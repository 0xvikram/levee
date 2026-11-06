// Demo reset: put the demo back to a clean start after an attack.
//   1. Read the token pause status and the freeze status of the treasury, the attacker and both payees
//      on the Mirror Node.
//   2. If the token is paused: 2-of-3 Unpause first (freeze/unfreeze via Studio fail while paused).
//   3. Reopen (2-of-3 Unfreeze) only the accounts that are FROZEN.
//   4. Print one final JSON line: {"reset":true,"reopened":[...],"paused":false}
// Idempotent: with nothing frozen and the token unpaused it only prints {"reset":true,"reopened":[],"paused":false}.
// Usage: npx tsx scripts/demo/reset.ts   (testnet only; never prints keys)
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Target {
  name: string; // "treasury" | "attacker" | "payee0" | "payee1"
  id: string; // 0.0.x
  evm: string;
}

export interface MirrorLike {
  /** Freeze status for the token, e.g. "FROZEN" | "UNFROZEN" | "NOT_APPLICABLE"; null when not associated. */
  freeze(accountId: string): Promise<string | null>;
  /** Token pause status, e.g. "PAUSED" | "UNPAUSED" | "NOT_APPLICABLE". */
  pause(): Promise<string>;
}

export interface ResetPlan {
  unpause: boolean;
  reopen: Target[];
  statuses: Record<string, string>;
}

/** The demo accounts reset looks at, from state/deploy.json. */
export function targetsFrom(state: any): Target[] {
  const out: Target[] = [];
  const add = (name: string, a: any) => {
    if (a && typeof a.id === "string" && /^0\.0\.\d+$/.test(a.id)) out.push({ name, id: a.id, evm: a.evm });
  };
  add("treasury", state.treasury);
  add("attacker", state.attacker);
  (state.payees ?? []).forEach((p: any, i: number) => add(`payee${i}`, p));
  return out;
}

/** Decide what to do: unpause only when PAUSED, reopen only accounts that are FROZEN. */
export async function planReset(targets: Target[], m: MirrorLike): Promise<ResetPlan> {
  const statuses: Record<string, string> = {};
  const reopen: Target[] = [];
  for (const t of targets) {
    const s = (await m.freeze(t.id)) ?? "NOT_ASSOCIATED";
    statuses[t.name] = s;
    if (s === "FROZEN") reopen.push(t);
  }
  const p = await m.pause();
  statuses.token = p;
  return { unpause: p === "PAUSED", reopen, statuses };
}

async function main() {
  const c = await import("../tests/common.js");
  const { freezeStatus } = await import("../../src/setup/net.js");
  const { state } = c;
  const tokenId = state.token.tokenId;
  const log = new c.Log("RESET", "demo reset (2-of-3 unpause + reopen of frozen accounts)");
  const mirror: MirrorLike = {
    freeze: async (id) => (await freezeStatus(id, tokenId))?.freeze ?? null,
    pause: () => c.tokenPauseStatus(),
  };
  const plan = await planReset(targetsFrom(state), mirror);
  console.log(`status: ${Object.entries(plan.statuses).map(([k, v]) => `${k}=${v}`).join(" ")}`);

  let paused = plan.statuses.token === "PAUSED";
  if (plan.unpause) {
    const before = (await c.readController("proposalCount")) as bigint; // read before: eth_call lags
    const p = await c.callController("admin0", "propose", [1, "0x0000000000000000000000000000000000000000"]);
    log.step("admin0 propose(Unpause)", p);
    if (p.ok) {
      const a = await c.callController("admin1", "approve", [before + 1n], 900_000); // approve executes unpause
      log.step(`admin1 approve(${before + 1n})`, a);
    }
    paused = (await c.waitPause("UNPAUSED")) !== "UNPAUSED";
    log.check("token UNPAUSED", !paused, "pause_status");
  }

  const reopened: string[] = [];
  if (paused && plan.reopen.length) log.note("token still paused: skipping reopen (unfreeze fails while paused)");
  else
    for (const t of plan.reopen) {
      const ok = (await c.reopenAccount(t.evm, log)) && (await c.waitFreeze(t.id, "UNFROZEN")) === "UNFROZEN";
      log.check(`${t.name} unfrozen`, ok, t.id);
      if (ok) reopened.push(t.name);
    }
  if (!plan.unpause && !plan.reopen.length) console.log("nothing frozen, token not paused: nothing to do");
  const failed = log.failures.length > 0;
  console.log(JSON.stringify({ reset: !failed, reopened, paused }));
  process.exitCode = failed ? 1 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`reset error: ${e?.message ?? e}`);
    process.exitCode = 1;
  });
}
