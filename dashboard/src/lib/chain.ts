// Chain mode for /live: when the local services (gate, watcher, checker, runner) cannot be
// reached — always on the public site, after DECIDE_MS on localhost — the room is filled from
// the public Hedera Mirror Node only: receipts topic, treasury token transfers, incidents topic.
// Everything here is pure except fetchChain/useChain at the bottom.
import { useEffect, useState } from "react";
import { MIRROR, deploy } from "./config";
import { MAX_ROWS, type FeedRow } from "./feed";
import { pickGenuineIncident } from "./incident";
import { b64ToText, parseIncidentMessage } from "./mirror";
import type { Incident } from "./types";

// ------------------------------------------------------------------ mode

export type RoomMode = "checking" | "local" | "chain";
export const DECIDE_MS = 4000;

/**
 * local: the page can reach the services (localhost/Vite proxy, or explicit service URLs).
 * anyUp: at least one service answered or has an open stream.
 */
export function decideMode(o: { local: boolean; anyUp: boolean; elapsedMs: number }): RoomMode {
  if (!o.local) return "chain";
  if (o.anyUp) return "local";
  return o.elapsedMs >= DECIDE_MS ? "chain" : "checking";
}

// ------------------------------------------------------------------ Mirror shapes

export interface MirrorTopicMsg {
  consensus_timestamp: string;
  message: string; // base64
  sequence_number?: number;
  chunk_info?: { initial_transaction_id?: { account_id?: string; transaction_valid_start?: string } } | null;
}

export interface MirrorTx {
  consensus_timestamp: string;
  transaction_id: string;
  result: string;
  nonce?: number;
  parent_consensus_timestamp?: string | null;
  scheduled?: boolean;
  token_transfers?: { token_id: string; account: string; amount: number | string }[];
}

export interface ChainReceipt {
  txId: string; // the transfer this receipt allows (Mirror spelling)
  to: string;
  amount: string;
  kind: string;
  machine?: string;
  consensusAt: string; // when the receipt reached consensus on HCS
  hcsTxId?: string; // the HCS submit transaction, for a HashScan link
}

export interface ChainMovement {
  txId: string;
  consensusAt: string;
  to: string;
  amount: string;
}

/** Compare "seconds.nanos" consensus timestamps exactly (no float rounding). */
export function cmpConsensus(a: string, b: string): number {
  const [as, an = "0"] = a.split(".");
  const [bs, bn = "0"] = b.split(".");
  const d = BigInt(as) - BigInt(bs);
  if (d !== 0n) return d < 0n ? -1 : 1;
  const e = BigInt(an.padEnd(9, "0")) - BigInt(bn.padEnd(9, "0"));
  return e === 0n ? 0 : e < 0n ? -1 : 1;
}

/** HCS submit tx id from a topic message's chunk_info, in Mirror spelling (0.0.x-sec-nanos). */
export function hcsTxId(m: MirrorTopicMsg): string | undefined {
  const id = m.chunk_info?.initial_transaction_id;
  if (!id?.account_id || !id.transaction_valid_start) return undefined;
  const [s, n = "0"] = id.transaction_valid_start.split(".");
  return `${id.account_id}-${s}-${n.padEnd(9, "0")}`;
}

/** Decode receipt messages for our token. Earliest receipt per transfer wins (like the watcher). */
export function parseReceipts(msgs: MirrorTopicMsg[], token: string): Map<string, ChainReceipt> {
  const out = new Map<string, ChainReceipt>();
  for (const m of msgs) {
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(b64ToText(m.message));
    } catch {
      continue;
    }
    if (v?.type !== "receipt" || typeof v.txId !== "string" || v.token !== token) continue;
    const r: ChainReceipt = {
      txId: v.txId,
      to: String(v.to ?? ""),
      amount: String(v.amount ?? "0"),
      kind: String(v.kind ?? "transfer"),
      machine: typeof v.machine === "string" ? v.machine : undefined,
      consensusAt: m.consensus_timestamp,
      hcsTxId: hcsTxId(m),
    };
    const cur = out.get(r.txId);
    if (!cur || cmpConsensus(r.consensusAt, cur.consensusAt) < 0) out.set(r.txId, r);
  }
  return out;
}

/**
 * Treasury outflows of `token`: per transaction (parent + child records together), the
 * treasury's net change is negative; one movement per credited account. Mirrors the watcher's
 * extractMovements for plain transfers (mints are not shown in chain mode).
 */
