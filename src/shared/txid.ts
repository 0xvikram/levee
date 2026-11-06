// Hedera transaction IDs come in two spellings:
//   SDK:    0.0.1234@1700000000.000000001
//   Mirror: 0.0.1234-1700000000-000000001
// We store and compare the Mirror spelling.

export function normaliseTxId(id: string): string {
  const s = id.trim();
  if (s.includes("@")) {
    const [acct, ts] = s.split("@");
    const [sec, nanos = "0"] = ts.split(".");
    return `${acct}-${sec}-${nanos.padStart(9, "0")}`;
  }
  return s;
}

/** Compare two consensus timestamps "seconds.nanos". Returns negative if a < b. */
export function compareConsensus(a: string, b: string): number {
  const [as, an = "0"] = a.split(".");
  const [bs, bn = "0"] = b.split(".");
  const d = BigInt(as) - BigInt(bs);
  if (d !== 0n) return d < 0n ? -1 : 1;
  const dn = BigInt(an.padEnd(9, "0")) - BigInt(bn.padEnd(9, "0"));
  return dn === 0n ? 0 : dn < 0n ? -1 : 1;
}

/** Consensus timestamp "seconds.nanos" to milliseconds since epoch. */
export function consensusToMs(ts: string): number {
  const [s, n = "0"] = ts.split(".");
  return Number(s) * 1000 + Math.floor(Number(n.padEnd(9, "0")) / 1e6);
}
