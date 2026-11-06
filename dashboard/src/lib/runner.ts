// Client side of the demo runner (scripts/demo/runner.ts, proxied at /api/runner).
import { services } from "./config";

export type RunKind = "pay" | "attack" | "reopen";

export interface RunView {
  id: string;
  kind: RunKind;
  status: "running" | "ok" | "failed";
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  links: string[];
  lines?: string[];
}

export const RUN_BUTTONS: { kind: RunKind; label: string; cmd: string; primary?: boolean }[] = [
  { kind: "pay", label: "Pay 500 RUPC (normal)", cmd: "npx tsx scripts/demo/normal-path.ts" },
  { kind: "attack", label: "Steal 10,000 RUPC (attack)", cmd: "npx tsx scripts/attack.ts 10000", primary: true },
  { kind: "reopen", label: "Reopen (2 of 3)", cmd: "npx tsx scripts/reopen.ts treasury attacker" },
];

export async function startRun(kind: RunKind): Promise<{ ok: true; run: RunView } | { ok: false; error: string }> {
  try {
    const r = await fetch(`${services.runner}/run/${kind}`, { method: "POST" });
    const j = (await r.json()) as { ok: boolean; run?: RunView; error?: string };
    return j.ok && j.run ? { ok: true, run: j.run } : { ok: false, error: j.error ?? `HTTP ${r.status}` };
  } catch {
    return { ok: false, error: "demo runner is not running" };
  }
}

export async function getRun(id: string): Promise<RunView | null> {
  try {
    const r = await fetch(`${services.runner}/runs/${encodeURIComponent(id)}`);
    const j = (await r.json()) as { ok: boolean; run?: RunView };
    return j.ok && j.run ? j.run : null;
  } catch {
    return null;
  }
}

/** Short label for a HashScan link in the run log. */
export function linkLabel(url: string): string {
  const m = url.match(/hashscan\.io\/[a-z]+\/([a-z]+)\/(.+)$/);
  if (!m) return url;
  const id = m[2];
  return `${m[1]} ${id.length > 22 ? id.slice(0, 20) + "…" : id}`;
}
