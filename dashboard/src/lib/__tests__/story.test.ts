import { describe, expect, it } from "vitest";
import { CAPTIONS, initialStory, runError, milestones, proofFromContain, proofFromRun, stepTone, storyCaption, storyReducer, type StoryAction } from "../story";
import { containReducer, initialContain } from "../stopwatch";
import { BREACH, INCIDENT } from "./fixtures";

const run = (...as: StoryAction[]) => as.reduce(storyReducer, initialStory);
const calm = { kind: "calm" };

describe("story", () => {
  it("captions follow the steps in plain words", () => {
    expect(storyCaption(initialStory, calm)).toBe(CAPTIONS.idle);
    expect(storyCaption(run({ type: "start", kind: "pay" }), calm)).toBe(CAPTIONS.send);
    expect(storyCaption(run({ type: "start", kind: "attack" }), calm)).toBe(CAPTIONS.hack);
    expect(storyCaption(run({ type: "start", kind: "mint" }), { kind: "live" })).toBe(CAPTIONS.mint);
    expect(storyCaption(run({ type: "start", kind: "reopen" }), calm)).toBe(CAPTIONS.unlock);
  });
  it("says how fast it was contained, with the real number, and keeps saying it", () => {
    expect(storyCaption(run({ type: "start", kind: "attack" }, { type: "contained", seconds: 8.314 }), { kind: "contained", seconds: 8.314 })).toBe("Frozen and taken back in 8.31 s.");
    // a containment from an earlier step does not leak into the next one
    expect(storyCaption(run({ type: "start", kind: "attack" }, { type: "contained", seconds: 5 }, { type: "start", kind: "mint" }), { kind: "contained", seconds: 5 })).toBe(CAPTIONS.mint);
    const s = run({ type: "start", kind: "attack" }, { type: "contained", seconds: 6.5 }, { type: "finish", kind: "attack", ok: true });
    expect(storyCaption(s, calm)).toBe("Frozen and taken back in 6.50 s.");
    expect(storyCaption(storyReducer(s, { type: "start", kind: "reopen" }), calm)).toBe(CAPTIONS.unlock);
  });
  it("a breach nobody pressed for still reads as a theft, then as contained", () => {
    expect(storyCaption(initialStory, { kind: "live" })).toBe(CAPTIONS.hack);
    expect(storyCaption(initialStory, { kind: "contained", seconds: 7 })).toBe(CAPTIONS.contained(7));
  });
  it("a failed step says so, and the log line shown is the Hedera status", () => {
    const s = run({ type: "start", kind: "mint" }, { type: "finish", kind: "mint", ok: false });
    expect(storyCaption(s, calm)).toBe(CAPTIONS.failed);
    expect(runError(["$ npx tsx x", "r [StatusError]: receipt contained error status CONTRACT_REVERT_EXECUTED", "  status: e { _code: 33 },", "Node.js v24.21.0"])).toBe("CONTRACT_REVERT_EXECUTED");
    expect(runError(["error: demo runner is not running"])).toBe("error: demo runner is not running");
  });
  it("marks steps active, done and failed; reset clears the story", () => {
    let s = run({ type: "start", kind: "pay" });
    expect(stepTone(s, "send")).toBe("active");
    s = run({ type: "start", kind: "pay" }, { type: "finish", kind: "pay", ok: true }, { type: "start", kind: "attack" });
    expect(stepTone(s, "send")).toBe("done");
    expect(stepTone(s, "hack")).toBe("active");
    s = storyReducer(s, { type: "finish", kind: "attack", ok: false });
    expect(stepTone(s, "hack")).toBe("failed");
    s = storyReducer(storyReducer(s, { type: "start", kind: "reset" }), { type: "finish", kind: "reset", ok: true });
    expect(s).toEqual(initialStory);
  });
});

describe("proof links", () => {
  it("labels runner links from the words before the url, or the line above", () => {
    const lines = [
      "gate scheduled the transfer",
      "schedule https://hashscan.io/testnet/schedule/0.0.1",
      "receipt https://hashscan.io/testnet/transaction/0.0.2-1-2",
      "transfer https://hashscan.io/testnet/transaction/0.0.3-1-2",
      "attack: minted 5000 RUPC to attacker 0.0.9 with the stolen CASHIN key",
      "tx https://hashscan.io/testnet/transaction/0.0.4-1-2",
    ];
    const links = lines.map((l) => l.match(/https:\S+/)?.[0]).filter((x): x is string => !!x);
    expect(proofFromRun(lines, links).map((p) => p.label)).toEqual(["Schedule", "Receipt", "Transfer", "Mint"]);
  });
  it("lists the theft, freeze and wipe of a containment", () => {
    const c = containReducer(containReducer(initialContain, { type: "breach", breach: BREACH }), { type: "incident", incident: INCIDENT });
    const p = proofFromContain(c, { hashscanTx: (id) => `hs/${id}`, treasury: "0.0.11333495" });
    expect(p.map((x) => x.label)).toEqual(["Theft (no receipt)", "Freeze treasury", "Wipe (taken back)"]);
    expect(p[0].url).toBe(`hs/${BREACH.txId}`);
    expect(proofFromContain(initialContain, { hashscanTx: (id) => id, treasury: "x" })).toEqual([]);
  });
  it("milestones: detected · treasury frozen · taken back", () => {
    const c = containReducer(initialContain, { type: "incident", incident: INCIDENT });
    expect(milestones(c, "0.0.11333495").map((m) => [m.label, m.ms])).toEqual([
      ["detected", 4193],
      ["treasury frozen", 6444],
      ["taken back", 8309],
    ]);
    expect(milestones(initialContain, "x").every((m) => m.ms === null)).toBe(true);
  });
});
