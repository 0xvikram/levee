import { useEffect, useRef, useState, type ReactNode } from "react";
import "./landing.css";
import { DitherImage } from "../components/DitherImage";
import { Link } from "../components/router";
import { SiteLogo } from "../components/SiteLogo";
import { ChevronMark } from "../components/logos";
import { ARKIV_EXPLORER, DOCS, GITHUB, MIRROR, deploy, hashscan } from "../lib/config";
import { FACTS, INDUSTRY, TICKS, logPos } from "../lib/numbers";
import { FALLBACK_SHOWCASE, useShowcase, type Showcase } from "../lib/incident";
import { usePrefersReducedMotion, useRiseIn } from "../lib/hooks";

const SCOPE = `${GITHUB}/blob/build/docs/SCOPE.md`;
/** The product window plays the recorded demo when true; until the new video lands it shows a cobalt mock with the live numbers. */
export const DEMO_VIDEO = false;
/** Media lives only in the hero and the footer. The hero engraving's own sampled sky is the dither's dark tone and the hero ground. */
const ART = {
  hero: { src: "/media/engraving/hero.jpg", sky: "#203C91" },
  footer: "/media/footer-engraving.jpg",
};
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
        <DitherImage className="lp-hero-art" src={ART.hero.src} dark={ART.hero.sky} priority posY={1} cell={1.5} />
        <div className="lp-hero-scrim" aria-hidden="true" />
        <div className="lp-nav">
          <Link to="/" className="lp-logo">
            <SiteLogo />
          </Link>
          <nav aria-label="Main">
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
            <a href={DOCS.home} target="_blank" rel="noreferrer">
              Docs
            </a>
          </nav>
          <Link to="/live" className="lp-btn primary small lp-nav-cta">
            Watch it live
          </Link>
        </div>

        <div className="lp-hero-copy">
          <span className="lp-chip">
            <i aria-hidden="true" /> Live on Hedera {deploy.network}
          </span>
          <h1>
            Hacked? It <span className="accent">snaps back</span>.
          </h1>
          <p>Stolen stablecoins frozen and taken back in seconds, on Hedera.</p>
          <div className="lp-ctas">
            <Link to="/live" className="lp-btn primary">
              Watch it live
            </Link>
            <a className="lp-btn ghost" href={DOCS.home} target="_blank" rel="noreferrer">
              Read the docs
            </a>
          </div>
        </div>
      </header>

      <div className="lp-window-wrap">
        <ProductWindow m={m} />
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
 * Browser-style window showing the product. Until the new demo video lands it is a mock
 * of the incident view, filled with the measured (or live) numbers. With `video` (or DEMO_VIDEO =
 * true) it plays the recorded demo instead: sources are attached only once the window is near the
 * screen, it plays muted on a loop while visible and pauses when scrolled away; the poster still sits
 * under it, and the mock comes back if neither can load. Reduced motion: the still only. Links to /live.
 */
export function ProductWindow({ m = FALLBACK_SHOWCASE, video = DEMO_VIDEO }: { m?: Showcase; video?: boolean } = {}) {
  const reduced = usePrefersReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  const vid = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  const [visible, setVisible] = useState(false);
  const [posterOk, setPosterOk] = useState(true);
  const [videoOk, setVideoOk] = useState(true);

  useEffect(() => {
    if (!video) return;
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
  }, [video]);

  const showVideo = video && near && !reduced && videoOk;
  useEffect(() => {
    const v = vid.current;
    if (!v) return;
    v.muted = true; // React does not always write the attribute, which autoplay needs
    if (visible) v.play?.()?.catch(() => undefined);
    else v.pause?.();
  }, [visible, showVideo]);

  const media = video && (posterOk || showVideo);
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
        <span className={`lp-window-body${media ? "" : " mock"}`} aria-hidden="true">
          {video && posterOk && <img src="/media/demo-poster.jpg" alt="" decoding="async" onError={() => setPosterOk(false)} />}
          {showVideo && (
            <video ref={vid} muted autoPlay loop playsInline preload="metadata" poster={posterOk ? "/media/demo-poster.jpg" : undefined} onError={(e) => e.target === e.currentTarget && setVideoOk(false)}>
              <source src="/media/demo.webm" type="video/webm" />
              {/* a failed <source> fires error on itself (React bubbles it to the video's onError, hence the target check); only the last one means none could play */}
              <source src="/media/demo.mp4" type="video/mp4" onError={() => setVideoOk(false)} />
            </video>
          )}
          {!media && <WindowMock m={m} />}
        </span>
      </Link>
    </div>
  );
}

