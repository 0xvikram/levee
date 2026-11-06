// Demo runner: lets the dashboard's three demo buttons run the fixed demo actions.
//   POST /run/pay     -> gate POST /request: 500 RUPC from payouts-server to payee0
//   POST /run/attack  -> npx tsx scripts/attack.ts 10000
//   POST /run/reopen  -> npx tsx scripts/reopen.ts treasury attacker
//   GET  /runs/:id    -> one run (status, log lines, HashScan links)
//   GET  /events      -> SSE: "run" (status changes) and "line" (stdout/stderr lines)
// Safety: refuses to start unless DEMO_MODE=1, binds 127.0.0.1 only, CORS + Origin check limited
// to the dashboard origins, one run at a time, no request input reaches argv, no shell.
// Usage: DEMO_MODE=1 npm run demo:runner
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";

export const HOST = "127.0.0.1";
export const PORT = Number(process.env.DEMO_RUNNER_PORT ?? 8713);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export type RunKind = "pay" | "attack" | "reopen";
export const RUN_KINDS: readonly RunKind[] = ["pay", "attack", "reopen"];

/** The only commands the runner ever spawns. Fixed argv, no shell, nothing from the request. */
export const SPAWN_ARGV: Readonly<Record<Exclude<RunKind, "pay">, readonly string[]>> = Object.freeze({
  attack: Object.freeze(["npx", "tsx", "scripts/attack.ts", "10000"]),
  reopen: Object.freeze(["npx", "tsx", "scripts/reopen.ts", "treasury", "attacker"]),
});

export function isRunKind(k: unknown): k is RunKind {
  return typeof k === "string" && (RUN_KINDS as readonly string[]).includes(k);
}

/** argv for a run kind, or null for anything outside the allow-list (pay is an HTTP call, not a spawn). */
export function argvFor(kind: unknown): readonly string[] | null {
  if (kind === "attack" || kind === "reopen") return SPAWN_ARGV[kind];
  return null;
}

export function assertDemoMode(env: NodeJS.ProcessEnv): void {
  if (env.DEMO_MODE !== "1") throw new Error("demo runner refused: set DEMO_MODE=1 to start it (it can move testnet funds)");
}

export function allowedOrigins(env: NodeJS.ProcessEnv): string[] {
  const extra = (env.DEMO_ORIGIN ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const base = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173"];
  return [...new Set([...base, ...extra])];
}

const HASHSCAN = /https:\/\/hashscan\.io\/[a-z]+\/[a-z]+\/[0-9.\-]+/g;
export function linksIn(line: string): string[] {
  return line.match(HASHSCAN) ?? [];
}

export interface Run {
  id: string;
  kind: RunKind;
  status: "running" | "ok" | "failed";
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  lines: string[];
  links: string[];
}

export interface RunnerDeps {
  /** Starts a fixed command; calls onLine per output line and onExit once. */
  spawnFixed: (argv: readonly string[], onLine: (l: string) => void, onExit: (code: number | null) => void) => void;
  /** The pay action (gate request). Resolves when done; ok=false marks the run failed. */
  pay: (log: (l: string) => void) => Promise<boolean>;
  origins: string[];
}

export function createRunner(deps: RunnerDeps) {
  const runs = new Map<string, Run>();
  const clients = new Set<Response>();
  let current: Run | null = null;
  let seq = 0;

  const send = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(frame);
  };
  const summary = (r: Run) => ({ id: r.id, kind: r.kind, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt, exitCode: r.exitCode, links: r.links });

  const log = (r: Run, line: string) => {
    const l = line.replace(/\s+$/, "");
    if (!l) return;
    r.lines.push(l);
    if (r.lines.length > 400) r.lines.shift();
    for (const u of linksIn(l)) if (!r.links.includes(u)) r.links.push(u);
    send("line", { id: r.id, line: l });
  };
  const finish = (r: Run, ok: boolean, code?: number | null) => {
    r.status = ok ? "ok" : "failed";
    r.endedAt = new Date().toISOString();
    if (code !== undefined) r.exitCode = code;
    if (current === r) current = null;
    send("run", summary(r));
  };

  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      if (!deps.origins.includes(origin)) return void res.status(403).json({ ok: false, error: "origin not allowed" });
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST");
      return void res.status(204).end();
    }
    next();
  });

  app.get("/health", (_req, res) => res.json({ ok: true, service: "demo-runner", busy: current ? summary(current) : null }));

  app.post("/run/:kind", (req: Request, res: Response) => {
    const kind = req.params.kind;
    if (!isRunKind(kind)) return void res.status(404).json({ ok: false, error: "unknown run" });
    if (current) return void res.status(409).json({ ok: false, error: "a run is already in progress", run: summary(current) });
    const run: Run = { id: `${Date.now().toString(36)}-${++seq}`, kind, status: "running", startedAt: new Date().toISOString(), lines: [], links: [] };
    runs.set(run.id, run);
    if (runs.size > 30) runs.delete(runs.keys().next().value!);
    current = run;
    send("run", summary(run));
    if (kind === "pay") {
      deps.pay((l) => log(run, l)).then(
        (ok) => finish(run, ok),
        (e: unknown) => {
          log(run, `error: ${e instanceof Error ? e.message : String(e)}`);
          finish(run, false);
        },
      );
    } else {
      const argv = argvFor(kind)!;
      log(run, `$ ${argv.join(" ")}`);
      deps.spawnFixed(argv, (l) => log(run, l), (code) => finish(run, code === 0, code));
    }
    res.status(202).json({ ok: true, run: summary(run) });
  });

  app.get("/runs/:id", (req, res) => {
    const r = runs.get(req.params.id);
    if (!r) return void res.status(404).json({ ok: false, error: "no such run" });
    res.json({ ok: true, run: { ...summary(r), lines: r.lines } });
  });

  app.get("/events", (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": connected\n\n");
    const last = [...runs.values()].at(-1);
    if (last) res.write(`event: run\ndata: ${JSON.stringify({ ...summary(last), lines: last.lines.slice(-80) })}\n\n`);
    clients.add(res);
    const ka = setInterval(() => res.write(": ka\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ka);
      clients.delete(res);
    });
  });

  return { app, runs, busy: () => current };
}

