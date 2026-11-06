import { describe, expect, it } from "vitest";
import { dedupeTxs, startOfUtcDay, Watcher, type WatcherMirror } from "../../src/watcher/watcher.js";
import { controllerArgs } from "../../src/watcher/index.js";
import type { MirrorTransaction, TopicMessage } from "../../src/shared/mirror.js";
import type { ContainmentStep } from "../../src/watcher/contain.js";
import type { IncidentOut } from "../../src/shared/hcs.js";
import type { Receipt, Rules } from "../../src/shared/types.js";

const TOKEN = "0.0.5001";
const T = "0.0.6000";
const P = "0.0.5000";
const PAYEE = "0.0.6001";
const ATT = "0.0.6666";
const rules: Rules = { token: TOKEN, treasury: T, capPerTransfer: 10_000n, capPerDay: 50_000n, knownDestinations: [PAYEE] };

const xfer = (id: string, ts: string, to: string, amount: number): MirrorTransaction => ({
  consensus_timestamp: ts,
  transaction_id: id,
  name: "CRYPTOTRANSFER",
  result: "SUCCESS",
  nonce: 0,
  token_transfers: [
    { token_id: TOKEN, account: T, amount: -amount },
    { token_id: TOKEN, account: to, amount },
  ],
});
const receiptMsg = (seq: number, ts: string, r: Partial<Receipt>): TopicMessage => ({
  consensusAt: ts,
  sequence: seq,
  payer: "0.0.7000",
  text: JSON.stringify({ v: 1, type: "receipt", token: TOKEN, from: T, kind: "transfer", machine: "payouts-1", approvedAt: "2026-11-06T10:00:00Z", ...r }),
});

class FakeMirror implements WatcherMirror {
  txs: Record<string, MirrorTransaction[]> = { [T]: [], [P]: [] };
  msgs: TopicMessage[] = [];
  frozen = new Set<string>();
  balances = new Map<string, bigint>();
  blockTs = "1762400100.000000000";
  calls: string[] = [];
  async transactionsSince(account: string, since: string) {
    this.calls.push(`tx:${account}:${since}`);
    return (this.txs[account] ?? []).filter((t) => Number(t.consensus_timestamp) > Number(since));
  }
  async topicMessagesSince(_topic: string, after: number) {
    this.calls.push(`msgs:${after}`);
    return this.msgs.filter((m) => m.sequence > after);
  }
  async tokenRelationship(a: string) {
    return { balance: this.balances.get(a) ?? 0n, frozen: this.frozen.has(a) };
  }
  async tokenInfo() {
    return { token_id: TOKEN, symbol: "RUPC", name: "Rupee", decimals: 6, total_supply: "1", treasury_account_id: P, pause_status: "UNPAUSED" };
  }
  async latestBlockTimestamp() {
    return this.blockTs;
  }
}

function setup(pauseOnBreach = false) {
  const mirror = new FakeMirror();
  const steps: ContainmentStep[] = [];
  const published: IncidentOut[] = [];
  const events: string[] = [];
  let now = 1762400101_000;
  const w = new Watcher(
    { token: TOKEN, treasury: T, tokenTreasury: P, receiptsTopic: "0.0.9001", rules, pauseOnBreach },
    {
      mirror,
      call: async (s) => {
        steps.push(s);
        now += 700;
        return { txId: `0.0.7100-${steps.length}-000000000` };
      },
      publishIncident: async (i) => void published.push(i),
      emit: (e) => events.push(e),
      now: () => now,
    },
    "1762400000.000000000",
  );
  return { mirror, w, steps, published, events, setNow: (n: number) => (now = n) };
}

