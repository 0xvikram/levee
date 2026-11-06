import { describe, expect, it } from "vitest";
import { bayer, coverRect, ditherGrid, ditherInto, easeOutCubic, luma, lumaOf, packColor, revealBias, shimmerLut, stretchLevels } from "../dither";

describe("bayer", () => {
  it("builds the classic 2×2 and 4×4 orders", () => {
    expect([...bayer(2)].map((v) => v * 4 - 0.5)).toEqual([0, 2, 3, 1]);
    expect([...bayer(4)].map((v) => Math.round(v * 16 - 0.5))).toEqual([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);
  });
  it.each([2, 4, 8] as const)("%i×%i holds every rank once, strictly inside (0, 1)", (n) => {
    const m = bayer(n);
    expect(m).toHaveLength(n * n);
    const ranks = [...m].map((v) => Math.round(v * n * n - 0.5)).sort((a, b) => a - b);
    expect(ranks).toEqual(Array.from({ length: n * n }, (_, i) => i));
    for (const v of m) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("coverRect", () => {
  it("crops the sides of a wide image into a square box, centred", () => {
    expect(coverRect(200, 100, 50, 50)).toEqual({ sx: 50, sy: 0, sw: 100, sh: 100 });
  });
  it("anchors the crop with posY (0 keeps the top)", () => {
    const r = coverRect(100, 200, 100, 50, 0.5, 0);
    expect(r.sy).toBe(0);
    expect(r.sh).toBe(50);
  });
});

describe("brightness", () => {
  it("is 0 for black, 1 for white, green brighter than blue", () => {
    expect(luma(0, 0, 0)).toBe(0);
    expect(luma(255, 255, 255)).toBeCloseTo(1, 6);
    expect(luma(0, 255, 0)).toBeGreaterThan(luma(0, 0, 255));
    expect([...lumaOf(new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]))].map((v) => Math.round(v))).toEqual([1, 0]);
  });
  it("stretches the quantiles to 0 and 1", () => {
    const l = new Float32Array(100).map((_, i) => 0.2 + (i / 99) * 0.4);
    stretchLevels(l, 0, 1);
    expect(Math.min(...l)).toBeCloseTo(0, 2);
    expect(Math.max(...l)).toBeCloseTo(1, 2);
  });
  it("turns a noisy dark sky into solid dark tone", () => {
    const l = new Float32Array(1000).map((_, i) => (i < 800 ? 0.2 + ((i * 7919) % 5) / 255 : 0.6 + ((i * 31) % 40) / 100));
    stretchLevels(l);
    expect(Math.max(...l.slice(0, 800))).toBe(0);
    expect(Math.max(...l.slice(800))).toBeCloseTo(1, 2);
  });
  it("does not divide by zero on a flat image", () => {
    const l = new Float32Array(10).fill(0.3);
    stretchLevels(l);
    for (const v of l) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("reveal", () => {
  it("starts fully hidden and ends at the finished image", () => {
    for (const y of [0, 0.5, 1]) {
      expect(revealBias(0, y)).toBe(-1);
      expect(revealBias(1, y)).toBe(0);
    }
  });
  it("sweeps from the top: higher rows are further along mid-way", () => {
    expect(revealBias(0.4, 0)).toBeGreaterThan(revealBias(0.4, 1));
  });
  it("never goes backwards", () => {
    let prev = -1;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const b = revealBias(p, 0.6);
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
    expect(easeOutCubic(2)).toBe(1);
  });
});

describe("shimmer", () => {
  it("is a small, bounded band that moves over time", () => {
    const a = shimmerLut(40, 20, 1000);
    const b = shimmerLut(40, 20, 4000);
    expect(a).toHaveLength(59);
    expect(Math.max(...a)).toBeLessThanOrEqual(0.07 + 1e-6);
    expect(Math.min(...a)).toBeGreaterThanOrEqual(0);
    expect(a.indexOf(Math.max(...a))).not.toBe(b.indexOf(Math.max(...b)));
  });
});

describe("ditherInto", () => {
  const n = 4;
  const m = bayer(n);
  const DARK = packColor("#1D3BA5");
  const LIGHT = packColor("#F3EBD6");

  it("packs colours as little-endian RGBA", () => {
    expect(packColor("#010203") >>> 0).toBe(0xff030201);
  });

  it("maps 0 to all dark, 1 to all light, and 0.5 to about half lit in the Bayer pattern", () => {
    const w = 16;
    const h = 16;
    const out = new Uint32Array(w * h);
    expect(ditherInto(out, new Float32Array(w * h).fill(0), w, h, m, n, DARK, LIGHT)).toBe(0);
    expect(out.every((p) => p === DARK)).toBe(true);
    expect(ditherInto(out, new Float32Array(w * h).fill(1), w, h, m, n, DARK, LIGHT)).toBe(w * h);
    expect(ditherInto(out, new Float32Array(w * h).fill(0.5), w, h, m, n, DARK, LIGHT)).toBe((w * h) / 2);
  });

  it("hides everything at the start of the reveal", () => {
    const w = 8;
    const h = 8;
    const out = new Uint32Array(w * h);
    const rows = new Float32Array(h).map((_, y) => revealBias(0, y / (h - 1)));
    expect(ditherInto(out, new Float32Array(w * h).fill(1), w, h, m, n, DARK, LIGHT, rows)).toBe(0);
  });

  it("lets the shimmer light a few extra pixels, never fewer", () => {
    const w = 32;
    const h = 16;
    const out = new Uint32Array(w * h);
    const lum = new Float32Array(w * h).fill(0.45);
    const still = ditherInto(out, lum, w, h, m, n, DARK, LIGHT);
    const lut = shimmerLut(w, h, 4500);
    const lit = ditherInto(out, lum, w, h, m, n, DARK, LIGHT, undefined, lut);
    expect(lit).toBeGreaterThan(still);
    expect(lit).toBeLessThan(w * h * 0.6);
  });
});

describe("ditherGrid", () => {
  it("snaps cells to whole device pixels and covers the box", () => {
    const g = ditherGrid(1001, 500, 2, 2);
    expect(g.cellDev).toBe(4);
    expect(g.w).toBe(Math.ceil(2002 / 4));
    expect(g.cssW).toBeGreaterThanOrEqual(1001);
    expect(g.cssH).toBeGreaterThanOrEqual(500);
  });
  it("caps the pixel ratio at 2 and never returns an empty grid", () => {
    expect(ditherGrid(100, 100, 3, 2).cellDev).toBe(4);
    const z = ditherGrid(0, 0, 1, 3);
    expect(z.w).toBe(1);
    expect(z.h).toBe(1);
  });
});
