import { describe, expect, it } from "vitest";
import { planReset, targetsFrom, type MirrorLike } from "./reset.js";

const state = {
  treasury: { id: "0.0.11333495", evm: "0x00000000000000000000000000000000000acef77" },
  attacker: { id: "0.0.11333494", evm: "0x11181c7d3b796e03deea91c090cea106364a93de" },
  payees: [
    { id: "0.0.11333490", evm: "0x9d" },
    { id: "0.0.11333492", evm: "0xdc" },
  ],
};

function fake(freeze: Record<string, string | null>, pause = "UNPAUSED"): MirrorLike & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    freeze: async (id) => {
      asked.push(id);
      return freeze[id] ?? null;
    },
    pause: async () => pause,
  };
}

describe("demo reset plan", () => {
  it("looks at treasury, attacker and both payees", () => {
    expect(targetsFrom(state).map((t) => `${t.name}:${t.id}`)).toEqual([
      "treasury:0.0.11333495",
      "attacker:0.0.11333494",
      "payee0:0.0.11333490",
      "payee1:0.0.11333492",
    ]);
    expect(targetsFrom({ treasury: { id: "bad" }, payees: [] })).toEqual([]);
  });

  it("reopens only FROZEN accounts", async () => {
    const m = fake({ "0.0.11333495": "UNFROZEN", "0.0.11333494": "FROZEN", "0.0.11333490": "UNFROZEN", "0.0.11333492": "FROZEN" });
    const p = await planReset(targetsFrom(state), m);
    expect(p.reopen.map((t) => t.name)).toEqual(["attacker", "payee1"]);
    expect(p.unpause).toBe(false);
    expect(m.asked).toEqual(["0.0.11333495", "0.0.11333494", "0.0.11333490", "0.0.11333492"]);
  });

  it("is a no-op when nothing is frozen or paused (and not-associated is not frozen)", async () => {
    const p = await planReset(targetsFrom(state), fake({ "0.0.11333495": "UNFROZEN", "0.0.11333494": "UNFROZEN", "0.0.11333490": "NOT_APPLICABLE" }));
    expect(p.reopen).toEqual([]);
    expect(p.unpause).toBe(false);
    expect(p.statuses.payee1).toBe("NOT_ASSOCIATED");
  });

  it("unpauses when the token is PAUSED", async () => {
    const p = await planReset(targetsFrom(state), fake({ "0.0.11333495": "FROZEN" }, "PAUSED"));
    expect(p.unpause).toBe(true);
    expect(p.reopen.map((t) => t.name)).toEqual(["treasury"]);
  });
});