describe("Watcher.tick", () => {
  it("matches a receipted payout and contains nothing", async () => {
    const { mirror, w, steps } = setup();
    mirror.msgs.push(receiptMsg(1, "1762400005.000000000", { txId: "0.0.6000-1762400004-000000001", to: PAYEE, amount: "500" }));
    mirror.txs[T].push(xfer("0.0.6000-1762400004-000000001", "1762400010.000000000", PAYEE, 500));
    const r = await w.tick();
    expect(r.matched).toHaveLength(1);
    expect(r.breaches).toHaveLength(0);
    expect(steps).toHaveLength(0);
    expect(w.snapshot()).toMatchObject({ matched: 1, receipts: 1, receiptSeq: 1, healthy: false });
  });

  it("reads movements BEFORE receipts (so a receipt that preceded a seen movement is never missed)", async () => {
    const { mirror, w } = setup();
    await w.tick();
    expect(mirror.calls.findIndex((c) => c.startsWith("msgs"))).toBeGreaterThan(mirror.calls.findIndex((c) => c.startsWith("tx:")));
  });

  it("advances cursors so the same movement is not processed twice", async () => {
    const { mirror, w } = setup();
    mirror.msgs.push(receiptMsg(1, "1762400005.000000000", { txId: "0.0.6000-1762400004-000000001", to: PAYEE, amount: "500" }));
    mirror.txs[T].push(xfer("0.0.6000-1762400004-000000001", "1762400010.000000000", PAYEE, 500));
    await w.tick();
    const r2 = await w.tick();
    expect(r2.matched).toHaveLength(0);
    expect(r2.breaches).toHaveLength(0);
    expect(w.cursors[T]).toBe("1762400010.000000000");
    expect(mirror.calls.at(-1)).toBe("msgs:1");
  });

  it("an unreceipted drain: freeze treasury, wipe+freeze attacker, publish incident with timings", async () => {
    const { mirror, w, steps, published, events } = setup();
    mirror.balances.set(ATT, 90_000_000_000n);
    mirror.txs[T].push(xfer("0.0.6000-1762400099-000000001", "1762400100.000000000", ATT, 90_000_000_000));
    const r = await w.tick();
    expect(r.breaches[0]).toMatchObject({ reason: "no-receipt" });
    expect(steps.map((s) => [s.step, s.account, s.amount])).toEqual([
      ["freezeAccount", T, undefined],
      ["wipeAndFreeze", ATT, "90000000000"],
    ]);
    const inc = published[0];
    expect(inc.detectedMs).toBe(1000);
    expect(inc.actions.map((a) => a.atMs)).toEqual([1700, 2400]);
    expect(inc.containedMs).toBe(2400);
    expect(events).toEqual(expect.arrayContaining(["breach", "detected", "plan", "step", "incident"]));
  });

  it("a receipt that only appears after the movement does not excuse it (backdating)", async () => {
    const { mirror, w } = setup();
    mirror.txs[T].push(xfer("0.0.6000-1762400004-000000001", "1762400010.000000000", PAYEE, 500));
    mirror.msgs.push(receiptMsg(1, "1762400011.000000000", { txId: "0.0.6000-1762400004-000000001", to: PAYEE, amount: "500" }));
    const r = await w.tick();
    expect(r.breaches[0]).toMatchObject({ reason: "receipt-after-movement" });
  });

  it("the earliest receipt for a txId wins; a later duplicate with another amount is ignored", async () => {
    const { mirror, w } = setup();
    mirror.msgs.push(receiptMsg(1, "1762400005.000000000", { txId: "0.0.6000-1762400004-000000001", to: PAYEE, amount: "500" }));
    mirror.msgs.push(receiptMsg(2, "1762400006.000000000", { txId: "0.0.6000-1762400004-000000001", to: PAYEE, amount: "9000" }));
    mirror.txs[T].push(xfer("0.0.6000-1762400004-000000001", "1762400010.000000000", PAYEE, 9000));
    const r = await w.tick();
    expect(r.breaches[0]).toMatchObject({ reason: "receipt-mismatch" });
  });

  it("counts invalid receipt messages and keeps going", async () => {
    const { mirror, w } = setup();
    mirror.msgs.push({ consensusAt: "1762400001.0", sequence: 1, payer: "0.0.1", text: "not json" });
    mirror.msgs.push(receiptMsg(2, "1762400002.0", { txId: "bad", to: PAYEE, amount: "1" }));
    await w.tick();
    expect(w.invalidReceipts).toBe(2);
    expect(w.receiptSeq).toBe(2);
  });

  it("an unreceipted Studio cash-in seen on the token treasury: wipe+freeze the beneficiary, no treasury freeze", async () => {
    const { mirror, w, steps } = setup();
    const id = "0.0.6666-1762400095-000000042";
    mirror.balances.set(ATT, 80_000_000n);
    mirror.txs[P].push(
      { consensus_timestamp: "1762400100.000000005", transaction_id: id, name: "CONTRACTCALL", result: "SUCCESS", nonce: 0, token_transfers: [] },
      { consensus_timestamp: "1762400100.000000006", transaction_id: id, name: "TOKENMINT", result: "SUCCESS", nonce: 1, parent_consensus_timestamp: "1762400100.000000005", token_transfers: [{ token_id: TOKEN, account: P, amount: 80_000_000 }] },
      { consensus_timestamp: "1762400100.000000007", transaction_id: id, name: "CRYPTOTRANSFER", result: "SUCCESS", nonce: 2, parent_consensus_timestamp: "1762400100.000000005", token_transfers: [{ token_id: TOKEN, account: P, amount: -80_000_000 }, { token_id: TOKEN, account: ATT, amount: 80_000_000 }] },
    );
    await w.tick();
    expect(steps.map((s) => [s.step, s.account, s.amount])).toEqual([["wipeAndFreeze", ATT, "80000000"]]);
  });

  it("the same record seen via both watched accounts is processed once", async () => {
    const { mirror, w } = setup();
    const t = xfer("0.0.6000-1762400099-000000001", "1762400100.000000000", P, 10);
    mirror.txs[T].push(t);
    mirror.txs[P].push(t);
    const r = await w.tick();
    expect(r.breaches).toHaveLength(1);
  });

  it("treasury allowance is a breach that freezes the treasury", async () => {
    const { mirror, w, steps } = setup();
    mirror.txs[T].push({ consensus_timestamp: "1762400100.000000000", transaction_id: "0.0.6000-1762400099-000000001", name: "CRYPTOAPPROVEALLOWANCE", result: "SUCCESS", nonce: 0 });
    const r = await w.tick();
    expect(r.breaches[0].reason).toBe("treasury-allowance");
    expect(steps.map((s) => [s.step, s.account])).toEqual([["freezeAccount", T]]);
  });

  it("uses wipeFrozen for an already frozen attacker and pauses last when configured", async () => {
    const { mirror, w, steps } = setup(true);
    mirror.frozen.add(ATT);
    mirror.balances.set(ATT, 5000n);
    mirror.txs[T].push(xfer("0.0.6000-1762400099-000000001", "1762400100.000000000", ATT, 5000));
    await w.tick();
    expect(steps.map((s) => s.step)).toEqual(["freezeAccount", "wipeFrozen", "pauseToken"]);
  });

  it("prime mode rebuilds daily spend and reports breaches as historic without containing", async () => {
    const { mirror, w, steps } = setup();
    mirror.msgs.push(receiptMsg(1, "1762400005.000000000", { txId: "0.0.6000-1762400004-000000001", to: PAYEE, amount: "8000" }));
    mirror.txs[T].push(xfer("0.0.6000-1762400004-000000001", "1762400010.000000000", PAYEE, 8000));
    mirror.txs[T].push(xfer("0.0.6000-1762400019-000000001", "1762400020.000000000", ATT, 1));
    const r = await w.tick(false);
    expect(r.breaches).toHaveLength(1);
    expect(steps).toHaveLength(0);
    expect(w.breaches[0].historic).toBe(true);
    expect(w.match.spentByDay.get("2025-11-06") ?? [...w.match.spentByDay.values()][0]).toBe(8000n);
  });

  it("failed containment steps are recorded, not thrown", async () => {
    const { mirror, w, published } = setup();
    (w as unknown as { deps: { call: unknown } }).deps.call = async () => {
      throw new Error("INSUFFICIENT_GAS");
    };
    mirror.txs[T].push(xfer("0.0.6000-1762400099-000000001", "1762400100.000000000", ATT, 5));
    await w.tick();
    expect(published[0].actions.every((a) => !a.ok)).toBe(true);
  });
});

