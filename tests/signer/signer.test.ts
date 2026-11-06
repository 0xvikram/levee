// Issuer signer: signs a gate schedule ONLY when a matching receipt is on the receipts topic and the
// rules pass; refuses (and never signs) otherwise.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import * as hiero from "@hiero-ledger/proto";
import { buildScheduleCreate } from "../../src/gate/server.js";
import type { DeployState } from "../../src/shared/config.js";
import type { MirrorSchedule, MirrorTransaction, TopicMessage } from "../../src/shared/mirror.js";
import { createSigner, type SignerMirror } from "../../src/signer/service.js";
import { decodeScheduledTransfer, verifySchedule, type SeenReceipt } from "../../src/signer/verify.js";

const { proto } = hiero as unknown as { proto: any };
const GATE = "0.0.6100";
const TREASURY = "0.0.6000";
const TOKEN = "0.0.5001";
const PAYEE = "0.0.6001";
const state = { token: { tokenId: TOKEN }, treasury: { id: TREASURY }, gate: { id: GATE } } as unknown as DeployState;
const rules = { token: TOKEN, treasury: TREASURY, capPerTransfer: 10_000n, capPerDay: 50_000n, knownDestinations: [PAYEE] };
const NOW = 1_800_000_000; // seconds

/** The base64 SchedulableTransactionBody the Mirror serves for a schedule the gate built. */
function bodyFor(to: string, amount: string): string {
  const tx = buildScheduleCreate(state, { machine: "payouts-1", to, amount, kind: "transfer" }, { nowMs: NOW * 1000 });
  const data = (tx as any)._makeTransactionData();
  return Buffer.from(proto.SchedulableTransactionBody.encode(data.scheduledTransactionBody).finish()).toString("base64");
}
function rawBody(o: object): string {
  return Buffer.from(proto.SchedulableTransactionBody.encode({ transactionFee: 1, ...o }).finish()).toString("base64");
}
const sched = (id: string, to = PAYEE, amount = "500", extra: Partial<MirrorSchedule> = {}): MirrorSchedule => ({
  schedule_id: id,
  consensus_timestamp: `${NOW - 10}.000000001`,
  creator_account_id: GATE,
  payer_account_id: GATE,
  deleted: false,
  executed_timestamp: null,
  expiration_time: `${NOW + 300}.000000000`,
  transaction_body: bodyFor(to, amount),
  ...extra,
});
const txIdFor = (id: string) => `${GATE}-${NOW - 12}-${id.split(".")[2].padStart(9, "0")}`;
const receiptFor = (id: string, o: Partial<SeenReceipt> = {}): SeenReceipt => ({
  v: 1, type: "receipt", txId: txIdFor(id), token: TOKEN, from: TREASURY, to: PAYEE, amount: "500", kind: "transfer",
  machine: "payouts-1", approvedAt: "2027-01-15T08:00:00.000Z", scheduleId: id, consensusAt: `${NOW - 5}.000000000`, payer: GATE, ...o,
});

describe("decodeScheduledTransfer", () => {
  it("reads the gate's own schedule body", () => {
    expect(decodeScheduledTransfer(bodyFor(PAYEE, "500"))).toEqual({ ok: true, value: { token: TOKEN, from: TREASURY, to: PAYEE, amount: "500" } });
  });
  it.each([
    ["not a transfer", rawBody({ consensusSubmitMessage: { message: Buffer.from("x") } })],
    ["HBAR legs", rawBody({ cryptoTransfer: { transfers: { accountAmounts: [{ accountID: { accountNum: 6000 }, amount: -1 }, { accountID: { accountNum: 6001 }, amount: 1 }] } } })],
    ["three legs", rawBody({ cryptoTransfer: { tokenTransfers: [{ token: { tokenNum: 5001 }, transfers: [{ accountID: { accountNum: 6000 }, amount: -2 }, { accountID: { accountNum: 6001 }, amount: 1 }, { accountID: { accountNum: 6666 }, amount: 1 }] }] } })],
    ["alias account", rawBody({ cryptoTransfer: { tokenTransfers: [{ token: { tokenNum: 5001 }, transfers: [{ accountID: { accountNum: 6000 }, amount: -1 }, { accountID: { alias: Buffer.alloc(20, 1) }, amount: 1 }] }] } })],
    ["garbage", "!!!notbase64protobuf"],
  ])("refuses %s", (_n, b) => {
    expect(decodeScheduledTransfer(b).ok).toBe(false);
  });
});

