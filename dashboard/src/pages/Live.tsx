import { useEffect, useReducer, useState } from "react";
import { HeroMedia } from "../components/HeroMedia";
import { Link } from "../components/router";
import { deploy, hashscan, services } from "../lib/config";
import { feedReducer, initialFeed, isLiveBreach, REASONS, type FeedRow } from "../lib/feed";
import { countdown, formatAmount, shortTx, stopwatch } from "../lib/format";
import { useEventSource, useNow, usePoll, usePrefersReducedMotion } from "../lib/hooks";
import { freezeStatus, latestIncident, type FreezeStatus } from "../lib/mirror";
import { passesReducer, passLeftMs } from "../lib/passes";
import { containReducer, elapsedMs, initialContain, stepLabel, type ContainState } from "../lib/stopwatch";
import type { BreachView, CheckerEvent, GateDecision, Incident, Movement, PassView, WatcherSnapshot } from "../lib/types";

const PASS_SECONDS = 180;
const fmt = (raw: string) => formatAmount(raw, deploy.token.decimals);
const sym = deploy.token.symbol;

export function Live() {
  const reduced = usePrefersReducedMotion();
  const [feed, feedDispatch] = useReducer(feedReducer, initialFeed);
  const [contain, containDispatch] = useReducer(containReducer, initialContain);
  const [passes, passesDispatch] = useReducer(passesReducer, {});
  const [lagMs, setLagMs] = useState<number | null>(null);

  // ---- watcher: snapshot (poll) + live events
  const wState = usePoll<WatcherSnapshot>(`${services.watcher}/state`, 10_000);
  useEffect(() => {
    if (!wState.data) return;
    feedDispatch({ type: "snapshot", snapshot: wState.data });
    containDispatch({ type: "snapshot", snapshot: wState.data });
    if (wState.data.lagMs !== null && wState.data.lagMs !== undefined) setLagMs(wState.data.lagMs);
  }, [wState.data]);

  const wSse = useEventSource(`${services.watcher}/events`, {
    matched: (d) => feedDispatch({ type: "matched", movement: d as Movement }),
    breach: (d) => {
      feedDispatch({ type: "breach", breach: d as BreachView });
      containDispatch({ type: "breach", breach: d as BreachView });
    },
    detected: (d) => {
      const x = d as { incidentId: string; detectedMs: number; breaches?: BreachView[] };
      containDispatch({ type: "detected", incidentId: x.incidentId, detectedMs: x.detectedMs, breaches: x.breaches });
    },
    plan: (d) => {
      const x = d as { incidentId: string; steps: unknown[] };
      containDispatch({ type: "plan", incidentId: x.incidentId, steps: x.steps ?? [] });
    },
    step: (d) => {
      const x = d as { incidentId: string; step: string; account?: string; amount?: string; txId?: string; atMs: number };
      containDispatch({ type: "step", step: { ...x, ok: true } });
    },
    incident: (d) => {
      feedDispatch({ type: "incident", incident: d as Incident });
      containDispatch({ type: "incident", incident: d as Incident });
    },
    health: (d) => {
      const x = d as { lagMs?: number };
      if (typeof x.lagMs === "number" && Number.isFinite(x.lagMs)) setLagMs(x.lagMs);
    },
  });

  // ---- gate: decisions
  const gHealth = usePoll<{ ok: boolean; served?: number; spentToday?: string; capPerDay?: string }>(`${services.gate}/health`, 5_000);
  useEventSource(`${services.gate}/events`, {
    decision: (d) => feedDispatch({ type: "decision", decision: d as GateDecision }),
  });

  // ---- checker: passes
  const cPasses = usePoll<PassView[]>(`${services.checker}/passes`, 10_000);
  useEffect(() => {
    if (Array.isArray(cPasses.data)) passesDispatch({ type: "snapshot", passes: cPasses.data });
  }, [cPasses.data]);
  useEventSource(`${services.checker}/events`, {
    message: (d) => passesDispatch({ type: "event", event: d as CheckerEvent }),
  });

  const wHealth = usePoll<{ ok: boolean; lagMs?: number }>(`${services.watcher}/health`, 5_000);

  // ---- fallback: last incident published on HCS (works with every service off)
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      latestIncident()
        .then((r) => alive && r && containDispatch({ type: "hcs-incident", incident: r.incident }))
        .catch(() => undefined);
    }, 2500);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, []);

  const tokenParam = new URLSearchParams(window.location.search).get("token")?.trim();
  const otherToken = tokenParam && tokenParam !== deploy.token.tokenId ? tokenParam : null;

  return (
    <div className="dash">
      <header className="band">
        <HeroMedia />
        <div className="nav">
          <Link to="/" className="logo">
            ▲ Levee
          </Link>
          <div className="health" aria-label="Service health">
            <Health name="Gate" ok={gHealth.ok} reachable={gHealth.reachable} />
            <Health name="Watcher" ok={wHealth.ok} reachable={wHealth.reachable} detail={wSse === "open" ? "live" : undefined} />
            <Health name="Checker" ok={cPasses.ok} reachable={cPasses.reachable} />
            <span className="chip mono">Mirror lag {lagMs === null ? "–" : `${(lagMs / 1000).toFixed(1)} s`}</span>
          </div>
        </div>
      </header>

      <div className="titlebar">
        <div className="band-row">
        <h1>
          No receipt, no <span className="accent">movement</span>
        </h1>
        <span className="chip mono">
          <a href={hashscan.token(deploy.token.tokenId)} target="_blank" rel="noreferrer">
            {sym} {deploy.token.tokenId}
          </a>
          · treasury {deploy.treasury}
          {gHealth.data?.spentToday !== undefined && gHealth.data.capPerDay !== undefined && (
            <> · approved today {fmt(gHealth.data.spentToday)} / {fmt(gHealth.data.capPerDay)}</>
          )}
        </span>
      </div>
      {otherToken && (
        <p className="notice" style={{ marginTop: 12 }}>
          This demo watches {sym} ({deploy.token.tokenId}) on Hedera {deploy.network}. Watching {otherToken} needs its own gate and watcher.
        </p>
      )}
      </div>

      <main className="panels">
        <PassesPanel passes={Object.values(passes)} reachable={cPasses.reachable} reduced={reduced} />
        <FeedPanel rows={feed.rows} reachable={wState.reachable} />
        <ContainPanel s={contain} reduced={reduced} />
      </main>

      <RunDemo />
    </div>
  );
}

