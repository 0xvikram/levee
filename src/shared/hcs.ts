// HCS helpers: submit JSON to a topic and wait for consensus, read messages back via
// the Mirror Node, and hand-validate Receipt / Incident / Heartbeat payloads.
import { Client, PrivateKey, TopicId, TopicMessageSubmitTransaction } from "@hashgraph/sdk";
import type { Incident, Receipt } from "./types.js";
import { MirrorClient, type TopicMessage } from "./mirror.js";
import { normaliseTxId } from "./txid.js";

// ------------------------------------------------------------------ submit

export interface SubmitResult {
  topicId: string;
  sequence: number;
  txId: string; // normalised Mirror spelling
  submitMs: number; // wall time until the receipt (= consensus reached)
}

/**
 * Submit `payload` as JSON to `topicId`, signed by `signingKey` (the topic submit key),
 * paid by `client`'s operator, and wait for the receipt. A receipt means the message has
 * reached consensus, so anything done after this returns is ordered after it.
 */
export async function submitJson(client: Client, topicId: string, payload: unknown, signingKey?: PrivateKey): Promise<SubmitResult> {
  const t0 = Date.now();
  const message = JSON.stringify(payload);
  if (Buffer.byteLength(message) > 1024) throw new Error(`HCS message too large (${Buffer.byteLength(message)} bytes, max 1024 unchunked)`);
  const tx = new TopicMessageSubmitTransaction({ topicId: TopicId.fromString(topicId), message }).freezeWith(client);
  const signed = signingKey ? await tx.sign(signingKey) : tx;
  const resp = await signed.execute(client);
  const receipt = await resp.getReceipt(client);
  return {
    topicId,
    sequence: Number(receipt.topicSequenceNumber?.toString() ?? "0"),
    txId: normaliseTxId(resp.transactionId.toString()),
    submitMs: Date.now() - t0,
  };
}

// ------------------------------------------------------------------ validation

const ID = /^\d+\.\d+\.\d+$/;
const INT = /^\d+$/;
const TXID = /^\d+\.\d+\.\d+-\d+-\d{9}$/;
const TS = /^\d+\.\d{1,9}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function tryJson(text: string): Parsed<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: "not JSON" };
  }
}

/** Validate an already-decoded object as a Receipt. Unknown extra fields are dropped. */
export function validateReceipt(v: unknown): Parsed<Receipt> {
  if (!isObj(v)) return { ok: false, error: "not an object" };
  if (v.v !== 1) return { ok: false, error: "bad version" };
  if (v.type !== "receipt") return { ok: false, error: "not a receipt" };
  if (!isStr(v.txId) || !TXID.test(v.txId)) return { ok: false, error: "bad txId" };
  for (const k of ["token", "from", "to"] as const) {
    if (!isStr(v[k]) || !ID.test(v[k] as string)) return { ok: false, error: `bad ${k}` };
  }
  if (!isStr(v.amount) || !INT.test(v.amount) || BigInt(v.amount) <= 0n) return { ok: false, error: "bad amount" };
  if (BigInt(v.amount) > 9223372036854775807n) return { ok: false, error: "amount overflows int64" };
  if (v.kind !== "transfer" && v.kind !== "mint") return { ok: false, error: "bad kind" };
  if (!isStr(v.machine) || v.machine.length === 0 || v.machine.length > 64) return { ok: false, error: "bad machine" };
  if (!isStr(v.approvedAt) || Number.isNaN(Date.parse(v.approvedAt))) return { ok: false, error: "bad approvedAt" };
  if (v.consensusAt !== undefined && (!isStr(v.consensusAt) || !TS.test(v.consensusAt))) return { ok: false, error: "bad consensusAt" };
  if (v.scheduleId !== undefined && (!isStr(v.scheduleId) || !ID.test(v.scheduleId))) return { ok: false, error: "bad scheduleId" };
  const r: Receipt = {
    v: 1,
    type: "receipt",
    txId: v.txId,
    token: v.token as string,
    from: v.from as string,
    to: v.to as string,
    amount: v.amount,
    kind: v.kind,
    machine: v.machine,
    approvedAt: v.approvedAt,
  };
  if (isStr(v.scheduleId)) r.scheduleId = v.scheduleId;
  if (isStr(v.consensusAt)) r.consensusAt = v.consensusAt;
  return { ok: true, value: r };
}

