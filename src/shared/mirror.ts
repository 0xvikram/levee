// Typed Mirror Node REST client + pure parsers that turn Mirror transaction JSON
// into treasury Movements. The parsers are pure so they can be tested against
// saved Mirror responses (tests/fixtures/mirror-*.json).
import { env } from "./config.js";
import { compareConsensus } from "./txid.js";
import type { Movement } from "./types.js";

// ------------------------------------------------------------------ Mirror shapes

export interface MirrorTokenTransfer {
  token_id: string;
  account: string;
  amount: number | string;
  is_approval?: boolean;
}

export interface MirrorTransfer {
  account: string;
  amount: number | string;
  is_approval?: boolean;
}

export interface MirrorTransaction {
  consensus_timestamp: string;
  transaction_id: string; // 0.0.x-sec-nanos (Mirror spelling)
  name: string; // CRYPTOTRANSFER, TOKENMINT, CONTRACTCALL, CRYPTOAPPROVEALLOWANCE, ...
  result: string; // SUCCESS, ...
  entity_id?: string | null;
  nonce?: number;
  parent_consensus_timestamp?: string | null;
  scheduled?: boolean;
  token_transfers?: MirrorTokenTransfer[];
  transfers?: MirrorTransfer[];
  memo_base64?: string | null;
  valid_start_timestamp?: string;
}

export interface MirrorLinks {
  next: string | null;
}

export interface MirrorTransactionsPage {
  transactions: MirrorTransaction[];
  links?: MirrorLinks;
}

export interface MirrorTopicMessage {
  consensus_timestamp: string;
  message: string; // base64
  payer_account_id: string;
  sequence_number: number;
  topic_id: string;
  running_hash?: string;
  chunk_info?: unknown;
}

/** Topic message with the payload decoded from base64. */
export interface TopicMessage {
  consensusAt: string;
  sequence: number;
  payer: string;
  text: string;
}

export interface MirrorTokenInfo {
  token_id: string;
  symbol: string;
  name: string;
  decimals: string | number;
  total_supply: string;
  treasury_account_id: string;
  pause_status?: string; // PAUSED | UNPAUSED | NOT_APPLICABLE
  freeze_default?: boolean;
}

// ------------------------------------------------------------------ pure parsers

export interface ExtractOptions {
  token: string; // HTS token id 0.0.x
  treasury: string; // company treasury account 0.0.x (watched for outflows)
  /** HTS treasury of the token (for Studio tokens: the proxy contract's id). Defaults to "any account credited by the mint". */
  tokenTreasury?: string;
}

const amt = (v: number | string): bigint => BigInt(typeof v === "number" ? Math.trunc(v) : v);

/** Group transactions by transaction_id so a parent ContractCall and its child records stay together. */
export function groupByTxId(txs: MirrorTransaction[]): Map<string, MirrorTransaction[]> {
  const groups = new Map<string, MirrorTransaction[]>();
  for (const t of txs) {
    // Scheduled executions share the schedule-create id; keep them apart.
    const key = t.scheduled ? `${t.transaction_id}#scheduled` : t.transaction_id;
    const g = groups.get(key) ?? [];
    g.push(t);
    groups.set(key, g);
  }
  for (const g of groups.values()) g.sort((a, b) => compareConsensus(a.consensus_timestamp, b.consensus_timestamp));
  return groups;
}

/**
 * Turn Mirror transactions into treasury-relevant token movements.
 *
 *  (a) transfer: the company treasury's net change of `token` in one transaction (all
 *      child records together) is negative. One Movement per credited account.
 *  (b) mint: a successful TOKENMINT of `token`, alone or as a child of a Stablecoin Studio
 *      cash-in ContractCall. Studio mints to the token treasury (proxy) and then moves the
 *      tokens to the beneficiary in a sibling child record, so `to` is the account that
 *      finally received the minted amount (falls back to the minted-to account).
 *
 * The txId is always the parent's transaction_id (children share it, with nonce > 0),
 * and consensusAt is the EARLIEST timestamp in the group, so a receipt has to precede
 * the whole operation.
 */
