// Live normal path + three refusals, against a running demo (scripts/demo/up.sh).
//   1. payouts-server asks for 500 RUPC to payee0 -> gate schedules it (gate key) -> receipt on HCS
//      -> issuer signer finds the receipt, adds the 2nd signature -> Hedera executes -> watcher "matched"
//   2. laptop-vikram asks for 500 RUPC to payee0  -> refused (wrong-role: an employee laptop, or no live pass)
// Every request is signed with the asking machine's own key (lib.ts gateRequest).
//   3. payouts-server asks for CAP+1 RUPC          -> refused (over-transfer-cap)
//   4. payouts-server asks for 500 RUPC to an unknown account -> refused (unknown-destination)
// Writes state/live-normal-path-<ts>.json. Usage: npx tsx scripts/demo/normal-path.ts
import fs from "node:fs";
import { env } from "../../src/shared/config.js";
import { CHECKER, WATCHER, gateRequest, getJson, hashscanSchedule, hashscanTopic, hashscanTx, state, subscribe, units, type SseFrame } from "./lib.js";

const SERVER = "payouts-server";
const LAPTOP = "laptop-vikram";
const payee0 = state.payees[0].id;

const matched = new Map<string, number>();
const breaches: SseFrame[] = [];
const sub = subscribe(`${WATCHER}/events`, (f) => {
  if (f.event === "matched") matched.set(f.data.txId, f.receivedAt);
  if (f.event === "breach") breaches.push(f);
});
await sub.ready;
const startSec = Date.now() / 1000;

const out: Record<string, unknown> = { at: new Date().toISOString(), caps: { perTransfer: env.capPerTransfer.toString(), perDay: env.capPerDay.toString() } };
out.passes = { [SERVER]: await getJson(`${CHECKER}/pass/${SERVER}`), [LAPTOP]: await getJson(`${CHECKER}/pass/${LAPTOP}`) };

// 1. normal path
const r1 = await gateRequest(SERVER, payee0, units(500));
console.log(`1. ${SERVER} 500 RUPC -> payee0 ${payee0}: HTTP ${r1.status} in ${r1.ms} ms`, r1.body.ok ? "" : r1.body);
let matchedMs: number | null = null;
if (r1.body.ok && r1.body.txId) {
  const tGate = Date.now();
  for (let i = 0; i < 120 && !matched.has(r1.body.txId); i++) await new Promise((r) => setTimeout(r, 250));
  matchedMs = matched.has(r1.body.txId) ? matched.get(r1.body.txId)! - tGate : null;
  console.log(`   schedule        ${hashscanSchedule(r1.body.scheduleId!)}`);
  console.log(`   receipt seq ${r1.body.receipt?.sequence}  ${hashscanTx(r1.body.receiptTxId!)}`);
  console.log(`   signer sign     ${hashscanTx(r1.body.signTxId!)}`);
  console.log(`   transfer        ${hashscanTx(r1.body.txId)}`);
  console.log(`   timings ${JSON.stringify(r1.body.timings)}; watcher matched ${matchedMs === null ? "NOT within 30 s" : `${matchedMs} ms after the gate replied`}`);
}
out.normal = { reply: r1, matchedAfterGateMs: matchedMs, links: r1.body.ok ? { schedule: hashscanSchedule(r1.body.scheduleId!), receipt: hashscanTx(r1.body.receiptTxId!), signerSign: hashscanTx(r1.body.signTxId!), transfer: hashscanTx(r1.body.txId!), topic: hashscanTopic(state.topics.receipts) } : null };

// 2-4. refusals
const refusals: [string, string, string, string][] = [
  ["laptop", LAPTOP, payee0, units(500)],
  ["over-cap", SERVER, payee0, units(env.capPerTransfer + 1n)],
  ["unknown-destination", SERVER, state.attacker.id, units(500)],
];
const refused: Record<string, unknown> = {};
for (const [name, machine, to, amount] of refusals) {
  const r = await gateRequest(machine, to, amount);
  console.log(`${name}: ${machine} -> ${to} ${amount}: HTTP ${r.status} ${r.body.reason}: ${r.body.detail} (${r.ms} ms)`);
  refused[name] = r;
}
out.refusals = refused;
await new Promise((r) => setTimeout(r, 3000));
const newBreaches = breaches.filter((b) => Number(b.data.consensusAt) >= startSec);
out.breachesDuringRun = newBreaches.map((b) => b.data);
out.watcherState = await getJson(`${WATCHER}/state`);
sub.stop();
const file = `state/live-normal-path-${Date.now()}.json`;
fs.writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`breaches during run: ${newBreaches.length}; saved ${file}`);
const okAll = r1.body.ok && matchedMs !== null && Object.values(refused).every((r: any) => r.status === 403) && newBreaches.length === 0;
console.log(okAll ? "NORMAL PATH: PASS" : "NORMAL PATH: FAIL");
process.exit(okAll ? 0 : 1);
