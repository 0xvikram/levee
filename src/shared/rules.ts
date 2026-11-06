// The same rules are used twice: by the gate before approving, and by the watcher
// when it re-checks every receipt (so a stolen gate key can only produce small,
// known-destination receipts).
import type { Rules } from "./types.js";

export type RuleResult = { ok: true } | { ok: false; reason: "over-transfer-cap" | "over-daily-cap" | "unknown-destination" };

export function checkRules(
  rules: Rules,
  req: { to: string; amount: bigint; kind: "transfer" | "mint" },
  spentToday: bigint,
): RuleResult {
  if (req.amount > rules.capPerTransfer) return { ok: false, reason: "over-transfer-cap" };
  if (spentToday + req.amount > rules.capPerDay) return { ok: false, reason: "over-daily-cap" };
  if (req.kind === "transfer" && !rules.knownDestinations.includes(req.to)) {
    return { ok: false, reason: "unknown-destination" };
  }
  return { ok: true };
}

/** UTC day key from a consensus timestamp "seconds.nanos". */
export function dayKey(consensusAt: string): string {
  const sec = Number(consensusAt.split(".")[0]);
  return new Date(sec * 1000).toISOString().slice(0, 10);
}
