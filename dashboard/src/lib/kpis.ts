// KPI strip for /live. Pure: every figure is either read live (Mirror Node or the local watcher)
// or a sourced static label, and the label says which.
import type { FeedRow } from "./feed";
import { formatAmount } from "./format";
import { parseIncidentMessage } from "./mirror";
import type { Incident } from "./types";

export interface Kpi {
  key: string;
  label: string;
  value: string;
  sub?: string;
  tone?: "ok" | "warn" | "breach";
  href?: string;
}

export interface TopicMsg {
  message: string;
  consensus_timestamp: string;
  sequence_number?: number;
}

/** "seconds.nanos" to epoch ms. */
const tsMs = (ts: string) => Number(ts.split(".")[0]) * 1000 + Number((ts.split(".")[1] ?? "0").padEnd(9, "0").slice(0, 3));

/** Local midnight of the day containing `nowMs`. */
export function dayStart(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A contained incident: at least one step, every step ok, and no receiver is one of our own payees (that would be a false alarm). */
export function isContained(i: Incident, payees: string[]): boolean {
  if (!i.breaches.length || !i.actions.length || i.actions.some((a) => !a.ok)) return false;
  return !i.breaches.some((b) => payees.includes(b.to));
}

export function containedSeconds(i: Incident): number {
  return (i.containedMs ?? Math.max(i.detectedMs, ...i.actions.map((a) => a.atMs))) / 1000;
}

export interface IncidentStats {
  total: number | null; // messages on the incidents topic (newest sequence number)
  today: number; // incidents published since local midnight (within the page read)
  lastContainedS: number | null; // newest contained incident (theft or mint)
  lastAt: string | null; // its consensus time
}

/** Incident figures from incidents-topic messages given newest first. */
export function incidentStats(msgs: TopicMsg[], o: { nowMs: number; payees: string[] }): IncidentStats {
  const from = dayStart(o.nowMs);
  let today = 0;
  let lastContainedS: number | null = null;
  let lastAt: string | null = null;
  for (const m of msgs) {
    const i = parseIncidentMessage(m.message);
    if (!i) continue;
    if (tsMs(m.consensus_timestamp) >= from) today++;
    if (lastContainedS === null && isContained(i, o.payees)) {
      lastContainedS = containedSeconds(i);
      lastAt = m.consensus_timestamp;
    }
  }
  const seq = msgs[0]?.sequence_number;
  return { total: typeof seq === "number" ? seq : msgs.length ? msgs.length : null, today, lastContainedS, lastAt };
}

/** Feed rows that matched their receipt since local midnight (chain mode: from Mirror rows). */
export function matchedToday(rows: FeedRow[], nowMs: number): number {
  const from = dayStart(nowMs);
  return rows.filter((r) => r.status === "receipt" && r.consensusAt && tsMs(r.consensusAt) >= from).length;
}

/** Static, sourced figures (docs/LIVE_RUN.md). */
export const STATIC_KPIS = {
  falseAlarms: 0,
  falseAlarmsNote: "since the fix",
  costPerSend: "~0.18 ℏ",
  costNote: "scheduled sends",
};

export interface KpiInputs {
  decimals: number;
  symbol: string;
  treasury: string | null | undefined; // smallest units
  supply: string | null | undefined; // smallest units
  matched: number | null;
  matchedNote: string;
  incidents: IncidentStats | null;
  lagMs: number | null;
  chain: boolean;
  liveSeconds?: number | null; // a containment that just finished on this page (beats the topic read)
}

function whole(raw: string | null | undefined, decimals: number): string {
  if (raw === null || raw === undefined) return "…";
  const s = formatAmount(raw, decimals);
  const [w, f] = s.split(".");
  return f ? `${w}.${f.slice(0, 2)}` : w;
}

export function lagText(ms: number | null): { value: string; tone?: Kpi["tone"] } {
  if (ms === null || !Number.isFinite(ms)) return { value: "–" };
  return { value: `${(ms / 1000).toFixed(1)} s`, tone: ms > 15_000 ? "warn" : "ok" };
}

export function buildKpis(k: KpiInputs): Kpi[] {
  const inc = k.incidents;
  const last = k.liveSeconds ?? inc?.lastContainedS ?? null;
  const lag = k.chain ? { value: "n/a" } : lagText(k.lagMs);
  return [
    { key: "treasury", label: "Treasury", value: whole(k.treasury, k.decimals), sub: `${k.symbol} · Mirror Node` },
    { key: "supply", label: "Total supply", value: whole(k.supply, k.decimals), sub: `${k.symbol} · Mirror Node` },
    { key: "matched", label: "Sends matched", value: k.matched === null ? "…" : String(k.matched), sub: k.matchedNote, tone: "ok" },
    { key: "false", label: "False alarms", value: String(STATIC_KPIS.falseAlarms), sub: STATIC_KPIS.falseAlarmsNote },
    { key: "today", label: "Incidents today", value: inc ? String(inc.today) : "…", sub: "incidents topic" },
    { key: "last", label: "Last containment", value: last === null ? "–" : `${last.toFixed(2)} s`, sub: "theft/mint → taken back", tone: last === null ? undefined : "ok" },
    { key: "total", label: "Incidents", value: inc?.total == null ? "…" : String(inc.total), sub: "all time, on Hedera" },
    { key: "cost", label: "Cost per send", value: STATIC_KPIS.costPerSend, sub: STATIC_KPIS.costNote },
    { key: "lag", label: "Mirror lag", value: lag.value, sub: k.chain ? "watcher is local" : "watcher behind", tone: lag.tone },
  ];
}
