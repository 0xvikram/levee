import { describe, expect, it } from "vitest";
import {
  buildIncident,
  executeContainment,
  firstBreachAt,
  incidentIdFor,
  planContainment,
  type ContainmentState,
  type WatcherBreach,
} from "../../src/watcher/contain.js";
import type { Movement } from "../../src/shared/types.js";
import { validateIncident } from "../../src/shared/hcs.js";

const T = "0.0.6000"; // company treasury
const P = "0.0.5000"; // token treasury (Studio proxy)
const A = "0.0.6666";
const B = "0.0.6667";

const mv = (o: Partial<Movement>): Movement => ({
  txId: "0.0.6000-1762400000-000000001",
  consensusAt: "1762400010.000000000",
  token: "0.0.5001",
  from: T,
  to: A,
  amount: "1000",
  kind: "transfer",
  ...o,
});
const br = (o: Partial<Movement>, reason: WatcherBreach["reason"] = "no-receipt"): WatcherBreach =>
  reason === "treasury-allowance"
    ? { reason, allowance: { txId: "0.0.6000-1-000000001", consensusAt: "1762400005.000000000", owner: T, name: "CRYPTOAPPROVEALLOWANCE" } }
    : ({ reason, movement: mv(o) } as WatcherBreach);
const st = (o: Partial<ContainmentState> = {}): ContainmentState => ({ treasury: T, tokenTreasury: P, frozen: new Set(), pauseOnBreach: false, ...o });

describe("planContainment", () => {
  it("does nothing without breaches", () => {
    expect(planContainment([], st({ pauseOnBreach: true }))).toEqual([]);
  });

  it("treasury outflow: freeze treasury first, then wipe+freeze the receiver with the exact amount", () => {
    const steps = planContainment([br({ amount: "90000000000" })], st());
    expect(steps.map((s) => [s.step, s.account, s.amount])).toEqual([
      ["freezeAccount", T, undefined],
      ["wipeAndFreeze", A, "90000000000"],
    ]);
  });

  it("does not re-freeze an already frozen treasury", () => {
    const steps = planContainment([br({})], st({ frozen: new Set([T]) }));
    expect(steps.map((s) => s.step)).toEqual(["wipeAndFreeze"]);
  });

  it("unauthorised mint to an attacker: no treasury freeze, wipe+freeze the receiver", () => {
    const steps = planContainment([br({ kind: "mint", from: null, amount: "80000000" })], st());
    expect(steps.map((s) => [s.step, s.account, s.amount])).toEqual([["wipeAndFreeze", A, "80000000"]]);
  });

  it("unauthorised mint still in the token treasury: burn it", () => {
    const steps = planContainment([br({ kind: "mint", from: null, to: P, amount: "5000" })], st());
    expect(steps.map((s) => [s.step, s.amount])).toEqual([["burnSupply", "5000"]]);
  });

  it("burn is capped to what the token treasury still holds, and skipped at zero", () => {
    expect(planContainment([br({ kind: "mint", from: null, to: P, amount: "5000" })], st({ balances: new Map([[P, 3000n]]) }))[0].amount).toBe("3000");
    expect(planContainment([br({ kind: "mint", from: null, to: P, amount: "5000" })], st({ balances: new Map([[P, 0n]]) }))).toEqual([]);
  });

  it("already-frozen receiver uses wipeFrozen", () => {
    const steps = planContainment([br({})], st({ frozen: new Set([A]) }));
    expect(steps.map((s) => [s.step, s.account])).toEqual([
      ["freezeAccount", T],
      ["wipeFrozen", A],
    ]);
  });

  it("several attacker accounts in one incident: one wipe each, amounts summed per account, biggest first", () => {
    const steps = planContainment(
      [
        br({ txId: "x-1-000000001", to: A, amount: "100" }),
        br({ txId: "x-1-000000002", to: B, amount: "900" }),
        br({ txId: "x-1-000000003", to: A, amount: "50" }),
      ],
      st(),
    );
    expect(steps.map((s) => [s.step, s.account, s.amount])).toEqual([
      ["freezeAccount", T, undefined],
      ["wipeAndFreeze", B, "900"],
      ["wipeAndFreeze", A, "150"],
    ]);
  });

  it("caps a wipe to the receiver's balance when part has moved on, and only freezes when nothing is left", () => {
    const steps = planContainment([br({ to: A, amount: "1000" }), br({ txId: "y-1-000000001", to: B, amount: "500" })], st({ balances: new Map([[A, 400n], [B, 0n]]) }));
    expect(steps.map((s) => [s.step, s.account, s.amount])).toEqual([
      ["freezeAccount", T, undefined],
      ["wipeAndFreeze", A, "400"],
      ["freezeAccount", B, undefined],
    ]);
  });

  it("pause only when configured, always last, and not if already paused", () => {
    const b = [br({}), br({ txId: "z-1-000000001", kind: "mint", from: null, to: P, amount: "7" })];
    expect(planContainment(b, st()).some((s) => s.step === "pauseToken")).toBe(false);
    const withPause = planContainment(b, st({ pauseOnBreach: true }));
    expect(withPause.map((s) => s.step)).toEqual(["freezeAccount", "wipeAndFreeze", "burnSupply", "pauseToken"]);
    expect(planContainment(b, st({ pauseOnBreach: true, paused: true })).some((s) => s.step === "pauseToken")).toBe(false);
  });

  it("treasury allowance alone: freeze the treasury", () => {
    expect(planContainment([br({}, "treasury-allowance")], st()).map((s) => [s.step, s.account])).toEqual([["freezeAccount", T]]);
  });

  it("an outflow from the treasury to the token treasury is never wiped (HTS forbids it)", () => {
    const steps = planContainment([br({ to: P })], st());
    expect(steps.map((s) => s.step)).toEqual(["freezeAccount"]);
  });

  it("does not mutate the input frozen set", () => {
    const frozen = new Set<string>();
    planContainment([br({})], st({ frozen }));
    expect(frozen.size).toBe(0);
  });
});

