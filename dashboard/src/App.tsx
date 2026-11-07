import { lazy, Suspense } from "react";
import { usePath } from "./components/router";
import { Landing } from "./pages/Landing";
import { Live } from "./pages/Live";
import { Logos } from "./pages/Logos";

/** /docs is its own chunk (MDX pages, search index, docs.css): it never loads on / or /live. */
const Docs = lazy(() => import("./pages/Docs"));

export function App() {
  const path = usePath().replace(/\/+$/, "") || "/";
  if (path === "/live") return <Live />;
  if (path === "/logos") return <Logos />;
  if (path === "/docs" || path.startsWith("/docs/"))
    return (
      <Suspense fallback={<div aria-busy="true" style={{ minHeight: "100vh", background: "var(--cobalt)" }} />}>
        <Docs />
      </Suspense>
    );
  return <Landing />;
}
