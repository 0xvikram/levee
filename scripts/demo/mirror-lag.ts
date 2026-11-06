// Read-only probe of how stale public Mirror Node REST answers are, used to design the watcher's
// receipt-hold logic. No keys, no state, no writes: plain GETs against the public testnet Mirror.
//
//   npx tsx scripts/demo/mirror-lag.ts [seconds=90] [topicId=<busiest topic in the last 100 txs>]
//
// Every ~250 ms it fires, in parallel:
//   blocks/cached   GET /blocks?order=desc&limit=1                 (same URL every time: CDN-cacheable)
//   blocks/fresh    same, plus a unique timestamp=lte:<future>     (cache-busted)
//   topic/cached    GET /topics/T/messages?order=desc&limit=1
//   topic/fresh     same, cache-busted
//   txs/fresh       GET /transactions?order=desc&limit=100 (cache-busted) -> first sight of T's submits
// and reports, per series: staleness (response wall time - newest consensus in it), how often an answer
// went BACKWARDS versus an earlier answer of the same series (replica/cache regressions), the CDN `age`
// header, and, per topic message, how much later it became visible on the topic endpoint than its
// CONSENSUSSUBMITMESSAGE became visible on the transactions endpoint.
const MIRROR = (process.env.MIRROR_URL ?? "https://testnet.mirrornode.hedera.com").replace(/\/$/, "");
const seconds = Number(process.argv[2] ?? "90");
let topic = process.argv[3] ?? "";

const tsMs = (ts: string) => {
  const [s, n = "0"] = ts.split(".");
  return Number(s) * 1000 + Number(n.padEnd(9, "0").slice(0, 3));
};
const cmpTs = (a: string, b: string) => {
  const [as, an = "0"] = a.split(".");
  const [bs, bn = "0"] = b.split(".");
  return Number(as) - Number(bs) || Number(an.padEnd(9, "0")) - Number(bn.padEnd(9, "0"));
};
let bust = 0;
const fresh = () => `&timestamp=lte:${Math.floor(Date.now() / 1000) + 3600}.${String(++bust).padStart(9, "0")}`;

interface Sample { wall: number; ts: string | null; age: number | null; cluster: string | null; ms: number }
async function get(path: string): Promise<{ j: any; s: Omit<Sample, "ts"> }> {
  const t0 = Date.now();
  const r = await fetch(MIRROR + path, { signal: AbortSignal.timeout(8000) });
  const j = r.ok ? await r.json() : null;
  const wall = Date.now();
  const age = r.headers.get("age");
  return { j, s: { wall, age: age === null ? null : Number(age), cluster: r.headers.get("x-cluster-id"), ms: wall - t0 } };
}

const series: Record<string, Sample[]> = { "blocks/cached": [], "blocks/fresh": [], "topic/cached": [], "topic/fresh": [], "txs/fresh": [] };
const topicFirstSeen = new Map<string, number>(); // consensus ts -> wall
const txFirstSeen = new Map<string, number>();

async function round() {
  const tasks: Promise<void>[] = [];
  const add = (name: string, path: string, pick: (j: any) => string | null, onJson?: (j: any, wall: number) => void) =>
    tasks.push(
      get(path)
        .then(({ j, s }) => {
          series[name].push({ ...s, ts: j ? pick(j) : null });
          if (j && onJson) onJson(j, s.wall);
        })
        .catch(() => undefined),
    );
  const blk = (j: any) => j.blocks?.[0]?.timestamp?.to ?? null;
  const msg = (j: any) => j.messages?.[0]?.consensus_timestamp ?? null;
  add("blocks/cached", "/api/v1/blocks?order=desc&limit=1", blk);
  add("blocks/fresh", "/api/v1/blocks?order=desc&limit=1" + fresh(), blk);
  add("topic/cached", `/api/v1/topics/${topic}/messages?order=desc&limit=1`, msg, (j, w) => {
    for (const m of j.messages ?? []) if (!topicFirstSeen.has(m.consensus_timestamp)) topicFirstSeen.set(m.consensus_timestamp, w);
  });
  add("topic/fresh", `/api/v1/topics/${topic}/messages?order=desc&limit=25` + fresh(), msg, (j, w) => {
    for (const m of j.messages ?? []) if (!topicFirstSeen.has(m.consensus_timestamp)) topicFirstSeen.set(m.consensus_timestamp, w);
  });
  add("txs/fresh", "/api/v1/transactions?order=desc&limit=100" + fresh(), (j) => j.transactions?.[0]?.consensus_timestamp ?? null, (j, w) => {
    for (const t of j.transactions ?? [])
      if (t.name === "CONSENSUSSUBMITMESSAGE" && t.entity_id === topic && !txFirstSeen.has(t.consensus_timestamp)) txFirstSeen.set(t.consensus_timestamp, w);
  });
  await Promise.all(tasks);
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (xs: number[]) => `n=${xs.length} p50=${pct(xs, 50)} p90=${pct(xs, 90)} p99=${pct(xs, 99)} max=${Math.max(...xs)}`;

async function main() {
  if (!topic) {
    const r = await get("/api/v1/transactions?order=desc&limit=100&transactiontype=CONSENSUSSUBMITMESSAGE");
    const counts = new Map<string, number>();
    for (const t of r.j?.transactions ?? []) counts.set(t.entity_id, (counts.get(t.entity_id) ?? 0) + 1);
    topic = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "0.0.11333501";
  }
  console.log(`probing ${MIRROR} for ${seconds} s, busy topic ${topic}`);
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const t0 = Date.now();
    await round();
    const wait = 250 - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  for (const [name, xs] of Object.entries(series)) {
    const ok = xs.filter((x) => x.ts);
    const stale = ok.map((x) => x.wall - tsMs(x.ts!));
    let max = "0.0";
    let back = 0;
    const backBy: number[] = [];
    for (const x of ok) {
      if (cmpTs(x.ts!, max) < 0) {
        back++;
        backBy.push(tsMs(max) - tsMs(x.ts!));
      } else max = x.ts!;
    }
    const ages = ok.map((x) => x.age).filter((a): a is number => a !== null);
    const clusters = new Set(ok.map((x) => x.cluster));
    console.log(`${name.padEnd(14)} staleness ms ${fmt(stale)} | went backwards ${back}/${ok.length}${backBy.length ? ` by ${fmt(backBy)}` : ""} | age hdr present ${ages.length} (max ${ages.length ? Math.max(...ages) : "-"}) | clusters ${[...clusters].join(",")} | rtt p50 ${pct(ok.map((x) => x.ms), 50)}`);
  }
  const gaps: number[] = [];
  for (const [ts, w] of txFirstSeen) {
    const tw = topicFirstSeen.get(ts);
    if (tw !== undefined) gaps.push(tw - w);
  }
  console.log(`topic-endpoint visibility minus transactions-endpoint visibility, same message (ms; >0 = topic later): ${gaps.length ? fmt(gaps) : "no overlap"}`);
  const negOnly = gaps.filter((g) => g > 0);
  console.log(`  messages seen later on the topic endpoint: ${negOnly.length}/${gaps.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
