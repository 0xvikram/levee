import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  persistenceSnapshot, evaluatePersistence, matchRemoteApps, matchRemoteProcesses, evaluateRemoteAccess,
  parseListeners, exposedSensitive, evaluatePorts, parseSpctl, parseCsrutil, parseFdesetup, evaluateProtections,
  evaluateDisk, recentExtensions, countNpmGlobals, evaluateExtensions, evaluateDevtools, type Baseline,
} from "../../src/agent/checks.js";

const fx = (n: string) => fs.readFileSync(path.join(__dirname, "fixtures", n), "utf8");

describe("persistence", () => {
  const entries = [
    { dir: "~/Library/LaunchAgents", name: "a.plist", mtimeMs: 1_000_000 },
    { dir: "/Library/LaunchDaemons", name: "b.plist", mtimeMs: 2_000_000 },
  ];
  const snap = persistenceSnapshot(entries);
  const baseline: Baseline = { createdAt: "", persistence: snap, tools: {} };
  it("is order independent and matches baseline", () => {
    expect(persistenceSnapshot([...entries].reverse()).hash).toBe(snap.hash);
    expect(evaluatePersistence(snap, baseline).ok).toBe(true);
  });
  it("flags a new launch item and names it", () => {
    const now = persistenceSnapshot([...entries, { dir: "~/Library/LaunchAgents", name: "evil.plist", mtimeMs: 3_000_000 }]);
    const r = evaluatePersistence(now, baseline);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("evil.plist");
  });
  it("flags a modified mtime", () => {
    const now = persistenceSnapshot([{ ...entries[0], mtimeMs: 9_000_000 }, entries[1]]);
    expect(evaluatePersistence(now, baseline).ok).toBe(false);
  });
  it("fails without baseline", () => expect(evaluatePersistence(snap, null).ok).toBe(false));
});

describe("remote access", () => {
  it("matches app bundles", () => {
    expect(matchRemoteApps(["Safari.app", "AnyDesk.app", "TeamViewer.app"])).toEqual(["AnyDesk", "TeamViewer"]);
    expect(matchRemoteApps(["Safari.app", "Cap.app"])).toEqual([]);
  });
  it("matches pgrep output", () => {
    expect(matchRemoteProcesses(fx("pgrep-remote.txt"))).toEqual(["AnyDesk", "TeamViewer"]);
    expect(matchRemoteProcesses("")).toEqual([]);
  });
  it("evaluates", () => {
    expect(evaluateRemoteAccess([], []).ok).toBe(true);
    expect(evaluateRemoteAccess(["AnyDesk"], ["AnyDesk"]).detail).toContain("running");
  });
});

describe("ports", () => {
  const listeners = parseListeners(fx("netstat.txt"));
  it("parses listeners incl. process names with spaces", () => {
    expect(listeners.length).toBeGreaterThanOrEqual(12);
    expect(listeners.find((l) => l.port === 7768)).toMatchObject({ address: "127.0.0.1" });
    expect(listeners.find((l) => l.port === 9222)).toMatchObject({ address: "192.168.1.20", process: "Google Chrome He" });
  });
  it("flags only sensitive ports beyond loopback", () => {
    const ports = exposedSensitive(listeners).map((l) => l.port).sort((a, b) => a - b);
    expect(ports).toEqual([22, 5900, 9222]); // 5432 is loopback only; 5000/7000 not sensitive
  });
  it("ignores ESTABLISHED lines and passes when clean", () => {
    const clean = "tcp4 0 0 127.0.0.1.8080 *.* LISTEN 0 0 131072 131072 node:1 00100 00000006 0000000000017d85 00000001 00000800 1 0 000000";
    expect(evaluatePorts(clean).ok).toBe(true);
    expect(evaluatePorts(fx("netstat.txt")).ok).toBe(false);
  });
});

describe("protections, disk", () => {
  it("parses spctl / csrutil / fdesetup", () => {
    expect(parseSpctl(fx("spctl-on.txt"))).toBe(true);
    expect(parseSpctl(fx("spctl-off.txt"))).toBe(false);
    expect(parseCsrutil(fx("csrutil-on.txt"))).toBe(true);
    expect(parseCsrutil(fx("csrutil-off.txt"))).toBe(false);
    expect(parseFdesetup(fx("fdesetup-on.txt"))).toBe(true);
    expect(parseFdesetup(fx("fdesetup-off.txt"))).toBe(false);
    expect(parseFdesetup(fx("fdesetup-deferred.txt"))).toBe(true);
  });
  it("evaluates", () => {
    expect(evaluateProtections(fx("spctl-on.txt"), fx("csrutil-on.txt")).ok).toBe(true);
    expect(evaluateProtections(fx("spctl-off.txt"), fx("csrutil-on.txt")).detail).toBe("Gatekeeper disabled");
    expect(evaluateProtections(fx("spctl-on.txt"), fx("csrutil-off.txt")).detail).toBe("SIP disabled");
    expect(evaluateDisk(fx("fdesetup-off.txt")).ok).toBe(false);
    expect(evaluateDisk(fx("fdesetup-on.txt")).ok).toBe(true);
  });
});

describe("extensions, dev tools", () => {
  const now = 10 * 24 * 3600 * 1000;
  const h = 3600 * 1000;
  const entries = [
    { dir: "d", name: "old.ext-1.0.0", mtimeMs: now - 48 * h },
    { dir: "d", name: "new.ext-2.0.0", mtimeMs: now - 2 * h },
    { dir: "d", name: "extensions.json", mtimeMs: now - 1 * h },
  ];
  it("finds recent extensions only", () => {
    const r = recentExtensions(entries, now);
    expect(r.map((e) => e.name)).toEqual(["new.ext-2.0.0"]);
    expect(evaluateExtensions(r, 4).ok).toBe(false);
    expect(evaluateExtensions([], 4).ok).toBe(true);
  });
  it("counts npm globals", () => expect(countNpmGlobals(fx("npm-ls.txt"))).toBe(4));
  it("detects a swapped binary", () => {
    const baseline: Baseline = { createdAt: "", persistence: { hash: "", entries: [] }, tools: { node: "aa", git: "bb" } };
    expect(evaluateDevtools({ node: "aa", git: "bb" }, baseline).ok).toBe(true);
    const r = evaluateDevtools({ node: "aa", git: "XX" }, baseline);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("git");
    expect(evaluateDevtools({ node: "aa" }, baseline).detail).toContain("missing");
    expect(evaluateDevtools({ node: "aa" }, null).ok).toBe(false);
  });
});
