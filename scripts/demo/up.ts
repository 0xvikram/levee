// Bring the Levee demo up: checker (real Arkiv) -> agents -> watcher (WATCHER_SINCE=now) -> gate.
// Each service runs detached in its own process group; logs in state/logs/<name>.log, pids in
// state/demo.pids.json (scripts/demo/down.sh stops them). Usage:
//   npx tsx scripts/demo/up.ts [--memory] [--no-laptop] [--restart] [--allow-sleep]
// Env passes through (e.g. CAP_PER_DAY=200000 for the normal-load run, HEARTBEAT_SECONDS).
// /enrol is locked: a fresh random ENROL_TOKEN is made per run (unless one is set) and handed only to the
// processes this script spawns, through their environment. It is never printed or written to disk.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../../src/shared/config.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const LOGS = path.join(ROOT, "state/logs");
const PIDS = path.join(ROOT, "state/demo.pids.json");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");
const has = (f: string) => process.argv.includes(`--${f}`);

export const SERVER = { machine: "payouts-server", profile: "server" };
export const LAPTOP = { machine: "laptop-vikram", profile: "laptop" };
const url = (port: number) => `http://localhost:${port}`;
const CHECKER = url(env.checkerPort), WATCHER = url(env.watcherPort), GATE = url(env.gatePort);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pids: Record<string, number> = fs.existsSync(PIDS) ? JSON.parse(fs.readFileSync(PIDS, "utf8")) : {};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function start(name: string, args: string[], extraEnv: Record<string, string> = {}) {
  fs.mkdirSync(LOGS, { recursive: true });
  const log = path.join(LOGS, `${name}.log`);
  const fd = fs.openSync(log, "a");
  fs.writeSync(fd, `\n===== ${new Date().toISOString()} start ${name} =====\n`);
  const child = spawn(TSX, args, { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, ...extraEnv } });
  child.unref();
  pids[name] = child.pid!;
  fs.writeFileSync(PIDS, JSON.stringify(pids, null, 2));
  console.log(`  started ${name.padEnd(16)} pid ${child.pid}  log state/logs/${name}.log`);
}

async function waitFor(what: string, fn: () => Promise<boolean>, timeoutS: number, logName?: string) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutS * 1000) {
    try {
      if (await fn()) {
        console.log(`  ok: ${what} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
        return;
      }
    } catch {
      /* not up yet */
    }
    if (logName && pids[logName] && !alive(pids[logName])) break;
    await sleep(1000);
  }
  const tail = logName ? fs.readFileSync(path.join(LOGS, `${logName}.log`), "utf8").split("\n").slice(-15).join("\n") : "";
  throw new Error(`timed out waiting for ${what}${tail ? `\n--- last lines of state/logs/${logName}.log ---\n${tail}` : ""}`);
}

const getJson = async (u: string) => {
  const r = await fetch(u, { signal: AbortSignal.timeout(5000) });
  return { status: r.status, body: (await r.json()) as any };
};

function enrolled(machine: string): boolean {
  const f = path.join(ROOT, "state/checker-machines.json");
  if (!fs.existsSync(f) || !fs.existsSync(path.join(ROOT, `state/machine-${machine}.key`))) return false;
  return (JSON.parse(fs.readFileSync(f, "utf8")) as { machine: string }[]).some((m) => m.machine === machine);
}

async function main() {
  const running = Object.entries(pids).filter(([, p]) => alive(p));
  if (running.length && !has("restart")) {
    throw new Error(`demo already running (${running.map(([n]) => n).join(", ")}): run scripts/demo/down.sh first, or pass --restart`);
  }
  if (running.length) spawnSync(path.join(ROOT, "scripts/demo/down.sh"), { stdio: "inherit" });
  for (const k of Object.keys(pids)) delete pids[k];

  // Keep the Mac awake while the demo runs: idle sleep paused every service mid-way through the
  // 300-transfer run (docs/LIVE_RUN.md). caffeinate is in its own process group, so down.sh stops it.
  if (process.platform === "darwin" && !has("allow-sleep")) {
    const c = spawn("caffeinate", ["-i", "-m", "-s"], { detached: true, stdio: "ignore" });
    c.unref();
    pids.caffeinate = c.pid!;
    fs.writeFileSync(PIDS, JSON.stringify(pids, null, 2));
    console.log(`  caffeinate (no idle sleep while the demo runs) pid ${c.pid}`);
  }
  // Lock /enrol for this run. Children inherit it via process.env; machines already enrolled keep their key.
  if (!process.env.ENROL_TOKEN) process.env.ENROL_TOKEN = randomBytes(24).toString("hex");
  console.log(`Levee demo up (caps: ${env.capPerTransfer} RUPC per transfer, ${env.capPerDay} RUPC per day)`);
  start("checker", ["src/checker/server.ts", ...(has("memory") ? ["--memory"] : [])]);
  await waitFor("checker answering", async () => (await getJson(`${CHECKER}/passes`)).status === 200, 30, "checker");

  const machines = has("no-laptop") ? [SERVER] : [SERVER, LAPTOP];
  for (const m of machines) {
    if (enrolled(m.machine)) continue;
    const r = spawnSync(TSX, ["src/agent/index.ts", "--machine", m.machine, "--profile", m.profile, "--enrol", "--role", m.profile === "server" ? "payouts" : "employee"], { cwd: ROOT, encoding: "utf8", env: process.env });
    console.log(`  enrol ${m.machine}: ${(r.stdout + r.stderr).trim().split("\n").pop()}`);
    if (r.status !== 0) throw new Error(`enrol ${m.machine} failed`);
  }

  start("watcher", ["src/watcher/index.ts"], { WATCHER_SINCE: "now" });
  for (const m of machines) start(`agent-${m.machine}`, ["src/agent/index.ts", "--machine", m.machine, "--profile", m.profile]);
  start("gate", ["src/gate/server.ts"]);

  await waitFor("watcher /health ok", async () => (await getJson(`${WATCHER}/health`)).body.ok === true, 90, "watcher");
  await waitFor("gate /health ok", async () => (await getJson(`${GATE}/health`)).body.ok === true, 60, "gate");
  await waitFor(`${SERVER.machine} pass live on Arkiv`, async () => (await getJson(`${CHECKER}/pass/${SERVER.machine}`)).body.live === true, 120, `agent-${SERVER.machine}`);
  if (!has("no-laptop")) {
    await waitFor(`${LAPTOP.machine} first heartbeat`, async () => (await getJson(`${CHECKER}/pass/${LAPTOP.machine}`)).body.lastHeartbeatAt != null, 90, `agent-${LAPTOP.machine}`);
    const p = (await getJson(`${CHECKER}/pass/${LAPTOP.machine}`)).body;
    console.log(`  ${LAPTOP.machine}: live=${p.live} kind=${p.kind} reason=${p.reason ?? "-"}`);
  }
  const sp = (await getJson(`${CHECKER}/pass/${SERVER.machine}`)).body;
  console.log(`  ${SERVER.machine}: live=${sp.live} expires ${sp.expiresAt} entity ${sp.arkivEntityKey}`);
  console.log(`
Levee demo is up.
  gate     ${GATE}     POST /request  GET /health  GET /events (SSE)
  watcher  ${WATCHER}     GET /state  GET /health  GET /events (SSE)
  checker  ${CHECKER}     GET /passes  GET /pass/:machine  GET /events (SSE)
  logs     state/logs/   stop: scripts/demo/down.sh`);
}

main().catch((e) => {
  console.error(`demo up failed: ${(e as Error).message}`);
  console.error("services already started are still running: scripts/demo/down.sh stops them");
  process.exit(1);
});
