// Pure checks for the issuer signer: may this Hedera schedule get the treasury signer's signature?
// No I/O here, so every refusal path is unit-tested (tests/signer/verify.test.ts).
//
// A schedule is signed only if ALL of these hold:
//  1. it was created by the gate account, is not deleted, not executed and not expired;
//  2. its body is ONE plain token transfer of our token: treasury -amount, recipient +amount, nothing else
//     (no HBAR legs, no NFTs, no other transaction type, no alias accounts);
//  3. a receipt for exactly that scheduled transaction id is on the receipts topic (read from the Mirror
//     Node, so it reached consensus), paid by the gate, with the same token / from / to / amount and kind
//     "transfer" (and, if the receipt names a schedule, the same schedule);
//  4. the same rules as the gate and the watcher still pass (per-transfer cap, daily cap counting every
//     earlier receipt that UTC day, known recipients only).
import * as hiero from "@hiero-ledger/proto";
import type { Receipt, Rules } from "../shared/types.js";
import type { MirrorSchedule } from "../shared/mirror.js";
import { checkRules, dayKey } from "../shared/rules.js";
import { compareConsensus } from "../shared/txid.js";

const { proto } = hiero as unknown as { proto: any };

export interface ScheduledTransfer {
  token: string;
  from: string;
  to: string;
  amount: string; // smallest unit
}

type Long = { toString(): string } | number | string;
const idOf = (o: { shardNum?: Long; realmNum?: Long } & Record<string, unknown>, numKey: string): string | null => {
  const n = o?.[numKey] as Long | undefined;
  if (n === undefined || n === null) return null;
  return `${String(o.shardNum ?? 0)}.${String(o.realmNum ?? 0)}.${String(n)}`;
};

/**
 * Decode a Mirror schedule's base64 SchedulableTransactionBody and accept only one plain token transfer
 * with exactly two legs (a debit and a matching credit). Anything else is refused.
 */
export function decodeScheduledTransfer(bodyBase64: string): { ok: true; value: ScheduledTransfer } | { ok: false; error: string } {
  let body: any;
  try {
    body = proto.SchedulableTransactionBody.decode(Buffer.from(bodyBase64, "base64"));
  } catch {
    return { ok: false, error: "schedule body does not decode" };
  }
  const kind: string | undefined = body.data; // the oneof case name
  if (kind !== "cryptoTransfer") return { ok: false, error: `scheduled transaction is ${kind ?? "empty"}, not a token transfer` };
  const ct = body.cryptoTransfer;
  if ((ct.transfers?.accountAmounts?.length ?? 0) > 0) return { ok: false, error: "scheduled transfer moves HBAR" };
  const lists = ct.tokenTransfers ?? [];
  if (lists.length !== 1) return { ok: false, error: `scheduled transfer has ${lists.length} token lists, expected 1` };
  const tl = lists[0];
  if ((tl.nftTransfers?.length ?? 0) > 0) return { ok: false, error: "scheduled transfer moves NFTs" };
  const token = tl.token ? idOf(tl.token, "tokenNum") : null;
  if (!token) return { ok: false, error: "scheduled transfer has no token id" };
  const legs = tl.transfers ?? [];
  if (legs.length !== 2) return { ok: false, error: `scheduled transfer has ${legs.length} legs, expected 2` };
  const parsed: { account: string; amount: bigint }[] = [];
  for (const l of legs) {
    if (l.isApproval) return { ok: false, error: "scheduled transfer uses an allowance" };
    const acct = l.accountID && !l.accountID.alias?.length ? idOf(l.accountID, "accountNum") : null;
    if (!acct) return { ok: false, error: "scheduled transfer names an alias or empty account" };
    parsed.push({ account: acct, amount: BigInt(String(l.amount ?? 0)) });
  }
  const debit = parsed.find((p) => p.amount < 0n);
  const credit = parsed.find((p) => p.amount > 0n);
  if (!debit || !credit || debit.amount + credit.amount !== 0n) return { ok: false, error: "scheduled transfer is not one debit and one matching credit" };
  return { ok: true, value: { token, from: debit.account, to: credit.account, amount: credit.amount.toString() } };
}

