// Breach mode for /live: red frame + banner while a live breach is being contained, then an
// olive "Contained in X s" banner that holds for HOLD_MS before the room goes calm again.
import type { ContainState } from "./stopwatch";

export type BreachMode = { kind: "calm" } | { kind: "live"; since: number } | { kind: "contained"; since: number; seconds: number };

export type BreachModeAction = { type: "update"; contain: ContainState; now: number } | { type: "tick"; now: number };

export const HOLD_MS = 25_000;
export const calm: BreachMode = { kind: "calm" };

export function breachModeReducer(m: BreachMode, a: BreachModeAction): BreachMode {
  if (a.type === "tick") return m.kind === "contained" && a.now - m.since > HOLD_MS ? calm : m;
  const c = a.contain;
  if (c.phase === "running" && c.source === "live") return m.kind === "live" ? m : { kind: "live", since: a.now };
  if (c.phase === "contained" && m.kind === "live") return { kind: "contained", since: a.now, seconds: (c.containedMs ?? 0) / 1000 };
  if (c.phase === "contained" && m.kind === "contained") return a.now - m.since > HOLD_MS ? calm : m;
  if (c.phase === "idle") return calm;
  return m; // a contained incident replayed from history never raises the banner
}
