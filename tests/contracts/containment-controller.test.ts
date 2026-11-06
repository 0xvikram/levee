// Unit tests for contracts/ContainmentController.sol against MockStudio, in an in-process EVM.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { keccak256, toHex, getAddress } from "viem";
import { Chain, compileAll, type CallResult, type Compiled, type Contract } from "./evm.ts";

const DEPLOYER = getAddress("0x00000000000000000000000000000000000000d0");
const WATCHER = getAddress("0x0000000000000000000000000000000000000077");
const NEW_WATCHER = getAddress("0x0000000000000000000000000000000000000078");
const ADMIN_A = getAddress("0x00000000000000000000000000000000000000a1");
const ADMIN_B = getAddress("0x00000000000000000000000000000000000000a2");
const ADMIN_C = getAddress("0x00000000000000000000000000000000000000a3");
const STRANGER = getAddress("0x0000000000000000000000000000000000000bad");
const ATTACKER = getAddress("0x000000000000000000000000000000000000a77a");
const TREASURY = getAddress("0x0000000000000000000000000000000000007ea5");
const INCIDENT = keccak256(toHex("incident-42"));
const ZERO = "0x0000000000000000000000000000000000000000";

const Action = { Unfreeze: 0, Unpause: 1, SetWatcher: 2 } as const;

let compiled: Record<"ContainmentController" | "MockStudio", Compiled>;
let studio: Contract;
let ctl: Contract;

beforeAll(() => {
  compiled = compileAll();
});

beforeEach(async () => {
  const chain = await Chain.create();
  studio = await chain.deploy(compiled.MockStudio, DEPLOYER);
  ctl = await chain.deploy(compiled.ContainmentController, DEPLOYER, [
    studio.address,
    WATCHER,
    [ADMIN_A, ADMIN_B, ADMIN_C],
  ]);
});

type StudioCall = { fn: string; account: string; amount: bigint; caller: string };
async function studioCalls(): Promise<StudioCall[]> {
  const n = await studio.read<bigint>("callCount");
  const out: StudioCall[] = [];
  for (let i = 0n; i < n; i++) {
    const [fn, account, amount, caller] = await studio.read<[string, string, bigint, string]>("getCall", [i]);
    out.push({ fn, account, amount, caller });
  }
  return out;
}

function expectOk(r: CallResult) {
  if (!r.ok) throw new Error(`expected success, reverted with ${r.error.errorName}`);
  return r;
}
function expectRevert(r: CallResult, errorName: string, args?: readonly unknown[]) {
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.errorName).toBe(errorName);
  if (args) expect(r.error.args).toEqual(args);
}
function contained(r: CallResult) {
  const ok = expectOk(r);
  const ev = ok.logs.filter((l) => l.eventName === "Contained");
  expect(ev).toHaveLength(1);
  return ev[0].args;
}

describe("deployment", () => {
  it("stores token, watcher, admins and threshold", async () => {
    expect(await ctl.read("token")).toBe(studio.address);
    expect(await ctl.read("watcher")).toBe(WATCHER);
    expect(await ctl.read("admins", [0n])).toBe(ADMIN_A);
    expect(await ctl.read("admins", [1n])).toBe(ADMIN_B);
    expect(await ctl.read("admins", [2n])).toBe(ADMIN_C);
    expect(await ctl.read("THRESHOLD")).toBe(2);
    expect(await ctl.read("proposalCount")).toBe(0n);
  });
});

describe("close actions: role checks", () => {
  const cases: [string, unknown[]][] = [
    ["freezeAccount", [TREASURY, INCIDENT]],
    ["wipeAndFreeze", [ATTACKER, 100n, INCIDENT]],
    ["wipeFrozen", [ATTACKER, 100n, INCIDENT]],
    ["burnSupply", [100n, INCIDENT]],
    ["pauseToken", [INCIDENT]],
  ];

  for (const [fn, args] of cases) {
    it(`${fn}: stranger reverts NotWatcherOrAdmin and Studio is not called`, async () => {
      expectRevert(await ctl.send(STRANGER, fn, args), "NotWatcherOrAdmin");
      expect(await studioCalls()).toEqual([]);
    });

    it(`${fn}: watcher and every admin may call it`, async () => {
      for (const who of [WATCHER, ADMIN_A, ADMIN_B, ADMIN_C]) expectOk(await ctl.send(who, fn, args));
    });
  }
});

