// Containment stopwatch: pure reducer. The clock starts at the breach movement's consensus
// time and stops at the last containment step (atMs values are measured from that same instant).
import type { BreachView, Incident, IncidentAction, WatcherSnapshot } from "./types";
import { consensusToMs } from "./format";

export type Phase = "idle" | "running" | "contained";

export interface ContainState {
  phase: Phase;
  incidentId?: string;
  breachTxId?: string;
  breachTo?: string;
  breachAmount?: string;
  startMs?: number; // epoch ms of the breach movement's consensus time
  detectedMs?: number;
  steps: IncidentAction[];
  plannedSteps?: number;
  containedMs?: number;
  source?: "live" | "watcher" | "hcs";
}

export type ContainAction =
  | { type: "breach"; breach: BreachView }
  | { type: "detected"; incidentId: string; detectedMs: number; breaches?: BreachView[] }
  | { type: "plan"; incidentId: string; steps: unknown[] }
  | { type: "step"; step: IncidentAction & { incidentId?: string } }
  | { type: "incident"; incident: Incident; source?: ContainState["source"] }
  | { type: "snapshot"; snapshot: WatcherSnapshot }
  | { type: "hcs-incident"; incident: Incident };

export const initialContain: ContainState = { phase: "idle", steps: [] };

function stepKey(s: IncidentAction): string {
  return `${s.step}|${s.account ?? ""}|${s.txId ?? s.atMs}`;
}

function addStep(steps: IncidentAction[], s: IncidentAction): IncidentAction[] {
  if (steps.some((x) => stepKey(x) === stepKey(s))) return steps;
  return [...steps, s].sort((a, b) => a.atMs - b.atMs);
}

function fromIncident(i: Incident, source: ContainState["source"], breach?: BreachView): ContainState {
  const first = i.breaches[0];
  return {
    phase: "contained",
    incidentId: i.incidentId,
    breachTxId: first?.txId,
    breachTo: first?.to,
    breachAmount: first?.amount,
    startMs: breach ? consensusToMs(breach.consensusAt) : undefined,
    detectedMs: i.detectedMs,
    steps: [...i.actions].sort((a, b) => a.atMs - b.atMs),
    plannedSteps: i.actions.length,
    containedMs: i.containedMs ?? (i.actions.length ? Math.max(...i.actions.map((x) => x.atMs)) : undefined),
    source,
  };
}

export function containReducer(s: ContainState, a: ContainAction): ContainState {
  switch (a.type) {
    case "breach": {
      const b = a.breach;
      if (b.historic) return s; // primed from earlier today: shown in the feed, never re-timed
      const startMs = consensusToMs(b.consensusAt);
      if (s.phase === "running") return { ...s, startMs: Math.min(s.startMs ?? startMs, startMs) };
      if (s.phase === "contained" && s.breachTxId === b.txId) return s; // replayed history
      return { phase: "running", breachTxId: b.txId, breachTo: b.to, breachAmount: b.amount, startMs, steps: [], source: "live" };
    }
    case "detected": {
      if (s.phase === "contained" && s.incidentId === a.incidentId) return s;
      const b = a.breaches?.[0];
      const base: ContainState = s.phase === "running" ? s : { phase: "running", steps: [], source: "live", breachTxId: b?.txId, breachTo: b?.to, breachAmount: b?.amount, startMs: b ? consensusToMs(b.consensusAt) : undefined };
      return { ...base, incidentId: a.incidentId, detectedMs: a.detectedMs };
    }
    case "plan":
      if (s.phase !== "running") return s;
      return { ...s, incidentId: a.incidentId, plannedSteps: a.steps.length };
    case "step": {
      const { incidentId, ...step } = a.step;
      if (s.phase === "contained" && (!incidentId || s.incidentId === incidentId)) return s;
      const base: ContainState = s.phase === "running" ? s : { phase: "running", steps: [], source: "live", incidentId };
      return { ...base, steps: addStep(base.steps, { ...step, ok: step.ok ?? true }) };
    }
    case "incident": {
      const startMs = s.incidentId === a.incident.incidentId || s.breachTxId === a.incident.breaches[0]?.txId ? s.startMs : undefined;
      return { ...fromIncident(a.incident, a.source ?? "live"), startMs };
    }
    case "snapshot": {
      if (s.phase !== "idle") return s;
      const incs = a.snapshot.incidents ?? [];
      const last = incs[incs.length - 1];
      if (!last) return s;
      const breach = (a.snapshot.breaches ?? []).find((b) => b.txId === last.breaches[0]?.txId);
      return fromIncident(last, "watcher", breach);
    }
    case "hcs-incident":
      return s.phase === "idle" ? fromIncident(a.incident, "hcs") : s;
  }
}

/** Value to show on the stopwatch at wall-clock `nowMs`. */
export function elapsedMs(s: ContainState, nowMs: number): number {
  if (s.phase === "contained") return s.containedMs ?? 0;
  if (s.phase === "running") {
    if (s.startMs === undefined) return s.steps.length ? s.steps[s.steps.length - 1].atMs : 0;
    return Math.max(0, nowMs - s.startMs);
  }
  return 0;
}

/** Human label for a controller step. */
export function stepLabel(step: string, account: string | undefined, amount: string | undefined, ctx: { treasury: string; fmt: (raw: string) => string; symbol: string }): string {
  switch (step) {
    case "freezeAccount":
      return account === ctx.treasury ? "Treasury frozen" : `Account ${account ?? ""} frozen`;
    case "wipeAndFreeze":
    case "wipeFrozen":
      return `${amount ? ctx.fmt(amount) : ""} ${ctx.symbol} wiped, receiver frozen`.trim();
    case "burnSupply":
      return `${amount ? ctx.fmt(amount) : ""} ${ctx.symbol} unapproved supply burned`.trim();
    case "pauseToken":
      return "Token paused";
    default:
      return step;
  }
}
