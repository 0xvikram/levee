// HBAR balances of the accounts the demo spends from (Mirror Node, no keys needed).
// Usage: npx tsx scripts/demo/balances.ts [--json]
import { env, readState } from "../../src/shared/config.js";

const s = readState();
export async function hbarBalances(): Promise<Record<string, number>> {
  const accts: Record<string, string> = { operator: env.operatorId, gate: s.gate.id, treasury: s.treasury.id, watcher: s.watcher.id };
  const out: Record<string, number> = {};
  for (const [k, id] of Object.entries(accts)) {
    const r = await fetch(`${env.mirrorUrl}/api/v1/balances?account.id=${id}`);
    const j = (await r.json()) as { balances: { balance: number }[] };
    out[k] = (j.balances?.[0]?.balance ?? 0) / 1e8;
  }
  return out;
}
if (process.argv[1]?.endsWith("balances.ts")) {
  const b = await hbarBalances();
  console.log(process.argv.includes("--json") ? JSON.stringify(b) : Object.entries(b).map(([k, v]) => `${k.padEnd(9)} ${v.toFixed(4)} HBAR`).join("\n"));
}
