// Create the issuer signer's own fee-paying account (idempotent). Run: npm run setup:signer [hbar=1]
// The treasury signer key is key-only in the original setup (part of the treasury's 2-of-3), so it had
// no account to pay for a ScheduleSign. This makes one whose key IS that treasury-signer key, so a
// single signature both pays for the ScheduleSign and adds the treasury signature to the schedule.
// Paid by the operator; the account id goes to state/deploy.json as issuerSigner. No key is created,
// printed or written: it reuses the existing treasurySigner key via roleKey().
import { AccountCreateTransaction, Hbar } from "@hashgraph/sdk";
import { readState, writeState } from "../shared/config.js";
import { longZero, operatorClient, roleKey } from "../shared/hedera.js";
import { normaliseTxId } from "../shared/txid.js";
import { SIGNER_ROLE } from "./server.js";

const state = readState();
if (state.issuerSigner) {
  console.log(`issuerSigner already exists: ${state.issuerSigner.id}`);
  process.exit(0);
}
const hbar = Number(process.argv[2] ?? "1");
const client = operatorClient();
const pub = roleKey(SIGNER_ROLE).publicKey;
const resp = await new AccountCreateTransaction().setKeyWithoutAlias(pub).setInitialBalance(new Hbar(hbar)).setAccountMemo("Levee issuer signer").execute(client);
const rec = await resp.getReceipt(client);
const id = rec.accountId!.toString();
writeState({ issuerSigner: { id, evm: longZero(id) } });
console.log(`created issuerSigner ${id} with ${hbar} HBAR  https://hashscan.io/testnet/transaction/${normaliseTxId(resp.transactionId.toString())}`);
client.close();
