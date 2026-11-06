import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CompareChart, FaqSection, Footer, HederaStrip, HowSection, Landing, PricingSection, ProductWindow, ProofSection } from "./Landing";
import { FALLBACK_SHOWCASE } from "../lib/incident";
import { FACTS, INDUSTRY } from "../lib/numbers";
import { deploy } from "../lib/config";

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
  it("has one h1 with a single yellow accent, the short subtitle and both CTAs", () => {
    const { container } = render(<Landing />);
    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe("Hacked? Your stablecoin snaps back in seconds.");
    expect(h1s[0].querySelectorAll(".accent")).toHaveLength(1);
    expect(screen.getByText("For stablecoin issuers on Hedera. No receipt, no movement.")).toBeInTheDocument();
    const hero = container.querySelector(".lp-hero-copy")!;
    expect(within(hero as HTMLElement).getByRole("link", { name: "Watch it live" })).toHaveAttribute("href", "/live");
    expect(within(hero as HTMLElement).getByRole("link", { name: "Read the docs" }).getAttribute("href")).toMatch(/github\.com\/0xvikram\/levee\/tree\/build\/docs-site/);
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
  it("is a link to /live titled levee · live, with a poster that degrades to a placeholder", () => {
    const { container } = render(<ProductWindow />);
    const a = screen.getByTestId("product-window");
    expect(a).toHaveAttribute("href", "/live");
    expect(a.textContent).toContain("levee · live");
    expect(a.querySelectorAll(".lp-dots i")).toHaveLength(3);
    const img = container.querySelector(".lp-window-body img")!;
    expect(img).toHaveAttribute("src", "/media/demo-poster.jpg");
    fireEvent.error(img);
    expect(container.querySelector(".lp-window-body img")).toBeNull();
  });

  it("attaches the demo video (webm then mp4, muted, looping, inline) once near the screen", () => {
    // jsdom has no IntersectionObserver, so the window counts as on screen at once
    const { container } = render(<ProductWindow />);
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
    expect(container.textContent).toMatch(/\$300\/mo on mainnet/);
    expect(container.textContent).toMatch(/\$1,500/);
    expect(container.querySelector("form")).toBeNull();
    for (const p of plans) expect(p.querySelector(".lp-btn")!.getAttribute("href")).toMatch(/^https:\/\/github\.com\/0xvikram\/levee/);
  });
});

describe("FAQ", () => {
  it("has five questions as native disclosure widgets", () => {
    const { container } = render(<FaqSection />);
    expect(container.querySelectorAll("details")).toHaveLength(5);
    expect(screen.getByText("Can it protect USDC?")).toBeInTheDocument();
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
    const img = container.querySelector(".lp-footer-art")!;
    expect(img).toHaveAttribute("src", "/media/footer-engraving.jpg");
    fireEvent.error(img);
    expect(container.querySelector(".lp-footer-art")).toBeNull();
  });
});
