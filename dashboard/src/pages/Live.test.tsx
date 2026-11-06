import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ADDON_KEY, CHAIN_BANNER, ChainBanner, ContainPanel, DemoPanel, FeedPanel, PassesStrip } from "./Live";
import { deploy } from "../lib/config";
import { feedReducer, initialFeed } from "../lib/feed";
import { containReducer, initialContain } from "../lib/stopwatch";
import { BREACH, INCIDENT, MATCHED } from "../lib/__tests__/fixtures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FeedPanel", () => {
  it("renders receipt ✓ and a live no receipt ✗ row with HashScan links", () => {
    const s = [{ type: "matched", movement: MATCHED }, { type: "breach", breach: BREACH }].reduce(feedReducer as never, initialFeed) as typeof initialFeed;
    render(<FeedPanel rows={s.rows} reachable />);
    expect(screen.getByText("receipt ✓")).toBeInTheDocument();
    const bad = screen.getByText("no receipt ✗");
    expect(bad).toHaveClass("tag", "breach");
    expect(screen.getByText("10,000 RUPC → 0.0.11333494")).toBeInTheDocument();
    const link = screen.getAllByRole("link").find((a) => a.getAttribute("href")?.endsWith(BREACH.txId));
    expect(link).toHaveAttribute("href", `https://hashscan.io/testnet/transaction/${BREACH.txId}`);
  });
});

describe("FeedPanel payee names", () => {
  it("shows Asha Pay next to the first payee's account id", () => {
    const s = feedReducer(initialFeed, { type: "matched", movement: { ...MATCHED, to: deploy.payees[0] } });
    render(<FeedPanel rows={s.rows} reachable />);
    expect(screen.getByText(new RegExp(`→ Asha Pay · ${deploy.payees[0].replace(/\./g, "\\.")}`))).toBeInTheDocument();
  });
});

describe("Phase 2 machine health", () => {
  afterEach(() => window.localStorage.clear());
  it("is collapsed on first view and remembers being opened", () => {
    window.localStorage.clear();
    const passes = [{ machine: "payouts-server", live: true, kind: "ok", expiresAt: new Date(Date.now() + 120_000).toISOString(), reason: null }];
    const { container, unmount } = render(<PassesStrip passes={passes} reachable reduced />);
    const btn = screen.getByRole("button", { name: /Phase 2: machine health/ });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".ring")).toBeNull();
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".ring")).not.toBeNull();
    expect(window.localStorage.getItem(ADDON_KEY)).toBe("1");
    unmount();
    render(<PassesStrip passes={passes} reachable reduced />);
    expect(screen.getByRole("button", { name: /Phase 2: machine health/ })).toHaveAttribute("aria-expanded", "true");
  });
});

describe("ContainPanel", () => {
  it("shows the stopped stopwatch, steps and the incident topic once contained", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ tokens: [{ freeze_status: "FROZEN" }] }), { headers: { "content-type": "application/json" } })));
    const s = containReducer(containReducer(initialContain, { type: "breach", breach: BREACH }), { type: "incident", incident: INCIDENT });
    render(<ContainPanel s={s} reduced />);
    expect(screen.getByRole("timer")).toHaveTextContent("8.31");
    expect(screen.getByText("Contained")).toBeInTheDocument();
    expect(screen.getByText(/Treasury frozen/)).toBeInTheDocument();
    expect(screen.getByText(/10,000 RUPC clawed back, receiver frozen/)).toBeInTheDocument();
    expect(screen.getByText(/topic 0\.0\.11333500/).closest("a")).toHaveAttribute("href", "https://hashscan.io/testnet/topic/0.0.11333500");
  });
});

describe("chain mode pieces", () => {
  it("banner says where the data comes from", () => {
    render(<ChainBanner />);
    expect(screen.getByRole("status")).toHaveTextContent(CHAIN_BANNER);
  });
  it("passes point to Arkiv instead of faking rings", () => {
    const { container } = render(<PassesStrip passes={[]} reachable={false} reduced chain />);
    expect(screen.getByRole("link", { name: "Arkiv explorer" })).toHaveAttribute("href", "https://rabdi.explorer.arkiv.network");
    expect(container.querySelector(".ring")).toBeNull();
  });
  it("demo panel hides the runner buttons and never polls the runner", () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    render(<DemoPanel chain />);
    expect(screen.queryByRole("button", { name: /Simulate theft/ })).toBeNull();
    expect(screen.getByText(/npx tsx scripts\/attack\.ts 10000/)).toBeInTheDocument();
    expect(f).not.toHaveBeenCalled();
  });
  it("a replayed incident is labelled as recorded on-chain data", () => {
    const s = containReducer(initialContain, { type: "incident", incident: INCIDENT, source: "replay" });
    render(<ContainPanel s={s} reduced extra={<button type="button">Replay again</button>} />);
    expect(screen.getByText("replay · recorded on-chain data")).toBeInTheDocument();
    expect(screen.getByText("Replay · contained (recorded)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replay again" })).toBeInTheDocument();
  });
});
