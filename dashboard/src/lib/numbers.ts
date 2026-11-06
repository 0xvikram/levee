// "By the numbers" on the landing page. Every figure here is sourced: a HashScan link for our own
// runs (docs/LIVE_RUN.md), or the public write-up for other teams' incidents. The theft figures are
// NOT here: they come live from the incidents topic (lib/incident.ts).
import { GITHUB } from "./config";

const LIVE_RUN = `${GITHUB}/blob/build/docs/LIVE_RUN.md`;

/** Live unauthorised mint, 6 Nov 2026 (docs/LIVE_RUN.md section 5; incident on topic 0.0.11333500). */
export const MINT = {
  date: "6 Nov 2026",
  amount: "5,000",
  detectedS: 4.65,
  containedS: 7.53,
  mintTx: "0.0.11333489-1793975099-404424918",
  wipeTx: "0.0.11333487-1793975101-804305541",
  netSupplyChange: 0, // 967,484,808,697 before the mint and after the wipe (smallest units)
  source: LIVE_RUN,
};

/** Normal-path facts from docs/LIVE_RUN.md and CI. Test counts are from `npx vitest run` at build time of this page. */
export const FACTS = {
  matchedSends: 393, // runs B, C and D, after the fix
  falseAlarms: 0,
  hbarPerSend: 0.02, // 0.016 transfer + 0.004 receipt
  rootTests: 306,
  dashboardTests: 117,
  liveRun: LIVE_RUN,
  ci: `${GITHUB}/actions/workflows/test.yml`,
};

export interface Comparison {
  name: string;
  when: string;
  seconds: number;
  shown: string; // the duration as written in the label
  what: string; // what the duration measures, in the source's own terms
  source: string;
  sourceName: string;
}

/** Other teams' time to contain or respond, as their own reports or the press put it. */
export const INDUSTRY: Comparison[] = [
  {
    name: "PlayDapp",
    when: "Feb 2024",
    seconds: 4 * 86_400,
    shown: "~4 days",
    what: "first unauthorised mint (9 Feb) to the halt notice (13 Feb)",
    source: "https://unchainedcrypto.com/playdapp-loses-290-million-in-exploit-after-private-key-exposed/",
    sourceName: "Unchained",
  },
  {
    name: "StablR",
    when: "May 2026",
    seconds: 8 * 3_600,
    shown: "~8 h",
    what: "to acknowledge, after the attacker's on-chain activity had stopped",
    source: "https://theblock.co/post/402429/stablrs-eurr-and-usdr-depeg-after-attacker-mints-13-5-million-in-unbacked-tokens-through-multisig-exploit",
    sourceName: "The Block",
  },
  {
    name: "Resolv USR",
    when: "Mar 2026",
    seconds: 3 * 3_600 + 9 * 60,
    shown: "~3 h 9 min",
    what: "first mint (02:21 UTC) to credentials revoked (05:30 UTC)",
    source: "https://www.kucoin.com/news/flash/resolv-postmortem-reveals-25m-crypto-drain-via-credential-exploitation",
    sourceName: "KuCoin News",
  },
  {
    name: "Gala Games",
    when: "May 2024",
    seconds: 45 * 60,
    shown: "~45 min",
    what: "identified and contained, per Gala Games",
    source: "https://cryptoslate.com/gala-games-says-it-resolved-exploit-within-45-minutes-identified-culprit/",
    sourceName: "CryptoSlate",
  },
];

/** Optional market context, checked against the DefiLlama stablecoins API on 6 Nov 2026 ($25.30M). */
export const MARKET = { text: "Hedera stablecoin supply ~$25.3M", source: "https://defillama.com/chain/hedera", sourceName: "DefiLlama, 6 Nov 2026" };

/** Log-scale axis for the comparison chart: 1 s … 10^6 s (about 11.6 days). */
export const AXIS = { min: 1, max: 1_000_000 };

/** Position of `seconds` on the log axis, 0..1 (clamped). */
export function logPos(seconds: number, axis = AXIS): number {
  const lo = Math.log10(axis.min);
  const hi = Math.log10(axis.max);
  const v = Math.log10(Math.max(axis.min, Math.min(axis.max, seconds)));
  return (v - lo) / (hi - lo);
}

export const TICKS: { s: number; label: string }[] = [
  { s: 1, label: "1 s" },
  { s: 10, label: "10 s" },
  { s: 60, label: "1 min" },
  { s: 3_600, label: "1 h" },
  { s: 86_400, label: "1 day" },
];

/** Hedera services Levee uses. `scheduled` is shown only once two-party Scheduled signing is on build. */
export const SCHEDULED_ON_BUILD = false;
