import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  decodeTopicMessages,
  extractAllowances,
  extractMovements,
  groupByTxId,
  MirrorClient,
  type FetchLike,
  type MirrorTransaction,
} from "../../src/shared/mirror.js";

const fx = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures", name), "utf8"));
const opts = { token: "0.0.5001", treasury: "0.0.6000", tokenTreasury: "0.0.5000" };

describe("extractMovements: transfers (doc fixture)", () => {
  const txs: MirrorTransaction[] = fx("doc-transfer.json").transactions;
  const mv = extractMovements(txs, opts);

  it("finds only successful outflows of our token from the treasury", () => {
    expect(mv.map((m) => m.txId)).toEqual([
      "0.0.6000-1762400005-000000123",
      "0.0.6000-1762400025-000000999",
      "0.0.6666-1762400065-000000001",
    ]);
  });
  it("fills every field of a plain transfer", () => {
    expect(mv[0]).toEqual({
      txId: "0.0.6000-1762400005-000000123",
      consensusAt: "1762400010.123456789",
      token: "0.0.5001",
      from: "0.0.6000",
      to: "0.0.6001",
      amount: "500000",
      kind: "transfer",
    });
  });
  it("keeps large amounts exact", () => {
    expect(mv[1].amount).toBe("90000000000");
  });
  it("catches an allowance-based spend (is_approval) paid by someone else", () => {
    expect(mv[2]).toMatchObject({ from: "0.0.6000", to: "0.0.6666", amount: "7000" });
  });
  it("ignores inflows, other tokens and failed transactions", () => {
    expect(mv.some((m) => m.txId.startsWith("0.0.6001-"))).toBe(false);
    expect(mv.some((m) => m.txId === "0.0.6000-1762400055-000000001")).toBe(false);
    expect(mv.some((m) => m.txId === "0.0.6000-1762400035-000000001")).toBe(false);
  });
});

describe("extractMovements: Studio cash-in (doc fixture)", () => {
  const txs: MirrorTransaction[] = fx("doc-cashin.json").transactions;

  it("reports one mint to the final beneficiary under the parent tx id", () => {
    const mv = extractMovements(txs, opts);
    expect(mv).toEqual([
      {
        txId: "0.0.6000-1762400095-000000042",
        consensusAt: "1762400100.000000005",
        token: "0.0.5001",
        from: null,
        to: "0.0.6001",
        amount: "2500000",
        kind: "mint",
      },
    ]);
  });
  it("works without knowing the token treasury", () => {
    const mv = extractMovements(txs, { token: opts.token, treasury: opts.treasury });
    expect(mv).toHaveLength(1);
    expect(mv[0].to).toBe("0.0.6001");
  });
  it("works when only the child records come back (no parent in the page)", () => {
    const mv = extractMovements(txs.filter((t) => (t.nonce ?? 0) > 0), opts);
    expect(mv).toHaveLength(1);
    expect(mv[0]).toMatchObject({ kind: "mint", to: "0.0.6001", consensusAt: "1762400100.000000006" });
  });
  it("drops the whole group when the parent call failed", () => {
    const failed = txs.map((t) => ((t.nonce ?? 0) === 0 ? { ...t, result: "CONTRACT_REVERT_EXECUTED" } : t));
    expect(extractMovements(failed, opts)).toEqual([]);
  });
  it("a bare TOKENMINT left in the token treasury is a mint to the token treasury", () => {
    const bare: MirrorTransaction = {
      consensus_timestamp: "1762400300.000000001",
      transaction_id: "0.0.6666-1762400295-000000001",
      name: "TOKENMINT",
      result: "SUCCESS",
      nonce: 0,
      token_transfers: [{ token_id: "0.0.5001", account: "0.0.5000", amount: 80000000 }],
    };
    expect(extractMovements([bare], opts)).toEqual([
      { txId: bare.transaction_id, consensusAt: bare.consensus_timestamp, token: "0.0.5001", from: null, to: "0.0.5000", amount: "80000000", kind: "mint" },
    ]);
  });
  it("a mint only partly passed on reports both parts", () => {
    const g = txs.map((t) =>
      t.name === "CRYPTOTRANSFER"
        ? { ...t, token_transfers: [{ token_id: "0.0.5001", account: "0.0.5000", amount: -1000000 }, { token_id: "0.0.5001", account: "0.0.6666", amount: 1000000 }] }
        : t,
    );
    const mv = extractMovements(g, opts);
    expect(mv.map((m) => [m.to, m.amount])).toEqual([
      ["0.0.6666", "1000000"],
      ["0.0.5000", "1500000"],
    ]);
  });
  it("amounts given as strings are accepted", () => {
    const g = txs.map((t) => ({ ...t, token_transfers: (t.token_transfers ?? []).map((x) => ({ ...x, amount: String(x.amount) })) }));
    expect(extractMovements(g, opts)[0].amount).toBe("2500000");
  });
});

