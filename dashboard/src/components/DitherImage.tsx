import { useEffect, useRef, useState, type CSSProperties } from "react";
import { usePrefersReducedMotion } from "../lib/hooks";
import { bayer, coverRect, ditherGrid, ditherInto, lumaOf, packColor, revealBias, shimmerLut, stretchLevels, type BayerSize } from "../lib/dither";

type State = "idle" | "ready" | "static" | "fallback";

export interface DitherImageProps {
  src: string;
  className?: string;
  /** Cell size in CSS px (snapped to whole device pixels). Bigger = chunkier pixels. */
  cell?: number;
  /** Bayer matrix size. */
  matrix?: BayerSize;
  /** Two tones, "#RRGGBB". Dark takes the sky, light takes the engraved lines. Use the art's own
   *  sampled sky colour for `dark` (and as the section ground behind it) so the edges disappear. */
  dark?: string;
  light?: string;
  /** Vertical anchor of the cover crop, 0 top .. 1 bottom. */
  posY?: number;
  /** Start loading at once (hero) instead of when near the screen. */
  priority?: boolean;
  /** Reveal length in ms. */
  revealMs?: number;
  /** Turn off the ambient shimmer (the reveal still runs). */
  shimmer?: boolean;
  /** Trim this fraction off every side of the source first (e.g. a printed frame round the art). */
  inset?: number;
  /** Peak shimmer boost (0..1); keep it small. */
  shimmerAmp?: number;
}

const FPS = 30;
const FRAME_MS = 1000 / FPS;

/**
 * An engraving drawn as two-tone ordered dither on a <canvas>: it dithers in (a threshold sweep from the
 * top, ~1.2 s) the first time it scrolls into view, then a faint band of shimmer drifts across it.
 * At most 30 fps, paused off screen and in hidden tabs, sized for devicePixelRatio (capped at 2).
 *
 * Layers: the wrapper's own background (the dark tone with a CSS halftone, see .dither in
 * landing.css) → the canvas. Feathering into the page is done with a CSS mask on the wrapper. A missing image or no canvas leaves the gradient. Under
 * prefers-reduced-motion (or without a 2D canvas) the plain image is shown, still.
 * Decorative only: aria-hidden.
 */
