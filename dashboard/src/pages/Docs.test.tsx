import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import Docs from "./Docs";
import { App } from "../App";
import { ALL_MDX_SLUGS, PAGES, TABS, hrefOf, parseFrontmatter, resolveDocHref, slugFromPath, slugify } from "../docs/content";
import { search } from "../docs/search";

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  Element.prototype.scrollIntoView = vi.fn();
  errors = vi.spyOn(console, "error");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  errors.mockRestore();
  window.history.replaceState(null, "", "/");
});

const go = (path: string) => window.history.replaceState(null, "", path);

/** Render /docs/<slug> and wait until the MDX body is in (not just the title). */
async function renderPage(path: string) {
  go(path);
  const utils = render(<Docs />);
  await waitFor(() => expect(utils.container.querySelector(".dc-prose .dc-loading")).toBeNull(), { timeout: 5000 });
  await waitFor(() => expect(utils.container.querySelector(".dc-prose")!.textContent!.trim().length).toBeGreaterThan(40));
  return utils;
}

describe("docs content", () => {
  it("docs.json lists every .mdx in docs-site exactly once, in four tabs", () => {
    const listed = PAGES.map((p) => p.slug);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...ALL_MDX_SLUGS].sort());
    expect(TABS.map((t) => t.tab)).toEqual(["Documentation", "API reference", "Security", "Product"]);
    expect(PAGES[0].slug).toBe("index");
    expect(PAGES).toHaveLength(32);
  });

  it("every page has a title and a description from its frontmatter", () => {
    for (const p of PAGES) {
      expect(p.title, p.slug).not.toBe(p.slug);
      expect(p.description.length, p.slug).toBeGreaterThan(10);
    }
  });

  it("parses quoted and bare frontmatter values", () => {
    const { data, body } = parseFrontmatter('---\ntitle: "A \\"b\\""\ndescription: plain words\n---\n\nBody');
    expect(data).toEqual({ title: 'A "b"', description: "plain words" });
    expect(body.trim()).toBe("Body");
  });
});

describe("every docs.json page compiles and renders", () => {
  it.each(PAGES.map((p) => [p.slug, p] as const))("%s", async (_slug, p) => {
    const { container } = await renderPage(p.href);
    expect(screen.getByRole("heading", { level: 1, name: p.title })).toBeInTheDocument();
    // the body rendered real content: at least one block, and every ## / ### heading in the source has its id
    const prose = container.querySelector(".dc-prose")!;
    expect(prose.querySelector("p, ul, ol, .dc-steps, .dc-cards, .dc-field, .dc-accordion, .dc-update, .dc-code")).not.toBeNull();
    for (const h of p.headings) expect(prose.querySelector(`[id="${h.id}"]`), `${p.slug} #${h.id}`).not.toBeNull();
    // no raw Mintlify tags or frontmatter leaked into the text
    expect(prose.textContent).not.toMatch(/<\/?(Card|Step|Note|Warning|ParamField|ResponseField|Accordion|Update)\b/);
    expect(prose.textContent).not.toMatch(/^---/);
    // the sidebar marks this page, and prev/next follow docs.json order
    expect(container.querySelector(`.dc-side a[aria-current="page"]`)).toHaveAttribute("href", p.href);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("docs components", () => {
  it("renders Mintlify components as real UI (steps, cards, fields, accordions, mermaid source)", async () => {
    const quick = await renderPage("/docs/quickstart");
    expect(quick.container.querySelectorAll(".dc-step").length).toBeGreaterThan(2);
    expect(quick.container.querySelector(".dc-callout.warning")).not.toBeNull();
    expect(quick.container.querySelector(".dc-code pre code")).not.toBeNull();
    cleanup();
    const gate = await renderPage("/docs/api-reference/gate");
    expect(gate.container.querySelectorAll(".dc-field").length).toBeGreaterThan(5);
    expect(gate.container.querySelector(".dc-field-req")!.textContent).toBe("required");
    cleanup();
    const faq = await renderPage("/docs/product/faq");
    expect(faq.container.querySelectorAll("details.dc-accordion summary").length).toBeGreaterThan(3);
    cleanup();
    const how = await renderPage("/docs/how-it-works");
    // in tests mermaid stays as its source (the browser draws it); either way the diagram block is there
    expect(how.container.querySelectorAll(".dc-mermaid").length).toBe(3);
    expect(how.container.querySelector(".dc-mermaid")!.textContent).toMatch(/flowchart/);
    expect(how.container.querySelectorAll(".dc-toc li").length).toBeGreaterThan(1);
    cleanup();
    const home = await renderPage("/docs");
    const cards = home.container.querySelectorAll("a.dc-card");
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      const href = c.getAttribute("href")!;
      expect(href.startsWith("/docs") || href.startsWith("/live") || href.startsWith("https://")).toBe(true);
    }
  });
});

describe("docs routing", () => {
  it("maps /docs paths to page slugs", () => {
    expect(slugFromPath("/docs")).toBe("index");
    expect(slugFromPath("/docs/")).toBe("index");
    expect(slugFromPath("/docs/index")).toBe("index");
    expect(slugFromPath("/docs/concepts/receipts")).toBe("concepts/receipts");
    expect(slugFromPath("/docs/quickstart/")).toBe("quickstart");
    expect(slugFromPath("/live")).toBeNull();
    expect(slugFromPath("/docsx")).toBeNull();
    expect(hrefOf("index")).toBe("/docs");
    expect(hrefOf("concepts/gate")).toBe("/docs/concepts/gate");
  });

  it("keeps Mintlify root links inside /docs and sends the rest out", () => {
    expect(resolveDocHref("/concepts/receipts")).toEqual({ to: "/docs/concepts/receipts", internal: true });
    expect(resolveDocHref("/quickstart#reset")).toEqual({ to: "/docs/quickstart#reset", internal: true });
    expect(resolveDocHref("https://levee-theta.vercel.app/live")).toEqual({ to: "/live", internal: true });
    expect(resolveDocHref("https://hashscan.io/testnet/topic/0.0.1")).toEqual({ to: "https://hashscan.io/testnet/topic/0.0.1", internal: false });
    expect(resolveDocHref("#check-order")).toEqual({ to: "#check-order", internal: false });
  });

  it("App sends /docs and /docs/<page> to the docs, and an unknown page shows a 404 inside the docs", async () => {
    go("/docs");
    const a = render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: PAGES[0].title }, { timeout: 5000 })).toBeInTheDocument();
    a.unmount();
    go("/docs/concepts/receipts");
    const b = render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: PAGES.find((p) => p.slug === "concepts/receipts")!.title }, { timeout: 5000 })).toBeInTheDocument();
    b.unmount();
    go("/docs/no-such-page");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" }, { timeout: 5000 })).toBeInTheDocument();
  });

  it("internal links in a page, the sidebar and next/prev navigate within /docs without a reload", async () => {
    const { container } = await renderPage("/docs/concepts/gate");
    const internal = [...container.querySelectorAll<HTMLAnchorElement>(".dc-prose a")].find((a) => a.getAttribute("href")!.startsWith("/docs/"));
    expect(internal, "concepts/gate links to another docs page").toBeTruthy();
    for (const ext of container.querySelectorAll<HTMLAnchorElement>('.dc-prose a[href^="http"]')) expect(ext).toHaveAttribute("target", "_blank");
    const target = internal!.getAttribute("href")!.split("#")[0];
    act(() => {
      fireEvent.click(internal!);
    });
    expect(window.location.pathname).toBe(target);
    const p = PAGES.find((x) => x.href === target)!;
    expect(await screen.findByRole("heading", { level: 1, name: p.title }, { timeout: 5000 })).toBeInTheDocument();

    const side = within(container.querySelector(".dc-side") as HTMLElement);
    act(() => {
      fireEvent.click(side.getByRole("link", { name: "Threat model" }));
    });
    expect(window.location.pathname).toBe("/docs/security/threat-model");
    expect(await screen.findByRole("heading", { level: 1, name: /threat model/i }, { timeout: 5000 })).toBeInTheDocument();
    expect(container.querySelector(".dc-side a[aria-current='page']")).toHaveTextContent("Threat model");

    const next = container.querySelector<HTMLAnchorElement>(".dc-pager-link.next")!;
    const i = PAGES.findIndex((x) => x.slug === "security/threat-model");
    expect(next.getAttribute("href")).toBe(PAGES[i + 1].href);
    expect(container.querySelector(".dc-pager-link.prev")).toHaveAttribute("href", PAGES[i - 1].href);
  });

  it("the menu button opens and closes the sidebar (mobile)", async () => {
    const { container } = await renderPage("/docs/quickstart");
    const btn = screen.getByRole("button", { name: "Open menu" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(btn);
    expect(screen.getByRole("button", { name: "Close menu" })).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".dc-side.open")).not.toBeNull();
  });

  it("the top bar links home, to the live demo and to GitHub", async () => {
    const { container } = await renderPage("/docs");
    const top = container.querySelector(".dc-top") as HTMLElement;
    expect(top.querySelector(".dc-logo")).toHaveAttribute("href", "/");
    expect(within(top).getByRole("link", { name: "Live demo" })).toHaveAttribute("href", "/live");
    expect(within(top).getByRole("link", { name: /GitHub/ })).toHaveAttribute("href", "https://github.com/0xvikram/levee");
  });
});