describe("extractMovements: misc", () => {
  it("one tx paying two accounts out of the treasury yields two movements with the same txId", () => {
    const t: MirrorTransaction = {
      consensus_timestamp: "1.000000001",
      transaction_id: "0.0.6000-1-000000001",
      name: "CRYPTOTRANSFER",
      result: "SUCCESS",
      token_transfers: [
        { token_id: "0.0.5001", account: "0.0.6000", amount: -30 },
        { token_id: "0.0.5001", account: "0.0.6001", amount: 10 },
        { token_id: "0.0.5001", account: "0.0.6666", amount: 20 },
      ],
    };
    const mv = extractMovements([t], opts);
    expect(mv.map((m) => m.to).sort()).toEqual(["0.0.6001", "0.0.6666"]);
    expect(new Set(mv.map((m) => m.txId)).size).toBe(1);
  });
  it("scheduled executions are grouped apart from the schedule-create record", () => {
    const base = { transaction_id: "0.0.6000-5-000000001", result: "SUCCESS" };
    const g = groupByTxId([
      { ...base, consensus_timestamp: "5.1", name: "SCHEDULECREATE" },
      { ...base, consensus_timestamp: "6.1", name: "CRYPTOTRANSFER", scheduled: true },
    ]);
    expect(g.size).toBe(2);
  });
  it("output is ordered by consensus time", () => {
    const all = [...fx("doc-cashin.json").transactions, ...fx("doc-transfer.json").transactions];
    const mv = extractMovements(all, opts);
    const ts = mv.map((m) => Number(m.consensusAt));
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });
});

describe("extractAllowances", () => {
  it("flags only successful approvals paid by the treasury", () => {
    const a = extractAllowances(fx("doc-allowance.json").transactions, "0.0.6000");
    expect(a).toEqual([{ txId: "0.0.6000-1762400195-000000001", consensusAt: "1762400200.000000001", owner: "0.0.6000", name: "CRYPTOAPPROVEALLOWANCE" }]);
  });
  it("ignores normal transfers", () => {
    expect(extractAllowances(fx("doc-transfer.json").transactions, "0.0.6000")).toEqual([]);
  });
});

// Real testnet captures saved by the setup agent, if present.
const real = (n: string) => fs.existsSync(path.join(__dirname, "../fixtures", n));
describe("real Mirror captures", () => {
  it.skipIf(!real("mirror-transfer.json"))("mirror-transfer.json yields a treasury transfer", () => {
    const j = fx("mirror-transfer.json");
    const txs: MirrorTransaction[] = j.transactions ?? j;
    const tt = txs.flatMap((t) => t.token_transfers ?? []);
    const neg = tt.find((x) => Number(x.amount) < 0)!;
    const mv = extractMovements(txs, { token: neg.token_id, treasury: neg.account });
    expect(mv.length).toBeGreaterThan(0);
    expect(mv[0].kind).toBe("transfer");
  });
  it.skipIf(!real("mirror-cashin.json"))("mirror-cashin.json yields one mint under the parent tx id", () => {
    const j = fx("mirror-cashin.json");
    const txs: MirrorTransaction[] = j.transactions ?? j;
    const mint = txs.find((t) => t.name === "TOKENMINT")!;
    expect(mint).toBeTruthy();
    const token = mint.token_transfers![0].token_id;
    const mv = extractMovements(txs, { token, treasury: "0.0.1" });
    expect(mv.filter((m) => m.kind === "mint").length).toBeGreaterThan(0);
    const parent = txs.find((t) => (t.nonce ?? 0) === 0) ?? mint;
    expect(mv[0].txId).toBe(parent.transaction_id);
  });
});

