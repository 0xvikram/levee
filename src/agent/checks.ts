// Layer 1 "Leash": the 7 health checks a company machine runs every heartbeat (macOS).
// Parsers are pure (tested with captured output in tests/agent/fixtures). The exec wrappers are thin:
// child_process.execFile only, no shell, read-only commands only.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type CheckId = "persistence" | "remote-access" | "ports" | "devtools" | "protections" | "disk" | "extensions";
export const CHECK_IDS: CheckId[] = ["persistence", "remote-access", "ports", "devtools", "protections", "disk", "extensions"];

export interface CheckResult {
  id: CheckId;
  ok: boolean;
  detail: string;
  evidenceHash: string; // sha256 hex of the raw evidence behind the verdict
}

export interface Baseline {
  createdAt: string;
  persistence: { hash: string; entries: string[] };
  tools: Record<string, string>; // tool name or shim path -> sha256 of the resolved binary
}

/**
 * Machine profiles. A laptop runs all 7 checks. A server or CI runner has no person at a keyboard,
 * so the laptop-only checks are skipped: disk encryption (servers are protected by the data
 * centre / cloud volume encryption, and FileVault is a per-user laptop control), editor
 * extensions (nobody installs VS Code extensions on a payouts server), and remote-access apps
 * (servers are reached over the ops path, not AnyDesk/Parsec). Persistence, ports, dev-tool
 * integrity and OS protections apply everywhere. The profile is fixed at enrolment: the checker
 * stores it and ignores what later heartbeats claim, so a laptop cannot downgrade itself.
 */
export type Profile = "laptop" | "server" | "ci";
export const PROFILES: Profile[] = ["laptop", "server", "ci"];
export const LAPTOP_ONLY: CheckId[] = ["disk", "extensions", "remote-access"];
export function checksFor(profile: Profile): CheckId[] {
  return profile === "laptop" ? [...CHECK_IDS] : CHECK_IDS.filter((c) => !LAPTOP_ONLY.includes(c));
}
export const isProfile = (v: unknown): v is Profile => typeof v === "string" && (PROFILES as string[]).includes(v);

export const REMOTE_TOOLS = ["AnyDesk", "TeamViewer", "RustDesk", "ScreenConnect", "Splashtop", "Parsec"];
export const SENSITIVE_PORTS = [22, 3389, 5900, 2375, 6379, 8888, 9222, 9229, 5432, 6443, 10250];
export const EXTENSION_WINDOW_MS = 24 * 3600 * 1000;

export const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

// ---------- pure parsers ----------

export interface DirEntry {
  dir: string;
  name: string;
  mtimeMs: number;
}

/** Stable hash of file names + mtimes (seconds), order independent. */
export function persistenceSnapshot(entries: DirEntry[]): { hash: string; entries: string[] } {
  const lines = entries.map((e) => `${e.dir}/${e.name}@${Math.floor(e.mtimeMs / 1000)}`).sort();
  return { hash: sha256(lines.join("\n")), entries: lines };
}

export function evaluatePersistence(current: { hash: string; entries: string[] }, baseline: Baseline | null): CheckResult {
  if (!baseline) return { id: "persistence", ok: false, detail: "no baseline (run --enrol)", evidenceHash: current.hash };
  if (current.hash === baseline.persistence.hash) {
    return { id: "persistence", ok: true, detail: `${current.entries.length} launch items match baseline`, evidenceHash: current.hash };
  }
  const base = new Set(baseline.persistence.entries);
  const now = new Set(current.entries);
  const added = current.entries.filter((e) => !base.has(e)).map(stripMtime);
  const removed = baseline.persistence.entries.filter((e) => !now.has(e)).map(stripMtime);
  const detail = `launch items changed: +${added.length} -${removed.length} (${[...added, ...removed].slice(0, 3).join(", ")})`;
  return { id: "persistence", ok: false, detail, evidenceHash: current.hash };
}
const stripMtime = (e: string) => e.replace(/@\d+$/, "");

/** App bundle names (e.g. "AnyDesk.app") that match a remote-access tool. */
export function matchRemoteApps(appNames: string[]): string[] {
  return REMOTE_TOOLS.filter((t) => appNames.some((a) => a.toLowerCase().replace(/\.app$/, "").includes(t.toLowerCase())));
}

/** `pgrep -il <pattern>` output: lines "pid name". Returns matched tool names. */
export function matchRemoteProcesses(pgrepOut: string): string[] {
  const lower = pgrepOut.toLowerCase();
  return REMOTE_TOOLS.filter((t) => lower.includes(t.toLowerCase()));
}

export function evaluateRemoteAccess(apps: string[], running: string[]): CheckResult {
  const all = [...new Set([...apps, ...running])];
  const detail = all.length ? `remote-access tools present: ${all.join(", ")}${running.length ? ` (running: ${running.join(", ")})` : ""}` : "no remote-access tools found";
  return { id: "remote-access", ok: all.length === 0, detail, evidenceHash: sha256(JSON.stringify({ apps, running })) };
}

