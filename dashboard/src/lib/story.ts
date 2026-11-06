// The demo story on /live: four steps driven by the demo runner, a plain-words caption for each,
// the proof links (with QR codes) for the latest step, and the stopwatch milestones. Pure.
import type { RunKind } from "./runner";
import type { ContainState } from "./stopwatch";
import type { IncidentAction } from "./types";

export type StepId = "send" | "hack" | "mint" | "unlock";

export const STORY: { id: StepId; kind: RunKind; n: string; label: string; sub: string; primary?: boolean }[] = [
  { id: "send", kind: "pay", n: "①", label: "Send 500 to Asha Pay", sub: "a normal payment" },
  { id: "hack", kind: "attack", n: "②", label: "Hack it", sub: "Simulate theft", primary: true },
  { id: "mint", kind: "mint", n: "③", label: "Fake mint", sub: "print tokens with a stolen key", primary: true },
  { id: "unlock", kind: "reopen", n: "④", label: "Unlock (2 of 3)", sub: "two managers sign" },
];

export const stepOf = (kind: RunKind): StepId | null => STORY.find((s) => s.kind === kind)?.id ?? null;

export interface StoryState {
  last: StepId | null; // the step the story is on
  running: boolean;
  done: StepId[];
  failed: StepId | null;
  containedS: number | null; // set when the hack / mint step was contained
}

export type StoryAction = { type: "start"; kind: RunKind } | { type: "finish"; kind: RunKind; ok: boolean } | { type: "contained"; seconds: number } | { type: "reset" };

export const initialStory: StoryState = { last: null, running: false, done: [], failed: null, containedS: null };

export function storyReducer(s: StoryState, a: StoryAction): StoryState {
  switch (a.type) {
    case "start": {
      if (a.kind === "reset") return { ...initialStory, running: true };
      const id = stepOf(a.kind);
      return id ? { ...s, last: id, running: true, failed: null, containedS: null } : s;
    }
    case "finish": {
      if (a.kind === "reset") return a.ok ? initialStory : { ...s, running: false };
      const id = stepOf(a.kind);
      if (!id) return { ...s, running: false };
      return { ...s, running: false, done: a.ok && !s.done.includes(id) ? [...s.done, id] : s.done, failed: a.ok ? null : id };
    }
    case "contained":
      return s.last === "hack" || s.last === "mint" ? { ...s, containedS: a.seconds } : s;
    case "reset":
      return initialStory;
  }
}

export const CAPTIONS = {
  idle: "Every token that leaves needs a receipt on Hedera first.",
  send: "Normal payment: receipt first, then the money. ✓",
  hack: "Stolen keys, no receipt. Watch the clock.",
  mint: "Fake tokens printed with a stolen key. Watch the supply.",
  unlock: "Only 2 of 3 managers together can unlock.",
  contained: (s: number) => `Frozen and taken back in ${s.toFixed(2)} s.`,
};

/**
 * The big caption. A containment that has just finished on the page (breach banner "contained")
 * wins; otherwise the current step's line; a hack/mint step that was contained keeps saying so.
 */
export function storyCaption(s: StoryState, breach: { kind: string; seconds?: number }): string {
  if (breach.kind === "contained" && typeof breach.seconds === "number" && s.last !== "send" && s.last !== "unlock") return CAPTIONS.contained(breach.seconds);
  if (breach.kind === "live" && s.last !== "mint") return CAPTIONS.hack;
  if (!s.last) return CAPTIONS.idle;
  if ((s.last === "hack" || s.last === "mint") && s.containedS !== null) return CAPTIONS.contained(s.containedS);
  return CAPTIONS[s.last];
}

export type StepTone = "idle" | "active" | "done" | "failed";
export function stepTone(s: StoryState, id: StepId): StepTone {
  if (s.last === id && s.running) return "active";
  if (s.failed === id) return "failed";
  if (s.last === id) return "active";
  return s.done.includes(id) ? "done" : "idle";
}

// ------------------------------------------------------------------ proof links

export interface ProofLink {
  label: string;
  url: string;
}

const WORDS: [RegExp, string][] = [
  [/\bmint/i, "Mint"],
  [/\bpropos/i, "Propose"],
  [/\bapprov/i, "Approve"],
  [/\bunfreez|\breopen/i, "Unfreeze"],
  [/\bwipe|clawed|taken back/i, "Wipe"],
  [/\bfreez/i, "Freeze"],
  [/\breceipt/i, "Receipt"],
  [/\bsignature/i, "2nd signature"],
  [/\bschedule/i, "Schedule"],
  [/\battack|\bstolen|treasury -> attacker/i, "Theft transfer"],
  [/\btransfer/i, "Transfer"],
];

function classify(text: string): string | null {
  for (const [re, label] of WORDS) if (re.test(text)) return label;
  return null;
}

/**
 * Label each HashScan link a run printed. The runner logs "receipt <url>", "transfer <url>", or a
 * description line followed by "tx <url>": the words before the url win, else the line above.
 */
export function proofFromRun(lines: string[], links: string[]): ProofLink[] {
  return links.map((url) => {
    const i = lines.findIndex((l) => l.includes(url));
    const before = i >= 0 ? lines[i].slice(0, lines[i].indexOf(url)) : "";
    const label = classify(before) ?? (i > 0 ? classify(lines[i - 1]) : null) ?? (/\/schedule\//.test(url) ? "Schedule" : /\/topic\//.test(url) ? "Topic" : "Transaction");
    return { label, url };
  });
}

/** The containment's own links: the move with no receipt, then each step that landed. */
export function proofFromContain(c: ContainState, o: { hashscanTx: (id: string) => string; treasury: string; mint?: boolean }): ProofLink[] {
  if (c.phase === "idle") return [];
  const out: ProofLink[] = [];
  if (c.breachTxId) out.push({ label: o.mint ? "Mint (no receipt)" : "Theft (no receipt)", url: o.hashscanTx(c.breachTxId) });
  for (const a of c.steps) {
    if (!a.txId) continue;
    out.push({ label: stepProofLabel(a, o.treasury), url: o.hashscanTx(a.txId) });
  }
  return out;
}

function stepProofLabel(a: IncidentAction, treasury: string): string {
  if (a.step === "freezeAccount") return a.account === treasury ? "Freeze treasury" : "Freeze account";
  if (a.step === "wipeAndFreeze" || a.step === "wipeFrozen") return "Wipe (taken back)";
  if (a.step === "burnSupply") return "Burn";
  if (a.step === "pauseToken") return "Pause";
  return a.step;
}

export function dedupeLinks(xs: ProofLink[]): ProofLink[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true)));
}

// ------------------------------------------------------------------ stopwatch milestones

export interface Milestone {
  key: "detected" | "frozen" | "back";
  label: string;
  ms: number | null;
}

/** detected · treasury frozen · taken back, with the times they landed (null until they do). */
export function milestones(c: ContainState, treasury: string): Milestone[] {
  const freeze = c.steps.find((a) => a.step === "freezeAccount" && a.account === treasury) ?? c.steps.find((a) => a.step === "freezeAccount");
  const wipes = c.steps.filter((a) => a.step === "wipeAndFreeze" || a.step === "wipeFrozen" || a.step === "burnSupply");
  return [
    { key: "detected", label: "detected", ms: c.detectedMs ?? null },
    { key: "frozen", label: freeze && freeze.account !== treasury ? "account frozen" : "treasury frozen", ms: freeze ? freeze.atMs : null },
    { key: "back", label: "taken back", ms: wipes.length ? wipes[wipes.length - 1].atMs : null },
  ];
}
