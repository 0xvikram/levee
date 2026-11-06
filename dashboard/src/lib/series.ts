// Live chart for /live: treasury balance and total supply over the last few minutes, polled from
// the Mirror Node. Pure: ring buffer, gaps (a failed poll is a null point that breaks the line),
// y scaling, SVG path building, a backward seed from recent treasury transfers, and chart events.

export interface Pt {
  t: number; // epoch ms
  v: number | null; // whole tokens; null = gap (poll failed)
}

export const WINDOW_MS = 8 * 60_000;
export const POLL_MS = 3_000;
export const CAP = Math.ceil(WINDOW_MS / POLL_MS) + 40;

/** Add a point, keep time order, drop points older than the window (relative to the newest), cap the length. */
export function pushPoint(buf: Pt[], p: Pt, o: { windowMs?: number; cap?: number } = {}): Pt[] {
  const windowMs = o.windowMs ?? WINDOW_MS;
  const cap = o.cap ?? CAP;
  let out: Pt[];
  const last = buf[buf.length - 1];
  if (!last || p.t > last.t) out = [...buf, p];
  else if (p.t === last.t) out = [...buf.slice(0, -1), p];
  else {
    out = [...buf, p].sort((a, b) => a.t - b.t);
  }
  const newest = out[out.length - 1].t;
  out = out.filter((x) => x.t >= newest - windowMs);
  return out.length > cap ? out.slice(out.length - cap) : out;
}

/** y domain of the non-null values with a little padding; a flat line gets a small band around it. */
export function domain(points: Pt[], padFrac = 0.12): [number, number] | null {
  const vs = points.map((p) => p.v).filter((v): v is number => v !== null && Number.isFinite(v));
  if (!vs.length) return null;
  let lo = Math.min(...vs);
  let hi = Math.max(...vs);
  const minSpan = Math.max(Math.abs(hi) * 0.002, 1);
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  const pad = (hi - lo) * padFrac;
  return [lo - pad, hi + pad];
}

export interface Scale {
  x: (t: number) => number;
  y: (v: number) => number;
}

