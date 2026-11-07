/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import mdx from "@mdx-js/rollup";
import remarkGfm from "remark-gfm";
import type { Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";

// Public IDs only. state/deploy.json holds no secrets, but we still copy a fixed whitelist
// of fields so nothing else from state/ can ever reach the bundle. state/keys.json is never read.
function publicDeploy() {
  const file = path.resolve(import.meta.dirname, "../state/deploy.json");
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      network: String(s.network ?? "testnet"),
      token: { tokenId: s.token?.tokenId, symbol: s.token?.symbol, decimals: s.token?.decimals },
      treasury: s.treasury?.id,
      attacker: s.attacker?.id,
      payees: (s.payees ?? []).map((p: { id: string }) => p.id),
      admins: (s.admins ?? []).map((a: { id: string }) => a.id),
      topics: { receipts: s.topics?.receipts, incidents: s.topics?.incidents, heartbeats: s.topics?.heartbeats },
      controller: s.controller?.contractId,
    };
  } catch {
    return null; // fall back to the IDs baked into src/lib/config.ts
  }
}

/** docs-site/*.mdx start with YAML frontmatter (title, description). The docs UI reads it from the raw
 *  source (src/docs/content.ts), so it is stripped here before MDX compiles the page body. */
function stripFrontmatter(): Plugin {
  return {
    name: "levee-mdx-frontmatter",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith(".mdx")) return null;
      return { code: code.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ""), map: null };
    },
  };
}

/** @mdx-js/rollup ignores the query, so `page.mdx?raw` (the search index in src/docs/content.ts) would be compiled too. */
function mdxPages(): Plugin {
  const inner = mdx({ remarkPlugins: [remarkGfm] }) as Plugin & { transform: (this: unknown, code: string, id: string) => unknown };
  return {
    ...inner,
    enforce: "pre",
    transform(code, id) {
      if (id.includes("?")) return null;
      return inner.transform.call(this, code, id) as ReturnType<Extract<Plugin["transform"], (...a: never[]) => unknown>>;
    },
  };
}

const proxy = {
  "/api/gate": { target: "http://127.0.0.1:8710", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api\/gate/, "") },
  "/api/watcher": { target: "http://127.0.0.1:8711", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api\/watcher/, "") },
  "/api/checker": { target: "http://127.0.0.1:8712", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api\/checker/, "") },
  // demo runner (scripts/demo/runner.ts, DEMO_MODE=1 only, bound to 127.0.0.1)
  "/api/runner": { target: "http://127.0.0.1:8713", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api\/runner/, "") },
};

export default defineConfig({
  plugins: [stripFrontmatter(), mdxPages(), react({ include: /\.(mdx|jsx|js|tsx|ts)$/ })],
  define: { __LEVEE_DEPLOY__: JSON.stringify(publicDeploy()) },
  server: { port: 5173, proxy, fs: { allow: [".."] } },
  preview: { port: 4173, proxy },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
  },
});
