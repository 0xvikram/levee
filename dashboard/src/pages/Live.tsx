// /live: one-screen demo command centre. Top bar · KPI strip · Story (left) · pipeline, stopwatch
// and live chart (centre) · Proof with QR codes, before/after and every move (right).
// Local mode drives the demo runner and listens to the services; hosted (chain) mode reads only
// the Hedera Mirror Node and offers a replay of the newest genuine incident.
import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Link } from "../components/router";
import { LiveChart } from "../components/LiveChart";
import { QR } from "../components/QR";
import { breachModeReducer, calm, type BreachMode } from "../lib/breach";
import { ARKIV_EXPLORER, GITHUB, deploy, eventsUrl, hashscan, payeeName, serviceUrl, servicesReachable } from "../lib/config";
import { decideMode, useChain } from "../lib/chain";
import { formatDate } from "../lib/incident";
import { replayContain, replayEndMs, replayPipeline } from "../lib/replay";
import { feedReducer, initialFeed, isLiveBreach, REASONS, type FeedRow } from "../lib/feed";
import { consensusToMs, formatAmount, shortTx, stopwatch } from "../lib/format";
import { serviceStatus, type ServiceStatus } from "../lib/health";
import { useEventSource, useNow, usePoll, usePrefersReducedMotion } from "../lib/hooks";
import { buildKpis, incidentStats, matchedToday, type Kpi } from "../lib/kpis";
import { useIncidentTopic, useLiveSeries } from "../lib/live-data";
import { latestIncident, tokenRelation, type TokenRelation } from "../lib/mirror";
import { INDUSTRY, logPos } from "../lib/numbers";
import { passesReducer, passLeftMs } from "../lib/passes";
import { initialPipeline, NODE_LABEL, NODE_SUB, NODES, pipelineReducer, type PipelineState } from "../lib/pipeline";
import { RUN_BUTTONS, useRunner, type RunKind, type RunView } from "../lib/runner";
import { withSpike, type ChartEvent, type ChartEventKind } from "../lib/series";
import { containReducer, elapsedMs, initialContain, stepLabel, type ContainState } from "../lib/stopwatch";
import { CAPTIONS, dedupeLinks, runError, initialStory, milestones, proofFromContain, proofFromRun, STORY, stepTone, storyCaption, storyReducer, type ProofLink, type StoryState } from "../lib/story";
import type { BreachView, CheckerEvent, GateDecision, Incident, Movement, PassView, WatcherSnapshot } from "../lib/types";

const fmt = (raw: string) => formatAmount(raw, deploy.token.decimals);
const sym = deploy.token.symbol;
type Relations = Record<string, TokenRelation>;
const label = (step: string, account?: string, amount?: string) => stepLabel(step, account, amount, { treasury: deploy.treasury, fmt, symbol: sym });
const CHAIN_PIPE: PipelineState = { ...initialPipeline, caption: "Hosted view · press “Replay latest incident” to run the recorded theft through Check ✗" };
const RUN_EVENT: Record<RunKind, ChartEventKind> = { pay: "send", attack: "theft", mint: "mint", reopen: "unlock", reset: "reset" };

/** One screen on desktop: lock html/body/#root to the viewport while /live is mounted. */
function useOneScreen() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("cc-page");
    return () => root.classList.remove("cc-page");
  }, []);
}

