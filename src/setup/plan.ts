// Pure helpers for the setup scripts: role ids, cost estimates, state checks, links.
// No network, no keys. Unit-tested in tests/setup/plan.test.ts.

/** Stablecoin Studio v4 role ids (keccak256 of the role names, see StableCoinRole in the SDK). */
export const STUDIO_ROLES = {
  DEFAULT_ADMIN: "0x0000000000000000000000000000000000000000000000000000000000000000",
  CASHIN: "0x53300d27a2268d3ff3ecb0ec8e628321ecfba1a08aed8b817e8acf589a52d25c",
  BURN: "0xe97b137254058bd94f28d2f3eb79e2d34074ffb488d042e3bc958e0a57d2fa22",
  WIPE: "0x515f99f4e5a381c770462a8d9879a01f0fd4a414a168a2404dab62a62e1af0c3",
  RESCUE: "0x43f433f336cda92fbbe5bfbdd344a9fd79b2ef138cd6e6fc49d55e2f54e1d99a",
  PAUSE: "0x139c2898040ef16910dc9f44dc697df79363da767d8bc92f2e310312b816e46d",
  FREEZE: "0x5789b43a60de35bcedee40618ae90979bab7d1315fd4b079234241bdab19936d",
  DELETE: "0x2b73f0f98ad60ca619bbdee4bcd175da1127db86346339f8b718e3f8b4a006e2",
} as const;

/** The four close-only roles the ContainmentController gets. Never DEFAULT_ADMIN. */
export const CONTROLLER_ROLES = ["FREEZE", "WIPE", "BURN", "PAUSE"] as const;

/** Stablecoin Studio v4.0.0 testnet deployment. */
export const STUDIO_TESTNET = {
  factory: "0.0.7353542",
  resolver: "0.0.7353500",
  /** configuration id + version the Studio SDK uses for a stablecoin proxy */
  stableCoinConfigId: "0x0000000000000000000000000000000000000000000000000000000000000002",
  stableCoinConfigVersion: 1n,
} as const;

/** Hedera token key types used by the Studio factory (bit flags). */
export const KEY_TYPE = { admin: 1n, kyc: 2n, freeze: 4n, wipe: 8n, supply: 16n, feeSchedule: 32n, pause: 64n } as const;

export const TOKEN_SPEC = { name: "Rupee Coin", symbol: "RUPC", decimals: 6, initialTreasuryWhole: 1_000_000n } as const;

/** Every account role created by accounts.ts, with its target HBAR balance. */
export const ACCOUNT_PLAN: { role: string; hbar: number }[] = [
  { role: "admin0", hbar: 0.5 },
  { role: "admin1", hbar: 0.5 },
  { role: "admin2", hbar: 0.5 },
  { role: "watcher", hbar: 1.5 },
  { role: "gate", hbar: 1 },
  { role: "payee0", hbar: 0 },
  { role: "payee1", hbar: 0 },
  { role: "attacker", hbar: 0 },
  { role: "treasury", hbar: 1 },
];

/** Keys that exist only as keys (parts of the treasury 2-of-3 KeyList), not accounts. */
export const KEY_ONLY_ROLES = ["treasurySigner", "cold"] as const;

/**
 * Approximate testnet fees in HBAR, measured from the Mirror Node on 6 Nov 2026
 * (1 HBAR ~ $0.069). Deliberately on the high side.
 */
export const FEE_HBAR = {
  accountCreate: 0.8,
  topicCreate: 0.45,
  tokenAssociate: 0.75,
  /** HTS token create fee forwarded by the Studio factory as msg.value; excess is not taken */
  tokenCreateValue: 25,
  tokenCreateFee: 16,
  gasTinybarPerUnit: 130,
  hbarTransfer: 0.001,
} as const;

export function gasHbar(gas: number): number {
  return (gas * FEE_HBAR.gasTinybarPerUnit) / 1e8;
}

export interface CostLine {
  what: string;
  hbar: number;
}

export function sumCost(lines: CostLine[]): number {
  return Math.round(lines.reduce((a, l) => a + l.hbar, 0) * 1000) / 1000;
}

