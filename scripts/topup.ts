// Top up setup accounts from the operator. Usage: npx tsx scripts/topup.ts admin0=3 admin1=3 watcher=3
import { Hbar, TransferTransaction, AccountId } from "@hashgraph/sdk";
import { env, readState } from "../src/shared/config.js";
import { operatorClient } from "../src/shared/hedera.js";

const state: any = readState();
const pairs = process.argv.slice(2).map((a) => a.split("="));
const lookup = (role: string) =>
  role.startsWith("admin") ? state.admins[Number(role.slice(5))] : role.startsWith("payee") ? state.payees[Number(role.slice(5))] : state[role];
const client = operatorClient();
const tx = new TransferTransaction();
let total = 0;
for (const [role, amt] of pairs) {
  const acct = lookup(role);
  if (!acct?.id) throw new Error(`unknown role ${role}`);
  tx.addHbarTransfer(acct.id, new Hbar(Number(amt)));
  total += Number(amt);
}
tx.addHbarTransfer(AccountId.fromString(env.operatorId), new Hbar(-total));
const r = await tx.execute(client);
const rc = await r.getReceipt(client);
console.log(`topped up ${pairs.map((p) => p.join("=")).join(", ")}: ${rc.status} https://hashscan.io/testnet/transaction/${r.transactionId}`);
client.close();
