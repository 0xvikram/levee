// Deploys the ContainmentController and grants it the close-only Studio roles. Idempotent.
// Run: npm run setup:controller
//
// Deploy goes through the JSON-RPC relay (EthereumTransaction, fee = gas only) instead of
// ContractCreateFlow, whose ContractCreate base fee is ~$1 (~15 testnet HBAR). Falls back to
// ContractCreateFlow if the relay refuses.
// Grants on the Studio proxy (all sent by the operator, who keeps DEFAULT_ADMIN):
//   controller: FREEZE_ROLE, WIPE_ROLE, BURN_ROLE, PAUSE_ROLE   (never DEFAULT_ADMIN)
//   gate:       CASHIN role, unlimited supplier allowance        (legit mints go through the gate)
import { ContractCreateFlow, ContractFunctionParameters } from "@hashgraph/sdk";
import { createPublicClient, createWalletClient, decodeFunctionResult, encodeDeployData, encodeFunctionData, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";
import { env, writeState } from "../shared/config.js";
import { operatorClient, parseKey } from "../shared/hedera.js";
import { CONTROLLER_ROLES, STUDIO_ROLES, estimateController, gasHbar, shortfall, sumCost } from "./plan.js";
import { contractIdFromEvm, ethCall, execContract, hbarBalance, mirror } from "./net.js";
import { loadState } from "./state.js";
import { controllerArtifact, revertAbis, studioTokenAbi } from "./studio.js";

const RELAY = process.env.RELAY_URL ?? "https://testnet.hashio.io/api";

async function hasRole(proxyEvm: string, role: string, account: string): Promise<boolean> {
  const data = encodeFunctionData({ abi: studioTokenAbi, functionName: "hasRole", args: [role as `0x${string}`, account as `0x${string}`] });
  const out = await ethCall(proxyEvm, data);
  return decodeFunctionResult({ abi: studioTokenAbi, functionName: "hasRole", data: out as `0x${string}` }) as boolean;
}

async function deploy(tokenEvm: string, watcherEvm: string, admins: string[]): Promise<{ contractId: string; evm: string }> {
  const { abi, bytecode } = controllerArtifact();
  const args = [tokenEvm, watcherEvm, admins] as const;
  const account = privateKeyToAccount(`0x${parseKey(env.operatorKey).toStringRaw()}`);
  const pub = createPublicClient({ chain: hederaTestnet, transport: http(RELAY) });
  const wallet = createWalletClient({ account, chain: hederaTestnet, transport: http(RELAY) });
  try {
    const est = await pub
      .estimateGas({ account, data: encodeDeployData({ abi, bytecode, args: args as any }) })
      .catch(() => 1_300_000n);
    const gas = (est * 115n) / 100n;
    console.log(`deploying via relay (EthereumTransaction), gas limit ${gas} (~${gasHbar(Number(gas)).toFixed(2)} HBAR)`);
    const hash = await wallet.deployContract({ abi, bytecode, args: args as any, gas });
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (rc.status !== "success" || !rc.contractAddress) throw new Error(`deploy tx ${hash} status ${rc.status}`);
    const evm = rc.contractAddress.toLowerCase();
    const contractId = await contractIdFromEvm(evm);
    console.log(`  tx https://hashscan.io/testnet/tx/${hash}`);
    return { contractId, evm };
  } catch (e: any) {
    console.warn(`relay deploy failed (${String(e?.shortMessage ?? e?.message ?? e).slice(0, 200)}); falling back to ContractCreateFlow (~$1 base fee)`);
    const client = operatorClient();
    const bal = await hbarBalance(client, env.operatorId);
    if (shortfall(bal, 17) > 0) throw new Error(`ContractCreateFlow needs ~17 HBAR, have ${bal.toFixed(2)}`);
    const params = new ContractFunctionParameters().addAddress(tokenEvm).addAddress(watcherEvm).addAddressArray(admins);
    const resp = await new ContractCreateFlow().setBytecode(bytecode.slice(2)).setGas(1_500_000).setConstructorParameters(params).execute(client);
    const rec = await resp.getReceipt(client);
    const contractId = rec.contractId!.toString();
    const c = await mirror<{ evm_address: string }>(`/api/v1/contracts/${contractId}`, 15);
    return { contractId, evm: c!.evm_address };
  }
}

async function main() {
  const client = operatorClient();
  const s = loadState();
  if (!s.token?.proxyEvm) throw new Error("run npm run setup:token first");
  if (!s.watcher || !s.admins || !s.gate) throw new Error("run npm run setup:accounts first");
  const opEvm = (await mirror<{ evm_address: string }>(`/api/v1/accounts/${env.operatorId}`, 5))!.evm_address;

  const balance = await hbarBalance(client, env.operatorId);
  const needDeploy = !s.controller?.evm;
  const lines = estimateController({ deploy: needDeploy, grants: CONTROLLER_ROLES.length + 1 });
  for (const l of lines) console.log(`  est. ${l.what}: ${l.hbar.toFixed(2)} HBAR`);
  console.log(`operator balance ${balance.toFixed(3)} HBAR`);
  if (shortfall(balance, sumCost(lines)) > 0) {
    console.error(`ABORT: short by ${shortfall(balance, sumCost(lines))} HBAR`);
    process.exit(2);
  }

  let controller = s.controller;
  if (!controller?.evm) {
    controller = await deploy(s.token.proxyEvm, s.watcher.evm, s.admins.map((a) => a.evm));
    writeState({ controller });
    console.log(`controller ${controller.contractId} (${controller.evm})`);
  } else console.log(`controller exists: ${controller.contractId} (${controller.evm})`);

  const proxyEvm = s.token.proxyEvm;
  const grants: { who: string; addr: string; role: keyof typeof STUDIO_ROLES }[] = [
    ...CONTROLLER_ROLES.map((r) => ({ who: "controller", addr: controller!.evm, role: r })),
    { who: "gate", addr: s.gate.evm, role: "CASHIN" as const },
  ];
  for (const g of grants) {
    if (await hasRole(proxyEvm, STUDIO_ROLES[g.role], g.addr)) {
      console.log(`${g.who} already has ${g.role}_ROLE`);
      continue;
    }
    const data =
      g.role === "CASHIN"
        ? encodeFunctionData({ abi: studioTokenAbi, functionName: "grantUnlimitedSupplierRole", args: [g.addr as `0x${string}`] })
        : encodeFunctionData({ abi: studioTokenAbi, functionName: "grantRole", args: [STUDIO_ROLES[g.role] as `0x${string}`, g.addr as `0x${string}`] });
    const r = await execContract(client, s.token.proxy, data, { from: opEvm, to: proxyEvm, minGas: 80_000, abis: revertAbis() });
    console.log(`grant ${g.role}_ROLE to ${g.who}: ${r.ok ? "OK" : "FAILED " + r.status + " " + (r.error ?? "")}  ${r.link}`);
    if (!r.ok) process.exit(1);
  }

  // Safety check: the controller must never be a Studio admin; the operator must stay one.
  const ctrlAdmin = await hasRole(proxyEvm, STUDIO_ROLES.DEFAULT_ADMIN, controller.evm);
  const opAdmin = await hasRole(proxyEvm, STUDIO_ROLES.DEFAULT_ADMIN, opEvm);
  console.log(`DEFAULT_ADMIN: operator=${opAdmin} controller=${ctrlAdmin}`);
  if (ctrlAdmin || !opAdmin) {
    console.error("ROLE CHECK FAILED");
    process.exit(1);
  }
  const after = await hbarBalance(client, env.operatorId);
  console.log(`done. operator balance ${after.toFixed(3)} HBAR (spent ${(balance - after).toFixed(3)})`);
  client.close();
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
