import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CompareChart, FaqSection, Footer, HederaStrip, HeroMedia, HowSection, Landing, PricingSection, ProductWindow, ProofSection } from "./Landing";
import { FALLBACK_SHOWCASE } from "../lib/incident";
import { FACTS, INDUSTRY } from "../lib/numbers";
import { DOCS, DOCS_URL, deploy } from "../lib/config";

// The landing reads the incidents topic from the Mirror Node; keep tests offline (fallback run).
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const live = { ...FALLBACK_SHOWCASE, live: true, detectionS: 2.51, treasuryFrozenS: 4.1, wipedS: 5.62 };

describe("Landing structure", () => {
  it("has a one-line h1 with a single yellow accent, the full-idea subtitle and both CTAs", () => {
    const { container } = render(<Landing />);
    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe("Hacked? It snaps back.");
    expect(h1s[0].querySelectorAll(".accent")).toHaveLength(1);
    expect(screen.getByText("Stolen stablecoins frozen and taken back in seconds, on Hedera.")).toBeInTheDocument();
    const hero = container.querySelector(".lp-hero-copy")!;
    expect(within(hero as HTMLElement).getByRole("link", { name: "Watch it live" })).toHaveAttribute("href", "/live");
    expect(within(hero as HTMLElement).getByRole("link", { name: "Read the docs" })).toHaveAttribute("href", DOCS_URL);
  });

  it("has a slim nav: logo, centre links including Docs, and the Watch it live pill", () => {
    const { container } = render(<Landing />);
    const nav = container.querySelector(".lp-nav")!;
    expect(nav.querySelector(".lp-logo")).toHaveAttribute("href", "/");
    const links = within(nav.querySelector("nav") as HTMLElement).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["How it works", "Pricing", "FAQ", "Docs"]);
    expect(links[3]).toHaveAttribute("href", DOCS_URL);
    expect(nav.querySelector(".lp-nav-cta")).toHaveAttribute("href", "/live");
  });

  it("keeps media to the hero and the footer only", () => {
    const { container } = render(<Landing />);
    expect(container.querySelector("main")!.querySelectorAll("img, video, canvas, .dither")).toHaveLength(0);
    expect(container.querySelector(".lp-window-wrap")!.querySelectorAll("img, video")).toHaveLength(0);
  });

  it("plays the lighthouse loop behind the hero copy (webm then mp4, muted, looping, inline, poster, decorative)", () => {
    const { container } = render(<Landing />);
    expect(container.querySelector(".lp-hero .dither, .lp-hero canvas")).toBeNull();
    const v = container.querySelector(".lp-hero video.lp-hero-media") as HTMLVideoElement;
    expect(v).not.toBeNull();
    expect(v).toHaveAttribute("aria-hidden", "true");
    expect(v.muted).toBe(true);
    expect(v.autoplay).toBe(true);
    expect(v.loop).toBe(true);
    expect(v.hasAttribute("playsinline")).toBe(true);
    expect(v).toHaveAttribute("preload", "metadata");
    expect(v).toHaveAttribute("poster", "/media/hero-lighthouse.jpg");
    expect([...v.querySelectorAll("source")].map((s) => [s.getAttribute("src"), s.getAttribute("type")])).toEqual([
      ["/media/hero-lighthouse.webm", "video/webm"],
      ["/media/hero-lighthouse.mp4", "video/mp4"],
    ]);
  });

  it("falls back to the poster still when neither video source can play", () => {
    const { container } = render(<Landing />);
    const sources = container.querySelectorAll(".lp-hero video source");
    fireEvent.error(sources[1]);
    expect(container.querySelector(".lp-hero video")).toBeNull();
    const img = container.querySelector(".lp-hero img.lp-hero-media")!;
    expect(img).toHaveAttribute("src", "/media/hero-lighthouse.jpg");
    fireEvent.error(img);
    expect(container.querySelector(".lp-hero .lp-hero-media")).toBeNull();
  });

  it("shows only the poster under reduced motion (no autoplay)", () => {
    const mm = vi.fn((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.stubGlobal("matchMedia", mm);
    try {
      const { container } = render(<HeroMedia />);
      expect(container.querySelector("video")).toBeNull();
      expect(container.querySelector("img")).toHaveAttribute("src", "/media/hero-lighthouse.jpg");
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    }
  });

  it("pauses the hero video when it scrolls off screen and plays it when back", () => {
    let cb: (e: { isIntersecting: boolean }[]) => void = () => undefined;
    const IO = vi.fn(function (this: unknown, fn: typeof cb) {
      cb = fn;
      return { observe: vi.fn(), disconnect: vi.fn() };
    });
    vi.stubGlobal("IntersectionObserver", IO);
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    try {
      render(<HeroMedia />);
      cb([{ isIntersecting: false }]);
      expect(pause).toHaveBeenCalled();
      cb([{ isIntersecting: true }]);
      expect(play).toHaveBeenCalled();
    } finally {
      play.mockRestore();
      pause.mockRestore();
    }
  });

  it("styles the sections as the /logos patchwork: cobalt-deep cards holding cream patches", () => {
    const { container } = render(<Landing />);
    const main = container.querySelector("main")!;
    expect(main.querySelector("#problem .lp-card .lp-chart.lp-patch")).not.toBeNull();
    expect(main.querySelector("#problem .lp-pill")!.textContent).toBe("01 · The problem");
    expect(main.querySelectorAll("#proof .lp-stats li.lp-patch")).toHaveLength(5);
    expect(main.querySelectorAll("#fit .lp-card .lp-patch.lp-checks")).toHaveLength(2);
    expect(main.querySelectorAll("#faq .lp-card details > p.lp-patch")).toHaveLength(5);
    expect(main.querySelector(".lp-glass")).toBeNull();
    expect(container.querySelector(".lp-strip .lp-card .lp-pill")!.textContent).toBe("Built on Hedera");
  });

  it("puts the sections in the agreed order, each with a pill eyebrow", () => {
    const { container } = render(<Landing />);
    const ids = [...container.querySelectorAll("main > section")].map((s) => s.id);
    expect(ids).toEqual(["problem", "how", "proof", "fit", "pricing", "faq"]);
    for (const s of container.querySelectorAll("main > section")) expect(s.querySelector(".lp-pill")).not.toBeNull();
    // the window and the Hedera strip come right after the hero, before main
    const order = [...container.querySelector(".lp")!.children].map((c) => c.className || c.tagName.toLowerCase());
    expect(order.indexOf("lp-window-wrap")).toBe(order.indexOf("lp-hero") + 1);
    expect(order.indexOf("lp-strip")).toBe(order.indexOf("lp-window-wrap") + 1);
  });

  it("drops the old Phase 2 / Phase 3 strips and the token search", () => {
    const { container } = render(<Landing />);
    expect(container.textContent).not.toMatch(/Phase 2|Phase 3/);
    expect(container.querySelector("form")).toBeNull();
  });

  it("uses semantic headings (one h1, h2 per section)", () => {
    const { container } = render(<Landing />);
    for (const s of container.querySelectorAll("main > section")) expect(s.querySelector("h2")).not.toBeNull();
  });
});

describe("product window", () => {
  it("is a link to /live titled levee · live, with a cobalt mock of the incident view (no media)", () => {
    const { container } = render(<ProductWindow m={live} />);
    const a = screen.getByTestId("product-window");
    expect(a).toHaveAttribute("href", "/live");
    expect(a.textContent).toContain("levee · live");
    expect(container.querySelector("img, video")).toBeNull();
    const mock = container.querySelector(".lp-mock")!;
    expect(mock.textContent).toContain("5.62 s");
    expect(mock.textContent).toContain("2.51 s");
    expect(mock.textContent).toMatch(/Request.*Receipt.*Transfer.*Check/);
  });

  it("with video on, shows the poster that degrades to the mock", () => {
    const { container } = render(<ProductWindow video />);
    const a = screen.getByTestId("product-window");
    expect(a).toHaveAttribute("href", "/live");
    expect(a.textContent).toContain("levee · live");
    expect(a.querySelectorAll(".lp-dots i")).toHaveLength(3);
    const img = container.querySelector(".lp-window-body img")!;
    expect(img).toHaveAttribute("src", "/media/demo-poster.jpg");
    fireEvent.error(img);
    expect(container.querySelector(".lp-window-body img")).toBeNull();
  });

  it("with video on, attaches the demo (webm then mp4, muted, looping, inline) once near the screen", () => {
    // jsdom has no IntersectionObserver, so the window counts as on screen at once
    const { container } = render(<ProductWindow video />);
    const v = container.querySelector("video")!;
    expect(v).not.toBeNull();
    expect(v.muted).toBe(true);
    expect(v.loop).toBe(true);
    expect(v.hasAttribute("playsinline")).toBe(true);
    expect([...v.querySelectorAll("source")].map((s) => s.getAttribute("src"))).toEqual(["/media/demo.webm", "/media/demo.mp4"]);
  });
});

describe("problem chart", () => {
  it("draws Levee shorter than every other bar, highlighted last, each with a source", () => {
    const { container } = render(<CompareChart leveeS={6.86} leveeTx="0.0.1-1-1" />);
    const rows = [...container.querySelectorAll(".lp-bars li")];
    expect(rows).toHaveLength(INDUSTRY.length + 1);
    const pos = rows.map((r) => Number(r.querySelector(".lp-bar")!.getAttribute("data-pos")));
    expect(rows.findIndex((r) => r.classList.contains("levee"))).toBe(rows.length - 1);
    for (let i = 1; i < pos.length; i++) expect(pos[i]).toBeLessThan(pos[i - 1]);
    for (const r of rows) expect(r.querySelector("a.lp-src")?.getAttribute("href")).toMatch(/^https:\/\//);
    expect(rows.at(-1)!.querySelector("a.lp-src")).toHaveAttribute("href", "https://hashscan.io/testnet/transaction/0.0.1-1-1");
  });
});

describe("how it works", () => {
  it("shows three cards with the live detection and containment times", () => {
    const { container } = render(<HowSection m={live} />);
    const cards = container.querySelectorAll(".lp-step");
    expect(cards).toHaveLength(3);
    expect(cards[0].textContent).toMatch(/Every payment gets a receipt on Hedera/);
    expect(cards[1].textContent).toMatch(/No receipt = theft, caught in ~3 s/);
    expect(cards[2].textContent).toMatch(/Frozen and taken back in ~6 s · 2 of 3 to unlock/);
  });
  it("uses no imagery: colour and type, each card a pill, a cream patch with a cobalt glyph, and a sentence", () => {
    const { container } = render(<HowSection m={live} />);
    expect(container.querySelector("img, video, canvas, .dither")).toBeNull();
    const cards = [...container.querySelectorAll(".lp-step")];
    expect(cards.map((c) => c.querySelector(".lp-pill")!.textContent)).toEqual(["A Receipt", "B Watch", "C Contain"]);
    for (const c of cards) {
      expect(c.classList.contains("lp-card")).toBe(true);
      expect(c.querySelector(".lp-patch svg.lp-glyph")).not.toBeNull();
    }
    expect(cards[1].querySelector(".lp-step-fig")!.textContent).toBe("~3 s");
    expect(cards[2].querySelector(".lp-step-fig")!.textContent).toBe("~6 s");
  });
});

describe("proof", () => {
  it("shows live numbers and links them to HashScan", () => {
    const { container } = render(<ProofSection m={live} />);
    expect(screen.getByText("2.51 s")).toBeInTheDocument();
    expect(screen.getByText("5.62 s")).toBeInTheDocument();
    expect(screen.getByText(`false alarms in ${FACTS.matchedSends} payments`)).toBeInTheDocument();
    expect(screen.getByText("351")).toBeInTheDocument();
    expect(screen.getByText(/Read live from the incidents topic/)).toBeInTheDocument();
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain(`https://hashscan.io/testnet/transaction/${live.attackTx}`);
    expect(hrefs).toContain(`https://hashscan.io/testnet/contract/${deploy.controller}`);
  });
  it("says 'measured run' when the chain could not be read", () => {
    render(<ProofSection m={FALLBACK_SHOWCASE} />);
    expect(screen.getByText(/The measured run/)).toBeInTheDocument();
  });
});

describe("Built on Hedera strip", () => {
  it("lists the services as a logo row", () => {
    render(<HederaStrip />);
    for (const t of ["Stablecoin Studio", "Consensus Service", "Scheduled Transactions", "Threshold keys", "Smart contract (verified)", "Mirror Node", "Arkiv"]) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
  });
});

describe("pricing", () => {
  it("has three plans, is labelled not final, and only the middle one is primary", () => {
    const { container } = render(<PricingSection />);
    expect(screen.getByText("Early access · pricing not final")).toBeInTheDocument();
    const plans = [...container.querySelectorAll(".lp-plan")];
    expect(plans.map((p) => p.querySelector("h3")!.textContent)).toEqual(["Watch", "Issuer", "Institutional"]);
    expect(plans.map((p) => p.querySelector(".lp-btn")!.classList.contains("primary"))).toEqual([false, true, false]);
    // patchwork: the middle plan is the cream card, the side plans cobalt-deep cards
    expect(plans.map((p) => (p.classList.contains("lp-patch") ? "cream" : p.classList.contains("lp-card") ? "deep" : "?"))).toEqual(["deep", "cream", "deep"]);
    expect(container.textContent).toMatch(/\$300\/mo on mainnet/);
    expect(container.textContent).toMatch(/\$1,500/);
    expect(container.querySelector("form")).toBeNull();
    for (const p of plans) expect(p.querySelector(".lp-btn")!.getAttribute("href")!.startsWith(DOCS_URL.replace("/tree/", "/blob/")) || p.querySelector(".lp-btn")!.getAttribute("href") === DOCS_URL).toBe(true);
    expect(plans.map((p) => p.querySelector(".lp-btn")!.getAttribute("href"))).toEqual([DOCS.quickstart, DOCS.setup, DOCS.contact]);
  });
});

describe("FAQ", () => {
  it("has five questions as native disclosure widgets", () => {
    const { container } = render(<FaqSection />);
    expect(container.querySelectorAll("details")).toHaveLength(5);
    expect(screen.getByText("Can it protect USDC?")).toBeInTheDocument();
    // every question is a native summary (keyboard and no-JS friendly); each answer sits in a cream patch
    for (const d of container.querySelectorAll("details")) {
      expect(d.firstElementChild!.tagName).toBe("SUMMARY");
      expect(d.querySelector("p.lp-patch")).not.toBeNull();
    }
  });
});

describe("footer", () => {
  it("has the three columns, the HashScan proof links and the disclaimer; the engraving drops out if missing", () => {
    const { container } = render(<Footer />);
    expect([...container.querySelectorAll(".lp-footer-h")].map((h) => h.textContent)).toEqual(["Product", "Developers", "Proof"]);
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain(`https://hashscan.io/testnet/token/${deploy.token.tokenId}`);
    expect(hrefs).toContain(`https://hashscan.io/testnet/contract/${deploy.controller}`);
    expect(hrefs).toContain(`https://hashscan.io/testnet/topic/${deploy.topics.incidents}`);
    expect(screen.getByText("Independent project, not affiliated with Hedera.")).toBeInTheDocument();
    const dev = [...container.querySelectorAll(".lp-footer-cols > div")][1];
    expect([...dev.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Docs", DOCS_URL],
      ["Quickstart", DOCS.quickstart],
      ["API reference", DOCS.api],
      ["Security", DOCS.security],
      ["GitHub", "https://github.com/0xvikram/levee"],
    ]);
    const img = container.querySelector(".lp-footer-art img")!;
    expect(img).toHaveAttribute("src", "/media/footer-engraving.jpg");
    fireEvent.error(img);
    expect(container.querySelector(".lp-footer-art img")).toBeNull();
    expect(container.querySelector(".lp-footer-art.missing")).not.toBeNull();
  });
});

describe("docs links", () => {
  it("are all built from DOCS_URL (one line to swap for Mintlify)", () => {
    for (const v of Object.values(DOCS)) expect(v === DOCS_URL || v.startsWith(DOCS_URL.replace("/tree/", "/blob/"))).toBe(true);
    expect(DOCS.quickstart).toMatch(/docs-site\/quickstart\.mdx$/);
    expect(DOCS.api).toMatch(/docs-site\/api-reference\/overview\.mdx$/);
  });
});
