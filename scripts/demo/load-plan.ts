// Pure plan for the false-alarm run: N legitimate transfers spread over the payees with varied
// amounts inside the caps, and the total checked against the daily cap before anything is sent.

export interface PlannedTransfer {
  i: number;
  to: string;
  amount: bigint; // smallest unit
}

/** Deterministic PRNG (mulberry32) so a run can be repeated exactly from its seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Amounts are uniform in [minWhole, maxWhole] whole tokens plus a random fraction (so no two
 * look alike), never above capPerTransfer. Destinations alternate randomly over `payees`.
 */
export function planLoad(o: { n: number; payees: string[]; decimals: number; capPerTransfer: bigint; minWhole?: number; maxWhole?: number; seed?: number }): PlannedTransfer[] {
  const r = rng(o.seed ?? 1);
  const scale = 10n ** BigInt(o.decimals);
  const min = BigInt(o.minWhole ?? 10) * scale;
  const max = BigInt(o.maxWhole ?? 900) * scale;
  const capUnits = o.capPerTransfer * scale;
  const out: PlannedTransfer[] = [];
  for (let i = 0; i < o.n; i++) {
    let amount = min + BigInt(Math.floor(r() * Number(max - min)));
    if (amount > capUnits) amount = capUnits;
    if (amount <= 0n) amount = 1n;
    out.push({ i, to: o.payees[Math.floor(r() * o.payees.length)], amount });
  }
  return out;
}

export const totalOf = (p: PlannedTransfer[]): bigint => p.reduce((s, x) => s + x.amount, 0n);

/** Daily cap needed (whole tokens, rounded up) so the plan plus what is already spent today fits. */
export function dailyCapNeeded(plan: PlannedTransfer[], spentTodayUnits: bigint, decimals: number): bigint {
  const scale = 10n ** BigInt(decimals);
  const need = totalOf(plan) + spentTodayUnits;
  return (need + scale - 1n) / scale;
}