export interface Listener {
  address: string;
  port: number;
  process: string;
}

const isLoopback = (a: string) => a === "localhost" || a === "::1" || a.startsWith("127.");

/** Parses `netstat -anv -p tcp` LISTEN lines. Local address looks like `*.22`, `127.0.0.1.7768`, `::1.8080`. */
export function parseListeners(netstat: string): Listener[] {
  const out: Listener[] = [];
  for (const line of netstat.split("\n")) {
    if (!/^tcp/.test(line) || !/\sLISTEN\s/.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols[3];
    const dot = local.lastIndexOf(".");
    if (dot < 0) continue;
    const port = Number(local.slice(dot + 1));
    if (!Number.isInteger(port)) continue;
    const proc = /LISTEN\s+\d+\s+\d+\s+\d+\s+\d+\s+(.+?):(\d+)\s+[0-9a-f]{5}\s/.exec(line)?.[1] ?? "unknown";
    out.push({ address: local.slice(0, dot), port, process: proc });
  }
  return out;
}

export function exposedSensitive(listeners: Listener[], allow: number[] = []): Listener[] {
  return listeners.filter((l) => !isLoopback(l.address) && SENSITIVE_PORTS.includes(l.port) && !allow.includes(l.port));
}

/**
 * LEVEE_ALLOW_PORTS="5432,6379": sensitive ports a machine is EXPECTED to expose (a DB host).
 * Off by default; documented in docs/LEASH.md. Allowed ports are named in the check detail so
 * the exception is always visible in the evidence.
 */
export function parseAllowPorts(v: string | undefined): number[] {
  return (v ?? "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
}
const allowedPortsFromEnv = () => parseAllowPorts(process.env.LEVEE_ALLOW_PORTS);

export function evaluatePorts(netstat: string, allow: number[] = []): CheckResult {
  const bad = exposedSensitive(parseListeners(netstat), allow);
  const uniq = [...new Set(bad.map((b) => `${b.port}/${b.process}`))];
  return {
    id: "ports",
    ok: bad.length === 0,
    detail:
      (bad.length ? `sensitive ports exposed beyond loopback: ${uniq.join(", ")}` : "no sensitive port exposed") +
      (allow.length ? ` (allowlisted: ${allow.join(", ")})` : ""),
    evidenceHash: allow.length ? sha256(JSON.stringify({ exposed: uniq.sort(), allow })) : sha256(JSON.stringify(uniq.sort())),
  };
}

export const parseSpctl = (out: string): boolean => /assessments enabled/i.test(out);
export const parseCsrutil = (out: string): boolean => /status:\s*enabled/i.test(out);
export const parseFdesetup = (out: string): boolean => /FileVault is On/i.test(out);

export function evaluateProtections(spctl: string, csrutil: string): CheckResult {
  const gk = parseSpctl(spctl);
  const sip = parseCsrutil(csrutil);
  const problems = [gk ? "" : "Gatekeeper disabled", sip ? "" : "SIP disabled"].filter(Boolean);
  return {
    id: "protections",
    ok: gk && sip,
    detail: problems.length ? problems.join(", ") : "Gatekeeper and SIP enabled",
    evidenceHash: sha256(`${spctl.trim()}|${csrutil.trim()}`),
  };
}

export function evaluateDisk(fdesetup: string): CheckResult {
  const on = parseFdesetup(fdesetup);
  return { id: "disk", ok: on, detail: on ? "FileVault on" : "FileVault off (disk not encrypted)", evidenceHash: sha256(fdesetup.trim()) };
}

export interface ExtEntry {
  dir: string;
  name: string;
  mtimeMs: number;
}

export function recentExtensions(entries: ExtEntry[], nowMs: number, windowMs = EXTENSION_WINDOW_MS): ExtEntry[] {
  return entries.filter((e) => e.name !== "extensions.json" && !e.name.startsWith(".") && nowMs - e.mtimeMs <= windowMs);
}

/** `npm ls -g --depth=0` output: count of "├──"/"└──" package lines. */
export function countNpmGlobals(out: string): number {
  return out.split("\n").filter((l) => /^[├└]── /.test(l)).length;
}

export function evaluateExtensions(recent: ExtEntry[], npmGlobalCount: number): CheckResult {
  const names = recent.map((r) => r.name).sort();
  return {
    id: "extensions",
    ok: recent.length === 0,
    detail: recent.length ? `${recent.length} editor extension(s) added in last 24h: ${names.slice(0, 3).join(", ")}` : `no new editor extensions (npm globals: ${npmGlobalCount})`,
    evidenceHash: sha256(JSON.stringify({ names, npmGlobalCount })),
  };
}

export function evaluateDevtools(current: Record<string, string>, baseline: Baseline | null): CheckResult {
  if (!baseline) return { id: "devtools", ok: false, detail: "no baseline (run --enrol)", evidenceHash: sha256(JSON.stringify(current)) };
  const changed: string[] = [];
  for (const [k, v] of Object.entries(current)) {
    if (baseline.tools[k] !== v) changed.push(k);
  }
  for (const k of Object.keys(baseline.tools)) if (!(k in current)) changed.push(`${k} (missing)`);
  return {
    id: "devtools",
    ok: changed.length === 0,
    detail: changed.length ? `dev tool binaries changed: ${changed.slice(0, 4).join(", ")}` : `${Object.keys(current).length} dev tool binaries match baseline`,
    evidenceHash: sha256(JSON.stringify(Object.entries(current).sort())),
  };
}

// ---------- thin exec / fs wrappers ----------

export function run(cmd: string, args: string[], timeoutMs = 15000): Promise<string> {
  return new Promise((resolve) => {
    // Many of these tools exit non-zero when the answer is "no" (pgrep with no match), so always resolve stdout.
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (_err, stdout, stderr) => resolve(String(stdout) + (stdout ? "" : String(stderr))));
  });
}

function listDir(dir: string): DirEntry[] {
  try {
    return fs.readdirSync(dir).map((name) => ({ dir, name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs }));
  } catch {
    return [];
  }
}

const home = () => os.homedir();
export const persistenceDirs = () => [path.join(home(), "Library/LaunchAgents"), "/Library/LaunchAgents", "/Library/LaunchDaemons"];

export function collectPersistence() {
  // Dir names are home-relative so a baseline survives, and the evidence has no username in it.
  const entries = persistenceDirs().flatMap(listDir).map((e) => ({ ...e, dir: e.dir.replace(home(), "~") }));
  return persistenceSnapshot(entries);
}

const hashCache = new Map<string, { sig: string; hash: string }>();
function hashFile(file: string): string | null {
  try {
    const real = fs.realpathSync(file);
    const st = fs.statSync(real);
    const sig = `${st.size}:${st.mtimeMs}`;
    const hit = hashCache.get(real);
    if (hit && hit.sig === sig) return hit.hash;
    const hash = sha256(fs.readFileSync(real));
    hashCache.set(real, { sig, hash });
    return hash;
  } catch {
    return null;
  }
}

function resolveOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

export function collectToolHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of ["node", "python3", "git", "npm", "brew"]) {
    const p = t === "brew" ? ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find((x) => fs.existsSync(x)) ?? null : resolveOnPath(t);
    const h = p ? hashFile(p) : null;
    if (h) out[t] = h;
  }
  const shimDir = path.join(home(), ".pyenv/shims");
  for (const e of listDir(shimDir)) {
    const h = hashFile(path.join(shimDir, e.name));
    if (h) out[`~/.pyenv/shims/${e.name}`] = h;
  }
  return out;
}

