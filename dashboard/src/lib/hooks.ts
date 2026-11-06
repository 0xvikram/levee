import { useEffect, useRef, useState, type RefObject } from "react";
import { initialPoll, nextPoll, type PollResult, type PollState } from "./health";

/** Subscribe to an SSE stream. `handlers` keys are event names ("message" for unnamed events). */
export function useEventSource(url: string, handlers: Record<string, (data: unknown) => void>): "connecting" | "open" | "closed" {
  const ref = useRef(handlers);
  ref.current = handlers;
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const names = Object.keys(handlers).sort().join(",");
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource(url);
    es.onopen = () => setStatus("open");
    es.onerror = () => setStatus(es.readyState === EventSource.CLOSED ? "closed" : "connecting");
    const listeners = names.split(",").filter(Boolean).map((name) => {
      const fn = (ev: MessageEvent) => {
        try {
          ref.current[name]?.(JSON.parse(ev.data));
        } catch {
          /* ignore malformed frame */
        }
      };
      es.addEventListener(name, fn as EventListener);
      return [name, fn] as const;
    });
    return () => {
      for (const [n, fn] of listeners) es.removeEventListener(n, fn as EventListener);
      es.close();
    };
  }, [url, names]);
  return status;
}

/**
 * Poll a JSON endpoint. Resolves non-2xx JSON bodies too (watcher /health answers 503 with JSON).
 * Keeps the last good data and only reports "unreachable" after two misses in a row (lib/health.ts).
 */
export function usePoll<T>(url: string, everyMs: number, timeoutMs = 8000): PollState<T> {
  const [st, setSt] = useState<PollState<T>>(initialPoll);
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const run = async () => {
      if (inFlight) return; // never stack requests on a slow endpoint
      inFlight = true;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      let res: PollResult<T>;
      try {
        const r = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json" } });
        const ct = r.headers.get("content-type") ?? "";
        res = ct.includes("json") ? { kind: "answer", status: r.status, data: (await r.json()) as T } : { kind: "miss" };
      } catch {
        res = { kind: "miss" };
      } finally {
        clearTimeout(t);
        inFlight = false;
      }
      if (alive) setSt((s) => nextPoll(s, res, Date.now()));
    };
    run();
    const id = setInterval(run, everyMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [url, everyMs, timeoutMs]);
  return st;
}

/** Wall clock that ticks every `ms` (only while `active`). */
export function useNow(ms: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms, active]);
  return now;
}

export function usePrefersReducedMotion(): boolean {
  const q = "(prefers-reduced-motion: reduce)";
  const [v, setV] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(q).matches);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const on = () => setV(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return v;
}

/**
 * Scroll reveal. Content is visible at rest: the CSS only hides [data-rise] once JS has put
 * .js-motion on <html>, so the page reads fine if this never runs. Adds .in once per element.
 */
export function useRiseIn(): void {
  useEffect(() => {
    const root = document.documentElement;
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-rise]"));
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || typeof IntersectionObserver === "undefined") {
      els.forEach((e) => e.classList.add("in"));
      return;
    }
    root.classList.add("js-motion");
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))),
      { threshold: 0.18, rootMargin: "0px 0px -6% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);
}

/** True once the element has been on screen (never flips back). Immediately true without IO. */
export function useSeenOnce<T extends Element>(ref: RefObject<T | null>, threshold = 0.35): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") return setSeen(true);
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && (setSeen(true), io.disconnect()), { threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen, threshold]);
  return seen;
}

/** Count from 0 to `target` once `start` is true (ease-out, rAF). Reduced motion: the final value. */
export function useCountUp(target: number, start: boolean, durationMs = 1400): number {
  const reduced = usePrefersReducedMotion();
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!start) return;
    if (reduced || typeof requestAnimationFrame === "undefined") return setV(target);
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / durationMs);
      setV(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, start, reduced, durationMs]);
  return start ? v : reduced ? target : 0;
}
