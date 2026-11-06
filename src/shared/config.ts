// Shared config + deployment state. Every service reads the same two things:
//  1. .env  (secrets and settings, never committed)
//  2. state/deploy.json  (IDs created by the setup scripts; gitignored, testnet only)
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

export const env = {
  network: process.env.HEDERA_NETWORK ?? "testnet",
  operatorId: process.env.OPERATOR_ID ?? "",
  operatorKey: process.env.OPERATOR_KEY ?? "",
  mirrorUrl: process.env.MIRROR_URL ?? "https://testnet.mirrornode.hedera.com",
  arkivRpc: process.env.ARKIV_RPC ?? "https://rpc.rabdi.db-chain.testnet.arkiv.network",
  arkivPrivateKey: process.env.ARKIV_PRIVATE_KEY ?? "",
  arkivAccessKey: process.env.ARKIV_ACCESS_KEY ?? "",
  capPerTransfer: BigInt(process.env.CAP_PER_TRANSFER ?? "10000"),
  capPerDay: BigInt(process.env.CAP_PER_DAY ?? "50000"),
  heartbeatSeconds: Number(process.env.HEARTBEAT_SECONDS ?? "60"),
  passSeconds: Number(process.env.PASS_SECONDS ?? "180"),
  gatePort: Number(process.env.GATE_PORT ?? "8710"),
  watcherPort: Number(process.env.WATCHER_PORT ?? "8711"),
  checkerPort: Number(process.env.CHECKER_PORT ?? "8712"),
};

/** One Hedera account created by setup. Private keys live ONLY in state/keys.json (gitignored). */
export interface AccountRef {
  id: string; // 0.0.x
  evm: string; // 0x... long-zero or alias address
}

/** Written by the setup scripts. Read by gate, watcher, checker, dashboard. */
export interface DeployState {
  network: string;
  createdAt: string;
  token: {
    tokenId: string; // HTS token id 0.0.x  (Stablecoin Studio token)
    proxy: string; // Stablecoin Studio diamond proxy contract id 0.0.x
    proxyEvm: string; // 0x... EVM address of the proxy (what the controller calls)
    symbol: string; // "RUPC"
    decimals: number; // 6
  };
  treasury: AccountRef; // company operating treasury (2-of-3 threshold key) that holds RUPC
  admins: [AccountRef, AccountRef, AccountRef]; // the 3 humans for 2-of-3 reopen
  watcher: AccountRef; // bot account that calls close actions
  gate: AccountRef; // gate account (submit key holder for receipts)
  payees: AccountRef[]; // known destinations
  attacker: AccountRef; // demo attacker account (receives the stolen tokens)
  controller: { contractId: string; evm: string }; // ContainmentController
  topics: {
    receipts: string; // HCS topic id, submit key = gate
    incidents: string; // HCS topic id, submit key = watcher
    heartbeats: string; // HCS topic id for watcher heartbeats
  };
}

const STATE_DIR = path.resolve("state");
const STATE_FILE = path.join(STATE_DIR, "deploy.json");
const KEYS_FILE = path.join(STATE_DIR, "keys.json");

export function readState(): DeployState {
  if (!fs.existsSync(STATE_FILE)) throw new Error("state/deploy.json missing: run the setup scripts first");
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

export function writeState(partial: Partial<DeployState>): DeployState {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const current = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  const next = { ...current, ...partial };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next as DeployState;
}

/** Private keys of setup-created accounts, keyed by role name. Never log these. */
export function readKeys(): Record<string, string> {
  return fs.existsSync(KEYS_FILE) ? JSON.parse(fs.readFileSync(KEYS_FILE, "utf8")) : {};
}

export function writeKey(role: string, privateKeyHex: string): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const keys = readKeys();
  keys[role] = privateKeyHex;
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
}
