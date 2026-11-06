/** "seconds.nanos" consensus timestamp to epoch ms. */
export function consensusToMs(ts: string): number {
  const [s, n = "0"] = ts.split(".");
  return Number(s) * 1000 + Math.floor(Number(n.padEnd(9, "0").slice(0, 9)) / 1e6);
}

/** Smallest-unit integer string to a grouped whole-token string (trailing zeros trimmed). */
export function formatAmount(raw: string, decimals: number): string {
  let v: bigint;
  try {
    v = BigInt(raw);
  } catch {
    return raw;
  }
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const whole = (v / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = decimals ? (v % base).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return (neg ? "-" : "") + whole + (frac ? "." + frac : "");
}

/** ms to "s.ss" with a fixed 2-decimal stopwatch look, e.g. 8309 -> "8.31". */
export function stopwatch(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0.00";
  if (ms >= 600_000) return `${Math.floor(ms / 60_000)}m`;
  return (ms / 1000).toFixed(2);
}

export function seconds1(ms: number): string {
  return (ms / 1000).toFixed(1);
}

/** Countdown "m:ss". */
export function countdown(ms: number): string {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

export function shortTx(txId: string): string {
  const [acct, s, n] = txId.split("-");
  return n ? `${acct}-${s}-${n.slice(0, 4)}…` : txId;
}
