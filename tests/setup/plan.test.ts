import { describe, expect, it } from "vitest";
import { encodeFunctionData } from "viem";
import {
  ACCOUNT_PLAN,
  CONTROLLER_ROLES,
  STUDIO_ROLES,
  estimateAccounts,
  estimateController,
  estimateToken,
  estimateTopics,
  gasHbar,
  hashscanTx,
  median,
  missingSteps,
  replaceSection,
  shortfall,
  sumCost,
  toUnits,
} from "../../src/setup/plan.js";
import { buildDeployRequest } from "../../src/setup/deploy-request.js";
import { studioFactoryAbi } from "../../src/setup/studio.js";

describe("role ids", () => {
  it("match the Stablecoin Studio v4 SDK constants (StableCoinRole)", () => {
    expect(STUDIO_ROLES.FREEZE).toBe("0x5789b43a60de35bcedee40618ae90979bab7d1315fd4b079234241bdab19936d");
    expect(STUDIO_ROLES.WIPE).toBe("0x515f99f4e5a381c770462a8d9879a01f0fd4a414a168a2404dab62a62e1af0c3");
    expect(STUDIO_ROLES.BURN).toBe("0xe97b137254058bd94f28d2f3eb79e2d34074ffb488d042e3bc958e0a57d2fa22");
    expect(STUDIO_ROLES.PAUSE).toBe("0x139c2898040ef16910dc9f44dc697df79363da767d8bc92f2e310312b816e46d");
    expect(STUDIO_ROLES.CASHIN).toBe("0x53300d27a2268d3ff3ecb0ec8e628321ecfba1a08aed8b817e8acf589a52d25c");
    expect(STUDIO_ROLES.DEFAULT_ADMIN).toBe("0x" + "0".repeat(64));
    expect(new Set(Object.values(STUDIO_ROLES)).size).toBe(Object.keys(STUDIO_ROLES).length);
  });
  it("controller never gets admin or cash-in", () => {
    expect(CONTROLLER_ROLES).toEqual(["FREEZE", "WIPE", "BURN", "PAUSE"]);
  });
});

describe("cost estimates", () => {
  it("accounts: creates plus optional funding", () => {
    const all = ACCOUNT_PLAN.map((p) => p.role);
    const withFunding = sumCost(estimateAccounts(all, true));
    const createOnly = sumCost(estimateAccounts(all, false));
    expect(createOnly).toBeCloseTo(9 * 0.8, 5);
    expect(withFunding - createOnly).toBeCloseTo(5, 5);
    expect(estimateAccounts([], true)).toEqual([]);
  });
  it("topics, token, controller", () => {
    expect(sumCost(estimateTopics(3))).toBeCloseTo(1.35, 5);
    expect(estimateTopics(0)).toEqual([]);
    expect(sumCost(estimateToken({ create: false, associations: 0, cashIn: false }))).toBe(0);
    expect(sumCost(estimateToken({ create: true, associations: 4, cashIn: true }))).toBeGreaterThan(18);
    expect(sumCost(estimateController({ deploy: true, grants: 5 }))).toBeLessThan(3);
  });
  it("gas pricing and shortfall", () => {
    expect(gasHbar(1_000_000)).toBeCloseTo(1.3, 5);
    expect(shortfall(10, 5)).toBe(0);
    expect(shortfall(10, 12)).toBe(2.5);
    expect(shortfall(1, 1, 0)).toBe(0);
  });
});

describe("state completeness", () => {
  const acct = (n: number) => ({ id: `0.0.${n}`, evm: `0x${n}` });
  const full = {
    admins: [acct(1), acct(2), acct(3)],
    watcher: acct(4),
    gate: acct(5),
    payees: [acct(6), acct(7)],
    attacker: acct(8),
    treasury: acct(9),
    topics: { receipts: "0.0.10", incidents: "0.0.11", heartbeats: "0.0.12" },
    token: { tokenId: "0.0.13", proxy: "0.0.14", proxyEvm: "0xabc", symbol: "RUPC", decimals: 6 },
    controller: { contractId: "0.0.15", evm: "0xdef" },
  };
  it("empty state needs everything", () => {
    expect(missingSteps({})).toEqual(["accounts", "topics", "token", "controller"]);
  });
  it("full state needs nothing", () => {
    expect(missingSteps(full)).toEqual([]);
  });
  it("detects a partial step", () => {
    expect(missingSteps({ ...full, admins: [acct(1), acct(2)] })).toEqual(["accounts"]);
    expect(missingSteps({ ...full, topics: { receipts: "0.0.10" } })).toEqual(["topics"]);
    expect(missingSteps({ ...full, controller: undefined })).toEqual(["controller"]);
  });
});

describe("misc helpers", () => {
  it("toUnits / hashscan / median", () => {
    expect(toUnits(1_000_000n, 6)).toBe(1_000_000_000_000n);
    expect(hashscanTx("0.0.1-2-3")).toBe("https://hashscan.io/testnet/transaction/0.0.1-2-3");
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNaN();
  });
  it("replaceSection appends then replaces in place", () => {
    let doc = "# Tests\n";
    doc = replaceSection(doc, "T1", "first");
    doc = replaceSection(doc, "T2", "second");
    doc = replaceSection(doc, "T1", "updated");
    expect(doc).toContain("<!-- T1:start -->\nupdated\n<!-- T1:end -->");
    expect(doc.indexOf("T1:start")).toBeLessThan(doc.indexOf("T2:start"));
    expect(doc.match(/T1:start/g)).toHaveLength(1);
  });
});

describe("deployStableCoin request", () => {
  const op = "0x455cc068606d35b933c85b4c7e77127e8a5d6dde";
  const req = buildDeployRequest(op, "0xd60a25c54c6a2b4232ffb4a02b58311f7523bf63");
  it("keys are contract-managed, no KYC, freeze default false", () => {
    expect(req.keys.map((k) => k.keyType)).toEqual([1n, 4n, 8n, 16n, 64n]);
    expect(req.keys.every((k) => k.publicKey === "0x")).toBe(true);
    expect(req.freeze).toBe(false);
    expect(req.tokenDecimals).toBe(6);
    expect(req.tokenSymbol).toBe("RUPC");
  });
  it("admin role goes to the operator", () => {
    expect(req.roles.find((r) => r.role === STUDIO_ROLES.DEFAULT_ADMIN)?.account).toBe(op);
  });
  it("encodes against the factory ABI", () => {
    const data = encodeFunctionData({ abi: studioFactoryAbi, functionName: "deployStableCoin", args: [req] as any });
    expect(data.slice(0, 10)).toBe("0xa002aee3"); // selector seen on testnet factory calls
  });
});
