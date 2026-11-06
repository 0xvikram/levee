// Treasury token transfer signed by 2 of the 3 treasury keys (treasurySigner + cold), paid by the treasury.
// This is exactly what an attacker holding two keys could do: no gate, no receipt.
import { TokenId, TransferTransaction, TransactionId, Status } from "@hashgraph/sdk";
import { roleKey } from "../../src/shared/hedera.js";
import { env } from "../../src/shared/config.js";
import { normaliseTxId } from "../../src/shared/txid.js";
import { hashscanTx } from "../../src/setup/plan.js";
import type { ExecResult } from "../../src/setup/net.js";
import { state } from "./common.js";
import { AccountId, Client } from "@hashgraph/sdk";

export async function treasuryTransfer(to: string, amount: bigint): Promise<ExecResult & { submittedAt: number }> {
  const client = env.network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  // operator = treasury account; signatures are added explicitly below (2 of 3)
  client.setOperatorWith(AccountId.fromString(state.treasury.id), roleKey("treasurySigner").publicKey, async (msg) =>
    roleKey("treasurySigner").sign(msg),
  );
  const tokenId = TokenId.fromString(state.token.tokenId);
  const tx = new TransferTransaction()
    .addTokenTransfer(tokenId, state.treasury.id, -Number(amount))
    .addTokenTransfer(tokenId, to, Number(amount))
    .setTransactionId(TransactionId.generate(state.treasury.id))
    .freezeWith(client);
  await tx.sign(roleKey("cold"));
  const txId = normaliseTxId(tx.transactionId!.toString());
  const submittedAt = Date.now();
  try {
    const resp = await tx.execute(client);
    const rc = await resp.getReceipt(client);
    return { ok: rc.status === Status.Success, status: rc.status.toString(), txId, link: hashscanTx(txId), gas: 0, submittedAt };
  } catch (e: any) {
    return { ok: false, status: e?.status?.toString?.() ?? String(e?.message ?? e), txId, link: hashscanTx(txId), gas: 0, submittedAt };
  } finally {
    client.close();
  }
}
