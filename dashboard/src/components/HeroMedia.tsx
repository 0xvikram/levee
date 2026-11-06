import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "../lib/hooks";

const IMG = "/media/hero.jpg";
const VIDEOS = [
  { src: "/media/hero.webm", type: "video/webm" },
  { src: "/media/hero.mp4", type: "video/mp4" },
];

/** True only if the file exists and is served as a video (dev servers answer HTML for misses). */
async function isVideo(src: string): Promise<boolean> {
  try {
    const r = await fetch(src, { method: "HEAD" });
    return r.ok && (r.headers.get("content-type") ?? "").startsWith("video/");
  } catch {
    return false;
  }
}

/**
 * Hero background: the brand gradient, then /media/hero.jpg, then the muted loop if
 * hero.webm / hero.mp4 exist. Any missing file just leaves the layer below showing.
 * Reduced motion: the still only.
 */
export function HeroMedia() {
  const reduced = usePrefersReducedMotion();
  const [imgOk, setImgOk] = useState(true);
  const [sources, setSources] = useState<typeof VIDEOS>([]);

  useEffect(() => {
    if (reduced) return setSources([]);
    let alive = true;
    Promise.all(VIDEOS.map((v) => isVideo(v.src))).then((ok) => alive && setSources(VIDEOS.filter((_, i) => ok[i])));
    return () => {
      alive = false;
    };
  }, [reduced]);

  return (
    <div className="media" aria-hidden="true">
      <img src={IMG} alt="" className={imgOk ? "" : "hidden"} onError={() => setImgOk(false)} decoding="async" />
      {sources.length > 0 && (
        <video autoPlay muted loop playsInline preload="auto" poster={imgOk ? IMG : undefined} onError={() => setSources([])}>
          {sources.map((s) => (
            <source key={s.src} src={s.src} type={s.type} />
          ))}
        </video>
      )}
    </div>
  );
}
