import { describe, expect, it } from "vitest";
import { allowedRolesFromEnv, parseSignedFields, ReplayCache, RequestAuthenticator, staticDirectory, type MachineDirectory } from "../../src/gate/auth.js";
import { newMachineKey, publicKeyOf } from "../../src/agent/protocol.js";
import { requestMessage, signRequestWithKey, verifyRequestSignature } from "../../src/agent/request.js";
import { parseRequest } from "../../src/gate/decide.js";

const key = newMachineKey();
const otherKey = newMachineKey();
const NOW = 1_800_000_000_000;
const dir = staticDirectory([
  { machine: "payouts-server", publicKey: publicKeyOf(key), role: "payouts" },
  { machine: "laptop-vikram", publicKey: publicKeyOf(otherKey), role: "employee" },
  { machine: "fin-1", publicKey: publicKeyOf(otherKey), role: "finance" },
]);

/** Runs a raw body through the gate's parse + auth, as server.ts does. */
async function check(body: Record<string, unknown>, auth = new RequestAuthenticator(dir), now = NOW) {
  const p = parseRequest(body);
  if (!p.ok) throw new Error(p.detail);
  return auth.check(p.value, body, now);
}
const sign = (k = key, machine = "payouts-server", r: { to?: string; amount?: string | number; kind?: "transfer" | "mint" } = {}, sentAt = NOW) =>
  signRequestWithKey(k, machine, { to: r.to ?? "0.0.7001", amount: r.amount ?? "500000000", kind: r.kind }, { sentAt });

describe("signed request", () => {
  it("signs exactly {machine,to,amount,kind,nonce,sentAt} and verifies against the enrolled key", async () => {
    const b = await sign();
    expect(Object.keys(b).sort()).toEqual(["amount", "kind", "machine", "nonce", "sentAt", "signature", "to"]);
    expect(b.kind).toBe("transfer");
    expect(requestMessage(b)).toBe(`{"amount":"500000000","kind":"transfer","machine":"payouts-server","nonce":"${b.nonce}","sentAt":${NOW},"to":"0.0.7001"}`);
    expect(await verifyRequestSignature(publicKeyOf(key), b, b.signature)).toBe(true);
    expect(await verifyRequestSignature(publicKeyOf(otherKey), b, b.signature)).toBe(false);
    expect(await verifyRequestSignature(publicKeyOf(key), b, "0xdeadbeef")).toBe(false);
  });

  it("good: accepted, returns the enrolled record", async () => {
    const r = await check(await sign());
    expect(r).toMatchObject({ ok: true, machine: { machine: "payouts-server", role: "payouts" } });
  });

  it("a numeric amount signs and verifies the same as its string form", async () => {
    const b = await sign(key, "payouts-server", { amount: 500 });
    expect(b.amount).toBe("500");
    expect((await check({ ...b, amount: 500 })).ok).toBe(true);
  });

  it("tampered amount, destination or kind: bad-signature", async () => {
    const b = await sign();
    expect(await check({ ...b, amount: "900000000" })).toMatchObject({ ok: false, reason: "bad-signature" });
    expect(await check({ ...b, to: "0.0.6666" })).toMatchObject({ ok: false, reason: "bad-signature" });
    expect(await check({ ...b, kind: "mint" })).toMatchObject({ ok: false, reason: "bad-signature" });
    expect(await check({ ...b, sentAt: NOW + 1 })).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  it("wrong key (another machine's key claiming payouts-server): bad-signature", async () => {
    expect(await check(await sign(otherKey))).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  it("stale or future sentAt beyond 60 s: stale-request; within 60 s ok", async () => {
    expect(await check(await sign(key, "payouts-server", {}, NOW - 61_000))).toMatchObject({ ok: false, reason: "stale-request" });
    expect(await check(await sign(key, "payouts-server", {}, NOW + 61_000))).toMatchObject({ ok: false, reason: "stale-request" });
    expect((await check(await sign(key, "payouts-server", {}, NOW - 59_000))).ok).toBe(true);
  });

  it("replay of the same body: replayed-request (and a stale replay is still refused)", async () => {
    const auth = new RequestAuthenticator(dir);
    const b = await sign();
    expect((await check(b, auth)).ok).toBe(true);
    expect(await check(b, auth, NOW + 1000)).toMatchObject({ ok: false, reason: "replayed-request" });
    expect(await check(b, auth, NOW + 120_000)).toMatchObject({ ok: false, reason: "stale-request" });
  });

  it("a bad signature does not burn the nonce", async () => {
    const auth = new RequestAuthenticator(dir);
    const b = await sign();
    expect(await check({ ...b, amount: "1" }, auth)).toMatchObject({ reason: "bad-signature" });
    expect((await check(b, auth)).ok).toBe(true);
  });

  it("unknown machine: unknown-machine; checker unreachable fails closed as unknown-machine", async () => {
    expect(await check(await sign(key, "ghost"))).toMatchObject({ ok: false, reason: "unknown-machine" });
    const down: MachineDirectory = { lookup: async () => Promise.reject(new Error("ECONNREFUSED")) };
    const r = await check(await sign(), new RequestAuthenticator(down));
    expect(r).toMatchObject({ ok: false, reason: "unknown-machine" });
    expect(!r.ok && r.detail).toMatch(/failing closed/);
  });

  it("missing or malformed signature fields (unsigned): bad-signature", async () => {
    const b = await sign();
    const { signature: _s, ...unsigned } = b;
    expect(await check(unsigned)).toMatchObject({ ok: false, reason: "bad-signature" });
    expect(await check({ ...b, nonce: "x" })).toMatchObject({ ok: false, reason: "bad-signature" });
    expect(await check({ ...b, sentAt: "now" })).toMatchObject({ ok: false, reason: "bad-signature" });
    expect(parseSignedFields(b).ok).toBe(true);
  });
});

describe("role check", () => {
  it("default allows finance and payouts; employee laptop is wrong-role", async () => {
    expect(await check(await sign(otherKey, "laptop-vikram"))).toMatchObject({ ok: false, reason: "wrong-role" });
    expect((await check(await sign(otherKey, "fin-1"))).ok).toBe(true);
  });
  it("GATE_ALLOWED_ROLES narrows the set", async () => {
    expect(allowedRolesFromEnv(undefined)).toEqual(["finance", "payouts"]);
    expect(allowedRolesFromEnv(" ")).toEqual(["finance", "payouts"]);
    expect(allowedRolesFromEnv("payouts, treasury")).toEqual(["payouts", "treasury"]);
    const auth = new RequestAuthenticator(dir, allowedRolesFromEnv("treasury"));
    expect(await check(await sign(), auth)).toMatchObject({ ok: false, reason: "wrong-role" });
  });
});

describe("ReplayCache", () => {
  it("forgets entries after the ttl and stays bounded", () => {
    const c = new ReplayCache(1000, 3);
    expect(c.remember("a", 0)).toBe(true);
    expect(c.remember("a", 500)).toBe(false);
    expect(c.remember("a", 1500)).toBe(true); // expired, so new again (the freshness check refuses it first in practice)
    for (const k of ["b", "c", "d", "e"]) c.remember(k, 1600);
    expect(c.size).toBe(3);
  });
});
