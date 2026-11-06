import { describe, expect, it } from "vitest";
import { compactIncident, parseHeartbeat, parseIncident, parseReceipt, receiptFromMessage, validateReceipt, type IncidentOut } from "../../src/shared/hcs.js";

const good = {
  v: 1, type: "receipt", txId: "0.0.6000-1762400095-000000042", token: "0.0.5001", from: "0.0.6000", to: "0.0.6001",
  amount: "500", kind: "transfer", machine: "payouts-1", approvedAt: "2026-11-06T10:00:00.000Z",
};

describe("receipt validation", () => {
  it("accepts a good receipt and drops unknown fields", () => {
    const p = parseReceipt(JSON.stringify({ ...good, extra: "x" }));
    expect(p).toEqual({ ok: true, value: good });
  });
  it.each([
    ["v", 2], ["type", "incident"], ["txId", "0.0.6000@1762400095.000000042"], ["txId", "0.0.6000-1762400095-42"],
    ["token", "abc"], ["from", 6000], ["to", ""], ["amount", 500], ["amount", "0"], ["amount", "-1"], ["amount", "1e3"],
    ["amount", "9223372036854775808"], ["kind", "burn"], ["machine", ""], ["machine", "x".repeat(65)], ["approvedAt", "yesterday"],
    ["consensusAt", "soon"],
  ])("rejects bad %s = %j", (k, v) => {
    expect(validateReceipt({ ...good, [k]: v }).ok).toBe(false);
  });
  it("keeps a schedule id (scheduled transfers) and rejects a bad one", () => {
    expect(parseReceipt(JSON.stringify({ ...good, scheduleId: "0.0.8888" }))).toEqual({ ok: true, value: { ...good, scheduleId: "0.0.8888" } });
    expect(validateReceipt({ ...good, scheduleId: "8888" }).ok).toBe(false);
  });
  it("rejects non-JSON and non-objects", () => {
    expect(parseReceipt("{")).toEqual({ ok: false, error: "not JSON" });
    expect(parseReceipt("[1]").ok).toBe(false);
    expect(parseReceipt("null").ok).toBe(false);
  });
  it("takes consensusAt from the Mirror, never from the payload (no self-backdating)", () => {
    const m = { consensusAt: "1762400100.000000001", sequence: 3, payer: "0.0.7000", text: JSON.stringify({ ...good, consensusAt: "1.000000000" }) };
    const p = receiptFromMessage(m);
    expect(p.ok && p.value.consensusAt).toBe("1762400100.000000001");
  });
});

describe("incident + heartbeat parsing", () => {
  const inc: IncidentOut = {
    v: 1, type: "incident", incidentId: "0x" + "ab".repeat(32), token: "0.0.5001",
    breaches: [{ txId: "0.0.6000-1-000000001", to: "0.0.6666", amount: "9", reason: "no-receipt" }],
    actions: [{ step: "freezeAccount", account: "0.0.6000", txId: "0.0.7-1-000000000", ok: true, atMs: 1500 }],
    detectedMs: 900, containedMs: 1500,
  };
  it("round-trips a valid incident", () => {
    expect(parseIncident(JSON.stringify(inc))).toEqual({ ok: true, value: inc });
  });
  it("rejects a malformed incident", () => {
    expect(parseIncident(JSON.stringify({ ...inc, incidentId: "abc" })).ok).toBe(false);
    expect(parseIncident(JSON.stringify({ ...inc, actions: [{ step: "x" }] })).ok).toBe(false);
    expect(parseIncident(JSON.stringify({ ...inc, breaches: "none" })).ok).toBe(false);
    expect(parseIncident(JSON.stringify({ ...inc, detectedMs: "1" })).ok).toBe(false);
    expect(parseIncident("nope").ok).toBe(false);
  });
  it("compacts a large incident under the HCS 1 KB limit and keeps it valid", () => {
    const big: IncidentOut = {
      ...inc,
      breaches: Array.from({ length: 20 }, (_, i) => ({ ...inc.breaches[0], txId: `0.0.6000-${i}-000000001` })),
      actions: Array.from({ length: 20 }, (_, i) => ({ ...inc.actions[0], account: `0.0.${7000 + i}` })),
    };
    const c = compactIncident(big);
    expect(Buffer.byteLength(JSON.stringify(c))).toBeLessThanOrEqual(1000);
    expect(c.breaches.length).toBeGreaterThan(0);
    expect(parseIncident(JSON.stringify(c)).ok).toBe(true);
    expect(compactIncident(inc)).toEqual(inc);
  });
  it("parses only watcher heartbeats", () => {
    expect(parseHeartbeat(JSON.stringify({ v: 1, type: "heartbeat", who: "watcher", at: "x", matched: 0, incidents: 0, lagMs: 1 })).ok).toBe(true);
    expect(parseHeartbeat(JSON.stringify({ v: 1, type: "heartbeat", who: "agent" })).ok).toBe(false);
    expect(parseHeartbeat("{").ok).toBe(false);
  });
});
