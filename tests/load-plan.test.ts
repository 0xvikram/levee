import { describe, it, expect } from "vitest";
import { dailyCapNeeded, planLoad, totalOf } from "../scripts/demo/load-plan.js";

describe("normal-load plan", () => {
  const base = { n: 300, payees: ["0.0.1", "0.0.2"], decimals: 6, capPerTransfer: 10_000n };
  it("stays inside the per-transfer cap and the configured range, uses every payee", () => {
    const p = planLoad(base);
    expect(p).toHaveLength(300);
    for (const x of p) {
      expect(x.amount).toBeGreaterThanOrEqual(10_000_000n);
      expect(x.amount).toBeLessThanOrEqual(900_000_000n);
    }
    expect(new Set(p.map((x) => x.to))).toEqual(new Set(["0.0.1", "0.0.2"]));
    expect(new Set(p.map((x) => x.amount)).size).toBeGreaterThan(290);
  });
  it("is deterministic per seed and clamps to a small cap", () => {
    expect(planLoad({ ...base, seed: 7 })).toEqual(planLoad({ ...base, seed: 7 }));
    expect(planLoad({ ...base, seed: 7 })).not.toEqual(planLoad({ ...base, seed: 8 }));
    expect(planLoad({ ...base, capPerTransfer: 50n }).every((x) => x.amount <= 50_000_000n)).toBe(true);
  });
  it("computes the daily cap the run needs (whole tokens, rounded up)", () => {
    const p = [{ i: 0, to: "a", amount: 1_500_000n }, { i: 1, to: "b", amount: 1n }];
    expect(totalOf(p)).toBe(1_500_001n);
    expect(dailyCapNeeded(p, 500_000_000n, 6)).toBe(502n);
  });
});
