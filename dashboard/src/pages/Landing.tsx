import { useEffect, useRef, useState, type FormEvent } from "react";
import { FooterScene, useFooterFeed } from "../components/FooterScene";
import { HeroMedia } from "../components/HeroMedia";
import { Link, navigate } from "../components/router";
import { GITHUB, deploy, hashscan, services } from "../lib/config";
import { useShowcase, type Showcase } from "../lib/incident";
import { useCountUp, usePoll, usePrefersReducedMotion, useRiseIn, useSeenOnce } from "../lib/hooks";
import type { WatcherSnapshot } from "../lib/types";

const INCIDENTS = [
  { name: "Resolv USR", when: "Mar 2026", big: "~$25M", note: "extracted before anyone could stop it" },
  { name: "StablR", when: "May 2026", big: "~$2.8M", note: "cashed out by the attacker" },
  { name: "Gala Games", when: "May 2024", big: "~$21M", note: "minted, about 45 minutes to stop" },
  { name: "Hedera", when: "Mar 2023", big: "~$600K", note: "taken, 11 hours to contain" },
];

const stepsFor = (m: Showcase) => [
  { t: 0, label: "Tokens leave the treasury with no receipt", tx: m.attackTx, link: "The theft" },
  { t: m.detectionS, label: "The watcher finds no receipt for it", tx: null, link: null },
  { t: m.treasuryFrozenS, label: "Treasury frozen by the close-only contract", tx: m.freezeTx, link: "The freeze" },
  { t: m.wipedS, label: `${m.wipedAmount} ${deploy.token.symbol} wiped from the attacker, attacker frozen`, tx: m.wipeTx, link: "The wipe" },
];

const DOCS = `${GITHUB}#readme`;
const BRAND = `${GITHUB}/blob/build/brand.html`;

export function Landing() {
  useRiseIn();
  const showcase = useShowcase();
  const [token, setToken] = useState("");
  const watch = (e: FormEvent) => {
    e.preventDefault();
    const t = token.trim();
    navigate(t ? `/live?token=${encodeURIComponent(t)}` : "/live");
  };

  return (
    <>
      <header className="hero">
        <HeroMedia parallax />
        <div className="nav">
          <Link to="/" className="logo">
            ▲ Levee
          </Link>
          <nav aria-label="Main">
            <a href="#how">How it works</a>
            <a href={GITHUB} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <Link to="/live" className="btn small">
              Live demo
            </Link>
          </nav>
        </div>

        <div className="hero-copy">
          <span className="chip">✦ Built on Hedera Stablecoin Studio</span>
          <h1>
            Stop a theft before it <span className="accent">spreads</span>
          </h1>
          <p>No receipt, no movement. Anything that moves without one is frozen and undone in seconds.</p>
          <form className="search" onSubmit={watch} role="search">
            <label htmlFor="token" className="sr-only">
              Hedera token ID
            </label>
            <input id="token" type="text" inputMode="text" autoComplete="off" spellCheck={false} placeholder="Paste a Hedera token ID…" value={token} onChange={(e) => setToken(e.target.value)} />
            <button className="btn" type="submit">
              Watch token
            </button>
          </form>
        </div>
      </header>

      <main>
        <ReceiptSection />
        <ContainSection m={showcase} />
        <NumbersSection m={showcase} />
        <IncidentsSection />
        <ReopenSection />
      </main>

      <Footer showcase={showcase} />
    </>
  );
}

// ---------------------------------------------------------------- a) receipt

