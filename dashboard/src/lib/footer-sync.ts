// Footer fireflies, synced to live payments. Pure logic only (canvas drawing is in
// components/FooterScene.tsx):
//   - watcher SSE event -> firefly spawn, with the same 60 s replay filter as lib/pipeline.ts
//     (the SSE hub replays its last 50 frames on every (re)connect)
//   - colour mood: idle (yellow) -> breach (breach-lit red, fast flicker) -> contained
//     (olive-lit, CONTAINED_HOLD_MS) -> idle
//   - Mirror Node receipts-topic sequence diffing for the fallback when the SSE is not open
//   - the swarm itself: spawn with a cap, ambient drift, step
import { FRESH_MS } from "./pipeline";
import { consensusToMs } from "./format";

export { FRESH_MS };
export const CONTAINED_HOLD_MS = 20_000;
/** A breach whose incident never arrives (watcher died mid-containment) stops glowing red after this. */
export const BREACH_MAX_MS = 120_000;
export const CAP_WIDE = 60;
export const CAP_NARROW = 30;
export const NARROW_PX = 640;
/** At most this many fireflies per receipts poll, so a long gap never dumps a burst. */
export const MAX_POLL_BURST = 3;

export const capFor = (widthPx: number) => (widthPx <= NARROW_PX ? CAP_NARROW : CAP_WIDE);
export const ambientFor = (widthPx: number) => (widthPx <= NARROW_PX ? 5 : 8);

export const isFresh = (eventMs: number, now: number) => Number.isFinite(eventMs) && now - eventMs <= FRESH_MS;

/** One firefly per matched payment, unless it is a replayed frame older than FRESH_MS. */
export function spawnsFor(event: string, data: unknown, now: number): number {
  if (event !== "matched") return 0;
  const at = (data as { consensusAt?: unknown } | null)?.consensusAt;
  if (typeof at !== "string") return 0;
  return isFresh(consensusToMs(at), now) ? 1 : 0;
}

// ---------------------------------------------------------------- mood

export type Mood = { kind: "idle" } | { kind: "breach"; since: number } | { kind: "contained"; since: number };
export const idleMood: Mood = { kind: "idle" };

export type MoodAction =
  | { type: "breach"; eventMs: number; now: number; historic?: boolean }
  | { type: "contained"; now: number }
  | { type: "tick"; now: number };

export function moodReducer(m: Mood, a: MoodAction): Mood {
  switch (a.type) {
    case "breach":
      if (a.historic || !isFresh(a.eventMs, a.now)) return m;
      return m.kind === "breach" ? m : { kind: "breach", since: a.now };
    case "contained":
      // only a live breach can be contained; a replayed incident never flips the colour
      return m.kind === "breach" ? { kind: "contained", since: a.now } : m;
    case "tick":
      if (m.kind === "contained" && a.now - m.since >= CONTAINED_HOLD_MS) return idleMood;
      if (m.kind === "breach" && a.now - m.since >= BREACH_MAX_MS) return idleMood;
      return m;
  }
}

/** Map a watcher SSE frame to a mood action (null if it does not affect the colour). */
export function moodActionFor(event: string, data: unknown, now: number): MoodAction | null {
  if (event === "breach") {
    const b = data as { consensusAt?: unknown; historic?: unknown } | null;
    if (typeof b?.consensusAt !== "string") return null;
    return { type: "breach", eventMs: consensusToMs(b.consensusAt), now, historic: b.historic === true };
  }
  if (event === "incident") return { type: "contained", now };
  return null;
}

