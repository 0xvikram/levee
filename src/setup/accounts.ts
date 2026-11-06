// Creates the demo accounts (idempotent). Run: npm run setup:accounts
//  - admin0..2, watcher, gate, payee0, payee1, attacker: ECDSA accounts with an EVM alias,
//    so msg.sender in contract calls is the same address whether called via HAPI or JSON-RPC.
//  - treasury: key = 2-of-3 KeyList {treasurySigner, gate, cold}; EVM address = long-zero.
// Private keys go to state/keys.json (gitignored) via writeKey; ids/addresses to state/deploy.json.
import {
  AccountCreateTransaction,
  AccountId,
  Hbar,
  KeyList,
  PrivateKey,
  TransferTransaction,
} from "@hashgraph/sdk";
import { env, readKeys, writeKey, writeState, type AccountRef, type DeployState } from "../shared/config.js";
import { longZero, operatorClient, parseKey } from "../shared/hedera.js";
import { ACCOUNT_PLAN, KEY_ONLY_ROLES, estimateAccounts, shortfall, sumCost, hashscanTx } from "./plan.js";
import { hbarBalance } from "./net.js";
import { normaliseTxId } from "../shared/txid.js";
import { loadState } from "./state.js";

const client = operatorClient();
const state = loadState();
const keys = readKeys();

function existing(role: string): AccountRef | undefined {
  if (role.startsWith("admin")) return state.admins?.[Number(role.slice(5))];
  if (role.startsWith("payee")) return state.payees?.[Number(role.slice(5))];
  return (state as any)[role];
}

function ensureKey(role: string): PrivateKey {
  if (keys[role]) return parseKey(keys[role]);
  const k = PrivateKey.generateECDSA();
  writeKey(role, k.toStringRaw());
  keys[role] = k.toStringRaw();
  return k;
}

function save(role: string, ref: AccountRef) {
  const s = loadState() as Partial<DeployState>;
  if (role.startsWith("admin")) {
    const admins = [...((s.admins as AccountRef[] | undefined) ?? [])];
    admins[Number(role.slice(5))] = ref;
    writeState({ admins: admins as DeployState["admins"] });
  } else if (role.startsWith("payee")) {
    const payees = [...(s.payees ?? [])];
    payees[Number(role.slice(5))] = ref;
    writeState({ payees });
  } else {
    writeState({ [role]: ref } as Partial<DeployState>);
  }
}

async function main() {
  writeState({ network: env.network, createdAt: state.createdAt ?? new Date().toISOString() });
  const missing = ACCOUNT_PLAN.filter((p) => !existing(p.role)).map((p) => p.role);
  const balance = await hbarBalance(client, env.operatorId);

  const full = estimateAccounts(missing, true);
  const createOnly = estimateAccounts(missing, false);
  console.log(`operator ${env.operatorId} balance: ${balance.toFixed(3)} HBAR`);
  console.log(`missing accounts: ${missing.length ? missing.join(", ") : "none"}`);
  for (const l of full) console.log(`  est. ${l.what}: ${l.hbar.toFixed(2)} HBAR`);

  let fund = true;
  if (shortfall(balance, sumCost(full)) > 0) {
    if (shortfall(balance, sumCost(createOnly)) > 0) {
      console.error(`ABORT: need ~${sumCost(full)} HBAR (+0.5 reserve), have ${balance.toFixed(2)}. Short by ${shortfall(balance, sumCost(full))} HBAR.`);
      process.exit(2);
    }
    fund = false;
    console.warn("Not enough HBAR to fund balances now: creating accounts with 0 HBAR. Re-run after a top-up to fund them.");
  }

  // key-only roles that make up the treasury threshold key
  for (const r of KEY_ONLY_ROLES) ensureKey(r);

  for (const p of ACCOUNT_PLAN) {
    if (existing(p.role)) continue;
    const initial = fund ? p.hbar : 0;
    let ref: AccountRef;
    let tx: AccountCreateTransaction;
    if (p.role === "treasury") {
      const gateKey = ensureKey("gate");
      const kl = new KeyList([ensureKey("treasurySigner").publicKey, gateKey.publicKey, ensureKey("cold").publicKey], 2);
      tx = new AccountCreateTransaction().setKeyWithoutAlias(kl).setInitialBalance(new Hbar(initial));
    } else {
      const k = ensureKey(p.role);
      tx = new AccountCreateTransaction().setECDSAKeyWithAlias(k).setInitialBalance(new Hbar(initial));
    }
    const resp = await tx.freezeWith(client).execute(client);
    const rec = await resp.getReceipt(client);
    const id = rec.accountId!.toString();
    const evm =
      p.role === "treasury" ? longZero(id) : "0x" + parseKey(keys[p.role]).publicKey.toEvmAddress();
    ref = { id, evm };
    save(p.role, ref);
    console.log(`created ${p.role.padEnd(9)} ${id} ${evm}  ${hashscanTx(normaliseTxId(resp.transactionId.toString()))}`);
  }

  // Top up to target balances (handles a previous run that skipped funding).
  if (fund || missing.length === 0) {
    const s = loadState();
    const transfer = new TransferTransaction();
    let total = 0;
    for (const p of ACCOUNT_PLAN) {
      if (!p.hbar) continue;
      const ref = (p.role.startsWith("admin") ? s.admins![Number(p.role.slice(5))] : (s as any)[p.role]) as AccountRef;
      const have = await hbarBalance(client, ref.id);
      const need = Math.round((p.hbar - have) * 1e8) / 1e8;
      if (need > 0.05) {
        transfer.addHbarTransfer(ref.id, new Hbar(need));
        total += need;
      }
    }
    if (total > 0) {
      const bal = await hbarBalance(client, env.operatorId);
      if (shortfall(bal, total) > 0) {
        console.warn(`Funding skipped: need ${total.toFixed(2)} HBAR (+0.5 reserve), have ${bal.toFixed(2)}.`);
      } else {
        transfer.addHbarTransfer(AccountId.fromString(env.operatorId), new Hbar(-total));
        const r = await transfer.execute(client);
        await r.getReceipt(client);
        console.log(`funded accounts with ${total.toFixed(2)} HBAR  ${hashscanTx(normaliseTxId(r.transactionId.toString()))}`);
      }
    } else console.log("balances already at target");
  }

  const after = await hbarBalance(client, env.operatorId);
  console.log(`done. operator balance ${after.toFixed(3)} HBAR (spent ${(balance - after).toFixed(3)})`);
  client.close();
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
