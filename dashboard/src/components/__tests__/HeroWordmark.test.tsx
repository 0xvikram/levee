import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { HeroWordmark } from "../HeroWordmark";
import { FALLBACK_SHOWCASE } from "../../lib/incident";

function mockReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: reduce && q.includes("reduce"),
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HeroWordmark", () => {
  it("renders the wordmark, 4 stat cells and the live link", () => {
    mockReducedMotion(false);
    const { container } = render(<HeroWordmark />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Levee");
    const strip = screen.getByRole("list", { name: /in numbers/i });
    const cells = within(strip).getAllByRole("listitem");
    expect(cells).toHaveLength(4);
    expect(cells[0]).toHaveTextContent("~3 s");
    expect(cells[0]).toHaveTextContent("2.87 s");
    expect(cells[1]).toHaveTextContent("~7 s");
    expect(cells[2]).toHaveTextContent("0");
    expect(cells[2]).toHaveTextContent("393 payments");
    expect(within(cells[3]).getByRole("link", { name: /live demo/i })).toHaveAttribute("href", "/live");
    expect(screen.getByRole("link", { name: /Resolv took 3 h 9 min/ })).toHaveAttribute("href", expect.stringContaining("kucoin.com"));
    expect(container.querySelector(".wm")).not.toHaveClass("wm--still");
    expect(container.querySelectorAll(".wm-cloud--back")).toHaveLength(2);
    expect(container.querySelectorAll(".wm-cloud--front")).toHaveLength(2);
  });

  it("uses the live run when the showcase is read from Hedera", () => {
    mockReducedMotion(false);
    render(<HeroWordmark showcase={{ ...FALLBACK_SHOWCASE, detectionS: 1.42, wipedS: 5.1, live: true }} />);
    const cells = screen.getAllByRole("listitem");
    expect(cells[0]).toHaveTextContent("~1 s");
    expect(cells[0]).toHaveTextContent("1.42 s");
    expect(cells[1]).toHaveTextContent("~5 s");
  });

  it("goes still under reduced motion (no video, still class)", () => {
    mockReducedMotion(true);
    const { container } = render(<HeroWordmark />);
    expect(container.querySelector(".wm")).toHaveClass("wm--still");
    expect(container.querySelector("video")).toBeNull();
  });
});