describe("Watcher health (fail closed)", () => {
  it("healthy only after a good tick with low lag; unhealthy when lag > 20 s or ticks stall", async () => {
    const { mirror, w, setNow } = setup();
    expect(w.healthy()).toBe(false);
    await w.measureLag();
    await w.tick();
    expect(w.lagMs).toBe(1000);
    expect(w.healthy()).toBe(true);
    mirror.blockTs = "1762400070.000000000";
    await w.measureLag();
    expect(w.healthy()).toBe(false);
    mirror.blockTs = "1762400100.000000000";
    await w.measureLag();
    expect(w.healthy()).toBe(true);
    setNow(1762400101_000 + 25_000);
    expect(w.healthy()).toBe(false);
  });

  it("no block from the mirror means infinite lag", async () => {
    const { mirror, w } = setup();
    mirror.latestBlockTimestamp = async () => null as unknown as string;
    await w.measureLag();
    expect(w.lagMs).toBe(Number.POSITIVE_INFINITY);
    expect(w.snapshot().lagMs).toBeNull();
  });

  it("a failing mirror leaves cursors untouched and records the error", async () => {
    const { mirror, w } = setup();
    mirror.topicMessagesSince = async () => {
      throw new Error("mirror 503");
    };
    mirror.txs[T].push(xfer("0.0.6000-1762400099-000000001", "1762400100.000000000", ATT, 5));
    await expect(w.tick()).rejects.toThrow("503");
    expect(w.cursors[T]).toBe("1762400000.000000000");
    expect(w.lastError).toBe("mirror 503");
  });
});

