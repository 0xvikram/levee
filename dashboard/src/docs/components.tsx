// React versions of the Mintlify components used in docs-site/*.mdx, drawn in the site's cobalt theme
// (styles in pages/docs.css). Unknown Mintlify components fail the "every page renders" test, so add
// them here when a page starts using one.
import { Children, isValidElement, lazy, Suspense, useId, useState, type ReactElement, type ReactNode } from "react";
import type { MDXComponents } from "mdx/types";
import { Link } from "../components/router";
import { resolveDocHref, slugify } from "./content";

const Mermaid = lazy(() => import("./Mermaid"));

/** Plain text of a React tree (for heading ids and copy buttons). */
export function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function DocLink({ href = "", children, className }: { href?: string; children?: ReactNode; className?: string }) {
  const { to, internal } = resolveDocHref(href);
  if (internal)
    return (
      <Link to={to} className={className}>
        {children}
      </Link>
    );
  if (to.startsWith("#"))
    return (
      <a href={to} className={className}>
        {children}
      </a>
    );
  return (
    <a href={to} className={className} target="_blank" rel="noreferrer">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function makeHeading(Tag: "h2" | "h3" | "h4") {
  return function Heading({ children }: { children?: ReactNode }) {
    const id = slugify(textOf(children));
    return (
      <Tag id={id} className="dc-h">
        {children}
        <a className="dc-anchor" href={`#${id}`} aria-label={`Link to ${textOf(children)}`}>
          #
        </a>
      </Tag>
    );
  };
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="dc-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

function Pre({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find((c) => isValidElement(c)) as
    | ReactElement<{ className?: string; children?: ReactNode }>
    | undefined;
  const lang = /language-(\S+)/.exec(code?.props.className ?? "")?.[1] ?? "";
  const text = textOf(code?.props.children ?? children).replace(/\n$/, "");
  if (lang === "mermaid") {
    return (
      <Suspense fallback={<MermaidSource code={text} />}>
        <Mermaid code={text} fallback={<MermaidSource code={text} />} />
      </Suspense>
    );
  }
  return (
    <div className="dc-code">
      <div className="dc-code-bar">
        <span>{lang || "text"}</span>
        <CopyButton text={text} />
      </div>
      <pre tabIndex={0}>
        <code className={lang ? `language-${lang}` : undefined}>{text}</code>
      </pre>
    </div>
  );
}

export function MermaidSource({ code }: { code: string }) {
  return (
    <figure className="dc-mermaid is-source">
      <pre tabIndex={0}>
        <code>{code}</code>
      </pre>
    </figure>
  );
}

// ---------------------------------------------------------------- callouts
function Callout({ kind, label, children }: { kind: string; label: string; children?: ReactNode }) {
  return (
    <aside className={`dc-callout ${kind}`} aria-label={label}>
      <span className="dc-callout-label">{label}</span>
      <div className="dc-callout-body">{children}</div>
    </aside>
  );
}
const Note = ({ children }: { children?: ReactNode }) => <Callout kind="note" label="Note" children={children} />;
const Info = ({ children }: { children?: ReactNode }) => <Callout kind="note" label="Info" children={children} />;
const Tip = ({ children }: { children?: ReactNode }) => <Callout kind="tip" label="Tip" children={children} />;
const Check = ({ children }: { children?: ReactNode }) => <Callout kind="tip" label="Check" children={children} />;
const Warning = ({ children }: { children?: ReactNode }) => <Callout kind="warning" label="Warning" children={children} />;

// ---------------------------------------------------------------- cards
const ICONS: Record<string, string> = {
  rocket: "M5 19l3-1 8-8a4 4 0 0 0-6-6l-8 8-1 3m4 0l2 2M15 3c3 0 6 3 6 6",
  shield: "M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  message: "M4 5h16v11H9l-5 4z",
  github: "M9 19c-4 1-4-2-6-2m12 4v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21",
  "building-columns": "M3 21h18M5 21V10m4 11V10m6 11V10m4 11V10M2 10l10-6 10 6z",
  "diagram-project": "M4 4h6v6H4zm10 10h6v6h-6zM7 10v4a2 2 0 0 0 2 2h5",
};
function Icon({ name }: { name?: string }) {
  const d = (name && ICONS[name]) || "M5 12h14M13 6l6 6-6 6";
  return (
    <svg className="dc-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

function Card({ title, icon, href, children }: { title?: string; icon?: string; href?: string; children?: ReactNode }) {
  const inner = (
    <>
      {icon && <Icon name={icon} />}
      {title && <span className="dc-card-title">{title}</span>}
      {children && <div className="dc-card-body">{children}</div>}
    </>
  );
  if (href)
    return (
      <DocLink href={href} className="dc-card is-link">
        {inner}
      </DocLink>
    );
  return <div className="dc-card">{inner}</div>;
}
function CardGroup({ cols = 2, children }: { cols?: number; children?: ReactNode }) {
  return (
    <div className="dc-cards" style={{ ["--cols" as string]: String(cols) }}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- steps
function Steps({ children }: { children?: ReactNode }) {
  return <ol className="dc-steps">{children}</ol>;
}
function Step({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <li className="dc-step">
      {title && <p className="dc-step-title">{title}</p>}
      <div className="dc-step-body">{children}</div>
    </li>
  );
}

// ---------------------------------------------------------------- fields
type FieldProps = {
  name?: string;
  body?: string;
  path?: string;
  query?: string;
  header?: string;
  type?: string;
  required?: boolean;
  default?: string;
  children?: ReactNode;
};
function Field({ name, body, path, query, header, type, required, default: def, children }: FieldProps) {
  const where = body !== undefined ? "body" : path !== undefined ? "path" : query !== undefined ? "query" : header !== undefined ? "header" : "";
  const label = name ?? body ?? path ?? query ?? header ?? "";
  return (
    <div className="dc-field">
      <div className="dc-field-head">
        <code className="dc-field-name">{label}</code>
        {type && <span className="dc-field-type">{type}</span>}
        {where && <span className="dc-field-type">{where}</span>}
        {required && <span className="dc-field-req">required</span>}
        {def !== undefined && <span className="dc-field-type">default: {String(def)}</span>}
      </div>
      {children && <div className="dc-field-body">{children}</div>}
    </div>
  );
}
function Expandable({ title = "properties", children }: { title?: string; children?: ReactNode }) {
  return (
    <details className="dc-accordion dc-expandable">
      <summary>Show {title}</summary>
      <div className="dc-accordion-body">{children}</div>
    </details>
  );
}

// ---------------------------------------------------------------- accordion, tabs, code group, update
function Accordion({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <details className="dc-accordion">
      <summary>{title}</summary>
      <div className="dc-accordion-body">{children}</div>
    </details>
  );
}
function AccordionGroup({ children }: { children?: ReactNode }) {
  return <div className="dc-accordion-group">{children}</div>;
}

function Tab({ children }: { title?: string; children?: ReactNode }) {
  return <>{children}</>;
}
function Tabs({ children }: { children?: ReactNode }) {
  const tabs = Children.toArray(children).filter(isValidElement) as ReactElement<{ title?: string; children?: ReactNode }>[];
  const [i, setI] = useState(0);
  const id = useId();
  return (
    <div className="dc-tabs">
      <div role="tablist" className="dc-tablist">
        {tabs.map((t, n) => (
          <button
            key={n}
            type="button"
            role="tab"
            id={`${id}-t${n}`}
            aria-selected={n === i}
            aria-controls={`${id}-p${n}`}
            tabIndex={n === i ? 0 : -1}
            onClick={() => setI(n)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") setI((i + 1) % tabs.length);
              if (e.key === "ArrowLeft") setI((i - 1 + tabs.length) % tabs.length);
            }}
          >
            {t.props.title ?? `Tab ${n + 1}`}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-p${i}`} aria-labelledby={`${id}-t${i}`}>
        {tabs[i]?.props.children}
      </div>
    </div>
  );
}
function CodeGroup({ children }: { children?: ReactNode }) {
  return <div className="dc-codegroup">{children}</div>;
}

function Update({ label, description, children }: { label?: string; description?: string; children?: ReactNode }) {
  const id = label ? slugify(label) : undefined;
  return (
    <section className="dc-update" aria-labelledby={id}>
      <div className="dc-update-meta">
        <span className="dc-update-label" id={id}>
          {label}
        </span>
        {description && <span className="dc-update-desc">{description}</span>}
      </div>
      <div className="dc-update-body">{children}</div>
    </section>
  );
}

function Frame({ caption, children }: { caption?: string; children?: ReactNode }) {
  return (
    <figure className="dc-frame">
      {children}
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

function Table({ children }: { children?: ReactNode }) {
  return (
    <div className="dc-table" tabIndex={0} role="region" aria-label="Table">
      <table>{children}</table>
    </div>
  );
}

export const MDX_COMPONENTS: MDXComponents = {
  a: ({ href, children }) => <DocLink href={href}>{children}</DocLink>,
  h1: makeHeading("h2"), // the page title is the only h1
  h2: makeHeading("h2"),
  h3: makeHeading("h3"),
  h4: makeHeading("h4"),
  pre: Pre,
  table: Table,
  Note,
  Info,
  Tip,
  Check,
  Warning,
  Card,
  CardGroup,
  Steps,
  Step,
  ParamField: Field,
  ResponseField: Field,
  Expandable,
  Accordion,
  AccordionGroup,
  Tabs,
  Tab,
  CodeGroup,
  Update,
  Frame,
  Icon: ({ icon }: { icon?: string }) => <Icon name={icon} />,
};
