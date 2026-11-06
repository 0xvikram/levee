// One place to build Hedera clients and parse keys. Never log private keys.
import { AccountId, Client, PrivateKey } from "@hashgraph/sdk";
import { env, readKeys } from "./config.js";

export function parseKey(hex: string): PrivateKey {
  const s = hex.trim().replace(/^0x/, "");
  // ECDSA raw hex (64 chars) or DER. All keys we create are ECDSA.
  return s.length === 64 ? PrivateKey.fromStringECDSA(s) : PrivateKey.fromStringDer(s);
}

/** Client paying fees with the operator account from .env */
export function operatorClient(): Client {
  if (!env.operatorId || !env.operatorKey) throw new Error("OPERATOR_ID / OPERATOR_KEY missing in .env");
  const client = env.network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(AccountId.fromString(env.operatorId), parseKey(env.operatorKey));
  return client;
}

/** Client paying fees with a setup-created account, by role name in state/keys.json. */
export function roleClient(role: string, accountId: string): Client {
  const keys = readKeys();
  const k = keys[role];
  if (!k) throw new Error(`no key for role ${role} in state/keys.json`);
  const client = env.network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(AccountId.fromString(accountId), parseKey(k));
  return client;
}

export function roleKey(role: string): PrivateKey {
  const k = readKeys()[role];
  if (!k) throw new Error(`no key for role ${role} in state/keys.json`);
  return parseKey(k);
}

/** Hedera account id 0.0.N -> long-zero EVM address */
export function longZero(id: string): string {
  return "0x" + AccountId.fromString(id).toSolidityAddress();
}
