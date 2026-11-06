import { describe, it, expect, beforeEach } from "vitest";
import { CHECK_IDS, checksFor, evaluatePorts, isProfile, parseAllowPorts, type CheckResult, type CheckId } from "../../src/agent/checks.js";
import { buildPayload, failingChecks, newMachineKey, publicKeyOf, signPayload } from "../../src/agent/protocol.js";
import { applySimulation, normaliseCheckId } from "../../src/agent/index.js";
import { CheckerCore, HttpError } from "../../src/checker/core.js";
import { MemoryPassStore } from "../../src/shared/arkiv.js";

const SERVER: CheckId[] = ["persistence", "ports", "devtools", "protections"];
const results = (ids: CheckId[], bad: string[] = []): CheckResult[] => ids.map((id) => ({ id, ok: !bad.includes(id), detail: "", evidenceHash: `h-${id}` }));
const status = async (fn: () => Promise<unknown>) => fn().then(() => 200, (e) => (e instanceof HttpError ? e.status : 500));

describe("machine profiles", () => {
  it("laptop runs all 7; server and ci skip disk, extensions, remote-access", () => {
    expect(checksFor("laptop")).toEqual(CHECK_IDS);
    expect(checksFor("server")).toEqual(SERVER);
    expect(checksFor("ci")).toEqual(SERVER);
    expect(isProfile("server")).toBe(true);
    expect(isProfile("desktop")).toBe(false);
  });
  it("buildPayload marks skipped checks as skip and carries the profile", () => {
    const p = buildPayload("s", 1, "n", results(SERVER), 1000, "server");
    expect(p.profile).toBe("server");
    expect(p.checks).toMatchObject({ disk: "skip", extensions: "skip", "remote-access": "skip", ports: "ok" });
    expect(failingChecks(p.checks, "server")).toEqual([]);
    // the same payload judged as a laptop fails on every skipped check
    expect(failingChecks(p.checks, "laptop").sort()).toEqual(["disk", "extensions", "remote-access"]);
    // no profile: payload shape is unchanged from before (no profile key, no skips)
    expect(buildPayload("s", 1, "n", results(CHECK_IDS), 1000)).not.toHaveProperty("profile");
  });
  it("server still fails on the checks it keeps", () => {
    expect(failingChecks(buildPayload("s", 1, "n", results(SERVER, ["ports"]), 1000, "server").checks, "server")).toEqual(["ports"]);
  });
  it("simulate-fail accepts camelCase and works for a check the profile skips", () => {
    expect(normaliseCheckId("remoteAccess")).toBe("remote-access");
    expect(normaliseCheckId("remote-access")).toBe("remote-access");
    expect(normaliseCheckId("nope")).toBeNull();
    const r = applySimulation(results(SERVER), "disk");
    expect(r.find((x) => x.id === "disk")?.ok).toBe(false);
  });
  it("LEVEE_ALLOW_PORTS allowlist: parsed strictly and shown in the detail", () => {
    expect(parseAllowPorts("5432, 6379,abc,0,70000")).toEqual([5432, 6379]);
    expect(parseAllowPorts(undefined)).toEqual([]);
    const netstat = "tcp4       0      0  *.5432                 *.*                    LISTEN      131072  131072    700      0 postgres:700   00100 00000006 0000000000000a1b 00000000 00000800      1      0 000001\n";
    expect(evaluatePorts(netstat).ok).toBe(false);
    const allowed = evaluatePorts(netstat, [5432]);
    expect(allowed.ok).toBe(true);
    expect(allowed.detail).toMatch(/allowlisted: 5432/);
  });
});

describe("checker enforces the enrolled profile", () => {
  let t: number, core: CheckerCore, key: ReturnType<typeof newMachineKey>, seq: number;
  beforeEach(() => {
    t = 1_700_000_000_000;
    seq = 0;
    core = new CheckerCore({ store: new MemoryPassStore(() => t), passSeconds: 180, now: () => t });
    key = newMachineKey();
  });
  const beat = async (m: string, ids: CheckId[], profile?: "laptop" | "server" | "ci", bad: string[] = []) =>
    core.heartbeat(await signPayload(key, buildPayload(m, ++seq, core.nonce(m).nonce, results(ids, bad), t, profile)));

  it("a server-profile machine gets a pass without the laptop-only checks", async () => {
    expect(core.enrol({ machine: "payouts-server", publicKey: publicKeyOf(key), profile: "server" }).profile).toBe("server");
    expect((await beat("payouts-server", SERVER, "server")).ok).toBe(true);
    const p = await core.pass("payouts-server");
    expect(p.live).toBe(true);
    expect(p.profile).toBe("server");
  });
  it("a laptop cannot claim server in a heartbeat to skip checks", async () => {
    core.enrol({ machine: "laptop-vikram", publicKey: publicKeyOf(key) });
    expect(await status(() => beat("laptop-vikram", SERVER, "server"))).toBe(400);
    // and without the profile field, skipped checks count as failing
    expect((await beat("laptop-vikram", SERVER)).ok).toBe(false);
    expect((await core.pass("laptop-vikram")).kind).toBe("unhealthy");
  });
  it("the profile cannot change after enrolment, and bad profiles are rejected", () => {
    core.enrol({ machine: "m", publicKey: publicKeyOf(key), profile: "laptop" });
    expect(() => core.enrol({ machine: "m", publicKey: publicKeyOf(key), profile: "server" })).toThrow(/profile laptop/);
    expect(() => core.enrol({ machine: "x", publicKey: publicKeyOf(key), profile: "root" })).toThrow(/profile must be/);
    expect(core.enrol({ machine: "m", publicKey: publicKeyOf(key) }).ok).toBe(true);
  });
});
