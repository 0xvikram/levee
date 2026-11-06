import { describe, expect, it } from "vitest";
import { AXIS, INDUSTRY, MINT, TICKS, logPos } from "../numbers";

describe("comparison chart log scale", () => {
  it("maps the axis ends to 0 and 1 and clamps outside them", () => {
    expect(logPos(AXIS.min)).toBe(0);
    expect(logPos(AXIS.max)).toBe(1);
    expect(logPos(0.01)).toBe(0);
    expect(logPos(AXIS.max * 10)).toBe(1);
  });
  it("is strictly increasing", () => {
    const xs = [1, 2, 5, 7, 10, 60, 2_700, 11_340, 28_800, 345_600, 999_999];
    const ps = xs.map((x) => logPos(x));
    for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThan(ps[i - 1]);
  });
  it("is logarithmic: every factor of ten is the same distance", () => {
    const step = logPos(10) - logPos(1);
    expect(step).toBeCloseTo(1 / 6, 10);
    expect(logPos(1_000) - logPos(100)).toBeCloseTo(step, 10);
    expect(logPos(70) - logPos(7)).toBeCloseTo(step, 10);
  });
  it("ticks ascend and sit inside the axis", () => {
    for (let i = 1; i < TICKS.length; i++) expect(TICKS[i].s).toBeGreaterThan(TICKS[i - 1].s);
    for (const t of TICKS) expect(logPos(t.s)).toBeGreaterThanOrEqual(0);
  });
});

describe("sourced figures", () => {
  it("every industry figure links its public source and fits on the axis", () => {
    for (const c of INDUSTRY) {
      expect(c.source).toMatch(/^https:\/\//);
      expect(c.seconds).toBeGreaterThan(AXIS.min);
      expect(c.seconds).toBeLessThan(AXIS.max);
    }
  });
  it("the mint figures are ordered and link real testnet transactions", () => {
    expect(MINT.detectedS).toBeLessThan(MINT.containedS);
    expect(MINT.mintTx).toMatch(/^0\.0\.\d+-\d+-\d+$/);
    expect(MINT.wipeTx).toMatch(/^0\.0\.\d+-\d+-\d+$/);
  });
});
