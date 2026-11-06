import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "../lib/hooks";

const POSTER = "/media/hero.jpg";

/**
 * Full-bleed muted loop (webm, then mp4) with the matching still as poster. Under reduced motion
 * only the still is shown. Layers: brand gradient → still → video, so any missing file just
 * leaves the layer below showing. `parallax` drifts the layer slowly on scroll (transform only).
 */
export function HeroMedia({ parallax = false }: { parallax?: boolean }) {
  const reduced = usePrefersReducedMotion();
  const [imgOk, setImgOk] = useState(true);
  const [videoOk, setVideoOk] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const vid = useRef<HTMLVideoElement>(null);

  // React does not always write the muted attribute, which some browsers need before autoplay.
  useEffect(() => {
    const v = vid.current;
    if (!v) return;
    v.muted = true;
    v.play?.()?.catch(() => undefined);
  }, [reduced, videoOk]);

  useEffect(() => {
    if (!parallax || reduced) return;
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const y = Math.min(window.scrollY, window.innerHeight);
        el.style.transform = `translate3d(0, ${(y * 0.18).toFixed(1)}px, 0) scale(1.06)`;
      });
    };
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", on);
    };
  }, [parallax, reduced]);

  return (
    <div className="media" aria-hidden="true">
      <div className="media-layer" ref={ref}>
        <img src={POSTER} alt="" className={imgOk ? "" : "hidden"} onError={() => setImgOk(false)} decoding="async" />
        {!reduced && videoOk && (
          <video ref={vid} autoPlay muted loop playsInline preload="metadata" poster={imgOk ? POSTER : undefined} onError={() => setVideoOk(false)}>
            <source src="/media/hero.webm" type="video/webm" />
            <source src="/media/hero.mp4" type="video/mp4" />
          </video>
        )}
      </div>
    </div>
  );
}