describe("incident ids and execution", () => {
  it("incidentId is a deterministic bytes32 independent of breach order", () => {
    const a = br({ txId: "a-1-000000001" });
    const b = br({ txId: "b-1-000000001" });
    const id = incidentIdFor([a, b]);
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(incidentIdFor([b, a])).toBe(id);
    expect(incidentIdFor([a])).not.toBe(id);
  });

  it("firstBreachAt picks the earliest consensus time", () => {
    expect(firstBreachAt([br({ consensusAt: "20.0" }), br({ consensusAt: "10.5" })])).toBe("10.5");
  });

  it("executes in order, records tx ids and ms since the breach, keeps going after a failure", async () => {
    const steps = planContainment([br({ consensusAt: "1762400010.000000000" })], st({ pauseOnBreach: true }));
    const order: string[] = [];
    let clock = 1762400010_000 + 1500;
    const res = await executeContainment(
      steps,
      "0x" + "ab".repeat(32),
      "1762400010.000000000",
      async (s) => {
        order.push(s.step);
        clock += 1000;
        if (s.step === "wipeAndFreeze") throw new Error("CONTRACT_REVERT_EXECUTED");
        return { txId: `0.0.7-${order.length}-000000000` };
      },
      () => clock,
    );
    expect(order).toEqual(["freezeAccount", "wipeAndFreeze", "pauseToken"]);
    expect(res.map((r) => [r.ok, r.atMs])).toEqual([
      [true, 2500],
      [false, 3500],
      [true, 4500],
    ]);
    expect(res[1].error).toContain("REVERT");
    expect(res[0].txId).toBe("0.0.7-1-000000000");
  });

  it("buildIncident produces a valid Incident with detection and containment times", async () => {
    const b = [br({ consensusAt: "1762400010.000000000", amount: "77" }), br({}, "treasury-allowance")];
    const id = incidentIdFor(b);
    const results = [
      { step: "freezeAccount" as const, account: T, txId: "0.0.7-1-000000000", ok: true, atMs: 1200 },
      { step: "wipeAndFreeze" as const, account: A, amount: "77", txId: "0.0.7-2-000000000", ok: true, atMs: 2900 },
    ];
    const inc = buildIncident({ incidentId: id, token: "0.0.5001", breaches: b, results, detectedAtMs: 1762400005_000 + 800 });
    expect(inc.detectedMs).toBe(800); // allowance at ...005 is the earliest
    expect(inc.containedMs).toBe(2900);
    expect(inc.breaches[1]).toEqual({ txId: "0.0.6000-1-000000001", to: T, amount: "0", reason: "treasury-allowance" });
    expect(validateIncident(inc).ok).toBe(true);
  });
});
