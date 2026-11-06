// Prints which setup steps are done and the operator balance. Run: npm run setup:status
import { env } from "../shared/config.js";
import { operatorClient } from "../shared/hedera.js";
import { hbarBalance } from "./net.js";
import { missingSteps } from "./plan.js";
import { loadState } from "./state.js";

const s = loadState();
const missing = missingSteps(s);
const client = operatorClient();
const bal = await hbarBalance(client, env.operatorId);
client.close();
console.log(`operator ${env.operatorId}: ${bal.toFixed(3)} HBAR`);
console.log(missing.length ? `to do: ${missing.join(", ")}` : "all setup steps done");
