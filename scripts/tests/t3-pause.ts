// T3: pause is the last step. While paused, freeze/wipe via the controller fail; 2-of-3 unpause reopens.
// Run: npm run t3
import { Log, callController, incidentId, readController, state, waitPause } from "./common.js";
import { toUnits } from "../../src/setup/plan.js";

const log = new Log("T3", "pause behaviour (pause last; 2-of-3 unpause)");

async function main() {
  if ((await waitPause("UNPAUSED", 3000)) !== "UNPAUSED") log.note("note: token started PAUSED");
  const r1 = await callController("watcher", "pauseToken", [incidentId("t3")]);
  log.step("watcher pauseToken()", r1);
  log.check("token PAUSED on the mirror node", (await waitPause("PAUSED")) === "PAUSED", "pause_status");

  const r2 = await callController("watcher", "freezeAccount", [state.payees[0].evm, incidentId("t3-f")], 150_000);
  log.step("freezeAccount while paused fails", r2, false);
  const r3 = await callController("watcher", "wipeAndFreeze", [state.attacker.evm, toUnits(1n, state.token.decimals), incidentId("t3-w")], 200_000);
  log.step("wipeAndFreeze while paused fails", r3, false);
  for (const r of [r2, r3]) if (!r.ok) log.note(`  exact error: ${r.status}${r.error ? " / " + r.error : ""}`);

  const before = (await readController("proposalCount")) as bigint; // read before: eth_call lags
  const p = await callController("admin0", "propose", [1, "0x0000000000000000000000000000000000000000"]);
  log.step("admin0 propose(Unpause)", p);
  const id = before + 1n;
  const a = await callController("admin2", "approve", [id], 900_000); // approve executes unpause: fixed gas
  log.step(`admin2 approve(${id})`, a);
  log.check("token UNPAUSED after 2-of-3", (await waitPause("UNPAUSED")) === "UNPAUSED", "pause_status");
  log.finish();
}

main().catch((e) => {
  log.check("script error", false, String(e?.message ?? e));
  log.finish();
});
