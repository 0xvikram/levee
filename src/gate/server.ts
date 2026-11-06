// Leash gate: approves treasury moves and holds ONE key of the treasury's 2-of-3 (the gate key).
//   POST /request {machine, to, amount, kind, nonce, sentAt, signature}
//     signed by the machine's own key (auth.ts: enrolled key, fresh, not replayed, allowed role)
//     -> pass check -> rules (+ daily spend) -> watcher alive
//     transfer: ScheduleCreate the fixed TransferTransaction, signed and paid by the gate key only (1 of 2)
//               -> receipt to HCS naming the scheduled tx id + schedule id, wait for consensus
//               -> tell the issuer signer (src/signer, its own process and key) the schedule id; it finds the
//                  receipt on the Mirror Node itself and adds the 2nd signature (ScheduleSign) -> Hedera executes
//     mint:     unchanged: build + freeze, receipt, sign with the gate key (CASHIN holder), execute
//   GET /health, GET /events (SSE of decisions)
// The gate never loads the treasury-signer key.
import express from "express";
import { pathToFileURL } from "node:url";
import {
  AccountId,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
  ScheduleCreateTransaction,
  Timestamp,
  TokenId,
  TransactionId,
  TransferTransaction,
  Status,
  Long,
  type Client,
  type PrivateKey,
} from "@hashgraph/sdk";
import { env, readState, type DeployState } from "../shared/config.js";
import { longZero, roleClient, roleKey } from "../shared/hedera.js";
import { MirrorClient } from "../shared/mirror.js";
import { parseHeartbeat, readReceipts, submitJson, type SubmitResult } from "../shared/hcs.js";
import { HttpPassChecker, type PassChecker } from "../shared/pass.js";
import { normaliseTxId } from "../shared/txid.js";
import type { Receipt, Rules } from "../shared/types.js";
import {
  buildReceipt,
  decide,
  gateEvent,
  parseRequest,
  rulesFromState,
  spentFromReceipts,
  SpendLedger,
  utcDay,
  type GateRequest,
  type WatcherBeat,
} from "./decide.js";
import { SseHub } from "./sse.js";
import { allowedRolesFromEnv, HttpMachineDirectory, RequestAuthenticator } from "./auth.js";

const CASHIN_GAS = Number(process.env.CASHIN_GAS ?? "300000");
const HEARTBEAT_MAX_AGE_MS = Number(process.env.WATCHER_HEARTBEAT_MAX_AGE_S ?? "120") * 1000;
const ROLE_GATE = process.env.GATE_ROLE ?? "gate";
/** How long an unsigned schedule lives before Hedera drops it (HIP-423 expiration time). */
export const SCHEDULE_TTL_S = Number(process.env.SCHEDULE_TTL_S ?? "300");
const SIGNER_URL = process.env.SIGNER_URL ?? `http://127.0.0.1:${env.signerPort}`;
const SIGNER_WAIT_MS = Number(process.env.SIGNER_WAIT_S ?? "75") * 1000;

/** What the issuer signer answers (src/signer/service.ts SignerDecision, the fields the gate uses). */
export interface SignerReply {
  ok: boolean;
  reason?: string;
  detail?: string;
  signTxId?: string;
  status?: string;
  executedStatus?: string;
  verifyMs?: number;
  signMs?: number;
}

/** Everything the gate does on Hedera, injectable for tests. */
export interface GateChain {
  /** Execute a frozen ScheduleCreate already signed by the gate key (and nothing else); returns the new schedule id. */
  createSchedule(tx: ScheduleCreateTransaction): Promise<{ scheduleId: string }>;
  submitReceipt(receipt: Receipt): Promise<SubmitResult>;
  /** Sign a frozen mint with the gate key and execute it; throws unless SUCCESS. */
  executeMint(tx: ContractExecuteTransaction): Promise<void>;
  /** Hand the schedule id to the issuer signer and wait for its decision. */
  notifySigner(scheduleId: string): Promise<SignerReply>;
}

export interface GateDeps {
  state: DeployState;
  rules: Rules;
  pass: PassChecker;
  /** checks the request is signed by the named machine's enrolled key, fresh, unreplayed, with an allowed role */
  auth: RequestAuthenticator;
  mirror: MirrorClient;
  client: Client; // the gate account: pays for receipts, ScheduleCreate and the scheduled transfer
  gateKey: PrivateKey;
  /** defaults to the real Hedera / HTTP implementation built from client + gateKey */
  chain?: Partial<GateChain>;
}

