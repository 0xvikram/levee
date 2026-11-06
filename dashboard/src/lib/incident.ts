// The containment run shown on the landing page: the newest GENUINE incident on the incidents
// topic, read live from the Mirror Node. "Genuine" = every step succeeded, the treasury was
// frozen, tokens were wiped, and no receiver is one of our own payees (a payee receiver means a
// false alarm on a normal payment, which the page must never advertise). Falls back to MEASURED.
import { useEffect, useState } from "react";
import { MEASURED, MIRROR, deploy } from "./config";
import { parseIncidentMessage } from "./mirror";
import type { Incident } from "./types";

export interface Showcase {
  date: string;
  detectionS: number;
  treasuryFrozenS: number;
  wipedS: number;
  wipedAmount: string; // display, whole tokens, e.g. "10,000"
  wipedValue: number; // whole tokens, for the count-up
  attackTx: string;
  freezeTx: string;
  wipeTx: string;
  live: boolean; // true when read from the chain, false for the built-in fallback
}

export const FALLBACK_SHOWCASE: Showcase = {
  ...MEASURED,
  wipedValue: Number(MEASURED.wipedAmount.replace(/,/g, "")),
  live: false,
};

export interface TopicMessage {
  message: string; // base64
  consensus_timestamp: string; // "seconds.nanos"
}

const WIPES = new Set(["wipeAndFreeze", "wipeFrozen"]);

export function formatDate(consensus: string): string {
  const d = new Date(Number(consensus.split(".")[0]) * 1000);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function toWhole(smallest: string, decimals: number): number {
  return Number(BigInt(smallest)) / 10 ** decimals;
}

/** Turn one incident into a showcase, or null if it is not a genuine, fully contained theft. */
export function showcaseFrom(i: Incident, consensus: string, o: { treasury: string; payees: string[]; decimals: number }): Showcase | null {
  if (!i.breaches.length || !i.actions.length || i.actions.some((a) => !a.ok)) return null;
  if (i.breaches.some((b) => o.payees.includes(b.to))) return null; // false alarm on a normal payment
  const freeze = i.actions.find((a) => a.step === "freezeAccount" && a.account === o.treasury && a.txId);
  const wipes = i.actions.filter((a) => WIPES.has(a.step) && a.txId && a.amount);
  if (!freeze || !wipes.length) return null;
  const last = wipes[wipes.length - 1];
  const wipedValue = wipes.reduce((s, a) => s + toWhole(a.amount!, o.decimals), 0);
  return {
    date: formatDate(consensus),
    detectionS: i.detectedMs / 1000,
    treasuryFrozenS: freeze.atMs / 1000,
    wipedS: last.atMs / 1000,
    wipedAmount: wipedValue.toLocaleString("en-US", { maximumFractionDigits: 2 }),
    wipedValue,
    attackTx: i.breaches[0].txId,
    freezeTx: freeze.txId!,
    wipeTx: last.txId!,
    live: true,
  };
}

/** Newest genuine incident among topic messages given newest first. */
export function pickShowcase(msgs: TopicMessage[], o: { treasury: string; payees: string[]; decimals: number }): Showcase | null {
  for (const m of msgs) {
    const i = parseIncidentMessage(m.message);
    const s = i && showcaseFrom(i, m.consensus_timestamp, o);
    if (s) return s;
  }
  return null;
}

/** The newest genuine incident itself (same rule as pickShowcase), for the /live chain-mode replay. */
export function pickGenuineIncident(msgs: TopicMessage[], o: { treasury: string; payees: string[]; decimals: number }): { incident: Incident; consensusAt: string } | null {
  for (const m of msgs) {
    const i = parseIncidentMessage(m.message);
    if (i && showcaseFrom(i, m.consensus_timestamp, o)) return { incident: i, consensusAt: m.consensus_timestamp };
  }
  return null;
}

export async function fetchShowcase(timeoutMs = 6000): Promise<Showcase | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${MIRROR}/api/v1/topics/${deploy.topics.incidents}/messages?order=desc&limit=25`, { signal: ctl.signal });
    if (!r.ok) return null;
    const j = (await r.json()) as { messages?: TopicMessage[] };
    return pickShowcase(j.messages ?? [], { treasury: deploy.treasury, payees: deploy.payees, decimals: deploy.token.decimals });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Starts with the fallback, swaps in the live run once the Mirror Node answers. */
export function useShowcase(): Showcase {
  const [s, setS] = useState<Showcase>(FALLBACK_SHOWCASE);
  useEffect(() => {
    let alive = true;
    fetchShowcase().then((live) => alive && live && setS(live));
    return () => {
      alive = false;
    };
  }, []);
  return s;
}
