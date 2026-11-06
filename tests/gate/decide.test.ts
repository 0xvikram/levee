import { describe, expect, it } from "vitest";
import { buildReceipt, decide, gateEvent, parseRequest, rulesFromState, spentFromReceipts, SpendLedger, utcDay, type DecideInput } from "../../src/gate/decide.js";
import { validateReceipt } from "../../src/shared/hcs.js";
import type { Receipt, Rules } from "../../src/shared/types.js";

const rules: Rules = { token: "0.0.5001", treasury: "0.0.6000", capPerTransfer: 10_000n, capPerDay: 15_000n, knownDestinations: ["0.0.6001", "0.0.6002"] };
const NOW = 1762400100_000;
const base = (o: Partial<DecideInput> = {}): DecideInput => ({
  req: { machine: "payouts-1", to: "0.0.6001", amount: "500", kind: "transfer" },
  pass: { live: true },
  rules,
  spentToday: 0n,
  heartbeat: { consensusAt: "1762400070.000000000" },
  nowMs: NOW,
  ...o,
});

describe("decide", () => {
  it("approves the happy path", () => {
    expect(decide(base())).toEqual({ ok: true });
  });
  it("refuses without a live pass (and passes the checker's reason through)", () => {
    expect(decide(base({ pass: { live: false, reason: "pass expired 40 s ago" } }))).toEqual({ ok: false, reason: "no-pass", detail: "pass expired 40 s ago" });
    expect(decide(base({ pass: { live: false } }))).toMatchObject({ reason: "no-pass" });
  });
  it("refuses over the per-transfer cap", () => {
    expect(decide(base({ req: { ...base().req, amount: "10001" } }))).toMatchObject({ ok: false, reason: "over-transfer-cap" });
  });
  it("allows exactly the cap", () => {
    expect(decide(base({ req: { ...base().req, amount: "10000" } })).ok).toBe(true);
  });
  it("refuses over the daily cap given today's spend", () => {
    const d = decide(base({ spentToday: 14_600n }));
    expect(d).toMatchObject({ ok: false, reason: "over-daily-cap" });
    if (!d.ok) expect(d.detail).toContain("14600");
  });
  it("refuses an unknown destination for transfers", () => {
    expect(decide(base({ req: { ...base().req, to: "0.0.6666" } }))).toMatchObject({ ok: false, reason: "unknown-destination" });
  });
  it("mints may go to any destination but still respect caps", () => {
    expect(decide(base({ req: { machine: "m", to: "0.0.7777", amount: "500", kind: "mint" } })).ok).toBe(true);
    expect(decide(base({ req: { machine: "m", to: "0.0.7777", amount: "50000", kind: "mint" } }))).toMatchObject({ reason: "over-transfer-cap" });
  });
  it("refuses with no watcher heartbeat at all", () => {
    expect(decide(base({ heartbeat: null }))).toMatchObject({ ok: false, reason: "no-watcher" });
  });
  it("refuses with a stale heartbeat (> 120 s) and says how old", () => {
    const d = decide(base({ heartbeat: { consensusAt: "1762399979.000000000" } }));
    expect(d).toMatchObject({ ok: false, reason: "no-watcher" });
    if (!d.ok) expect(d.detail).toMatch(/no watcher, no signing.*121 s/);
  });
  it("accepts a heartbeat exactly 120 s old, honours a custom max age", () => {
    expect(decide(base({ heartbeat: { consensusAt: "1762399980.000000000" } })).ok).toBe(true);
    expect(decide(base({ heartbeat: { consensusAt: "1762400090.000000000" }, maxHeartbeatAgeMs: 5000 })).ok).toBe(false);
  });
  it("checks in order: pass, then rules, then watcher", () => {
    const all = base({ pass: { live: false }, req: { ...base().req, amount: "99999" }, heartbeat: null });
    expect(decide(all)).toMatchObject({ reason: "no-pass" });
    expect(decide({ ...all, pass: { live: true } })).toMatchObject({ reason: "over-transfer-cap" });
    expect(decide({ ...all, pass: { live: true }, req: base().req })).toMatchObject({ reason: "no-watcher" });
  });
});

