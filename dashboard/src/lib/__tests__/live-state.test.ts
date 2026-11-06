import { describe, expect, it } from "vitest";
import { breachModeReducer, calm, HOLD_MS } from "../breach";
import { deploy, eventsUrl, payeeName } from "../config";
import { initialPoll, nextPoll, serviceStatus } from "../health";
import { FRESH_MS, initialPipeline, NODES, pipelineReducer, SETTLE_MS, type PipelineState } from "../pipeline";
import { ring } from "../ring";
import { containReducer, initialContain } from "../stopwatch";
import { BREACH, INCIDENT } from "./fixtures";

const tones = (s: PipelineState) => Object.fromEntries(Object.entries(s.nodes).map(([k, v]) => [k, v.tone]));

describe("pipelineReducer", () => {
  const now = 1_000_000;
  it("has four nodes: Request → Receipt → Transfer → Check", () => {
    expect(NODES).toEqual(["request", "receipt", "transfer", "check"]);
    expect(initialPipeline.links).toHaveLength(3);
  });
  it("approved lights request → transfer, matched carries on to check ✓", () => {
    let s = pipelineReducer(initialPipeline, { type: "approved", eventMs: now, now });
    expect(tones(s)).toEqual({ request: "ok", receipt: "ok", transfer: "ok", check: "idle" });
    expect(s.links.map((l) => l.tone)).toEqual(["ok", "ok", "idle"]);
    s = pipelineReducer(s, { type: "matched", eventMs: now + 3000, now: now + 3000 });
    expect(s.nodes.check.tone).toBe("ok");
    expect(s.links[2].tone).toBe("ok");
    expect(s.caption).toMatch(/matched its receipt/);
  });
  it("a refusal stops at request/receipt in neutral amber, never red", () => {
    const s = pipelineReducer(initialPipeline, { type: "refused", reason: "payee not on the list", eventMs: now, now });
    expect(tones(s)).toEqual({ request: "refused", receipt: "refused", transfer: "idle", check: "idle" });
    expect(s.links.map((l) => l.tone)).toEqual(["refused", "idle", "idle"]);
    expect(s.caption).toMatch(/payee not on the list/);
    expect(JSON.stringify(s)).not.toContain("breach");
  });
  it("breach goes red on transfer → check, then settles to olive when contained", () => {
    let s = pipelineReducer(initialPipeline, { type: "breach", eventMs: now, now });
    expect(tones(s)).toEqual({ request: "idle", receipt: "idle", transfer: "breach", check: "breach" });
    expect(s.links.map((l) => l.tone)).toEqual(["idle", "idle", "breach"]);
    // normal traffic and ticks do not hide a live breach
    s = pipelineReducer(s, { type: "approved", eventMs: now + 1, now: now + 1 });
    s = pipelineReducer(s, { type: "refused", reason: "x", eventMs: now + 1, now: now + 1 });
    s = pipelineReducer(s, { type: "tick", now: now + SETTLE_MS * 5 });
    expect(s.nodes.check.tone).toBe("breach");
    s = pipelineReducer(s, { type: "contained", seconds: 8.309, now: now + 9000 });
    expect(tones(s)).toMatchObject({ transfer: "settled", check: "settled" });
    expect(s.links.every((l) => l.tone !== "breach")).toBe(true);
    expect(s.caption).toBe("Contained in 8.31 s");
    s = pipelineReducer(s, { type: "tick", now: now + 9000 + SETTLE_MS + 1 });
    expect(s).toEqual({ ...initialPipeline, seq: s.seq });
  });
  it("replayed history and historic breaches never light the row", () => {
    expect(pipelineReducer(initialPipeline, { type: "approved", eventMs: now - FRESH_MS - 1, now })).toBe(initialPipeline);
    expect(pipelineReducer(initialPipeline, { type: "breach", eventMs: now, now, historic: true })).toBe(initialPipeline);
    expect(pipelineReducer(initialPipeline, { type: "contained", seconds: 1, now })).toBe(initialPipeline);
  });
  it("each event restarts the connector pulse with a new key", () => {
    const a = pipelineReducer(initialPipeline, { type: "approved", eventMs: now, now });
    const b = pipelineReducer(a, { type: "approved", eventMs: now + 1, now: now + 1 });
    expect(b.links[0].key).not.toBe(a.links[0].key);
  });
});