export function Live() {
  useOneScreen();
  const reduced = usePrefersReducedMotion();
  const [feed, feedDispatch] = useReducer(feedReducer, initialFeed);
  const [contain, containDispatch] = useReducer(containReducer, initialContain);
  const [passes, passesDispatch] = useReducer(passesReducer, {});
  const [pipe, pipeDispatch] = useReducer(pipelineReducer, initialPipeline);
  const [mode, modeDispatch] = useReducer(breachModeReducer, calm);
  const [story, storyDispatch] = useReducer(storyReducer, initialStory);
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
  const gHealth = usePoll<{ ok: boolean }>(serviceUrl("gate", "/health"), 10_000);
  const gSse = useEventSource(eventsUrl("gate"), {
    decision: (d) => {
      const x = d as GateDecision;
      feedDispatch({ type: "decision", decision: x });
      const eventMs = Date.parse(x.at);
      if (x.ok && x.txId) pipeDispatch({ type: "approved", eventMs, now: Date.now() });
      else if (!x.ok && !x.txId) pipeDispatch({ type: "refused", reason: REASONS[x.reason ?? ""] ?? x.reason ?? "refused", eventMs, now: Date.now() });
    },
  });

  // ---- checker: Arkiv passes (one chip in the top bar)
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
    if (prevMode.current.kind === "live" && mode.kind === "contained") {
      pipeDispatch({ type: "contained", seconds: mode.seconds, now: Date.now() });
      storyDispatch({ type: "contained", seconds: mode.seconds });
    }
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

  // ---- local or chain mode
  const mountedAt = useRef(Date.now());
  const anyUp = wState.reachable || gHealth.reachable || cPasses.reachable || wSse === "open" || gSse === "open" || cSse === "open";
  const roomMode = decideMode({ local, anyUp, elapsedMs: now - mountedAt.current });
  const chainMode = roomMode === "chain";
  const chain = useChain(chainMode);
  const genuine = chain?.genuine ?? null;

  // ---- demo runner + story
  const [runEvents, setRunEvents] = useState<ChartEvent[]>([]);
  const runner = useRunner(local && !chainMode, (r) => {
    if (r.status !== "running") storyDispatch({ type: "finish", kind: r.kind, ok: r.status === "ok" });
  });
  const go = async (kind: RunKind) => {
    const ok = await runner.start(kind);
    if (ok) {
      storyDispatch({ type: "start", kind });
      setRunEvents((e) => [...e, { t: Date.now(), kind: RUN_EVENT[kind] }].slice(-30));
    }
  };

  // ---- replay of the newest genuine incident (chain mode)
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

  // ---- Mirror Node: live series (3 s), incidents topic, freeze status of the accounts in play
  const series = useLiveSeries();
  const topic = useIncidentTopic();
  const watched = [deploy.treasury, deploy.attacker, ...deploy.payees].filter((a): a is string => !!a && /^0\.0\.\d+$/.test(a));
  const relations = useRelations(watched.join(","), mode.kind === "live" ? 2000 : 6000);
  const treasuryRel = series.treasuryRel ?? relations[deploy.treasury];
  const mirrorOk = series.treasury.length > 0 && series.treasury[series.treasury.length - 1].v !== null;

  // ---- KPIs
  const stats = useMemo(() => (topic ? incidentStats(topic, { nowMs: Date.now(), payees: deploy.payees }) : null), [topic]);
  const kpis = buildKpis({
    decimals: deploy.token.decimals,
    symbol: sym,
    treasury: treasuryRel?.balance,
    supply: series.supplyRaw,
    matched: chainMode ? (chain ? matchedToday(chain.rows, now) : null) : (wState.data?.matched ?? null),
    matchedNote: chainMode ? "today · Mirror Node" : "watcher · this session",
    incidents: stats,
    lagMs,
    chain: chainMode,
    liveSeconds: mode.kind === "contained" ? mode.seconds : story.containedS,
  });

  // ---- caption
  const caption = chainMode ? (replaying ? (replay!.done ? CAPTIONS.contained(replayEndMs(genuine!.incident) / 1000) : CAPTIONS.hack) : CAPTIONS.idle) : storyCaption(story, mode);

  // ---- chart events
  const chartEvents: ChartEvent[] = chainMode
    ? shownRows.filter((r) => r.consensusAt && (r.status === "receipt" || r.status === "breach")).map((r) => ({ t: consensusToMs(r.consensusAt!), kind: r.status === "receipt" ? "send" : r.kind === "mint" ? "mint" : "theft" }))
    : [...runEvents, ...feed.rows.filter((r) => r.status === "breach" && r.consensusAt && !r.historic).map((r) => ({ t: consensusToMs(r.consensusAt!), kind: (r.kind === "mint" ? "mint" : "theft") as ChartEventKind }))];

  // ---- supply spike of a contained mint (drawn from the incident: mint consensus time to the wipe)
  const mintRow = !chainMode ? feed.rows.find((r) => r.kind === "mint" && r.status === "breach" && r.txId === contain.breachTxId && r.consensusAt) : undefined;
  const mintWipe = mintRow && contain.startMs !== undefined ? [...contain.steps].reverse().find((a) => a.step === "wipeAndFreeze" || a.step === "wipeFrozen" || a.step === "burnSupply") : undefined;
  const supplyLine =
    mintRow && mintWipe && contain.startMs !== undefined ? withSpike(series.supply, { from: consensusToMs(mintRow.consensusAt!), to: contain.startMs + mintWipe.atMs, amount: Number(mintRow.amount) / 10 ** deploy.token.decimals }) : series.supply;

  // ---- proof for the latest step
  const isMint = !!shownContain.breachTxId && shownRows.some((r) => r.txId === shownContain.breachTxId && r.kind === "mint");
  const proof = proofLinks({ chain: chainMode, run: runner.run, contain: shownContain, mint: isMint || story.last === "mint" });

  // ---- Arkiv chip
  const passList = Object.values(passes);
  const arkiv: "live" | "expired" | "off" | "hosted" = chainMode ? "hosted" : !(cPasses.reachable || cSse === "open") ? "off" : passList.some((p) => passLeftMs(p, now) > 0) ? "live" : "expired";

  const st = (p: Parameters<typeof serviceStatus>[0], sse: Parameters<typeof serviceStatus>[1]): ServiceStatus => (local ? serviceStatus(p, sse) : "local");
  const health: [string, ServiceStatus][] = chainMode
    ? []
    : [
        ["Receipts", st(gHealth, gSse)],
        ["Watcher", st(wState, wSse)],
      ];

  const tokenParam = new URLSearchParams(window.location.search).get("token")?.trim();
  const otherToken = tokenParam && tokenParam !== deploy.token.tokenId ? tokenParam : null;
  const leveeS = shownContain.phase === "contained" && shownContain.containedMs ? shownContain.containedMs / 1000 : null;

  return (
    <div className={`room cc mode-${mode.kind}`}>
      <div className="room-frame" aria-hidden="true" />
      <TopBar treasury={treasuryRel} health={health} arkiv={arkiv} mirrorOk={mirrorOk} chain={chainMode} />
      <KpiStrip kpis={kpis} />
      <div className="cc-main">
        <aside className="cc-col cc-story card-dark" aria-labelledby="story-h">
          {chainMode ? (
            <ChainStory genuine={genuine} replay={replay} onReplay={() => setReplay({ startMs: Date.now(), done: false })} />
          ) : (
            <StoryPanel story={story} up={runner.up} busy={runner.busy} run={runner.run} error={runner.error} onRun={go} thiefFrozen={!!deploy.attacker && relations[deploy.attacker]?.freeze === "FROZEN"} />
          )}
          <p className={`cc-caption${mode.kind === "live" ? " live" : ""}`} aria-live="polite">
            {caption}
          </p>
          {otherToken && (
            <p className="dim small">
              This demo watches {sym} ({deploy.token.tokenId}) on Hedera {deploy.network}. Watching {otherToken} needs its own Levee setup.
            </p>
          )}
        </aside>
        <section className="cc-col cc-centre" aria-label="Live view">
          <Pipeline s={shownPipe} />
          <ContainPanel s={shownContain} reduced={reduced} extra={null} />
          <LiveChart
            treasury={series.treasury}
            supply={supplyLine}
            events={chartEvents}
            now={now}
            symbol={sym}
            note={`Polled from the Mirror Node every 3 s.${series.seeded ? " Treasury history seeded from Mirror transactions;" : ""} supply line starts when this page opened.`}
          />
        </section>
        <aside className="cc-col cc-proof" aria-label="Proof">
          <ProofPanel links={proof} />
          <BeforeAfter leveeS={leveeS} />
          <FeedPanel rows={shownRows} reachable={wState.reachable || wSse === "open"} emptyText={chainMode ? (chain ? "No treasury movements in the latest Mirror Node page." : "Reading the Mirror Node…") : undefined} />
        </aside>
      </div>
    </div>
  );
}

