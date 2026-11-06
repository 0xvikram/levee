import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ContainPanel, FeedPanel } from "./Live";
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

describe("ContainPanel", () => {
  it("shows the stopped stopwatch, steps and the incident topic once contained", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ tokens: [{ freeze_status: "FROZEN" }] }), { headers: { "content-type": "application/json" } })));
    const s = containReducer(containReducer(initialContain, { type: "breach", breach: BREACH }), { type: "incident", incident: INCIDENT });
    render(<ContainPanel s={s} reduced />);
    expect(screen.getByRole("timer")).toHaveTextContent("8.31");
    expect(screen.getByText("Contained")).toBeInTheDocument();
    expect(screen.getByText(/Treasury frozen/)).toBeInTheDocument();
    expect(screen.getByText(/10,000 RUPC wiped, receiver frozen/)).toBeInTheDocument();
    expect(screen.getByText(/topic 0\.0\.11333500/).closest("a")).toHaveAttribute("href", "https://hashscan.io/testnet/topic/0.0.11333500");
  });
});
