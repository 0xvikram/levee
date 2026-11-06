import { useEffect, useRef, useState, type ReactNode } from "react";
import "./landing.css";
import { HeroMedia } from "../components/HeroMedia";
import { Link } from "../components/router";
import { ARKIV_EXPLORER, GITHUB, MIRROR, deploy, hashscan } from "../lib/config";
import { FACTS, INDUSTRY, TICKS, logPos } from "../lib/numbers";
import { useShowcase, type Showcase } from "../lib/incident";
import { usePrefersReducedMotion, useRiseIn } from "../lib/hooks";

const DOCS = `${GITHUB}/tree/build/docs-site`;
const API_DOCS = `${GITHUB}/tree/build/docs-site/api-reference`;
const QUICKSTART = `${GITHUB}/blob/build/docs-site/quickstart.mdx`;
const SCOPE = `${GITHUB}/blob/build/docs/SCOPE.md`;
/** Root suite (`npx vitest run` in the repo root, 7 Nov 2026). Shown with the CI link. */
const ROOT_TESTS = 351;

const sec = (s: number) => `${s.toFixed(2)} s`;
const about = (s: number) => `~${Math.max(1, Math.round(s))} s`;

export function Landing() {
  useRiseIn();
  const m = useShowcase();

  useEffect(() => {
    document.documentElement.classList.add("lp-page");
    return () => document.documentElement.classList.remove("lp-page");
  }, []);

  return (
    <div className="lp">
      <a className="lp-skip" href="#main">
        Skip to content
      </a>
      <header className="lp-hero">
        <HeroMedia parallax />
        <div className="lp-nav">
          <Link to="/" className="lp-logo">
            ▲ Levee
          </Link>
          <nav aria-label="Main">
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
            <a href={DOCS} target="_blank" rel="noreferrer">
              Docs
            </a>
            <Link to="/live" className="lp-btn primary small">
              Watch it live
            </Link>
          </nav>
        </div>

        <div className="lp-hero-copy">
          <span className="lp-chip">
            <i aria-hidden="true" /> Live on Hedera {deploy.network}
          </span>
          <h1>
            Hacked? Your stablecoin <span className="accent">snaps back</span> in seconds.
          </h1>
          <p>For stablecoin issuers on Hedera. No receipt, no movement.</p>
          <div className="lp-ctas">
            <Link to="/live" className="lp-btn primary">
              Watch it live
            </Link>
            <a className="lp-btn ghost" href={DOCS} target="_blank" rel="noreferrer">
              Read the docs
            </a>
          </div>
        </div>
      </header>

      <div className="lp-window-wrap">
        <ProductWindow />
      </div>

      <HederaStrip />

      <main id="main">
        <ProblemSection m={m} />
        <HowSection m={m} />
        <ProofSection m={m} />
        <FitSection />
        <PricingSection />
        <FaqSection />
      </main>

      <Footer />
    </div>
  );
}

// ---------------------------------------------------------------- product window

/**
 * Browser-style window that plays the recorded demo. Sources are attached only once the window is
 * near the screen, it plays muted on a loop while visible and pauses when scrolled away. Layers:
 * gradient → poster still → video, so a missing file just leaves the layer below showing.
 * Reduced motion: the still only. The whole window is a link to /live.
 */
