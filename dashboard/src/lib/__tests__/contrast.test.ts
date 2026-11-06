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

const C = { sky: "#EFE6D2", haze: "#E6D8B4", white: "#FFFFFF", ink: "#1B1A17", moss: "#2E3722", smoke: "#6B665C", gold: "#7A5A00", yellow: "#F2E34C", olive: "#5F6B3B", oliveLit: "#B6C383", amber: "#D9B25C", breachLit: "#F08C74", breach: "#C8432B" };

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
  ["gold accent on sky", C.gold, C.sky],
  ["gold accent on haze", C.gold, C.haze],
  ["gold accent on white", C.gold, C.white],
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
  // by the numbers (light ground): chart labels, Levee highlight, source links
  ["ink chart label on sky", C.ink, C.sky],
  ["smoke source link / axis on sky", C.smoke, C.sky],
  ["gold Levee label + value on sky", C.gold, C.sky],
];

/** Non-text marks (bars) need 3:1 against the ground (WCAG 1.4.11), and Levee must stand apart from the rest. */
const MARKS: [string, string, string][] = [
  ["smoke industry bar on sky", C.smoke, C.sky],
  ["gold Levee bar on sky", C.gold, C.sky],
];

describe("brand contrast pairs", () => {
  it.each(PAIRS)("%s ≥ 4.5:1", (_name, fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(MARKS)("%s ≥ 3:1", (_name, fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(3);
  });
  it("the Levee bar is not the same colour as the others", () => {
    expect(C.gold.toLowerCase()).not.toBe(C.smoke.toLowerCase());
  });
  it("the old yellow-on-cream accent really was unreadable", () => {
    expect(ratio(C.yellow, C.sky)).toBeLessThan(1.2);
  });
});
