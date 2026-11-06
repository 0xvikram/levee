// Fire Exit watcher service.
//   every 1 s (0.4 s while a movement waits for its receipt): tick (movements -> receipts -> match -> contain)
//   every 5 s: measure Mirror read lag (fail closed above 20 s: stop heartbeats)
//   every 30 s: heartbeat on the heartbeats topic (the gate refuses to sign without one)
//   GET /state, GET /events (SSE), GET /health
import express from "express";
import { pathToFileURL } from "node:url";
import { ContractExecuteTransaction, ContractFunctionParameters, ContractId, Long, Status, type Client, type PrivateKey } from "@hashgraph/sdk";
import { env, readState } from "../shared/config.js";
import { longZero, roleClient, roleKey } from "../shared/hedera.js";
import { MirrorClient } from "../shared/mirror.js";
import { compactIncident, submitJson, type Heartbeat } from "../shared/hcs.js";
import { normaliseTxId } from "../shared/txid.js";
import { rulesFromState } from "../gate/decide.js";
import { SseHub } from "../gate/sse.js";
import type { ContainmentStep, ControllerCall } from "./contain.js";
import { startOfUtcDay, Watcher } from "./watcher.js";

const ROLE_WATCHER = process.env.WATCHER_ROLE ?? "watcher";
const PAUSE_ON_BREACH = /^(1|true|yes)$/i.test(process.env.PAUSE_ON_BREACH ?? "false");
const HEARTBEAT_EVERY_MS = Number(process.env.WATCHER_HEARTBEAT_SECONDS ?? "30") * 1000;
const TICK_MS = Number(process.env.WATCHER_TICK_MS ?? "1000");
// While a movement waits for its receipt, tick sooner: each tick re-reads receipts with a fresh
// (cache-busted) request and retries the one-answer completeness proof (Watcher.proveReceipts).
const HOLD_TICK_MS = Number(process.env.WATCHER_HOLD_TICK_MS ?? "400");
const GAS: Record<ContainmentStep["step"], number> = {
  freezeAccount: Number(process.env.GAS_FREEZE ?? "400000"),
  wipeAndFreeze: Number(process.env.GAS_WIPE_FREEZE ?? "700000"),
  wipeFrozen: Number(process.env.GAS_WIPE_FROZEN ?? "900000"),
  burnSupply: Number(process.env.GAS_BURN ?? "400000"),
  pauseToken: Number(process.env.GAS_PAUSE ?? "400000"),
};

const bytes32 = (hex: string) => Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));

/** Controller ABI arguments for one step (exported for tests). */
export function controllerArgs(step: ContainmentStep, incidentId: string, evm?: string): { fn: string; params: ContractFunctionParameters } {
  const p = new ContractFunctionParameters();
  const id = bytes32(incidentId);
  // Studio rejects the long-zero address of an account that has an EVM alias (INVALID_ACCOUNT_ID),
  // so callers pass the account's real EVM address (see resolveEvm); long-zero is only a fallback.
  const addr = () => evm ?? longZero(step.account!);
  switch (step.step) {
    case "freezeAccount":
      return { fn: "freezeAccount", params: p.addAddress(addr()).addBytes32(id) };
    case "wipeAndFreeze":
    case "wipeFrozen":
      return { fn: step.step, params: p.addAddress(addr()).addInt64(Long.fromString(step.amount!)).addBytes32(id) };
    case "burnSupply":
      return { fn: "burnSupply", params: p.addInt64(Long.fromString(step.amount!)).addBytes32(id) };
    case "pauseToken":
      return { fn: "pauseToken", params: p.addBytes32(id) };
  }
}

const evmCache = new Map<string, string>();
/** The account's real EVM address from the Mirror Node (alias if it has one, else long-zero). */
export async function resolveEvm(accountId: string, mirrorUrl = env.mirrorUrl): Promise<string> {
  const hit = evmCache.get(accountId);
  if (hit) return hit;
  try {
    const r = await fetch(`${mirrorUrl}/api/v1/accounts/${accountId}`);
    if (r.ok) {
      const j = (await r.json()) as { evm_address?: string };
      if (j.evm_address) {
        evmCache.set(accountId, j.evm_address);
        return j.evm_address;
      }
    }
  } catch {
    /* fall through to long-zero */
  }
  return longZero(accountId);
}

function controllerCaller(client: Client, controllerId: string): ControllerCall {
  return async (step, incidentId) => {
    const evm = step.account ? await resolveEvm(step.account) : undefined;
    const { fn, params } = controllerArgs(step, incidentId, evm);
    const resp = await new ContractExecuteTransaction()
      .setContractId(ContractId.fromString(controllerId))
      .setGas(GAS[step.step])
      .setFunction(fn, params)
      .execute(client);
    const txId = normaliseTxId(resp.transactionId.toString());
    const rec = await resp.getReceipt(client);
    if (rec.status !== Status.Success) throw new Error(`${fn} ${rec.status.toString()} (${txId})`);
    return { txId };
  };
}

