import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { allowedOrigins, argvFor, assertDemoMode, createRunner, linksIn, SPAWN_ARGV, type RunnerDeps } from "./runner.js";

describe("demo runner allow-list", () => {
  it("maps only the fixed run kinds to fixed argv", () => {
    expect(argvFor("attack")).toEqual(["npx", "tsx", "scripts/attack.ts", "10000"]);
    expect(argvFor("reopen")).toEqual(["npx", "tsx", "scripts/reopen.ts", "treasury", "attacker"]);
    for (const bad of ["pay", "attack; rm -rf /", "../attack", "ATTACK", "", undefined, null, 1, {}, ["attack"], "__proto__", "constructor"]) {
      expect(argvFor(bad)).toBeNull();
    }
  });
  it("argv is frozen", () => {
    expect(Object.isFrozen(SPAWN_ARGV)).toBe(true);
    expect(Object.isFrozen(SPAWN_ARGV.attack)).toBe(true);
  });
  it("extracts HashScan links only", () => {
    expect(linksIn("tx https://hashscan.io/testnet/transaction/0.0.1-2-3 and https://evil.example/x")).toEqual(["https://hashscan.io/testnet/transaction/0.0.1-2-3"]);
  });
});

describe("DEMO_MODE guard", () => {
  it("refuses to start unless DEMO_MODE=1", () => {
    expect(() => assertDemoMode({})).toThrow(/DEMO_MODE=1/);
    expect(() => assertDemoMode({ DEMO_MODE: "true" })).toThrow();
    expect(() => assertDemoMode({ DEMO_MODE: "0" })).toThrow();
    expect(() => assertDemoMode({ DEMO_MODE: "1" })).not.toThrow();
  });
  it("origins default to the local dashboard only", () => {
    expect(allowedOrigins({})).toEqual(["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173"]);
  });
});

describe("runner HTTP", () => {
  async function start(deps: Partial<RunnerDeps> = {}) {
    const spawned: (readonly string[])[] = [];
    let exit: (code: number) => void = () => {};
    const { app } = createRunner({
      origins: ["http://localhost:5173"],
      spawnFixed: (argv, onLine, onExit) => {
        spawned.push(argv);
        onLine("tx https://hashscan.io/testnet/transaction/0.0.9-1-2");
        exit = onExit;
      },
      pay: async () => true,
      ...deps,
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, spawned, exit: (c: number) => exit(c), close: () => server.close() };
  }

  it("runs one at a time, ignores request bodies, rejects foreign origins", async () => {
    const t = await start();
    try {
      const r1 = await fetch(`${t.base}/run/attack`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ argv: ["rm", "-rf"], amount: 1 }) });
      expect(r1.status).toBe(202);
      expect(t.spawned).toEqual([["npx", "tsx", "scripts/attack.ts", "10000"]]);
      const id = ((await r1.json()) as { run: { id: string } }).run.id;
      expect((await fetch(`${t.base}/run/reopen`, { method: "POST" })).status).toBe(409);
      t.exit(0);
      const run = (await (await fetch(`${t.base}/runs/${id}`)).json()) as { run: { status: string; links: string[] } };
      expect(run.run.status).toBe("ok");
      expect(run.run.links).toEqual(["https://hashscan.io/testnet/transaction/0.0.9-1-2"]);
      expect((await fetch(`${t.base}/run/shell`, { method: "POST" })).status).toBe(404);
      expect((await fetch(`${t.base}/run/attack`, { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
      expect(t.spawned).toHaveLength(1);
    } finally {
      t.close();
    }
  });
});
