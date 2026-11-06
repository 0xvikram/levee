// Footer fireflies (canvas) and the live feed that drives them. Mapping logic lives in
// lib/footer-sync.ts; this file only wires the sources and draws.
//
// Sources, one at a time:
//   1. the watcher SSE (the ONLY stream the landing page opens; direct to :8711 on local dev)
//   2. if that is not open within SSE_GRACE_MS: poll the receipts topic on the Mirror Node
//      every POLL_MS while the footer is on screen, one firefly per new sequence number
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { MIRROR, deploy, eventsUrl, servicesReachable } from "../lib/config";
import { useEventSource } from "../lib/hooks";
import {
  MOOD_FLICKER,
  MOOD_RGB,
  MoodClock,
  addFly,
  ambientFor,
  capFor,
  diffReceiptSeqs,
  ensureAmbient,
  idleMood,
  makePayment,
  spawnsFor,
  stepFlies,
  type Fly,
  type Mood,
} from "../lib/footer-sync";

const SSE_GRACE_MS = 4_000;
const POLL_MS = 10_000;

export interface FooterFeed {
  /** fireflies waiting to be spawned; the scene drains it each frame */
  queue: MutableRefObject<number>;
  mood: Mood;
  sse: "connecting" | "open" | "closed";
  fallback: boolean;
}

/** `started` opens the stream (footer has neared the viewport); `onScreen` gates the Mirror poll. */
export function useFooterFeed(started: boolean, onScreen: boolean): FooterFeed {
  const queue = useRef(0);
  const [mood, setMood] = useState<Mood>(idleMood);
  const clock = useMemo(() => new MoodClock(setMood), []);
  useEffect(() => () => clock.dispose(), [clock]);

  const handlers = useMemo(
    () => ({
      matched: (d: unknown) => (queue.current += spawnsFor("matched", d, Date.now())),
      breach: (d: unknown) => clock.handle("breach", d),
      incident: (d: unknown) => clock.handle("incident", d),
    }),
    [clock],
  );
  const sse = useEventSource(started ? eventsUrl("watcher") : "", handlers);

  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => {
    if (!started) return;
    const t = setTimeout(() => setGraceOver(true), SSE_GRACE_MS);
    return () => clearTimeout(t);
  }, [started]);
  // public site: no services to wait for, go straight to the Mirror Node
  const fallback = started && (graceOver || !servicesReachable()) && sse !== "open";

  const last = useRef<number | null>(null);
  useEffect(() => {
    if (!fallback || !onScreen) return;
    let alive = true;
    const run = async () => {
      if (document.hidden) return;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8_000);
      try {
        const r = await fetch(`${MIRROR}/api/v1/topics/${deploy.topics.receipts}/messages?order=desc&limit=10`, { signal: ctl.signal });
        if (!r.ok) return;
        const j = (await r.json()) as { messages?: { sequence_number?: number }[] };
        if (!alive) return;
        const d = diffReceiptSeqs(last.current, (j.messages ?? []).map((m) => Number(m.sequence_number)));
        last.current = d.last;
        queue.current += d.emit;
      } catch {
        /* offline: ambient fireflies only */
      } finally {
        clearTimeout(t);
      }
    };
    run();
    const id = setInterval(run, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [fallback, onScreen]);

  return { queue, mood, sse: started ? sse : "connecting", fallback };
}

const rnd = Math.random;

/** Canvas swarm. `active` = footer on screen; the loop also stops while the tab is hidden. */
export function FooterScene({ active, feed }: { active: boolean; feed: FooterFeed }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const moodRef = useRef(feed.mood);
  moodRef.current = feed.mood;
  const flies = useRef<Fly[]>([]);
  const size = useRef({ w: 0, h: 0 });
  const rgb = useRef<[number, number, number]>([...MOOD_RGB.idle]);

  // size + devicePixelRatio
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const fit = () => {
      const r = c.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      size.current = { w: r.width, h: r.height };
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
      c.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
      flies.current = ensureAmbient(flies.current, ambientFor(r.width), rnd);
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const on = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  useEffect(() => {
    if (!active || !visible) return;
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    feed.queue.current = Math.min(feed.queue.current, 3); // payments seen while off screen: a few, not a burst
    let raf = 0;
    let prev = performance.now();
    let t = 0;
    const frame = (now: number) => {
      const dt = (now - prev) / 1000;
      prev = now;
      t += Math.min(dt, 0.1);
      const { w, h } = size.current;
      const cap = capFor(w);
      // spawn what the feed queued (bounded per frame so a burst trickles in)
      for (let n = 0; n < 2 && feed.queue.current > 0; n++) {
        feed.queue.current--;
        flies.current = addFly(flies.current, makePayment(rnd), cap);
      }
      if (feed.queue.current > cap) feed.queue.current = cap;
      flies.current = stepFlies(flies.current, dt, rnd);

      // ease the colour toward the mood
      const kind = moodRef.current.kind;
      const target = MOOD_RGB[kind];
      const k = Math.min(1, dt * 3);
      rgb.current = rgb.current.map((v, i) => v + (target[i] - v) * k) as [number, number, number];
      const [r, g, b] = rgb.current.map(Math.round);
      const speed = MOOD_FLICKER[kind];

      ctx.clearRect(0, 0, w, h);
      for (const f of flies.current) {
        const fadeIn = f.ambient ? 1 : Math.min(1, f.age / 0.8);
        const fadeTop = f.ambient ? 1 : Math.min(1, Math.max(0, f.y / 0.25));
        const flicker = 0.55 + 0.45 * Math.sin(t * speed + f.phase);
        const a = (f.ambient ? 0.55 : 0.95) * fadeIn * fadeTop * flicker;
        if (a <= 0.01) continue;
        const x = f.x * w;
        const y = f.y * h;
        const glow = f.r * 7;
        const grd = ctx.createRadialGradient(x, y, 0, x, y, glow);
        grd.addColorStop(0, `rgba(${r},${g},${b},${(a * 0.55).toFixed(3)})`);
        grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grd;
        ctx.fillRect(x - glow, y - glow, glow * 2, glow * 2);
        ctx.fillStyle = `rgba(246,236,198,${a.toFixed(3)})`; // --sun core
        ctx.beginPath();
        ctx.arc(x, y, f.r * 0.7, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [active, visible, feed.queue]);

  return <canvas ref={canvas} className="footer-flies" aria-hidden="true" />;
}
