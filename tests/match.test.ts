import { describe, expect, it } from "vitest";
import { matchMovements, newMatchState } from "../src/watcher/match.js";
import { normaliseTxId, compareConsensus } from "../src/shared/txid.js";
import type { Movement, Receipt, Rules } from "../src/shared/types.js";

const rules: Rules = {
  token: "0.0.100",
  treasury: "0.0.200",
  capPerTransfer: 10_000n,
  capPerDay: 15_000n,
  knownDestinations: ["0.0.301", "0.0.302"],
};

function mv(over: Partial<Movement> = {}): Movement {
  return {
    txId: "0.0.200-1762400000-000000001",
    consensusAt: "1762400010.000000000",
    token: "0.0.100",
    from: "0.0.200",
    to: "0.0.301",
    amount: "500",
    kind: "transfer",
    ...over,
  };
}

function rc(over: Partial<Receipt> = {}): Receipt {
  return {
    v: 1,
    type: "receipt",
    txId: "0.0.200-1762400000-000000001",
    token: "0.0.100",
    from: "0.0.200",
    to: "0.0.301",
    amount: "500",
    kind: "transfer",
    machine: "server-payouts-1",
    approvedAt: "2026-11-06T10:00:00Z",
    consensusAt: "1762400005.000000000",
    ...over,
  };
}

const run = (ms: Movement[], rs: Receipt[], state = newMatchState()) =>
  matchMovements(ms, new Map(rs.map((r) => [r.txId, r])), rules, state);

describe("matchMovements", () => {
  it("accepts a movement with an earlier, identical receipt", () => {
    const res = run([mv()], [rc()]);
    expect(res.matched).toHaveLength(1);
    expect(res.breaches).toHaveLength(0);
  });

  it("flags a movement with no receipt (stolen key bypassing the gate)", () => {
    const res = run([mv({ txId: "0.0.200-1762400099-000000000", amount: "1000000" })], [rc()]);
    expect(res.breaches[0].reason).toBe("no-receipt");
  });

  it("flags a receipt written after the movement (backdating)", () => {
    const res = run([mv()], [rc({ consensusAt: "1762400011.000000000" })]);
    expect(res.breaches[0].reason).toBe("receipt-after-movement");
  });

  it("flags a receipt whose amount does not match", () => {
    const res = run([mv({ amount: "9000" })], [rc({ amount: "500" })]);
    expect(res.breaches[0].reason).toBe("receipt-mismatch");
  });

  it("flags reuse of a receipt", () => {
    const state = newMatchState();
    run([mv()], [rc()], state);
    const res = run([mv()], [rc()], state);
    expect(res.breaches[0].reason).toBe("receipt-reused");
  });

  it("flags a receipt over the per-transfer cap even if genuine (stolen gate key)", () => {
    const res = run([mv({ amount: "20000" })], [rc({ amount: "20000" })]);
    expect(res.breaches[0].reason).toBe("over-transfer-cap");
  });

  it("flags a receipt to an unknown destination", () => {
    const res = run([mv({ to: "0.0.999" })], [rc({ to: "0.0.999" })]);
    expect(res.breaches[0].reason).toBe("unknown-destination");
  });

  it("flags when the daily cap is exceeded across transfers", () => {
    const a = { txId: "0.0.200-1762400000-000000001" };
    const b = { txId: "0.0.200-1762400000-000000002", consensusAt: "1762400020.000000000" };
    const res = run(
      [mv({ ...a, amount: "9000" }), mv({ ...b, amount: "9000" })],
      [rc({ ...a, amount: "9000" }), rc({ ...b, amount: "9000", consensusAt: "1762400015.000000000" })],
    );
    expect(res.matched).toHaveLength(1);
    expect(res.breaches[0].reason).toBe("over-daily-cap");
  });

  it("treats an unreceipted mint as a breach", () => {
    const res = run([mv({ kind: "mint", from: null, to: "0.0.666", amount: "80000000" })], []);
    expect(res.breaches[0].reason).toBe("no-receipt");
  });
});

describe("txid helpers", () => {
  it("normalises SDK transaction IDs to Mirror form", () => {
    expect(normaliseTxId("0.0.1234@1700000000.000000001")).toBe("0.0.1234-1700000000-000000001");
    expect(normaliseTxId("0.0.1234@1700000000.5")).toBe("0.0.1234-1700000000-000000005");
  });
  it("orders consensus timestamps", () => {
    expect(compareConsensus("10.000000001", "10.000000002")).toBe(-1);
    expect(compareConsensus("11.0", "10.999999999")).toBe(1);
  });
});
