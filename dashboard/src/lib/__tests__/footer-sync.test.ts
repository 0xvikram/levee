import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BREACH_MAX_MS,
  CAP_NARROW,
  CAP_WIDE,
  CONTAINED_HOLD_MS,
  MAX_POLL_BURST,
  MoodClock,
  addFly,
  ambientFor,
  capFor,
  diffReceiptSeqs,
  ensureAmbient,
  makeAmbient,
  makePayment,
  moodReducer,
  spawnsFor,
  stepFlies,
  idleMood,
  type Fly,
} from "../footer-sync";

const NOW = 1_793_935_200_000;
const consensus = (ms: number) => `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1e6).padStart(9, "0")}`;
const seeded = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

describe("spawn per matched event", () => {
  it("one firefly per fresh matched payment", () => {
    expect(spawnsFor("matched", { txId: "a", consensusAt: consensus(NOW - 2_000) }, NOW)).toBe(1);
  });
  it("replayed matched events older than 60 s are ignored", () => {
    expect(spawnsFor("matched", { txId: "a", consensusAt: consensus(NOW - 61_000) }, NOW)).toBe(0);
    expect(spawnsFor("matched", { txId: "a", consensusAt: consensus(NOW - 59_000) }, NOW)).toBe(1);
  });
  it("other events and malformed frames spawn nothing", () => {
    expect(spawnsFor("breach", { consensusAt: consensus(NOW) }, NOW)).toBe(0);
    expect(spawnsFor("matched", null, NOW)).toBe(0);
    expect(spawnsFor("matched", { consensusAt: 5 }, NOW)).toBe(0);
  });
});

describe("mood state machine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("breach -> red -> contained -> olive -> back to idle after the hold", () => {
    const seen: string[] = [];
    const c = new MoodClock((m) => seen.push(m.kind));
    c.handle("breach", { txId: "x", reason: "no-receipt", consensusAt: consensus(Date.now() - 3_000) });
    expect(c.mood.kind).toBe("breach");
    vi.advanceTimersByTime(5_000);
    c.handle("incident", { incidentId: "i1", actions: [] });
    expect(c.mood.kind).toBe("contained");
    vi.advanceTimersByTime(CONTAINED_HOLD_MS - 1);
    expect(c.mood.kind).toBe("contained");
    vi.advanceTimersByTime(1);
    expect(c.mood.kind).toBe("idle");
    expect(seen).toEqual(["breach", "contained", "idle"]);
    c.dispose();
  });

  it("replayed or historic breaches never turn the swarm red", () => {
    const c = new MoodClock();
    c.handle("breach", { consensusAt: consensus(Date.now() - 61_000) });
    expect(c.mood.kind).toBe("idle");
    c.handle("breach", { consensusAt: consensus(Date.now()), historic: true });
    expect(c.mood.kind).toBe("idle");
  });

  it("an incident with no live breach (replay) does not go olive", () => {
    const c = new MoodClock();
    c.handle("incident", { incidentId: "old" });
    expect(c.mood.kind).toBe("idle");
  });

  it("a breach that is never contained stops glowing after BREACH_MAX_MS", () => {
    const c = new MoodClock();
    c.handle("breach", { consensusAt: consensus(Date.now()) });
    vi.advanceTimersByTime(BREACH_MAX_MS);
    expect(c.mood.kind).toBe("idle");
  });

  it("reducer is pure", () => {
    const m = moodReducer(idleMood, { type: "breach", eventMs: NOW, now: NOW });
    expect(m).toEqual({ kind: "breach", since: NOW });
    expect(moodReducer(m, { type: "tick", now: NOW + 1000 })).toBe(m);
  });
});

describe("receipts sequence diffing", () => {
  it("first load seeds the cursor without a burst", () => {
    expect(diffReceiptSeqs(null, [41, 40, 39])).toEqual({ last: 41, emit: 0 });
  });
  it("emits one per new sequence number", () => {
    expect(diffReceiptSeqs(41, [43, 42, 41, 40])).toEqual({ last: 43, emit: 2 });
    expect(diffReceiptSeqs(43, [43, 42])).toEqual({ last: 43, emit: 0 });
  });
  it("caps a long gap at MAX_POLL_BURST", () => {
    expect(diffReceiptSeqs(10, [20, 19, 18, 17, 16, 15, 14, 13, 12, 11])).toEqual({ last: 20, emit: MAX_POLL_BURST });
  });
  it("empty or junk pages keep the cursor", () => {
    expect(diffReceiptSeqs(5, [])).toEqual({ last: 5, emit: 0 });
    expect(diffReceiptSeqs(null, [NaN])).toEqual({ last: null, emit: 0 });
  });
});

describe("swarm cap", () => {
  it("caps at 60 wide and 30 narrow", () => {
    expect(capFor(1280)).toBe(CAP_WIDE);
    expect(capFor(390)).toBe(CAP_NARROW);
    expect(CAP_WIDE).toBe(60);
    expect(CAP_NARROW).toBe(30);
  });

  it("never exceeds the cap and drops the oldest payment firefly first, keeping ambient ones", () => {
    const rnd = seeded(7);
    let flies: Fly[] = ensureAmbient([], ambientFor(390), rnd);
    expect(flies).toHaveLength(5);
    for (let i = 0; i < 100; i++) flies = addFly(flies, { ...makePayment(rnd), age: i }, CAP_NARROW);
    expect(flies).toHaveLength(CAP_NARROW);
    expect(flies.filter((f) => f.ambient)).toHaveLength(5);
    const ages = flies.filter((f) => !f.ambient).map((f) => f.age);
    expect(Math.min(...ages)).toBe(100 - (CAP_NARROW - 5));
  });

  it("ambient drift: 5-8 always present, payment flies leave off the top", () => {
    const rnd = seeded(3);
    expect(ambientFor(1280)).toBe(8);
    let flies: Fly[] = [makeAmbient(rnd), { ...makePayment(rnd), y: -0.04, vy: -0.1 }];
    for (let i = 0; i < 10; i++) flies = stepFlies(flies, 0.1, rnd);
    expect(flies).toHaveLength(1);
    expect(flies[0].ambient).toBe(true);
  });
});