describe("verifySchedule", () => {
  const base = { scheduledTxId: txIdFor("0.0.8001"), rules, gateAccount: GATE, nowSec: NOW };
  it("ok with the matching receipt", () => {
    expect(verifySchedule({ ...base, schedule: sched("0.0.8001"), receipts: [receiptFor("0.0.8001")] }).ok).toBe(true);
  });
  it("no receipt -> not yet (final: false)", () => {
    expect(verifySchedule({ ...base, schedule: sched("0.0.8001"), receipts: [] })).toMatchObject({ ok: false, final: false, reason: "no-receipt" });
  });
  it("a receipt for another tx id does not count", () => {
    expect(verifySchedule({ ...base, schedule: sched("0.0.8001"), receipts: [receiptFor("0.0.8002")] })).toMatchObject({ reason: "no-receipt" });
  });
  it.each([
    ["amount", { amount: "499" }],
    ["recipient", { to: "0.0.6002" }],
    ["kind", { kind: "mint" as const }],
    ["schedule id", { scheduleId: "0.0.9999" }],
  ])("receipt-mismatch on %s", (_n, o) => {
    expect(verifySchedule({ ...base, schedule: sched("0.0.8001"), receipts: [receiptFor("0.0.8001", o)] })).toMatchObject({ ok: false, final: true, reason: "receipt-mismatch" });
  });
  it("unknown recipient even with a matching receipt", () => {
    const r = verifySchedule({ ...base, schedule: sched("0.0.8001", "0.0.6666"), receipts: [receiptFor("0.0.8001", { to: "0.0.6666" })] });
    expect(r).toMatchObject({ ok: false, final: true, reason: "unknown-destination" });
  });
  it("over the per-transfer cap even with a matching receipt", () => {
    const r = verifySchedule({ ...base, schedule: sched("0.0.8001", PAYEE, "10001"), receipts: [receiptFor("0.0.8001", { amount: "10001" })] });
    expect(r).toMatchObject({ reason: "over-transfer-cap" });
  });
  it("over the daily cap counting earlier receipts of the same day", () => {
    const earlier = Array.from({ length: 5 }, (_, i) => receiptFor(`0.0.70${i}`, { amount: "10000", consensusAt: `${NOW - 100 + i}.000000000` }));
    const r = verifySchedule({ ...base, schedule: sched("0.0.8001"), receipts: [...earlier, receiptFor("0.0.8001")] });
    expect(r).toMatchObject({ reason: "over-daily-cap" });
  });
  it("receipt not paid by the gate", () => {
    expect(verifySchedule({ ...base, schedule: sched("0.0.8001"), receipts: [receiptFor("0.0.8001", { payer: "0.0.666" })] })).toMatchObject({ reason: "receipt-not-from-gate" });
  });
  it.each([
    ["not-from-gate", { creator_account_id: "0.0.666" }],
    ["deleted", { deleted: true }],
    ["already-executed", { executed_timestamp: `${NOW}.0` }],
    ["expired", { expiration_time: `${NOW - 1}.000000000` }],
  ])("%s", (reason, extra) => {
    expect(verifySchedule({ ...base, schedule: sched("0.0.8001", PAYEE, "500", extra), receipts: [receiptFor("0.0.8001")] })).toMatchObject({ ok: false, reason });
  });
  it("wrong token / not from the treasury", () => {
    expect(verifySchedule({ ...base, rules: { ...rules, token: "0.0.5002" }, schedule: sched("0.0.8001"), receipts: [receiptFor("0.0.8001")] })).toMatchObject({ reason: "wrong-token" });
    expect(verifySchedule({ ...base, rules: { ...rules, treasury: "0.0.6009" }, schedule: sched("0.0.8001"), receipts: [receiptFor("0.0.8001")] })).toMatchObject({ reason: "not-from-treasury" });
  });
});

