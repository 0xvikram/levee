// Demo attack: a stolen 2-of-3 treasury key pair (treasurySigner + cold) drains RUPC to the attacker
// WITHOUT going through the gate, so no receipt exists. Usage: npx tsx scripts/attack.ts [amount=10000]
import { readState } from "../src/shared/config.js";
import { treasuryTransfer } from "./tests/transfer.js";
import { toUnits } from "../src/setup/plan.js";

const state: any = readState();
const amount = BigInt(process.argv[2] ?? "10000");
const t0 = Date.now();
const r = await treasuryTransfer(state.attacker.id, toUnits(amount, state.token.decimals));
console.log(`attack: ${amount} RUPC treasury -> attacker ${state.attacker.id}: ${r.status} (${Date.now() - t0} ms)`);
console.log(`tx https://hashscan.io/testnet/transaction/${r.txId ?? ""}`);