describe("docs search", () => {
  it("finds pages by title, heading and body text, best match first", () => {
    expect(search(PAGES, "receipts")[0].slug).toBe("concepts/receipts");
    expect(search(PAGES, "mainnet checklist")[0].slug).toBe("integrate/mainnet-checklist");
    expect(search(PAGES, "threat model")[0].slug).toBe("security/threat-model");
    expect(search(PAGES, "pricing")[0].slug).toBe("product/pricing");
    // body-only words still find something, and every word must match
    expect(search(PAGES, "ACCOUNT_FROZEN_FOR_TOKEN").length).toBeGreaterThan(0);
    expect(search(PAGES, "receipts zzqxv")).toEqual([]);
    expect(search(PAGES, "   ")).toEqual([]);
    expect(search(PAGES, "receipts").length).toBeLessThanOrEqual(8);
  });

  it("links straight to a matching heading when the title does not match", () => {
    const page = PAGES.find((p) => p.headings.length > 0 && p.slug === "api-reference/gate")!;
    const h = page.headings[0];
    const hit = search(PAGES, h.text).find((x) => x.slug === page.slug);
    expect(hit).toBeTruthy();
    if (!page.title.toLowerCase().includes(h.text.toLowerCase().split(" ")[0])) expect(hit!.href).toBe(`${page.href}#${slugify(h.text)}`);
  });

  it("the search box lists results and Enter opens the first one", async () => {
    const { container } = await renderPage("/docs");
    const box = screen.getByRole("combobox", { name: "Search the docs" });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "threat model" } });
    const list = screen.getByRole("listbox", { name: "Search results" });
    expect(within(list).getAllByRole("option")[0]).toHaveTextContent("Threat model");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(window.location.pathname).toBe("/docs/security/threat-model");
    expect(await screen.findByRole("heading", { level: 1, name: /threat model/i }, { timeout: 5000 })).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "zzqxv" } });
    fireEvent.focus(box);
    expect(container.querySelector(".dc-search-empty")).toHaveTextContent("No results");
  });
});
