// Creates the HCS topics (idempotent). Run: npm run setup:topics
//   receipts   submitKey = gate key     (gate writes 'approved' receipts BEFORE each transfer)
//   incidents  submitKey = watcher key  (watcher writes breach + containment reports)
//   heartbeats submitKey = watcher key  (watcher liveness)
import { TopicCreateTransaction } from "@hashgraph/sdk";
import { env, writeState } from "../shared/config.js";
import { operatorClient, roleKey } from "../shared/hedera.js";
import { normaliseTxId } from "../shared/txid.js";
import { estimateTopics, hashscanTx, shortfall, sumCost } from "./plan.js";
import { hbarBalance } from "./net.js";
import { loadState } from "./state.js";

const SPEC = [
  { name: "receipts", memo: "Levee receipts: gate approvals before treasury moves", submitRole: "gate" },
  { name: "incidents", memo: "Levee incidents: breaches and containment", submitRole: "watcher" },
  { name: "heartbeats", memo: "Levee watcher heartbeats", submitRole: "watcher" },
] as const;

async function main() {
  const client = operatorClient();
  const state = loadState();
  const topics: Record<string, string> = { ...(state.topics ?? {}) };
  const missing = SPEC.filter((s) => !topics[s.name]);
  const balance = await hbarBalance(client, env.operatorId);
  const need = sumCost(estimateTopics(missing.length));
  console.log(`operator balance ${balance.toFixed(3)} HBAR; ${missing.length} topic(s) to create, est. ${need} HBAR`);
  if (shortfall(balance, need) > 0) {
    console.error(`ABORT: short by ${shortfall(balance, need)} HBAR`);
    process.exit(2);
  }
  for (const s of missing) {
    const submitKey = roleKey(s.submitRole).publicKey; // throws if accounts step not run
    const resp = await new TopicCreateTransaction().setTopicMemo(s.memo).setSubmitKey(submitKey).execute(client);
    const rec = await resp.getReceipt(client);
    topics[s.name] = rec.topicId!.toString();
    writeState({ topics: topics as any });
    console.log(`created topic ${s.name.padEnd(10)} ${topics[s.name]}  ${hashscanTx(normaliseTxId(resp.transactionId.toString()))}`);
  }
  if (!missing.length) console.log("all topics exist:", topics);
  client.close();
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
