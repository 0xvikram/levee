import { describe, expect, it } from "vitest";
import { chainFeed, cmpConsensus, decideMode, DECIDE_MS, hcsTxId, parseReceipts, treasuryOutflows, type MirrorTopicMsg, type MirrorTx } from "../chain";
import { serviceUrl, servicesReachable } from "../config";
import { pickGenuineIncident } from "../incident";
import { replayContain, replayEndMs, replayPipeline } from "../replay";
import { elapsedMs } from "../stopwatch";
import type { Incident } from "../types";
import { BREACH, INCIDENT } from "./fixtures";

const TOKEN = "0.0.11333594";
const TREASURY = "0.0.11333495";
const b64 = (v: unknown) => btoa(JSON.stringify(v));

// Real receipt + transfer from the testnet run on 6 Nov 2026 (Mirror Node responses, trimmed).
const RECEIPT_MSG: MirrorTopicMsg = {
  consensus_timestamp: "1793938974.289114817",
  message: b64({ v: 1, type: "receipt", txId: "0.0.11333495-1793938968-211036439", token: TOKEN, from: TREASURY, to: "0.0.11333492", amount: "779974127", kind: "transfer", machine: "payouts-server", approvedAt: "2026-11-06T04:22:53.848Z" }),
  chunk_info: { initial_transaction_id: { account_id: "0.0.11333489", transaction_valid_start: "1793938968.573814471" } },
};
const PAID: MirrorTx = {
  transaction_id: "0.0.11333495-1793938968-211036439",
  consensus_timestamp: "1793938975.489142104",
  result: "SUCCESS",
  nonce: 0,
  token_transfers: [
    { token_id: TOKEN, account: "0.0.11333492", amount: 779974127 },
    { token_id: TOKEN, account: TREASURY, amount: -779974127 },
  ],
};
const STOLEN: MirrorTx = {
  transaction_id: BREACH.txId,
  consensus_timestamp: BREACH.consensusAt,
  result: "SUCCESS",
  nonce: 0,
  token_transfers: [
    { token_id: TOKEN, account: "0.0.11333494", amount: 10000000000 },
    { token_id: TOKEN, account: TREASURY, amount: -10000000000 },
  ],
};
const FAILED: MirrorTx = { transaction_id: "0.0.11333495-1793940565-310727999", consensus_timestamp: "1793940573.437732476", result: "ACCOUNT_FROZEN_FOR_TOKEN", nonce: 0, token_transfers: [] };

describe("decideMode", () => {
  it("public site is chain mode at once", () => {
    expect(decideMode({ local: false, anyUp: false, elapsedMs: 0 })).toBe("chain");
  });
  it("localhost waits DECIDE_MS for any service, then falls back to the chain", () => {
    expect(decideMode({ local: true, anyUp: false, elapsedMs: 0 })).toBe("checking");
    expect(decideMode({ local: true, anyUp: false, elapsedMs: DECIDE_MS - 1 })).toBe("checking");
    expect(decideMode({ local: true, anyUp: false, elapsedMs: DECIDE_MS })).toBe("chain");
    expect(decideMode({ local: true, anyUp: true, elapsedMs: 60_000 })).toBe("local");
  });
});

describe("service reachability", () => {
  it("local hosts and Vite ports reach the services; the public site does not", () => {
    expect(servicesReachable({ hostname: "localhost", port: "5173", protocol: "http:" })).toBe(true);
    expect(servicesReachable({ hostname: "192.168.1.4", port: "4173", protocol: "http:" })).toBe(true);
    expect(servicesReachable({ hostname: "levee.vercel.app", port: "", protocol: "https:" })).toBe(false);
    expect(serviceUrl("watcher", "/state", { hostname: "levee.vercel.app", port: "", protocol: "https:" })).toBe("");
    expect(serviceUrl("watcher", "/state", { hostname: "127.0.0.1", port: "5173", protocol: "http:" })).toBe("/api/watcher/state");
  });
});

describe("Mirror parsing", () => {
  it("compares consensus timestamps exactly", () => {
    expect(cmpConsensus("1.000000001", "1.000000002")).toBe(-1);
    expect(cmpConsensus("2.1", "1.999999999")).toBe(1);
    expect(cmpConsensus("5.5", "5.500000000")).toBe(0);
  });
  it("builds the HCS submit tx id from chunk_info", () => {
    expect(hcsTxId(RECEIPT_MSG)).toBe("0.0.11333489-1793938968-573814471");
    expect(hcsTxId({ consensus_timestamp: "1.0", message: "" })).toBeUndefined();
  });
  it("keeps the earliest receipt per transfer, ignores other tokens and junk", () => {
    const later = { ...RECEIPT_MSG, consensus_timestamp: "1793938999.000000000", chunk_info: null };
    const other = { ...RECEIPT_MSG, message: b64({ v: 1, type: "receipt", txId: "x", token: "0.0.1", to: "a", amount: "1" }) };
    const r = parseReceipts([later, RECEIPT_MSG, other, { consensus_timestamp: "1.0", message: "!!!" }], TOKEN);
    expect([...r.keys()]).toEqual(["0.0.11333495-1793938968-211036439"]);
    expect(r.get(PAID.transaction_id)).toMatchObject({ consensusAt: RECEIPT_MSG.consensus_timestamp, machine: "payouts-server", hcsTxId: "0.0.11333489-1793938968-573814471" });
  });
  it("treasury outflows: net negative per transaction, failed ones skipped, newest first", () => {
    const m = treasuryOutflows([PAID, FAILED, STOLEN], { token: TOKEN, treasury: TREASURY });
    expect(m).toEqual([
      { txId: PAID.transaction_id, consensusAt: PAID.consensus_timestamp, to: "0.0.11333492", amount: "779974127" },
      { txId: BREACH.txId, consensusAt: BREACH.consensusAt, to: "0.0.11333494", amount: "10000000000" },
    ]);
    // an inflow to the treasury is not a movement
    const inflow = { ...PAID, transaction_id: "in", token_transfers: PAID.token_transfers!.map((t) => ({ ...t, amount: -Number(t.amount) })) };
    expect(treasuryOutflows([inflow], { token: TOKEN, treasury: TREASURY })).toEqual([]);
  });
});

