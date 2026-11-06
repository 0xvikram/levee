// Live Arkiv smoke test: create -> read -> extend -> revoke one throwaway pass. Needs tGLM in the checker wallet.
// Run: npm run arkiv:smoke   (exits early, writing nothing, when the balance is 0)
import { ArkivPassStore } from "../shared/arkiv.js";

const s = new ArkivPassStore();
const bal = await s.balance();
console.log(`checker wallet ${s.checkerAddress}  balance ${bal} wei  block age ${(await s.latestBlockAge())?.toFixed(1)}s`);
if (bal === 0n) {
  console.log("balance is 0 tGLM: fund the wallet at https://hub.arkiv.network/faucet, then rerun. Nothing written.");
  process.exit(0);
}
const machine = `smoke-${Date.now().toString(36)}`;
const t0 = Date.now();
const rec = await s.upsertPass({ machine, role: "smoke", postureHash: "0".repeat(64), status: "live" }, 180);
console.log(`created ${rec.entityKey} in ${Date.now() - t0} ms, expires ${new Date(rec.expiresAtMs).toISOString()}`);
console.log(`owner is checker: ${rec.owner.toLowerCase() === s.checkerAddress.toLowerCase()}`);
const t1 = Date.now();
const ext = await s.extendPass(machine, 240);
console.log(`extended in ${Date.now() - t1} ms, expires ${ext && new Date(ext.expiresAtMs).toISOString()}`);
console.log(`revoked: ${await s.revokePass(machine)}`);
await s.flush();
console.log(`after revoke getPass -> ${JSON.stringify(await s.getPass(machine))}`);
