// Pure helpers for the ordered-dither engravings (components/DitherImage.tsx).
// Everything here is plain maths on typed arrays, so it is tested without a canvas.

export type BayerSize = 2 | 4 | 8;

/**
 * Bayer ordered-dither matrix of size n×n, row-major, as thresholds in (0, 1):
 * (rank + 0.5) / n². Built recursively: M(2k) = [[4M, 4M+2], [4M+3, 4M+1]].
 */
export function bayer(n: BayerSize): Float32Array {
  let m = [[0]];
  while (m.length < n) {
    const k = m.length;
    const next: number[][] = Array.from({ length: k * 2 }, () => new Array<number>(k * 2).fill(0));
    for (let y = 0; y < k; y++) {
      for (let x = 0; x < k; x++) {
        const v = m[y][x] * 4;
        next[y][x] = v;
        next[y][x + k] = v + 2;
        next[y + k][x] = v + 3;
        next[y + k][x + k] = v + 1;
      }
    }
    m = next;
  }
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] = (m[y][x] + 0.5) / (n * n);
  return out;
}

/** Source rectangle that makes an image cover a dstW×dstH box (like object-fit: cover), anchored at posX/posY (0..1). */
export function coverRect(srcW: number, srcH: number, dstW: number, dstH: number, posX = 0.5, posY = 0.5) {
  const scale = Math.max(dstW / srcW, dstH / srcH);
  const sw = dstW / scale;
  const sh = dstH / scale;
  return { sx: (srcW - sw) * posX, sy: (srcH - sh) * posY, sw, sh };
}

/** Perceptual brightness of an sRGB pixel (0..255 channels) in 0..1 (Rec. 709 weights on the encoded values). */
export function luma(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Brightness of every pixel of an RGBA buffer. */
export function lumaOf(rgba: Uint8ClampedArray | Uint8Array): Float32Array {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = luma(rgba[i], rgba[i + 1], rgba[i + 2]);
  return out;
}

/**
 * Stretch brightness so the lowPct quantile maps to 0 and the highPct quantile to 1 (clamped).
 * Engravings are mostly flat sky plus thin light lines, so this keeps the lines crisp. When the
 * commonest value (the sky) is dark, the black point is lifted to sky + skyPad. In place.
 */
export function stretchLevels(lum: Float32Array, lowPct = 0.04, highPct = 0.985, skyPad = 0.1): Float32Array {
  if (lum.length === 0) return lum;
  const bins = new Uint32Array(256);
  for (let i = 0; i < lum.length; i++) bins[Math.min(255, Math.max(0, Math.round(lum[i] * 255)))]++;
  const at = (pct: number) => {
    const target = Math.max(1, pct * lum.length);
    let acc = 0;
    for (let b = 0; b < 256; b++) {
      acc += bins[b];
      if (acc >= target) return b / 255;
    }
    return 1;
  };
  // the most common brightness is the flat sky when it sits in the darker half: lift the black point
  // just past it, so the sky's paper noise comes out as solid dark tone instead of a haze of dots
  let mode = 0;
  for (let b = 1; b < 256; b++) if (bins[b] > bins[mode]) mode = b;
  const lo = mode < 128 ? Math.max(at(lowPct), mode / 255 + skyPad) : at(lowPct);
  let hi = at(highPct);
  if (hi - lo < 0.05) hi = Math.min(1, lo + 0.05);
  const span = hi - lo;
  for (let i = 0; i < lum.length; i++) lum[i] = Math.min(1, Math.max(0, (lum[i] - lo) / span));
  return lum;
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const easeOutCubic = (t: number) => 1 - (1 - clamp01(t)) ** 3;

/**
 * Reveal offset for a row at height yNorm (0 top .. 1 bottom) when the reveal is `p` (0..1) done.
 * -1 hides everything (all pixels take the dark tone), 0 is the finished image. The sweep runs
 * top to bottom: a row starts `band` later than the row above it, so the image dithers in from the sky.
 */
export function revealBias(p: number, yNorm: number, band = 0.35): number {
  const e = easeOutCubic(p);
  return clamp01(e * (1 + band) - clamp01(yNorm) * band) - 1;
}

/**
 * Ambient shimmer: a soft diagonal band of extra brightness that drifts across the image.
 * Returns a lookup by diagonal index d = x + y (0 .. w + h - 2) for time tMs, so a frame
 * costs one array read per pixel. `amp` is the peak boost (keep it small: it only flips
 * pixels sitting right at their threshold).
 */
export function shimmerLut(w: number, h: number, tMs: number, amp = 0.07, periodMs = 9000, out?: Float32Array): Float32Array {
  const len = Math.max(1, w + h - 1);
  const lut = out && out.length === len ? out : new Float32Array(len);
  const width = len * 0.12;
  // the band travels from before the start to past the end, so it enters and leaves softly
  const pos = ((tMs % periodMs) / periodMs) * (len + 4 * width) - 2 * width;
  const inv = 1 / (2 * width * width);
  for (let d = 0; d < len; d++) {
    const k = d - pos;
    lut[d] = amp * Math.exp(-k * k * inv);
  }
  return lut;
}

/** "#RRGGBB" to a 32-bit pixel for a Uint32Array view over ImageData (little-endian: ABGR in memory). */
export function packColor(hex: string, alpha = 255): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return ((alpha << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/**
 * One frame of two-tone ordered dither. A pixel takes `light` when its brightness, plus the
 * row's reveal offset and the shimmer for its diagonal, is above the Bayer threshold at its cell.
 * `rowBias` (length h) and `lut` (length w + h - 1) may be omitted for a still frame.
 * Returns how many pixels came out light (handy for tests and for "is anything drawn yet").
 */
export function ditherInto(
  out: Uint32Array,
  lum: Float32Array,
  w: number,
  h: number,
  matrix: Float32Array,
  n: number,
  dark: number,
  light: number,
  rowBias?: Float32Array,
  lut?: Float32Array,
): number {
  let lit = 0;
  const mask = n - 1; // n is a power of two
  for (let y = 0; y < h; y++) {
    const bias = rowBias ? rowBias[y] : 0;
    const mrow = (y & mask) * n;
    const base = y * w;
    for (let x = 0; x < w; x++) {
      const i = base + x;
      const v = lum[i] + bias + (lut ? lut[x + y] : 0);
      if (v > matrix[mrow + (x & mask)]) {
        out[i] = light;
        lit++;
      } else out[i] = dark;
    }
  }
  return lit;
}

/** Grid for a box of cssW×cssH CSS px at `dpr`, with square cells of `cellCss` CSS px snapped to whole device pixels. */
export function ditherGrid(cssW: number, cssH: number, dpr: number, cellCss: number) {
  const ratio = Math.max(1, Math.min(dpr || 1, 2));
  const cellDev = Math.max(1, Math.round(cellCss * ratio));
  const w = Math.max(1, Math.ceil((cssW * ratio) / cellDev));
  const h = Math.max(1, Math.ceil((cssH * ratio) / cellDev));
  return { w, h, cellDev, cssW: (w * cellDev) / ratio, cssH: (h * cellDev) / ratio };
}
