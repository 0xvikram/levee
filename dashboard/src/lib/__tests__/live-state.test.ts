import { describe, expect, it } from "vitest";
import { breachModeReducer, calm, HOLD_MS } from "../breach";
import { eventsUrl } from "../config";
import { initialPoll, nextPoll, serviceStatus } from "../health";
import { FRESH_MS, initialPipeline, pipelineReducer, SETTLE_MS, type PipelineState } from "../pipeline";
import { ring } from "../ring";
import { containReducer, initialContain } from "../stopwatch";
import { BREACH, INCIDENT } from "./fixtures";

const tones = (s: PipelineState) => Object.fromEntries(Object.entries(s.nodes).map(([k, v]) => [k, v.tone]));

describe("pipelineReducer", () => {
  const now = 1_000_000;
  it("approved lights machine → transfer, matched carries on to the watcher", () => {
    let s = pipelineReducer(initialPipeline, { type: "approved", eventMs: now, now });
    expect(tones(s)).toMatchObject({ machine: "ok", gate: "ok", receipt: "ok", transfer: "ok", watcher: "idle", contain: "idle" });
    expect(s.links.map((l) => l.tone)).toEqual(["ok", "ok", "ok", "idle", "idle"]);
    s = pipelineReducer(s, { type: "matched", eventMs: now + 3000, now: now + 3000 });
    expect(s.nodes.watcher.tone).toBe("ok");
    expect(s.links[3].tone).toBe("ok");
  });
  it("a refusal stops at the gate in neutral, never red", () => {
    const s = pipelineReducer(initialPipeline, { type: "refused", reason: "no live machine pass", eventMs: now, now });
    expect(tones(s)).toMatchObject({ machine: "ok", gate: "refused", receipt: "idle", transfer: "idle" });
    expect(s.caption).toMatch(/no live machine pass/);
    expect(JSON.stringify(s)).not.toContain("breach");
  });
  it("breach goes red on transfer → contain, then settles to olive when contained", () => {
    let s = pipelineReducer(initialPipeline, { type: "breach", eventMs: now, now });
    expect(tones(s)).toMatchObject({ transfer: "breach", watcher: "breach", contain: "breach", gate: "idle", receipt: "idle" });
    // normal traffic and ticks do not hide a live breach
    s = pipelineReducer(s, { type: "approved", eventMs: now + 1, now: now + 1 });
    s = pipelineReducer(s, { type: "tick", now: now + SETTLE_MS * 5 });
    expect(s.nodes.contain.tone).toBe("breach");
    s = pipelineReducer(s, { type: "contained", seconds: 8.309, now: now + 9000 });
    expect(tones(s)).toMatchObject({ transfer: "settled", watcher: "settled", contain: "settled" });
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
  it("SSE goes straight to the service port on local dev, through the proxy elsewhere", () => {
    expect(eventsUrl("watcher", { hostname: "localhost", port: "5173", protocol: "http:" })).toBe("http://localhost:8711/events");
    expect(eventsUrl("gate", { hostname: "127.0.0.1", port: "4173", protocol: "http:" })).toBe("http://127.0.0.1:8710/events");
    expect(eventsUrl("checker", { hostname: "levee.example", port: "", protocol: "https:" })).toBe("/api/checker/events");
  });
});
