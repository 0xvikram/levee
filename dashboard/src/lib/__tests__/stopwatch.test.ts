import { describe, expect, it } from "vitest";
import { containReducer, elapsedMs, initialContain, stepLabel, type ContainState } from "../stopwatch";
import { consensusToMs, stopwatch } from "../format";
import { BREACH, INCIDENT, INCIDENT_ID } from "./fixtures";

const run = (...a: Parameters<typeof containReducer>[1][]): ContainState => a.reduce(containReducer, initialContain);
const T0 = consensusToMs(BREACH.consensusAt);

describe("containReducer", () => {
  it("starts at the breach movement's consensus time", () => {
    const s = run({ type: "breach", breach: BREACH });
    expect(s.phase).toBe("running");
    expect(s.startMs).toBe(T0);
    expect(elapsedMs(s, T0 + 3210)).toBe(3210);
  });

  it("collects steps in order and stops at the last step", () => {
    const s = run(
      { type: "breach", breach: BREACH },
      { type: "detected", incidentId: INCIDENT_ID, detectedMs: 4193 },
      { type: "plan", incidentId: INCIDENT_ID, steps: [{}, {}] },
      { type: "step", step: { incidentId: INCIDENT_ID, ...INCIDENT.actions[1] } },
      { type: "step", step: { incidentId: INCIDENT_ID, ...INCIDENT.actions[0] } },
    );
    expect(s.steps.map((x) => x.atMs)).toEqual([6444, 8309]);
    expect(s.plannedSteps).toBe(2);
    const done = containReducer(s, { type: "incident", incident: INCIDENT });
    expect(done.phase).toBe("contained");
    expect(done.startMs).toBe(T0);
    expect(elapsedMs(done, T0 + 999_999)).toBe(8309);
    expect(stopwatch(elapsedMs(done, 0))).toBe("8.31");
  });

  it("ignores replayed frames once contained", () => {
    const done = run({ type: "breach", breach: BREACH }, { type: "incident", incident: INCIDENT });
    const again = run({ type: "breach", breach: BREACH }, { type: "incident", incident: INCIDENT }, { type: "breach", breach: BREACH }, { type: "step", step: { incidentId: INCIDENT_ID, ...INCIDENT.actions[0] } });
    expect(again).toEqual(done);
  });

  it("does not start for historic breaches", () => {
    expect(run({ type: "breach", breach: { ...BREACH, historic: true } }).phase).toBe("idle");
  });

  it("loads the last incident from a snapshot, and HCS only when nothing else is known", () => {
    const snap = run({ type: "snapshot", snapshot: { healthy: true, lagMs: 1, matched: 0, receipts: 0, breaches: [BREACH], incidents: [INCIDENT] } });
    expect(snap).toMatchObject({ phase: "contained", source: "watcher", startMs: T0, containedMs: 8309, detectedMs: 4193 });
    expect(containReducer(snap, { type: "hcs-incident", incident: { ...INCIDENT, containedMs: 1 } })).toBe(snap);
    expect(run({ type: "hcs-incident", incident: INCIDENT })).toMatchObject({ phase: "contained", source: "hcs" });
  });

  it("a new breach after a contained incident starts a fresh clock", () => {
    const next = { ...BREACH, txId: "0.0.11333495-1793936000-000000001", consensusAt: "1793936005.500000000" };
    const s = run({ type: "breach", breach: BREACH }, { type: "incident", incident: INCIDENT }, { type: "breach", breach: next });
    expect(s).toMatchObject({ phase: "running", breachTxId: next.txId, steps: [] });
  });
});

describe("stepLabel", () => {
  const ctx = { treasury: "0.0.11333495", fmt: (r: string) => (Number(r) / 1e6).toLocaleString("en-US"), symbol: "RUPC" };
  it("names the treasury freeze and the wipe", () => {
    expect(stepLabel("freezeAccount", "0.0.11333495", undefined, ctx)).toBe("Treasury frozen");
    expect(stepLabel("wipeAndFreeze", "0.0.11333494", "10000000000", ctx)).toBe("10,000 RUPC wiped, receiver frozen");
  });
});
