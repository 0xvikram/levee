// Demo attack: a stolen MINTING key. The gate account holds the Studio CASHIN (supplier) role,
// so whoever steals its key can call the Studio proxy's cash-in, mint(address,int64), directly,
// WITHOUT going through the gate: no receipt exists, so the watcher must treat the new supply as
// an unauthorised mint (the Resolv / StablR / Gala incidents were all unauthorised mints).
//
// On the Mirror Node a Studio cash-in is: parent CONTRACTCALL to the proxy, child TOKENMINT to the
// token treasury (= the proxy), child CRYPTOTRANSFER proxy -> beneficiary. The watcher reads the
// proxy's transactions and extractMovements reports it as one `mint` to the beneficiary, under the
// parent tx id (tests/watcher/mirror.test.ts, fixture tests/fixtures/mirror-cashin.json).
//
// Usage:
//   npx tsx scripts/attack-mint.ts [amount=5000]   mint RUPC straight to the attacker account
//   npx tsx scripts/attack-mint.ts retry            the attacker tries to move 0.000001 RUPC on
//                                                   (expect ACCOUNT_FROZEN_FOR_TOKEN once contained;
//                                                    the fee is paid by the gate account, the attacker signs)
// Testnet only. Never prints keys.
import {
  AccountId,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
  Long,
  TokenId,
  TransferTransaction,
} from "@hashgraph/sdk";
import { readState } from "../src/shared/config.js";
import { roleClient, roleKey } from "../src/shared/hedera.js";
import { normaliseTxId } from "../src/shared/txid.js";
import { toUnits } from "../src/setup/plan.js";

const state: any = readState();
const MIRROR = process.env.MIRROR_URL ?? "https://testnet.mirrornode.hedera.com";
const link = (txId: string) => `https://hashscan.io/testnet/transaction/${txId}`;

async function totalSupply(): Promise<string> {
  const r = await fetch(`${MIRROR}/api/v1/tokens/${state.token.tokenId}`);
  return ((await r.json()) as { total_supply: string }).total_supply;
}

const client = roleClient("gate", state.gate.id); // the stolen CASHIN-role key pays and signs
try {
  if (process.argv[2] === "retry") {
    const token = TokenId.fromString(state.token.tokenId);
    const tx = await new TransferTransaction()
      .addTokenTransfer(token, AccountId.fromString(state.attacker.id), Long.fromInt(-1))
      .addTokenTransfer(token, AccountId.fromString(state.treasury.id), Long.fromInt(1))
      .freezeWith(client)
      .sign(roleKey("attacker"));
    const resp = await tx.execute(client);
    const txId = normaliseTxId(resp.transactionId.toString());
    let status: string;
    try {
      status = (await resp.getReceipt(client)).status.toString();
    } catch (e) {
      status = (e as { status?: { toString(): string } }).status?.toString() ?? (e as Error).message;
    }
    console.log(`attacker second attempt: 0.000001 RUPC ${state.attacker.id} -> treasury: ${status}`);
    console.log(`tx ${link(txId)}`);
  } else {
    const amount = BigInt(process.argv[2] ?? "5000");
    const units = toUnits(amount, state.token.decimals);
    console.log(`total supply before: ${await totalSupply()}`);
    const t0 = Date.now();
    const resp = await new ContractExecuteTransaction()
      .setContractId(ContractId.fromString(state.token.proxy))
      .setGas(Number(process.env.CASHIN_GAS ?? "300000"))
      .setFunction("mint", new ContractFunctionParameters().addAddress(state.attacker.evm).addInt64(Long.fromString(units.toString())))
      .execute(client);
    const txId = normaliseTxId(resp.transactionId.toString());
    const rec = await resp.getReceipt(client);
    console.log(`attack: minted ${amount} RUPC to attacker ${state.attacker.id} with the stolen CASHIN key, no gate, no receipt: ${rec.status.toString()} (${Date.now() - t0} ms)`);
    console.log(`tx ${link(txId)}`);
  }
} finally {
  client.close();
}