describe("parseRequest", () => {
  const good = { machine: "payouts-1", to: "0.0.6001", amount: "500", kind: "transfer" };
  it("accepts a good request and defaults kind to transfer", () => {
    expect(parseRequest(good)).toEqual({ ok: true, value: good });
    expect(parseRequest({ ...good, kind: undefined })).toMatchObject({ ok: true, value: { kind: "transfer" } });
  });
  it("accepts a safe integer number amount and normalises leading zeros", () => {
    expect(parseRequest({ ...good, amount: 500 })).toMatchObject({ ok: true, value: { amount: "500" } });
    expect(parseRequest({ ...good, amount: "000500" })).toMatchObject({ ok: true, value: { amount: "500" } });
  });
  it.each([
    ["null body", null],
    ["array body", []],
    ["missing machine", { ...good, machine: undefined }],
    ["bad machine chars", { ...good, machine: "a b" }],
    ["long machine", { ...good, machine: "x".repeat(65) }],
    ["bad to", { ...good, to: "0x1234" }],
    ["negative amount", { ...good, amount: "-5" }],
    ["zero amount", { ...good, amount: "0" }],
    ["decimal amount", { ...good, amount: "1.5" }],
    ["float number amount", { ...good, amount: 1.5 }],
    ["int64 overflow", { ...good, amount: "9223372036854775808" }],
    ["bad kind", { ...good, kind: "burn" }],
  ])("rejects %s", (_n, body) => {
    expect(parseRequest(body)).toMatchObject({ ok: false, reason: "bad-request" });
  });
});

describe("spend tracking", () => {
  const r = (amount: string, consensusAt?: string): Receipt => ({
    v: 1, type: "receipt", txId: "0.0.6000-1-000000001", token: "0.0.5001", from: "0.0.6000", to: "0.0.6001", amount, kind: "transfer", machine: "m", approvedAt: "2026-11-06T00:00:00Z", consensusAt,
  });
  it("recomputes today's spend from receipts, ignoring other days and unread ones", () => {
    const today = utcDay(1762400100_000);
    expect(spentFromReceipts([r("100", "1762400000.0"), r("250", "1762400050.5"), r("999", "1762300000.0"), r("7")], today)).toBe(350n);
  });
  it("SpendLedger adds per day", () => {
    const l = new SpendLedger();
    l.add("2026-11-06", 5n);
    l.add("2026-11-06", 7n);
    l.set("2026-11-07", 1n);
    expect(l.get("2026-11-06")).toBe(12n);
    expect(l.get("2026-11-07")).toBe(1n);
    expect(l.get("2026-11-08")).toBe(0n);
  });
});

describe("receipt + events", () => {
  const req = { machine: "payouts-1", to: "0.0.6001", amount: "500", kind: "transfer" as const };
  it("buildReceipt makes a valid Receipt with the normalised tx id", () => {
    const rc = buildReceipt(req, { txId: "0.0.6000-1762400095-000000042", token: "0.0.5001", treasury: "0.0.6000", nowMs: NOW });
    expect(validateReceipt(rc)).toEqual({ ok: true, value: rc });
    expect(rc.consensusAt).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(rc))).toBeLessThan(1024);
  });
  it("gateEvent carries the refusal reason or the tx id", () => {
    expect(gateEvent(req, { ok: false, reason: "no-pass", detail: "x" }, NOW)).toMatchObject({ ok: false, reason: "no-pass", detail: "x", at: new Date(NOW).toISOString() });
    const ok = gateEvent(req, { ok: true }, NOW, { txId: "t" });
    expect(ok).toMatchObject({ ok: true, txId: "t" });
    expect(ok).not.toHaveProperty("reason");
  });
  it("rulesFromState uses the payees as known destinations", () => {
    const r = rulesFromState({ token: { tokenId: "0.0.5001" }, treasury: { id: "0.0.6000" }, payees: [{ id: "0.0.6001" }, { id: "0.0.6002" }] }, { capPerTransfer: 1n, capPerDay: 2n });
    expect(r).toEqual({ token: "0.0.5001", treasury: "0.0.6000", capPerTransfer: 1n, capPerDay: 2n, knownDestinations: ["0.0.6001", "0.0.6002"] });
  });
});