export function extractMovements(txs: MirrorTransaction[], opts: ExtractOptions): Movement[] {
  const out: Movement[] = [];
  for (const [key, group] of groupByTxId(txs)) {
    const ok = group.filter((t) => t.result === "SUCCESS");
    if (ok.length === 0) continue;
    // If the parent failed, the children are reverted too.
    const parent = group.find((t) => (t.nonce ?? 0) === 0 && !t.parent_consensus_timestamp);
    if (parent && parent.result !== "SUCCESS") continue;

    const txId = key.replace(/#scheduled$/, "");
    const consensusAt = ok[0].consensus_timestamp;

    // Net change per account for our token across the group.
    const net = new Map<string, bigint>();
    let minted = 0n;
    const mintedTo = new Map<string, bigint>();
    for (const t of ok) {
      for (const tt of t.token_transfers ?? []) {
        if (tt.token_id !== opts.token) continue;
        const a = amt(tt.amount);
        net.set(tt.account, (net.get(tt.account) ?? 0n) + a);
        if (t.name === "TOKENMINT" && a > 0n) {
          minted += a;
          mintedTo.set(tt.account, (mintedTo.get(tt.account) ?? 0n) + a);
        }
      }
    }

    if (minted > 0n) {
      const mintAccounts = new Set(mintedTo.keys());
      if (opts.tokenTreasury) mintAccounts.add(opts.tokenTreasury);
      // Accounts other than the mint/token treasury that ended up with a positive balance change.
      const receivers = [...net.entries()].filter(([acct, d]) => d > 0n && !mintAccounts.has(acct));
      if (receivers.length === 0) {
        for (const [acct, a] of mintedTo) out.push({ txId, consensusAt, token: opts.token, from: null, to: acct, amount: a.toString(), kind: "mint" });
      } else {
        for (const [acct, d] of receivers) out.push({ txId, consensusAt, token: opts.token, from: null, to: acct, amount: d.toString(), kind: "mint" });
        // Minted supply that was NOT passed on stays in the token treasury: report it too.
        const passed = receivers.reduce((s, [, d]) => s + d, 0n);
        if (minted > passed) {
          const [acct] = [...mintedTo.keys()];
          out.push({ txId, consensusAt, token: opts.token, from: null, to: acct, amount: (minted - passed).toString(), kind: "mint" });
        }
      }
      continue;
    }

    const treasuryNet = net.get(opts.treasury) ?? 0n;
    if (treasuryNet >= 0n) continue;
    for (const [acct, d] of net) {
      if (acct === opts.treasury || d <= 0n) continue;
      out.push({ txId, consensusAt, token: opts.token, from: opts.treasury, to: acct, amount: d.toString(), kind: "transfer" });
    }
  }
  return out.sort((a, b) => compareConsensus(a.consensusAt, b.consensusAt));
}

export interface AllowanceEvent {
  txId: string;
  consensusAt: string;
  owner: string; // the treasury
  name: string; // CRYPTOAPPROVEALLOWANCE | CRYPTODELETEALLOWANCE
}

const ALLOWANCE_NAMES = new Set(["CRYPTOAPPROVEALLOWANCE"]);

/**
 * Any successful allowance approval paid by (or naming) the treasury is a breach: the
 * treasury must never let another account spend for it. The list endpoint does not show
 * which token/spender was approved, so we flag the whole transaction.
 */
export function extractAllowances(txs: MirrorTransaction[], treasury: string): AllowanceEvent[] {
  const out: AllowanceEvent[] = [];
  for (const t of txs) {
    if (!ALLOWANCE_NAMES.has(t.name) || t.result !== "SUCCESS") continue;
    const payer = t.transaction_id.split("-")[0];
    if (payer !== treasury && t.entity_id !== treasury) continue;
    out.push({ txId: t.transaction_id, consensusAt: t.consensus_timestamp, owner: treasury, name: t.name });
  }
  return out;
}

/** Decode a topic message page into plain text messages. */
export function decodeTopicMessages(msgs: MirrorTopicMessage[]): TopicMessage[] {
  return msgs.map((m) => ({
    consensusAt: m.consensus_timestamp,
    sequence: m.sequence_number,
    payer: m.payer_account_id,
    text: Buffer.from(m.message, "base64").toString("utf8"),
  }));
}

// ------------------------------------------------------------------ HTTP client

export type FetchLike = (url: string) => Promise<{ status: number; ok: boolean; json(): Promise<unknown>; headers?: { get(name: string): string | null } }>;

export interface MirrorClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  maxPages?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class MirrorClient {
  readonly baseUrl: string;
  private f: FetchLike;
  private maxRetries: number;
  private sleep: (ms: number) => Promise<void>;
  private maxPages: number;

  constructor(o: MirrorClientOptions = {}) {
    this.baseUrl = (o.baseUrl ?? env.mirrorUrl).replace(/\/$/, "");
    this.f = o.fetch ?? ((url) => fetch(url) as unknown as ReturnType<FetchLike>);
    this.maxRetries = o.maxRetries ?? 5;
    this.sleep = o.sleep ?? realSleep;
    this.maxPages = o.maxPages ?? 20;
  }

  /** GET a Mirror path (or an absolute `links.next`). Retries 429 and 5xx with backoff. 404 -> null. */
  async get<T>(pathOrUrl: string): Promise<T | null> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : this.baseUrl + pathOrUrl;
    let delay = 250;
    for (let attempt = 0; ; attempt++) {
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.f(url);
      } catch (e) {
        if (attempt >= this.maxRetries) throw e;
        await this.sleep(delay);
        delay = Math.min(delay * 2, 4000);
        continue;
      }
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= this.maxRetries) throw new Error(`mirror ${res.status} after ${attempt + 1} tries: ${url}`);
        const ra = Number(res.headers?.get("retry-after") ?? "");
        await this.sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : delay);
        delay = Math.min(delay * 2, 4000);
        continue;
      }
      if (!res.ok) throw new Error(`mirror ${res.status}: ${url}`);
      return (await res.json()) as T;
    }
  }

  /** Follow `links.next` until exhausted (or maxPages), collecting `key` arrays. */
  private async paged<T>(first: string, key: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = first;
    for (let i = 0; next && i < this.maxPages; i++) {
      const page: (Record<string, unknown> & { links?: MirrorLinks }) | null = await this.get(next);
      if (!page) break;
      out.push(...(((page[key] as T[]) ?? []) as T[]));
      next = page.links?.next ?? null;
    }
    return out;
  }

  /** Transactions touching `account` with consensus strictly after `sinceTs` ("seconds.nanos"), oldest first. */
  transactionsSince(account: string, sinceTs: string, limit = 100): Promise<MirrorTransaction[]> {
    const q = `/api/v1/transactions?account.id=${account}&timestamp=gt:${sinceTs}&order=asc&limit=${limit}`;
    return this.paged<MirrorTransaction>(q, "transactions");
  }

  /** All records (parent + children) of one transaction id. */
  async transactionById(txId: string): Promise<MirrorTransaction[]> {
    const r = await this.get<{ transactions: MirrorTransaction[] }>(`/api/v1/transactions/${txId}`);
    return r?.transactions ?? [];
  }

  tokenInfo(tokenId: string): Promise<MirrorTokenInfo | null> {
    return this.get<MirrorTokenInfo>(`/api/v1/tokens/${tokenId}`);
  }

  async tokenSupply(tokenId: string): Promise<bigint | null> {
    const t = await this.tokenInfo(tokenId);
    return t ? BigInt(t.total_supply) : null;
  }

  /** Token balance + freeze status of one account (null if not associated). */
  async tokenRelationship(account: string, tokenId: string): Promise<{ balance: bigint; frozen: boolean } | null> {
    const r = await this.get<{ tokens: { token_id: string; balance: number; freeze_status: string }[] }>(
      `/api/v1/accounts/${account}/tokens?token.id=${tokenId}`,
    );
    const t = r?.tokens?.find((x) => x.token_id === tokenId);
    return t ? { balance: BigInt(t.balance), frozen: t.freeze_status === "FROZEN" } : null;
  }

  /** Topic messages with sequence number > `afterSeq`, oldest first, decoded. */
  async topicMessagesSince(topicId: string, afterSeq: number, limit = 100): Promise<TopicMessage[]> {
    // The Mirror Node rejects sequencenumber=gt:0 (HTTP 400); gte:N+1 is the same filter and is accepted.
    const q = `/api/v1/topics/${topicId}/messages?sequencenumber=gte:${afterSeq + 1}&order=asc&limit=${limit}`;
    return decodeTopicMessages(await this.paged<MirrorTopicMessage>(q, "messages"));
  }

  /** Latest message on a topic (or null if none). */
  async latestTopicMessage(topicId: string): Promise<TopicMessage | null> {
    const r = await this.get<{ messages: MirrorTopicMessage[] }>(`/api/v1/topics/${topicId}/messages?order=desc&limit=1`);
    const m = r?.messages?.[0];
    return m ? decodeTopicMessages([m])[0] : null;
  }

  /** Consensus end timestamp of the newest block the Mirror Node has ingested. */
  async latestBlockTimestamp(): Promise<string | null> {
    const r = await this.get<{ blocks: { timestamp: { from: string; to: string } }[] }>(`/api/v1/blocks?order=desc&limit=1`);
    return r?.blocks?.[0]?.timestamp?.to ?? null;
  }
}
