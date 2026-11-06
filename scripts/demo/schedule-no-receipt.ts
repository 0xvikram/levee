// Proof that the issuer signer never signs without a receipt. Plays someone holding the gate key who
// skips the gate: ScheduleCreate a treasury transfer (500 RUPC to Asha Pay, a known recipient, under the
// caps) signed with the gate key, and write NO receipt. The gate is not told; the issuer signer finds the
// schedule on its own Mirror poll, finds no receipt, refuses, and the schedule expires unexecuted.
//   npx tsx scripts/demo/schedule-no-receipt.ts [ttlSeconds=120]
// Needs the issuer signer running (scripts/demo/up.sh). Writes state/schedule-no-receipt-<ts>.json.
import fs from "node:fs";
import { Status } from "@hashgraph/sdk";
import { buildScheduleCreate } from "../../src/gate/server.js";
import { roleClient, roleKey } from "../../src/shared/hedera.js";
import { MirrorClient } from "../../src/shared/mirror.js";
import { normaliseTxId } from "../../src/shared/txid.js";
import { SIGNER, getJson, hashscanSchedule, hashscanTx, sleep, state, units } from "./lib.js";

const ttl = Number(process.argv[2] ?? "120");
const client = roleClient("gate", state.gate.id);
const mirror = new MirrorClient();
const tx = await buildScheduleCreate(state, { machine: "no-receipt-test", to: state.payees[0].id, amount: units(500), kind: "transfer" }, { nowMs: Date.now(), ttlS: ttl })
  .freezeWith(client)
  .sign(roleKey("gate"));
const resp = await tx.execute(client);
const rec = await resp.getReceipt(client);
if (rec.status !== Status.Success || !rec.scheduleId) throw new Error(`ScheduleCreate ${rec.status}`);
const scheduleId = rec.scheduleId.toString();
const scheduledTxId = normaliseTxId(resp.transactionId.toString());
const createdAt = Date.now();
console.log(`schedule ${scheduleId} created with the gate key only, no receipt: ${hashscanSchedule(scheduleId)}`);
console.log(`  would execute as ${scheduledTxId}; expires in ${ttl} s`);

// 1. the signer finds it on its own poll and refuses (no notification sent)
let refusal: any = null;
for (let i = 0; i < 60 && !refusal; i++) {
  await sleep(2000);
  const d = await getJson(`${SIGNER}/decisions`);
  refusal = d.decisions.find((x: any) => x.scheduleId === scheduleId) ?? null;
}
console.log(refusal ? `issuer signer: ${refusal.ok ? "SIGNED (unexpected!)" : `refused: ${refusal.reason}: ${refusal.detail}`} after ${((Date.now() - createdAt) / 1000).toFixed(0)} s` : "issuer signer: no decision seen");

// 2. the schedule expires without executing
const expiresMs = createdAt + ttl * 1000;
while (Date.now() < expiresMs + 15_000) await sleep(5000);
const s = await mirror.schedule(scheduleId);
const executed = await mirror.transactionById(scheduledTxId);
const ran = executed.filter((t) => t.scheduled);
console.log(`after expiry: executed_timestamp=${s?.executed_timestamp ?? "null"} expiration_time=${s?.expiration_time} deleted=${s?.deleted}; scheduled executions on the Mirror: ${ran.length}`);
const out = { at: new Date().toISOString(), scheduleId, scheduledTxId, createTx: hashscanTx(scheduledTxId), schedule: hashscanSchedule(scheduleId), refusal, mirrorSchedule: s, scheduledExecutions: ran.length };
const file = `state/schedule-no-receipt-${Date.now()}.json`;
fs.writeFileSync(file, JSON.stringify(out, null, 2));
const pass = refusal && !refusal.ok && !s?.executed_timestamp && ran.length === 0;
console.log(`${pass ? "PASS" : "FAIL"}: signer refused and the schedule never executed (saved ${file})`);
client.close();
process.exit(pass ? 0 : 1);
