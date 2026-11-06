// Issuer signer core (I/O injected, so the HTTP service is tested offline).
//   POST /schedule {scheduleId}  -> verify on the Mirror Node, then ScheduleSign (or refuse). Waits for the answer.
//   GET  /health, GET /decisions (recent), GET /events (SSE: "signed", "refused")
// It also polls the Mirror for schedules created by the gate, so a schedule the gate never announced is
// still judged (and refused if it has no receipt). It never signs without a matching receipt.
import express from "express";
import type { MirrorClient, MirrorSchedule } from "../shared/mirror.js";
import { receiptFromMessage } from "../shared/hcs.js";
import type { Rules } from "../shared/types.js";
import { SseHub } from "../gate/sse.js";
import { verifySchedule, type RefuseReason, type ScheduledTransfer, type SeenReceipt } from "./verify.js";

export type SignerMirror = Pick<MirrorClient, "schedule" | "schedulesCreatedBy" | "transactionsAt" | "topicMessagesSince">;

export interface SignResult {
  status: string; // ScheduleSign receipt status, e.g. SUCCESS
  signTxId: string; // the ScheduleSign transaction (Mirror spelling)
  executedStatus?: string; // the scheduled transfer's own receipt status, when known
}

export interface SignerDeps {
  mirror: SignerMirror;
  rules: Rules;
  gateAccount: string;
  receiptsTopic: string;
  /** ScheduleSign with the treasury-signer key (the ONLY key this process holds). */
  sign: (scheduleId: string, scheduledTxId: string) => Promise<SignResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** how long a schedule may wait for its receipt to be readable on the Mirror before it is refused for good */
  receiptWaitMs?: number;
  /** delay between Mirror re-reads while waiting */
  retryMs?: number;
  log?: (line: string) => void;
}

export type SignerDecision =
  | { ok: true; scheduleId: string; scheduledTxId: string; transfer: ScheduledTransfer; receiptSequence?: number; receiptConsensusAt: string; signTxId: string; status: string; executedStatus?: string; verifyMs: number; signMs: number; at: string }
  | { ok: false; scheduleId: string; scheduledTxId?: string; reason: RefuseReason | "schedule-not-found" | "sign-failed"; detail: string; at: string; verifyMs: number };

const ID = /^\d+\.\d+\.\d+$/;