function Health({ name, ok, reachable, detail }: { name: string; ok: boolean; reachable: boolean; detail?: string }) {
  const word = ok ? (detail ?? "up") : reachable ? "unhealthy" : "off";
  return (
    <span className="chip" title={`${name}: ${word}`}>
      <i className={`dot ${ok ? "ok" : ""}`} aria-hidden="true" />
      {name} <span className="muted">{word}</span>
    </span>
  );
}

// ------------------------------------------------------------------ passes

function PassesPanel({ passes, reachable, reduced }: { passes: PassView[]; reachable: boolean; reduced: boolean }) {
  const now = useNow(reduced ? 1000 : 250);
  const sorted = [...passes].sort((a, b) => a.machine.localeCompare(b.machine));
  return (
    <section className="panel p-passes" aria-labelledby="passes-h">
      <div className="panel-head">
        <h2 id="passes-h">Machine passes</h2>
        <span className="eyebrow">Arkiv · {PASS_SECONDS} s</span>
      </div>
      {!reachable && sorted.length === 0 && <p className="empty">Checker is off. Start it with npm run checker.</p>}
      {reachable && sorted.length === 0 && <p className="empty">No machines enrolled yet.</p>}
      <ul className="list">
        {sorted.map((p) => {
          const left = passLeftMs(p, now);
          const live = left > 0;
          return (
            <li key={p.machine}>
              <div className="pass">
                <div style={{ minWidth: 0 }}>
                  <div className="name">{p.machine}</div>
                  <div className="why">{live ? "pass live · gate will sign" : (p.reason ?? "no live pass · gate refuses")}</div>
                </div>
                <div className="left" style={{ color: live ? "var(--olive)" : "var(--smoke)" }}>
                  {live ? countdown(left) : "expired"}
                </div>
              </div>
              <div className="bar" aria-hidden="true">
                <i style={{ width: `${Math.min(100, (left / (PASS_SECONDS * 1000)) * 100)}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------ feed

function rowTag(r: FeedRow): { cls: string; text: string } {
  switch (r.status) {
    case "receipt":
      return { cls: "ok", text: "receipt ✓" };
    case "pending":
      return { cls: "pending", text: "receipt written" };
    case "refused":
      return { cls: "refused", text: "refused at gate" };
    case "breach":
      return isLiveBreach(r) ? { cls: "breach", text: "no receipt ✗" } : { cls: "done", text: r.historic ? "no receipt ✗ · earlier" : "no receipt ✗ · undone" };
  }
}

export function FeedPanel({ rows, reachable }: { rows: FeedRow[]; reachable: boolean }) {
  return (
    <section className="panel p-feed" aria-labelledby="feed-h">
      <div className="panel-head">
        <h2 id="feed-h">Match feed</h2>
        <span className="eyebrow">treasury movements</span>
      </div>
      {rows.length === 0 && <p className="empty">{reachable ? "No treasury movements yet today." : "Watcher is off. Start it with npm run watcher."}</p>}
      <ul className="list" aria-live="polite">
        {rows.map((r) => {
          const tag = rowTag(r);
          const reason = r.reason && r.reason !== "no-receipt" ? (REASONS[r.reason] ?? r.reason) : null;
          return (
            <li key={r.key} className={isLiveBreach(r) ? "feed-row live" : "feed-row"}>
              <span className="what">
                {fmt(r.amount)} {sym} → {r.to}
              </span>
              <span className={`tag ${tag.cls}`}>{tag.text}</span>
              <span className="meta">
                {r.txId && (
                  <a href={hashscan.tx(r.txId)} target="_blank" rel="noreferrer">
                    {shortTx(r.txId)}
                  </a>
                )}
                {r.kind === "mint" && <span>mint</span>}
                {r.machine && <span>from {r.machine}</span>}
                {reason && <span>{reason}</span>}
                <span>{r.consensusAt ? new Date(Number(r.consensusAt.split(".")[0]) * 1000).toLocaleTimeString() : r.at ? new Date(r.at).toLocaleTimeString() : ""}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------ containment

export function ContainPanel({ s, reduced }: { s: ContainState; reduced: boolean }) {
  const now = useNow(reduced ? 1000 : 47, s.phase === "running");
  const ms = elapsedMs(s, now);
  const stalled = s.phase === "running" && ms > 120_000;
  const [treasury, setTreasury] = useState<FreezeStatus>("UNKNOWN");
  const [receiver, setReceiver] = useState<FreezeStatus>("UNKNOWN");

  useEffect(() => {
    let alive = true;
    const run = async () => {
      const [t, r] = await Promise.all([freezeStatus(deploy.treasury).catch(() => "UNKNOWN" as const), s.breachTo ? freezeStatus(s.breachTo).catch(() => "UNKNOWN" as const) : Promise.resolve("UNKNOWN" as const)]);
      if (alive) {
        setTreasury(t);
        setReceiver(r);
      }
    };
    run();
    const id = setInterval(run, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [s.breachTo]);

  const stateText = s.phase === "running" ? (stalled ? "Breach · waiting for the watcher" : "Breach live · containing") : s.phase === "contained" ? "Contained" : "All movements have receipts";

  return (
    <section className="panel p-contain" aria-labelledby="contain-h">
      <div className="panel-head">
        <h2 id="contain-h">Containment</h2>
        {s.source === "hcs" && <span className="eyebrow">last incident · from HCS</span>}
        {s.source === "watcher" && <span className="eyebrow">last incident</span>}
      </div>

      <div className={`watch ${s.phase}`} role="timer" aria-live="off">
        <span className="state-line">
          <i className={`dot ${s.phase === "running" ? "breach" : s.phase === "contained" ? "ok" : ""}`} aria-hidden="true" />
          {stateText}
        </span>
        <span className="digits">
          {stopwatch(ms)}
          <small>s</small>
        </span>
        <span className="muted" style={{ fontSize: "0.82rem" }}>
          from the theft reaching consensus to the last containment step
        </span>
      </div>

      {s.phase !== "idle" && (
        <ol className="list steps">
          {s.breachTxId && (
            <li className="row">
              <span className="t">0.00</span>
              <span className="lbl">
                {s.breachAmount ? `${fmt(s.breachAmount)} ${sym}` : "Tokens"} moved with no receipt{s.breachTo ? ` → ${s.breachTo}` : ""}
                <a href={hashscan.tx(s.breachTxId)} target="_blank" rel="noreferrer">
                  HashScan
                </a>
              </span>
            </li>
          )}
          {s.detectedMs !== undefined && (
            <li className="row">
              <span className="t">{stopwatch(s.detectedMs)}</span>
              <span className="lbl">Detected by the watcher</span>
            </li>
          )}
          {s.steps.map((a) => (
            <li className="row" key={`${a.step}|${a.account ?? ""}|${a.txId ?? a.atMs}`}>
              <span className="t">{stopwatch(a.atMs)}</span>
              <span className={`lbl ${a.ok ? "" : "fail"}`}>
                {stepLabel(a.step, a.account, a.amount, { treasury: deploy.treasury, fmt, symbol: sym })}
                {!a.ok && " (failed)"}
                {a.txId && (
                  <a href={hashscan.tx(a.txId)} target="_blank" rel="noreferrer">
                    HashScan
                  </a>
                )}
              </span>
            </li>
          ))}
          {s.phase === "running" && s.plannedSteps !== undefined && s.steps.length < s.plannedSteps && (
            <li className="row">
              <span className="t">…</span>
              <span className="lbl muted">
                {s.plannedSteps - s.steps.length} step{s.plannedSteps - s.steps.length > 1 ? "s" : ""} to go
              </span>
            </li>
          )}
          {s.phase === "contained" && (
            <li className="row">
              <span className="t">✓</span>
              <span className="lbl">
                Incident published
                <a href={hashscan.topic(deploy.topics.incidents)} target="_blank" rel="noreferrer">
                  topic {deploy.topics.incidents}
                </a>
              </span>
            </li>
          )}
        </ol>
      )}

      <div className="reopen-box">
        <span className="eyebrow">Reopen · 2 of 3 admins</span>
        <span>
          Treasury <b>{freezeWord(treasury)}</b>
          {s.breachTo && (
            <>
              {" "}
              · receiver {s.breachTo} <b>{freezeWord(receiver)}</b>
            </>
          )}
        </span>
        <span className="muted">
          {treasury === "FROZEN" ? "The contract can only close. Two of the three admins must sign to reopen." : treasury === "UNFROZEN" && s.phase === "contained" ? "Open again: two admins signed the reopen." : "Open. The watcher closes it the moment a movement has no receipt."}
        </span>
      </div>
    </section>
  );
}

function freezeWord(f: FreezeStatus): string {
  return f === "FROZEN" ? "frozen" : f === "UNFROZEN" ? "open" : f === "NOT_APPLICABLE" ? "n/a" : "…";
}

// ------------------------------------------------------------------ run demo

const COMMANDS = [
  { label: "Steal 10,000 RUPC with a leaked 2-of-3 key pair (no receipt)", cmd: "npx tsx scripts/attack.ts 10000" },
  { label: "Reopen treasury and attacker with 2 of 3 admins", cmd: "npx tsx scripts/reopen.ts treasury attacker" },
];

function RunDemo() {
  return (
    <section className="demo" aria-labelledby="demo-h">
      <div className="panel">
        <div className="panel-head">
          <h2 id="demo-h">Run the demo</h2>
          <span className="eyebrow">from the repo root</span>
        </div>
        <p className="muted" style={{ fontSize: "0.9rem" }}>
          The services expose no safe demo endpoint, so the attack and the reopen run from a terminal. Keep npm run gate, npm run watcher and npm run checker running, then:
        </p>
        <div className="cmds">
          {COMMANDS.map((c) => (
            <Cmd key={c.cmd} {...c} />
          ))}
        </div>
      </div>
    </section>
  );
}

function Cmd({ label, cmd }: { label: string; cmd: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the text is selectable */
    }
  };
  return (
    <div className="cmd">
      <code>
        <span className="label">{label}</span>
        {cmd}
      </code>
      <button type="button" className="btn secondary small" onClick={copy} aria-label={`Copy: ${cmd}`}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
