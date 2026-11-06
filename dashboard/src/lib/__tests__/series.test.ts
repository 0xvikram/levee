import { describe, expect, it } from "vitest";
import { accountDeltas, domain, pushPoint, scale, seedBackward, toPath, visibleEvents, type Pt } from "../series";

describe("pushPoint (ring buffer)", () => {
  it("appends in order and drops points older than the window", () => {
    let b: Pt[] = [];
    for (let t = 0; t <= 10_000; t += 1000) b = pushPoint(b, { t, v: t }, { windowMs: 5000, cap: 100 });
    expect(b.map((p) => p.t)).toEqual([5000, 6000, 7000, 8000, 9000, 10000]);
  });
  it("caps the length, keeping the newest", () => {
    let b: Pt[] = [];
    for (let t = 0; t < 10; t++) b = pushPoint(b, { t, v: 1 }, { windowMs: 1e9, cap: 3 });
    expect(b.map((p) => p.t)).toEqual([7, 8, 9]);
  });
  it("replaces a point at the same time and sorts a late one in", () => {
    let b = pushPoint([], { t: 10, v: 1 });
    b = pushPoint(b, { t: 10, v: 2 });
    b = pushPoint(b, { t: 5, v: 3 });
    expect(b).toEqual([{ t: 5, v: 3 }, { t: 10, v: 2 }]);
  });
});

describe("domain and scale", () => {
  it("ignores gaps and pads the range", () => {
    expect(domain([{ t: 0, v: 100 }, { t: 1, v: null }, { t: 2, v: 200 }], 0.1)).toEqual([90, 210]);
  });
  it("gives a flat line a visible band", () => {
    const [lo, hi] = domain([{ t: 0, v: 1_000_000 }, { t: 1, v: 1_000_000 }], 0)!;
    expect(hi - lo).toBeCloseTo(2000);
    expect((lo + hi) / 2).toBe(1_000_000);
  });
  it("returns null without values", () => {
    expect(domain([{ t: 0, v: null }])).toBeNull();
  });
  it("maps time left to right and value bottom to top", () => {
    const s = scale({ t0: 0, t1: 100, lo: 0, hi: 10, width: 200, height: 50 });
    expect(s.x(50)).toBe(100);
    expect(s.y(10)).toBe(0);
    expect(s.y(0)).toBe(50);
  });
});

describe("toPath", () => {
  const s = scale({ t0: 0, t1: 10, lo: 0, hi: 10, width: 10, height: 10 });
  it("draws steps and breaks the line at a gap", () => {
    const d = toPath([{ t: 0, v: 0 }, { t: 2, v: 5 }, { t: 3, v: null }, { t: 5, v: 10 }, { t: 6, v: 10 }], s);
    expect(d).toBe("M0 10H2V5M5 0H6V0");
  });
  it("draws a tick for a lone point", () => {
    expect(toPath([{ t: 5, v: 5 }], s)).toBe("M3 5H7");
  });
});

describe("seed from Mirror history", () => {
  const txs = [
    { consensus_timestamp: "100.500000000", result: "SUCCESS", token_transfers: [{ token_id: "T", account: "A", amount: -5_000_000 }, { token_id: "T", account: "B", amount: 5_000_000 }] },
    { consensus_timestamp: "90.000000000", result: "SUCCESS", token_transfers: [{ token_id: "T", account: "A", amount: 2_000_000 }] },
    { consensus_timestamp: "95.000000000", result: "INVALID_SIGNATURE", token_transfers: [{ token_id: "T", account: "A", amount: -9_000_000 }] },
    { consensus_timestamp: "80.000000000", result: "SUCCESS", token_transfers: [{ token_id: "X", account: "A", amount: -1 }] },
  ];
  it("sums the account's net change per successful record, newest first", () => {
    expect(accountDeltas(txs, { token: "T", account: "A", decimals: 6 })).toEqual([
      { t: 100_500, d: -5 },
      { t: 90_000, d: 2 },
    ]);
  });
  it("walks back from the current value", () => {
    const pts = seedBackward(100, [{ t: 100_500, d: -5 }, { t: 90_000, d: 2 }], 110_000, 30_000);
    expect(pts[0]).toEqual({ t: 80_000, v: 103 });
    expect(pts.find((p) => p.t === 90_000)!.v).toBe(105);
    expect(pts.find((p) => p.t === 100_499)!.v).toBe(105);
    expect(pts[pts.length - 1]).toEqual({ t: 110_000, v: 100 });
  });
  it("ignores changes older than the window", () => {
    const pts = seedBackward(100, [{ t: 1_000, d: 50 }], 110_000, 30_000);
    expect(pts.every((p) => p.v === 100)).toBe(true);
  });
});

describe("visibleEvents", () => {
  it("keeps events in the window and merges repeats of a kind", () => {
    const ev = visibleEvents(
      [
        { t: 5, kind: "send" },
        { t: 100, kind: "send" },
        { t: 110, kind: "send" },
        { t: 115, kind: "theft" },
        { t: 500, kind: "send" },
      ],
      50,
      600,
      50,
    );
    expect(ev).toEqual([
      { t: 100, kind: "send" },
      { t: 115, kind: "theft" },
      { t: 500, kind: "send" },
    ]);
  });
});

import { withSpike } from "../series";
describe("withSpike (mint then wipe between polls)", () => {
  it("raises the line by the minted amount between the mint and the wipe", () => {
    const pts: Pt[] = [{ t: 0, v: 100 }, { t: 3000, v: 100 }, { t: 6000, v: 100 }, { t: 9000, v: 100 }];
    const out = withSpike(pts, { from: 4000, to: 8000, amount: 5 });
    expect(out).toEqual([{ t: 0, v: 100 }, { t: 3000, v: 100 }, { t: 4000, v: 105 }, { t: 7999, v: 105 }, { t: 8000, v: 100 }, { t: 9000, v: 100 }]);
  });
  it("does nothing without a value before the mint", () => {
    const pts: Pt[] = [{ t: 5000, v: 100 }];
    expect(withSpike(pts, { from: 4000, to: 8000, amount: 5 })).toBe(pts);
  });
});
