// "Replay latest incident" for /live chain mode: animates the stopwatch and the pipeline with
// the step times (atMs) recorded in a real incident on the incidents topic. Pure: given the
// incident and the time since the replay started, return what the room shows at that moment.
import { initialPipeline, pipelineReducer, type PipelineState } from "./pipeline";
import { containReducer, initialContain, type ContainState } from "./stopwatch";
import type { Incident } from "./types";

/** ms (from the theft reaching consensus) of the last containment step. */
export function replayEndMs(i: Incident): number {
  return i.containedMs ?? (i.actions.length ? Math.max(...i.actions.map((a) => a.atMs)) : i.detectedMs);
}

/** Stopwatch state `elapsed` ms into a replay that started at wall-clock `startMs`. */
export function replayContain(i: Incident, startMs: number, elapsed: number): ContainState {
  if (elapsed >= replayEndMs(i)) return containReducer(initialContain, { type: "incident", incident: i, source: "replay" });
  const first = i.breaches[0];
  return {
    phase: "running",
    source: "replay",
    incidentId: i.incidentId,
    breachTxId: first?.txId,
    breachTo: first?.to,
    breachAmount: first?.amount,
    startMs,
    ...(elapsed >= i.detectedMs ? { detectedMs: i.detectedMs, plannedSteps: i.actions.length } : {}),
    steps: i.actions.filter((a) => a.atMs <= elapsed).sort((a, b) => a.atMs - b.atMs),
  };
}

/** Pipeline `elapsed` ms into the replay. Captions are prefixed "Replay" so nobody reads it as live. */
export function replayPipeline(i: Incident, startMs: number, elapsed: number, label: (step: string, account?: string, amount?: string) => string): PipelineState {
  const end = replayEndMs(i);
  const breach = pipelineReducer(initialPipeline, { type: "breach", eventMs: startMs, now: startMs });
  const s = (ms: number) => (ms / 1000).toFixed(2);
  if (elapsed >= end) {
    const done = pipelineReducer(breach, { type: "contained", seconds: end / 1000, now: startMs + end });
    return { ...done, caption: `Replay · contained in ${s(end)} s, as recorded on chain` };
  }
  const landed = i.actions.filter((a) => a.atMs <= elapsed).sort((a, b) => a.atMs - b.atMs);
  const last = landed[landed.length - 1];
  const caption = last
    ? `Replay · ${label(last.step, last.account, last.amount)} at ${s(last.atMs)} s`
    : elapsed >= i.detectedMs
      ? `Replay · watcher saw the move with no receipt at ${s(i.detectedMs)} s`
      : "Replay · tokens left the treasury with no receipt";
  return { ...breach, caption };
}
