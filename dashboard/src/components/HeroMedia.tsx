import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "../lib/hooks";

/** Stills in order of preference: the dusk hero, then the older hero, then none (gradient). */
const STILLS = ["/media/hero-dusk.jpg", "/media/hero.jpg"];

/**
 * Full-bleed muted loop with the matching still as poster. Under reduced motion only the still is
 * shown. Layers: navy gradient → still → video, so any missing file just leaves the layer below
 * showing. Video sources are tried in order (dusk webm/mp4, then the older hero); the browser moves
 * on to the next <source> when one fails, and the video is dropped if all of them fail.
 * `parallax` drifts the layer slowly on scroll (transform only).
 */
export function HeroMedia({ parallax = false }: { parallax?: boolean }) {
  const reduced = usePrefersReducedMotion();
  const [still, setStill] = useState(0);
  const [videoOk, setVideoOk] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const vid = useRef<HTMLVideoElement>(null);
  const poster = STILLS[still];

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
        {poster && <img key={poster} src={poster} alt="" onError={() => setStill((i) => i + 1)} decoding="async" />}
        {!reduced && videoOk && (
          <video ref={vid} autoPlay muted loop playsInline preload="metadata" poster={poster} onError={(e) => e.target === e.currentTarget && setVideoOk(false)}>
            <source src="/media/hero-dusk.webm" type="video/webm" />
            <source src="/media/hero-dusk.mp4" type="video/mp4" />
            <source src="/media/hero.webm" type="video/webm" />
            {/* a failed <source> fires error on itself (React bubbles it to the video's onError, hence the target check); only the last one means none could play */}
            <source src="/media/hero.mp4" type="video/mp4" onError={() => setVideoOk(false)} />
          </video>
        )}
      </div>
      {/* heavier navy grade while only the older warm hero exists */}
      <div className={`media-tint${still > 0 ? " legacy" : ""}`} />
    </div>
  );
}