describe("decodeTopicMessages", () => {
  it("base64-decodes payloads", () => {
    const [m] = decodeTopicMessages([
      { consensus_timestamp: "1.000000002", message: Buffer.from('{"a":1}').toString("base64"), payer_account_id: "0.0.9", sequence_number: 7, topic_id: "0.0.10" },
    ]);
    expect(m).toEqual({ consensusAt: "1.000000002", sequence: 7, payer: "0.0.9", text: '{"a":1}' });
  });
});

function fakeFetch(responses: { status: number; body?: unknown; headers?: Record<string, string> }[]) {
  const calls: string[] = [];
  const f: FetchLike = async (url) => {
    calls.push(url);
    const r = responses.shift();
    if (!r) throw new Error("no more responses");
    return { status: r.status, ok: r.status < 300, json: async () => r.body, headers: { get: (n: string) => r.headers?.[n] ?? null } };
  };
  return { f, calls };
}

describe("MirrorClient", () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);

  it("follows links.next across pages", async () => {
    const { f, calls } = fakeFetch([
      { status: 200, body: { transactions: [{ consensus_timestamp: "1.1" }], links: { next: "/api/v1/transactions?account.id=0.0.6000&timestamp=gt:1.1" } } },
      { status: 200, body: { transactions: [{ consensus_timestamp: "2.1" }], links: { next: null } } },
    ]);
    const m = new MirrorClient({ baseUrl: "https://mirror.test/", fetch: f, sleep });
    const txs = await m.transactionsSince("0.0.6000", "0.0");
    expect(txs.map((t) => t.consensus_timestamp)).toEqual(["1.1", "2.1"]);
    expect(calls[0]).toBe("https://mirror.test/api/v1/transactions?account.id=0.0.6000&timestamp=gt:0.0&order=asc&limit=100");
    expect(calls[1]).toBe("https://mirror.test/api/v1/transactions?account.id=0.0.6000&timestamp=gt:1.1");
  });

  it("backs off on 429 (honouring retry-after) and on 5xx", async () => {
    sleeps.length = 0;
    const { f } = fakeFetch([
      { status: 429, headers: { "retry-after": "2" } },
      { status: 503 },
      { status: 200, body: { token_id: "0.0.5001", total_supply: "123" } },
    ]);
    const m = new MirrorClient({ baseUrl: "https://mirror.test", fetch: f, sleep });
    expect(await m.tokenSupply("0.0.5001")).toBe(123n);
    expect(sleeps).toEqual([2000, 500]);
  });

  it("gives up after maxRetries", async () => {
    const { f } = fakeFetch([{ status: 429 }, { status: 429 }]);
    const m = new MirrorClient({ baseUrl: "https://mirror.test", fetch: f, sleep, maxRetries: 1 });
    await expect(m.tokenInfo("0.0.1")).rejects.toThrow(/429/);
  });

  it("returns null on 404 and throws on other 4xx", async () => {
    const { f } = fakeFetch([{ status: 404 }, { status: 400 }]);
    const m = new MirrorClient({ baseUrl: "https://mirror.test", fetch: f, sleep });
    expect(await m.tokenInfo("0.0.1")).toBeNull();
    await expect(m.tokenInfo("0.0.1")).rejects.toThrow(/400/);
  });

  it("reads topic messages after a sequence number, decoded", async () => {
    const msg = { consensus_timestamp: "3.000000001", message: Buffer.from("hi").toString("base64"), payer_account_id: "0.0.2", sequence_number: 5, topic_id: "0.0.10" };
    const { f, calls } = fakeFetch([{ status: 200, body: { messages: [msg], links: { next: null } } }]);
    const m = new MirrorClient({ baseUrl: "https://mirror.test", fetch: f, sleep });
    const out = await m.topicMessagesSince("0.0.10", 4);
    expect(out[0].text).toBe("hi");
    // gte:N+1, because the Mirror Node returns 400 for sequencenumber=gt:0
    expect(calls[0]).toContain("/api/v1/topics/0.0.10/messages?sequencenumber=gte:5&order=asc");
  });

  it("cacheBust makes every polling URL unique without excluding any real record", async () => {
    const page = { status: 200, body: { messages: [], transactions: [], blocks: [], links: { next: null } } };
    const { f, calls } = fakeFetch([page, page, page, page]);
    const m = new MirrorClient({ baseUrl: "https://mirror.test", fetch: f, sleep, cacheBust: true, now: () => 1_793_940_000_123 });
    await m.topicMessagesSince("0.0.10", 4);
    await m.topicMessagesSince("0.0.10", 4);
    await m.transactionsSince("0.0.6000", "1.0");
    await m.latestBlockTimestamp();
    expect(calls[0]).toBe("https://mirror.test/api/v1/topics/0.0.10/messages?sequencenumber=gte:5&timestamp=lte:1793943600.000000001&order=asc&limit=100");
    expect(calls[1]).toContain("timestamp=lte:1793943600.000000002");
    expect(calls[2]).toBe("https://mirror.test/api/v1/transactions?account.id=0.0.6000&timestamp=gt:1.0&timestamp=lte:1793943600.000000003&order=asc&limit=100");
    expect(new Set(calls).size).toBe(4);
  });

  it("lists transactions of several accounts at once (repeated account.id), ascending, from a timestamp inclusive", async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { transactions: [{ consensus_timestamp: "5.1" }], links: { next: null } } }]);
    const m = new MirrorClient({ baseUrl: "https://mirror.test", fetch: f, sleep });
    const out = await m.transactionsForAccountsFrom(["0.0.6000", "0.0.5000", "0.0.6000", "0.0.7000"], "5.000000001");
    expect(out).toHaveLength(1);
    expect(calls[0]).toBe("https://mirror.test/api/v1/transactions?account.id=0.0.6000&account.id=0.0.5000&account.id=0.0.7000&timestamp=gte:5.000000001&order=asc&limit=100");
  });

  it("reads freeze status and balance of an account", async () => {
    const { f } = fakeFetch([{ status: 200, body: { tokens: [{ token_id: "0.0.5001", balance: 42, freeze_status: "FROZEN" }] } }]);
    const m = new MirrorClient({ baseUrl: "https://mirror.test", fetch: f, sleep });
    expect(await m.tokenRelationship("0.0.6666", "0.0.5001")).toEqual({ balance: 42n, frozen: true });
  });
});