export function ProductWindow() {
  const reduced = usePrefersReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  const vid = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  const [visible, setVisible] = useState(false);
  const [posterOk, setPosterOk] = useState(true);
  const [videoOk, setVideoOk] = useState(true);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        setVisible(e.isIntersecting);
        if (e.isIntersecting) setNear(true);
      },
      { rootMargin: "200px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const showVideo = near && !reduced && videoOk;
  useEffect(() => {
    const v = vid.current;
    if (!v) return;
    v.muted = true; // React does not always write the attribute, which autoplay needs
    if (visible) v.play?.()?.catch(() => undefined);
    else v.pause?.();
  }, [visible, showVideo]);

  return (
    <div className="lp-window-shell" ref={box}>
    <Link to="/live" className="lp-window" aria-label="Open the live demo: a theft frozen and taken back on Hedera testnet" data-testid="product-window">
      <span className="lp-window-bar" aria-hidden="true">
        <span className="lp-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="lp-window-title">levee · live</span>
        <span className="lp-window-open">Open ↗</span>
      </span>
      <span className="lp-window-body" aria-hidden="true">
        {posterOk && <img src="/media/demo-poster.jpg" alt="" decoding="async" loading="lazy" onError={() => setPosterOk(false)} />}
        {showVideo && (
          <video ref={vid} muted autoPlay loop playsInline preload="metadata" poster={posterOk ? "/media/demo-poster.jpg" : undefined} onError={(e) => e.target === e.currentTarget && setVideoOk(false)}>
            <source src="/media/demo.webm" type="video/webm" />
            {/* a failed <source> fires error on itself (React bubbles it to the video's onError, hence the target check); only the last one means none could play */}
            <source src="/media/demo.mp4" type="video/mp4" onError={() => setVideoOk(false)} />
          </video>
        )}
        {!posterOk && !showVideo && (
          <span className="lp-window-empty">
            <b>levee · live</b>
            <span>Watch a theft frozen and taken back</span>
          </span>
        )}
      </span>
    </Link>
    </div>
  );
}

// ---------------------------------------------------------------- Built on Hedera

const SERVICES = ["Stablecoin Studio", "Consensus Service", "Scheduled Transactions", "Threshold keys", "Smart contract (verified)", "Mirror Node", "Arkiv"];

