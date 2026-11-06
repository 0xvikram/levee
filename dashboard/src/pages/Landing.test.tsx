import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CompareChart, HederaStrip, NumbersSection } from "./Landing";
import { FALLBACK_SHOWCASE } from "../lib/incident";
import { INDUSTRY, MINT, SCHEDULED_ON_BUILD } from "../lib/numbers";

afterEach(cleanup);

describe("By the numbers", () => {
  it("shows the live theft run, the mint and links both to HashScan", () => {
    const live = { ...FALLBACK_SHOWCASE, live: true, detectionS: 2.87, treasuryFrozenS: 4.85, wipedS: 6.86 };
    const { container } = render(<NumbersSection m={live} />);
    expect(screen.getByText("By the numbers")).toBeInTheDocument();
    expect(screen.getByText(/latest real incident/)).toBeInTheDocument();
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    for (const tx of [live.attackTx, live.freezeTx, live.wipeTx, MINT.mintTx, MINT.wipeTx]) {
      expect(hrefs).toContain(`https://hashscan.io/testnet/transaction/${tx}`);
    }
  });
  it("says 'measured run' when the chain could not be read", () => {
    render(<NumbersSection m={FALLBACK_SHOWCASE} />);
    expect(screen.queryByText(/latest real incident/)).toBeNull();
    expect(screen.getByText(/measured run/)).toBeInTheDocument();
  });
});

describe("comparison chart", () => {
  it("draws Levee shorter than every other bar, highlighted, each with a source", () => {
    const { container } = render(<CompareChart leveeS={6.86} leveeTx="0.0.1-1-1" />);
    const rows = [...container.querySelectorAll(".bn-bars li")];
    expect(rows).toHaveLength(INDUSTRY.length + 1);
    const pos = rows.map((r) => Number(r.querySelector(".bn-bar")!.getAttribute("data-pos")));
    const levee = rows.findIndex((r) => r.classList.contains("levee"));
    expect(levee).toBe(rows.length - 1);
    for (let i = 1; i < pos.length; i++) expect(pos[i]).toBeLessThan(pos[i - 1]); // sorted longest → Levee
    for (const r of rows) expect(r.querySelector("a.bn-src")?.getAttribute("href")).toMatch(/^https:\/\//);
  });
});

describe("Built on Hedera strip", () => {
  it("lists the services with the public ids and the Arkiv chip", () => {
    render(<HederaStrip />);
    for (const t of ["Hedera Token Service", "Hedera Consensus Service", "Threshold keys", "Smart contract", "Mirror Node", "Arkiv"]) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
    expect(screen.getByText(/ContainmentController 0\.0\.11333603/)).toBeInTheDocument();
    expect(screen.queryByText("Scheduled Transactions") !== null).toBe(SCHEDULED_ON_BUILD);
  });
});