function ReceiptSection() {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeenOnce(ref, 0.4);
  return (
    <section className="section" id="how">
      <div className="section-inner split">
        <div className="section-head" data-rise>
          <span className="eyebrow">01 · The rule</span>
          <h2>
            Every move needs a <span className="accent">receipt</span>
          </h2>
          <p className="muted">
            Before the treasury sends a single token, the gate writes an approved receipt to a Hedera topic. It only signs for machines whose health heartbeats keep a live 180-second pass on Arkiv. A watcher reads every movement from the Mirror Node and matches it to its receipt.
          </p>
        </div>
        <div ref={ref} className={`receipt-seq${seen ? " play" : ""}`} aria-label="A receipt, then the transfer it allows">
          <article className="mini-card receipt-card">
            <span className="eyebrow">Receipt · HCS topic {deploy.topics.receipts}</span>
            <span className="mc-line mono">approved · payouts-server</span>
            <span className="mc-big mono num">500 {deploy.token.symbol}</span>
            <span className="mc-line mono">→ {deploy.payees[0] ?? "0.0.x"}</span>
          </article>
          <span className="connector" aria-hidden="true">
            <i />
            <b>✓</b>
          </span>
          <article className="mini-card transfer-card">
            <span className="eyebrow">Transfer · treasury {deploy.treasury}</span>
            <span className="mc-line mono">matched to receipt</span>
            <span className="mc-big mono num">500 {deploy.token.symbol}</span>
            <span className="mc-line mono">→ {deploy.payees[0] ?? "0.0.x"}</span>
          </article>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- b) containment

function ContainSection({ m }: { m: Showcase }) {
  const ref = useRef<HTMLOListElement>(null);
  const seen = useSeenOnce(ref, 0.3);
  return (
    <section className="section dark" id="contain">
      <div className="section-inner">
        <div className="section-head" data-rise>
          <span className="eyebrow">02 · No receipt</span>
          <h2>
            What happens when it <span className="accent">doesn't</span>
          </h2>
          <p className="muted">A stolen 2-of-3 key pair sent {m.wipedAmount} {deploy.token.symbol} straight from the treasury on Hedera testnet, skipping the gate. This is what the chain recorded, timed from the theft reaching consensus.</p>
        </div>
        <ol ref={ref} className={`contain-steps${seen ? " play" : ""}`}>
          {stepsFor(m).map((s, i) => (
            <li key={s.label} style={{ ["--i" as string]: i }}>
              <span className="cs-time mono num">
                {s.t.toFixed(2)}
                <small>s</small>
              </span>
              <span className="cs-dot" aria-hidden="true" />
              <span className="cs-label">
                {s.label}
                {s.tx && (
                  <a href={hashscan.tx(s.tx)} target="_blank" rel="noreferrer">
                    {s.link} on HashScan
                  </a>
                )}
              </span>
            </li>
          ))}
        </ol>
        <p className="links" data-rise>
          <a href={hashscan.topic(deploy.topics.incidents)} target="_blank" rel="noreferrer">
            The published incident · topic {deploy.topics.incidents}
          </a>
          <Link to="/live">Watch it happen live</Link>
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- c) numbers

function Figure({ value, decimals, unit, label, start }: { value: number; decimals: number; unit?: string; label: string; start: boolean }) {
  const v = useCountUp(value, start);
  const text = decimals ? v.toFixed(decimals) : Math.round(v).toLocaleString("en-US");
  return (
    <div className="figure">
      <span className="fig-val mono num" aria-hidden="true">
        {text}
        {unit && <small>{unit}</small>}
      </span>
      <span className="sr-only">
        {decimals ? value.toFixed(decimals) : value.toLocaleString("en-US")} {unit}
      </span>
      <span className="fig-label">{label}</span>
    </div>
  );
}

function NumbersSection({ m }: { m: Showcase }) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeenOnce(ref, 0.3);
  return (
    <section className="section" id="numbers">
      <div className="section-inner">
        <div className="section-head" data-rise>
          <span className="eyebrow">03 · {m.live ? "Latest run" : "Measured"} on Hedera testnet, {m.date}</span>
          <h2>
            Frozen and undone in <span className="accent">{m.wipedS.toFixed(2)} seconds</span>
          </h2>
        </div>
        <div ref={ref} className="figures">
          <Figure value={m.detectionS} decimals={2} unit="s" label="Theft detected" start={seen} />
          <Figure value={m.treasuryFrozenS} decimals={2} unit="s" label="Treasury frozen" start={seen} />
          <Figure value={m.wipedS} decimals={2} unit="s" label="Stolen tokens wiped, attacker frozen" start={seen} />
          <Figure value={m.wipedValue} decimals={m.wipedValue % 1 ? 2 : 0} unit={deploy.token.symbol} label="Taken back from the attacker" start={seen} />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- d) incidents

function IncidentsSection() {
  return (
    <section className="section haze-ground" id="problem">
      <div className="section-inner">
        <div className="section-head" data-rise>
          <span className="eyebrow">04 · Why seconds matter</span>
          <h2>
            Others found out after the money <span className="accent">left</span>
          </h2>
          <p className="muted">By the time people are awake and on a call, stolen tokens have been swapped and bridged away.</p>
        </div>
        <div className="incidents">
          {INCIDENTS.map((i) => (
            <article className="incident" key={i.name} data-rise>
              <span className="eyebrow">
                {i.name} · {i.when}
              </span>
              <span className="inc-big num">{i.big}</span>
              <span className="muted">{i.note}</span>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- e) reopen

function Key({ turn }: { turn: boolean }) {
  return (
    <span className={`key${turn ? " turns" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 64 64" width="64" height="64">
        <circle cx="22" cy="32" r="12" fill="none" stroke="currentColor" strokeWidth="4" />
        <path d="M34 32h24M50 32v9M58 32v7" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function ReopenSection() {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeenOnce(ref, 0.5);
  return (
    <section className="section" id="reopen">
      <div className="section-inner split">
        <div className="section-head" data-rise>
          <span className="eyebrow">05 · Reopening</span>
          <h2>
            The robot only closes doors. Two people reopen <span className="accent">them</span>
          </h2>
          <p className="muted">The containment contract can freeze, wipe and publish. It cannot unfreeze. Reopening needs two of the three admins to sign, so a stolen watcher key can only ever lock things.</p>
          <div>
            <Link to="/live" className="btn">
              Watch it live
            </Link>
          </div>
        </div>
        <div ref={ref} className={`keys${seen ? " play" : ""}`}>
          {deploy.admins.slice(0, 3).map((a, i) => (
            <a key={a} className="key-card" href={hashscan.account(a)} target="_blank" rel="noreferrer">
              <Key turn={i < 2} />
              <span className="eyebrow">Admin {i + 1}</span>
              <span className="mono small">{a}</span>
              <span className="small key-state">{i < 2 ? "signed" : "not needed"}</span>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- footer

const WORD = "Levee";

function Footer({ showcase }: { showcase: Showcase }) {
  const reduced = usePrefersReducedMotion();
  const root = useRef<HTMLElement>(null);
  const light = useRef<HTMLDivElement>(null);
  const letters = useRef<(HTMLSpanElement | null)[]>([]);
  const vid = useRef<HTMLVideoElement>(null);
  const [imgOk, setImgOk] = useState(true);
  const [videoFailed, setVideoFailed] = useState(false);
  const [started, setStarted] = useState(false); // footer has neared the viewport once
  const [onScreen, setOnScreen] = useState(false);
  const [fine, setFine] = useState(false);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setStarted(true);
      setOnScreen(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        setOnScreen(e.isIntersecting);
        if (e.isIntersecting) setStarted(true);
      },
      { rootMargin: "300px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const m = window.matchMedia?.("(pointer: fine)");
    if (!m) return;
    const on = () => setFine(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);

  const showVideo = started && !reduced && !videoFailed;
  useEffect(() => {
    const v = vid.current;
    if (!v) return;
    v.muted = true; // React does not always write the attribute, which some browsers need before autoplay
    if (onScreen) v.play?.()?.catch(() => undefined);
    else v.pause?.();
  }, [onScreen, showVideo]);

  // cursor light + wordmark lean (pointer: fine only, transforms only)
  const interactive = fine && !reduced;
  useEffect(() => {
    const el = root.current;
    if (!el || !interactive) return;
    let raf = 0;
    let px = 0;
    let py = 0;
    const paint = () => {
      raf = 0;
      const box = el.getBoundingClientRect();
      if (light.current) light.current.style.transform = `translate3d(${(px - box.left).toFixed(0)}px, ${(py - box.top).toFixed(0)}px, 0) translate(-50%, -50%)`;
      for (const l of letters.current) {
        if (!l) continue;
        const r = l.getBoundingClientRect();
        const dx = px - (r.left + r.width / 2);
        const dy = py - (r.top + r.height / 2);
        const pull = Math.exp(-Math.hypot(dx, dy) / 420);
        const lift = -12 * pull;
        const tilt = Math.max(-1, Math.min(1, dx / 300)) * 7 * pull;
        l.style.transform = `translate3d(0, ${lift.toFixed(2)}px, 0) rotate(${tilt.toFixed(2)}deg)`;
      }
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
      px = e.clientX;
      py = e.clientY;
      el.classList.add("lit");
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const leave = () => {
      el.classList.remove("lit");
      for (const l of letters.current) if (l) l.style.transform = "";
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      leave();
    };
  }, [interactive]);

  const feed = useFooterFeed(started, onScreen);
  const watcher = usePoll<WatcherSnapshot>(started ? `${services.watcher}/state` : "", 15_000);
  const matched = watcher.reachable && typeof watcher.data?.matched === "number" ? watcher.data.matched : null;

  return (
    <footer ref={root} className={`footer${interactive ? " footer-live" : ""}`}>
      {imgOk && (
        <img
          className={`footer-img${videoFailed && !reduced ? " drift" : ""}`}
          src="/media/footer.jpg"
          alt=""
          aria-hidden="true"
          onError={() => setImgOk(false)}
          decoding="async"
          loading="lazy"
        />
      )}
      {showVideo && (
        <video
          ref={vid}
          className="footer-img"
          muted
          autoPlay
          loop
          playsInline
          preload="metadata"
          poster={imgOk ? "/media/footer.jpg" : undefined}
          aria-hidden="true"
          onError={() => setVideoFailed(true)}
        >
          <source src="/media/footer.webm" type="video/webm" />
          {/* a missing source fires error on the <source>, not the <video> */}
          <source src="/media/footer.mp4" type="video/mp4" onError={() => setVideoFailed(true)} />
        </video>
      )}
      {!reduced && <FooterScene active={onScreen} feed={feed} />}
      {interactive && <div ref={light} className="footer-light" aria-hidden="true" />}
      <div className="footer-inner">
        <div className="footer-brand">
          <span className="footer-word" role="img" aria-label={WORD}>
            {WORD.split("").map((ch, i) => (
              <span key={i} ref={(n) => void (letters.current[i] = n)} aria-hidden="true">
                {ch}
              </span>
            ))}
          </span>
          <p>
            No receipt, no movement. Anything that moves without one is frozen and <span className="accent">undone</span>.
          </p>
        </div>
        <div className="footer-cols">
          <div>
            <span className="eyebrow">Product</span>
            <a href="#how">How it works</a>
            <Link to="/live">Live demo</Link>
          </div>
          <div>
            <span className="eyebrow">Proof</span>
            <a href={hashscan.token(deploy.token.tokenId)} target="_blank" rel="noreferrer">
              Token {deploy.token.tokenId}
            </a>
            <a href={hashscan.contract(deploy.controller)} target="_blank" rel="noreferrer">
              Controller {deploy.controller}
            </a>
            <a href={hashscan.topic(deploy.topics.incidents)} target="_blank" rel="noreferrer">
              Incidents topic {deploy.topics.incidents}
            </a>
          </div>
          <div>
            <span className="eyebrow">Build</span>
            <a href={GITHUB} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href={DOCS} target="_blank" rel="noreferrer">
              Docs
            </a>
            <a href={BRAND} target="_blank" rel="noreferrer">
              Brand
            </a>
          </div>
        </div>
        <p className="footer-ticker" aria-live="off">
          {matched !== null && (
            <span>
              <b>{matched.toLocaleString("en-US")}</b> {matched === 1 ? "payment" : "payments"} matched today
            </span>
          )}
          {showcase.live && (
            <a href={hashscan.tx(showcase.wipeTx)} target="_blank" rel="noreferrer">
              last incident contained in <b>{showcase.wipedS.toFixed(2)} s</b>
            </a>
          )}
          <a href={hashscan.topic(deploy.topics.receipts)} target="_blank" rel="noreferrer">
            receipts topic <span className="mono">{deploy.topics.receipts}</span>
          </a>
          {feed.sse === "open" && <span className="footer-dot">live</span>}
        </p>
        <div className="footer-base">
          <span>Built at ETHGlobal Mumbai 2026 · Hedera {deploy.network}</span>
          <span className="fine">Independent project, not affiliated with Hedera.</span>
        </div>
      </div>
    </footer>
  );
}
