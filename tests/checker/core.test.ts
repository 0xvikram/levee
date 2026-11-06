import { describe, it, expect, beforeEach } from "vitest";
import { CheckerCore, HttpError } from "../../src/checker/core.js";
import { MemoryPassStore } from "../../src/shared/arkiv.js";
import { buildPayload, newMachineKey, publicKeyOf, signPayload } from "../../src/agent/protocol.js";
import { CHECK_IDS, type CheckResult } from "../../src/agent/checks.js";

const PASS = 180;
const results = (bad: string[] = []): CheckResult[] => CHECK_IDS.map((id) => ({ id, ok: !bad.includes(id), detail: "", evidenceHash: `h-${id}` }));

let t: number, store: MemoryPassStore, core: CheckerCore, key: ReturnType<typeof newMachineKey>, seq: number;

async function beat(bad: string[] = [], opts: { seq?: number; nonce?: string; k?: typeof key } = {}) {
  const nonce = opts.nonce ?? core.nonce("m1").nonce;
  const s = opts.seq ?? ++seq;
  const hb = await signPayload(opts.k ?? key, buildPayload("m1", s, nonce, results(bad), t));
  return { hb, res: await core.heartbeat(hb) };
}
const status = async (fn: () => Promise<unknown>) => fn().then(() => 200, (e) => (e instanceof HttpError ? e.status : 500));

beforeEach(() => {
  t = 1_700_000_000_000;
  seq = 0;
  store = new MemoryPassStore(() => t);
  core = new CheckerCore({ store, passSeconds: PASS, now: () => t });
  key = newMachineKey();
  core.enrol({ machine: "m1", publicKey: publicKeyOf(key), role: "employee" });
});

describe("enrol", () => {
  it("rejects a different key for an enrolled machine, bad names and bad keys", () => {
    expect(() => core.enrol({ machine: "m1", publicKey: publicKeyOf(newMachineKey()) })).toThrow(/already enrolled/);
    expect(() => core.enrol({ machine: "../x", publicKey: publicKeyOf(key) })).toThrow(/bad machine/);
    expect(() => core.enrol({ machine: "m2", publicKey: "0x1234" })).toThrow(/publicKey/);
  });
  it("enforces the enrol token when set", () => {
    const c = new CheckerCore({ store, passSeconds: PASS, enrolToken: "s3cret" });
    expect(() => c.enrol({ machine: "m2", publicKey: publicKeyOf(key) }, "nope")).toThrow(/token/);
    expect(c.enrol({ machine: "m2", publicKey: publicKeyOf(key) }, "s3cret").ok).toBe(true);
  });
});

describe("heartbeat verification", () => {
  it("a good heartbeat creates the pass; the gate sees it live", async () => {
    const { res } = await beat();
    expect(res).toMatchObject({ ok: true, renewed: true });
    const p = await core.pass("m1");
    expect(p).toMatchObject({ live: true, kind: "ok", reason: null });
    expect(p.arkivEntityKey).toMatch(/^0xmem/);
  });
  it("rejects a replayed heartbeat (nonce is single use)", async () => {
    const { hb } = await beat();
    expect(await status(() => core.heartbeat(hb))).toBe(400);
  });
  it("rejects an unknown or expired nonce", async () => {
    expect(await status(() => beat([], { nonce: "deadbeef" }))).toBe(400);
    const { nonce } = core.nonce("m1");
    t += 61_000;
    expect(await status(() => beat([], { nonce }))).toBe(400);
  });
  it("rejects a seq rollback or repeat", async () => {
    await beat([], { seq: 5 });
    expect(await status(() => beat([], { seq: 5 }))).toBe(409);
    expect(await status(() => beat([], { seq: 3 }))).toBe(409);
    expect(await status(() => beat([], { seq: 6 }))).toBe(200);
  });
  it("rejects a signature from another key", async () => {
    expect(await status(() => beat([], { k: newMachineKey() }))).toBe(401);
    expect(await store.getPass("m1")).toBeNull();
  });
  it("burns the nonce even when the signature is bad", async () => {
    const { nonce } = core.nonce("m1");
    expect(await status(() => beat([], { nonce, k: newMachineKey() }))).toBe(401);
    expect(await status(() => beat([], { nonce }))).toBe(400);
  });
  it("a nonce issued to one machine cannot be used by another", async () => {
    const k2 = newMachineKey();
    core.enrol({ machine: "m2", publicKey: publicKeyOf(k2) });
    const { nonce } = core.nonce("m2");
    expect(await status(() => beat([], { nonce }))).toBe(400);
  });
});

