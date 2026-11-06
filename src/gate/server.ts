// Leash gate: the only thing that co-signs treasury moves.
//   POST /request {machine, to, amount, kind}
//     pass check -> rules (+ daily spend) -> watcher alive -> build + freeze tx (txId known)
//     -> receipt to HCS, wait for consensus -> sign (treasurySigner + gate = 2 of 3) -> execute
//   GET /health, GET /events (SSE of decisions)
import express from "express";
import { pathToFileURL } from "node:url";
import {
  AccountId,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
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
import { parseHeartbeat, readReceipts, submitJson } from "../shared/hcs.js";
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

const CASHIN_GAS = Number(process.env.CASHIN_GAS ?? "300000");
const HEARTBEAT_MAX_AGE_MS = Number(process.env.WATCHER_HEARTBEAT_MAX_AGE_S ?? "120") * 1000;
const ROLE_GATE = process.env.GATE_ROLE ?? "gate";
const ROLE_SIGNER = process.env.TREASURY_SIGNER_ROLE ?? "treasurySigner";

export interface GateDeps {
  state: DeployState;
  rules: Rules;
  pass: PassChecker;
  mirror: MirrorClient;
  client: Client; // pays for receipts + submits the signed treasury tx
  gateKey: PrivateKey;
  signerKey: PrivateKey;
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
 * Build and freeze the transaction with a pre-generated id, so the receipt can name it.
 *  transfer: TransferTransaction treasury -> to, payer = treasury (needs 2 of {treasurySigner, gate, cold}).
 *  mint:     Studio cash-in proxy.mint(address,int64), payer = gate (setup grants CASHIN to the gate account).
 */
function buildFrozenTx(d: GateDeps, req: GateRequest) {
  const amount = Long.fromString(req.amount);
  if (req.kind === "transfer") {
    const treasury = AccountId.fromString(d.state.treasury.id);
    const token = TokenId.fromString(d.state.token.tokenId);
    return new TransferTransaction()
      .setTransactionId(TransactionId.generate(treasury))
      .addTokenTransfer(token, treasury, amount.negate())
      .addTokenTransfer(token, AccountId.fromString(req.to), amount)
      .freezeWith(d.client);
  }
  return new ContractExecuteTransaction()
    .setTransactionId(TransactionId.generate(AccountId.fromString(d.state.gate.id)))
    .setContractId(ContractId.fromString(d.state.token.proxy))
    .setGas(CASHIN_GAS)
    .setFunction("mint", new ContractFunctionParameters().addAddress(evmFor(d.state, req.to)).addInt64(amount))
    .freezeWith(d.client);
}

export function createGate(d: GateDeps, ledger = new SpendLedger()) {
  const app = express();
  app.use(express.json({ limit: "8kb" }));
  const hub = new SseHub();
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
    });
  });
  app.get("/events", hub.handler);

  app.post("/request", (req, res) => {
    const job = queue.then(() => handle(req.body));
    queue = job.catch(() => undefined);
    job.then(
      ({ status, body }) => res.status(status).json(body),
      (e) => res.status(500).json({ ok: false, reason: "internal", detail: (e as Error).message }),
    );
  });

  async function handle(body: unknown): Promise<{ status: number; body: unknown }> {
    const t0 = Date.now();
    const timings: Record<string, number> = {};
    const parsed = parseRequest(body);
    if (!parsed.ok) return { status: 400, body: parsed };
    const r = parsed.value;

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

    // d) build + freeze: the tx id is fixed before anything is written.
    const tx = buildFrozenTx(d, r);
    const txId = normaliseTxId(tx.transactionId!.toString());
    const receipt: Receipt = buildReceipt(r, { txId, token: d.state.token.tokenId, treasury: d.state.treasury.id, nowMs: Date.now() });

    // e) receipt first, and wait for consensus.
    const t1 = Date.now();
    const sub = await submitJson(d.client, d.state.topics.receipts, receipt, d.gateKey);
    timings.receiptMs = Date.now() - t1;
    ledger.add(today, BigInt(r.amount));

    // f) transfer: 2-of-3 (treasury signer + gate); mint: gate (CASHIN holder). Then execute.
    const t2 = Date.now();
    try {
      if (r.kind === "transfer") await tx.sign(d.signerKey); // second key of the treasury 2-of-3
      await tx.sign(d.gateKey);
      const resp = await tx.execute(d.client);
      const rec = await resp.getReceipt(d.client);
      timings.executeMs = Date.now() - t2;
      timings.totalMs = Date.now() - t0;
      if (rec.status !== Status.Success) throw new Error(`status ${rec.status.toString()}`);
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
      client: roleClient(ROLE_GATE, state.gate.id),
      gateKey: roleKey(ROLE_GATE),
      signerKey: roleKey(ROLE_SIGNER),
    },
    ledger,
  );
  gate.app.listen(env.gatePort, () => {
    console.log(`gate listening on :${env.gatePort} (treasury ${state.treasury.id}, token ${state.token.tokenId}); spent today ${ledger.get(today)} from ${receipts.length} receipts`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("gate failed to start:", (e as Error).message);
    process.exit(1);
  });
}
