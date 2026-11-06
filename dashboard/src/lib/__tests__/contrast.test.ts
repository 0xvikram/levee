// Text contrast pairs used by styles.css (WCAG 2.1 relative luminance). Every pair must reach 4.5:1.
import { describe, expect, it } from "vitest";

function lum(hex: string): number {
  const c = hex.replace("#", "").match(/../g)!.map((h) => parseInt(h, 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** fg at `alpha` over bg, as hex */
function over(fg: string, alpha: number, bg: string): string {
  const f = fg.replace("#", "").match(/../g)!.map((h) => parseInt(h, 16));
  const g = bg.replace("#", "").match(/../g)!.map((h) => parseInt(h, 16));
  return "#" + f.map((v, i) => Math.round(v * alpha + g[i] * (1 - alpha)).toString(16).padStart(2, "0")).join("");
}

const C = { sky: "#EFE6D2", haze: "#E6D8B4", white: "#FFFFFF", ink: "#1B1A17", moss: "#2E3722", smoke: "#6B665C", yellow: "#F2E34C", olive: "#5F6B3B", oliveLit: "#B6C383", amber: "#D9B25C", breachLit: "#F08C74", breach: "#C8432B" };

/** Landing (Parley v3) tokens: cobalt grounds, cream text, yellow a small accent only. Gold #7A5A00 is retired. */
const N = { cobalt: "#1A3892", deep: "#142C82", ink: "#0E1F5E", sky: "#1F3F88", cream: "#F3EBD6", heroSky: "#203C91" };
/** Cobalt glass card: cream at 9% (the top of its gradient, the lightest it gets) over the page ground. */
const GLASS = over(N.cream, 0.09, N.cobalt);
const CREAM_DIM = (bg: string) => over(N.cream, 0.74, bg);
const CREAM_FAINT = (bg: string) => over(N.cream, 0.64, bg);
/** Hero copy: the scrim is the hero's own sky at 85%; worst case is a cream engraved pixel right behind a letter. */
const HERO_SCRIM = over(N.heroSky, 0.85, N.cream);
/** Fixed nav: cobalt-ink glass at 72%; worst case is cream art behind it. */
const NAV_GLASS = over(N.ink, 0.72, N.cream);
/** Page grain: cream at <= 5% over the ground (soft-light is gentler than this plain mix). */
const GRAIN = over(N.cream, 0.05, N.cobalt);

/** screen blend of the footer cursor light's brightest stop (sun #F6ECC6 at 0.2) over ink */
const LIT_INK = (() => {
  const a = [0xf6, 0xec, 0xc6].map((v) => (v / 255) * 0.2);
  const b = C.ink.replace("#", "").match(/../g)!.map((h) => parseInt(h, 16) / 255);
  return "#" + b.map((v, i) => Math.round((1 - (1 - v) * (1 - a[i])) * 255).toString(16).padStart(2, "0")).join("");
})();

const PAIRS: [string, string, string][] = [
  ["ink on sky", C.ink, C.sky],
  ["ink on haze", C.ink, C.haze],
  ["smoke on sky", C.smoke, C.sky],
  ["olive scope mark on sky", C.olive, C.sky],
  ["ink on yellow button", C.ink, C.yellow],
  ["sky on ink", C.sky, C.ink],
  ["sky on moss", C.sky, C.moss],
  ["yellow accent on ink", C.yellow, C.ink],
  ["yellow accent on moss", C.yellow, C.moss],
  ["sky-dim on ink", over(C.sky, 0.7, C.ink), C.ink],
  ["sky-dim on moss", over(C.sky, 0.7, C.moss), C.moss],
  ["olive-lit on ink", C.oliveLit, C.ink],
  ["olive-lit on moss", C.oliveLit, C.moss],
  ["amber on ink", C.amber, C.ink],
  ["amber on moss", C.amber, C.moss],
  ["breach-lit on ink", C.breachLit, C.ink],
  ["breach-lit on moss", C.breachLit, C.moss],
  ["white on breach", C.white, C.breach],
  // footer: the cursor light (sun at <= 20% alpha, screen blend) brightens the dark ground under the ticker
  ["sky-dim ticker on ink under cursor light", over(C.sky, 0.7, LIT_INK), LIT_INK],
  ["yellow ticker figure on ink under cursor light", C.yellow, LIT_INK],
  ["olive-lit live tag on ink under cursor light", C.oliveLit, LIT_INK],
  ["sky ticker link on ink under cursor light", C.sky, LIT_INK],
  // landing (/): Parley v3 cobalt
  ["cream on cobalt (page ground)", N.cream, N.cobalt],
  ["cream on cobalt-deep", N.cream, N.deep],
  ["cream on cobalt-ink (window bar)", N.cream, N.ink],
  ["cream on cobalt-sky (footer)", N.cream, N.sky],
  ["cream on glass card", N.cream, GLASS],
  ["cream on the page grain", N.cream, GRAIN],
  ["cream-dim on cobalt", CREAM_DIM(N.cobalt), N.cobalt],
  ["cream-dim on cobalt-ink (window bar)", CREAM_DIM(N.ink), N.ink],
  ["cream-dim on glass card", CREAM_DIM(GLASS), GLASS],
  ["cream-dim footer heading on cobalt-sky", CREAM_DIM(N.sky), N.sky],
  ["cream-faint Built on Hedera row on cobalt", CREAM_FAINT(N.cobalt), N.cobalt],
  ["yellow accent word on cobalt", C.yellow, N.cobalt],
  ["yellow accent on cobalt-deep", C.yellow, N.deep],
  ["yellow on glass card (Levee bar label, step numbers)", C.yellow, GLASS],
  ["yellow pill text on its 8% yellow fill", C.yellow, over(C.yellow, 0.08, N.cobalt)],
  ["cobalt-ink on yellow (primary button, fit mark)", N.ink, C.yellow],
  ["cream hero copy on the scrim over a cream pixel", N.cream, HERO_SCRIM],
  ["yellow hero accent on the scrim over a cream pixel", C.yellow, HERO_SCRIM],
  ["cream nav link on the nav glass over a cream pixel", N.cream, NAV_GLASS],
  ["cream heading over the blurred Pricing word", N.cream, over(N.cream, 0.09, N.cobalt)],
  // tonal section band: cobalt-ink at 22% over the ground, and a glass card on it
  ["cream on the tonal band", N.cream, over(N.ink, 0.22, N.cobalt)],
  ["cream-dim on a glass card on the tonal band", CREAM_DIM(over(N.cream, 0.09, over(N.ink, 0.22, N.cobalt))), over(N.cream, 0.09, over(N.ink, 0.22, N.cobalt))],
  ["yellow accent on the tonal band", C.yellow, over(N.ink, 0.22, N.cobalt)],
  // product window mock (cobalt-deep panels)
  ["cream-dim on cobalt-deep (window mock labels)", CREAM_DIM(N.deep), N.deep],
];

/** Non-text marks (bars) need 3:1 against the ground (WCAG 1.4.11), and Levee must stand apart from the rest. */
const MARKS: [string, string, string][] = [
  // landing problem chart (cobalt glass card): industry bars cream-dim, Levee bar yellow
  ["cream-dim industry bar on glass", CREAM_DIM(GLASS), GLASS],
  ["yellow Levee bar on glass", C.yellow, GLASS],
  // /live command centre (moss cards): chart lines, event marks, before/after bars
  ["yellow treasury line / Levee bar on moss", C.yellow, C.moss],
  ["olive-lit supply line on moss", C.oliveLit, C.moss],
  ["sky-dim industry bar on moss", over(C.sky, 0.7, C.moss), C.moss],
  ["breach-lit theft mark on moss", C.breachLit, C.moss],
  ["amber mint mark on moss", C.amber, C.moss],
];

describe("brand contrast pairs", () => {
  it.each(PAIRS)("%s ≥ 4.5:1", (_name, fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(MARKS)("%s ≥ 3:1", (_name, fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(3);
  });
  it("the Levee bar is not the same colour as the others", () => {
    expect(C.yellow.toLowerCase()).not.toBe(CREAM_DIM(GLASS).toLowerCase());
  });
  it("the old yellow-on-cream accent really was unreadable", () => {
    expect(ratio(C.yellow, C.sky)).toBeLessThan(1.2);
  });
});

describe("landing has no gold or brown accent", () => {
  it("styles.css and landing.css never use the retired gold #7A5A00", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "../..");
    for (const f of ["styles.css", "pages/landing.css"]) {
      const css = fs.readFileSync(path.join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").toLowerCase(); // rules only, not comments
      expect(css).not.toContain("#7a5a00");
      expect(css).not.toContain("var(--gold)");
    }
  });
});

describe("landing palette is cobalt + cream + yellow only", () => {
  it("landing.css uses no colour outside the Parley v3 palette (black appears only inside masks)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const css = fs.readFileSync(path.resolve(__dirname, "../../pages/landing.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").toLowerCase();
    const allowed = new Set([
      "26,56,146", // cobalt #1a3892
      "20,44,130", // cobalt-deep #142c82
      "14,31,94", // cobalt-ink #0e1f5e
      "31,63,136", // cobalt-sky #1f3f88
      "32,60,145", // hero sky #203c91
      "243,235,214", // cream #f3ebd6
      "242,227,76", // yellow #f2e34c
      "0,0,0", // mask alpha only
    ]);
    const hex = (h: string) => {
      const x = h.length === 4 ? h.slice(1).split("").map((c) => c + c).join("") : h.slice(1);
      return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)).join(",");
    };
    const found = [...css.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/g)].map((m) => hex(m[0]));
    found.push(...[...css.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)/g)].map((m) => `${m[1]},${m[2]},${m[3]}`));
    expect(found.length).toBeGreaterThan(10);
    for (const c of found) expect(allowed, `unexpected colour rgb(${c})`).toContain(c);
  });
});
