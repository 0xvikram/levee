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

/** Display-only names for the demo payees (payees[0] is Asha, payees[1] is Ravi). Never sent anywhere. */
const PAYEE_NAMES = ["Asha", "Ravi"];
export function payeeName(id: string | undefined): string | null {
  if (!id) return null;
  const i = deploy.payees.indexOf(id);
  return i >= 0 ? (PAYEE_NAMES[i] ?? `Payee ${i + 1}`) : null;
}

const env = import.meta.env;
/** Service base URLs. Dev and `vite preview` proxy /api/* to the local services. */
export const services = {
  gate: (env.VITE_GATE_URL as string | undefined) ?? "/api/gate",
  watcher: (env.VITE_WATCHER_URL as string | undefined) ?? "/api/watcher",
  checker: (env.VITE_CHECKER_URL as string | undefined) ?? "/api/checker",
  runner: (env.VITE_RUNNER_URL as string | undefined) ?? "/api/runner",
};

type Loc = { hostname: string; port: string; protocol: string };
const here = (): Loc | undefined => (typeof window !== "undefined" ? window.location : undefined);
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/**
 * Can this page reach the services at all? True on localhost, on the Vite dev/preview ports
 * (which proxy /api/*), or when a service URL is set explicitly. False on the public site
 * (Vercel), where /api/* does not exist: nothing may poll it or open an EventSource to it.
 */
export function servicesReachable(loc: Loc | undefined = here()): boolean {
  if (env.VITE_GATE_URL || env.VITE_WATCHER_URL || env.VITE_CHECKER_URL || env.VITE_RUNNER_URL) return true;
  if (!loc) return false;
  return LOCAL_HOST.test(loc.hostname) || loc.port === "5173" || loc.port === "4173";
}

/** A service URL when the services can be reached from here, else "" (usePoll/useEventSource then do nothing). */
export function serviceUrl(svc: keyof typeof services, path: string, loc: Loc | undefined = here()): string {
  return servicesReachable(loc) ? `${services[svc]}${path}` : "";
}

const PORTS = { gate: 8710, watcher: 8711, checker: 8712 } as const;
/**
 * SSE URL for a service. On local dev/preview the stream goes straight to the service port
 * (services send CORS * on /events), so the three never-ending streams do not use up the
 * browser's 6-connections-per-origin budget that the proxied polls share. See lib/health.ts.
 */
export function eventsUrl(svc: keyof typeof PORTS, loc: Loc | undefined = here()): string {
  const explicit = env[`VITE_${svc.toUpperCase()}_URL`] as string | undefined;
  if (explicit) return `${explicit}/events`;
  if (!servicesReachable(loc)) return ""; // public site: never open a stream to a missing /api/*
  if (loc && loc.protocol === "http:" && LOCAL_HOST.test(loc.hostname) && (loc.port === "5173" || loc.port === "4173")) {
    return `http://${loc.hostname}:${PORTS[svc]}/events`;
  }
  return `${services[svc]}/events`;
}
export const MIRROR = (env.VITE_MIRROR_URL as string | undefined) ?? `https://${deploy.network}.mirrornode.hedera.com`;
export const GITHUB = "https://github.com/0xvikram/levee";
export const ARKIV_EXPLORER = "https://rabdi.explorer.arkiv.network";

const hs = `https://hashscan.io/${deploy.network}`;
export const hashscan = {
  tx: (txId: string) => `${hs}/transaction/${txId}`,
  topic: (id: string) => `${hs}/topic/${id}`,
  account: (id: string) => `${hs}/account/${id}`,
  token: (id: string) => `${hs}/token/${id}`,
  contract: (id: string) => `${hs}/contract/${id}`,
};

/** The measured testnet run (6 Nov 2026), shown on the landing page. */
export const MEASURED = {
  date: "6 Nov 2026",
  detectionS: 4.19,
  treasuryFrozenS: 6.44,
  wipedS: 8.31,
  wipedAmount: "10,000",
  attackTx: "0.0.11333495-1793935170-233904996",
  freezeTx: "0.0.11333487-1793935173-898405003",
  wipeTx: "0.0.11333487-1793935180-013412119",
};
