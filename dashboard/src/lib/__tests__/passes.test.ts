import { describe, expect, it } from "vitest";
import { passesReducer, passLeftMs } from "../passes";

describe("passesReducer", () => {
  it("renews on a healthy heartbeat and expires on time", () => {
    const now = Date.parse("2026-11-06T03:00:00Z");
    let s = passesReducer({}, { type: "snapshot", passes: [{ machine: "laptop-1", live: false, kind: "offline", expiresAt: null, reason: "pass expired" }] });
    s = passesReducer(s, { type: "event", event: { type: "heartbeat", at: now, data: { machine: "laptop-1", ok: true, expiresAtMs: now + 180_000 } } });
    expect(s["laptop-1"].live).toBe(true);
    expect(passLeftMs(s["laptop-1"], now + 60_000)).toBe(120_000);
    expect(passLeftMs(s["laptop-1"], now + 181_000)).toBe(0);
  });
  it("denies at once on a failing check", () => {
    const s = passesReducer({}, { type: "event", event: { type: "heartbeat", at: 0, data: { machine: "m", ok: false, failing: ["disk-encryption"] } } });
    expect(s.m).toMatchObject({ live: false, kind: "unhealthy", reason: "check failed: disk-encryption" });
  });
});
