// Pure matching logic: every treasury movement must have a receipt that
// (1) has the same transaction ID, (2) reached consensus BEFORE the movement,
// (3) matches token/from/to/amount/kind exactly, (4) was not used before, and
// (5) still passes the rules. Anything else is a breach.
import type { Breach, Movement, Receipt, Rules } from "../shared/types.js";
import { compareConsensus } from "../shared/txid.js";
import { checkRules, dayKey } from "../shared/rules.js";

export interface MatchState {
  usedReceipts: Set<string>; // txIds already matched
  spentByDay: Map<string, bigint>; // approved outflow per UTC day
}

export function newMatchState(): MatchState {
  return { usedReceipts: new Set(), spentByDay: new Map() };
}

export interface MatchResult {
  matched: Movement[];
  breaches: Breach[];
}

export function matchMovements(
  movements: Movement[],
  receipts: Map<string, Receipt>,
  rules: Rules,
  state: MatchState,
): MatchResult {
  const matched: Movement[] = [];
  const breaches: Breach[] = [];

  const ordered = [...movements].sort((a, b) => compareConsensus(a.consensusAt, b.consensusAt));
  for (const m of ordered) {
    const r = receipts.get(m.txId);
    if (!r) {
      breaches.push({ movement: m, reason: "no-receipt" });
      continue;
    }
    if (!r.consensusAt || compareConsensus(r.consensusAt, m.consensusAt) >= 0) {
      breaches.push({ movement: m, reason: "receipt-after-movement" });
      continue;
    }
    if (state.usedReceipts.has(m.txId)) {
      breaches.push({ movement: m, reason: "receipt-reused" });
      continue;
    }
    const same =
      r.token === m.token &&
      r.to === m.to &&
      r.amount === m.amount &&
      r.kind === m.kind &&
      (m.kind === "mint" || r.from === m.from);
    if (!same) {
      breaches.push({ movement: m, reason: "receipt-mismatch" });
      continue;
    }
    const day = dayKey(m.consensusAt);
    const spent = state.spentByDay.get(day) ?? 0n;
    const rule = checkRules(rules, { to: m.to, amount: BigInt(m.amount), kind: m.kind }, spent);
    if (!rule.ok) {
      breaches.push({ movement: m, reason: rule.reason });
      continue;
    }
    state.usedReceipts.add(m.txId);
    state.spentByDay.set(day, spent + BigInt(m.amount));
    matched.push(m);
  }
  return { matched, breaches };
}
