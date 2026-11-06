import { describe, it, expect } from "vitest";
import { canonicalJson, buildPayload, newMachineKey, publicKeyOf, signPayload, verifySigned, failingChecks } from "../../src/agent/protocol.js";
import { CHECK_IDS, type CheckResult } from "../../src/agent/checks.js";
import { applySimulation } from "../../src/agent/index.js";

const results = (bad: string[] = []): CheckResult[] => CHECK_IDS.map((id) => ({ id, ok: !bad.includes(id), detail: "", evidenceHash: `h-${id}` }));

describe("canonical json + signatures", () => {
  it("sorts keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
  it("round-trips", async () => {
    const k = newMachineKey();
    const hb = await signPayload(k, buildPayload("m1", 1, "nonce", results(), 1000));
    expect(await verifySigned(publicKeyOf(k), hb)).toBe(true);
  });
  it("rejects tampering and a different key", async () => {
    const k = newMachineKey();
    const hb = await signPayload(k, buildPayload("m1", 1, "nonce", results(["disk"]), 1000));
    const forged = { ...hb, payload: { ...hb.payload, checks: { ...hb.payload.checks, disk: "ok" as const } } };
    expect(await verifySigned(publicKeyOf(k), forged)).toBe(false);
    expect(await verifySigned(publicKeyOf(newMachineKey()), hb)).toBe(false);
  });
  it("reports failing checks, treating missing as failing", () => {
    expect(failingChecks(buildPayload("m", 1, "n", results(["ports"])).checks)).toEqual(["ports"]);
    expect(failingChecks({ persistence: "ok" })).toHaveLength(6);
  });
  it("simulate-fail flips one check", () => {
    const r = applySimulation(results(), "ports");
    expect(r.filter((x) => !x.ok).map((x) => x.id)).toEqual(["ports"]);
    expect(applySimulation(results(), null).every((x) => x.ok)).toBe(true);
  });
});
