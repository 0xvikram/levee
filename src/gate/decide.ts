// Pure gate logic: validate a request, then pass -> rules -> watcher-alive, in that order
// (the signature / freshness / replay / role checks run before this, in auth.ts).
// No I/O here so every refusal path is unit-tested.
import type { Receipt, Rules } from "../shared/types.js";
import type { PassStatus } from "../shared/pass.js";
import { checkRules, dayKey } from "../shared/rules.js";
import { consensusToMs } from "../shared/txid.js";

export interface GateRequest {
  machine: string;
  to: string; // 0.0.x
  amount: string; // integer, smallest unit
  kind: "transfer" | "mint";
}

export type RefusalReason =
  | "bad-request"
  | "unknown-machine"
  | "bad-signature"
  | "stale-request"
  | "replayed-request"
  | "wrong-role"
  | "no-pass"
  | "over-transfer-cap"
  | "over-daily-cap"
  | "unknown-destination"
  | "no-watcher";

export type Decision = { ok: true } | { ok: false; reason: RefusalReason; detail: string };

const ID = /^\d+\.\d+\.\d+$/;
const INT = /^\d+$/;
const MAX_INT64 = 9223372036854775807n;

export function parseRequest(body: unknown): { ok: true; value: GateRequest } | { ok: false; reason: "bad-request"; detail: string } {
  const bad = (detail: string) => ({ ok: false as const, reason: "bad-request" as const, detail });
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (typeof b.machine !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(b.machine)) return bad("machine must be 1-64 chars [A-Za-z0-9._:-]");
  if (typeof b.to !== "string" || !ID.test(b.to)) return bad("to must be a Hedera account id 0.0.x");
  const amount = typeof b.amount === "number" && Number.isSafeInteger(b.amount) ? String(b.amount) : b.amount;
  if (typeof amount !== "string" || !INT.test(amount)) return bad("amount must be a positive integer (smallest unit)");
  const n = BigInt(amount);
  if (n <= 0n) return bad("amount must be > 0");
  if (n > MAX_INT64) return bad("amount overflows int64");
  const kind = b.kind ?? "transfer";
  if (kind !== "transfer" && kind !== "mint") return bad('kind must be "transfer" or "mint"');
  return { ok: true, value: { machine: b.machine, to: b.to, amount: n.toString(), kind } };
}

export interface WatcherBeat {
  consensusAt: string; // consensus time of the latest watcher heartbeat
}

export interface DecideInput {
  req: GateRequest;
  pass: PassStatus;
  rules: Rules;
  spentToday: bigint;
  heartbeat: WatcherBeat | null;
  nowMs: number;
  maxHeartbeatAgeMs?: number; // default 120 s
}

export function decide(i: DecideInput): Decision {
  if (!i.pass.live) return { ok: false, reason: "no-pass", detail: i.pass.reason ?? "machine has no live pass" };

  const rule = checkRules(i.rules, { to: i.req.to, amount: BigInt(i.req.amount), kind: i.req.kind }, i.spentToday);
  if (!rule.ok) {
    const detail =
      rule.reason === "over-transfer-cap"
        ? `amount ${i.req.amount} > cap ${i.rules.capPerTransfer}`
        : rule.reason === "over-daily-cap"
          ? `spent today ${i.spentToday} + ${i.req.amount} > daily cap ${i.rules.capPerDay}`
          : `${i.req.to} is not a known destination`;
    return { ok: false, reason: rule.reason, detail };
  }

  const maxAge = i.maxHeartbeatAgeMs ?? 120_000;
  if (!i.heartbeat) return { ok: false, reason: "no-watcher", detail: "no watcher, no signing: no heartbeat on the topic" };
  const age = i.nowMs - consensusToMs(i.heartbeat.consensusAt);
  if (age > maxAge) {
    return { ok: false, reason: "no-watcher", detail: `no watcher, no signing: last heartbeat ${Math.round(age / 1000)} s ago` };
  }
  return { ok: true };
}

/** Today's (UTC) approved spend, recomputed from receipts read back from the topic. */
export function spentFromReceipts(receipts: Receipt[], today: string): bigint {
  let s = 0n;
  for (const r of receipts) {
    if (!r.consensusAt) continue;
    if (dayKey(r.consensusAt) === today) s += BigInt(r.amount);
  }
  return s;
}

/** In-memory per-day spend. Reserved as soon as a receipt is written (conservative). */
export class SpendLedger {
  private byDay = new Map<string, bigint>();
  get(day: string): bigint {
    return this.byDay.get(day) ?? 0n;
  }
  add(day: string, amount: bigint): void {
    this.byDay.set(day, this.get(day) + amount);
  }
  set(day: string, amount: bigint): void {
    this.byDay.set(day, amount);
  }
}

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Gate decision event for the dashboard SSE feed. */
export interface GateEvent {
  at: string;
  machine: string;
  to: string;
  amount: string;
  kind: "transfer" | "mint";
  ok: boolean;
  reason?: RefusalReason | "execute-failed";
  detail?: string;
  txId?: string;
  receiptTxId?: string; // HCS submit tx of the receipt (approved requests only)
  receiptSequence?: number; // receipt's sequence number on the receipts topic
  timings?: Record<string, number>;
}

export function gateEvent(req: GateRequest, d: Decision | { ok: false; reason: "execute-failed"; detail: string }, nowMs: number, extra: Partial<GateEvent> = {}): GateEvent {
  return {
    at: new Date(nowMs).toISOString(),
    machine: req.machine,
    to: req.to,
    amount: req.amount,
    kind: req.kind,
    ok: d.ok,
    ...(d.ok ? {} : { reason: d.reason, detail: d.detail }),
    ...extra,
  };
}

export function buildReceipt(req: GateRequest, o: { txId: string; token: string; treasury: string; nowMs: number }): Receipt {
  return {
    v: 1,
    type: "receipt",
    txId: o.txId,
    token: o.token,
    from: o.treasury,
    to: req.to,
    amount: req.amount,
    kind: req.kind,
    machine: req.machine,
    approvedAt: new Date(o.nowMs).toISOString(),
  };
}

/**
 * Rules for this deployment: caps from .env, known destinations = the setup payees.
 * CAP_PER_TRANSFER / CAP_PER_DAY are written in WHOLE tokens (10000 = 10,000 RUPC), while gate
 * requests, receipts and Mirror movements are in the smallest unit, so the caps are scaled by
 * 10^decimals here. (Before this fix a 6-decimal token had a cap of 0.01 RUPC.)
 */
export function rulesFromState(
  s: { token: { tokenId: string; decimals?: number }; treasury: { id: string }; payees: { id: string }[] },
  caps: { capPerTransfer: bigint; capPerDay: bigint },
): Rules {
  const scale = 10n ** BigInt(s.token.decimals ?? 0);
  return {
    token: s.token.tokenId,
    treasury: s.treasury.id,
    capPerTransfer: caps.capPerTransfer * scale,
    capPerDay: caps.capPerDay * scale,
    knownDestinations: s.payees.map((p) => p.id),
  };
}