/** The real chain: Hedera via the gate's client, the signer over localhost HTTP. */
export function realChain(d: Pick<GateDeps, "client" | "gateKey" | "state">, signerUrl = SIGNER_URL, signerWaitMs = SIGNER_WAIT_MS): GateChain {
  return {
    async createSchedule(tx) {
      const resp = await tx.execute(d.client);
      const rec = await resp.getReceipt(d.client);
      if (rec.status !== Status.Success || !rec.scheduleId) throw new Error(`ScheduleCreate status ${rec.status.toString()}`);
      return { scheduleId: rec.scheduleId.toString() };
    },
    submitReceipt: (receipt) => submitJson(d.client, d.state.topics.receipts, receipt, d.gateKey),
    async executeMint(tx) {
      await tx.sign(d.gateKey);
      const resp = await tx.execute(d.client);
      const rec = await resp.getReceipt(d.client);
      if (rec.status !== Status.Success) throw new Error(`status ${rec.status.toString()}`);
    },
    async notifySigner(scheduleId) {
      try {
        const r = await fetch(`${signerUrl}/schedule`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scheduleId }), signal: AbortSignal.timeout(signerWaitMs) });
        return (await r.json()) as SignerReply;
      } catch (e) {
        return { ok: false, reason: "signer-unavailable", detail: `issuer signer at ${signerUrl} did not answer: ${(e as Error).message}` };
      }
    },
  };
}

/** Latest watcher heartbeat (consensus time) on the heartbeats topic, or null. */
async function latestHeartbeat(mirror: MirrorClient, topic: string): Promise<WatcherBeat | null> {
  const m = await mirror.latestTopicMessage(topic);
  if (!m) return null;
  return parseHeartbeat(m.text).ok ? { consensusAt: m.consensusAt } : null;
}

/** EVM address for an account: the one setup recorded (alias or long-zero), else long-zero. */
export function evmFor(state: DeployState, id: string): string {
  const known = [state.treasury, state.gate, state.watcher, state.attacker, ...(state.payees ?? []), ...(state.admins ?? [])].find((a) => a?.id === id);
  return known?.evm ?? longZero(id);
}

/**
 * The scheduled transfer, before it is frozen: ScheduleCreate wrapping TransferTransaction treasury -> to.
 * Its transaction id is fixed here (payer = gate), and the transfer will execute under that same id with
 * the "scheduled" flag, which the Mirror Node shows as the same transaction_id with scheduled=true. So the
 * receipt names normaliseTxId(txId) and the watcher matches it unchanged.
 * Signatures needed for the transfer: the treasury's 2-of-3 (gate + issuer signer) and the payer (gate).
 */
export function buildScheduleCreate(state: DeployState, req: GateRequest, o: { nowMs: number; ttlS?: number; validStart?: TransactionId }): ScheduleCreateTransaction {
  const amount = Long.fromString(req.amount);
  const treasury = AccountId.fromString(state.treasury.id);
  const gate = AccountId.fromString(state.gate.id);
  const token = TokenId.fromString(state.token.tokenId);
  const transfer = new TransferTransaction().addTokenTransfer(token, treasury, amount.negate()).addTokenTransfer(token, AccountId.fromString(req.to), amount);
  return new ScheduleCreateTransaction()
    .setTransactionId(o.validStart ?? TransactionId.generate(gate))
    .setScheduledTransaction(transfer)
    .setPayerAccountId(gate)
    .setExpirationTime(Timestamp.fromDate(new Date(o.nowMs + (o.ttlS ?? SCHEDULE_TTL_S) * 1000)))
    .setWaitForExpiry(false) // execute as soon as the second signature lands
    .setScheduleMemo(`levee ${req.machine}`.slice(0, 100));
}

/** Mint (unchanged): Studio cash-in proxy.mint(address,int64), payer = gate (setup grants CASHIN to the gate account). */
function buildFrozenMint(d: GateDeps, req: GateRequest): ContractExecuteTransaction {
  return new ContractExecuteTransaction()
    .setTransactionId(TransactionId.generate(AccountId.fromString(d.state.gate.id)))
    .setContractId(ContractId.fromString(d.state.token.proxy))
    .setGas(CASHIN_GAS)
    .setFunction("mint", new ContractFunctionParameters().addAddress(evmFor(d.state, req.to)).addInt64(Long.fromString(req.amount)))
    .freezeWith(d.client);
}