async function main() {
  const state = readState();
  for (const k of ["treasury", "watcher", "token", "topics", "controller", "payees"] as const) {
    if (!state[k]) throw new Error(`state/deploy.json has no ${k}: finish setup first`);
  }
  const mirror = new MirrorClient({ cacheBust: true });
  const client = roleClient(ROLE_WATCHER, state.watcher.id);
  const key: PrivateKey = roleKey(ROLE_WATCHER);
  const hub = new SseHub(100);
  const info = await mirror.tokenInfo(state.token.tokenId);
  const tokenTreasury = info?.treasury_account_id ?? state.token.proxy;

  const since = process.env.WATCHER_SINCE === "now" ? `${Math.floor(Date.now() / 1000)}.000000000` : (process.env.WATCHER_SINCE ?? startOfUtcDay(Date.now()));
  const w = new Watcher(
    {
      token: state.token.tokenId,
      treasury: state.treasury.id,
      tokenTreasury,
      receiptsTopic: state.topics.receipts,
      rules: rulesFromState(state, env),
      pauseOnBreach: PAUSE_ON_BREACH,
      receiptGraceMs: Number(process.env.WATCHER_RECEIPT_GRACE_MS ?? "3000"),
      receiptPayer: state.gate?.id,
    },
    {
      mirror,
      call: controllerCaller(client, state.controller.contractId),
      publishIncident: async (i) => {
        await submitJson(client, state.topics.incidents, compactIncident(i), key);
      },
      emit: (e, d) => hub.publish(e, d),
      log: (m) => console.error(`[watcher] ${m}`),
    },
    since,
  );

  // Prime: rebuild today's matched spend; past breaches are shown as historic, not re-contained.
  await w.measureLag();
  const primed = await w.tick(false);
  console.log(`[watcher] primed from ${since}: ${primed.matched.length} matched, ${primed.breaches.length} historic breaches, ${w.receipts.size} receipts`);

  // One tick at a time (containment can take longer than a tick); the next one is scheduled when it ends.
  const loop = async () => {
    const t0 = Date.now();
    try {
      const r = await w.tick(true);
      if (r.incident) console.log(`[watcher] incident ${r.incident.incidentId}: ${r.incident.actions.map((a) => `${a.step}${a.account ? ` ${a.account}` : ""}${a.note ? " (known partner: frozen, not wiped)" : ""}${a.ok ? "" : "(FAILED)"}`).join(", ")} contained in ${r.incident.containedMs} ms`);
    } catch {
      /* recorded in lastError; health check handles it */
    }
    const every = w.pending.size > 0 ? HOLD_TICK_MS : TICK_MS;
    setTimeout(loop, Math.max(0, every - (Date.now() - t0)));
  };
  setTimeout(loop, TICK_MS);

  setInterval(() => w.measureLag().catch(() => (w.lagMs = Number.POSITIVE_INFINITY)), 5000);

  let lastBeat: string | null = null;
  const beat = async () => {
    if (!w.healthy()) {
      hub.publish("health", { healthy: false, lagMs: w.lagMs, lastError: w.lastError });
      console.error(`[watcher] unhealthy (lag ${w.lagMs} ms): heartbeat withheld`);
      return;
    }
    const hb: Heartbeat = { v: 1, type: "heartbeat", who: "watcher", at: new Date().toISOString(), matched: w.matchedCount, incidents: w.incidents.length, lagMs: Math.round(w.lagMs) };
    try {
      await submitJson(client, state.topics.heartbeats, hb, key);
      lastBeat = hb.at;
      hub.publish("health", { healthy: true, lagMs: w.lagMs, heartbeatAt: hb.at });
    } catch (e) {
      console.error(`[watcher] heartbeat failed: ${(e as Error).message}`);
    }
  };
  await beat();
  setInterval(beat, HEARTBEAT_EVERY_MS);

  const app = express();
  app.get("/health", (_req, res) => res.status(w.healthy() ? 200 : 503).json({ ok: w.healthy(), service: "watcher", lagMs: w.lagMs, lastBeat }));
  app.get("/state", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ...w.snapshot(), lastBeat, pauseOnBreach: PAUSE_ON_BREACH, treasury: state.treasury.id, token: state.token.tokenId, tokenTreasury });
  });
  app.get("/events", hub.handler);
  app.listen(env.watcherPort, () => console.log(`[watcher] listening on :${env.watcherPort}, watching ${state.treasury.id} + ${tokenTreasury}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("watcher failed to start:", (e as Error).message);
    process.exit(1);
  });
}
