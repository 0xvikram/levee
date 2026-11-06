import { describe, it, expect } from "vitest";
import { MemoryPassStore } from "../../src/shared/arkiv.js";

const input = { machine: "m1", role: "employee", postureHash: "p1", status: "live" as const };

describe("MemoryPassStore", () => {
  it("creates, reads, lists", async () => {
    let t = 1_000_000;
    const s = new MemoryPassStore(() => t);
    const rec = await s.upsertPass(input, 180);
    expect(rec.expiresAtMs).toBe(t + 180_000);
    expect(rec.owner).toBe(s.checkerAddress);
    expect((await s.getPass("m1"))?.entityKey).toBe(rec.entityKey);
    expect(await s.listPasses()).toHaveLength(1);
  });
  it("expires and then forgets", async () => {
    let t = 0;
    const s = new MemoryPassStore(() => t);
    await s.upsertPass(input, 180);
    t = 179_000;
    expect(await s.getPass("m1")).not.toBeNull();
    t = 181_000;
    expect(await s.getPass("m1")).toBeNull();
    expect(await s.extendPass("m1", 180)).toBeNull(); // an expired pass cannot be revived by extend
  });
  it("upsert keeps the same entity and extends; patches attributes", async () => {
    let t = 0;
    const s = new MemoryPassStore(() => t);
    const a = await s.upsertPass(input, 180);
    t = 60_000;
    const b = await s.upsertPass({ ...input, postureHash: "p2" }, 180);
    expect(b.entityKey).toBe(a.entityKey);
    expect(b.postureHash).toBe("p2");
    expect(b.expiresAtMs).toBe(240_000);
  });
  it("never shortens expiry", async () => {
    const s = new MemoryPassStore(() => 0);
    await s.upsertPass(input, 180);
    expect((await s.extendPass("m1", 10))?.expiresAtMs).toBe(180_000);
  });
  it("revoke deletes", async () => {
    const s = new MemoryPassStore(() => 0);
    await s.upsertPass(input, 180);
    expect(await s.revokePass("m1")).toBe(true);
    expect(await s.getPass("m1")).toBeNull();
    expect(await s.revokePass("m1")).toBe(false);
  });
});