export function createGate(d: GateDeps, ledger = new SpendLedger()) {
  const app = express();
  app.use(express.json({ limit: "8kb" }));
  const hub = new SseHub();
  const chain: GateChain = { ...realChain(d), ...(d.chain ?? {}) };
  let queue: Promise<unknown> = Promise.resolve(); // one request at a time: no double-spend of the daily cap
  let served = 0;

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "gate",
      served,
      treasury: d.state.treasury.id,
      token: d.state.token.tokenId,
      sseClients: hub.size,
      // smallest units, as strings (bigint-safe)
      capPerTransfer: d.rules.capPerTransfer.toString(),
      capPerDay: d.rules.capPerDay.toString(),
      spentToday: ledger.get(utcDay(Date.now())).toString(),
      knownDestinations: d.rules.knownDestinations,
      signing: "scheduled: gate key + issuer signer (separate process)",
    });
  });
  app.get("/events", hub.handler);

  type Reply = { status: number; body: unknown };
  app.post("/request", (req, res) => {
    // Checks, ScheduleCreate and the receipt run one request at a time (no double-spend of the daily
    // cap); waiting for the issuer signer happens outside the queue.
    const job = queue.then(() => handle(req.body));
    queue = job.catch(() => undefined);
    job
      .then((r) => ("after" in r ? r.after() : r))
      .then(
        ({ status, body }) => res.status(status).json(body),
        (e) => res.status(500).json({ ok: false, reason: "internal", detail: (e as Error).message }),
      );
  });

  async function handle(body: unknown): Promise<Reply | { after: () => Promise<Reply> }> {
    const t0 = Date.now();
    const timings: Record<string, number> = {};
    const parsed = parseRequest(body);
    if (!parsed.ok) return { status: 400, body: parsed };
    const r = parsed.value;

    // Who is asking: the signature must come from this machine's enrolled key (before any pass/rules work).
    const who = await d.auth.check(r, body);
    timings.authMs = Date.now() - t0;
    if (!who.ok) {
      const refusal = { ok: false as const, reason: who.reason, detail: who.detail };
      hub.publish("decision", gateEvent(r, refusal, Date.now(), { timings }));
      return { status: 403, body: refusal };
    }

    const [pass, heartbeat] = await Promise.all([
      d.pass.isLive(r.machine).finally(() => (timings.passMs = Date.now() - t0)),
      latestHeartbeat(d.mirror, d.state.topics.heartbeats).catch(() => null).finally(() => (timings.heartbeatMs = Date.now() - t0)),
    ]);
    const today = utcDay(Date.now());
    const decision = decide({ req: r, pass, rules: d.rules, spentToday: ledger.get(today), heartbeat, nowMs: Date.now(), maxHeartbeatAgeMs: HEARTBEAT_MAX_AGE_MS });
    if (!decision.ok) {
      hub.publish("decision", gateEvent(r, decision, Date.now(), { timings }));
      return { status: 403, body: { ok: false, reason: decision.reason, detail: decision.detail } };
    }
    return r.kind === "transfer" ? transfer(r, t0, timings, today) : mint(r, t0, timings, today);
  }

  /** Transfer: schedule (gate key only) -> receipt -> issuer signer adds the 2nd signature. */
  async function transfer(r: GateRequest, t0: number, timings: Record<string, number>, today: string): Promise<Reply | { after: () => Promise<Reply> }> {
    // Signed by the gate key only. Signatures on a ScheduleCreate count toward the scheduled transfer,
    // so this is key 2 of the treasury's 2-of-3 (and the payer). The issuer signer adds key 1 later.
    const tx = await buildScheduleCreate(d.state, r, { nowMs: Date.now() }).freezeWith(d.client).sign(d.gateKey);
    const txId = normaliseTxId(tx.transactionId!.toString()); // = the scheduled transfer's id on the Mirror
    const tS = Date.now();
    let scheduleId: string;
    try {
      ({ scheduleId } = await chain.createSchedule(tx));
      timings.scheduleMs = Date.now() - tS;
    } catch (e) {
      timings.scheduleMs = Date.now() - tS;
      const detail = `ScheduleCreate failed (no receipt written, nothing can move): ${(e as Error).message}`;
      hub.publish("decision", gateEvent(r, { ok: false, reason: "schedule-failed", detail }, Date.now(), { txId, timings }));
      return { status: 502, body: { ok: false, reason: "schedule-failed", detail, txId, timings } };
    }

    // The schedule cannot execute until the issuer signer signs, and it signs only after it reads this
    // receipt on the Mirror Node: so the receipt still reaches consensus before the transfer.
    const receipt: Receipt = { ...buildReceipt(r, { txId, token: d.state.token.tokenId, treasury: d.state.treasury.id, nowMs: Date.now() }), scheduleId };
    const t1 = Date.now();
    const sub = await chain.submitReceipt(receipt);
    timings.receiptMs = Date.now() - t1;
    ledger.add(today, BigInt(r.amount));
    const common = { txId, scheduleId, scheduledTxId: txId, receiptTxId: sub.txId, receiptSequence: sub.sequence };

    return {
      after: async (): Promise<Reply> => {
        const t2 = Date.now();
        const s = await chain.notifySigner(scheduleId);
        timings.signerMs = Date.now() - t2;
        if (s.verifyMs !== undefined) timings.signerVerifyMs = s.verifyMs;
        if (s.signMs !== undefined) timings.signerSignMs = s.signMs;
        timings.totalMs = Date.now() - t0;
        const executed = s.ok && (s.executedStatus === undefined || s.executedStatus === "SUCCESS");
        if (!executed) {
          const reason = s.reason === "signer-unavailable" ? "signer-unavailable" : "signer-refused";
          const detail = s.ok
            ? `issuer signer signed (${s.signTxId}) but the scheduled transfer ended ${s.executedStatus}`
            : `receipt written (seq ${sub.sequence}), schedule ${scheduleId} not signed: ${s.reason}: ${s.detail ?? ""}`.trim();
          hub.publish("decision", gateEvent(r, { ok: false, reason, detail }, Date.now(), { ...common, timings }));
          return { status: reason === "signer-unavailable" ? 504 : 502, body: { ok: false, reason, detail, ...common, receipt, signer: s, timings } };
        }
        served++;
        hub.publish("decision", gateEvent(r, { ok: true }, Date.now(), { ...common, signTxId: s.signTxId, timings }));
        return { status: 200, body: { ok: true, receipt: { ...receipt, sequence: sub.sequence }, ...common, signTxId: s.signTxId, executedStatus: s.executedStatus, timings } };
      },
    };
  }

  /** Mint: unchanged (the cash-in role sits with the gate account): receipt first, then sign + execute. */
  async function mint(r: GateRequest, t0: number, timings: Record<string, number>, today: string): Promise<Reply> {
    const tx = buildFrozenMint(d, r);
    const txId = normaliseTxId(tx.transactionId!.toString());
    const receipt: Receipt = buildReceipt(r, { txId, token: d.state.token.tokenId, treasury: d.state.treasury.id, nowMs: Date.now() });
    const t1 = Date.now();
    const sub = await chain.submitReceipt(receipt);
    timings.receiptMs = Date.now() - t1;
    ledger.add(today, BigInt(r.amount));
    const t2 = Date.now();
    try {
      await chain.executeMint(tx);
      timings.executeMs = Date.now() - t2;
      timings.totalMs = Date.now() - t0;
    } catch (e) {
      timings.executeMs = Date.now() - t2;
      timings.totalMs = Date.now() - t0;
      const detail = `receipt written (seq ${sub.sequence}) but execution failed: ${(e as Error).message}`;
      hub.publish("decision", gateEvent(r, { ok: false, reason: "execute-failed", detail }, Date.now(), { txId, timings }));
      return { status: 502, body: { ok: false, reason: "execute-failed", detail, txId, receipt, timings } };
    }
    served++;
    hub.publish("decision", gateEvent(r, { ok: true }, Date.now(), { txId, receiptTxId: sub.txId, receiptSequence: sub.sequence, timings }));
    return { status: 200, body: { ok: true, receipt: { ...receipt, sequence: sub.sequence }, receiptTxId: sub.txId, txId, timings } };
  }

  return { app, hub, ledger };
}

