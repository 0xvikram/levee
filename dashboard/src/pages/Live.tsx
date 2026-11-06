import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Link } from "../components/router";
import { breachModeReducer, calm, type BreachMode } from "../lib/breach";
import { ARKIV_EXPLORER, GITHUB, deploy, eventsUrl, hashscan, payeeName, serviceUrl, servicesReachable } from "../lib/config";
import { decideMode, useChain } from "../lib/chain";
import { formatDate } from "../lib/incident";
import { replayContain, replayEndMs, replayPipeline } from "../lib/replay";
import { feedReducer, initialFeed, isLiveBreach, REASONS, type FeedRow } from "../lib/feed";
import { consensusToMs, countdown, formatAmount, shortTx, stopwatch } from "../lib/format";
import { serviceStatus, type ServiceStatus } from "../lib/health";
import { useEventSource, useNow, usePoll, usePrefersReducedMotion } from "../lib/hooks";
import { latestIncident, tokenRelation, type TokenRelation } from "../lib/mirror";
import { passesReducer, passLeftMs } from "../lib/passes";
import { initialPipeline, NODE_LABEL, NODE_SUB, NODES, pipelineReducer, type PipelineState } from "../lib/pipeline";
import { ring, RING_LOW } from "../lib/ring";
import { getRun, linkLabel, RUN_BUTTONS, startRun, type RunKind, type RunView } from "../lib/runner";
import { containReducer, elapsedMs, initialContain, stepLabel, type ContainState } from "../lib/stopwatch";
import type { BreachView, CheckerEvent, GateDecision, Incident, Movement, PassView, WatcherSnapshot } from "../lib/types";

const PASS_SECONDS = 180;
const fmt = (raw: string) => formatAmount(raw, deploy.token.decimals);
const sym = deploy.token.symbol;
type Relations = Record<string, TokenRelation>;
const label = (step: string, account?: string, amount?: string) => stepLabel(step, account, amount, { treasury: deploy.treasury, fmt, symbol: sym });
const CHAIN_PIPE: PipelineState = { ...initialPipeline, caption: "Chain view · press “Replay latest incident” to run the recorded theft through Check ✗" };