describe("close actions: Studio calls and events", () => {
  it("freezeAccount calls freeze(account) and emits Contained", async () => {
    const ev = contained(await ctl.send(WATCHER, "freezeAccount", [TREASURY, INCIDENT]));
    expect(ev).toEqual({ step: "freeze", account: TREASURY, amount: 0n, incidentId: INCIDENT });
    expect(await studioCalls()).toEqual([{ fn: "freeze", account: TREASURY, amount: 0n, caller: ctl.address }]);
  });

  it("wipeAndFreeze calls wipe(account, amount) then freeze(account)", async () => {
    const ev = contained(await ctl.send(WATCHER, "wipeAndFreeze", [ATTACKER, 12345n, INCIDENT]));
    expect(ev).toEqual({ step: "wipe+freeze", account: ATTACKER, amount: 12345n, incidentId: INCIDENT });
    expect((await studioCalls()).map((c) => [c.fn, c.account, c.amount])).toEqual([
      ["wipe", ATTACKER, 12345n],
      ["freeze", ATTACKER, 0n],
    ]);
  });

  it("wipeFrozen calls unfreeze -> wipe -> freeze in that order and ends frozen", async () => {
    const ev = contained(await ctl.send(WATCHER, "wipeFrozen", [ATTACKER, 777n, INCIDENT]));
    expect(ev).toEqual({ step: "wipe-frozen", account: ATTACKER, amount: 777n, incidentId: INCIDENT });
    const calls = await studioCalls();
    expect(calls.map((c) => [c.fn, c.account, c.amount])).toEqual([
      ["unfreeze", ATTACKER, 0n],
      ["wipe", ATTACKER, 777n],
      ["freeze", ATTACKER, 0n],
    ]);
    expect(calls.at(-1)?.fn).toBe("freeze");
  });

  it("burnSupply calls burn(amount) and emits Contained with account 0", async () => {
    const ev = contained(await ctl.send(WATCHER, "burnSupply", [5000n, INCIDENT]));
    expect(ev).toEqual({ step: "burn", account: ZERO, amount: 5000n, incidentId: INCIDENT });
    expect(await studioCalls()).toEqual([{ fn: "burn", account: ZERO, amount: 5000n, caller: ctl.address }]);
  });

  it("pauseToken calls pause() and emits Contained", async () => {
    const ev = contained(await ctl.send(WATCHER, "pauseToken", [INCIDENT]));
    expect(ev).toEqual({ step: "pause", account: ZERO, amount: 0n, incidentId: INCIDENT });
    expect((await studioCalls()).map((c) => c.fn)).toEqual(["pause"]);
  });

  it("passes the incident id through unchanged", async () => {
    const other = keccak256(toHex("incident-other"));
    const ev = contained(await ctl.send(WATCHER, "pauseToken", [other]));
    expect(ev.incidentId).toBe(other);
  });
});

describe("close actions: StudioCallFailed bubbling", () => {
  const cases: [string, unknown[], string][] = [
    ["freezeAccount", [TREASURY, INCIDENT], "freeze"],
    ["wipeAndFreeze", [ATTACKER, 1n, INCIDENT], "wipe"],
    ["wipeAndFreeze", [ATTACKER, 1n, INCIDENT], "freeze"],
    ["wipeFrozen", [ATTACKER, 1n, INCIDENT], "unfreeze"],
    ["wipeFrozen", [ATTACKER, 1n, INCIDENT], "wipe"],
    ["wipeFrozen", [ATTACKER, 1n, INCIDENT], "freeze"],
    ["burnSupply", [1n, INCIDENT], "burn"],
    ["pauseToken", [INCIDENT], "pause"],
  ];
  for (const [fn, args, step] of cases) {
    it(`${fn}: Studio ${step} returning false reverts StudioCallFailed("${step}") and rolls back`, async () => {
      expectOk(await studio.send(DEPLOYER, "setFail", [step, true]));
      expectRevert(await ctl.send(WATCHER, fn, args), "StudioCallFailed", [step]);
      expect(await studioCalls()).toEqual([]);
    });
  }
});

