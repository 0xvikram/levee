// Creates the Stablecoin Studio token "Rupee Coin" (RUPC, 6 decimals) and funds the treasury. Idempotent.
// Run: npm run setup:token
//
// Path: calls the Studio v4 factory (0.0.7353542) deployStableCoin directly with HAPI
// ContractExecuteTransaction, building the same request the Studio SDK builds
// (packages/sdk TokenOperations.create). Why not StableCoin.create() from the SDK: it always
// sends 80 HBAR + a 10M gas limit (~12 HBAR of gas charged at Hedera's 80% minimum), which
// this operator cannot afford. Direct call = estimated gas (~1.25M) + the HTS create fee only.
//
// Keys: admin, freeze, wipe, supply, pause = the smart contract (so Studio roles apply);
// no KYC key, no fee-schedule key, freeze default false. All Studio roles start with the
// operator (DEFAULT_ADMIN stays with the operator for good; the controller only ever gets
// FREEZE/WIPE/BURN/PAUSE in controller.ts).
import { PrivateKey, TokenAssociateTransaction } from "@hashgraph/sdk";
import { encodeFunctionData } from "viem";
import { env, readKeys, writeState } from "../shared/config.js";
import { operatorClient, parseKey, roleKey } from "../shared/hedera.js";
import { normaliseTxId } from "../shared/txid.js";
import {
  FEE_HBAR,
  STUDIO_TESTNET,
  TOKEN_SPEC,
  estimateToken,
  gasHbar,
  hashscanTx,
  shortfall,
  sumCost,
  toUnits,
} from "./plan.js";
import { estimateGas, execContract, freezeStatus, hbarBalance, mirror, mirrorTx, sleep, tokenBalance } from "./net.js";
import { loadState } from "./state.js";
import { revertAbis, studioFactoryAbi, studioTokenAbi } from "./studio.js";
import { saveFixture } from "./fixtures.js";
import { buildDeployRequest } from "./deploy-request.js";

async function operatorEvm(): Promise<string> {
  const a = await mirror<{ evm_address: string }>(`/api/v1/accounts/${env.operatorId}`, 5);
  if (!a?.evm_address) throw new Error("operator evm address not found");
  return a.evm_address;
}

async function contractEvm(id: string): Promise<string> {
  const c = await mirror<{ evm_address: string }>(`/api/v1/contracts/${id}`, 10);
  if (!c?.evm_address) throw new Error(`no evm address for contract ${id}`);
  return c.evm_address;
}