function proofLinks(o: { chain: boolean; run: RunView | null; contain: ContainState; mint: boolean }): ProofLink[] {
  const fromContain = proofFromContain(o.contain, { hashscanTx: hashscan.tx, treasury: deploy.treasury, mint: o.mint });
  const topic = o.contain.phase === "contained" ? [{ label: "Incident on HCS", url: hashscan.topic(deploy.topics.incidents) }] : [];
  if (o.chain || !o.run) return dedupeLinks([...fromContain, ...topic]);
  const fromRun = proofFromRun(o.run.lines ?? [], o.run.links);
  const runStart = Date.parse(o.run.startedAt);
  const containFresh = o.contain.phase !== "idle" && (o.run.kind === "attack" || o.run.kind === "mint") && (o.contain.startMs === undefined || o.contain.startMs >= runStart - 5_000);
  return dedupeLinks(containFresh ? [...fromRun, ...fromContain, ...topic] : fromRun);
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
const ARKIV_WORD = { live: "live", expired: "expired", off: "off", hosted: "operator only" } as const;

export function TopBar({ treasury, health, arkiv, mirrorOk, chain = false }: { treasury?: TokenRelation | null; health: [string, ServiceStatus][]; arkiv: keyof typeof ARKIV_WORD; mirrorOk: boolean; chain?: boolean }) {
  const frozen = treasury?.freeze === "FROZEN";
  return (
    <header className="topbar cc-top">
      <Link to="/" className="wordmark">
        ▲ Levee
      </Link>
      <a className="tb-item mono" href={hashscan.token(deploy.token.tokenId)} target="_blank" rel="noreferrer">
        {sym} <span className="dim">{deploy.token.tokenId}</span>
      </a>
      <span className="tb-item">
        <span className="dim">Treasury</span>
        <span className="mono num tb-bal">{treasury?.balance != null ? `${fmt(treasury.balance).replace(/(\.\d{2})\d+$/, "$1")} ${sym}` : "…"}</span>
        <span className={`state-badge ${treasury ? (frozen ? "frozen" : "open") : ""}`}>{treasury ? (frozen ? "FROZEN" : "OPEN") : "…"}</span>
      </span>
      <span className="tb-health" aria-label="Status">
        {health.map(([name, s]) => (
          <span key={name} className="tb-dot" title={`${name}: ${HEALTH_WORD[s]}`}>
            <i className={`dot ${s}`} aria-hidden="true" />
            {name}
            {s === "up" ? <span className="sr-only"> up</span> : <span className="dim"> {HEALTH_WORD[s]}</span>}
          </span>
        ))}
        <a className={`arkiv-chip a-${arkiv}`} href={ARKIV_EXPLORER} target="_blank" rel="noreferrer" title="Phase 2 machine health pass on Arkiv (optional rule)">
          Arkiv pass: {ARKIV_WORD[arkiv]} {arkiv === "live" && <i className="dot up" aria-hidden="true" />}
        </a>
        <span className="tb-dot net">
          <i className={`dot ${mirrorOk ? "up" : "checking"}`} aria-hidden="true" />
          Hedera {deploy.network} · {chain ? "Mirror Node" : "live"}
        </span>
      </span>
    </header>
  );
}

// ------------------------------------------------------------------ KPI strip

export function KpiStrip({ kpis }: { kpis: Kpi[] }) {
  return (
    <ul className="cc-kpis" aria-label="Key figures">
      {kpis.map((k) => (
        <li key={k.key} className={`kpi${k.tone ? ` k-${k.tone}` : ""}`} title={k.sub ? `${k.label}: ${k.value} (${k.sub})` : undefined}>
          <span className="kpi-label">{k.label}</span>
          <span className="kpi-value mono num">{k.value}</span>
          {k.sub && <span className="kpi-sub">{k.sub}</span>}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ story

export function StoryPanel({ story, up, busy, run, error, onRun, thiefFrozen = false }: { story: StoryState; up: boolean; busy: boolean; run: RunView | null; error: string | null; onRun: (k: RunKind) => void; thiefFrozen?: boolean }) {
  return (
    <>
      <div className="card-head">
        <h2 id="story-h">
          The <span className="accent">story</span>
        </h2>
        <span className="eyebrow">{up ? "live on testnet" : "demo runner off"}</span>
      </div>
      <ol className="stepper">
        {STORY.map((s) => {
          const tone = stepTone(story, s.id);
          // the mint lands in the thief's account: while it is frozen (after ②) the mint would revert
          const blocked = s.id === "mint" && thiefFrozen;
          return (
            <li key={s.id} className={`step t-${tone}`}>
              <button type="button" className={`step-btn${s.primary ? " primary" : ""}`} disabled={!up || busy || blocked} onClick={() => onRun(s.kind)} aria-current={tone === "active" ? "step" : undefined}>
                <span className="step-n" aria-hidden="true">
                  {tone === "done" ? "✓" : s.n}
                </span>
                <span className="step-text">
                  <b>{s.label}</b>
                  <small>{tone === "active" && story.running ? "running…" : tone === "failed" ? "failed, see log" : blocked ? "thief's account is frozen: unlock ③ or reset first" : s.sub}</small>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <button type="button" className="btn ghost small reset-btn" disabled={!up || busy} onClick={() => onRun("reset")}>
        ↺ Reset demo
      </button>
      {!up && (
        <p className="dim small">
          Start the buttons with <code>DEMO_MODE=1 npm run demo:runner</code>.
        </p>
      )}
      {error && <p className="small warn">{error}</p>}
      {run && (
        <p className={`run-line small mono r-${run.status}`}>
          {run.kind} · {run.status === "running" ? "running…" : run.status === "ok" ? "done" : "failed"}
          {run.status === "failed" && run.lines?.length ? <span className="dim"> · {runError(run.lines)}</span> : null}
        </p>
      )}
    </>
  );
}

export const CHAIN_BANNER = "Services run on the operator's machine. Showing the chain: receipts, transfers and incidents read live from the Hedera Mirror Node.";

export function ChainBanner() {
  return (
    <p className="chain-note small" role="status">
      <i className="dot up" aria-hidden="true" /> {CHAIN_BANNER}
    </p>
  );
}

function ChainStory({ genuine, replay, onReplay }: { genuine: { incident: Incident; consensusAt: string } | null; replay: { done: boolean } | null; onReplay: () => void }) {
  return (
    <>
      <div className="card-head">
        <h2 id="story-h">
          The <span className="accent">story</span>
        </h2>
        <span className="eyebrow">hosted · Mirror Node</span>
      </div>
      <ChainBanner />
      {genuine ? (
        <div className="replay-box">
          <button type="button" className="btn" disabled={!!replay && !replay.done} onClick={onReplay}>
            {replay?.done ? "Replay again" : "Replay latest incident"}
          </button>
          <span className="dim small">Replays the step times recorded on chain for the incident of {formatDate(genuine.consensusAt)}. Not a live event.</span>
        </div>
      ) : (
        <p className="dim small">Reading the incidents topic…</p>
      )}
      <p className="dim small">
        The demo buttons drive the operator's own services. To run it yourself, clone{" "}
        <a href={GITHUB} target="_blank" rel="noreferrer">
          the repo
        </a>{" "}
        and run, for example, <code>{RUN_BUTTONS.find((b) => b.kind === "attack")!.cmd}</code>.
      </p>
    </>
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

// ------------------------------------------------------------------ containment stopwatch

export function ContainPanel({ s, reduced, extra }: { s: ContainState; reduced: boolean; extra?: ReactNode }) {
  const now = useNow(reduced ? 1000 : 47, s.phase === "running");
  const ms = elapsedMs(s, now);
  const stalled = s.phase === "running" && ms > 120_000;
  const stateText = s.source === "replay" ? (s.phase === "running" ? "Replay · containing (recorded)" : "Replay · contained (recorded)") : s.phase === "running" ? (stalled ? "Breach · waiting for the watcher" : "Breach live · containing") : s.phase === "contained" ? "Contained" : "All movements have receipts";
  const ms3 = milestones(s, deploy.treasury);
  return (
    <section className={`card-dark contain cc-watch ${s.phase}`} aria-labelledby="contain-h">
      <div className={`watch ${s.phase}`} role="timer" aria-live="off">
        <span className="state-line">
          <i className={`dot ${s.phase === "running" ? "breach" : s.phase === "contained" ? "up" : ""}`} aria-hidden="true" />
          <span id="contain-h">{stateText}</span>
          {s.source === "hcs" && <span className="dim"> · last incident, from HCS</span>}
          {s.source === "watcher" && <span className="dim"> · last incident</span>}
          {s.source === "replay" && <span className="dim"> · replay · recorded on-chain data</span>}
        </span>
        <span className="digits mono num">
          {stopwatch(ms)}
          <small>s</small>
        </span>
      </div>
      <ol className="milestones">
        {ms3.map((m) => (
          <li key={m.key} className={m.ms === null ? "pending" : "landed"}>
            <span className="ms-t mono num">{m.ms === null ? "–" : `${stopwatch(m.ms)} s`}</span>
            <span className="ms-l">{m.label}</span>
          </li>
        ))}
      </ol>
      {extra}
    </section>
  );
}

// ------------------------------------------------------------------ proof (QR)

const QR_SHOWN = 4;
export function ProofPanel({ links }: { links: ProofLink[] }) {
  const qr = links.slice(0, QR_SHOWN);
  const rest = links.slice(QR_SHOWN);
  return (
    <section className="card-dark cc-proofs" aria-labelledby="proof-h">
      <div className="card-head">
        <h2 id="proof-h">
          <span className="accent">Proof</span> on HashScan
        </h2>
        <span className="eyebrow">scan with your phone</span>
      </div>
      {links.length === 0 ? (
        <p className="dim small">Run a step: its receipt, transfer, freeze and wipe show up here with QR codes.</p>
      ) : (
        <ul className="qr-grid">
          {qr.map((l) => (
            <li key={l.url}>
              <a href={l.url} target="_blank" rel="noreferrer">
                <QR text={l.url} label={l.label} />
                <span className="qr-label">{l.label}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {rest.length > 0 && (
        <p className="more-links small">
          {rest.map((l) => (
            <a key={l.url} href={l.url} target="_blank" rel="noreferrer">
              {l.label}
            </a>
          ))}
        </p>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ before / after

const BEFORE = ["Resolv USR", "StablR", "Gala Games"];
export function BeforeAfter({ leveeS }: { leveeS: number | null }) {
  const rows = INDUSTRY.filter((c) => BEFORE.includes(c.name));
  return (
    <section className="card-dark cc-before" aria-labelledby="ba-h">
      <div className="card-head">
        <h2 id="ba-h">Before / after</h2>
        <span className="eyebrow">time to contain · log scale</span>
      </div>
      <ul className="ba-bars">
        {rows.map((c) => (
          <li key={c.name}>
            <a className="ba-name" href={c.source} target="_blank" rel="noreferrer" title={`${c.what} (${c.sourceName})`}>
              {c.name}
            </a>
            <span className="ba-track" aria-hidden="true">
              <i style={{ width: `${Math.max(2, logPos(c.seconds) * 100)}%` }} />
            </span>
            <span className="ba-val mono">{c.name === "StablR" ? `${c.shown} to ack.` : c.shown}</span>
          </li>
        ))}
        <li className="levee">
          <span className="ba-name">Levee</span>
          <span className="ba-track" aria-hidden="true">
            <i style={{ width: leveeS === null ? 0 : `${Math.max(2, logPos(leveeS) * 100)}%` }} />
          </span>
          <span className="ba-val mono">{leveeS === null ? "run ②" : `${leveeS.toFixed(2)} s`}</span>
        </li>
      </ul>
    </section>
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
    <section className="card-dark feed cc-feed" aria-labelledby="feed-h">
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
