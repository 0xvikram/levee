// Public deployment IDs (no keys). Filled from state/deploy.json at build time (whitelisted in
// vite.config.ts); the fallback is the testnet deployment measured on 6 Nov 2026.
export interface DeployIds {
  network: string;
  token: { tokenId: string; symbol: string; decimals: number };
  treasury: string;
  attacker?: string;
  payees: string[];
  admins: string[];
  topics: { receipts: string; incidents: string; heartbeats: string };
  controller: string;
}

const FALLBACK: DeployIds = {
  network: "testnet",
  token: { tokenId: "0.0.11333594", symbol: "RUPC", decimals: 6 },
  treasury: "0.0.11333495",
  attacker: "0.0.11333494",
  payees: ["0.0.11333490", "0.0.11333492"],
  admins: ["0.0.11333483", "0.0.11333484", "0.0.11333485"],
  topics: { receipts: "0.0.11333498", incidents: "0.0.11333500", heartbeats: "0.0.11333501" },
  controller: "0.0.11333603",
};

const injected = typeof __LEVEE_DEPLOY__ !== "undefined" ? __LEVEE_DEPLOY__ : null;
export const deploy: DeployIds = injected?.token?.tokenId ? { ...FALLBACK, ...injected } : FALLBACK;

const env = import.meta.env;
/** Service base URLs. Dev and `vite preview` proxy /api/* to the local services. */
export const services = {
  gate: (env.VITE_GATE_URL as string | undefined) ?? "/api/gate",
  watcher: (env.VITE_WATCHER_URL as string | undefined) ?? "/api/watcher",
  checker: (env.VITE_CHECKER_URL as string | undefined) ?? "/api/checker",
};
export const MIRROR = (env.VITE_MIRROR_URL as string | undefined) ?? `https://${deploy.network}.mirrornode.hedera.com`;
export const GITHUB = "https://github.com/0xvikram/levee";

const hs = `https://hashscan.io/${deploy.network}`;
export const hashscan = {
  tx: (txId: string) => `${hs}/transaction/${txId}`,
  topic: (id: string) => `${hs}/topic/${id}`,
  account: (id: string) => `${hs}/account/${id}`,
  token: (id: string) => `${hs}/token/${id}`,
};

/** The measured testnet run (6 Nov 2026), shown on the landing page. */
export const MEASURED = {
  date: "6 Nov 2026",
  detectionS: "3–4",
  treasuryFrozenS: "6.4",
  wipedS: "8.3",
  wipedAmount: "10,000",
  attackTx: "0.0.11333495-1793935170-233904996",
  wipeTx: "0.0.11333487-1793935180-013412119",
};