describe("issuer signer service", () => {
  const schedules = new Map<string, MirrorSchedule>();
  let messages: TopicMessage[] = [];
  const signedIds: string[] = [];
  const mirror: SignerMirror = {
    schedule: async (id) => schedules.get(id) ?? null,
    schedulesCreatedBy: async () => [...schedules.values()],
    transactionsAt: async (ts) =>
      [...schedules.values()].filter((s) => s.consensus_timestamp === ts).map((s) => ({ name: "SCHEDULECREATE", entity_id: s.schedule_id, scheduled: false, transaction_id: txIdFor(s.schedule_id), consensus_timestamp: ts, result: "SUCCESS" }) as MirrorTransaction),
    topicMessagesSince: async (_t, after) => messages.filter((m) => m.sequence > after),
  };
  const addReceipt = (r: SeenReceipt) => {
    const { payer, consensusAt, ...payload } = r;
    messages = [...messages, { sequence: messages.length + 1, consensusAt: consensusAt!, payer, text: JSON.stringify(payload) }];
  };
  // distinct consensus timestamps per schedule so transactionsAt finds the right ScheduleCreate
  const put = (id: string, to = PAYEE, amount = "500") => schedules.set(id, sched(id, to, amount, { consensus_timestamp: `${NOW - 10}.${id.split(".")[2].padStart(9, "0")}` }));

  const signer = createSigner({
    mirror, rules, gateAccount: GATE, receiptsTopic: "0.0.9001",
    sign: async (id) => {
      signedIds.push(id);
      return { status: "SUCCESS", signTxId: `0.0.7000-${NOW}-000000001`, executedStatus: "SUCCESS" };
    },
    now: () => NOW * 1000,
    sleep: async () => {},
    receiptWaitMs: 0, // tests: one look, then decide
  });
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = signer.app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());
  const ask = (scheduleId: unknown) => fetch(`${base}/schedule`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scheduleId }) });

  it("signs when the matching receipt is on the topic", async () => {
    put("0.0.8001");
    addReceipt(receiptFor("0.0.8001"));
    const r = await ask("0.0.8001");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, scheduleId: "0.0.8001", scheduledTxId: txIdFor("0.0.8001"), status: "SUCCESS", receiptSequence: 1 });
    expect(signedIds).toEqual(["0.0.8001"]);
  });

  it("refuses a schedule with no receipt, and never signs it", async () => {
    put("0.0.8002");
    const r = await ask("0.0.8002");
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ ok: false, reason: "no-receipt" });
    // a later ask gets the same final answer: no second look, no signature
    addReceipt(receiptFor("0.0.8002"));
    expect(await (await ask("0.0.8002")).json()).toMatchObject({ ok: false, reason: "no-receipt" });
    expect(signedIds).not.toContain("0.0.8002");
  });

  it("refuses a mismatched amount", async () => {
    put("0.0.8003", PAYEE, "900");
    addReceipt(receiptFor("0.0.8003", { amount: "500" }));
    expect(await (await ask("0.0.8003")).json()).toMatchObject({ ok: false, reason: "receipt-mismatch" });
  });

  it("refuses an unknown recipient", async () => {
    put("0.0.8004", "0.0.6666");
    addReceipt(receiptFor("0.0.8004", { to: "0.0.6666" }));
    expect(await (await ask("0.0.8004")).json()).toMatchObject({ ok: false, reason: "unknown-destination" });
  });

  it("refuses over the cap", async () => {
    put("0.0.8005", PAYEE, "20000");
    addReceipt(receiptFor("0.0.8005", { amount: "20000" }));
    expect(await (await ask("0.0.8005")).json()).toMatchObject({ ok: false, reason: "over-transfer-cap" });
  });

  it("refuses an unknown schedule and a bad id", async () => {
    expect(await (await ask("0.0.1")).json()).toMatchObject({ ok: false, reason: "schedule-not-found" });
    expect((await ask("x")).status).toBe(400);
  });

  it("the poll judges schedules the gate never announced", async () => {
    put("0.0.8006");
    expect(await signer.pollOnce()).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    const health = (await (await fetch(`${base}/health`)).json()) as any;
    expect(health).toMatchObject({ ok: true, service: "issuer signer", signed: 1 });
    expect(health.refused).toBeGreaterThanOrEqual(5);
    expect(signedIds).toEqual(["0.0.8001"]);
  });

  it("waits for a receipt that is not readable yet, then signs", async () => {
    let t = NOW * 1000;
    let looks = 0;
    const s2 = createSigner({
      mirror: { ...mirror, topicMessagesSince: async (topic, after) => (++looks >= 3 ? mirror.topicMessagesSince(topic, after) : []) },
      rules, gateAccount: GATE, receiptsTopic: "0.0.9001",
      sign: async () => ({ status: "SUCCESS", signTxId: "0.0.7000-1-000000002" }),
      now: () => t,
      sleep: async (ms) => void (t += ms),
      receiptWaitMs: 10_000,
    });
    put("0.0.8007");
    addReceipt(receiptFor("0.0.8007"));
    expect(await s2.process("0.0.8007")).toMatchObject({ ok: true });
    expect(looks).toBeGreaterThanOrEqual(3);
  });
});