/** Mood holder that schedules its own return to idle (setTimeout, so fake timers can drive it). */
export class MoodClock {
  mood: Mood = idleMood;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private onChange: (m: Mood) => void = () => undefined,
    private now: () => number = Date.now,
  ) {}

  dispatch(a: MoodAction | null): Mood {
    if (!a) return this.mood;
    const next = moodReducer(this.mood, a);
    if (next !== this.mood) {
      this.mood = next;
      this.schedule();
      this.onChange(next);
    }
    return this.mood;
  }

  handle(event: string, data: unknown): Mood {
    return this.dispatch(moodActionFor(event, data, this.now()));
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const m = this.mood;
    if (m.kind === "idle") return;
    const wait = m.kind === "contained" ? CONTAINED_HOLD_MS : BREACH_MAX_MS;
    this.timer = setTimeout(() => this.dispatch({ type: "tick", now: m.since + wait }), wait);
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export const MOOD_RGB: Record<Mood["kind"], [number, number, number]> = {
  idle: [0xf2, 0xe3, 0x4c], // --yellow
  breach: [0xf0, 0x8c, 0x74], // --breach-lit
  contained: [0xb6, 0xc3, 0x83], // --olive-lit
};
/** flicker speed, radians per second */
export const MOOD_FLICKER: Record<Mood["kind"], number> = { idle: 1.6, breach: 9, contained: 2.4 };

// ---------------------------------------------------------------- receipts fallback

/**
 * New receipts since the last poll. First load (`last` null) only seeds the cursor: no burst.
 * Returns the new cursor and how many fireflies to emit (capped at MAX_POLL_BURST).
 */
export function diffReceiptSeqs(last: number | null, seqs: number[]): { last: number | null; emit: number } {
  const valid = seqs.filter((s) => Number.isInteger(s) && s >= 0);
  if (!valid.length) return { last, emit: 0 };
  const max = Math.max(...valid);
  if (last === null) return { last: max, emit: 0 };
  const fresh = valid.filter((s) => s > last).length;
  return { last: Math.max(last, max), emit: Math.min(fresh, MAX_POLL_BURST) };
}

// ---------------------------------------------------------------- swarm

/** Positions are normalised to the canvas (0..1). Speeds are per second. */
export interface Fly {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number; // radius, CSS px
  phase: number;
  age: number; // seconds
  ambient: boolean;
}

export type Rand = () => number;

export function makeAmbient(rnd: Rand): Fly {
  return { x: rnd(), y: 0.15 + rnd() * 0.8, vx: (rnd() - 0.5) * 0.02, vy: (rnd() - 0.5) * 0.02, r: 1.4 + rnd() * 1.4, phase: rnd() * Math.PI * 2, age: rnd() * 10, ambient: true };
}

export function makePayment(rnd: Rand): Fly {
  return { x: 0.06 + rnd() * 0.88, y: 1.03, vx: (rnd() - 0.5) * 0.03, vy: -(0.07 + rnd() * 0.05), r: 2 + rnd() * 1.6, phase: rnd() * Math.PI * 2, age: 0, ambient: false };
}

/**
 * Add one payment firefly, keeping the total at or under `cap`: the oldest payment firefly is
 * dropped first; ambient ones stay so the footer is never empty.
 */
export function addFly(flies: Fly[], fly: Fly, cap: number): Fly[] {
  const out = flies.slice();
  while (out.length >= cap) {
    const i = out.findIndex((f) => !f.ambient);
    if (i === -1) return out.slice(0, cap); // only ambient left: no room
    out.splice(i, 1);
  }
  out.push(fly);
  return out;
}

/** Bring the ambient count to `n` (adds or trims). */
export function ensureAmbient(flies: Fly[], n: number, rnd: Rand): Fly[] {
  const amb = flies.filter((f) => f.ambient).length;
  if (amb === n) return flies;
  if (amb < n) return [...flies, ...Array.from({ length: n - amb }, () => makeAmbient(rnd))];
  let drop = amb - n;
  return flies.filter((f) => !(f.ambient && drop-- > 0));
}

/** Advance the swarm by `dt` seconds (mutates for the hot loop). Payment flies leave off the top. */
export function stepFlies(flies: Fly[], dt: number, rnd: Rand): Fly[] {
  const d = Math.min(dt, 0.1);
  for (const f of flies) {
    f.age += d;
    if (f.ambient) {
      f.vx += (rnd() - 0.5) * 0.02 * d;
      f.vy += (rnd() - 0.5) * 0.02 * d;
      f.vx = Math.max(-0.02, Math.min(0.02, f.vx));
      f.vy = Math.max(-0.015, Math.min(0.015, f.vy));
      f.x += f.vx * d;
      f.y += f.vy * d;
      if (f.x < -0.02) f.x = 1.02;
      if (f.x > 1.02) f.x = -0.02;
      if ((f.y < 0.1 && f.vy < 0) || (f.y > 1 && f.vy > 0)) f.vy = -f.vy;
    } else {
      f.x += (f.vx + Math.sin(f.age * 1.3 + f.phase) * 0.012) * d;
      f.y += f.vy * d;
    }
  }
  return flies.filter((f) => f.ambient || f.y > -0.05);
}
