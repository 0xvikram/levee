import { describe, expect, it } from "vitest";
import { feedReducer, initialFeed, isLiveBreach, type FeedState } from "../feed";
import { BREACH, INCIDENT, MATCHED } from "./fixtures";

const run = (...actions: Parameters<typeof feedReducer>[1][]): FeedState => actions.reduce(feedReducer, initialFeed);

describe("feedReducer", () => {
  it("shows a matched movement as receipt ✓", () => {
    const s = run({ type: "matched", movement: MATCHED });
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ txId: MATCHED.txId, status: "receipt", to: "0.0.11333490" });
  });

  it("upgrades a gate 'receipt written' row when the watcher matches it, and never downgrades", () => {
    const decision = { at: "2026-11-06T03:00:00.000Z", machine: "laptop-1", to: MATCHED.to, amount: MATCHED.amount, kind: "transfer" as const, ok: true, txId: MATCHED.txId };
    const s = run({ type: "decision", decision }, { type: "matched", movement: MATCHED }, { type: "decision", decision });
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].status).toBe("receipt");
    expect(s.rows[0].machine).toBe("laptop-1");
  });

  it("adds refused gate requests as their own rows", () => {
    const s = run({ type: "decision", decision: { at: "2026-11-06T03:00:00.000Z", machine: "laptop-2", to: "0.0.1", amount: "1", kind: "transfer", ok: false, reason: "no-pass" } });
    expect(s.rows[0]).toMatchObject({ status: "refused", reason: "no-pass" });
  });

  it("a breach is live (red) until its incident is contained", () => {
    const live = run({ type: "breach", breach: BREACH });
    expect(isLiveBreach(live.rows[0])).toBe(true);
    const done = feedReducer(live, { type: "incident", incident: INCIDENT });
    expect(done.rows[0].contained).toBe(true);
    expect(isLiveBreach(done.rows[0])).toBe(false);
  });

  it("historic breaches from priming are never live", () => {
    const s = run({ type: "breach", breach: { ...BREACH, historic: true } });
    expect(isLiveBreach(s.rows[0])).toBe(false);
  });

  it("is idempotent across SSE replay + snapshot, newest first", () => {
    const snapshot = { healthy: true, lagMs: 1000, matched: 1, receipts: 1, breaches: [BREACH], incidents: [INCIDENT] };
    const s = run(
      { type: "matched", movement: MATCHED },
      { type: "breach", breach: BREACH },
      { type: "incident", incident: INCIDENT },
      { type: "snapshot", snapshot },
      { type: "breach", breach: BREACH },
      { type: "matched", movement: MATCHED },
    );
    expect(s.rows.map((r) => r.txId)).toEqual([BREACH.txId, MATCHED.txId]);
    expect(s.rows[0].contained).toBe(true);
  });
});