async function main() {
  const client = operatorClient();
  const state = loadState();
  if (!state.treasury || !state.payees || !state.attacker) throw new Error("run npm run setup:accounts first");
  const opEvm = await operatorEvm();

  const toAssociate: { role: string; id: string; signers: PrivateKey[] }[] = [];
  const keys = readKeys();
  const tokenId0: string | undefined = state.token?.tokenId;
  const assocTargets = [
    { role: "treasury", id: state.treasury.id, signers: [roleKey("treasurySigner"), roleKey("cold")] },
    { role: "payee0", id: state.payees[0].id, signers: [parseKey(keys.payee0)] },
    { role: "payee1", id: state.payees[1].id, signers: [parseKey(keys.payee1)] },
    { role: "attacker", id: state.attacker.id, signers: [parseKey(keys.attacker)] },
  ];
  for (const t of assocTargets) if (!tokenId0 || !(await freezeStatus(t.id, tokenId0))) toAssociate.push(t);
  const needCashIn = !tokenId0 || (await tokenBalance(state.treasury.id, tokenId0)) === 0n;

  const balance = await hbarBalance(client, env.operatorId);
  const lines = estimateToken({ create: !tokenId0, associations: toAssociate.length, cashIn: needCashIn });
  for (const l of lines) console.log(`  est. ${l.what}: ${l.hbar.toFixed(2)} HBAR`);
  // deployStableCoin also needs msg.value on the account at submission time (unused part is not taken).
  const need = sumCost(lines) + (tokenId0 ? 0 : FEE_HBAR.tokenCreateValue - FEE_HBAR.tokenCreateFee);
  console.log(`operator balance ${balance.toFixed(3)} HBAR, needs ~${need.toFixed(2)} HBAR available for this step`);
  if (shortfall(balance, need) > 0) {
    console.error(`ABORT: short by ${shortfall(balance, need)} HBAR. Top up the operator at portal.hedera.com and re-run.`);
    process.exit(2);
  }

  // 1. create the token
  let tokenId = tokenId0;
  if (!tokenId) {
    const factoryEvm = await contractEvm(STUDIO_TESTNET.factory);
    const resolverEvm = await contractEvm(STUDIO_TESTNET.resolver);
    const req = buildDeployRequest(opEvm, resolverEvm);
    const data = encodeFunctionData({ abi: studioFactoryAbi, functionName: "deployStableCoin", args: [req] as any });
    // Send as much msg.value as we can spare (Studio SDK sends 80); the HTS create fee is ~15 HBAR.
    const value = Math.max(FEE_HBAR.tokenCreateValue, Math.min(80, Math.floor(balance - gasHbar(1_500_000) - 3)));
    const est = await estimateGas(opEvm, factoryEvm, data, BigInt(value * 1e8)).catch(() => null);
    const gas = est ? Math.ceil(est * 1.15) : 1_450_000;
    console.log(`deployStableCoin: gas ${gas} (${est ? "mirror estimate +15%" : "fixed, estimate unavailable"}), value ${value} HBAR`);
    const r = await execContract(client, STUDIO_TESTNET.factory, data, { gas, valueHbar: value, abis: revertAbis() });
    console.log(`  ${r.ok ? "OK" : "FAILED " + r.status + " " + (r.error ?? "")}  ${r.link}`);
    if (!r.ok) process.exit(1);
    const recs = (await mirrorTx(r.txId, 60_000)) ?? [];
    const tokenRec = recs.find((x) => x.name === "TOKENCREATION");
    const proxyRec = recs.find((x) => x.name === "CONTRACTCREATEINSTANCE");
    if (!tokenRec || !proxyRec) throw new Error(`could not find token/proxy in children of ${r.txId}; check ${r.link}`);
    tokenId = tokenRec.entity_id as string;
    const proxy = proxyRec.entity_id as string;
    const proxyEvm = await contractEvm(proxy);
    writeState({ token: { tokenId, proxy, proxyEvm, symbol: TOKEN_SPEC.symbol, decimals: TOKEN_SPEC.decimals } });
    console.log(`token ${tokenId}  proxy ${proxy} (${proxyEvm})`);
    await sleep(3000);
  } else console.log(`token exists: ${tokenId}`);

  // 2. associate treasury, payees, attacker (operator pays; each account signs)
  for (const t of toAssociate) {
    if (await freezeStatus(t.id, tokenId!)) continue;
    let tx = new TokenAssociateTransaction().setAccountId(t.id).setTokenIds([tokenId!]).freezeWith(client);
    for (const k of t.signers) tx = await tx.sign(k);
    const resp = await tx.execute(client);
    await resp.getReceipt(client);
    console.log(`associated ${t.role} ${t.id}  ${hashscanTx(normaliseTxId(resp.transactionId.toString()))}`);
  }

  // 3. cash-in (Studio mint) the initial balance to the treasury account
  const s = loadState();
  await sleep(4000); // let the mirror catch up before reading the balance
  if ((await tokenBalance(s.treasury!.id, tokenId!)) === 0n) {
    const amount = toUnits(TOKEN_SPEC.initialTreasuryWhole, TOKEN_SPEC.decimals);
    const data = encodeFunctionData({ abi: studioTokenAbi, functionName: "mint", args: [s.treasury!.evm as `0x${string}`, amount] });
    const r = await execContract(client, s.token!.proxy, data, { from: opEvm, to: s.token!.proxyEvm, minGas: 120_000, abis: revertAbis() });
    console.log(`cash-in ${TOKEN_SPEC.initialTreasuryWhole} ${TOKEN_SPEC.symbol} to treasury: ${r.ok ? "OK" : "FAILED " + r.status + " " + (r.error ?? "")}  ${r.link}`);
    if (!r.ok) process.exit(1);
    const recs = await mirrorTx(r.txId, 60_000);
    if (recs) saveFixture("mirror-cashin.json", { _note: `GET /api/v1/transactions/${r.txId} for a Studio cash-in (HAPI ContractCall to proxy mint(address,int64)) by the operator`, transactions: recs });
  } else console.log("treasury already funded");

  const after = await hbarBalance(client, env.operatorId);
  console.log(`done. operator balance ${after.toFixed(3)} HBAR (spent ${(balance - after).toFixed(3)})`);
  client.close();
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
