// The docs at /docs are the Mintlify sources in docs-site/, compiled by @mdx-js/rollup at build time
// (vite.config.ts). docs.json gives the navigation; each page's frontmatter gives its title and
// description. This module is only imported by the lazily loaded /docs route, so none of it (nor the
// raw page text used for search) reaches the bundle for / or /live.
import type { ComponentType } from "react";
import docsConfig from "../../../docs-site/docs.json";
import type { MDXComponents } from "mdx/types";

export type MdxPage = ComponentType<{ components?: MDXComponents }>;

const ROOT = "../../../docs-site/";
const loaders = import.meta.glob<{ default: MdxPage }>("../../../docs-site/**/*.mdx");
const raws = import.meta.glob<string>("../../../docs-site/**/*.mdx", { query: "?raw", import: "default", eager: true });

const slugOf = (file: string) => file.slice(ROOT.length).replace(/\.mdx$/, "");

export interface Frontmatter {
  title?: string;
  description?: string;
  sidebarTitle?: string;
}

/** Simple YAML frontmatter: one `key: value` per line, value optionally in double or single quotes. */
export function parseFrontmatter(src: string): { data: Frontmatter; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { data: {}, body: src };
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    data[kv[1]] = v.replace(/\\"/g, '"');
  }
  return { data, body: src.slice(m[0].length) };
}

/** Same rule as the rendered headings' ids (components.tsx), so search hits and the TOC agree. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/** Markdown inline text to plain text: links keep their label, code keeps its content. */
export function inlinePlain(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

export interface Heading {
  text: string;
  id: string;
  depth: 2 | 3;
}

export interface DocPage {
  slug: string; // "index", "quickstart", "concepts/receipts"
  href: string; // "/docs", "/docs/quickstart"
  title: string;
  navTitle: string;
  description: string;
  tab: string;
  group: string;
  headings: Heading[];
  text: string; // plain text for search
  load: () => Promise<{ default: MdxPage }>;
}

export function hrefOf(slug: string): string {
  return slug === "index" ? "/docs" : `/docs/${slug}`;
}

/** Headings (## / ###) outside code fences. */
function headingsOf(body: string): Heading[] {
  const out: Heading[] = [];
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      const text = inlinePlain(m[2]);
      out.push({ text, id: slugify(text), depth: m[1].length as 2 | 3 });
    }
  }
  return out;
}

/** Page body to searchable plain text: component tags keep their attribute values (titles, field names). */
function plainText(body: string): string {
  return body
    .replace(/```[^\n]*\n/g, "\n")
    .replace(/```/g, "")
    .replace(/<\/?[A-Za-z][^>]*>/g, (tag) => " " + [...tag.matchAll(/="([^"]*)"/g)].map((m) => m[1]).join(" ") + " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*>|]/g, " ")
    .replace(/-{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface NavGroup {
  group: string;
  pages: string[];
}
interface NavTab {
  tab: string;
  groups: NavGroup[];
}

export const TABS: NavTab[] = (docsConfig as { navigation: { tabs: NavTab[] } }).navigation.tabs;

function build(): DocPage[] {
  const pages: DocPage[] = [];
  for (const tab of TABS) {
    for (const g of tab.groups) {
      for (const slug of g.pages) {
        const file = `${ROOT}${slug}.mdx`;
        const raw = raws[file];
        const load = loaders[file];
        if (raw === undefined || !load) throw new Error(`docs.json lists "${slug}" but docs-site/${slug}.mdx is missing`);
        const { data, body } = parseFrontmatter(raw);
        const title = data.title ?? slug;
        pages.push({
          slug,
          href: hrefOf(slug),
          title,
          navTitle: data.sidebarTitle ?? title,
          description: data.description ?? "",
          tab: tab.tab,
          group: g.group,
          headings: headingsOf(body),
          text: plainText(body),
          load,
        });
      }
    }
  }
  return pages;
}

/** Every page in docs.json order (the sidebar order, and the prev/next order). */
export const PAGES: DocPage[] = build();
export const BY_SLUG = new Map(PAGES.map((p) => [p.slug, p]));

/** Every .mdx in docs-site, listed in docs.json or not. */
export const ALL_MDX_SLUGS = Object.keys(loaders).map(slugOf);

/** "/docs", "/docs/", "/docs/index", "/docs/concepts/receipts/" -> page slug (or null when not a docs path). */
export function slugFromPath(path: string): string | null {
  const m = /^\/docs(?:\/(.*))?$/.exec(path);
  if (!m) return null;
  const rest = (m[1] ?? "").replace(/\/+$/, "").replace(/\.mdx$/, "");
  return rest === "" ? "index" : rest;
}

const SITE = "https://levee-theta.vercel.app";

/**
 * Where a link inside a docs page should go. Mintlify-style root links ("/concepts/receipts",
 * "/quickstart#x") stay inside /docs; links to this site's own pages become in-app routes.
 */
export function resolveDocHref(href: string): { to: string; internal: boolean } {
  if (href.startsWith(SITE)) href = href.slice(SITE.length) || "/";
  if (href.startsWith("#")) return { to: href, internal: false };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return { to: href, internal: false };
  if (href === "/" || href === "/live" || href.startsWith("/live#") || href.startsWith("/docs")) return { to: href, internal: true };
  if (href.startsWith("/")) {
    const [p, hash] = href.split("#");
    const slug = p.replace(/^\/+/, "").replace(/\/+$/, "") || "index";
    return { to: hrefOf(slug) + (hash ? `#${hash}` : ""), internal: true };
  }
  return { to: href, internal: false };
}
