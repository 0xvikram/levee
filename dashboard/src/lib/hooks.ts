import { useEffect, useRef, useState } from "react";

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

/** Poll a JSON endpoint. Resolves non-2xx bodies too (watcher /health answers 503 with JSON). */
export function usePoll<T>(url: string, everyMs: number): { data: T | null; ok: boolean; reachable: boolean; at: number } {
  const [st, setSt] = useState<{ data: T | null; ok: boolean; reachable: boolean; at: number }>({ data: null, ok: false, reachable: false, at: 0 });
  useEffect(() => {
    let alive = true;
    const run = async () => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), Math.min(everyMs, 5000));
      try {
        const r = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json" } });
        const ct = r.headers.get("content-type") ?? "";
        const data = ct.includes("json") ? ((await r.json()) as T) : null;
        if (alive) setSt({ data, ok: r.ok && data !== null, reachable: data !== null, at: Date.now() });
      } catch {
        if (alive) setSt((s) => ({ ...s, ok: false, reachable: false, at: Date.now() }));
      } finally {
        clearTimeout(t);
      }
    };
    run();
    const id = setInterval(run, everyMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [url, everyMs]);
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

/** Adds .in to [data-rise] elements as they scroll into view (no-op under reduced motion). */
export function useRiseIn(): void {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-rise]"));
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || typeof IntersectionObserver === "undefined") {
      els.forEach((e) => e.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))),
      { threshold: 0.15 },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);
}
