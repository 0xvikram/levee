// False-alarm test: N legitimate, gate-approved transfers while the watcher runs, then assert
// the watcher matched every one and raised zero breaches.
//   npx tsx scripts/demo/normal-load.ts [N=100] [--seed 1] [--min 10] [--max 900] [--machine payouts-server]
// The demo must be up (scripts/demo/up.sh) with a daily cap that fits the run; the script reads the
// gate's caps and today's spend from GET /health and refuses to start if the plan would not fit,
// printing the CAP_PER_DAY to restart with. Writes state/normal-load-<N>-<ts>.json.
import fs from "node:fs";
import { hbarBalances } from "./balances.js";
import { dailyCapNeeded, planLoad, totalOf } from "./load-plan.js";
import { GATE, WATCHER, gateRequest, getJson, hashscanTx, sleep, state, subscribe, type SseFrame } from "./lib.js";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const N = Number(argv.find((a) => /^\d+$/.test(a)) ?? "100");
const machine = opt("machine", "payouts-server");
const scale = 10n ** BigInt(state.token.decimals);

const health = await getJson(`${GATE}/health`);
const capPerTransferWhole = BigInt(health.capPerTransfer) / scale;
const plan = planLoad({ n: N, payees: state.payees.map((p) => p.id), decimals: state.token.decimals, capPerTransfer: capPerTransferWhole, minWhole: Number(opt("min", "10")), maxWhole: Number(opt("max", "900")), seed: Number(opt("seed", "1")) });
const need = dailyCapNeeded(plan, BigInt(health.spentToday), state.token.decimals);
const capDayWhole = BigInt(health.capPerDay) / scale;
console.log(`plan: ${N} transfers, total ${totalOf(plan) / scale} RUPC; gate spent today ${BigInt(health.spentToday) / scale} RUPC; daily cap ${capDayWhole} RUPC (needs >= ${need})`);
if (need > capDayWhole) {
  console.error(`daily cap too small for this run: restart the demo with CAP_PER_DAY=${need} or more (scripts/demo/down.sh; CAP_PER_DAY=${need} scripts/demo/up.sh)`);
  process.exit(2);
}

const matched = new Map<string, number>();
const breaches: SseFrame[] = [];
const incidents: SseFrame[] = [];
const sub = subscribe(`${WATCHER}/events`, (f) => {
  if (f.event === "matched") matched.set(f.data.txId, f.receivedAt);
  if (f.event === "breach") breaches.push(f);
  if (f.event === "incident" || f.event === "detected") incidents.push(f);
});
await sub.ready;
const before = await getJson(`${WATCHER}/state`);
const hbarBefore = await hbarBalances();
const startSec = Date.now() / 1000;
const t0 = Date.now();

const sent: { i: number; to: string; amount: string; txId?: string; status: number; ms: number; reason?: string; gateDoneAt: number }[] = [];
for (const p of plan) {
  let r;
  try {
    r = await gateRequest(machine, p.to, p.amount.toString());
  } catch (e) {
    sent.push({ i: p.i, to: p.to, amount: p.amount.toString(), status: 0, ms: 0, reason: (e as Error).message, gateDoneAt: Date.now() });
    continue;
  }
  sent.push({ i: p.i, to: p.to, amount: p.amount.toString(), txId: r.body.txId, status: r.status, ms: r.ms, reason: r.body.ok ? undefined : `${r.body.reason}: ${r.body.detail}`, gateDoneAt: Date.now() });
  if (!r.body.ok) console.log(`  #${p.i} refused/failed: HTTP ${r.status} ${r.body.reason}: ${r.body.detail}`);
  if ((p.i + 1) % 10 === 0) console.log(`  ${p.i + 1}/${N} sent, ${matched.size} matched so far, ${breaches.filter((b) => Number(b.data.consensusAt) >= startSec).length} breaches (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
const approved = sent.filter((s) => s.status === 200 && s.txId);
const sendDoneMs = Date.now() - t0;

// wait for the watcher to catch up on the last ones
for (let i = 0; i < 240 && approved.some((s) => !matched.has(s.txId!)); i++) await sleep(250);
await sleep(3000); // and give any late breach a chance to show up
const after = await getJson(`${WATCHER}/state`);
sub.stop();
const hbarAfter = await hbarBalances();

const runBreaches = breaches.filter((b) => Number(b.data.consensusAt) >= startSec).map((b) => b.data);
const lat = approved.filter((s) => matched.has(s.txId!)).map((s) => matched.get(s.txId!)! - s.gateDoneAt).sort((a, b) => a - b);
const pct = (q: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : null);
const gateMs = approved.map((s) => s.ms).sort((a, b) => a - b);
const spent = Object.fromEntries(Object.keys(hbarBefore).map((k) => [k, +(hbarBefore[k] - hbarAfter[k]).toFixed(4)]));
const result = {
  at: new Date().toISOString(),
  N,
  machine,
  seed: Number(opt("seed", "1")),
  approved: approved.length,
  refusedOrFailed: sent.length - approved.length,
  matchedViaSse: approved.filter((s) => matched.has(s.txId!)).length,
  watcherMatchedDelta: after.matched - before.matched,
  breaches: runBreaches.length,
  watcherBreachDelta: after.breaches.length - before.breaches.length,
  incidentsDelta: after.incidents.length - before.incidents.length,
  lateReceiptMatches: (after.lateReceiptMatches ?? 0) - (before.lateReceiptMatches ?? 0), // matched only thanks to the receipt grace

  totalRupc: (totalOf(plan) / scale).toString(),
  durationS: +((Date.now() - t0) / 1000).toFixed(1),
  sendPhaseS: +(sendDoneMs / 1000).toFixed(1),
  gateLatencyMs: { p50: gateMs[Math.floor(gateMs.length / 2)] ?? null, max: gateMs[gateMs.length - 1] ?? null },
  matchLatencyAfterGateMs: { p50: pct(0.5), p95: pct(0.95), max: lat[lat.length - 1] ?? null },
  hbarSpent: spent,
  hbarSpentTotal: +Object.values(spent).reduce((a, b) => a + b, 0).toFixed(4),
  caps: { capPerTransfer: health.capPerTransfer, capPerDay: health.capPerDay },
  firstTx: approved[0]?.txId ? hashscanTx(approved[0].txId) : null,
  lastTx: approved.at(-1)?.txId ? hashscanTx(approved.at(-1)!.txId!) : null,
  breachDetails: runBreaches,
  failures: sent.filter((s) => s.status !== 200),
  unmatched: approved.filter((s) => !matched.has(s.txId!)).map((s) => s.txId),
};
const file = `state/normal-load-${N}-${Date.now()}.json`;
fs.writeFileSync(file, JSON.stringify({ ...result, sent }, null, 2));
const { sent: _s, breachDetails, failures, unmatched, ...summary } = { ...result, sent };
console.log(JSON.stringify(summary, null, 2));
const pass = approved.length === N && result.matchedViaSse === N && result.watcherMatchedDelta === N && result.breaches === 0 && result.incidentsDelta === 0;
console.log(`${pass ? "PASS" : "FAIL"}: N=${N} matched=${result.watcherMatchedDelta} breaches=${result.breaches} (saved ${file})`);
if (!pass) console.log(JSON.stringify({ breachDetails, failures: failures.slice(0, 5), unmatched: unmatched.slice(0, 5) }, null, 2));
process.exit(pass ? 0 : 1);