export type RefuseReason =
  | "not-from-gate"
  | "deleted"
  | "already-executed"
  | "expired"
  | "not-a-plain-transfer"
  | "wrong-token"
  | "not-from-treasury"
  | "no-receipt"
  | "receipt-not-from-gate"
  | "receipt-mismatch"
  | "over-transfer-cap"
  | "over-daily-cap"
  | "unknown-destination";

export type Verdict =
  | { ok: true; transfer: ScheduledTransfer; receipt: Receipt }
  | { ok: false; final: boolean; reason: RefuseReason; detail: string };

/** A receipt as read from the receipts topic, with who paid for the message. */
export type SeenReceipt = Receipt & { payer: string };

export interface VerifyInput {
  schedule: MirrorSchedule;
  /** transaction id (Mirror spelling) the transfer will execute under: the ScheduleCreate's id */
  scheduledTxId: string;
  /** every receipt read from the receipts topic so far, in topic order, consensusAt filled from the Mirror */
  receipts: SeenReceipt[];
  rules: Rules;
  gateAccount: string;
  nowSec: number;
}

/**
 * Decide on one schedule. `final: false` means "not yet" (the receipt may simply not be readable on the
 * Mirror yet); the service retries those until its deadline, then refuses for good.
 */
export function verifySchedule(i: VerifyInput): Verdict {
  const no = (reason: RefuseReason, detail: string, final = true): Verdict => ({ ok: false, final, reason, detail });
  const s = i.schedule;
  if (s.creator_account_id !== i.gateAccount) return no("not-from-gate", `schedule created by ${s.creator_account_id}, not the gate ${i.gateAccount}`);
  if (s.deleted) return no("deleted", "schedule was deleted");
  if (s.executed_timestamp) return no("already-executed", `schedule already executed at ${s.executed_timestamp}`);
  if (s.expiration_time && Number(s.expiration_time.split(".")[0]) <= i.nowSec) return no("expired", `schedule expired at ${s.expiration_time}`);

  const t = decodeScheduledTransfer(s.transaction_body);
  if (!t.ok) return no("not-a-plain-transfer", t.error);
  const tr = t.value;
  if (tr.token !== i.rules.token) return no("wrong-token", `token ${tr.token}, expected ${i.rules.token}`);
  if (tr.from !== i.rules.treasury) return no("not-from-treasury", `debits ${tr.from}, not the treasury ${i.rules.treasury}`);

  const r = i.receipts.find((x) => x.txId === i.scheduledTxId);
  if (!r || !r.consensusAt) return no("no-receipt", `no receipt for ${i.scheduledTxId} on the receipts topic`, false);
  if (r.payer !== i.gateAccount) return no("receipt-not-from-gate", `receipt paid by ${r.payer}, not the gate`);
  const same = r.kind === "transfer" && r.token === tr.token && r.from === tr.from && r.to === tr.to && r.amount === tr.amount && (r.scheduleId === undefined || r.scheduleId === s.schedule_id);
  if (!same) {
    return no("receipt-mismatch", `receipt says ${r.kind} ${r.amount} ${r.token} ${r.from}->${r.to}${r.scheduleId ? ` (schedule ${r.scheduleId})` : ""}; schedule ${s.schedule_id} moves ${tr.amount} ${tr.token} ${tr.from}->${tr.to}`);
  }

  // Daily cap: every receipt of the same UTC day that reached consensus before this one.
  const day = dayKey(r.consensusAt);
  let spent = 0n;
  for (const x of i.receipts) {
    if (x === r || !x.consensusAt) continue; // all kinds, as the gate's own daily ledger counts them
    if (dayKey(x.consensusAt) === day && compareConsensus(x.consensusAt, r.consensusAt) < 0) spent += BigInt(x.amount);
  }
  const rule = checkRules(i.rules, { to: tr.to, amount: BigInt(tr.amount), kind: "transfer" }, spent);
  if (!rule.ok) {
    const detail =
      rule.reason === "over-transfer-cap"
        ? `amount ${tr.amount} > cap ${i.rules.capPerTransfer}`
        : rule.reason === "over-daily-cap"
          ? `earlier receipts today ${spent} + ${tr.amount} > daily cap ${i.rules.capPerDay}`
          : `${tr.to} is not a known recipient`;
    return no(rule.reason, detail);
  }
  return { ok: true, transfer: tr, receipt: r };
}
