// A Levee normal send is a Hedera scheduled transaction. Live Mirror records (testnet, 2026-11-06):
// the SCHEDULECREATE (by the gate) and the executed CRYPTOTRANSFER share one transaction_id; the
// executed one has scheduled=true. The gate's receipt names that id, so the watcher matches it with
// no change, and the issuer signer's check accepts the live schedule body.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { decodeTopicMessages, extractMovements, type MirrorTransaction } from "../../src/shared/mirror.js";
import { receiptFromMessage } from "../../src/shared/hcs.js";
import { matchMovements, newMatchState } from "../../src/watcher/match.js";
import { verifySchedule } from "../../src/signer/verify.js";

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/mirror-scheduled-transfer.json"), "utf8"));
const txs: MirrorTransaction[] = fx.transactions;
const TOKEN = "0.0.11333594", TREASURY = "0.0.11333495", GATE = "0.0.11333489", ASHA = "0.0.11333490";
const rules = { token: TOKEN, treasury: TREASURY, capPerTransfer: 10_000_000_000n, capPerDay: 300_000_000_000n, knownDestinations: [ASHA, "0.0.11333492"] };
const [msg] = decodeTopicMessages([fx.receiptMessage]);
const receipt = receiptFromMessage(msg);

describe("scheduled transfer on the Mirror Node (live fixture)", () => {
  it("schedule-create and executed transfer share the transaction id; only the transfer has scheduled=true", () => {
    const [create, transfer] = [...txs].sort((a, b) => a.consensus_timestamp.localeCompare(b.consensus_timestamp));
    expect(create).toMatchObject({ name: "SCHEDULECREATE", scheduled: false, entity_id: fx.schedule.schedule_id });
    expect(transfer).toMatchObject({ name: "CRYPTOTRANSFER", scheduled: true, result: "SUCCESS" });
    expect(transfer.transaction_id).toBe(create.transaction_id);
  });

  it("the receipt names that id and the schedule, and reached consensus before the transfer", () => {
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.value).toMatchObject({ txId: txs[0].transaction_id, scheduleId: fx.schedule.schedule_id, to: ASHA, amount: "500000000" });
    expect(msg.payer).toBe(GATE);
  });

  it("extractMovements finds one treasury outflow under the scheduled id, and the watcher matches it", () => {
    const mv = extractMovements(txs, { token: TOKEN, treasury: TREASURY });
    expect(mv).toHaveLength(1);
    expect(mv[0]).toMatchObject({ txId: txs[0].transaction_id, from: TREASURY, to: ASHA, amount: "500000000", kind: "transfer" });
    if (!receipt.ok) throw new Error("bad receipt");
    const res = matchMovements(mv, new Map([[receipt.value.txId, receipt.value]]), rules, newMatchState());
    expect(res.breaches).toEqual([]);
    expect(res.matched).toHaveLength(1);
  });

  it("the issuer signer's check accepts the live schedule body with this receipt (as it did before executing)", () => {
    if (!receipt.ok) throw new Error("bad receipt");
    const before = { ...fx.schedule, executed_timestamp: null }; // as the signer saw it, before its signature
    const nowSec = Number(fx.schedule.consensus_timestamp.split(".")[0]) + 3;
    const v = verifySchedule({ schedule: before, scheduledTxId: txs[0].transaction_id, receipts: [{ ...receipt.value, payer: msg.payer }], rules, gateAccount: GATE, nowSec });
    expect(v).toMatchObject({ ok: true, transfer: { token: TOKEN, from: TREASURY, to: ASHA, amount: "500000000" } });
    // and the executed schedule is never signed again
    expect(verifySchedule({ schedule: fx.schedule, scheduledTxId: txs[0].transaction_id, receipts: [{ ...receipt.value, payer: msg.payer }], rules, gateAccount: GATE, nowSec })).toMatchObject({ ok: false, reason: "already-executed" });
  });
});
