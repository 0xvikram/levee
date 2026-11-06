// Live chart (SVG, no chart library): treasury balance and total supply, each on its own y scale,
// with the demo's events marked. Pure maths in lib/series.ts.
import { useEffect, useRef, useState } from "react";
import { axisLabel, domain, EVENT_LABEL, scale, toPath, visibleEvents, WINDOW_MS, type ChartEvent, type Pt } from "../lib/series";

function useSize<T extends Element>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ w: 640, h: 220 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect;
      if (r.width > 0 && r.height > 0) setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

const PAD_L = 76;
const PAD_R = 76;
const PAD_T = 26;
const PAD_B = 22;

export function LiveChart({ treasury, supply, events, now, symbol, note }: { treasury: Pt[]; supply: Pt[]; events: ChartEvent[]; now: number; symbol: string; note: string }) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const t0 = now - WINDOW_MS;
  const t1 = now;
  const iw = Math.max(10, w - PAD_L - PAD_R);
  const ih = Math.max(10, h - PAD_T - PAD_B);
  const vis = (ps: Pt[]) => ps.filter((p) => p.t >= t0 - 60_000);
  const tr = vis(treasury);
  const su = vis(supply);
  const dT = domain(tr);
  const dS = domain(su);
  const sT = dT && scale({ t0, t1, lo: dT[0], hi: dT[1], width: iw, height: ih });
  const sS = dS && scale({ t0, t1, lo: dS[0], hi: dS[1], width: iw, height: ih });
  const xOf = (t: number) => ((t - t0) / (t1 - t0)) * iw;
  const evs = visibleEvents(events, t0, t1);
  const lastT = [...tr].reverse().find((p) => p.v !== null)?.v ?? null;
  const lastS = [...su].reverse().find((p) => p.v !== null)?.v ?? null;
  const minutes = Array.from({ length: Math.floor(WINDOW_MS / 60_000) + 1 }, (_, i) => i);

  return (
    <section className="card-dark cc-chart" aria-labelledby="chart-h">
      <div className="card-head">
        <h2 id="chart-h">Live: treasury and supply</h2>
        <span className="chart-legend small">
          <span className="lg-t">
            <i aria-hidden="true" /> Treasury <b className="mono num">{lastT === null ? "…" : axisLabel(lastT)}</b>
          </span>
          <span className="lg-s">
            <i aria-hidden="true" /> Total supply <b className="mono num">{lastS === null ? "…" : axisLabel(lastS)}</b> <span className="dim">{symbol}</span>
          </span>
        </span>
      </div>
      <div className="chart-box" ref={ref}>
        <svg width={w} height={h} role="img" aria-label={`Treasury balance and total supply over the last ${WINDOW_MS / 60_000} minutes`}>
          <g transform={`translate(${PAD_L},${PAD_T})`}>
            {minutes.map((m) => {
              const x = xOf(t1 - m * 60_000);
              return (
                <g key={m}>
                  <line className="ch-grid" x1={x} x2={x} y1={0} y2={ih} />
                  <text className="ch-tick" x={x} y={ih + 16} textAnchor="middle">
                    {m === 0 ? "now" : `−${m} min`}
                  </text>
                </g>
              );
            })}
            {dT && sT && (
              <>
                <text className="ch-axis t" x={-8} y={sT.y(dT[1]) + 10} textAnchor="end">
                  {axisLabel(dT[1])}
                </text>
                <text className="ch-axis t" x={-8} y={sT.y(dT[0])} textAnchor="end">
                  {axisLabel(dT[0])}
                </text>
                <path className="ch-line t" d={toPath(tr, sT)} />
              </>
            )}
            {dS && sS && (
              <>
                <text className="ch-axis s" x={iw + 8} y={sS.y(dS[1]) + 10}>
                  {axisLabel(dS[1])}
                </text>
                <text className="ch-axis s" x={iw + 8} y={sS.y(dS[0])}>
                  {axisLabel(dS[0])}
                </text>
                <path className="ch-line s" d={toPath(su, sS)} />
              </>
            )}
            {evs.map((e) => {
              const x = xOf(e.t);
              return (
                <g key={`${e.kind}${e.t}`} className={`ch-ev ev-${e.kind}`}>
                  <line x1={x} x2={x} y1={-4} y2={ih} />
                  <text x={x} y={-10} textAnchor="middle">
                    {EVENT_LABEL[e.kind]}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      <p className="dim small chart-note">{note}</p>
    </section>
  );
}