// ---------------------------------------------------------------- real deps

function readDeploy(): { payee: string; machine: string } {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, "state/deploy.json"), "utf8"));
  const payee = s.payees?.[0]?.id;
  if (typeof payee !== "string" || !/^0\.0\.\d+$/.test(payee)) throw new Error("state/deploy.json has no payees[0].id");
  const m = s.machines?.server ?? s.machines?.[0]?.machine ?? "payouts-server";
  return { payee, machine: typeof m === "string" && /^[a-z0-9-]{1,40}$/.test(m) ? m : "payouts-server" };
}

function spawnFixed(argv: readonly string[], onLine: (l: string) => void, onExit: (code: number | null) => void) {
  const child = spawn(argv[0], argv.slice(1), { cwd: ROOT, shell: false, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const pipe = (stream: NodeJS.ReadableStream) => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (d: string) => {
      buf += d;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? "";
      parts.forEach(onLine);
    });
    stream.on("end", () => buf && onLine(buf));
  };
  pipe(child.stdout!);
  pipe(child.stderr!);
  child.on("error", (e) => {
    onLine(`error: ${e.message}`);
    onExit(null);
  });
  child.on("close", (code) => onExit(code));
}

async function pay(log: (l: string) => void): Promise<boolean> {
  const { payee, machine } = readDeploy();
  const gate = `http://127.0.0.1:${Number(process.env.GATE_PORT ?? 8710)}`;
  const amount = "500000000"; // 500 RUPC, 6 decimals
  log(`${machine} asks the gate for 500 RUPC -> ${payee}`);
  const t0 = Date.now();
  const r = await fetch(`${gate}/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ machine, to: payee, amount, kind: "transfer" }),
    signal: AbortSignal.timeout(60_000),
  });
  const b = (await r.json()) as { ok: boolean; reason?: string; detail?: string; txId?: string; receiptTxId?: string; receipt?: { sequence?: number } };
  if (!b.ok) {
    log(`refused at gate: ${b.reason}${b.detail ? ` (${b.detail})` : ""} · HTTP ${r.status}`);
    if (b.txId) log(`transfer https://hashscan.io/testnet/transaction/${b.txId}`);
    return false;
  }
  log(`receipt written to HCS (seq ${b.receipt?.sequence ?? "?"})`);
  if (b.receiptTxId) log(`receipt https://hashscan.io/testnet/transaction/${b.receiptTxId}`);
  log(`transfer https://hashscan.io/testnet/transaction/${b.txId}`);
  log(`done in ${Date.now() - t0} ms; the watcher will match it to the receipt`);
  return true;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    assertDemoMode(process.env);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const { app } = createRunner({ spawnFixed, pay, origins: allowedOrigins(process.env) });
  app.listen(PORT, HOST, () => console.log(`demo runner on http://${HOST}:${PORT} (DEMO_MODE=1)`));
}
