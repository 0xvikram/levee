/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
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

const proxy = {
  "/api/gate": { target: "http://127.0.0.1:8710", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api\/gate/, "") },
  "/api/watcher": { target: "http://127.0.0.1:8711", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api\/watcher/, "") },
  "/api/checker": { target: "http://127.0.0.1:8712", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api\/checker/, "") },
};

export default defineConfig({
  plugins: [react()],
  define: { __LEVEE_DEPLOY__: JSON.stringify(publicDeploy()) },
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
  },
});
