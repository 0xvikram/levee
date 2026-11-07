// /docs and /docs/<page>: the Mintlify docs in docs-site/, rendered in the site's own theme.
// Loaded lazily from App.tsx, so none of this reaches the bundle for / or /live.
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type RefObject } from "react";
import { Link, navigate, usePath } from "../components/router";
import { SiteLogo } from "../components/SiteLogo";
import { GITHUB } from "../lib/config";
import { BY_SLUG, PAGES, TABS, slugFromPath, type DocPage, type MdxPage } from "../docs/content";
import { MDX_COMPONENTS } from "../docs/components";
import { search, type SearchHit } from "../docs/search";
import "./docs.css";

const lazyPages = new Map<string, ComponentType>();
function pageComponent(p: DocPage): ComponentType {
  let C = lazyPages.get(p.slug);
  if (!C) {
    const Mdx = lazy(p.load) as unknown as MdxPage;
    C = () => <Mdx components={MDX_COMPONENTS} />;
    lazyPages.set(p.slug, C);
  }
  return C;
}

export default function Docs() {
  const path = usePath();
  const slug = slugFromPath(path) ?? "index";
  const page = BY_SLUG.get(slug);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add("dc-page");
    return () => document.documentElement.classList.remove("dc-page");
  }, []);
  useEffect(() => {
    const before = document.title;
    document.title = page ? `${page.title} · Levee docs` : "Not found · Levee docs";
    return () => {
      document.title = before;
    };
  }, [page]);
  useEffect(() => setMenuOpen(false), [slug]);

  return (
    <div className="dc">
      <a className="dc-skip" href="#dc-main">
        Skip to content
      </a>
      <header className="dc-top">
        <button
          type="button"
          className="dc-menu-btn"
          aria-expanded={menuOpen}
          aria-controls="dc-side"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            {menuOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
          <span className="sr-only">{menuOpen ? "Close menu" : "Open menu"}</span>
        </button>
        <Link to="/" className="dc-logo">
          <SiteLogo />
        </Link>
        <Link to="/docs" className="dc-title">
          Docs
        </Link>
        <DocsSearch />
        <nav className="dc-top-links" aria-label="Site">
          <Link to="/live">Live demo</Link>
          <a href={GITHUB} target="_blank" rel="noreferrer">
            GitHub<span className="sr-only"> (opens in a new tab)</span>
          </a>
        </nav>
      </header>

      <div className="dc-shell">
        <nav id="dc-side" className={`dc-side${menuOpen ? " open" : ""}`} aria-label="Docs">
          {TABS.map((tab) => (
            <div key={tab.tab} className="dc-side-tab">
              {tab.groups.map((g) => (
                <div key={g.group} className="dc-side-group">
                  <p className="dc-side-label">{tab.tab === "Documentation" ? g.group : tab.tab}</p>
                  <ul>
                    {g.pages.map((s) => {
                      const p = BY_SLUG.get(s)!;
                      const active = s === slug;
                      return (
                        <li key={s}>
                          <Link to={p.href} aria-current={active ? "page" : undefined} className={active ? "active" : undefined}>
                            {p.navTitle}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </nav>
        {menuOpen && <div className="dc-scrim" onClick={() => setMenuOpen(false)} aria-hidden="true" />}

        {page ? <DocArticle key={page.slug} page={page} /> : <NotFound slug={slug} />}
      </div>
    </div>
  );
}

function DocArticle({ page }: { page: DocPage }) {
  const Body = useMemo(() => pageComponent(page), [page]);
  const i = PAGES.indexOf(page);
  const prev = PAGES[i - 1];
  const next = PAGES[i + 1];
  const [toc, setToc] = useState<{ id: string; text: string; depth: number }[]>([]);
  const articleRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string>("");

  return (
    <>
      <main id="dc-main" className="dc-main" tabIndex={-1}>
        <article className="dc-article">
          <header className="dc-article-head">
            <p className="dc-overline">{page.group}</p>
            <h1>{page.title}</h1>
            {page.description && <p className="dc-desc">{page.description}</p>}
          </header>
          <div className="dc-prose" ref={articleRef}>
            <Suspense fallback={<p className="dc-loading">Loading…</p>}>
              <Body />
              <Rendered articleRef={articleRef} onToc={setToc} onActive={setActiveId} />
            </Suspense>
          </div>
          <nav className="dc-pager" aria-label="Previous and next page">
            {prev ? (
              <Link to={prev.href} className="dc-pager-link prev">
                <span>Previous</span>
                {prev.navTitle}
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link to={next.href} className="dc-pager-link next">
                <span>Next</span>
                {next.navTitle}
              </Link>
            )}
          </nav>
        </article>
      </main>
      <aside className="dc-toc" aria-label="On this page">
        {toc.length > 0 && (
          <>
            <p className="dc-side-label">On this page</p>
            <ul>
              {toc.map((h) => (
                <li key={h.id} className={`d${h.depth}`}>
                  <a href={`#${h.id}`} className={h.id === activeId ? "active" : undefined}>
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
    </>
  );
}

/** Mounts once the page's MDX has loaded: reads its h2/h3 for the TOC, follows #hash, tracks the heading in view. */
function Rendered({
  articleRef,
  onToc,
  onActive,
}: {
  articleRef: RefObject<HTMLDivElement | null>;
  onToc: (t: { id: string; text: string; depth: number }[]) => void;
  onActive: (id: string) => void;
}) {
  // a passive effect: refs on the parent (articleRef) are attached after children's layout effects
  useEffect(() => {
    const root = articleRef.current;
    if (!root) return;
    const hs = [...root.querySelectorAll<HTMLElement>("h2.dc-h[id], h3.dc-h[id]")];
    onToc(hs.map((h) => ({ id: h.id, text: (h.firstChild ? [...h.childNodes].filter((n) => !(n instanceof HTMLElement && n.classList.contains("dc-anchor"))).map((n) => n.textContent).join("") : h.textContent ?? "").trim(), depth: h.tagName === "H3" ? 3 : 2 })));
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (hash) document.getElementById(hash)?.scrollIntoView();
    if (typeof IntersectionObserver === "undefined" || !hs.length) return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = hs.find((h) => seen.get(h.id));
        if (first) onActive(first.id);
      },
      { rootMargin: "-80px 0px -60% 0px" },
    );
    hs.forEach((h) => io.observe(h));
    return () => io.disconnect();
  }, [articleRef, onToc, onActive]);
  return null;
}

function NotFound({ slug }: { slug: string }) {
  return (
    <main id="dc-main" className="dc-main" tabIndex={-1}>
      <article className="dc-article">
        <header className="dc-article-head">
          <p className="dc-overline">404</p>
          <h1>Page not found</h1>
          <p className="dc-desc">There is no docs page at /docs/{slug}.</p>
        </header>
        <p className="dc-prose">
          Start at the <Link to="/docs">introduction</Link> or the <Link to="/docs/quickstart">quickstart</Link>, or use search.
        </p>
      </article>
    </main>
  );
}

// ---------------------------------------------------------------- search
function DocsSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const hits: SearchHit[] = useMemo(() => search(PAGES, q), [q]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        input.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (h: SearchHit) => {
    setOpen(false);
    setQ("");
    input.current?.blur();
    navigate(h.href);
    const id = h.href.split("#")[1];
    if (id) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter" && hits[sel]) {
      e.preventDefault();
      go(hits[sel]);
    } else if (e.key === "Escape") {
      setOpen(false);
      input.current?.blur();
    }
  };
  const show = open && q.trim().length > 0;

  return (
    <div className="dc-search" role="search">
      <label htmlFor="dc-search-input" className="sr-only">
        Search the docs
      </label>
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </svg>
      <input
        id="dc-search-input"
        ref={input}
        type="search"
        placeholder="Search docs"
        autoComplete="off"
        role="combobox"
        aria-expanded={show}
        aria-controls="dc-search-results"
        aria-activedescendant={show && hits[sel] ? `dc-hit-${sel}` : undefined}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setSel(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
      />
      <kbd aria-hidden="true">/</kbd>
      {show && (
        <ul id="dc-search-results" className="dc-search-results" role="listbox" aria-label="Search results">
          {hits.length === 0 && <li className="dc-search-empty">No results for “{q.trim()}”</li>}
          {hits.map((h, n) => (
            <li
              key={h.href}
              id={`dc-hit-${n}`}
              role="option"
              aria-selected={n === sel}
              className={n === sel ? "sel" : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                go(h);
              }}
              onMouseEnter={() => setSel(n)}
            >
              <span className="dc-hit-title">
                {h.title}
                {h.heading && <span className="dc-hit-heading"> › {h.heading}</span>}
              </span>
              <span className="dc-hit-group">{h.group}</span>
              <span className="dc-hit-snippet">{h.snippet}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