describe("helpers", () => {
  it("dedupeTxs keeps parent and children apart by nonce", () => {
    const a = { consensus_timestamp: "1.1", transaction_id: "x", name: "A", result: "SUCCESS", nonce: 0 };
    expect(dedupeTxs([a, a, { ...a, nonce: 1, consensus_timestamp: "1.2" }])).toHaveLength(2);
  });
  it("startOfUtcDay", () => {
    expect(startOfUtcDay(Date.UTC(2026, 10, 6, 15, 30))).toBe(`${Date.UTC(2026, 10, 6) / 1000}.000000000`);
  });
  it("controllerArgs encodes each step with the right function and arguments", () => {
    const id = "0x" + "11".repeat(32);
    const enc = (s: ContainmentStep) => {
      const { fn, params } = controllerArgs(s, id);
      return { fn, hex: Buffer.from(params._build(fn)).toString("hex") };
    };
    const w = enc({ step: "wipeAndFreeze", account: "0.0.6666", amount: "90000000000", why: "" });
    expect(w.fn).toBe("wipeAndFreeze");
    expect(w.hex).toContain("0000000000000000000000000000000000001a0a"); // 0.0.6666 long-zero
    expect(w.hex).toContain((90000000000).toString(16).padStart(64, "0"));
    expect(w.hex.endsWith("11".repeat(32))).toBe(true);
    expect(enc({ step: "freezeAccount", account: "0.0.6000", why: "" }).fn).toBe("freezeAccount");
    expect(enc({ step: "burnSupply", amount: "5", why: "" }).hex.length).toBe(8 + 128);
    expect(enc({ step: "pauseToken", why: "" }).hex.length).toBe(8 + 64);
    expect(enc({ step: "wipeFrozen", account: "0.0.1", amount: "1", why: "" }).fn).toBe("wipeFrozen");
  });
});
