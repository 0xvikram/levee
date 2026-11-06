// T1: the controller really holds the Studio roles, and its access rules hold.
//  1. watcher -> controller.freezeAccount(payee1)       => succeeds, payee1 FROZEN
//  2. gate (not watcher, not admin) -> freezeAccount    => reverts NotWatcherOrAdmin
//  3. admin0 propose(Unfreeze, payee1), admin1 approve  => payee1 UNFROZEN
// Run: npm run t1
import { Log, callController, incidentId, reopenAccount, state, waitFreeze } from "./common.js";

const log = new Log("T1", "controller holds the roles (freeze by watcher, 2-of-3 unfreeze)");
const payee1 = state.payees[1];

async function main() {
  const before = await waitFreeze(payee1.id, "UNFROZEN", 3000);
  if (before !== "UNFROZEN") log.note(`note: payee1 started as ${before}`);

  const r1 = await callController("watcher", "freezeAccount", [payee1.evm, incidentId("t1")]);
  log.step("watcher freezeAccount(payee1)", r1);
  log.check("payee1 is FROZEN on the mirror node", (await waitFreeze(payee1.id, "FROZEN")) === "FROZEN", `status ${await waitFreeze(payee1.id, "FROZEN", 1)}`);

  const r2 = await callController("gate", "freezeAccount", [state.payees[0].evm, incidentId("t1-bad")], 120_000);
  log.step("gate (non-watcher, non-admin) freezeAccount(payee0) reverts", r2, false);
  if (!r2.ok) log.check("revert reason is NotWatcherOrAdmin", (r2.error ?? "").includes("NotWatcherOrAdmin"), r2.error ?? "no reason");

  const ok = await reopenAccount(payee1.evm, log);
  log.check("payee1 is UNFROZEN after 2-of-3", ok && (await waitFreeze(payee1.id, "UNFROZEN")) === "UNFROZEN", `status ${await waitFreeze(payee1.id, "UNFROZEN", 1)}`);
  log.finish();
}

main().catch((e) => {
  log.check("script error", false, String(e?.message ?? e));
  log.finish();
});
