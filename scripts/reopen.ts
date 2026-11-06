// Demo reset: 2-of-3 admins unfreeze accounts and/or unpause the token via the ContainmentController.
// Usage: npx tsx scripts/reopen.ts treasury attacker [--unpause]
import { Log, reopenAccount, state, waitFreeze } from "./tests/common.js";

const log = new Log("REOPEN", "2-of-3 reopen after a demo incident");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const roleOf = (r: string): { id: string; evm: string } =>
  r.startsWith("payee") ? state.payees[Number(r.slice(5))] : (state as any)[r];

for (const r of args) {
  const acct = roleOf(r);
  if ((await waitFreeze(acct.id, "FROZEN", 2000)) !== "FROZEN") {
    log.note(`${r} ${acct.id} is not frozen, skipping`);
    continue;
  }
  // Use the account's real EVM address (alias) when it has one; the treasury has none.
  const evm = acct.evm && !/^0x0{24}/.test(acct.evm) ? acct.evm : acct.evm;
  const ok = await reopenAccount(evm, log);
  log.check(`${r} unfrozen`, ok && (await waitFreeze(acct.id, "UNFROZEN")) === "UNFROZEN", acct.id);
}
console.log("done");
