// Leash agent: runs on each company machine. Every interval: 7 checks -> signed heartbeat -> checker.
// It never judges transactions; it only reports machine health. Usage:
//   npm run agent -- --machine laptop-1 --enrol      (once: key + baseline + register)
//   npm run agent -- --machine laptop-1              (loop)
//   npm run agent -- --machine laptop-1 --once --simulate-fail ports
import fs from "node:fs";
import { env } from "../shared/config.js";
import { CHECK_IDS, captureBaseline, runAllChecks, sha256, type Baseline, type CheckId, type CheckResult } from "./checks.js";
import { baselineFile, ensureKey, enrolMachine, nextSeq, sendHeartbeat, stateDir } from "./heartbeat.js";
import path from "node:path";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

function readBaseline(): Baseline | null {
  try {
    return JSON.parse(fs.readFileSync(baselineFile(), "utf8"));
  } catch {
    return null;
  }
}

/** --simulate-fail <id>, or state/simulate-<machine>.fail (edit while running for the live demo). */
function simulated(machine: string): CheckId | null {
  let id = arg("simulate-fail");
  try {
    id = fs.readFileSync(path.join(stateDir(), `simulate-${machine}.fail`), "utf8").trim() || id;
  } catch {
    /* none */
  }
  return CHECK_IDS.includes(id as CheckId) ? (id as CheckId) : null;
}

export function applySimulation(results: CheckResult[], id: CheckId | null): CheckResult[] {
  if (!id) return results;
  return results.map((r) => (r.id === id ? { ...r, ok: false, detail: `SIMULATED FAILURE (${r.detail})`, evidenceHash: sha256(`sim:${id}`) } : r));
}

async function tick(checker: string, machine: string, key: ReturnType<typeof ensureKey>) {
  const results = applySimulation(await runAllChecks(readBaseline()), simulated(machine));
  const bad = results.filter((r) => !r.ok);
  const res = await sendHeartbeat(checker, machine, key, results, nextSeq(machine));
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[agent ${stamp}] ${machine}: ${results.length - bad.length}/${results.length} checks ok -> checker ${res.status} ${JSON.stringify(res.body)}`);
  for (const r of bad) console.log(`   FAIL ${r.id}: ${r.detail}`);
}

async function main() {
  const machine = arg("machine");
  if (!machine) throw new Error("--machine <name> is required");
  const checker = arg("checker") ?? process.env.CHECKER_URL ?? `http://localhost:${env.checkerPort}`;
  const intervalS = Number(arg("interval") ?? env.heartbeatSeconds);
  const key = ensureKey(machine);

  if (has("enrol")) {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(baselineFile(), JSON.stringify(captureBaseline(), null, 2));
    const r = await enrolMachine(checker, machine, arg("role") ?? "employee", process.env.ENROL_TOKEN);
    console.log(`[agent] baseline saved; enrol -> ${r.status} ${JSON.stringify(r.body)}`);
    if (!r.ok && r.status !== 409) process.exitCode = 1;
  }
  if (has("once") || has("enrol")) {
    if (has("once")) await tick(checker, machine, key);
    return;
  }
  console.log(`[agent] ${machine} -> ${checker}, every ${intervalS}s`);
  for (;;) {
    try {
      await tick(checker, machine, key);
    } catch (e) {
      console.log(`[agent] heartbeat not sent: ${(e as Error).message} (the pass will simply expire)`);
    }
    await new Promise((r) => setTimeout(r, intervalS * 1000));
  }
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(`[agent] ${e.message}`);
    process.exit(1);
  });
}
