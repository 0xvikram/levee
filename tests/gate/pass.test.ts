import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { alwaysLive, HttpPassChecker, neverLive } from "../../src/shared/pass.js";

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const m = req.url!.split("/pass/")[1];
    res.setHeader("content-type", "application/json");
    if (m === "live") return res.end(JSON.stringify({ live: true, expiresAt: "2026-11-06T10:03:00Z", extra: 1 }));
    if (m === "dead") return res.writeHead(403).end(JSON.stringify({ live: false, reason: "pass expired" }));
    if (m === "weird") return res.end(JSON.stringify({ ok: true }));
    if (m === "slow") return void setTimeout(() => res.end("{}"), 500);
    res.writeHead(500).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("HttpPassChecker", () => {
  it("reads a live pass", async () => {
    expect(await new HttpPassChecker(base).isLive("live")).toEqual({ live: true, expiresAt: "2026-11-06T10:03:00Z" });
  });
  it("reads a refused pass with reason", async () => {
    expect(await new HttpPassChecker(base).isLive("dead")).toEqual({ live: false, reason: "pass expired" });
  });
  it("fails closed on a malformed answer, server error, timeout and unreachable checker", async () => {
    expect((await new HttpPassChecker(base).isLive("weird")).live).toBe(false);
    expect(await new HttpPassChecker(base).isLive("boom")).toMatchObject({ live: false, reason: "checker http 500" });
    expect((await new HttpPassChecker(base, 100).isLive("slow")).live).toBe(false);
    expect(await new HttpPassChecker("http://127.0.0.1:1").isLive("x")).toMatchObject({ live: false, reason: expect.stringContaining("unreachable") });
  });
  it("url-encodes the machine name", async () => {
    expect((await new HttpPassChecker(base).isLive("a/../live")).live).toBe(false);
  });
});

describe("test doubles", () => {
  it("alwaysLive / neverLive", async () => {
    expect((await alwaysLive.isLive("x")).live).toBe(true);
    expect(await neverLive("nope").isLive("x")).toEqual({ live: false, reason: "nope" });
  });
});
