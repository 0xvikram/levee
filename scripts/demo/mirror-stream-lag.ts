// Read-only: compare receipt-style visibility on the Mirror Node's gRPC topic subscription (the SDK's
// TopicMessageQuery) with fresh (cache-busted) REST polling of the same topic, every ~250 ms.
//   npx tsx scripts/demo/mirror-stream-lag.ts [seconds=120] [topicId=0.0.1926]
// For each message: stream arrival - consensus, REST first sight - consensus, and REST - stream.
import { Client, Timestamp, TopicId, TopicMessageQuery } from "@hashgraph/sdk";

const MIRROR = (process.env.MIRROR_URL ?? "https://testnet.mirrornode.hedera.com").replace(/\/$/, "");
const seconds = Number(process.argv[2] ?? "120");
const topic = process.argv[3] ?? "0.0.1926";
const tsMs = (ts: string) => {
  const [s, n = "0"] = ts.split(".");
  return Number(s) * 1000 + Number(n.padEnd(9, "0").slice(0, 3));
};
const key = (t: Timestamp) => `${t.seconds.toString()}.${String(t.nanos.toNumber()).padStart(9, "0")}`;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
const fmt = (xs: number[]) => (xs.length ? `n=${xs.length} p50=${pct(xs, 50)} p90=${pct(xs, 90)} p99=${pct(xs, 99)} max=${Math.max(...xs)}` : "n=0");

async function main() {
  const client = Client.forTestnet(); // no operator: subscriptions are free and need no key
  const stream = new Map<string, number>();
  const rest = new Map<string, number>();
  const start = Date.now();
  const startTs = Timestamp.fromDate(new Date(start));
  const handle = new TopicMessageQuery()
    .setTopicId(TopicId.fromString(topic))
    .setStartTime(startTs)
    .subscribe(client, (_m, e) => console.error("stream error", e?.message), (m) => {
      const k = key(m.consensusTimestamp);
      if (!stream.has(k)) stream.set(k, Date.now());
    });
  let n = 0;
  const startSec = `${Math.floor(start / 1000)}.000000000`;
  while (Date.now() - start < seconds * 1000) {
    const t0 = Date.now();
    try {
      const u = `${MIRROR}/api/v1/topics/${topic}/messages?timestamp=gt:${startSec}&timestamp=lte:${Math.floor(Date.now() / 1000) + 3600}.${String(++n).padStart(9, "0")}&order=desc&limit=50`;
      const j = (await (await fetch(u)).json()) as { messages?: { consensus_timestamp: string }[] };
      const w = Date.now();
      for (const m of j.messages ?? []) if (!rest.has(m.consensus_timestamp)) rest.set(m.consensus_timestamp, w);
    } catch {
      /* skip */
    }
    const wait = 250 - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  handle.unsubscribe();
  client.close();
  const sLag = [...stream].map(([k, w]) => w - tsMs(k));
  const rLag = [...rest].map(([k, w]) => w - tsMs(k));
  const diff = [...stream].filter(([k]) => rest.has(k)).map(([k, w]) => rest.get(k)! - w);
  console.log(`topic ${topic}, ${seconds} s`);
  console.log(`gRPC stream  arrival - consensus ms: ${fmt(sLag)}`);
  console.log(`REST fresh   first sight - consensus ms (250 ms polls): ${fmt(rLag)}`);
  console.log(`REST - stream, same message ms (>0 = stream earlier): ${fmt(diff)}`);
  console.log(`only on stream ${[...stream.keys()].filter((k) => !rest.has(k)).length}, only on REST ${[...rest.keys()].filter((k) => !stream.has(k)).length}`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