describe("watcher cannot open anything", () => {
  it("watcher cannot propose or approve (NotAdmin)", async () => {
    for (const a of [Action.Unfreeze, Action.Unpause, Action.SetWatcher]) {
      expectRevert(await ctl.send(WATCHER, "propose", [a, WATCHER]), "NotAdmin");
    }
    expectOk(await ctl.send(ADMIN_A, "propose", [Action.Unpause, ZERO]));
    expectRevert(await ctl.send(WATCHER, "approve", [1n]), "NotAdmin");
    expect(await studioCalls()).toEqual([]);
  });

  it("the ABI has no direct unfreeze/unpause/setWatcher entry point", () => {
    const fns = compiled.ContainmentController.abi
      .filter((e) => e.type === "function")
      .map((e) => (e as { name: string }).name);
    for (const name of fns) expect(name.toLowerCase()).not.toMatch(/unfreeze|unpause|setwatcher/);
    expect(fns.sort()).toEqual(
      [
        "THRESHOLD",
        "admins",
        "approve",
        "burnSupply",
        "freezeAccount",
        "getProposal",
        "pauseToken",
        "propose",
        "proposalCount",
        "token",
        "watcher",
        "wipeAndFreeze",
        "wipeFrozen",
      ].sort(),
    );
  });
});

describe("2-of-3 proposals", () => {
  it("non-admin cannot propose or approve", async () => {
    expectRevert(await ctl.send(STRANGER, "propose", [Action.Unfreeze, ATTACKER]), "NotAdmin");
    expectOk(await ctl.send(ADMIN_A, "propose", [Action.Unfreeze, ATTACKER]));
    expectRevert(await ctl.send(STRANGER, "approve", [1n]), "NotAdmin");
  });

  it("ids start at 1 and increase", async () => {
    const r1 = expectOk(await ctl.send(ADMIN_A, "propose", [Action.Unfreeze, ATTACKER]));
    const r2 = expectOk(await ctl.send(ADMIN_B, "propose", [Action.Unpause, ZERO]));
    expect(r1.result).toBe(1n);
    expect(r2.result).toBe(2n);
    expect(await ctl.read("proposalCount")).toBe(2n);
  });

  it("propose counts as one approval and does not execute", async () => {
    const r = expectOk(await ctl.send(ADMIN_A, "propose", [Action.Unfreeze, ATTACKER]));
    expect(r.logs.map((l) => l.eventName)).toEqual(["ProposalCreated", "ProposalApproved"]);
    expect(r.logs[0].args).toEqual({ id: 1n, action: Action.Unfreeze, target: ATTACKER, by: ADMIN_A });
    expect(r.logs[1].args).toEqual({ id: 1n, by: ADMIN_A, approvals: 1 });
    expect(await ctl.read("getProposal", [1n])).toEqual([Action.Unfreeze, ATTACKER, 1, false]);
    expect(await studioCalls()).toEqual([]);
  });

  it("Unfreeze: a second distinct admin executes unfreeze(target)", async () => {
    expectOk(await ctl.send(ADMIN_A, "propose", [Action.Unfreeze, ATTACKER]));
    const r = expectOk(await ctl.send(ADMIN_C, "approve", [1n]));
    expect(r.logs.map((l) => l.eventName)).toEqual(["ProposalApproved", "ProposalExecuted"]);
    expect(r.logs[0].args).toEqual({ id: 1n, by: ADMIN_C, approvals: 2 });
    expect(r.logs[1].args).toEqual({ id: 1n, action: Action.Unfreeze, target: ATTACKER });
    expect(await studioCalls()).toEqual([{ fn: "unfreeze", account: ATTACKER, amount: 0n, caller: ctl.address }]);
    expect(await ctl.read("getProposal", [1n])).toEqual([Action.Unfreeze, ATTACKER, 2, true]);
  });

  it("Unpause: a second distinct admin executes unpause()", async () => {
    expectOk(await ctl.send(ADMIN_B, "propose", [Action.Unpause, ZERO]));
    expectOk(await ctl.send(ADMIN_A, "approve", [1n]));
    expect((await studioCalls()).map((c) => c.fn)).toEqual(["unpause"]);
  });

  it("same admin approving twice reverts AlreadyApproved", async () => {
    expectOk(await ctl.send(ADMIN_A, "propose", [Action.Unfreeze, ATTACKER]));
    expectRevert(await ctl.send(ADMIN_A, "approve", [1n]), "AlreadyApproved");
    expect(await ctl.read("getProposal", [1n])).toEqual([Action.Unfreeze, ATTACKER, 1, false]);
  });

  it("approving an executed proposal reverts AlreadyExecuted", async () => {
    expectOk(await ctl.send(ADMIN_A, "propose", [Action.Unpause, ZERO]));
    expectOk(await ctl.send(ADMIN_B, "approve", [1n]));
    expectRevert(await ctl.send(ADMIN_C, "approve", [1n]), "AlreadyExecuted");
    expectRevert(await ctl.send(ADMIN_B, "approve", [1n]), "AlreadyExecuted");
    expect((await studioCalls()).map((c) => c.fn)).toEqual(["unpause"]);
  });

  it("Studio failure on execute reverts StudioCallFailed and leaves the proposal open", async () => {
    expectOk(await studio.send(DEPLOYER, "setFail", ["unfreeze", true]));
    expectOk(await ctl.send(ADMIN_A, "propose", [Action.Unfreeze, ATTACKER]));
    expectRevert(await ctl.send(ADMIN_B, "approve", [1n]), "StudioCallFailed", ["unfreeze"]);
    expect(await ctl.read("getProposal", [1n])).toEqual([Action.Unfreeze, ATTACKER, 1, false]);
    expectOk(await studio.send(DEPLOYER, "setFail", ["unfreeze", false]));
    expectOk(await ctl.send(ADMIN_B, "approve", [1n]));
    expect((await studioCalls()).map((c) => c.fn)).toEqual(["unfreeze"]);
  });

  it("Unpause failure reverts StudioCallFailed(\"unpause\")", async () => {
    expectOk(await studio.send(DEPLOYER, "setFail", ["unpause", true]));
    expectOk(await ctl.send(ADMIN_A, "propose", [Action.Unpause, ZERO]));
    expectRevert(await ctl.send(ADMIN_B, "approve", [1n]), "StudioCallFailed", ["unpause"]);
  });

  it("proposals are independent: approvals on one do not count toward another", async () => {
    expectOk(await ctl.send(ADMIN_A, "propose", [Action.Unfreeze, ATTACKER]));
    expectOk(await ctl.send(ADMIN_B, "propose", [Action.Unfreeze, TREASURY]));
    expect(await studioCalls()).toEqual([]);
    expectOk(await ctl.send(ADMIN_A, "approve", [2n]));
    expect((await studioCalls()).map((c) => [c.fn, c.account])).toEqual([["unfreeze", TREASURY]]);
    expect(await ctl.read("getProposal", [1n])).toEqual([Action.Unfreeze, ATTACKER, 1, false]);
  });
});