describe("chainFeed", () => {
  const moves = treasuryOutflows([PAID, STOLEN], { token: TOKEN, treasury: TREASURY });
  const receipts = parseReceipts([RECEIPT_MSG], TOKEN);
  it("matches receipt → transfer by tx id and marks the theft contained by its incident", () => {
    const rows = chainFeed(moves, receipts, [INCIDENT]);
    expect(rows.map((r) => [r.txId, r.status])).toEqual([
      [PAID.transaction_id, "receipt"],
      [BREACH.txId, "breach"],
    ]);
    expect(rows[0]).toMatchObject({ machine: "payouts-server", receiptTxId: "0.0.11333489-1793938968-573814471" });
    expect(rows[1]).toMatchObject({ reason: "no-receipt", contained: true });
    expect(rows[1].historic).toBeUndefined();
  });
  it("a breach with no successful incident is historic, never live red", () => {
    const rows = chainFeed(moves, receipts, []);
    expect(rows[1]).toMatchObject({ status: "breach", historic: true });
  });
  it("a receipt that reached consensus after the move, or names other values, is a breach", () => {
    const late = new Map([[PAID.transaction_id, { ...receipts.get(PAID.transaction_id)!, consensusAt: "1793938976.000000000" }]]);
    expect(chainFeed(moves.slice(0, 1), late, [])[0]).toMatchObject({ status: "breach", reason: "receipt-after-movement" });
    const wrong = new Map([[PAID.transaction_id, { ...receipts.get(PAID.transaction_id)!, amount: "1" }]]);
    expect(chainFeed(moves.slice(0, 1), wrong, [])[0]).toMatchObject({ status: "breach", reason: "receipt-mismatch" });
  });
  it("a receipt in the window with no transfer shows as receipt written", () => {
    const orphan = parseReceipts([{ ...RECEIPT_MSG, consensus_timestamp: "1793940000.000000000", message: b64({ v: 1, type: "receipt", txId: "0.0.11333495-1793939999-1", token: TOKEN, to: "0.0.11333490", amount: "5", kind: "transfer" }) }], TOKEN);
    const rows = chainFeed(moves, orphan, []);
    expect(rows[0]).toMatchObject({ key: "receipt:0.0.11333495-1793939999-1", status: "pending", to: "0.0.11333490" });
  });
});

describe("genuine incident + replay", () => {
  const msg = (i: Incident, ts: string) => ({ message: b64(i), consensus_timestamp: ts });
  const o = { treasury: TREASURY, payees: ["0.0.11333490", "0.0.11333492"], decimals: 6 };
  it("skips false alarms on payees and failed runs", () => {
    const falseAlarm: Incident = { ...INCIDENT, incidentId: "fa", breaches: [{ ...INCIDENT.breaches[0], to: "0.0.11333490" }] };
    const failed: Incident = { ...INCIDENT, incidentId: "f", actions: [INCIDENT.actions[0], { ...INCIDENT.actions[1], ok: false }] };
    expect(pickGenuineIncident([msg(falseAlarm, "3.0"), msg(failed, "2.0"), msg(INCIDENT, "1.0")], o)?.incident.incidentId).toBe(INCIDENT.incidentId);
    expect(pickGenuineIncident([msg(falseAlarm, "3.0")], o)).toBeNull();
  });
  it("stopwatch replays the recorded step times", () => {
    const start = 1_000_000;
    expect(replayEndMs(INCIDENT)).toBe(8309);
    let s = replayContain(INCIDENT, start, 1000);
    expect(s).toMatchObject({ phase: "running", source: "replay", steps: [] });
    expect(s.detectedMs).toBeUndefined();
    expect(elapsedMs(s, start + 1000)).toBe(1000);
    s = replayContain(INCIDENT, start, 4193);
    expect(s.detectedMs).toBe(4193);
    expect(s.steps).toHaveLength(0);
    s = replayContain(INCIDENT, start, 7000);
    expect(s.steps.map((a) => a.step)).toEqual(["freezeAccount"]);
    s = replayContain(INCIDENT, start, 8309);
    expect(s).toMatchObject({ phase: "contained", source: "replay", containedMs: 8309 });
    expect(elapsedMs(s, start + 99_999)).toBe(8309);
  });
  it("pipeline goes red, captions say Replay, then settles at the recorded time", () => {
    const label = (step: string) => step;
    const p0 = replayPipeline(INCIDENT, 0, 100, label);
    expect(p0.nodes.contain.tone).toBe("breach");
    expect(p0.caption).toMatch(/^Replay · tokens left/);
    expect(replayPipeline(INCIDENT, 0, 5000, label).caption).toBe("Replay · watcher saw the move with no receipt at 4.19 s");
    expect(replayPipeline(INCIDENT, 0, 7000, label).caption).toBe("Replay · freezeAccount at 6.44 s");
    const done = replayPipeline(INCIDENT, 0, Number.POSITIVE_INFINITY, label);
    expect(done.nodes.contain.tone).toBe("settled");
    expect(done.caption).toBe("Replay · contained in 8.31 s, as recorded on chain");
  });
});
