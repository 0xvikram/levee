import { useRef, useState, type FormEvent } from "react";
import { HeroMedia } from "../components/HeroMedia";
import { Link, navigate } from "../components/router";
import { GITHUB, deploy, hashscan } from "../lib/config";
import { useShowcase, type Showcase } from "../lib/incident";
import { useCountUp, useRiseIn, useSeenOnce } from "../lib/hooks";

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

      <Footer />
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

function Footer() {
  const [imgOk, setImgOk] = useState(true);
  return (
    <footer className="footer">
      {imgOk && <img className="footer-img" src="/media/footer.jpg" alt="" aria-hidden="true" onError={() => setImgOk(false)} decoding="async" loading="lazy" />}
      <div className="footer-inner">
        <div className="footer-brand">
          <span className="footer-word">Levee</span>
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
        <div className="footer-base">
          <span>Built at ETHGlobal Mumbai 2026 · Hedera {deploy.network}</span>
          <span className="fine">Independent project, not affiliated with Hedera.</span>
        </div>
      </div>
    </footer>
  );
}