describe("SetWatcher rotation", () => {
  it("2-of-3 rotates the watcher; old watcher loses access, new watcher gains it", async () => {
    expectOk(await ctl.send(ADMIN_A, "propose", [Action.SetWatcher, NEW_WATCHER]));
    expect(await ctl.read("watcher")).toBe(WATCHER);
    const r = expectOk(await ctl.send(ADMIN_B, "approve", [1n]));
    expect(r.logs.at(-1)).toMatchObject({
      eventName: "ProposalExecuted",
      args: { id: 1n, action: Action.SetWatcher, target: NEW_WATCHER },
    });
    expect(await ctl.read("watcher")).toBe(NEW_WATCHER);
    expect(await studioCalls()).toEqual([]);

    expectRevert(await ctl.send(WATCHER, "pauseToken", [INCIDENT]), "NotWatcherOrAdmin");
    expectOk(await ctl.send(NEW_WATCHER, "pauseToken", [INCIDENT]));
  });

  it("a single admin cannot rotate the watcher", async () => {
    expectOk(await ctl.send(ADMIN_C, "propose", [Action.SetWatcher, STRANGER]));
    expect(await ctl.read("watcher")).toBe(WATCHER);
    expectRevert(await ctl.send(STRANGER, "pauseToken", [INCIDENT]), "NotWatcherOrAdmin");
  });

  it("the new watcher still cannot open anything", async () => {
    expectOk(await ctl.send(ADMIN_A, "propose", [Action.SetWatcher, NEW_WATCHER]));
    expectOk(await ctl.send(ADMIN_B, "approve", [1n]));
    expectRevert(await ctl.send(NEW_WATCHER, "propose", [Action.Unpause, ZERO]), "NotAdmin");
  });
});
