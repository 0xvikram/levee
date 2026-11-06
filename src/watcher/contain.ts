// Fire Exit containment: a pure planner that turns breaches into ordered controller
// calls, and an executor that sends them (ContractExecute, signed by the watcher key).
//
// Order matters on Hedera:
//   1. freeze the treasury first (stops further outflows),
//   2. wipe + freeze every unknown receiving account (a frozen account cannot be wiped, so the
//      controller wipes first, or uses wipeFrozen to unfreeze-wipe-freeze atomically);
//      a KNOWN partner (rules allowlist / state payees) is only frozen, never wiped: a false
//      alarm must not take a real partner's money (it wiped Asha Pay once), admins decide,
//   3. burn unauthorised supply still sitting in the token treasury (proxy),
//   4. pause the token last (a paused token rejects freeze/wipe/burn), only if configured.
import { createHash } from "node:crypto";
import type { Breach, Movement } from "../shared/types.js";
import { compareConsensus, consensusToMs } from "../shared/txid.js";
import type { AllowanceEvent } from "../shared/mirror.js";
import type { IncidentOut } from "../shared/hcs.js";

/** Watcher breaches: the shared matcher reasons plus allowances on the treasury. */
export type WatcherBreach =
  | Breach
  | { reason: "treasury-allowance"; allowance: AllowanceEvent };

export type StepKind = "freezeAccount" | "wipeAndFreeze" | "wipeFrozen" | "burnSupply" | "pauseToken";

export interface ContainmentStep {
  step: StepKind;
  account?: string; // 0.0.x (freeze / wipe steps)
  amount?: string; // smallest unit (wipe / burn steps)
  why: string;
  /** true when the account is a known partner: frozen only, never wiped */
  partner?: boolean;
}

export const PARTNER_WHY = "known partner: frozen, not wiped; admins decide";

export interface ContainmentState {
  treasury: string; // company treasury 0.0.x
  tokenTreasury: string; // HTS token treasury (Studio proxy) 0.0.x
  frozen: Set<string>; // accounts currently frozen for the token
  /** Current balances if known; wipe/burn amounts are capped to them so a call never reverts on "insufficient". */
  balances?: Map<string, bigint>;
  pauseOnBreach: boolean;
  paused?: boolean;
  /** Known recipients (rules allowlist / state payees). They are frozen, never wiped. */
  knownRecipients?: Set<string>;
}

export function isTreasuryOutflow(b: WatcherBreach, treasury: string): boolean {
  if (b.reason === "treasury-allowance") return true;
  return b.movement.kind === "transfer" && b.movement.from === treasury;
}

export function breachTime(b: WatcherBreach): string {
  return b.reason === "treasury-allowance" ? b.allowance.consensusAt : b.movement.consensusAt;
}

export function breachTxId(b: WatcherBreach): string {
  return b.reason === "treasury-allowance" ? b.allowance.txId : b.movement.txId;
}

/** Earliest consensus time among the breaches (the clock starts here). */
export function firstBreachAt(breaches: WatcherBreach[]): string {
  return breaches.map(breachTime).sort(compareConsensus)[0];
}