export function createSigner(d: SignerDeps) {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = d.receiptWaitMs ?? 60_000;
  const retryMs = d.retryMs ?? 750;
  const hub = new SseHub();
  const receipts: (SeenReceipt & { sequence: number })[] = [];
  let receiptSeq = 0;
  const inflight = new Map<string, Promise<SignerDecision>>();
  const decided = new Map<string, SignerDecision>(); // final decisions, by schedule id (never re-judged by this process)
  const recent: SignerDecision[] = [];
  let signed = 0;
  let refused = 0;
  let signing: Promise<unknown> = Promise.resolve(); // one ScheduleSign at a time

  async function refreshReceipts(): Promise<void> {
    const msgs = await d.mirror.topicMessagesSince(d.receiptsTopic, receiptSeq);
    for (const m of msgs) {
      receiptSeq = Math.max(receiptSeq, m.sequence);
      const p = receiptFromMessage(m);
      if (p.ok) receipts.push({ ...p.value, payer: m.payer, sequence: m.sequence });
    }
  }

  async function scheduledTxIdOf(s: MirrorSchedule): Promise<string | null> {
    const txs = await d.mirror.transactionsAt(s.consensus_timestamp);
    const create = txs.find((t) => t.name === "SCHEDULECREATE" && t.entity_id === s.schedule_id && !t.scheduled);
    return create ? create.transaction_id : null;
  }

  function record(dec: SignerDecision): SignerDecision {
    decided.set(dec.scheduleId, dec);
    recent.push(dec);
    if (recent.length > 100) recent.shift();
    if (dec.ok) signed++;
    else refused++;
    hub.publish(dec.ok ? "signed" : "refused", dec);
    d.log?.(dec.ok ? `signed ${dec.scheduleId} (${dec.scheduledTxId}): ${dec.transfer.amount} -> ${dec.transfer.to}, ${dec.status}` : `REFUSED ${dec.scheduleId}: ${dec.reason}: ${dec.detail}`);
    return dec;
  }

  async function judge(scheduleId: string): Promise<SignerDecision> {
    const t0 = now();
    const at = () => new Date(now()).toISOString();
    let last: { reason: RefuseReason | "schedule-not-found"; detail: string; scheduledTxId?: string } = { reason: "schedule-not-found", detail: "schedule not found on the Mirror Node" };
    for (;;) {
      const s = await d.mirror.schedule(scheduleId).catch(() => null);
      if (s) {
        const txId = await scheduledTxIdOf(s).catch(() => null);
        if (!txId) {
          last = { reason: "schedule-not-found", detail: "ScheduleCreate transaction not readable yet" };
        } else {
          await refreshReceipts().catch((e) => d.log?.(`receipts read failed: ${(e as Error).message}`));
          const v = verifySchedule({ schedule: s, scheduledTxId: txId, receipts, rules: d.rules, gateAccount: d.gateAccount, nowSec: Math.floor(now() / 1000) });
          if (v.ok) {
            const verifyMs = now() - t0;
            const t1 = now();
            const job = signing.then(() => d.sign(scheduleId, txId));
            signing = job.catch(() => undefined);
            try {
              const r = await job;
              const seq = (v.receipt as SeenReceipt & { sequence?: number }).sequence;
              return record({ ok: true, scheduleId, scheduledTxId: txId, transfer: v.transfer, receiptSequence: seq, receiptConsensusAt: v.receipt.consensusAt!, signTxId: r.signTxId, status: r.status, executedStatus: r.executedStatus, verifyMs, signMs: now() - t1, at: at() });
            } catch (e) {
              return record({ ok: false, scheduleId, scheduledTxId: txId, reason: "sign-failed", detail: (e as Error).message, at: at(), verifyMs });
            }
          }
          if (v.final) return record({ ok: false, scheduleId, scheduledTxId: txId, reason: v.reason, detail: v.detail, at: at(), verifyMs: now() - t0 });
          last = { reason: v.reason, detail: v.detail, scheduledTxId: txId };
        }
      }
      if (now() - t0 >= waitMs) {
        return record({ ok: false, scheduleId, scheduledTxId: last.scheduledTxId, reason: last.reason, detail: `${last.detail} (gave up after ${Math.round(waitMs / 1000)} s)`, at: at(), verifyMs: now() - t0 });
      }
      await sleep(retryMs);
    }
  }

  /** Judge a schedule once; concurrent and repeated asks share the same (final) answer. */
  function process(scheduleId: string): Promise<SignerDecision> {
    const done = decided.get(scheduleId);
    if (done) return Promise.resolve(done);
    let p = inflight.get(scheduleId);
    if (!p) {
      p = judge(scheduleId).finally(() => inflight.delete(scheduleId));
      inflight.set(scheduleId, p);
    }
    return p;
  }

  /** One poll: every unexecuted, undeleted, unexpired schedule the gate created that we have not judged. */
  async function pollOnce(): Promise<number> {
    const list = await d.mirror.schedulesCreatedBy(d.gateAccount);
    const nowSec = Math.floor(now() / 1000);
    const todo = list.filter((s) => !s.deleted && !s.executed_timestamp && !(s.expiration_time && Number(s.expiration_time.split(".")[0]) <= nowSec) && !decided.has(s.schedule_id) && !inflight.has(s.schedule_id));
    for (const s of todo) void process(s.schedule_id);
    return todo.length;
  }

  const app = express();
  app.use(express.json({ limit: "2kb" }));
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "issuer signer", gate: d.gateAccount, treasury: d.rules.treasury, token: d.rules.token, receiptsTopic: d.receiptsTopic, receiptsRead: receipts.length, signed, refused, pending: inflight.size, sseClients: hub.size });
  });
  app.get("/decisions", (_req, res) => res.json({ ok: true, decisions: recent.slice(-50) }));
  app.get("/events", hub.handler);
  app.post("/schedule", (req, res) => {
    const id = (req.body as { scheduleId?: unknown })?.scheduleId;
    if (typeof id !== "string" || !ID.test(id)) return void res.status(400).json({ ok: false, reason: "bad-request", detail: "scheduleId must be 0.0.x" });
    process(id).then(
      (dec) => res.status(dec.ok ? 200 : 409).json(dec),
      (e) => res.status(500).json({ ok: false, reason: "internal", detail: (e as Error).message }),
    );
  });

  return { app, hub, process, pollOnce, refreshReceipts, receipts };
}
