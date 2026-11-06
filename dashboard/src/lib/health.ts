// Service health for the top bar.
//
// Bug fixed (pills showed "off" while the watcher was up): every SSE stream and every poll went
// through the same Vite proxy origin, and a browser allows only 6 HTTP/1.1 connections per origin.
// Three never-ending SSE streams (six with a second tab) starved the polls, which then hit the
// 5 s abort and flipped to "off" on the first miss. Checker /passes also reads Arkiv and can take
// longer than 5 s. Now: SSE goes straight to the service port on local dev (its own connection
// pool; the services send CORS * on /events), an open SSE stream counts as proof of life, polls
// wait 8 s, and a service only reads "off" after two misses in a row.

export interface PollState<T> {
  data: T | null;
  ok: boolean; // last answer was 2xx JSON
  reachable: boolean; // last answer was JSON at all (watcher /health answers 503 + JSON)
  fails: number; // consecutive misses (timeout / network / non-JSON)
  at: number;
}

export const initialPoll: PollState<never> = { data: null, ok: false, reachable: false, fails: 0, at: 0 };

export type PollResult<T> = { kind: "answer"; status: number; data: T | null } | { kind: "miss" };

export function nextPoll<T>(prev: PollState<T>, r: PollResult<T>, now: number): PollState<T> {
  if (r.kind === "answer" && r.data !== null) {
    return { data: r.data, ok: r.status >= 200 && r.status < 300, reachable: true, fails: 0, at: now };
  }
  return { ...prev, fails: prev.fails + 1, at: now, ...(prev.fails + 1 >= 2 ? { ok: false, reachable: false } : {}) };
}

export type ServiceStatus = "checking" | "up" | "degraded" | "off";

export function serviceStatus(poll: Pick<PollState<unknown>, "ok" | "reachable" | "fails" | "at">, sse?: "connecting" | "open" | "closed"): ServiceStatus {
  if (poll.ok) return "up";
  if (poll.reachable) return "degraded";
  if (sse === "open") return "up";
  if (poll.at === 0 || poll.fails < 2) return "checking";
  return "off";
}
