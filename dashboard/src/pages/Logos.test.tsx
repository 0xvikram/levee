import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Logos } from "./Logos";
import { SiteLogo } from "../components/SiteLogo";
import { LOGOS } from "../components/logos";

describe("/logos", () => {
  it("shows the four options, each as a titled single-colour SVG", () => {
    const { container } = render(<Logos />);
    expect(LOGOS.map((l) => l.id)).toEqual(["embankment", "chevron", "monogram", "sluice"]);
    for (const o of LOGOS) {
      expect(screen.getByRole("heading", { level: 2, name: o.name })).toBeInTheDocument();
      expect(screen.getByRole("img", { name: `${o.name} mark` })).toBeInTheDocument();
    }
    for (const svg of container.querySelectorAll("svg")) {
      expect(svg.getAttribute("viewBox")).toBe("0 0 32 32");
      expect(svg.getAttribute("fill")).toBe("currentColor");
    }
  });
});

describe("SiteLogo", () => {
  it("renders the current ▲ mark and the word by default", () => {
    const { container } = render(<SiteLogo />);
    expect(container.textContent).toBe("▲ Levee");
    expect(container.querySelector("svg")).toBeNull();
  });
});
