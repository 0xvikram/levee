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

/** Landing (dusk) tokens: navy grounds, cream text, yellow the only accent. Gold #7A5A00 is retired. */
const N = { navy950: "#060A1C", navy900: "#0A1130", navy800: "#111B45", cream: "#F3ECDD", blurWord: "#4C68FF" };
/** Frosted glass card: cream at 7% over the deepest ground (the lightest a card gets). */
const GLASS = over(N.cream, 0.07, N.navy950);
const CREAM_DIM = (bg: string) => over(N.cream, 0.72, bg);
const CREAM_FAINT = (bg: string) => over(N.cream, 0.6, bg);
/** Hero copy sits on the video under the navy tint (about 60% navy at the headline). Assumed brightest dusk frame: pale horizon #A9B8E8. */
const HERO_DUSK = over(N.navy950, 0.6, "#A9B8E8");
/** While only the older warm hero exists, the heavier "legacy" tint (about 87% navy) covers its brightest cream frame. */
const HERO_LEGACY = over(N.navy950, 0.87, "#F6ECC6");
/** Footer columns sit below the engraving on an 88% navy scrim; worst case is white paper behind it. */
const FOOTER_SCRIM = over(N.navy950, 0.88, C.white);
/** Pricing: the blurred word (ultramarine at 32%) behind the heading. */
const BLUR_WORD = over(N.blurWord, 0.32, N.navy950);

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
  // landing (/): dusk theme
  ["cream on navy-950", N.cream, N.navy950],
  ["cream on navy-900", N.cream, N.navy900],
  ["cream on navy-800", N.cream, N.navy800],
  ["cream on glass card", N.cream, GLASS],
  ["cream-dim on navy-950", CREAM_DIM(N.navy950), N.navy950],
  ["cream-dim on navy-800 (window bar)", CREAM_DIM(N.navy800), N.navy800],
  ["cream-dim on glass card", CREAM_DIM(GLASS), GLASS],
  ["cream-faint Built on Hedera row on navy-950", CREAM_FAINT(N.navy950), N.navy950],
  ["yellow accent word on navy-950", C.yellow, N.navy950],
  ["yellow accent on navy-800", C.yellow, N.navy800],
  ["yellow on glass card (Levee bar label, step numbers)", C.yellow, GLASS],
  ["yellow pill text on its 8% yellow fill", C.yellow, over(C.yellow, 0.08, N.navy950)],
  ["navy-950 on yellow (primary button, fit mark)", N.navy950, C.yellow],
  ["cream hero copy on the dusk video under the tint", N.cream, HERO_DUSK],
  ["yellow hero accent on the dusk video under the tint", C.yellow, HERO_DUSK],
  ["cream hero copy on the older hero under the legacy tint", N.cream, HERO_LEGACY],
  ["cream footer link on the scrim over white paper", N.cream, FOOTER_SCRIM],
  ["cream-dim footer heading on the scrim over white paper", CREAM_DIM(FOOTER_SCRIM), FOOTER_SCRIM],
  ["cream heading over the blurred Pricing word", N.cream, BLUR_WORD],
];

/** Non-text marks (bars) need 3:1 against the ground (WCAG 1.4.11), and Levee must stand apart from the rest. */
const MARKS: [string, string, string][] = [
  // landing problem chart (glass card): industry bars cream-dim, Levee bar yellow
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