export function HederaStrip() {
  return (
    <section className="lp-strip" aria-label="Built on Hedera">
      <span className="lp-strip-label">Built on Hedera</span>
      <ul>
        {SERVICES.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- shared bits

function Pill({ children }: { children: ReactNode }) {
  return <span className="lp-pill">{children}</span>;
}

function Src({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="lp-src" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

// ---------------------------------------------------------------- 1. problem

function ProblemSection({ m }: { m: Showcase }) {
  return (
    <section className="lp-section" id="problem" aria-labelledby="problem-h">
      <div className="lp-inner">
        <div className="lp-head" data-rise>
          <Pill>The problem</Pill>
          <h2 id="problem-h">
            Hacks take <span className="accent">hours</span> to stop.
          </h2>
          <p className="lp-lede">By the time a team is awake and on a call, the stolen tokens are swapped and bridged away.</p>
        </div>
        <CompareChart leveeS={m.wipedS} leveeTx={m.wipeTx} live={m.live} />
      </div>
    </section>
  );
}

export function CompareChart({ leveeS, leveeTx, live = false }: { leveeS: number; leveeTx: string; live?: boolean }) {
  const rows = [
    ...INDUSTRY.map((c) => ({ key: c.name, name: c.name, when: c.when, shown: c.shown, what: c.what, pos: logPos(c.seconds), href: c.source, srcName: c.sourceName, levee: false })),
    {
      key: "levee",
      name: "Levee",
      when: live ? "latest incident" : "measured run",
      shown: sec(leveeS),
      what: "theft to thief wiped and frozen, Hedera testnet",
      pos: logPos(leveeS),
      href: hashscan.tx(leveeTx),
      srcName: "HashScan",
      levee: true,
    },
  ];
  return (
    <figure className="lp-chart lp-glass" data-rise>
      <figcaption>
        <span className="lp-chart-title">Time to contain, log scale</span>
        <span className="lp-muted small">As each team or the press reported it. Each step right is ten times longer.</span>
      </figcaption>
      <ul className="lp-bars">
        {rows.map((r) => (
          <li key={r.key} className={r.levee ? "levee" : undefined}>
            <span className="lp-bar-name">
              <b>{r.name}</b> · {r.when}
            </span>
            <span className="lp-bar-val mono num">{r.shown}</span>
            <svg className="lp-track" viewBox="0 0 1000 14" preserveAspectRatio="none" aria-hidden="true" focusable="false">
              {TICKS.map((t) => (
                <line key={t.s} x1={logPos(t.s) * 1000} x2={logPos(t.s) * 1000} y1="0" y2="14" className="lp-grid" vectorEffect="non-scaling-stroke" />
              ))}
              <rect x="0" y="2" width={Math.max(6, r.pos * 1000)} height="10" rx="5" className="lp-bar" data-pos={r.pos.toFixed(4)} />
            </svg>
            <span className="lp-bar-what">
              {r.what} · <Src href={r.href}>{r.srcName}</Src>
            </span>
          </li>
        ))}
      </ul>
      <div className="lp-axis mono" aria-hidden="true">
        {TICKS.map((t) => (
          <span key={t.s} style={{ left: `${(logPos(t.s) * 100).toFixed(2)}%` }}>
            {t.label}
          </span>
        ))}
      </div>
    </figure>
  );
}

// ---------------------------------------------------------------- 2. how it works

function Engraving({ n }: { n: number }) {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return <img className="lp-card-art" src={`/media/section-engraving-${n}.jpg`} alt="" aria-hidden="true" loading="lazy" decoding="async" onError={() => setOk(false)} />;
}

export function HowSection({ m }: { m: Showcase }) {
  const steps = [
    { title: "Every payment gets a receipt on Hedera", text: "Your payout service asks Levee first. Levee writes a receipt to a Hedera topic, then co-signs the payment." },
    { title: `No receipt = theft, caught in ${about(m.detectionS)}`, text: "The watcher reads every movement from the Mirror Node. Anything that leaves without a receipt is a theft, whoever signed it." },
    { title: `Frozen and taken back in ${about(m.wipedS)} · 2 of 3 to unlock`, text: "A close-only contract freezes the treasury and wipes the thief. Only 2 of 3 admins, signing together, can reopen." },
  ];
  return (
    <section className="lp-section" id="how" aria-labelledby="how-h">
      <div className="lp-inner">
        <div className="lp-head" data-rise>
          <Pill>How it works</Pill>
          <h2 id="how-h">
            One rule: no receipt, no <span className="accent">movement</span>.
          </h2>
        </div>
        <ol className="lp-steps">
          {steps.map((s, i) => (
            <li key={i} className="lp-glass lp-step" data-rise>
              <Engraving n={i + 1} />
              <span className="lp-step-n mono" aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3>{s.title}</h3>
              <p className="lp-muted">{s.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- 3. proof

export function ProofSection({ m }: { m: Showcase }) {
  const stats: { value: string; label: string; href: string; src: string }[] = [
    { value: sec(m.detectionS), label: "theft detected", href: hashscan.tx(m.attackTx), src: "the theft" },
    { value: sec(m.wipedS), label: "contained: frozen and wiped", href: hashscan.tx(m.wipeTx), src: "the wipe" },
    { value: String(FACTS.falseAlarms), label: `false alarms in ${FACTS.matchedSends} payments`, href: FACTS.liveRun, src: "LIVE_RUN.md" },
    { value: "✓", label: "contract verified", href: hashscan.contract(deploy.controller), src: `HashScan ${deploy.controller}` },
    { value: String(ROOT_TESTS), label: "automated tests", href: FACTS.ci, src: "CI" },
  ];
  return (
    <section className="lp-section" id="proof" aria-labelledby="proof-h">
      <div className="lp-inner">
        <div className="lp-head" data-rise>
          <Pill>Proof</Pill>
          <h2 id="proof-h">
            Measured on Hedera, not <span className="accent">promised</span>.
          </h2>
          <p className="lp-lede">
            {m.live ? "Read live from the incidents topic" : "The measured run"} · {m.date}
          </p>
        </div>
        <ul className="lp-stats" data-rise>
          {stats.map((s) => (
            <li key={s.label}>
              <b className="num">{s.value}</b>
              <span>{s.label}</span>
              <Src href={s.href}>{s.src}</Src>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- 4. fit

function FitSection() {
  return (
    <section className="lp-section" id="fit" aria-labelledby="fit-h">
      <div className="lp-inner">
        <div className="lp-head" data-rise>
          <Pill>Who it's for</Pill>
          <h2 id="fit-h">
            Built for issuers, <span className="accent">only</span>.
          </h2>
        </div>
        <div className="lp-fit">
          <article className="lp-glass lp-fit-card" data-rise>
            <span className="lp-mark yes" aria-hidden="true">
              ✓
            </span>
            <h3>For issuers of their own Stablecoin Studio token</h3>
            <ul>
              <li>You hold the token's freeze and wipe keys</li>
              <li>Your treasury pays known partners and distributors</li>
              <li>You want stolen keys and rogue insiders undone, on chain</li>
            </ul>
          </article>
          <article className="lp-glass lp-fit-card" data-rise>
            <span className="lp-mark no" aria-hidden="true">
              ✕
            </span>
            <h3>Not for USDC or tokens you didn't issue</h3>
            <ul>
              <li>Taking tokens back needs the token's own wipe key</li>
              <li>Only the issuer holds it: nobody but Circle can wipe USDC</li>
              <li>
                <a href={SCOPE} target="_blank" rel="noreferrer">
                  Full scope and limits
                </a>
              </li>
            </ul>
          </article>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- 5. pricing

const PLANS = [
  {
    name: "Watch",
    price: "$0",
    per: "on testnet",
    note: "$300/mo on mainnet",
    features: ["Receipts and the watcher", "Freeze on a breach (freeze only)", "Every incident logged on Hedera"],
    cta: "Start on testnet",
    href: QUICKSTART,
    primary: false,
  },
  {
    name: "Issuer",
    price: "$1,500",
    per: "/mo",
    note: "Up to 3 tokens",
    features: ["Freeze and wipe: tokens taken back", "2 of 3 admins to reopen", "Close-only contract on your token"],
    cta: "Read the setup guide",
    href: DOCS,
    primary: true,
  },
  {
    name: "Institutional",
    price: "Custom",
    per: "",
    note: "More tokens, your rules",
    features: ["Stricter rules: caps, known recipients", "Deployment agreed together", "Mainnet checklist review"],
    cta: "Open an issue on GitHub",
    href: `${GITHUB}/issues`,
    primary: false,
  },
];

export function PricingSection() {
  return (
    <section className="lp-section lp-pricing" id="pricing" aria-labelledby="pricing-h">
      <span className="lp-pricing-word" aria-hidden="true">
        Pricing
      </span>
      <div className="lp-inner">
        <div className="lp-head" data-rise>
          <Pill>Early access · pricing not final</Pill>
          <h2 id="pricing-h">
            Simple plans, <span className="accent">early</span>.
          </h2>
        </div>
        <ul className="lp-plans">
          {PLANS.map((p) => (
            <li key={p.name} className={`lp-glass lp-plan${p.primary ? " featured" : ""}`} data-rise>
              <h3>{p.name}</h3>
              <p className="lp-price">
                <b className="num">{p.price}</b>
                {p.per && <span>{p.per}</span>}
              </p>
              <p className="lp-muted small">{p.note}</p>
              <ul>
                {p.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              <a className={`lp-btn ${p.primary ? "primary" : "ghost"}`} href={p.href} target="_blank" rel="noreferrer">
                {p.cta}
              </a>
            </li>
          ))}
        </ul>
        <p className="lp-muted small lp-center">Early access on Hedera testnet. Prices may change before mainnet.</p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- 6. FAQ

const FAQ: { q: string; a: string }[] = [
  {
    q: "Can it protect USDC?",
    a: "No. Levee only protects tokens you issue, because taking tokens back needs the token's own freeze and wipe keys. Nobody but Circle has those for USDC.",
  },
  {
    q: "We already use Fireblocks or a multisig. Why Levee?",
    a: "They stop bad requests that go through them, before signing. A stolen quorum or an insider signing outside them is not seen. Levee watches the ledger whoever signed and undoes what has no receipt. Use both: Fireblocks first, Levee second.",
  },
  {
    q: "What if the watcher is down?",
    a: "No payments go out: the gate refuses to sign without a recent watcher heartbeat on Hedera. Honest limit: a thief who skips the gate while the watcher is down is reported when it restarts, but not taken back automatically. An admin has to act.",
  },
  {
    q: "What if the funds already moved on?",
    a: "The treasury is frozen first, so nothing more can leave. The wipe takes what is still in the thief's account and freezes it. Tokens already sent on to a second account are not chased yet; that is on the roadmap.",
  },
  {
    q: "Why Hedera?",
    a: "Stablecoin Studio tokens have native freeze, wipe and pause roles, so a contract can take tokens back without custom token code. Consensus Service gives every receipt a public, ordered timestamp. 2-of-3 keys are built in, and fees are low and fixed in USD.",
  },
];

export function FaqSection() {
  return (
    <section className="lp-section" id="faq" aria-labelledby="faq-h">
      <div className="lp-inner lp-faq-inner">
        <div className="lp-head" data-rise>
          <Pill>FAQ</Pill>
          <h2 id="faq-h">
            Straight <span className="accent">answers</span>.
          </h2>
        </div>
        <div className="lp-faq" data-rise>
          {FAQ.map((f) => (
            <details key={f.q}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- 7. footer

export function Footer() {
  const [imgOk, setImgOk] = useState(true);
  return (
    <footer className="lp-footer">
      {imgOk && <img className="lp-footer-art" src="/media/footer-engraving.jpg" alt="" aria-hidden="true" loading="lazy" decoding="async" onError={() => setImgOk(false)} />}
      <div className="lp-footer-inner">
        <div className="lp-footer-brand">
          <span className="lp-footer-word">Levee</span>
          <p>
            No receipt, no <span className="accent">movement</span>.
          </p>
        </div>
        <div className="lp-footer-cols">
          <div>
            <h2 className="lp-footer-h">Product</h2>
            <Link to="/live">Live demo</Link>
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
          </div>
          <div>
            <h2 className="lp-footer-h">Developers</h2>
            <a href={DOCS} target="_blank" rel="noreferrer">
              Docs
            </a>
            <a href={GITHUB} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href={API_DOCS} target="_blank" rel="noreferrer">
              API
            </a>
          </div>
          <div>
            <h2 className="lp-footer-h">Proof</h2>
            <a href={hashscan.token(deploy.token.tokenId)} target="_blank" rel="noreferrer">
              Token {deploy.token.tokenId}
            </a>
            <a href={hashscan.contract(deploy.controller)} target="_blank" rel="noreferrer">
              Contract {deploy.controller}
            </a>
            <a href={hashscan.topic(deploy.topics.incidents)} target="_blank" rel="noreferrer">
              Incidents topic {deploy.topics.incidents}
            </a>
            <a href={`${MIRROR}/api/v1/topics/${deploy.topics.incidents}/messages?order=desc&limit=5`} target="_blank" rel="noreferrer">
              Mirror Node feed
            </a>
            <a href={ARKIV_EXPLORER} target="_blank" rel="noreferrer">
              Arkiv explorer
            </a>
          </div>
        </div>
        <div className="lp-footer-base">
          <span>Built at ETHGlobal Mumbai 2026 · Hedera {deploy.network}</span>
          <span>Independent project, not affiliated with Hedera.</span>
        </div>
      </div>
    </footer>
  );
}