/** The incident view, drawn from the numbers: headline time, the four steps, the treasury line, the event log. */
function WindowMock({ m }: { m: Showcase }) {
  const span = Math.max(m.wipedS, 1) * 1.4;
  const x = (t: number) => 60 + (t / span) * 500;
  const theftX = x(0);
  const wipeX = x(m.wipedS);
  // treasury balance: flat, the theft drops it, the wipe brings it back
  const path = `M0 30 H${theftX.toFixed(1)} L${(theftX + 6).toFixed(1)} 92 H${wipeX.toFixed(1)} L${(wipeX + 6).toFixed(1)} 30 H600`;
  const events = [
    { t: 0, text: `${m.wipedAmount} RUPC left the treasury · no receipt` },
    { t: m.detectionS, text: "theft detected by the watcher" },
    { t: m.treasuryFrozenS, text: "treasury frozen" },
    { t: m.wipedS, text: "thief wiped and frozen · tokens back" },
  ];
  const kpis: [string, string][] = [
    [sec(m.detectionS), "detected"],
    [sec(m.treasuryFrozenS), "treasury frozen"],
    [sec(m.wipedS), "taken back"],
    ["0", "false alarms"],
  ];
  return (
    <span className="lp-mock">
      <span className="lp-mock-main">
        <span className="lp-mock-state mono">
          <i /> Contained · Hedera {deploy.network}
        </span>
        <span className="lp-mock-big">
          <b className="num">{sec(m.wipedS)}</b>
          <small>theft to tokens back</small>
        </span>
        <span className="lp-mock-pipe mono">
          {["Request", "Receipt", "Transfer", "Check"].map((p) => (
            <span key={p}>
              <i />
              {p}
            </span>
          ))}
        </span>
        <span className="lp-mock-chart">
          <span className="lp-mock-label mono">Treasury balance</span>
          <svg viewBox="0 0 600 120" preserveAspectRatio="none" focusable="false">
            {[30, 60, 92].map((y) => (
              <line key={y} x1="0" x2="600" y1={y} y2={y} className="grid" vectorEffect="non-scaling-stroke" />
            ))}
            <path d={path} className="line" vectorEffect="non-scaling-stroke" />
            <line x1={wipeX + 3} x2={wipeX + 3} y1="6" y2="114" className="mark" vectorEffect="non-scaling-stroke" />
          </svg>
        </span>
      </span>
      <span className="lp-mock-side">
        <span className="lp-mock-kpis">
          {kpis.map(([v, l]) => (
            <span key={l}>
              <b className="num mono">{v}</b>
              {l}
            </span>
          ))}
        </span>
        <span className="lp-mock-log mono">
          {events.map((e) => (
            <span key={e.text}>
              <b>+{e.t.toFixed(2)} s</b>
              {e.text}
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}

// ---------------------------------------------------------------- Built on Hedera

const SERVICES = ["Stablecoin Studio", "Consensus Service", "Scheduled Transactions", "Threshold keys", "Smart contract (verified)", "Mirror Node", "Arkiv"];

/** A cobalt-deep card: yellow pill label, then each service as a small cream patch. */
export function HederaStrip() {
  return (
    <section className="lp-strip" aria-label="Built on Hedera">
      <div className="lp-card lp-strip-card">
        <span className="lp-pill">Built on Hedera</span>
        <ul>
          {SERVICES.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- shared bits

/** Yellow pill label (mono, cobalt-ink on yellow), as on the /logos review cards. */
function Pill({ children }: { children: ReactNode }) {
  return <span className="lp-pill">{children}</span>;
}

/** Card header row: pill, title, and a mono caption pushed right. */
function CardHead({ pill, title, id, caption, as: H = "h2" }: { pill: ReactNode; title: ReactNode; id?: string; caption?: ReactNode; as?: "h2" | "h3" }) {
  return (
    <div className="lp-card-head">
      <Pill>{pill}</Pill>
      <H id={id}>{title}</H>
      {caption && <span className="lp-cap">{caption}</span>}
    </div>
  );
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
        <div className="lp-card" data-rise>
          <CardHead
            pill="01 · The problem"
            id="problem-h"
            title={
              <>
                Hacks take <span className="accent">hours</span> to stop.
              </>
            }
            caption="log scale"
          />
          <p className="lp-lede serif">By the time a team is awake and on a call, the stolen tokens are swapped and bridged away.</p>
          <CompareChart leveeS={m.wipedS} leveeTx={m.wipeTx} live={m.live} />
        </div>
      </div>
    </section>
  );
}

/** The time-to-contain bars on a cream patch, drawn in cobalt ink; Levee's row is a cobalt band with a yellow bar. */
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
    <figure className="lp-chart lp-patch">
      <figcaption>
        <span className="lp-chart-title">Time to contain</span>
        <span className="lp-ink-dim small">As each team or the press reported it. Each step right is ten times longer.</span>
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

/** Three wave lines, the water the watcher reads (from the chevron mark). */
function Waves() {
  return (
    <svg className="lp-glyph" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <path d="M4.5 10 q2.875 -2.6 5.75 0 t5.75 0 t5.75 0 t5.75 0" />
        <path d="M4.5 17 q2.875 -2.6 5.75 0 t5.75 0 t5.75 0 t5.75 0" />
        <path d="M4.5 24 q2.875 -2.6 5.75 0 t5.75 0 t5.75 0 t5.75 0" />
      </g>
    </svg>
  );
}

/** A closed lock: the treasury frozen. */
function Lock() {
  return (
    <svg className="lp-glyph" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path d="M10 14 V10 a6 6 0 0 1 12 0 V14" fill="none" stroke="currentColor" strokeWidth="3" />
      <rect x="6" y="14" width="20" height="14" rx="2.5" fill="currentColor" />
      <rect x="14.75" y="18.5" width="2.5" height="5" rx="1.25" className="lp-glyph-cut" />
    </svg>
  );
}

export function HowSection({ m }: { m: Showcase }) {
  const steps = [
    {
      letter: "A",
      tag: "Receipt",
      cap: "before signing",
      glyph: <ChevronMark className="lp-glyph" />,
      figure: "1 receipt",
      figCap: "per payment, on a Hedera topic",
      title: "Every payment gets a receipt on Hedera",
      text: "Your payout service asks Levee first. Levee writes a receipt to a Hedera topic, then co-signs the payment.",
    },
    {
      letter: "B",
      tag: "Watch",
      cap: "mirror node",
      glyph: <Waves />,
      figure: about(m.detectionS),
      figCap: "theft to detected",
      title: `No receipt = theft, caught in ${about(m.detectionS)}`,
      text: "The watcher reads every movement from the Mirror Node. Anything that leaves without a receipt is a theft, whoever signed it.",
    },
    {
      letter: "C",
      tag: "Contain",
      cap: "2 of 3 to reopen",
      glyph: <Lock />,
      figure: about(m.wipedS),
      figCap: "frozen and taken back",
      title: `Frozen and taken back in ${about(m.wipedS)} · 2 of 3 to unlock`,
      text: "A close-only contract freezes the treasury and wipes the thief. Only 2 of 3 admins, signing together, can reopen.",
    },
  ];
  return (
    <section className="lp-section" id="how" aria-labelledby="how-h">
      <div className="lp-inner">
        <div className="lp-sec-head" data-rise>
          <CardHead
            pill="02 · How it works"
            id="how-h"
            title={
              <>
                One rule: no receipt, no <span className="accent">movement</span>.
              </>
            }
            caption="three parts"
          />
        </div>
        <ol className="lp-steps">
          {steps.map((s) => (
            <li key={s.letter} className="lp-card lp-step" data-rise>
              <div className="lp-card-head">
                <span className="lp-pill">
                  <b>{s.letter}</b> {s.tag}
                </span>
                <span className="lp-cap">{s.cap}</span>
              </div>
              <figure className="lp-patch lp-step-panel" aria-hidden="true">
                {s.glyph}
                <b className="lp-step-fig mono">{s.figure}</b>
                <figcaption>{s.figCap}</figcaption>
              </figure>
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
        <div className="lp-card" data-rise>
          <CardHead
            pill="03 · Proof"
            id="proof-h"
            title={
              <>
                Measured on Hedera, not <span className="accent">promised</span>.
              </>
            }
            caption={`${m.live ? "Read live from the incidents topic" : "The measured run"} · ${m.date}`}
          />
          <ul className="lp-stats">
            {stats.map((s) => (
              <li key={s.label} className="lp-patch">
                <b className="num">{s.value}</b>
                <span>{s.label}</span>
                <Src href={s.href}>{s.src}</Src>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- 4. fit

function FitSection() {
  return (
    <section className="lp-section" id="fit" aria-labelledby="fit-h">
      <div className="lp-inner">
        <div className="lp-sec-head" data-rise>
          <CardHead
            pill="04 · Who it's for"
            id="fit-h"
            title={
              <>
                Built for issuers, <span className="accent">only</span>.
              </>
            }
            caption="Stablecoin Studio tokens"
          />
        </div>
        <div className="lp-fit">
          <article className="lp-card lp-fit-card" data-rise>
            <CardHead as="h3" pill="✓ For" title="Issuers of their own Stablecoin Studio token" />
            <ul className="lp-patch lp-checks yes">
              <li>You hold the token's freeze and wipe keys</li>
              <li>Your treasury pays known partners and distributors</li>
              <li>You want stolen keys and rogue insiders undone, on chain</li>
            </ul>
          </article>
          <article className="lp-card lp-fit-card" data-rise>
            <CardHead as="h3" pill="✕ Not for" title="USDC or tokens you didn't issue" />
            <ul className="lp-patch lp-checks no">
              <li>Taking tokens back needs the token's own wipe key</li>
              <li>Only the issuer holds it: nobody but Circle can wipe USDC</li>
              <li className="link">
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
    href: DOCS.quickstart,
    primary: false,
  },
  {
    name: "Issuer",
    price: "$1,500",
    per: "/mo",
    note: "Up to 3 tokens",
    features: ["Freeze and wipe: tokens taken back", "2 of 3 admins to reopen", "Close-only contract on your token"],
    cta: "Read the setup guide",
    href: DOCS.setup,
    primary: true,
  },
  {
    name: "Institutional",
    price: "Custom",
    per: "",
    note: "More tokens, your rules",
    features: ["Stricter rules: caps, known recipients", "Deployment agreed together", "Mainnet checklist review"],
    cta: "Talk to us",
    href: DOCS.contact,
    primary: false,
  },
];

/** Side plans are cobalt-deep cards; the middle (Issuer) plan is a cream card in cobalt ink with the yellow button. */
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
            <li key={p.name} className={`lp-plan${p.primary ? " featured lp-patch" : " lp-card"}`} data-rise>
              <h3>{p.name}</h3>
              <p className="lp-price">
                <b className="num">{p.price}</b>
                {p.per && <span>{p.per}</span>}
              </p>
              <p className="lp-plan-note">{p.note}</p>
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

/** One cobalt-deep card; each question a row, its answer opening in a cream patch (native details/summary). */
export function FaqSection() {
  return (
    <section className="lp-section" id="faq" aria-labelledby="faq-h">
      <div className="lp-inner lp-faq-inner">
        <div className="lp-card" data-rise>
          <CardHead
            pill="06 · FAQ"
            id="faq-h"
            title={
              <>
                Straight <span className="accent">answers</span>.
              </>
            }
            caption={`${FAQ.length} questions`}
          />
          <div className="lp-faq">
            {FAQ.map((f, i) => (
              <details key={f.q}>
                <summary>
                  <span className="lp-faq-n mono" aria-hidden="true">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span>{f.q}</span>
                </summary>
                <p className="lp-patch">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- 7. footer

/** Parley-style footer: brand and link columns over the engraving's empty sky, the coastline at the bottom. */
export function Footer() {
  const [imgOk, setImgOk] = useState(true);
  return (
    <footer className="lp-footer">
      <div className="lp-footer-inner">
        <div className="lp-footer-brand">
          <span className="lp-footer-word">Levee</span>
          <p className="serif">
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
            <a href={DOCS.home} target="_blank" rel="noreferrer">
              Docs
            </a>
            <a href={DOCS.quickstart} target="_blank" rel="noreferrer">
              Quickstart
            </a>
            <a href={DOCS.api} target="_blank" rel="noreferrer">
              API reference
            </a>
            <a href={DOCS.security} target="_blank" rel="noreferrer">
              Security
            </a>
            <a href={GITHUB} target="_blank" rel="noreferrer">
              GitHub
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
      <div className={`lp-footer-art${imgOk ? "" : " missing"}`} aria-hidden="true">
        {imgOk && <img src={ART.footer} alt="" loading="lazy" decoding="async" onError={() => setImgOk(false)} />}
      </div>
    </footer>
  );
}