describe("breachModeReducer", () => {
  it("live → contained banner → calm after the hold", () => {
    const running = containReducer(initialContain, { type: "breach", breach: BREACH });
    let m = breachModeReducer(calm, { type: "update", contain: running, now: 10 });
    expect(m).toEqual({ kind: "live", since: 10 });
    expect(breachModeReducer(m, { type: "update", contain: running, now: 20 })).toBe(m);
    const done = containReducer(running, { type: "incident", incident: INCIDENT });
    m = breachModeReducer(m, { type: "update", contain: done, now: 9000 });
    expect(m).toEqual({ kind: "contained", since: 9000, seconds: 8.309 });
    expect(breachModeReducer(m, { type: "tick", now: 9000 + HOLD_MS - 1 })).toBe(m);
    expect(breachModeReducer(m, { type: "tick", now: 9000 + HOLD_MS + 1 })).toEqual(calm);
  });
  it("an incident replayed from history never raises the banner", () => {
    const hist = containReducer(initialContain, { type: "hcs-incident", incident: INCIDENT });
    expect(breachModeReducer(calm, { type: "update", contain: hist, now: 1 })).toEqual(calm);
  });
});

describe("ring", () => {
  it("maps time left to stroke offset", () => {
    const full = ring(180_000, 180_000, 20);
    expect(full.circumference).toBeCloseTo(2 * Math.PI * 20);
    expect(full.offset).toBeCloseTo(0);
    expect(ring(90_000, 180_000, 20).offset).toBeCloseTo(Math.PI * 20);
    expect(ring(0, 180_000, 20).offset).toBeCloseTo(full.circumference);
  });
  it("clamps bad input", () => {
    expect(ring(-5, 180_000, 10).frac).toBe(0);
    expect(ring(999_999, 180_000, 10).frac).toBe(1);
    expect(ring(NaN, 180_000, 10).frac).toBe(0);
    expect(ring(10, 0, 10).frac).toBe(0);
  });
});

describe("service health", () => {
  it("one slow miss does not flip an up service to off; two do", () => {
    let p = nextPoll(initialPoll, { kind: "answer", status: 200, data: { ok: true } }, 1);
    expect(serviceStatus(p)).toBe("up");
    p = nextPoll(p, { kind: "miss" }, 2);
    expect(serviceStatus(p)).toBe("up");
    p = nextPoll(p, { kind: "miss" }, 3);
    expect(serviceStatus(p)).toBe("off");
  });
  it("an open SSE stream counts as up; a 503 JSON answer is degraded, not off", () => {
    const missed = nextPoll(nextPoll(initialPoll, { kind: "miss" }, 1), { kind: "miss" }, 2);
    expect(serviceStatus(missed, "open")).toBe("up");
    expect(serviceStatus(missed, "connecting")).toBe("off");
    expect(serviceStatus(nextPoll(initialPoll, { kind: "answer", status: 503, data: { ok: false } }, 1))).toBe("degraded");
    expect(serviceStatus(initialPoll)).toBe("checking");
  });
  it("SSE goes straight to the service port on local dev, and is never opened on the public site", () => {
    expect(eventsUrl("watcher", { hostname: "localhost", port: "5173", protocol: "http:" })).toBe("http://localhost:8711/events");
    expect(eventsUrl("gate", { hostname: "127.0.0.1", port: "4173", protocol: "http:" })).toBe("http://127.0.0.1:8710/events");
    // public site: no stream at all (there is no /api/* there; an EventSource would 404 in a loop)
    expect(eventsUrl("checker", { hostname: "levee.example", port: "", protocol: "https:" })).toBe("");
  });
});

describe("payeeName", () => {
  it("names the demo payees for display only", () => {
    expect(payeeName(deploy.payees[0])).toBe("Asha");
    expect(payeeName(deploy.payees[1])).toBe("Ravi");
    expect(payeeName(deploy.attacker)).toBeNull();
    expect(payeeName(undefined)).toBeNull();
  });
});
