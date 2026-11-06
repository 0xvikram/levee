// Issuer signer service (port 8715): holds ONLY the issuer's treasury-signer key (key 1 of the treasury's
// 2-of-3). The gate schedules each approved transfer with its own key (key 2) and tells this service the
// schedule id; this service independently finds the matching receipt on Hedera (Mirror Node) and only
// then adds the second signature with ScheduleSign, which makes Hedera execute the transfer.
//   npm run signer          (needs state/deploy.json issuerSigner: npm run setup:signer)
// Env: SIGNER_PORT (8715), SIGNER_RECEIPT_WAIT_S (60), SIGNER_POLL_S (10; 0 = notifications only).
import { pathToFileURL } from "node:url";
import { ScheduleId, ScheduleSignTransaction, Status, TransactionId, TransactionReceiptQuery } from "@hashgraph/sdk";
import { env, readState } from "../shared/config.js";
import { roleClient } from "../shared/hedera.js";
import { MirrorClient } from "../shared/mirror.js";
import { normaliseTxId } from "../shared/txid.js";
import { rulesFromState } from "../gate/decide.js";
import { createSigner, type SignResult } from "./service.js";

export const SIGNER_ROLE = process.env.TREASURY_SIGNER_ROLE ?? "treasurySigner";

/** Mirror spelling 0.0.x-sec-nanos -> SDK TransactionId of the scheduled execution (…?scheduled). */
export function scheduledSdkTxId(mirrorTxId: string): TransactionId {
  const m = /^(\d+\.\d+\.\d+)-(\d+)-(\d{9})$/.exec(mirrorTxId);
  if (!m) throw new Error(`bad transaction id ${mirrorTxId}`);
  return TransactionId.fromString(`${m[1]}@${m[2]}.${m[3]}`).setScheduled(true);
}

async function main() {
  const state = readState();
  if (!state.issuerSigner) throw new Error("state/deploy.json has no issuerSigner account: run npm run setup:signer first");
  for (const k of ["treasury", "gate", "token", "topics", "payees"] as const) {
    if (!state[k]) throw new Error(`state/deploy.json has no ${k}: finish setup first`);
  }
  // The only key this process loads: the treasury signer's. It also pays for its own ScheduleSign.
  const client = roleClient(SIGNER_ROLE, state.issuerSigner.id);
  const mirror = new MirrorClient({ cacheBust: true });
  const rules = rulesFromState(state, env);

  async function sign(scheduleId: string, scheduledTxId: string): Promise<SignResult> {
    const tx = new ScheduleSignTransaction().setScheduleId(ScheduleId.fromString(scheduleId)).freezeWith(client);
    const resp = await tx.execute(client);
    const rec = await resp.getReceipt(client);
    if (rec.status !== Status.Success) throw new Error(`ScheduleSign status ${rec.status.toString()}`);
    let executedStatus: string | undefined;
    try {
      const inner = await new TransactionReceiptQuery().setTransactionId(scheduledSdkTxId(scheduledTxId)).execute(client);
      executedStatus = inner.status.toString();
    } catch (e) {
      executedStatus = `unknown (${(e as Error).message.slice(0, 120)})`;
    }
    return { status: rec.status.toString(), signTxId: normaliseTxId(resp.transactionId.toString()), executedStatus };
  }

  const signer = createSigner({
    mirror,
    rules,
    gateAccount: state.gate.id,
    receiptsTopic: state.topics.receipts,
    sign,
    receiptWaitMs: Number(process.env.SIGNER_RECEIPT_WAIT_S ?? "60") * 1000,
    log: (l) => console.log(`${new Date().toISOString()} ${l}`),
  });
  await signer.refreshReceipts();
  const pollS = Number(process.env.SIGNER_POLL_S ?? "10");
  if (pollS > 0) {
    const poll = () => signer.pollOnce().catch((e) => console.log(`poll failed: ${(e as Error).message}`));
    setTimeout(poll, 2000);
    setInterval(poll, pollS * 1000);
  }
  signer.app.listen(env.signerPort, "127.0.0.1", () => {
    console.log(
      `issuer signer listening on 127.0.0.1:${env.signerPort}: key ${SIGNER_ROLE} only, pays from ${state.issuerSigner!.id}; signs schedules from the gate ${state.gate.id} only with a matching receipt on ${state.topics.receipts} (${signer.receipts.length} receipts read); polling every ${pollS} s`,
    );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("issuer signer failed to start:", (e as Error).message);
    process.exit(1);
  });
}