describe("failed checks", () => {
  it("do not renew, record the reason, and deny at once", async () => {
    await beat();
    t += 60_000;
    const { res } = await beat(["disk"]);
    expect(res).toMatchObject({ ok: false, renewed: false, reason: "check failed: disk" });
    const p = await core.pass("m1");
    expect(p).toMatchObject({ live: false, kind: "unhealthy", reason: "check failed: disk" });
    expect(await store.getPass("m1")).toBeNull(); // revoked on Arkiv too
  });
  it("a first heartbeat with a failing check never creates a pass", async () => {
    await beat(["ports", "persistence"]);
    expect(await store.listPasses()).toHaveLength(0);
    expect((await core.pass("m1")).reason).toBe("check failed: persistence, ports");
  });
  it("recovers when the machine is healthy again", async () => {
    await beat(["disk"]);
    await beat();
    expect((await core.pass("m1")).live).toBe(true);
  });
});

describe("pass logic (fails closed)", () => {
  it("unknown machine is not live", async () => expect(await core.pass("ghost")).toMatchObject({ live: false, kind: "unknown" }));
  it("pass lifetime is passSeconds from the last good heartbeat", async () => {
    await beat();
    expect((await core.pass("m1")).expiresAt).toBe(new Date(t + PASS * 1000).toISOString());
    t += 60_000;
    await beat();
    expect((await core.pass("m1")).expiresAt).toBe(new Date(t + PASS * 1000).toISOString());
  });
  it("expired pass is not live", async () => {
    await beat();
    t += PASS * 1000 + 1;
    expect(await core.pass("m1")).toMatchObject({ live: false, kind: "offline" });
  });
  it("wrong owner is not live", async () => {
    store.injectForeign({ machine: "m1", role: "employee", postureHash: "x", status: "live" }, "0xAttacker", 180);
    expect(await core.pass("m1")).toMatchObject({ live: false, reason: "pass entity is not owned by the checker wallet" });
  });
  it("stale Arkiv block => not live, even with a valid pass", async () => {
    await beat();
    store.blockAge = 25;
    expect(await core.pass("m1")).toMatchObject({ live: false, kind: "unverifiable" });
    store.blockAge = 9.9;
    expect((await core.pass("m1")).live).toBe(true);
    store.blockAge = 10;
    expect((await core.pass("m1")).live).toBe(false);
  });
  it("unreachable Arkiv => not live", async () => {
    await beat();
    store.blockAge = null;
    expect(await core.pass("m1")).toMatchObject({ live: false, kind: "unverifiable" });
    store.latestBlockAge = async () => {
      throw new Error("boom");
    };
    expect((await core.pass("m1")).live).toBe(false);
  });
  it("Arkiv write failure surfaces as 503 and does not mark the machine live", async () => {
    store.upsertPass = async () => {
      throw new Error("insufficient funds");
    };
    expect(await status(() => beat())).toBe(503);
    expect((await core.pass("m1")).live).toBe(false);
  });
});

describe("sleeping laptop", () => {
  it("no heartbeats for more than passSeconds => not live, and it is not a breach or an unhealthy flag", async () => {
    await beat();
    expect((await core.pass("m1")).live).toBe(true);
    t += (PASS + 30) * 1000; // lid closed
    const p = await core.pass("m1");
    expect(p.live).toBe(false);
    expect(p.kind).toBe("offline");
    expect(p.reason).toMatch(/offline or asleep, not a breach/);
    // waking up and sending a healthy heartbeat restores the pass with no manual step
    await beat();
    expect((await core.pass("m1")).live).toBe(true);
  });
});

describe("events", () => {
  it("emits heartbeat events", async () => {
    const seen: any[] = [];
    core.events.on("event", (e) => seen.push(e));
    await beat();
    await beat(["disk"]);
    expect(seen.map((e) => e.type + ":" + e.data.ok)).toEqual(["heartbeat:true", "heartbeat:false"]);
  });
});
