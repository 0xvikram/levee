import { useEffect, useRef } from "react";
import { HeroMedia } from "./HeroMedia";
import { Link } from "./router";
import { GITHUB } from "../lib/config";
import { usePrefersReducedMotion } from "../lib/hooks";
import type { Showcase } from "../lib/incident";
import "../hero-wordmark.css";

/** Measured on testnet after the receipt fix (docs/LIVE_RUN.md section 3), used until the live run answers. */
export const HERO_FALLBACK = { detectionS: 2.87, wipedS: 6.86 };
/** Runs B + C + D in docs/LIVE_RUN.md: 100 + 193 + 100 payments, 0 breaches. */
export const HERO_PAYMENTS = 393;
const RESOLV = "https://www.kucoin.com/news/flash/resolv-postmortem-reveals-25m-crypto-drain-via-credential-exploitation";

const CLOUDS_BACK = [
  { src: "/media/clouds/cloud-1.jpg", cls: "wm-cloud--b1" },
  { src: "/media/clouds/cloud-2.jpg", cls: "wm-cloud--b2" },
];
const CLOUDS_FRONT = [
  { src: "/media/clouds/cloud-3.jpg", cls: "wm-cloud--f1" },
  { src: "/media/clouds/cloud-4.jpg", cls: "wm-cloud--f2" },
];

const approx = (s: number) => `~${Math.max(1, Math.round(s))} s`;
const exact = (s: number) => `${s.toFixed(2)} s`;

/**
 * Poster hero: a full-width "LEVEE" wordmark over the meadow video, with clouds both behind and in
 * front of the letters (screen blend, so their black ground disappears) and a 4-stat strip below.
 * Motion is transform-only: CSS drift on the clouds, plus small scroll/pointer parallax written to
 * CSS variables. Under reduced motion everything is still.
 */
export function HeroWordmark({ showcase }: { showcase?: Showcase }) {
  const reduced = usePrefersReducedMotion();
  const root = useRef<HTMLElement>(null);
  const live = !!showcase?.live;
  const detect = live ? showcase!.detectionS : HERO_FALLBACK.detectionS;
  const wiped = live ? showcase!.wipedS : HERO_FALLBACK.wipedS;

  useEffect(() => {
    const el = root.current;
    if (!el || reduced) return;
    let raf = 0;
    let px = 0;
    let py = 0;
    const write = () => {
      raf = 0;
      const sy = Math.min(window.scrollY, window.innerHeight);
      el.style.setProperty("--wm-sy", sy.toFixed(1));
      el.style.setProperty("--wm-px", px.toFixed(3));
      el.style.setProperty("--wm-py", py.toFixed(3));
    };
    const queue = () => {
      if (!raf) raf = requestAnimationFrame(write);
    };
    const onPointer = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      px = (e.clientX / window.innerWidth) * 2 - 1;
      py = (e.clientY / window.innerHeight) * 2 - 1;
      queue();
    };
    queue();
    window.addEventListener("scroll", queue, { passive: true });
    window.addEventListener("pointermove", onPointer, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", queue);
      window.removeEventListener("pointermove", onPointer);
    };
  }, [reduced]);

  const cloud = (c: { src: string; cls: string }, layer: "back" | "front") => (
    <div key={c.cls} className={`wm-cloud wm-cloud--${layer} ${c.cls}`} aria-hidden="true">
      <img src={c.src} alt="" decoding="async" loading="eager" draggable={false} style={layer === "front" ? { maskImage: `url(${c.src})` } : undefined} />
    </div>
  );

  return (
    <header ref={root} className={`wm${reduced ? " wm--still" : ""}`}>
      <div className="wm-stage">
        <HeroMedia parallax />
        <div className="wm-tint" aria-hidden="true" />

        <div className="wm-nav">
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
        </div>

        <div className="wm-mark">
          {CLOUDS_BACK.map((c) => cloud(c, "back"))}
          <h1 className="wm-word">Levee</h1>
          {CLOUDS_FRONT.map((c) => cloud(c, "front"))}
        </div>

        <div className="wm-copy">
          <p className="wm-tag">
            No receipt, no <span className="wm-accent">movement.</span>
          </p>
          <p className="wm-line">For stablecoin issuers on Hedera: anything that leaves without a receipt is frozen and taken back in seconds.</p>
        </div>

        <a className="wm-chip" href={RESOLV} target="_blank" rel="noreferrer">
          <span className="wm-chip-dot" aria-hidden="true" />
          Resolv took 3 h 9 min <span aria-hidden="true">↗</span>
        </a>
      </div>

      <ul className="wm-strip" aria-label="Levee in numbers">
        <li className="wm-stat">
          <span className="wm-idx">01</span>
          <span className="wm-big num">{approx(detect)}</span>
          <span className="wm-label">detected · {exact(detect)}</span>
        </li>
        <li className="wm-stat">
          <span className="wm-idx">02</span>
          <span className="wm-big num">{approx(wiped)}</span>
          <span className="wm-label">frozen &amp; taken back · {exact(wiped)}</span>
        </li>
        <li className="wm-stat">
          <span className="wm-idx">03</span>
          <span className="wm-big num">0</span>
          <span className="wm-label">false alarms in {HERO_PAYMENTS} payments</span>
        </li>
        <li className="wm-stat">
          <span className="wm-idx">04</span>
          <Link to="/live" className="wm-big wm-live">
            Live demo <span aria-hidden="true">→</span>
          </Link>
          <span className="wm-label">{live ? "last run read from Hedera" : "watch it on testnet"}</span>
        </li>
      </ul>
    </header>
  );
}