describe("real testnet capture: contract-driven mint (third-party contract)", () => {
  const txs: MirrorTransaction[] = fx("testnet-contract-mint.json").transactions;
  it("has the parent + HTS-precompile CONTRACTCALL + TOKENMINT + CRYPTOTRANSFER shape we expect", () => {
    expect(txs.map((t) => [t.name, t.nonce])).toEqual([
      ["ETHEREUMTRANSACTION", 0],
      ["CONTRACTCALL", 1],
      ["TOKENMINT", 2],
      ["CRYPTOTRANSFER", 3],
    ]);
    expect(txs.slice(1).every((t) => t.parent_consensus_timestamp === txs[0].consensus_timestamp)).toBe(true);
  });
  it("yields one mint to the beneficiary under the parent tx id at the parent's consensus time", () => {
    const mint = txs[2];
    const token = mint.token_transfers![0].token_id;
    const tokenTreasury = mint.token_transfers![0].account;
    const mv = extractMovements(txs, { token, treasury: "0.0.1", tokenTreasury });
    expect(mv).toEqual([
      { txId: txs[0].transaction_id, consensusAt: txs[0].consensus_timestamp, token, from: null, to: "0.0.10648629", amount: "10000", kind: "mint" },
    ]);
  });
});

describe("real testnet: account.id view of the token treasury returns only the children", () => {
  // Verified live: /transactions?account.id=<token treasury> returns TOKENMINT#2 + CRYPTOTRANSFER#3 (no parent).
  const txs: MirrorTransaction[] = fx("testnet-contract-mint.json").transactions.filter((t: MirrorTransaction) => t.name === "TOKENMINT" || t.name === "CRYPTOTRANSFER");
  it("still yields the mint under the shared tx id", () => {
    const tokenTreasury = "0.0.10650119";
    const mv = extractMovements(txs, { token: "0.0.10650120", treasury: "0.0.1", tokenTreasury });
    expect(mv).toHaveLength(1);
    expect(mv[0]).toMatchObject({ kind: "mint", to: "0.0.10648629", amount: "10000", consensusAt: txs[0].consensus_timestamp });
  });
});
