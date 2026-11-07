// Mermaid diagrams, drawn in the browser. This file (and the mermaid package it imports on demand)
// is split out of every bundle: it only loads on a docs page that has a ```mermaid block.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

let ready: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  ready ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      fontFamily: "Inter, 'Helvetica Neue', Arial, sans-serif",
      // no automatic shrink-to-fit: wide left-to-right flowcharts made their labels unreadably small.
      // The component below sizes each diagram (fit the column down to 75%, then scroll).
      flowchart: { useMaxWidth: false, nodeSpacing: 28, rankSpacing: 34, padding: 10, wrappingWidth: 160 },
      sequence: { useMaxWidth: false },
      themeVariables: {
        // cobalt theme: cobalt-deep boxes with cream lines and text; edge labels on cobalt-ink
        background: "#0e1f5e",
        primaryColor: "#1a3892",
        primaryTextColor: "#f3ebd6",
        primaryBorderColor: "#f3ebd6",
        secondaryColor: "#142c82",
        tertiaryColor: "#142c82",
        lineColor: "#f3ebd6",
        textColor: "#f3ebd6",
        mainBkg: "#1a3892",
        nodeBorder: "#f3ebd6",
        edgeLabelBackground: "#0e1f5e",
        clusterBkg: "#142c82",
        actorBkg: "#1a3892",
        actorBorder: "#f3ebd6",
        actorTextColor: "#f3ebd6",
        actorLineColor: "#f3ebd6",
        signalColor: "#f3ebd6",
        signalTextColor: "#f3ebd6",
        labelBoxBkgColor: "#142c82",
        labelBoxBorderColor: "#f3ebd6",
        labelTextColor: "#f3ebd6",
        loopTextColor: "#f3ebd6",
        noteBkgColor: "#f2e34c",
        noteTextColor: "#0e1f5e",
        noteBorderColor: "#f2e34c",
        activationBkgColor: "#142c82",
        activationBorderColor: "#f3ebd6",
        sequenceNumberColor: "#0e1f5e",
        fontSize: "14px",
      },
    });
    return mermaid;
  });
  return ready;
}

export default function Mermaid({ code, fallback }: { code: string; fallback: ReactNode }) {
  const [svg, setSvg] = useState<string | null>(null);
  const id = "mmd" + useId().replace(/[^a-zA-Z0-9]/g, "");
  useEffect(() => {
    if (import.meta.env.MODE === "test") return; // jsdom has no layout; tests check the source fallback
    let live = true;
    loadMermaid()
      .then((m) => m.render(id, code))
      .then(({ svg }) => live && setSvg(svg))
      .catch(() => {
        /* keep the source fallback */
      });
    return () => {
      live = false;
    };
  }, [code, id]);
  const ref = useRef<HTMLElement>(null);
  // Fit the column when that keeps text at >= 75% of its natural size; wider diagrams scroll inside the figure.
  useLayoutEffect(() => {
    const el = ref.current?.querySelector("svg");
    const natural = el?.viewBox.baseVal?.width;
    if (!el || !natural) return;
    el.style.maxWidth = `${natural}px`;
    el.style.width = `max(100%, ${Math.round(natural * 0.75)}px)`;
  }, [svg]);
  if (!svg) return <>{fallback}</>;
  return <figure ref={ref} className="dc-mermaid" role="img" aria-label="Diagram (scrolls sideways when wide)" tabIndex={0} dangerouslySetInnerHTML={{ __html: svg }} />;
}