export function DitherImage({ src, className = "", cell = 2, matrix = 8, dark = "#1D3BA5", light = "#F3EBD6", posY = 0.5, priority = false, revealMs = 1200, shimmer = true, inset = 0, shimmerAmp = 0.05 }: DitherImageProps) {
  const reduced = usePrefersReducedMotion();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<State>("idle");
  const [near, setNear] = useState(priority);
  const [canDraw] = useState(() => {
    if (typeof document === "undefined") return false;
    try {
      return !!document.createElement("canvas").getContext?.("2d");
    } catch {
      return false;
    }
  });
  const still = reduced || !canDraw;

  // load only when near the screen (unless priority)
  useEffect(() => {
    if (near) return;
    const el = wrap.current;
    if (!el || typeof IntersectionObserver === "undefined") return setNear(true);
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && (setNear(true), io.disconnect()), { rootMargin: "300px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);

  useEffect(() => {
    if (still || !near) return;
    const box = wrap.current;
    const cv = canvas.current;
    if (!box || !cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    let dead = false;
    let raf = 0;
    let visible = typeof IntersectionObserver === "undefined";
    let revealStart = -1;
    let last = 0;
    let img: HTMLImageElement | null = null;
    let grid = { w: 0, h: 0 };
    let lum: Float32Array = new Float32Array(0);
    let frame: ImageData | null = null;
    let px: Uint32Array = new Uint32Array(0);
    let rows: Float32Array = new Float32Array(0);
    let lut: Float32Array | undefined;
    const m = bayer(matrix);
    const D = packColor(dark);
    const L = packColor(light);

    const layout = () => {
      if (!img) return;
      const r = box.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      const g = ditherGrid(r.width, r.height, window.devicePixelRatio || 1, cell);
      if (g.w === grid.w && g.h === grid.h) return;
      grid = g;
      cv.width = g.w;
      cv.height = g.h;
      cv.style.width = `${g.cssW}px`;
      cv.style.height = `${g.cssH}px`;
      const off = document.createElement("canvas");
      off.width = g.w;
      off.height = g.h;
      const o = off.getContext("2d", { willReadFrequently: true });
      if (!o) return;
      const ix = img.naturalWidth * inset;
      const iy = img.naturalHeight * inset;
      const c = coverRect(img.naturalWidth - 2 * ix, img.naturalHeight - 2 * iy, g.w, g.h, 0.5, posY);
      o.imageSmoothingQuality = "high";
      o.drawImage(img, ix + c.sx, iy + c.sy, c.sw, c.sh, 0, 0, g.w, g.h);
      lum = stretchLevels(lumaOf(o.getImageData(0, 0, g.w, g.h).data));
      frame = ctx.createImageData(g.w, g.h);
      px = new Uint32Array(frame.data.buffer);
      rows = new Float32Array(g.h);
      lut = undefined;
    };

    const draw = (now: number) => {
      if (!frame) return;
      const p = revealStart < 0 ? 0 : Math.min(1, (now - revealStart) / revealMs);
      for (let y = 0; y < grid.h; y++) rows[y] = revealBias(p, grid.h > 1 ? y / (grid.h - 1) : 0);
      lut = shimmer && p >= 1 ? shimmerLut(grid.w, grid.h, now, shimmerAmp, 9000, lut) : undefined;
      ditherInto(px, lum, grid.w, grid.h, m, matrix, D, L, rows, lut);
      ctx.putImageData(frame, 0, 0);
    };

    const tick = (now: number) => {
      raf = 0;
      if (dead || !visible || document.hidden) return;
      if (revealStart < 0) revealStart = now;
      if (now - last >= FRAME_MS - 1) {
        last = now;
        draw(now);
      }
      const revealing = now - revealStart < revealMs;
      if (revealing || shimmer) raf = requestAnimationFrame(tick);
      else draw(revealStart + revealMs); // land exactly on the finished frame
    };
    const kick = () => {
      if (!raf && !dead && visible && !document.hidden && frame) raf = requestAnimationFrame(tick);
    };

    const io =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (es) => {
              visible = es.some((e) => e.isIntersecting);
              if (visible) kick();
            },
            { threshold: 0.12 },
          );
    io?.observe(box);

    let ro: ResizeObserver | null = null;
    let resizeRaf = 0;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
          const before = grid.w;
          layout();
          if (grid.w !== before && frame) {
            draw(performance.now());
            kick();
          }
        });
      });
      ro.observe(box);
    }

    const onVis = () => !document.hidden && kick();
    document.addEventListener("visibilitychange", onVis);

    const im = new Image();
    im.decoding = "async";
    im.onload = () => {
      if (dead) return;
      img = im;
      layout();
      if (!frame) return setState("fallback");
      draw(revealStart < 0 ? 0 : performance.now()); // first frame: all dark tone (nothing revealed yet)
      setState("ready");
      kick();
    };
    im.onerror = () => !dead && setState("fallback");
    im.src = src;

    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(resizeRaf);
      io?.disconnect();
      ro?.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      im.onload = null;
      im.onerror = null;
    };
  }, [still, near, src, cell, matrix, dark, light, posY, revealMs, shimmer, inset, shimmerAmp]);

  const shown = still ? (state === "fallback" ? "fallback" : "static") : state;
  return (
    <div ref={wrap} className={`dither ${className}`.trim()} data-state={shown} data-dither="" aria-hidden="true" style={{ "--dither-dark": dark } as CSSProperties}>
      {still
        ? state !== "fallback" && near && <img src={src} alt="" decoding="async" loading={priority ? "eager" : "lazy"} style={{ objectPosition: `50% ${posY * 100}%`, transform: inset ? `scale(${(1 / (1 - 2 * inset)).toFixed(4)})` : undefined }} onError={() => setState("fallback")} />
        : <canvas ref={canvas} className={state === "ready" ? "on" : undefined} />}
    </div>
  );
}