export function parseReceipt(text: string): Parsed<Receipt> {
  const j = tryJson(text);
  return j.ok ? validateReceipt(j.value) : j;
}

/** Read a receipt from a topic message: the consensus time ALWAYS comes from the Mirror, never the payload. */
export function receiptFromMessage(m: TopicMessage): Parsed<Receipt> {
  const p = parseReceipt(m.text);
  if (!p.ok) return p;
  return { ok: true, value: { ...p.value, consensusAt: m.consensusAt } };
}

/** Incidents carry a reason that may go beyond the shared BreachReason (e.g. treasury-allowance). */
export type IncidentOut = Omit<Incident, "breaches"> & {
  breaches: { txId: string; to: string; amount: string; reason: string }[];
};

export function validateIncident(v: unknown): Parsed<IncidentOut> {
  if (!isObj(v)) return { ok: false, error: "not an object" };
  if (v.v !== 1 || v.type !== "incident") return { ok: false, error: "not an incident" };
  if (!isStr(v.incidentId) || !/^0x[0-9a-fA-F]{64}$/.test(v.incidentId)) return { ok: false, error: "bad incidentId" };
  if (!isStr(v.token) || !ID.test(v.token)) return { ok: false, error: "bad token" };
  if (!Array.isArray(v.breaches)) return { ok: false, error: "bad breaches" };
  for (const b of v.breaches) {
    if (!isObj(b) || !isStr(b.txId) || !isStr(b.to) || !isStr(b.amount) || !isStr(b.reason)) return { ok: false, error: "bad breach entry" };
  }
  if (!Array.isArray(v.actions)) return { ok: false, error: "bad actions" };
  for (const a of v.actions) {
    if (!isObj(a) || !isStr(a.step) || typeof a.ok !== "boolean" || typeof a.atMs !== "number") return { ok: false, error: "bad action entry" };
  }
  if (typeof v.detectedMs !== "number") return { ok: false, error: "bad detectedMs" };
  if (v.containedMs !== undefined && typeof v.containedMs !== "number") return { ok: false, error: "bad containedMs" };
  return { ok: true, value: v as unknown as IncidentOut };
}

export function parseIncident(text: string): Parsed<IncidentOut> {
  const j = tryJson(text);
  return j.ok ? validateIncident(j.value) : j;
}

/** Watcher liveness message on the heartbeats topic. */
export interface Heartbeat {
  v: 1;
  type: "heartbeat";
  who: "watcher";
  at: string; // ISO, informational
  matched: number;
  incidents: number;
  lagMs: number;
}

export function parseHeartbeat(text: string): Parsed<Heartbeat> {
  const j = tryJson(text);
  if (!j.ok) return j;
  const v = j.value;
  if (!isObj(v) || v.v !== 1 || v.type !== "heartbeat" || v.who !== "watcher") return { ok: false, error: "not a watcher heartbeat" };
  return { ok: true, value: v as unknown as Heartbeat };
}

/**
 * Compact incident for HCS (1 KB message limit): the long tail of breaches/actions is
 * trimmed and the counts kept, so the topic always gets a valid message.
 */
export function compactIncident(i: IncidentOut, maxBytes = 1000): IncidentOut {
  let out: IncidentOut = { ...i };
  const size = () => Buffer.byteLength(JSON.stringify(out));
  while (size() > maxBytes && (out.breaches.length > 1 || out.actions.length > 1)) {
    if (out.actions.length >= out.breaches.length && out.actions.length > 1) out = { ...out, actions: out.actions.slice(0, -1) };
    else out = { ...out, breaches: out.breaches.slice(0, -1) };
  }
  return out;
}

// ------------------------------------------------------------------ read back

/** Read all valid receipts on the receipts topic after `afterSeq`. Invalid messages are returned separately. */
export async function readReceipts(mirror: MirrorClient, topicId: string, afterSeq: number) {
  const msgs = await mirror.topicMessagesSince(topicId, afterSeq);
  const receipts: Receipt[] = [];
  const invalid: { sequence: number; error: string }[] = [];
  let lastSeq = afterSeq;
  for (const m of msgs) {
    lastSeq = Math.max(lastSeq, m.sequence);
    const p = receiptFromMessage(m);
    if (p.ok) receipts.push(p.value);
    else invalid.push({ sequence: m.sequence, error: p.error });
  }
  return { receipts, invalid, lastSeq };
}