/** Cost of creating the accounts that are missing, and of topping balances up to target. */
export function estimateAccounts(missingRoles: string[], fund: boolean): CostLine[] {
  const lines: CostLine[] = [];
  if (missingRoles.length) lines.push({ what: `create ${missingRoles.length} account(s)`, hbar: missingRoles.length * FEE_HBAR.accountCreate });
  if (fund) {
    const funding = ACCOUNT_PLAN.filter((p) => missingRoles.includes(p.role)).reduce((a, p) => a + p.hbar, 0);
    if (funding) lines.push({ what: "initial HBAR balances", hbar: funding });
  }
  return lines;
}

export function estimateTopics(missing: number): CostLine[] {
  return missing ? [{ what: `create ${missing} topic(s)`, hbar: missing * FEE_HBAR.topicCreate }] : [];
}

export function estimateToken(opts: { create: boolean; associations: number; cashIn: boolean }): CostLine[] {
  const lines: CostLine[] = [];
  if (opts.create) {
    lines.push({ what: "Studio deployStableCoin (HTS create fee + ~1.25M gas)", hbar: FEE_HBAR.tokenCreateFee + gasHbar(1_300_000) });
  }
  if (opts.associations) lines.push({ what: `associate ${opts.associations} account(s)`, hbar: opts.associations * FEE_HBAR.tokenAssociate });
  if (opts.cashIn) lines.push({ what: "cash-in to treasury (~250k gas)", hbar: gasHbar(250_000) });
  return lines;
}

export function estimateController(opts: { deploy: boolean; grants: number }): CostLine[] {
  const lines: CostLine[] = [];
  if (opts.deploy) lines.push({ what: "deploy ContainmentController (~1.3M gas, EthereumTransaction)", hbar: gasHbar(1_300_000) });
  if (opts.grants) lines.push({ what: `${opts.grants} role grant(s) (~150k gas each)`, hbar: opts.grants * gasHbar(150_000) });
  return lines;
}

/** Balance check: how much is missing (0 when enough). Keeps a small reserve for later steps. */
export function shortfall(balanceHbar: number, needHbar: number, reserveHbar = 0.5): number {
  const gap = needHbar + reserveHbar - balanceHbar;
  return gap > 0 ? Math.ceil(gap * 100) / 100 : 0;
}

/** Integer amount in the token's smallest unit. */
export function toUnits(whole: bigint, decimals: number): bigint {
  return whole * 10n ** BigInt(decimals);
}

export function hashscanTx(txId: string, network = "testnet"): string {
  return `https://hashscan.io/${network}/transaction/${txId}`;
}

/** Which setup steps are still to do, given a (possibly partial) deploy.json. */
export function missingSteps(s: Record<string, unknown>): string[] {
  const out: string[] = [];
  const has = (v: unknown) => v !== undefined && v !== null && v !== "";
  const acct = (v: unknown) => !!v && typeof v === "object" && has((v as { id?: string }).id) && has((v as { evm?: string }).evm);
  const admins = s.admins as unknown[] | undefined;
  const payees = s.payees as unknown[] | undefined;
  if (!(Array.isArray(admins) && admins.length === 3 && admins.every(acct) && acct(s.watcher) && acct(s.gate) && acct(s.attacker) && acct(s.treasury) && Array.isArray(payees) && payees.length >= 2 && payees.every(acct)))
    out.push("accounts");
  const t = s.topics as Record<string, string> | undefined;
  if (!(t && has(t.receipts) && has(t.incidents) && has(t.heartbeats))) out.push("topics");
  const tok = s.token as Record<string, unknown> | undefined;
  if (!(tok && has(tok.tokenId) && has(tok.proxy) && has(tok.proxyEvm))) out.push("token");
  const c = s.controller as Record<string, string> | undefined;
  if (!(c && has(c.contractId) && has(c.evm))) out.push("controller");
  return out;
}

/** Replace (or append) a marked section of a markdown doc. Used for docs/FIRST_HOUR_TESTS.md. */
export function replaceSection(doc: string, id: string, body: string): string {
  const start = `<!-- ${id}:start -->`;
  const end = `<!-- ${id}:end -->`;
  const block = `${start}\n${body.trim()}\n${end}`;
  const i = doc.indexOf(start);
  const j = doc.indexOf(end);
  if (i >= 0 && j > i) return doc.slice(0, i) + block + doc.slice(j + end.length);
  return (doc.trimEnd() ? doc.trimEnd() + "\n\n" : "") + block + "\n";
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
