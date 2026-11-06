// Mirror Node reads for the /live command centre (no keys, works on the hosted site too):
// treasury balance + total supply every 3 s for the live chart, and the incidents topic for KPIs.
import { useEffect, useState } from "react";
import { MIRROR, deploy } from "./config";
import { type TopicMsg } from "./kpis";
import { tokenRelation, type TokenRelation } from "./mirror";
import { accountDeltas, POLL_MS, pushPoint, seedBackward, WINDOW_MS, type Pt } from "./series";

export interface LiveSeries {
  treasury: Pt[];
  supply: Pt[];
  treasuryRel: TokenRelation | null; // newest read (balance in smallest units + freeze status)
  supplyRaw: string | null; // newest total supply, smallest units
  seeded: boolean;
}

const whole = (raw: string | null) => (raw === null ? null : Number(raw) / 10 ** deploy.token.decimals);

async function json<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout?.(6000) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

export async function fetchSupply(): Promise<string | null> {
  const j = await json<{ total_supply?: string | number }>(`${MIRROR}/api/v1/tokens/${deploy.token.tokenId}`);
  return j?.total_supply === undefined ? null : String(j.total_supply);
}

/** Seed the treasury line from the last WINDOW_MS of treasury transactions (Mirror). */
async function seedTreasury(current: number, nowMs: number): Promise<Pt[] | null> {
  const since = Math.floor((nowMs - WINDOW_MS) / 1000);
  const j = await json<{ transactions?: { consensus_timestamp: string; result: string; token_transfers?: { token_id: string; account: string; amount: number | string }[] }[] }>(
    `${MIRROR}/api/v1/transactions?account.id=${deploy.treasury}&timestamp=gte:${since}.0&order=desc&limit=100`,
  );
  if (!j) return null;
  return seedBackward(current, accountDeltas(j.transactions ?? [], { token: deploy.token.tokenId, account: deploy.treasury, decimals: deploy.token.decimals }), nowMs);
}

export function useLiveSeries(everyMs = POLL_MS): LiveSeries {
  const [s, setS] = useState<LiveSeries>({ treasury: [], supply: [], treasuryRel: null, supplyRaw: null, seeded: false });
  useEffect(() => {
    let alive = true;
    let seeding = false;
    let seeded = false;
    let inFlight = false;
    const run = async () => {
      if (inFlight || (typeof document !== "undefined" && document.hidden)) return;
      inFlight = true;
      const [rel, sup] = await Promise.all([tokenRelation(deploy.treasury).catch(() => null), fetchSupply()]);
      inFlight = false;
      if (!alive) return;
      const t = Date.now();
      const tv = rel?.balance != null ? whole(rel.balance) : null;
      setS((p) => ({
        ...p,
        treasury: pushPoint(p.treasury, { t, v: tv }),
        supply: pushPoint(p.supply, { t, v: whole(sup) }),
        treasuryRel: rel?.balance != null ? rel : p.treasuryRel,
        supplyRaw: sup ?? p.supplyRaw,
      }));
      if (!seeded && !seeding && tv !== null) {
        seeding = true;
        const seed = await seedTreasury(tv, t);
        seeding = false;
        if (!alive || !seed) return;
        seeded = true;
        setS((p) => {
          let buf = seed.filter((x) => x.t < (p.treasury[0]?.t ?? Infinity));
          for (const x of p.treasury) buf = pushPoint(buf, x);
          // supply has no cheap history on the Mirror Node: its line starts when the page opened
          return { ...p, treasury: buf, seeded: true };
        });
      }
    };
    run();
    const id = setInterval(run, everyMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [everyMs]);
  return s;
}

/** Newest page of the incidents topic, refreshed every `everyMs`. */
export function useIncidentTopic(everyMs = 10_000): TopicMsg[] | null {
  const [msgs, setMsgs] = useState<TopicMsg[] | null>(null);
  useEffect(() => {
    let alive = true;
    const run = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      const j = await json<{ messages?: TopicMsg[] }>(`${MIRROR}/api/v1/topics/${deploy.topics.incidents}/messages?order=desc&limit=100`);
      if (alive && j) setMsgs(j.messages ?? []);
    };
    run();
    const id = setInterval(run, everyMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [everyMs]);
  return msgs;
}