async function main() {
  const state = readState();
  for (const k of ["treasury", "gate", "token", "topics", "payees"] as const) {
    if (!state[k]) throw new Error(`state/deploy.json has no ${k}: finish setup first`);
  }
  const mirror = new MirrorClient();
  const rules = rulesFromState(state, env);
  const ledger = new SpendLedger();
  const today = utcDay(Date.now());
  const { receipts } = await readReceipts(mirror, state.topics.receipts, 0);
  ledger.set(today, spentFromReceipts(receipts, today));
  const gate = createGate(
    {
      state,
      rules,
      mirror,
      pass: new HttpPassChecker(),
      auth: new RequestAuthenticator(new HttpMachineDirectory(), allowedRolesFromEnv()),
      client: roleClient(ROLE_GATE, state.gate.id),
      gateKey: roleKey(ROLE_GATE), // the only treasury key in this process
    },
    ledger,
  );
  gate.app.listen(env.gatePort, () => {
    console.log(`gate listening on :${env.gatePort}, signed requests only, transfers scheduled for the issuer signer at ${SIGNER_URL}, roles ${allowedRolesFromEnv().join("/")} (treasury ${state.treasury.id}, token ${state.token.tokenId}); spent today ${ledger.get(today)} from ${receipts.length} receipts`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("gate failed to start:", (e as Error).message);
    process.exit(1);
  });
}