export function planContainment(breaches: WatcherBreach[], s: ContainmentState): ContainmentStep[] {
  const steps: ContainmentStep[] = [];
  if (breaches.length === 0) return steps;
  const frozen = new Set(s.frozen);
  const cap = (acct: string, want: bigint): bigint => {
    const bal = s.balances?.get(acct);
    return bal === undefined ? want : bal < want ? bal : want;
  };

  // 1. Freeze the treasury if anything left it (or it granted an allowance).
  if (breaches.some((b) => isTreasuryOutflow(b, s.treasury)) && !frozen.has(s.treasury)) {
    steps.push({ step: "freezeAccount", account: s.treasury, why: "treasury outflow without a valid receipt" });
    frozen.add(s.treasury);
  }

  // 2. Aggregate what each receiving account got across all breaches of this incident.
  const received = new Map<string, bigint>();
  let mintedInTreasury = 0n;
  const movements: Movement[] = breaches.flatMap((b) => (b.reason === "treasury-allowance" ? [] : [b.movement]));
  for (const m of movements) {
    if (m.kind === "mint" && m.to === s.tokenTreasury) {
      mintedInTreasury += BigInt(m.amount);
      continue;
    }
    received.set(m.to, (received.get(m.to) ?? 0n) + BigInt(m.amount));
  }
  // Stable order: biggest first, then id, so the largest theft is clawed back first.
  const ordered = [...received.entries()].sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] > b[1] ? -1 : 1));
  for (const [acct, want] of ordered) {
    if (acct === s.tokenTreasury) continue; // HTS cannot wipe the token treasury
    if (s.knownRecipients?.has(acct)) {
      if (!frozen.has(acct)) {
        steps.push({ step: "freezeAccount", account: acct, why: PARTNER_WHY, partner: true });
        frozen.add(acct);
      }
      continue;
    }
    const amount = cap(acct, want);
    if (amount <= 0n) {
      if (!frozen.has(acct)) {
        steps.push({ step: "freezeAccount", account: acct, why: "received unauthorised tokens; balance already moved on" });
        frozen.add(acct);
      }
      continue;
    }
    steps.push({
      step: frozen.has(acct) ? "wipeFrozen" : "wipeAndFreeze",
      account: acct,
      amount: amount.toString(),
      why: amount < want ? `claw back ${amount} of ${want} (rest already moved)` : "claw back unauthorised tokens",
    });
    frozen.add(acct);
  }

  // 3. Burn unauthorised supply still held by the token treasury.
  if (mintedInTreasury > 0n) {
    const amount = cap(s.tokenTreasury, mintedInTreasury);
    if (amount > 0n) steps.push({ step: "burnSupply", amount: amount.toString(), why: "unauthorised mint still in the token treasury" });
  }

  // 4. Pause last, only if configured.
  if (s.pauseOnBreach && !s.paused) steps.push({ step: "pauseToken", why: "PAUSE_ON_BREACH is set" });
  return steps;
}

/** Deterministic bytes32 incident id from the breach tx ids. */
export function incidentIdFor(breaches: WatcherBreach[]): string {
  const ids = [...new Set(breaches.map(breachTxId))].sort().join(",");
  return "0x" + createHash("sha256").update("levee-incident:" + ids).digest("hex");
}

// ------------------------------------------------------------------ executor

export interface StepResult {
  step: StepKind;
  account?: string;
  amount?: string;
  txId?: string;
  ok: boolean;
  atMs: number; // ms since the first breach movement's consensus time
  error?: string;
  partner?: boolean;
}

/** Sends one controller call; returns the normalised tx id. Throws on failure. */
export type ControllerCall = (step: ContainmentStep, incidentId: string) => Promise<{ txId: string }>;

/** Run steps in order; a failed step is recorded and the next one still runs. */
export async function executeContainment(
  steps: ContainmentStep[],
  incidentId: string,
  breachAt: string,
  call: ControllerCall,
  now: () => number = Date.now,
): Promise<StepResult[]> {
  const t0 = consensusToMs(breachAt);
  const out: StepResult[] = [];
  for (const s of steps) {
    try {
      const { txId } = await call(s, incidentId);
      out.push({ step: s.step, account: s.account, amount: s.amount, txId, ok: true, atMs: now() - t0, ...(s.partner ? { partner: true } : {}) });
    } catch (e) {
      out.push({ step: s.step, account: s.account, amount: s.amount, ok: false, atMs: now() - t0, error: (e as Error).message.slice(0, 200), ...(s.partner ? { partner: true } : {}) });
    }
  }
  return out;
}

export function buildIncident(o: {
  incidentId: string;
  token: string;
  breaches: WatcherBreach[];
  results: StepResult[];
  detectedAtMs: number;
}): IncidentOut {
  const t0 = consensusToMs(firstBreachAt(o.breaches));
  const last = o.results.length ? o.results[o.results.length - 1].atMs : undefined;
  return {
    v: 1,
    type: "incident",
    incidentId: o.incidentId,
    token: o.token,
    breaches: o.breaches.map((b) =>
      b.reason === "treasury-allowance"
        ? { txId: b.allowance.txId, to: b.allowance.owner, amount: "0", reason: b.reason }
        : { txId: b.movement.txId, to: b.movement.to, amount: b.movement.amount, reason: b.reason },
    ),
    actions: o.results.map((r) => ({
      step: r.step,
      ...(r.account ? { account: r.account } : {}),
      ...(r.amount ? { amount: r.amount } : {}),
      ...(r.txId ? { txId: r.txId } : {}),
      ok: r.ok,
      atMs: r.atMs,
      ...(r.partner ? { note: PARTNER_WHY } : {}), // says why a receiver was frozen but not wiped
      ...(r.error ? { error: r.error } : {}), // kept so a failed step can be diagnosed
    })),
    detectedMs: o.detectedAtMs - t0,
    ...(last !== undefined ? { containedMs: last } : {}),
  };
}
