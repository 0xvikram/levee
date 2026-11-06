import { afterEach, describe, expect, it, vi } from "vitest";
import { FALLBACK_SHOWCASE, fetchShowcase, pickShowcase, type TopicMessage } from "../incident";

const O = { treasury: "0.0.11333495", payees: ["0.0.11333490", "0.0.11333492"], decimals: 6 };
const b64 = (v: unknown) => btoa(JSON.stringify(v));
const msg = (v: unknown, ts = "1793935185.725356463"): TopicMessage => ({ message: b64(v), consensus_timestamp: ts });

// Real messages from incidents topic 0.0.11333500 (sequence 1-3), newest first.
const FALSE_ALARM = {
  v: 1, type: "incident", incidentId: "0xb3", token: "0.0.11333594",
  breaches: [{ txId: "0.0.11333495-1793937268-268749224", to: "0.0.11333490", amount: "415191303", reason: "no-receipt" }],
  actions: [
    { step: "freezeAccount", account: "0.0.11333495", txId: "0.0.11333487-1793937272-760815553", ok: true, atMs: 4096 },
    { step: "wipeAndFreeze", account: "0.0.11333490", amount: "415191303", txId: "0.0.11333487-1793937275-861488712", ok: true, atMs: 6242 },
  ],
  detectedMs: 2021, containedMs: 6242,
};
const ATTACK = {
  v: 1, type: "incident", incidentId: "0x5f", token: "0.0.11333594",
  breaches: [{ txId: "0.0.11333495-1793935170-233904996", to: "0.0.11333494", amount: "10000000000", reason: "no-receipt" }],
  actions: [
    { step: "freezeAccount", account: "0.0.11333495", txId: "0.0.11333487-1793935173-898405003", ok: true, atMs: 6444 },
    { step: "wipeAndFreeze", account: "0.0.11333494", amount: "10000000000", txId: "0.0.11333487-1793935180-013412119", ok: true, atMs: 8309 },
  ],
  detectedMs: 4193, containedMs: 8309,
};
const FAILED_WIPE = {
  ...ATTACK, incidentId: "0x4c",
  actions: [ATTACK.actions[0], { step: "wipeAndFreeze", account: "0.0.11333494", amount: "10000000000", ok: false, atMs: 4189 }],
};

afterEach(() => vi.unstubAllGlobals());

describe("pickShowcase", () => {
  it("skips a false alarm on a payee and picks the newest genuine attack", () => {
    const s = pickShowcase([msg(FALSE_ALARM, "1793937283.5"), msg(ATTACK), msg(FAILED_WIPE, "1793934993.5")], O)!;
    expect(s.live).toBe(true);
    expect(s.attackTx).toBe("0.0.11333495-1793935170-233904996");
    expect([s.detectionS, s.treasuryFrozenS, s.wipedS]).toEqual([4.193, 6.444, 8.309]);
    expect(s.wipedS.toFixed(2)).toBe("8.31");
    expect(s.wipedAmount).toBe("10,000");
    expect(s.wipedValue).toBe(10000);
    expect(s.freezeTx).toBe("0.0.11333487-1793935173-898405003");
    expect(s.wipeTx).toBe("0.0.11333487-1793935180-013412119");
    expect(s.date).toBe("6 Nov 2026");
  });

  it("prefers a newer genuine attack over an older one", () => {
    const newer = { ...ATTACK, incidentId: "0x99", detectedMs: 3000, actions: [{ ...ATTACK.actions[0], atMs: 4000 }, { ...ATTACK.actions[1], atMs: 5500, amount: "250500000" }] };
    const s = pickShowcase([msg(newer, "1793990000.1"), msg(ATTACK)], O)!;
    expect(s.wipedS).toBe(5.5);
    expect(s.wipedAmount).toBe("250.5");
  });

  it("skips incidents with a failed step, and ignores non-incident messages", () => {
    expect(pickShowcase([{ message: btoa("not json"), consensus_timestamp: "1.0" }, msg(FAILED_WIPE)], O)).toBeNull();
  });

  it("needs the treasury freeze to count as a theft", () => {
    const noTreasury = { ...ATTACK, actions: [{ ...ATTACK.actions[0], account: "0.0.1" }, ATTACK.actions[1]] };
    expect(pickShowcase([msg(noTreasury)], O)).toBeNull();
  });
});

describe("fetchShowcase", () => {
  it("returns null (the page keeps the fallback) when the Mirror Node fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    expect(await fetchShowcase()).toBeNull();
    expect(FALLBACK_SHOWCASE.live).toBe(false);
    expect(FALLBACK_SHOWCASE.wipedValue).toBe(10000);
  });

  it("reads the incidents topic newest first", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ messages: [msg(FALSE_ALARM), msg(ATTACK)] })));
    vi.stubGlobal("fetch", f);
    const s = await fetchShowcase();
    expect(String((f.mock.calls[0] as unknown[])[0])).toMatch(/\/topics\/0\.0\.\d+\/messages\?order=desc&limit=25$/);
    expect(s?.attackTx).toBe("0.0.11333495-1793935170-233904996");
  });
});