/** Linear scale: time t0..t1 to 0..width, value lo..hi to height..0 (SVG y grows down). */
export function scale(o: { t0: number; t1: number; lo: number; hi: number; width: number; height: number; padX?: number; padY?: number }): Scale {
  const px = o.padX ?? 0;
  const py = o.padY ?? 0;
  const tw = Math.max(1, o.t1 - o.t0);
  const vh = o.hi - o.lo || 1;
  return {
    x: (t) => px + ((t - o.t0) / tw) * (o.width - 2 * px),
    y: (v) => py + (1 - (v - o.lo) / vh) * (o.height - 2 * py),
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * SVG path for a stepped line (balances change in steps, not slopes). A null point ends the
 * current run; the next value starts a new "M". A lone point draws a short tick so it is visible.
 */
export function toPath(points: Pt[], s: Scale): string {
  const parts: string[] = [];
  let run: Pt[] = [];
  const flush = () => {
    if (run.length === 1) {
      const p = run[0];
      parts.push(`M${r1(s.x(p.t) - 2)} ${r1(s.y(p.v!))}H${r1(s.x(p.t) + 2)}`);
    } else if (run.length > 1) {
      let d = `M${r1(s.x(run[0].t))} ${r1(s.y(run[0].v!))}`;
      for (let i = 1; i < run.length; i++) d += `H${r1(s.x(run[i].t))}V${r1(s.y(run[i].v!))}`;
      parts.push(d);
    }
    run = [];
  };
  for (const p of points) {
    if (p.v === null || !Number.isFinite(p.v)) flush();
    else run.push(p);
  }
  flush();
  return parts.join("");
}

// ------------------------------------------------------------------ seed from Mirror history

export interface Delta {
  t: number; // epoch ms
  d: number; // whole tokens, signed change for the account
}

interface MirrorTxLike {
  consensus_timestamp: string;
  result: string;
  token_transfers?: { token_id: string; account: string; amount: number | string }[];
}

/** Net change of `account` in `token` per successful Mirror transaction record, newest first. */
export function accountDeltas(txs: MirrorTxLike[], o: { token: string; account: string; decimals: number }): Delta[] {
  const out: Delta[] = [];
  for (const tx of txs) {
    if (tx.result !== "SUCCESS") continue;
    let sum = 0n;
    for (const tt of tx.token_transfers ?? []) {
      if (tt.token_id !== o.token || tt.account !== o.account) continue;
      sum += BigInt(typeof tt.amount === "number" ? Math.trunc(tt.amount) : tt.amount);
    }
    if (sum === 0n) continue;
    const [s, n = "0"] = tx.consensus_timestamp.split(".");
    out.push({ t: Number(s) * 1000 + Math.floor(Number(n.padEnd(9, "0").slice(0, 3))), d: Number(sum) / 10 ** o.decimals });
  }
  return out.sort((a, b) => b.t - a.t);
}

/**
 * Rebuild the line backwards from the current value: before each change (newest first) the
 * value was current minus that change. Returns points oldest first, from now - windowMs to now.
 */
export function seedBackward(current: number, deltas: Delta[], nowMs: number, windowMs = WINDOW_MS): Pt[] {
  const from = nowMs - windowMs;
  const pts: Pt[] = [{ t: nowMs, v: current }];
  let v = current;
  for (const x of [...deltas].sort((a, b) => b.t - a.t)) {
    if (x.t > nowMs) continue;
    if (x.t < from) break;
    pts.push({ t: x.t, v }); // value from this change onwards
    v -= x.d;
    pts.push({ t: x.t - 1, v }); // value just before it
  }
  pts.push({ t: from, v });
  return pts.sort((a, b) => a.t - b.t);
}

// ------------------------------------------------------------------ events on the chart

export type ChartEventKind = "send" | "theft" | "mint" | "unlock" | "reset";
export interface ChartEvent {
  t: number;
  kind: ChartEventKind;
}
export const EVENT_LABEL: Record<ChartEventKind, string> = { send: "send", theft: "theft", mint: "mint", unlock: "unlock", reset: "reset" };

/** Events inside [t0, t1], oldest first, with repeats of the same kind within `minGapMs` merged. */
export function visibleEvents(events: ChartEvent[], t0: number, t1: number, minGapMs = 20_000): ChartEvent[] {
  const inside = events.filter((e) => e.t >= t0 && e.t <= t1).sort((a, b) => a.t - b.t);
  const out: ChartEvent[] = [];
  for (const e of inside) {
    const prev = [...out].reverse().find((x) => x.kind === e.kind);
    if (prev && e.t - prev.t < minGapMs) continue;
    out.push(e);
  }
  return out;
}

/** Compact whole-token label: 967,484.8 -> "967,485"; 12.5 -> "12.5". */
export function axisLabel(v: number): string {
  const abs = Math.abs(v);
  return v.toLocaleString("en-US", { maximumFractionDigits: abs >= 1000 ? 0 : 2 });
}

/**
 * A mint and its wipe land a few seconds apart, often between two 3 s polls, so the supply line
 * may never see the jump. Draw it from the incident itself: supply was `amount` higher from the
 * mint's consensus time until the wipe. Points already showing the raised value are left alone.
 */
export function withSpike(points: Pt[], spike: { from: number; to: number; amount: number }): Pt[] {
  if (!(spike.to > spike.from) || !points.length) return points;
  const before = [...points].reverse().find((p) => p.t <= spike.from && p.v !== null);
  if (!before || before.v === null) return points;
  const base = before.v;
  const up = base + spike.amount;
  const kept = points.filter((p) => p.t < spike.from || p.t > spike.to || (p.v !== null && Math.abs(p.v - up) < 1e-6));
  return [...kept, { t: spike.from, v: up }, { t: spike.to - 1, v: up }, { t: spike.to, v: base }].sort((a, b) => a.t - b.t);
}