export function Live() {
  const reduced = usePrefersReducedMotion();
  const [feed, feedDispatch] = useReducer(feedReducer, initialFeed);
  const [contain, containDispatch] = useReducer(containReducer, initialContain);
  const [passes, passesDispatch] = useReducer(passesReducer, {});
  const [pipe, pipeDispatch] = useReducer(pipelineReducer, initialPipeline);
  const [mode, modeDispatch] = useReducer(breachModeReducer, calm);
  const [lagMs, setLagMs] = useState<number | null>(null);
  const local = servicesReachable();

  // ---- watcher: snapshot (poll, also its health) + live events
  const wState = usePoll<WatcherSnapshot>(serviceUrl("watcher", "/state"), 8_000);
  useEffect(() => {
    if (!wState.data) return;
    feedDispatch({ type: "snapshot", snapshot: wState.data });
    containDispatch({ type: "snapshot", snapshot: wState.data });
    if (typeof wState.data.lagMs === "number") setLagMs(wState.data.lagMs);
  }, [wState.data]);

  const wSse = useEventSource(eventsUrl("watcher"), {
    matched: (d) => {
      const m = d as Movement;
      feedDispatch({ type: "matched", movement: m });
      pipeDispatch({ type: "matched", eventMs: consensusToMs(m.consensusAt), now: Date.now() });
    },
    breach: (d) => {
      const b = d as BreachView;
      feedDispatch({ type: "breach", breach: b });
      containDispatch({ type: "breach", breach: b });
      pipeDispatch({ type: "breach", eventMs: consensusToMs(b.consensusAt), now: Date.now(), historic: b.historic });
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
  const gHealth = usePoll<{ ok: boolean; spentToday?: string; capPerDay?: string }>(serviceUrl("gate", "/health"), 10_000);
  const gSse = useEventSource(eventsUrl("gate"), {
    decision: (d) => {
      const x = d as GateDecision;
      feedDispatch({ type: "decision", decision: x });
      const eventMs = Date.parse(x.at);
      if (x.ok && x.txId) pipeDispatch({ type: "approved", eventMs, now: Date.now() });
      else if (!x.ok && !x.txId) pipeDispatch({ type: "refused", reason: REASONS[x.reason ?? ""] ?? x.reason ?? "refused", eventMs, now: Date.now() });
    },
  });

  // ---- checker: passes (slow: reads Arkiv)
  const cPasses = usePoll<PassView[]>(serviceUrl("checker", "/passes"), 10_000, 12_000);
  useEffect(() => {
    if (Array.isArray(cPasses.data)) passesDispatch({ type: "snapshot", passes: cPasses.data });
  }, [cPasses.data]);
  const cSse = useEventSource(eventsUrl("checker"), {
    message: (d) => passesDispatch({ type: "event", event: d as CheckerEvent }),
  });

  // ---- breach mode + pipeline settle
  const now = useNow(1000);
  useEffect(() => modeDispatch({ type: "update", contain, now: Date.now() }), [contain]);
  useEffect(() => {
    modeDispatch({ type: "tick", now });
    pipeDispatch({ type: "tick", now });
  }, [now]);
  const prevMode = useRef<BreachMode>(calm);
  useEffect(() => {
    if (prevMode.current.kind === "live" && mode.kind === "contained") pipeDispatch({ type: "contained", seconds: mode.seconds, now: Date.now() });
    prevMode.current = mode;
  }, [mode]);

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

  // ---- local or chain mode: services unreachable (public site, or nothing answered in 4 s)
  const mountedAt = useRef(Date.now());
  const anyUp = wState.reachable || gHealth.reachable || cPasses.reachable || wSse === "open" || gSse === "open" || cSse === "open";
  const roomMode = decideMode({ local, anyUp, elapsedMs: now - mountedAt.current });
  const chainMode = roomMode === "chain";
  const chain = useChain(chainMode);
  const genuine = chain?.genuine ?? null;

  // ---- replay of the newest genuine incident, with its recorded step times
  const [replay, setReplay] = useState<{ startMs: number; done: boolean } | null>(null);
  const rNow = useNow(reduced ? 250 : 50, !!replay && !replay.done);
  const rElapsed = replay ? (replay.done ? Number.POSITIVE_INFINITY : Math.max(0, rNow - replay.startMs)) : 0;
  useEffect(() => {
    if (replay && !replay.done && genuine && rElapsed >= replayEndMs(genuine.incident)) setReplay({ ...replay, done: true });
  }, [replay, genuine, rElapsed]);
  const chainContain = useMemo(() => (genuine ? containReducer(initialContain, { type: "hcs-incident", incident: genuine.incident }) : initialContain), [genuine]);
  const replaying = chainMode && !!replay && !!genuine;
  const shownContain = !chainMode ? contain : replaying ? replayContain(genuine!.incident, replay!.startMs, rElapsed) : chainContain;
  const shownPipe = !chainMode ? pipe : replaying ? replayPipeline(genuine!.incident, replay!.startMs, rElapsed, label) : CHAIN_PIPE;
  const shownRows = chainMode ? (chain?.rows ?? []) : feed.rows;

  // ---- Mirror Node: balance + freeze for treasury, attacker, payees, breach receivers
  const watched = [deploy.treasury, deploy.attacker, ...deploy.payees, ...shownRows.filter((r) => r.status === "breach").map((r) => r.to)].filter((a): a is string => !!a && /^0\.0\.\d+$/.test(a));
  const watchKey = [...new Set(watched)].sort().join(",");
  const relations = useRelations(watchKey, mode.kind === "live" ? 2000 : 6000);

  const tokenParam = new URLSearchParams(window.location.search).get("token")?.trim();
  const otherToken = tokenParam && tokenParam !== deploy.token.tokenId ? tokenParam : null;

  const st = (p: Parameters<typeof serviceStatus>[0], sse: Parameters<typeof serviceStatus>[1]): ServiceStatus => (local ? serviceStatus(p, sse) : "local");
  const health: [string, ServiceStatus][] = [
    ["Receipts", st(gHealth, gSse)],
    ["Watcher", st(wState, wSse)],
    ["Arkiv add-on", st(cPasses, cSse)],
  ];
  const replayButton = chainMode && genuine && (
    <div className="replay-box">
      <button type="button" className="btn small" disabled={!!replay && !replay.done} onClick={() => setReplay({ startMs: Date.now(), done: false })}>
        {replay?.done ? "Replay again" : "Replay latest incident"}
      </button>
      <span className="dim small">Replays the step times recorded on chain for the incident of {formatDate(genuine.consensusAt)}. Not a live event.</span>
    </div>
  );

  return (
    <div className={`room mode-${mode.kind}`}>
      <div className="room-frame" aria-hidden="true" />
      <TopBar relations={relations} health={health} lagMs={lagMs} chain={chainMode} />
      {chainMode ? <ChainBanner /> : <Banner mode={mode} contain={contain} reduced={reduced} />}
      {otherToken && (
        <p className="room-notice">
          This demo watches {sym} ({deploy.token.tokenId}) on Hedera {deploy.network}. Watching {otherToken} needs its own Levee setup.
        </p>
      )}
      <Pipeline s={shownPipe} />
      <main className="room-grid">
        <TreasuryCard relations={relations} spentToday={gHealth.data?.spentToday} capPerDay={gHealth.data?.capPerDay} />
        <FeedPanel rows={shownRows} reachable={wState.reachable || wSse === "open"} emptyText={chainMode ? (chain ? "No treasury movements in the latest Mirror Node page." : "Reading the Mirror Node…") : undefined} />
        <ContainPanel s={shownContain} reduced={reduced} relations={relations} extra={replayButton || undefined} />
      </main>
      <DemoPanel chain={chainMode} />
      <PassesStrip passes={chainMode ? [] : Object.values(passes)} reachable={cPasses.reachable || cSse === "open"} reduced={reduced} chain={chainMode} />
    </div>
  );
}

function useRelations(key: string, everyMs: number): Relations {
  const [rel, setRel] = useState<Relations>({});
  useEffect(() => {
    let alive = true;
    const ids = key.split(",").filter(Boolean);
    const run = async () => {
      const got = await Promise.all(ids.map((id) => tokenRelation(id).catch(() => null)));
      if (!alive) return;
      setRel((prev) => {
        const out = { ...prev };
        ids.forEach((id, i) => {
          const g = got[i];
          if (g) out[id] = g;
        });
        return out;
      });
    };
    run();
    const t = setInterval(run, everyMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [key, everyMs]);
  return rel;
}

// ------------------------------------------------------------------ top bar

const HEALTH_WORD: Record<ServiceStatus, string> = { up: "up", degraded: "unhealthy", off: "off", checking: "…", local: "local only" };

function TopBar({ relations, health, lagMs, chain = false }: { relations: Relations; health: [string, ServiceStatus][]; lagMs: number | null; chain?: boolean }) {
  const t = relations[deploy.treasury];
  const frozen = t?.freeze === "FROZEN";
  return (
    <header className="topbar">
      <Link to="/" className="wordmark">
        ▲ Levee
      </Link>
      <a className="tb-item mono" href={hashscan.token(deploy.token.tokenId)} target="_blank" rel="noreferrer">
        {sym} <span className="dim">{deploy.token.tokenId}</span>
      </a>
      <span className="tb-item">
        <span className="dim">Treasury</span>
        <span className="mono num">{t?.balance != null ? `${fmt(t.balance)} ${sym}` : "…"}</span>
        <span className={`state-badge ${t ? (frozen ? "frozen" : "open") : ""}`}>{t ? (frozen ? "FROZEN" : "OPEN") : "…"}</span>
      </span>
      <span className="tb-health" aria-label="Service health">
        {health.map(([name, st]) => (
          <span key={name} className="tb-dot" title={`${name}: ${HEALTH_WORD[st]}`}>
            <i className={`dot ${st}`} aria-hidden="true" />
            {name}
            {st === "up" ? <span className="sr-only"> up</span> : <span className="dim"> {HEALTH_WORD[st]}</span>}
          </span>
        ))}
        {chain ? (
          <span className="tb-dot">
            <span className="dim">Data</span> Mirror Node
          </span>
        ) : (
          <span className="tb-dot mono">
            <span className="dim">Mirror lag</span> {lagMs === null ? "–" : `${(lagMs / 1000).toFixed(1)} s`}
          </span>
        )}
      </span>
    </header>
  );
}

// ------------------------------------------------------------------ breach banner

function Banner({ mode, contain, reduced }: { mode: BreachMode; contain: ContainState; reduced: boolean }) {
  const now = useNow(reduced ? 1000 : 97, mode.kind === "live");
  if (mode.kind === "calm") return null;
  if (mode.kind === "live") {
    return (
      <div className="banner live" role="alert">
        <i className="dot breach" aria-hidden="true" />
        Unreceipted transfer — containing…
        <span className="mono num">{stopwatch(elapsedMs(contain, now))} s</span>
      </div>
    );
  }
  return (
    <div className="banner contained" role="status">
      ✓ Contained in <span className="mono num">{mode.seconds.toFixed(2)} s</span>
    </div>
  );
}

export const CHAIN_BANNER = "Services run on the operator's machine. Showing the chain: receipts, transfers and incidents read live from the Hedera Mirror Node.";

export function ChainBanner() {
  return (
    <div className="banner chain" role="status">
      <i className="dot up" aria-hidden="true" />
      {CHAIN_BANNER}
    </div>
  );
}

// ------------------------------------------------------------------ pipeline

export function Pipeline({ s }: { s: PipelineState }) {
  return (
    <section className="pipeline" aria-label="Pipeline">
      <ol className="pipe-row">
        {NODES.map((n, i) => (
          <li key={n} className={`pipe-node tone-${s.nodes[n].tone}`}>
            <span className="pipe-dot" aria-hidden="true">
              <i />
            </span>
            <span className="pipe-label">
              {NODE_LABEL[n]}
              <small>{NODE_SUB[n]}</small>
            </span>
            {i < NODES.length - 1 && (
              <span className={`pipe-link tone-${s.links[i].tone}`} aria-hidden="true">
                {s.links[i].tone !== "idle" && <i key={s.links[i].key} />}
              </span>
            )}
          </li>
        ))}
      </ol>
      <p className="pipe-caption" aria-live="polite">
        {s.caption}
      </p>
    </section>
  );
}

// ------------------------------------------------------------------ treasury

function TreasuryCard({ relations, spentToday, capPerDay }: { relations: Relations; spentToday?: string; capPerDay?: string }) {
  const t = relations[deploy.treasury];
  const frozen = Object.entries(relations).filter(([, r]) => r.freeze === "FROZEN");
  const name = (id: string) => (id === deploy.treasury ? "treasury" : id === deploy.attacker ? "thief (demo)" : (payeeName(id) ?? "receiver"));
  return (
    <section className="card-dark treasury" aria-labelledby="tr-h">
      <div className="card-head">
        <h2 id="tr-h">Treasury</h2>
        <a className="dim mono small" href={hashscan.account(deploy.treasury)} target="_blank" rel="noreferrer">
          {deploy.treasury}
        </a>
      </div>
      <div className="big-balance mono num">
        {t?.balance != null ? <BigAmount text={fmt(t.balance)} /> : "…"} <small>{sym}</small>
      </div>
      <div className={`state-line-lg ${t?.freeze === "FROZEN" ? "frozen" : "open"}`}>
        <i className="dot" aria-hidden="true" />
        {t ? (t.freeze === "FROZEN" ? "Frozen · two of three admins must reopen" : "Open · every payout needs a receipt first") : "Reading Mirror Node…"}
      </div>
      {spentToday !== undefined && capPerDay !== undefined && (
        <div className="cap">
          <div className="cap-row small">
            <span className="dim">Add-on cap · paid today</span>
            <span className="mono num">
              {fmt(spentToday)} / {fmt(capPerDay)}
            </span>
          </div>
          <div className="meter" aria-hidden="true">
            <i style={{ transform: `scaleX(${Math.min(1, Number(spentToday) / Math.max(1, Number(capPerDay)))})` }} />
          </div>
        </div>
      )}
      <div>
        <span className="eyebrow">Frozen accounts</span>
        {frozen.length === 0 ? (
          <p className="dim small">None. Nothing is frozen right now.</p>
        ) : (
          <ul className="frozen-list">
            {frozen.map(([id, r]) => (
              <li key={id}>
                <a className="mono" href={hashscan.account(id)} target="_blank" rel="noreferrer">
                  {id}
                </a>
                <span className="dim small">
                  {name(id)}
                  {r.balance != null ? ` · ${fmt(r.balance)} ${sym}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function BigAmount({ text }: { text: string }) {
  const [whole, frac] = text.split(".");
  return (
    <>
      {whole}
      {frac && <span className="frac">.{frac.slice(0, 2)}</span>}
    </>
  );
}

// ------------------------------------------------------------------ feed

function rowTag(r: FeedRow): { cls: string; text: string; mark: string } {
  switch (r.status) {
    case "receipt":
      return { cls: "ok", text: "receipt ✓", mark: "✓" };
    case "pending":
      return { cls: "pending", text: "receipt written", mark: "•" };
    case "refused":
      return { cls: "refused", text: "refused · no receipt", mark: "–" };
    case "breach":
      return isLiveBreach(r) ? { cls: "breach", text: "no receipt ✗", mark: "✗" } : { cls: "done", text: r.historic ? "no receipt ✗ · earlier" : "no receipt ✗ · undone", mark: "✗" };
  }
}

function rowTime(r: FeedRow): string {
  const ms = r.consensusAt ? consensusToMs(r.consensusAt) : r.at ? Date.parse(r.at) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
}

export function FeedPanel({ rows, reachable, emptyText }: { rows: FeedRow[]; reachable: boolean; emptyText?: string }) {
  return (
    <section className="card-dark feed" aria-labelledby="feed-h">
      <div className="card-head">
        <h2 id="feed-h">Every move</h2>
        <span className="eyebrow">newest first</span>
      </div>
      {rows.length === 0 && <p className="dim small">{emptyText ?? (reachable ? "No treasury movements yet today." : "Watcher is off. Start it with npm run watcher.")}</p>}
      <ol className="timeline" aria-live="polite">
        {rows.map((r) => {
          const tag = rowTag(r);
          const reason = r.reason && r.reason !== "no-receipt" ? (REASONS[r.reason] ?? r.reason) : null;
          return (
            <li key={r.key} className={`tl-row s-${tag.cls}${isLiveBreach(r) ? " live" : ""}`}>
              <span className="tl-mark" aria-hidden="true">
                {tag.mark}
              </span>
              <div className="tl-body">
                <div className="tl-top">
                  <span className="what mono">
                    {fmt(r.amount)} {sym} → {payeeName(r.to) ? `${payeeName(r.to)} · ${r.to}` : r.to}
                  </span>
                  <span className={`tag ${tag.cls}`}>{tag.text}</span>
                </div>
                <div className="tl-meta">
                  <span className="mono">{rowTime(r)}</span>
                  {r.status === "refused" && <span>{reason ?? "refused"}</span>}
                  {r.status === "breach" && <span>{isLiveBreach(r) ? "containing" : "frozen and clawed back"}</span>}
                  {r.status !== "refused" && reason && <span>{reason}</span>}
                  {r.machine && <span>payout app {r.machine}</span>}
                  {r.kind === "mint" && <span>mint</span>}
                  {r.receiptTxId && (
                    <a href={hashscan.tx(r.receiptTxId)} target="_blank" rel="noreferrer">
                      receipt
                    </a>
                  )}
                  {r.txId && (
                    <a className="mono" href={hashscan.tx(r.txId)} target="_blank" rel="noreferrer">
                      {shortTx(r.txId)}
                    </a>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ------------------------------------------------------------------ containment stopwatch

export function ContainPanel({ s, reduced, relations = {}, extra }: { s: ContainState; reduced: boolean; relations?: Relations; extra?: ReactNode }) {
  const now = useNow(reduced ? 1000 : 47, s.phase === "running");
  const ms = elapsedMs(s, now);
  const stalled = s.phase === "running" && ms > 120_000;
  const treasury = relations[deploy.treasury]?.freeze;
  const receiver = s.breachTo ? relations[s.breachTo]?.freeze : undefined;

  const stateText = s.source === "replay" ? (s.phase === "running" ? "Replay · containing (recorded)" : "Replay · contained (recorded)") : s.phase === "running" ? (stalled ? "Breach · waiting for the watcher" : "Breach live · containing") : s.phase === "contained" ? "Contained" : "All movements have receipts";
  const planned = s.plannedSteps ?? Math.max(s.steps.length, 2);
  const total = planned + 2; // detected + steps + published
  const done = s.phase === "contained" ? total : (s.detectedMs !== undefined ? 1 : 0) + s.steps.length;
  const frac = s.phase === "idle" ? 0 : Math.min(1, done / total);

  return (
    <section className={`card-dark contain ${s.phase}`} aria-labelledby="contain-h">
      <div className="card-head">
        <h2 id="contain-h">Containment</h2>
        {s.source === "hcs" && <span className="eyebrow">last incident · from HCS</span>}
        {s.source === "watcher" && <span className="eyebrow">last incident</span>}
        {s.source === "replay" && <span className="eyebrow">replay · recorded on-chain data</span>}
      </div>

      <div className={`watch ${s.phase}`} role="timer" aria-live="off">
        <span className="state-line">
          <i className={`dot ${s.phase === "running" ? "breach" : s.phase === "contained" ? "up" : ""}`} aria-hidden="true" />
          {stateText}
        </span>
        <span className="digits mono num">
          {stopwatch(ms)}
          <small>s</small>
        </span>
        <span className="dim small">from the theft reaching consensus to the last containment step</span>
      </div>

      {extra}

      <div className="progress" aria-hidden="true">
        <i style={{ transform: `scaleX(${frac})` }} />
      </div>

      {s.phase !== "idle" && (
        <ol className="steps">
          {s.breachTxId && (
            <li className="row">
              <span className="t mono num">0.00</span>
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
              <span className="t mono num">{stopwatch(s.detectedMs)}</span>
              <span className="lbl">Check ✗ no receipt found</span>
            </li>
          )}
          {s.steps.map((a) => (
            <li className="row landed" key={`${a.step}|${a.account ?? ""}|${a.txId ?? a.atMs}`}>
              <span className="t mono num">{stopwatch(a.atMs)}</span>
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
              <span className="lbl dim">
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
        <span className="dim small">
          {treasury === "FROZEN" ? "The contract can only close. Two of the three admins must sign to reopen." : treasury === "UNFROZEN" && s.phase === "contained" ? "Open again: two admins signed the reopen." : "Open. The contract closes it the moment tokens leave with no receipt."}
        </span>
      </div>
    </section>
  );
}

function freezeWord(f: string | undefined): string {
  return f === "FROZEN" ? "frozen" : f === "UNFROZEN" ? "open" : f === "NOT_APPLICABLE" ? "n/a" : "…";
}

// ------------------------------------------------------------------ add-on: machine health (Arkiv)

const R = 17;
export const ADDON_KEY = "levee.addon.machineHealth";
function readOpen(): boolean {
  try {
    return window.localStorage.getItem(ADDON_KEY) === "1";
  } catch {
    return false;
  }
}
function saveOpen(open: boolean) {
  try {
    window.localStorage.setItem(ADDON_KEY, open ? "1" : "0");
  } catch {
    /* storage blocked: the toggle still works for this visit */
  }
}

export function PassesStrip({ passes, reachable, reduced, chain = false }: { passes: PassView[]; reachable: boolean; reduced: boolean; chain?: boolean }) {
  const [open, setOpen] = useState(readOpen);
  const now = useNow(reduced ? 1000 : 250, open);
  const sorted = [...passes].sort((a, b) => a.machine.localeCompare(b.machine));
  const toggle = () => {
    const next = !open;
    saveOpen(next);
    setOpen(next);
  };
  return (
    <section className={`passes addon${open ? " open" : ""}`} aria-labelledby="passes-h">
      <div className="passes-head">
        <h2 id="passes-h">
          <button type="button" className="addon-toggle" aria-expanded={open} aria-controls="passes-body" onClick={toggle}>
            <span className="addon-caret" aria-hidden="true">
              ▸
            </span>
            Add-on: machine health (Arkiv)
          </button>
        </h2>
        <span className="eyebrow">optional rule · not needed for the main rule</span>
        <a className="small" href={ARKIV_EXPLORER} target="_blank" rel="noreferrer">
          Arkiv explorer
        </a>
      </div>
      {open && (
        <div id="passes-body" className="addon-body">
          <p className="dim small">
            With this add-on on, Levee only writes a receipt for a payout machine that holds a health pass on Arkiv. The pass expires in {PASS_SECONDS / 60} minutes unless the machine renews it.
            {chain && " The health check runs on the operator's machine, so live countdowns are not shown here."}
            {!chain && !reachable && " The health check is off. Start it with npm run checker."}
          </p>
          {!chain && reachable && sorted.length === 0 && <p className="dim small">No machines enrolled yet.</p>}
          <ul className="pass-chips">
            {sorted.map((p) => {
              const left = passLeftMs(p, now);
              const live = left > 0;
              const g = ring(left, PASS_SECONDS * 1000, R);
              return (
                <li key={p.machine} className={`pass-chip ${live ? (g.frac < RING_LOW ? "low" : "live") : "dead"}`}>
                  <svg className="ring" viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
                    <circle cx="20" cy="20" r={R} className="ring-bg" />
                    <circle cx="20" cy="20" r={R} className="ring-fg" strokeDasharray={g.circumference} strokeDashoffset={g.offset} transform="rotate(-90 20 20)" />
                  </svg>
                  <span className="pass-text">
                    <span className="mono name">{p.machine}</span>
                    <span className="small dim">{live ? `healthy · ${countdown(left)} left` : (p.reason ?? "no health pass · no receipt")}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ demo panel

const payCmd = `curl -s -X POST localhost:8710/request -H 'content-type: application/json' -d '{"machine":"payouts-server","to":"${deploy.payees[0] ?? "0.0.x"}","amount":"500000000"}'`;
const cliFor = (k: RunKind, cmd: string) => (k === "pay" ? payCmd : cmd);

export function DemoPanel({ chain = false }: { chain?: boolean }) {
  const runner = usePoll<{ ok: boolean; busy: RunView | null }>(chain ? "" : serviceUrl("runner", "/health"), 10_000, 3000);
  const [run, setRun] = useState<RunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = run?.status === "running" || (!!runner.data?.busy && runner.data.busy.id !== run?.id);

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

  const go = async (kind: RunKind) => {
    setError(null);
    const r = await startRun(kind);
    if (r.ok) setRun({ ...r.run, lines: [] });
    else setError(r.error);
  };

  const up = runner.ok && !chain;
  return (
    <section className="demo-panel card-dark" aria-labelledby="demo-h">
      <div className="card-head">
        <h2 id="demo-h">
          Run the <span className="accent">demo</span>
        </h2>
        <span className="eyebrow">{up ? "demo runner · testnet" : "from the repo root"}</span>
      </div>
      {up ? (
        <>
          <div className="demo-buttons">
            {RUN_BUTTONS.map((b) => (
              <button key={b.kind} type="button" className={`btn ${b.primary ? "" : "ghost"}`} disabled={running} onClick={() => go(b.kind)}>
                {b.label}
              </button>
            ))}
          </div>
          {error && <p className="small warn">{error}</p>}
          {run && (
            <div className={`run-log ${run.status}`}>
              <div className="run-head small">
                <span className="mono">
                  {run.kind} · {run.status === "running" ? "running…" : run.status === "ok" ? "done" : "failed"}
                </span>
                {run.links.map((u) => (
                  <a key={u} className="mono" href={u} target="_blank" rel="noreferrer">
                    {linkLabel(u)}
                  </a>
                ))}
              </div>
              <pre aria-live="polite">{(run.lines ?? []).slice(-14).join("\n") || "starting…"}</pre>
            </div>
          )}
        </>
      ) : (
        <>
          {chain ? (
            <p className="dim small">
              The demo buttons drive the operator's own services, so they are not available here. To run it yourself, clone{" "}
              <a href={GITHUB} target="_blank" rel="noreferrer">
                the repo
              </a>{" "}
              and, with npm run gate, watcher and checker up, run from its root:
            </p>
          ) : (
            <p className="dim small">
              Start the buttons with <code>DEMO_MODE=1 npm run demo:runner</code>, or run these with npm run gate, watcher and checker up:
            </p>
          )}
          <div className="cmds">
            {RUN_BUTTONS.map((b) => (
              <Cmd key={b.kind} label={b.label} cmd={cliFor(b.kind, b.cmd)} />
            ))}
          </div>
        </>
      )}
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
      <button type="button" className="btn ghost small" onClick={copy} aria-label={`Copy: ${cmd}`}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
