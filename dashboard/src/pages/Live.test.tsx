import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BeforeAfter, CHAIN_BANNER, ChainBanner, ContainPanel, FeedPanel, KpiStrip, ProofPanel, StoryPanel, TopBar } from "./Live";
import { initialStory, storyReducer } from "../lib/story";
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

describe("TopBar", () => {
  it("shows the treasury, the OPEN/FROZEN badge, the network dot and one Arkiv chip", () => {
    render(<TopBar treasury={{ balance: "778974460000", freeze: "FROZEN" }} health={[]} arkiv="live" mirrorOk />);
    expect(screen.getByText("778,974.46 RUPC")).toBeInTheDocument();
    expect(screen.getByText("FROZEN")).toHaveClass("state-badge", "frozen");
    expect(screen.getByText(/Hedera testnet · live/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Arkiv pass: live/ })).toHaveAttribute("href", "https://rabdi.explorer.arkiv.network");
  });
});

describe("StoryPanel", () => {
  it("runs a step from its button and disables every button while a run is going", () => {
    const onRun = vi.fn();
    const { rerender } = render(<StoryPanel story={initialStory} up busy={false} run={null} error={null} onRun={onRun} />);
    fireEvent.click(screen.getByRole("button", { name: /Hack it/ }));
    expect(onRun).toHaveBeenCalledWith("attack");
    fireEvent.click(screen.getByRole("button", { name: /Reset demo/ }));
    expect(onRun).toHaveBeenCalledWith("reset");
    const s = storyReducer(initialStory, { type: "start", kind: "mint" });
    rerender(<StoryPanel story={s} up busy run={null} error={null} onRun={onRun} />);
    for (const b of screen.getAllByRole("button")) expect(b).toBeDisabled();
    expect(screen.getByRole("button", { name: /Fake mint/ })).toHaveAttribute("aria-current", "step");
  });
  it("buttons are off when the runner is not running", () => {
    render(<StoryPanel story={initialStory} up={false} busy={false} run={null} error={null} onRun={() => undefined} />);
    expect(screen.getByRole("button", { name: /Send 500 to Asha Pay/ })).toBeDisabled();
    expect(screen.getByText(/DEMO_MODE=1 npm run demo:runner/)).toBeInTheDocument();
  });
});

describe("KpiStrip", () => {
  it("renders each figure with its label", () => {
    render(<KpiStrip kpis={[{ key: "false", label: "False alarms", value: "0", sub: "since the fix" }]} />);
    expect(screen.getByText("False alarms")).toBeInTheDocument();
    expect(screen.getByText("since the fix")).toBeInTheDocument();
  });
});

describe("ProofPanel", () => {
  it("draws a scannable QR code per HashScan link", () => {
    const url = `https://hashscan.io/testnet/transaction/${BREACH.txId}`;
    const { container } = render(<ProofPanel links={[{ label: "Theft (no receipt)", url }]} />);
    expect(screen.getByRole("img", { name: "QR code: Theft (no receipt)" })).toBeInTheDocument();
    expect(container.querySelector("svg.qr path")?.getAttribute("d")?.length).toBeGreaterThan(100);
    expect(screen.getByText("Theft (no receipt)").closest("a")).toHaveAttribute("href", url);
  });
});

describe("BeforeAfter", () => {
  it("puts Levee's real time next to the sourced industry times", () => {
    render(<BeforeAfter leveeS={8.31} />);
    expect(screen.getByText("8.31 s")).toBeInTheDocument();
    expect(screen.getByText("~3 h 9 min")).toBeInTheDocument();
    expect(screen.getByText("~8 h to ack.")).toBeInTheDocument();
    expect(screen.getByText("~45 min")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Gala Games" })).toHaveAttribute("href", expect.stringContaining("cryptoslate.com"));
  });
});

describe("ContainPanel", () => {
  it("shows the stopped stopwatch, steps and the incident topic once contained", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ tokens: [{ freeze_status: "FROZEN" }] }), { headers: { "content-type": "application/json" } })));
    const s = containReducer(containReducer(initialContain, { type: "breach", breach: BREACH }), { type: "incident", incident: INCIDENT });
    render(<ContainPanel s={s} reduced />);
    expect(screen.getByRole("timer")).toHaveTextContent("8.31");
    expect(screen.getByText("Contained")).toBeInTheDocument();
    expect(screen.getByText("treasury frozen")).toBeInTheDocument();
    expect(screen.getByText("6.44 s")).toBeInTheDocument();
    expect(screen.getByText("taken back")).toBeInTheDocument();
    expect(screen.getByText("8.31 s")).toBeInTheDocument();
  });
});

describe("chain mode pieces", () => {
  it("banner says where the data comes from", () => {
    render(<ChainBanner />);
    expect(screen.getByRole("status")).toHaveTextContent(CHAIN_BANNER);
  });
  it("a replayed incident is labelled as recorded on-chain data", () => {
    const s = containReducer(initialContain, { type: "incident", incident: INCIDENT, source: "replay" });
    render(<ContainPanel s={s} reduced extra={<button type="button">Replay again</button>} />);
    expect(screen.getByText(/replay · recorded on-chain data/)).toBeInTheDocument();
    expect(screen.getByText("Replay · contained (recorded)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replay again" })).toBeInTheDocument();
  });
});
