// Shared helpers for the first-hour tests (t1..t4). Testnet only. Never prints keys.
import fs from "node:fs";
import path from "node:path";
import { decodeFunctionResult, encodeFunctionData, keccak256, toHex } from "viem";
import { readState, type DeployState } from "../../src/shared/config.js";
import { roleClient } from "../../src/shared/hedera.js";
import { ethCall, execContract, freezeStatus, mirror, sleep, type ExecResult } from "../../src/setup/net.js";
import { missingSteps, replaceSection } from "../../src/setup/plan.js";
import { controllerArtifact, revertAbis } from "../../src/setup/studio.js";

export const state: DeployState = readState();
{
  const todo = missingSteps(state as any);
  if (todo.length) {
    console.error(`setup incomplete (to do: ${todo.join(", ")}). Run npm run setup first.`);
    process.exit(2);
  }
}
export const ctrlAbi = controllerArtifact().abi;
const abis = revertAbis();

export type Role = "watcher" | "gate" | "admin0" | "admin1" | "admin2";

export function accountOf(role: Role): { id: string; evm: string } {
  if (role.startsWith("admin")) return state.admins[Number(role.slice(5))];
  return (state as any)[role];
}

export function incidentId(label: string): `0x${string}` {
  return keccak256(toHex(`${label}-${Date.now()}`));
}

/** Call a ContainmentController function as one of the demo accounts (HAPI ContractExecute). */
export async function callController(role: Role, fn: string, args: unknown[], gas?: number): Promise<ExecResult> {
  const data = encodeFunctionData({ abi: ctrlAbi, functionName: fn, args } as any);
  const acct = accountOf(role);
  const client = roleClient(role, acct.id);
  try {
    return await execContract(client, state.controller.contractId, data, {
      gas,
      from: acct.evm,
      to: state.controller.evm,
      minGas: 100_000,
      abis,
    });
  } finally {
    client.close();
  }
}

export async function readController(fn: string, args: unknown[] = []): Promise<any> {
  const data = encodeFunctionData({ abi: ctrlAbi, functionName: fn, args } as any);
  const out = await ethCall(state.controller.evm, data);
  return decodeFunctionResult({ abi: ctrlAbi, functionName: fn, data: out as `0x${string}` } as any);
}

/** Poll the mirror until the account's freeze status for the token equals `want`. */
export async function waitFreeze(accountId: string, want: "FROZEN" | "UNFROZEN", timeoutMs = 20_000): Promise<string> {
  const t0 = Date.now();
  let last = "?";
  while (Date.now() - t0 < timeoutMs) {
    last = (await freezeStatus(accountId, state.token.tokenId))?.freeze ?? "NOT_ASSOCIATED";
    if (last === want) return last;
    await sleep(1000);
  }
  return last;
}

export async function tokenPauseStatus(): Promise<string> {
  const t = await mirror<{ pause_status: string }>(`/api/v1/tokens/${state.token.tokenId}`);
  return t?.pause_status ?? "?";
}

export async function waitPause(want: "PAUSED" | "UNPAUSED", timeoutMs = 20_000): Promise<string> {
  const t0 = Date.now();
  let last = "?";
  while (Date.now() - t0 < timeoutMs) {
    last = await tokenPauseStatus();
    if (last === want) return last;
    await sleep(1000);
  }
  return last;
}

/** Reopen (unfreeze) an account with a 2-of-3 proposal: admin0 proposes, admin1 approves. */
export async function reopenAccount(evm: string, log: Log): Promise<boolean> {
  // Read the count BEFORE proposing: eth_call right after a tx can still see the old state.
  const before = (await readController("proposalCount")) as bigint;
  const p = await callController("admin0", "propose", [0, evm]);
  log.step("admin0 propose(Unfreeze)", p);
  if (!p.ok) return false;
  const id = before + 1n;
  // Fixed gas: the approving call also executes unfreeze via the Studio proxy (HTS precompile),
  // which a gas estimate taken before the proposal is visible does not include.
  const a = await callController("admin1", "approve", [id], 900_000);
  log.step(`admin1 approve(${id})`, a);
  return a.ok;
}

/** Collects steps and writes a PASS/FAIL section into docs/FIRST_HOUR_TESTS.md. */
export class Log {
  lines: string[] = [];
  failures: string[] = [];
  constructor(public id: string, public title: string) {
    console.log(`\n=== ${id}: ${title} ===`);
  }
  step(label: string, r: ExecResult, expectOk = true) {
    const pass = r.ok === expectOk;
    const detail = r.ok ? "SUCCESS" : `${r.status}${r.error ? ` / ${r.error}` : ""}`;
    const line = `- ${pass ? "PASS" : "FAIL"}: ${label} — expected ${expectOk ? "success" : "failure"}, got ${detail} ([${r.txId}](${r.link}))`;
    console.log(line.replace(/\[(.*?)\]\((.*?)\)/, "$2"));
    this.lines.push(line);
    if (!pass) this.failures.push(label);
    return pass;
  }
  check(label: string, pass: boolean, detail: string) {
    const line = `- ${pass ? "PASS" : "FAIL"}: ${label} — ${detail}`;
    console.log(line);
    this.lines.push(line);
    if (!pass) this.failures.push(label);
    return pass;
  }
  note(text: string) {
    console.log(text);
    this.lines.push(text);
  }
  finish(): void {
    const verdict = this.failures.length ? `FAIL (${this.failures.length}: ${this.failures.join("; ")})` : "PASS";
    console.log(`\n${this.id}: ${verdict}`);
    const body = `## ${this.id}: ${this.title}\n\n**Result: ${verdict}** — run ${new Date().toISOString()}\n\n${this.lines.join("\n")}`;
    const file = path.resolve("docs", "FIRST_HOUR_TESTS.md");
    const doc = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "# First-hour tests\n";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, replaceSection(doc, this.id, body));
    process.exitCode = this.failures.length ? 1 : 0;
  }
}