export async function collectExtensions(nowMs = Date.now()) {
  const entries: ExtEntry[] = [".vscode", ".cursor"].flatMap((d) => listDir(path.join(home(), d, "extensions")));
  const npmOut = await run("npm", ["ls", "-g", "--depth=0"], 30000);
  return evaluateExtensions(recentExtensions(entries, nowMs), countNpmGlobals(npmOut));
}

export async function collectRemoteAccess(): Promise<CheckResult> {
  const apps = matchRemoteApps(listDir("/Applications").map((e) => e.name));
  const pgrep = await run("pgrep", ["-il", REMOTE_TOOLS.map((t) => t.toLowerCase()).join("|")]);
  return evaluateRemoteAccess(apps, matchRemoteProcesses(pgrep));
}

/** Snapshot of everything baseline-able. Written by `--enrol`. */
export function captureBaseline(): Baseline {
  return { createdAt: new Date().toISOString(), persistence: collectPersistence(), tools: collectToolHashes() };
}

export async function runAllChecks(baseline: Baseline | null, profile: Profile = "laptop"): Promise<CheckResult[]> {
  const want = new Set(checksFor(profile));
  const skip = Promise.resolve(null);
  const [netstat, spctl, csrutil, fde, remote, ext] = await Promise.all([
    run("netstat", ["-anv", "-p", "tcp"]),
    run("spctl", ["--status"]),
    run("csrutil", ["status"]),
    want.has("disk") ? run("fdesetup", ["status"]) : skip,
    want.has("remote-access") ? collectRemoteAccess() : skip,
    want.has("extensions") ? collectExtensions() : skip,
  ]);
  const all: (CheckResult | null)[] = [
    evaluatePersistence(collectPersistence(), baseline),
    remote,
    evaluatePorts(netstat, allowedPortsFromEnv()),
    evaluateDevtools(collectToolHashes(), baseline),
    evaluateProtections(spctl, csrutil),
    fde === null ? null : evaluateDisk(fde),
    ext,
  ];
  return all.filter((r): r is CheckResult => r !== null && want.has(r.id));
}
