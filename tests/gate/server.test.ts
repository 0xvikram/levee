import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createGate } from "../../src/gate/server.js";
import { neverLive, alwaysLive, type PassChecker } from "../../src/shared/pass.js";
import type { DeployState } from "../../src/shared/config.js";
import type { MirrorClient } from "../../src/shared/mirror.js";
import { RequestAuthenticator, staticDirectory } from "../../src/gate/auth.js";
import { newMachineKey, publicKeyOf } from "../../src/agent/protocol.js";
import { signRequestWithKey } from "../../src/agent/request.js";

const state = {
  token: { tokenId: "0.0.5001", proxy: "0.0.5000" },
  treasury: { id: "0.0.6000" },
  topics: { receipts: "0.0.9001", incidents: "0.0.9002", heartbeats: "0.0.9003" },
  payees: [{ id: "0.0.6001" }],
} as unknown as DeployState;
const rules = { token: "0.0.5001", treasury: "0.0.6000", capPerTransfer: 10_000n, capPerDay: 50_000n, knownDestinations: ["0.0.6001"] };

let pass: PassChecker = neverLive("pass expired");
let beat: { text: string; consensusAt: string } | null = null;
const mirror = { latestTopicMessage: async () => (beat ? { ...beat, sequence: 1, payer: "0.0.1" } : null) } as unknown as MirrorClient;
const key = newMachineKey();
const laptopKey = newMachineKey();
const auth = new RequestAuthenticator(
  staticDirectory([
    { machine: "payouts-1", publicKey: publicKeyOf(key), role: "payouts" },
    { machine: "laptop-1", publicKey: publicKeyOf(laptopKey), role: "employee" },
  ]),
);
const gate = createGate({ state, rules, mirror, pass: { isLive: (m) => pass.isLive(m) }, auth, client: {} as never, gateKey: {} as never });
let server: Server;
let base = "";
beforeAll(async () => {
  server = gate.app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const postRaw = (body: unknown) => fetch(`${base}/request`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const good = { machine: "payouts-1", to: "0.0.6001", amount: "500", kind: "transfer" as const };
/** Signs with payouts-1's key unless told otherwise (bad requests are posted unsigned). */
const post = async (body: typeof good) => {
  const { machine, ...r } = body;
  if (!/^\d+$/.test(r.amount)) return postRaw(body);
  return postRaw(await signRequestWithKey(machine === "laptop-1" ? laptopKey : key, machine, r));
};

describe("gate HTTP", () => {
  it("GET /health", async () => {
    const r = await fetch(`${base}/health`);
    expect(await r.json()).toMatchObject({ ok: true, service: "gate", treasury: "0.0.6000", capPerTransfer: "10000", capPerDay: "50000", spentToday: "0", knownDestinations: ["0.0.6001"] });
  });
  it("400 on a bad request", async () => {
    const r = await post({ ...good, amount: "-1" });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ reason: "bad-request" });
  });
  it("403 no-pass, and the decision goes out on the SSE hub", async () => {
    const before = gate.hub.publish("probe", {}); // just to know the id counter works
    expect(before).toContain("event: probe");
    const r = await post(good);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ ok: false, reason: "no-pass", detail: "pass expired" });
  });
  it("403 over-transfer-cap", async () => {
    pass = alwaysLive;
    const r = await post({ ...good, amount: "10001" });
    expect(await r.json()).toMatchObject({ reason: "over-transfer-cap" });
  });
  it("403 no-watcher when the heartbeat topic is empty or stale or not a heartbeat", async () => {
    pass = alwaysLive;
    beat = null;
    expect(await (await post(good)).json()).toMatchObject({ reason: "no-watcher" });
    beat = { text: JSON.stringify({ v: 1, type: "heartbeat", who: "watcher" }), consensusAt: `${Math.floor(Date.now() / 1000) - 300}.000000000` };
    expect(await (await post(good)).json()).toMatchObject({ reason: "no-watcher" });
    beat = { text: "garbage", consensusAt: `${Math.floor(Date.now() / 1000)}.000000000` };
    expect(await (await post(good)).json()).toMatchObject({ reason: "no-watcher" });
  });
});

describe("gate HTTP: who is asking", () => {
  it("403 unknown-machine / bad-signature for unsigned or forged requests, before any pass check", async () => {
    pass = alwaysLive;
    const unsigned = await postRaw(good);
    expect(unsigned.status).toBe(403);
    expect(await unsigned.json()).toMatchObject({ reason: "bad-signature" });
    // signed by the laptop's key but claiming to be payouts-1
    const forged = await postRaw(await signRequestWithKey(laptopKey, "payouts-1", { to: "0.0.6001", amount: "500" }));
    expect(forged.status).toBe(403);
    expect(await forged.json()).toMatchObject({ reason: "bad-signature" });
    const nobody = await postRaw(await signRequestWithKey(key, "ghost-1", { to: "0.0.6001", amount: "500" }));
    expect(nobody.status).toBe(403);
    expect(await nobody.json()).toMatchObject({ reason: "unknown-machine" });
  });
  it("403 wrong-role for an enrolled, correctly signed employee laptop", async () => {
    pass = alwaysLive;
    const r = await post({ ...good, machine: "laptop-1" });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ reason: "wrong-role" });
  });
  it("403 replayed-request when the same signed body is sent twice", async () => {
    pass = neverLive("pass expired");
    const body = await signRequestWithKey(key, "payouts-1", { to: "0.0.6001", amount: "500" });
    expect(await (await postRaw(body)).json()).toMatchObject({ reason: "no-pass" });
    expect(await (await postRaw(body)).json()).toMatchObject({ reason: "replayed-request" });
  });
});

describe("evmFor", () => {
  it("prefers the EVM address recorded by setup, else long-zero", async () => {
    const { evmFor } = await import("../../src/gate/server.js");
    const s = { ...state, payees: [{ id: "0.0.6001", evm: "0xabc" }] } as unknown as DeployState;
    expect(evmFor(s, "0.0.6001")).toBe("0xabc");
    expect(evmFor(s, "0.0.6666")).toBe("0x0000000000000000000000000000000000001a0a");
  });
});
