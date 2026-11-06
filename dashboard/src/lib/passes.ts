// Machine passes: reducer over checker /passes snapshots and /events.
import type { CheckerEvent, PassView } from "./types";

export type PassesState = Record<string, PassView>;

export type PassesAction = { type: "snapshot"; passes: PassView[] } | { type: "event"; event: CheckerEvent };

export function passesReducer(s: PassesState, a: PassesAction): PassesState {
  if (a.type === "snapshot") {
    const out: PassesState = {};
    for (const p of a.passes) out[p.machine] = p;
    return out;
  }
  const { type, data, at } = a.event;
  const machine = data?.machine;
  if (!machine) return s;
  const cur: PassView = s[machine] ?? { machine, live: false, kind: "unknown", expiresAt: null, reason: null };
  if (type === "enrol") return s[machine] ? s : { ...s, [machine]: { ...cur, reason: "enrolled, no heartbeat yet" } };
  if (type !== "heartbeat") return s;
  const seen = new Date(at).toISOString();
  if (data.ok && typeof data.expiresAtMs === "number") {
    return { ...s, [machine]: { ...cur, live: true, kind: "ok", reason: null, expiresAt: new Date(data.expiresAtMs).toISOString(), lastHeartbeatAt: seen } };
  }
  if (data.ok === false) {
    return { ...s, [machine]: { ...cur, live: false, kind: "unhealthy", expiresAt: null, reason: `check failed: ${(data.failing ?? []).join(", ")}`, lastHeartbeatAt: seen } };
  }
  return s;
}

/** Live at `nowMs`: the checker said live and the Arkiv expiry has not passed. */
export function passLeftMs(p: PassView, nowMs: number): number {
  if (!p.live || !p.expiresAt) return 0;
  return Math.max(0, Date.parse(p.expiresAt) - nowMs);
}
