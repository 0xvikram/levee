// The gate's normal path: ScheduleCreate signed by the gate key ONLY, then the receipt (naming the
// scheduled tx id + schedule id), then the issuer signer is told the schedule id.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client, PrivateKey, ScheduleCreateTransaction } from "@hashgraph/sdk";
import * as hiero from "@hiero-ledger/proto";
import { buildScheduleCreate, createGate, type GateChain, type SignerReply } from "../../src/gate/server.js";
import { alwaysLive } from "../../src/shared/pass.js";
import type { DeployState } from "../../src/shared/config.js";
import type { MirrorClient } from "../../src/shared/mirror.js";
import type { Receipt } from "../../src/shared/types.js";
import { RequestAuthenticator, staticDirectory } from "../../src/gate/auth.js";
import { newMachineKey, publicKeyOf } from "../../src/agent/protocol.js";
import { signRequestWithKey } from "../../src/agent/request.js";
import { decodeScheduledTransfer } from "../../src/signer/verify.js";

const { proto } = hiero as unknown as { proto: any };

const state = {
  token: { tokenId: "0.0.5001", proxy: "0.0.5000" },
  treasury: { id: "0.0.6000" },
  gate: { id: "0.0.6100" },
  topics: { receipts: "0.0.9001", incidents: "0.0.9002", heartbeats: "0.0.9003" },
  payees: [{ id: "0.0.6001" }],
} as unknown as DeployState;
const rules = { token: "0.0.5001", treasury: "0.0.6000", capPerTransfer: 10_000n, capPerDay: 50_000n, knownDestinations: ["0.0.6001"] };

/** base64 SchedulableTransactionBody of a ScheduleCreate, as the Mirror Node serves it. */
export function scheduleBodyBase64(tx: ScheduleCreateTransaction): string {
  const data = (tx as unknown as { _makeTransactionData(): { scheduledTransactionBody: unknown } })._makeTransactionData();
  return Buffer.from(proto.SchedulableTransactionBody.encode(data.scheduledTransactionBody).finish()).toString("base64");
}

describe("buildScheduleCreate", () => {
  it("wraps exactly the approved transfer, payer = gate, expires, executes on the last signature", () => {
    const now = Date.UTC(2026, 10, 6, 12, 0, 0);
    const tx = buildScheduleCreate(state, { machine: "payouts-1", to: "0.0.6001", amount: "500", kind: "transfer" }, { nowMs: now, ttlS: 120 });
    const data = (tx as any)._makeTransactionData();
    expect(data.waitForExpiry).toBe(false);
    expect(Number(data.expirationTime.seconds)).toBe(now / 1000 + 120);
    expect(String(data.payerAccountID.accountNum)).toBe("6100");
    expect(tx.transactionId!.accountId!.toString()).toBe("0.0.6100");
    expect(decodeScheduledTransfer(scheduleBodyBase64(tx))).toEqual({ ok: true, value: { token: "0.0.5001", from: "0.0.6000", to: "0.0.6001", amount: "500" } });
  });
});

describe("gate HTTP: scheduled transfer", () => {
  const gateKey = PrivateKey.generateECDSA();
  const machineKey = newMachineKey();
  const auth = new RequestAuthenticator(staticDirectory([{ machine: "payouts-1", publicKey: publicKeyOf(machineKey), role: "payouts" }]));
  const mirror = { latestTopicMessage: async () => ({ text: JSON.stringify({ v: 1, type: "heartbeat", who: "watcher" }), consensusAt: `${Math.floor(Date.now() / 1000)}.000000000`, sequence: 1, payer: "0.0.1" }) } as unknown as MirrorClient;
  const client = Client.forTestnet();
  const calls: string[] = [];
  let created: ScheduleCreateTransaction | null = null;
  let written: Receipt | null = null;
  let signerReply: SignerReply = { ok: true, signTxId: "0.0.7000-1-000000001", status: "SUCCESS", executedStatus: "SUCCESS", verifyMs: 10, signMs: 20 };
  const chain: GateChain = {
    async createSchedule(tx) {
      calls.push("schedule");
      created = tx;
      return { scheduleId: "0.0.8888" };
    },
    async submitReceipt(r) {
      calls.push("receipt");
      written = r;
      return { topicId: "0.0.9001", sequence: 42, txId: "0.0.6100-1-000000002", submitMs: 5 };
    },
    async executeMint() {
      throw new Error("no mint in this test");
    },
    async notifySigner(id) {
      calls.push(`signer:${id}`);
      return signerReply;
    },
  };
  const gate = createGate({ state, rules, mirror, pass: alwaysLive, auth, client, gateKey, chain });
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = gate.app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
    client.close();
  });
  const send = async (amount = "500") =>
    fetch(`${base}/request`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(await signRequestWithKey(machineKey, "payouts-1", { to: "0.0.6001", amount })) });

  it("the gate process holds no treasury-signer key", () => {
    expect(Object.keys({ state, rules, mirror, pass: alwaysLive, auth, client, gateKey, chain })).not.toContain("signerKey");
  });

  it("schedule (gate key only) -> receipt with scheduled tx id + schedule id -> signer", async () => {
    const r = await send();
    const body = (await r.json()) as any;
    expect(r.status).toBe(200);
    expect(calls).toEqual(["schedule", "receipt", "signer:0.0.8888"]);
    // exactly one signature on the ScheduleCreate, and it is the gate's
    const sigs = created!.getSignatures();
    const keys = new Set<string>();
    for (const byTx of sigs.values()) for (const byKey of byTx.values()) for (const pk of byKey.keys()) keys.add(pk.toStringRaw());
    expect([...keys]).toEqual([gateKey.publicKey.toStringRaw()]);
    // receipt txId is the ScheduleCreate's id (Mirror spelling): the id the transfer executes under
    const id = created!.transactionId!.toString();
    const [acct, ts] = id.split("@");
    const [sec, nanos] = ts.split(".");
    const expected = `${acct}-${sec}-${nanos.padStart(9, "0")}`;
    expect(written).toMatchObject({ txId: expected, scheduleId: "0.0.8888", to: "0.0.6001", amount: "500", kind: "transfer", from: "0.0.6000" });
    expect(body).toMatchObject({ ok: true, txId: expected, scheduledTxId: expected, scheduleId: "0.0.8888", receiptSequence: 42, signTxId: "0.0.7000-1-000000001" });
  });

  it("signer refusal -> 502 signer-refused (receipt written, nothing moved)", async () => {
    calls.length = 0;
    signerReply = { ok: false, reason: "no-receipt", detail: "no receipt" };
    const r = await send("501");
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ ok: false, reason: "signer-refused", scheduleId: "0.0.8888" });
  });

  it("signer down -> 504 signer-unavailable", async () => {
    signerReply = { ok: false, reason: "signer-unavailable", detail: "ECONNREFUSED" };
    const r = await send("502");
    expect(r.status).toBe(504);
    expect(await r.json()).toMatchObject({ ok: false, reason: "signer-unavailable" });
  });
});
