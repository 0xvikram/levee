import { describe, expect, it } from "vitest";
import { buildKpis, dayStart, incidentStats, isContained, lagText, matchedToday, STATIC_KPIS } from "../kpis";
import type { FeedRow } from "../feed";
import { INCIDENT } from "./fixtures";

const b64 = (o: unknown) => btoa(JSON.stringify(o));
const PAYEES = ["0.0.11333490", "0.0.11333492"];
const NOW = new Date(2026, 10, 6, 15, 0, 0).getTime();
const sec = (ms: number) => `${Math.floor(ms / 1000)}.000000000`;

describe("incidentStats", () => {
  const falseAlarm = { ...INCIDENT, incidentId: "fa", breaches: [{ ...INCIDENT.breaches[0], to: PAYEES[0] }] };
  const failed = { ...INCIDENT, incidentId: "f", actions: [{ ...INCIDENT.actions[0], ok: false }] };
  const msgs = [
    { message: b64(failed), consensus_timestamp: sec(NOW - 60_000), sequence_number: 12 },
    { message: b64(falseAlarm), consensus_timestamp: sec(NOW - 120_000), sequence_number: 11 },
    { message: b64({ type: "heartbeat" }), consensus_timestamp: sec(NOW - 130_000), sequence_number: 10 },
    { message: b64({ ...INCIDENT, containedMs: 7530 }), consensus_timestamp: sec(NOW - 180_000), sequence_number: 9 },
    { message: b64(INCIDENT), consensus_timestamp: sec(dayStart(NOW) - 1000), sequence_number: 8 },
  ];
  it("counts today's incidents, total from the sequence number, and the newest contained one", () => {
    expect(incidentStats(msgs, { nowMs: NOW, payees: PAYEES })).toEqual({ total: 12, today: 3, lastContainedS: 7.53, lastAt: sec(NOW - 180_000) });
  });
  it("is null-safe on an empty topic", () => {
    expect(incidentStats([], { nowMs: NOW, payees: PAYEES })).toEqual({ total: null, today: 0, lastContainedS: null, lastAt: null });
  });
  it("a false alarm on a payee or a failed step is not a containment", () => {
    expect(isContained(INCIDENT, PAYEES)).toBe(true);
    expect(isContained({ ...INCIDENT, breaches: [{ ...INCIDENT.breaches[0], to: PAYEES[1] }] }, PAYEES)).toBe(false);
    expect(isContained({ ...INCIDENT, actions: [] }, PAYEES)).toBe(false);
  });
});

describe("matchedToday", () => {
  it("counts receipt-matched rows since local midnight", () => {
    const row = (status: FeedRow["status"], ms: number): FeedRow => ({ key: `${status}${ms}`, to: "x", amount: "1", kind: "transfer", status, consensusAt: sec(ms) });
    expect(matchedToday([row("receipt", NOW - 1000), row("receipt", dayStart(NOW) - 5000), row("breach", NOW - 100), row("pending", NOW)], NOW)).toBe(1);
  });
});

describe("buildKpis", () => {
  const base = { decimals: 6, symbol: "RUPC", treasury: "778974460000", supply: "971484808697", matched: 8, matchedNote: "watcher", incidents: { total: 9, today: 2, lastContainedS: 8.31, lastAt: null }, lagMs: 1600, chain: false };
  const by = (k: ReturnType<typeof buildKpis>) => Object.fromEntries(k.map((x) => [x.key, x]));
  it("formats live figures and keeps the static, sourced ones", () => {
    const k = by(buildKpis(base));
    expect(k.treasury.value).toBe("778,974.46");
    expect(k.supply.value).toBe("971,484.80");
    expect(k.matched.value).toBe("8");
    expect(k.false.value).toBe(String(STATIC_KPIS.falseAlarms));
    expect(k.today.value).toBe("2");
    expect(k.total.value).toBe("9");
    expect(k.last.value).toBe("8.31 s");
    expect(k.cost.value).toBe("~0.18 ℏ");
    expect(k.lag.value).toBe("1.6 s");
  });
  it("a containment that just finished on the page wins over the topic read", () => {
    expect(by(buildKpis({ ...base, liveSeconds: 6.02 })).last.value).toBe("6.02 s");
  });
  it("shows placeholders while loading and no lag on the hosted site", () => {
    const k = by(buildKpis({ ...base, treasury: null, supply: undefined, matched: null, incidents: null, chain: true }));
    expect(k.treasury.value).toBe("…");
    expect(k.supply.value).toBe("…");
    expect(k.matched.value).toBe("…");
    expect(k.today.value).toBe("…");
    expect(k.last.value).toBe("–");
    expect(k.lag.value).toBe("n/a");
  });
  it("lag turns to a warning past 15 s", () => {
    expect(lagText(null).value).toBe("–");
    expect(lagText(20_000)).toEqual({ value: "20.0 s", tone: "warn" });
  });
});
