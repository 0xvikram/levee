// T2: wipe order on Hedera. A frozen account cannot be wiped, so the controller wipes first.
//  0. treasury -> attacker 200 RUPC (setup, signed by treasurySigner + cold)
//  1. watcher wipeAndFreeze(attacker, 50)      => succeeds, attacker FROZEN, balance -50
//  2. watcher wipeAndFreeze(attacker, 50) again => fails (wipe on a frozen account)
//  3. watcher wipeFrozen(attacker, 50)          => succeeds, attacker still FROZEN
//  4. cleanup: 2-of-3 unfreeze attacker
// Run: npm run t2
import { Log, callController, incidentId, reopenAccount, state, waitFreeze } from "./common.js";
import { treasuryTransfer } from "./transfer.js";
import { sleep, tokenBalance } from "../../src/setup/net.js";
import { toUnits } from "../../src/setup/plan.js";

const log = new Log("T2", "wipe order (frozen accounts cannot be wiped)");
const attacker = state.attacker;
const amt = toUnits(50n, state.token.decimals);

async function main() {
  if ((await waitFreeze(attacker.id, "UNFROZEN", 3000)) !== "UNFROZEN") {
    log.note("attacker started frozen: reopening first");
    await reopenAccount(attacker.evm, log);
  }
  const t = await treasuryTransfer(attacker.id, toUnits(200n, state.token.decimals));
  log.step("setup: treasury -> attacker 200 RUPC", t);
  await sleep(4000);
  const b0 = await tokenBalance(attacker.id, state.token.tokenId);

  const r1 = await callController("watcher", "wipeAndFreeze", [attacker.evm, amt, incidentId("t2")]);
  log.step("watcher wipeAndFreeze(attacker, 50)", r1);
  log.check("attacker FROZEN", (await waitFreeze(attacker.id, "FROZEN")) === "FROZEN", "after wipeAndFreeze");

  const r2 = await callController("watcher", "wipeAndFreeze", [attacker.evm, amt, incidentId("t2-frozen")], 200_000);
  log.step("wipeAndFreeze on an already FROZEN account fails", r2, false);
  if (!r2.ok) log.note(`  exact error: ${r2.status}${r2.error ? " / " + r2.error : ""}`);

  const r3 = await callController("watcher", "wipeFrozen", [attacker.evm, amt, incidentId("t2-wf")]);
  log.step("watcher wipeFrozen(attacker, 50)", r3);
  log.check("attacker still FROZEN after wipeFrozen", (await waitFreeze(attacker.id, "FROZEN")) === "FROZEN", "unfreeze/wipe/freeze in one tx");
  await sleep(4000);
  const b1 = await tokenBalance(attacker.id, state.token.tokenId);
  log.check("attacker balance dropped by 100 RUPC (2 wipes)", b0 - b1 === 2n * amt, `before ${b0}, after ${b1} (smallest units)`);

  const ok = await reopenAccount(attacker.evm, log);
  log.check("cleanup: attacker UNFROZEN", ok && (await waitFreeze(attacker.id, "UNFROZEN")) === "UNFROZEN", "2-of-3 unfreeze");
  log.finish();
}

main().catch((e) => {
  log.check("script error", false, String(e?.message ?? e));
  log.finish();
});