export function treasuryOutflows(txs: MirrorTx[], o: { token: string; treasury: string }): ChainMovement[] {
  const groups = new Map<string, MirrorTx[]>();
  for (const t of txs) {
    const key = t.scheduled ? `${t.transaction_id}#scheduled` : t.transaction_id;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const out: ChainMovement[] = [];
  for (const [key, group] of groups) {
    const parent = group.find((t) => (t.nonce ?? 0) === 0 && !t.parent_consensus_timestamp);
    if (parent && parent.result !== "SUCCESS") continue;
    const ok = group.filter((t) => t.result === "SUCCESS").sort((a, b) => cmpConsensus(a.consensus_timestamp, b.consensus_timestamp));
    if (!ok.length) continue;
    const net = new Map<string, bigint>();
    for (const t of ok)
      for (const tt of t.token_transfers ?? []) {
        if (tt.token_id !== o.token) continue;
        const a = BigInt(typeof tt.amount === "number" ? Math.trunc(tt.amount) : tt.amount);
        net.set(tt.account, (net.get(tt.account) ?? 0n) + a);
      }
    if ((net.get(o.treasury) ?? 0n) >= 0n) continue;
    for (const [acct, d] of net) {
      if (acct === o.treasury || d <= 0n) continue;
      out.push({ txId: key.replace(/#scheduled$/, ""), consensusAt: ok[0].consensus_timestamp, to: acct, amount: d.toString() });
    }
  }
  return out.sort((a, b) => cmpConsensus(b.consensusAt, a.consensusAt));
}

/**
 * Feed rows from chain data alone: each treasury outflow matched to its receipt by tx id.
 *  - receipt found, earlier than the move, same receiver + amount → "receipt ✓"
 *  - otherwise a breach (reason from the incident when one names it). Breaches here are always
 *    past events: "contained" when a fully successful incident covers them, else "historic",
 *    so chain mode never paints a live red row.
 *  - receipts in the window with no transfer yet (or a transfer that failed) → "receipt written"
 */
export function chainFeed(movements: ChainMovement[], receipts: Map<string, ChainReceipt>, incidents: Incident[], max = MAX_ROWS): FeedRow[] {
  const reasonOf = new Map<string, string>();
  const contained = new Set<string>();
  for (const i of incidents) {
    const done = i.actions.length > 0 && i.actions.every((a) => a.ok);
    for (const b of i.breaches) {
      if (!reasonOf.has(b.txId)) reasonOf.set(b.txId, b.reason);
      if (done) contained.add(b.txId);
    }
  }
  const rows: FeedRow[] = [];
  const used = new Set<string>();
  for (const m of movements) {
    const r = receipts.get(m.txId);
    if (r) used.add(m.txId);
    let reason: string | null = null;
    if (!r) reason = "no-receipt";
    else if (cmpConsensus(r.consensusAt, m.consensusAt) > 0) reason = "receipt-after-movement";
    else if (r.to !== m.to || r.amount !== m.amount) reason = "receipt-mismatch";
    const key = movements.filter((x) => x.txId === m.txId).length > 1 ? `${m.txId}|${m.to}` : m.txId;
    const base = { key, txId: m.txId, to: m.to, amount: m.amount, kind: "transfer", consensusAt: m.consensusAt, ...(r?.machine ? { machine: r.machine } : {}), ...(r?.hcsTxId ? { receiptTxId: r.hcsTxId } : {}) };
    if (reason === null) rows.push({ ...base, status: "receipt" });
    else {
      const isDone = contained.has(m.txId);
      rows.push({ ...base, status: "breach", reason: reasonOf.get(m.txId) ?? reason, ...(isDone ? { contained: true } : { historic: true }) });
    }
  }
  const oldest = movements.length ? movements[movements.length - 1].consensusAt : null;
  for (const r of receipts.values()) {
    if (used.has(r.txId)) continue;
    if (oldest && cmpConsensus(r.consensusAt, oldest) < 0) continue; // older than the transfer window
    rows.push({ key: `receipt:${r.txId}`, txId: undefined, to: r.to, amount: r.amount, kind: r.kind, status: "pending", consensusAt: r.consensusAt, ...(r.machine ? { machine: r.machine } : {}), ...(r.hcsTxId ? { receiptTxId: r.hcsTxId } : {}) });
  }
  return rows.sort((a, b) => cmpConsensus(b.consensusAt ?? "0", a.consensusAt ?? "0")).slice(0, max);
}

// ------------------------------------------------------------------ fetch

export interface ChainData {
  rows: FeedRow[];
  genuine: { incident: Incident; consensusAt: string } | null;
  ok: boolean; // every Mirror read answered
  at: number;
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T | null> {
  try {
    const r = await fetch(url, { signal });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

export async function fetchChain(timeoutMs = 10_000): Promise<ChainData> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const [rec, txs, inc] = await Promise.all([
      getJson<{ messages?: MirrorTopicMsg[] }>(`${MIRROR}/api/v1/topics/${deploy.topics.receipts}/messages?order=desc&limit=100`, ctl.signal),
      getJson<{ transactions?: MirrorTx[] }>(`${MIRROR}/api/v1/transactions?account.id=${deploy.treasury}&order=desc&limit=50`, ctl.signal),
      getJson<{ messages?: MirrorTopicMsg[] }>(`${MIRROR}/api/v1/topics/${deploy.topics.incidents}/messages?order=desc&limit=25`, ctl.signal),
    ]);
    const incidentMsgs = inc?.messages ?? [];
    const incidents = incidentMsgs.map((m) => parseIncidentMessage(m.message)).filter((i): i is Incident => !!i);
    const rows = chainFeed(treasuryOutflows(txs?.transactions ?? [], { token: deploy.token.tokenId, treasury: deploy.treasury }), parseReceipts(rec?.messages ?? [], deploy.token.tokenId), incidents);
    const genuine = pickGenuineIncident(incidentMsgs, { treasury: deploy.treasury, payees: deploy.payees, decimals: deploy.token.decimals });
    return { rows, genuine, ok: !!(rec && txs && inc), at: Date.now() };
  } finally {
    clearTimeout(t);
  }
}

/** Mirror-only room data, refreshed every `everyMs` while `active`. */
export function useChain(active: boolean, everyMs = 15_000): ChainData | null {
  const [d, setD] = useState<ChainData | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const run = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      fetchChain()
        .then((x) => alive && setD((prev) => (x.ok || !prev ? x : { ...prev, ok: false })))
        .catch(() => undefined);
    };
    run();
    const id = setInterval(run, everyMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active, everyMs]);
  return d;
}
