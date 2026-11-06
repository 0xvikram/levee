// SVG ring countdown for a machine pass (180 s Arkiv lifetime).

export interface Ring {
  /** fraction of the pass left, 0..1 */
  frac: number;
  circumference: number;
  /** stroke-dashoffset: 0 = full ring, circumference = empty */
  offset: number;
}

export function ring(leftMs: number, totalMs: number, r: number): Ring {
  const c = 2 * Math.PI * r;
  const frac = totalMs > 0 && Number.isFinite(leftMs) ? Math.min(1, Math.max(0, leftMs / totalMs)) : 0;
  return { frac, circumference: c, offset: c * (1 - frac) };
}

/** Under this fraction the ring turns from olive to neutral warning. */
export const RING_LOW = 1 / 6; // 30 s of 180 s
