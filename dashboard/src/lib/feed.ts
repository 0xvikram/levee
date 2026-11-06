// Match feed: pure reducer from service events to rows. Idempotent, because SSE replays
// recent history on every (re)connect and the /state snapshot overlaps with it.
import type { BreachView, GateDecision, Incident, Movement, WatcherSnapshot } from "./types";

export type RowStatus = "pending" | "receipt" | "breach" | "refused";

export interface FeedRow {
  key: string;
  txId?: string;
  to: string;
  amount: string;
  kind: string;
  status: RowStatus;
  reason?: string;
  consensusAt?: string;
  at?: string; // ISO, for gate-only rows
  machine?: string;
  contained?: boolean;
  historic?: boolean;
}

export interface FeedState {
  rows: FeedRow[];
}

export type FeedAction =
  | { type: "snapshot"; snapshot: WatcherSnapshot }
  | { type: "matched"; movement: Movement }
  | { type: "breach"; breach: BreachView }
  | { type: "incident"; incident: Incident }
  | { type: "decision"; decision: GateDecision };

export const MAX_ROWS = 60;
export const initialFeed: FeedState = { rows: [] };

const rank: Record<RowStatus, number> = { refused: 0, pending: 1, receipt: 2, breach: 3 };

/** Sort key: consensus time when known, else the gate's wall-clock time. */
function sortMs(r: FeedRow): number {
  if (r.consensusAt) {
    const [s, n = "0"] = r.consensusAt.split(".");
    return Number(s) * 1000 + Number(n.padEnd(9, "0").slice(0, 3));
  }
  return r.at ? Date.parse(r.at) : 0;
}

function upsert(rows: FeedRow[], next: FeedRow): FeedRow[] {
  const i = rows.findIndex((r) => r.key === next.key);
  let out: FeedRow[];
  if (i === -1) out = [...rows, next];
  else {
    const cur = rows[i];
    // never downgrade: a watcher verdict beats the gate's "receipt written"
    const status = rank[next.status] >= rank[cur.status] ? next.status : cur.status;
    const merged: FeedRow = { ...cur, ...next, status, contained: cur.contained || next.contained };
    if (status === cur.status && status !== next.status) {
      merged.reason = cur.reason;
      merged.historic = cur.historic;
    }
    out = rows.slice();
    out[i] = merged;
  }
  return out.sort((a, b) => sortMs(b) - sortMs(a)).slice(0, MAX_ROWS);
}

function breachRow(b: BreachView): FeedRow {
  return {
    key: b.txId,
    txId: b.txId,
    to: b.to ?? "allowance",
    amount: b.amount ?? "0",
    kind: b.kind ?? "allowance",
    status: "breach",
    reason: b.reason,
    consensusAt: b.consensusAt,
    ...(b.historic ? { historic: true } : {}),
  };
}

function markContained(rows: FeedRow[], inc: Incident): FeedRow[] {
  const ids = new Set(inc.breaches.map((b) => b.txId));
  const done = inc.actions.length > 0 && inc.actions.every((a) => a.ok);
  if (!done) return rows;
  return rows.map((r) => (r.txId && ids.has(r.txId) ? { ...r, contained: true } : r));
}

export function feedReducer(state: FeedState, a: FeedAction): FeedState {
  switch (a.type) {
    case "matched": {
      const m = a.movement;
      return { rows: upsert(state.rows, { key: m.txId, txId: m.txId, to: m.to, amount: m.amount, kind: m.kind, status: "receipt", consensusAt: m.consensusAt }) };
    }
    case "breach":
      return { rows: upsert(state.rows, breachRow(a.breach)) };
    case "incident":
      return { rows: markContained(state.rows, a.incident) };
    case "decision": {
      const d = a.decision;
      if (d.ok && d.txId) {
        return { rows: upsert(state.rows, { key: d.txId, txId: d.txId, to: d.to, amount: d.amount, kind: d.kind, status: "pending", at: d.at, machine: d.machine }) };
      }
      if (!d.ok && !d.txId) {
        const key = `refused:${d.at}:${d.machine}`;
        return { rows: upsert(state.rows, { key, to: d.to, amount: d.amount, kind: d.kind, status: "refused", reason: d.reason, at: d.at, machine: d.machine }) };
      }
      return state; // execute-failed with a txId: the watcher reports what really happened on chain
    }
    case "snapshot": {
      let rows = state.rows;
      for (const b of a.snapshot.breaches ?? []) rows = upsert(rows, breachRow(b));
      for (const i of a.snapshot.incidents ?? []) rows = markContained(rows, i);
      return { rows };
    }
  }
}

/** A breach is "live" (shown in red) only until its incident is contained. */
export function isLiveBreach(r: FeedRow): boolean {
  return r.status === "breach" && !r.contained && !r.historic;
}

export const REASONS: Record<string, string> = {
  "no-receipt": "no receipt",
  "receipt-after-movement": "receipt came after the move",
  "receipt-mismatch": "receipt does not match",
  "receipt-reused": "receipt already used",
  "over-transfer-cap": "over the per-transfer cap",
  "over-daily-cap": "over the daily cap",
  "unknown-destination": "unknown destination",
  "treasury-allowance": "allowance granted on treasury",
  "no-pass": "no live machine pass",
};
