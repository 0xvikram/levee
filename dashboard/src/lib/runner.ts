// Client side of the demo runner (scripts/demo/runner.ts, proxied at /api/runner).
import { useCallback, useEffect, useState } from "react";
import { services } from "./config";
import { usePoll } from "./hooks";

export type RunKind = "pay" | "attack" | "mint" | "reopen" | "reset";

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
  { kind: "pay", label: "Send 500 to Asha Pay", cmd: "npm run request -- --machine payouts-server --to <payee0> --amount 500" },
  { kind: "attack", label: "Simulate theft", cmd: "npx tsx scripts/attack.ts 10000", primary: true },
  { kind: "mint", label: "Fake mint", cmd: "npx tsx scripts/attack-mint.ts 5000" },
  { kind: "reopen", label: "Reopen (2 of 3)", cmd: "npx tsx scripts/reopen.ts treasury attacker" },
  { kind: "reset", label: "Reset demo", cmd: "npx tsx scripts/demo/reset.ts" },
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

/**
 * The demo runner from the page: is it up, the current run (polled while running), and start().
 * `enabled` false (chain mode) never touches the runner.
 */
export function useRunner(enabled: boolean, onChange?: (r: RunView) => void) {
  const health = usePoll<{ ok: boolean; busy: RunView | null }>(enabled ? `${services.runner}/health` : "", 10_000, 3000);
  const [run, setRun] = useState<RunView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!run || run.status !== "running") return;
    let alive = true;
    const t = setInterval(async () => {
      const r = await getRun(run.id);
      if (alive && r) setRun(r);
    }, 700);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [run?.id, run?.status]);

  useEffect(() => {
    if (run) onChange?.(run);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, run?.status, run?.links.length]);

  const start = useCallback(async (kind: RunKind) => {
    setError(null);
    const r = await startRun(kind);
    if (r.ok) setRun({ ...r.run, lines: [] });
    else setError(r.error);
    return r.ok;
  }, []);

  const busy = run?.status === "running" || (!!health.data?.busy && health.data.busy.id !== run?.id);
  return { up: enabled && health.ok, run, error, busy, start };
}
