// Network helpers shared by setup scripts and first-hour tests.
// Contract calls go through HAPI ContractExecuteTransaction (fee = gas only), with gas
// estimated for free by the Mirror Node. Never logs keys.
import {
  AccountBalanceQuery,
  AccountId,
  Client,
  ContractExecuteTransaction,
  ContractId,
  Hbar,
  Status,
  TransactionId,
} from "@hashgraph/sdk";
import { decodeErrorResult, type Abi } from "viem";
import { env } from "../shared/config.js";
import { normaliseTxId } from "../shared/txid.js";
import { hashscanTx } from "./plan.js";

/** HAPI response code number -> name, e.g. 165 -> ACCOUNT_FROZEN_FOR_TOKEN */
export function statusName(code: number): string {
  try {
    return (Status as any)._fromCode(code).toString();
  } catch {
    return `code ${code}`;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mirror<T = any>(pathAndQuery: string, tries = 1): Promise<T | null> {
  const base = env.mirrorUrl.replace(/\/$/, "");
  const url = pathAndQuery.startsWith("http") ? pathAndQuery : `${base}${pathAndQuery}`;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url);
    if (r.ok) return (await r.json()) as T;
    if (r.status !== 404) throw new Error(`mirror ${r.status} for ${pathAndQuery}: ${(await r.text()).slice(0, 300)}`);
    if (i < tries - 1) await sleep(1000);
  }
  return null;
}

export async function hbarBalance(client: Client, accountId: string): Promise<number> {
  const b = await new AccountBalanceQuery().setAccountId(accountId).execute(client);
  return b.hbars.toTinybars().toNumber() / 1e8;
}

/** Mirror Node gas estimate (free). Returns null if the mirror cannot estimate. */
export async function estimateGas(from: string, to: string, data: string, valueTinybar = 0n): Promise<number | null> {
  const r = await fetch(`${env.mirrorUrl.replace(/\/$/, "")}/api/v1/contracts/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from, to, data, estimate: true, value: Number(valueTinybar), gas: 15_000_000 }),
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { result?: string };
  return j.result ? Number(BigInt(j.result)) : null;
}

/** Mirror Node eth_call (free): returns hex result or throws with the revert data. */
export async function ethCall(to: string, data: string, from?: string): Promise<string> {
  const r = await fetch(`${env.mirrorUrl.replace(/\/$/, "")}/api/v1/contracts/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to, data, from, estimate: false, gas: 5_000_000 }),
  });
  const j = (await r.json()) as any;
  if (!r.ok) {
    const err = new Error(`eth_call failed: ${JSON.stringify(j?._status?.messages ?? j).slice(0, 400)}`);
    (err as any).data = j?._status?.messages?.[0]?.data;
    throw err;
  }
  return j.result as string;
}

export interface ExecResult {
  ok: boolean;
  status: string;
  txId: string; // mirror spelling
  link: string;
  gas: number;
  error?: string; // decoded revert reason when available
}

/** Contract id of an EVM address (long-zero or CREATE-style) via the mirror node. */
export async function contractIdFromEvm(evm: string): Promise<string> {
  const lz = evm.toLowerCase().replace(/^0x/, "");
  if (lz.startsWith("000000000000000000000000")) return ContractId.fromSolidityAddress(lz).toString();
  const j = await mirror<{ contract_id: string }>(`/api/v1/contracts/${evm}`, 10);
  if (!j) throw new Error(`no contract found for ${evm}`);
  return j.contract_id;
}

/** Revert reason for a failed contract tx, read from the Mirror Node (waits for it to index). */
export async function revertReason(txId: string, abis: Abi[] = []): Promise<string> {
  for (let i = 0; i < 12; i++) {
    const j = await mirror<any>(`/api/v1/contracts/results/${txId}`).catch(() => null);
    if (j) {
      const msg: string = j.error_message ?? "";
      if (msg && msg.startsWith("0x") && msg.length >= 10) {
        for (const abi of abis) {
          try {
            const d = decodeErrorResult({ abi, data: msg as `0x${string}` });
            const args = (d.args ?? []).map(String).join(", ");
            if (d.errorName === "ResponseCodeInvalid") return `ResponseCodeInvalid(${args} = ${statusName(Number(d.args?.[0]))})`;
            return `${d.errorName}(${args})`;
          } catch {
            /* try next abi */
          }
        }
        try {
          const d = decodeErrorResult({ abi: [], data: msg as `0x${string}` }); // Error(string) / Panic
          return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`;
        } catch {
          return `raw revert ${msg}`;
        }
      }
      return msg || j.result || "unknown";
    }
    await sleep(1500);
  }
  return "revert reason not indexed yet";
}

/**
 * Execute a contract function as the client's operator (msg.sender = operator's EVM alias, or long-zero).
 * Never throws for a failed receipt; returns ok=false with the status and decoded reason instead.
 */
export async function execContract(
  client: Client,
  contractId: string,
  data: string,
  opts: { gas?: number; from?: string; to?: string; valueHbar?: number; abis?: Abi[]; minGas?: number } = {},
): Promise<ExecResult> {
  let gas = opts.gas ?? 0;
  if (!gas && opts.from && opts.to) {
    const est = await estimateGas(opts.from, opts.to, data, BigInt(Math.round((opts.valueHbar ?? 0) * 1e8))).catch(() => null);
    if (est) gas = Math.ceil(est * 1.2);
  }
  if (!gas) gas = 400_000;
  if (opts.minGas && gas < opts.minGas) gas = opts.minGas;
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(contractId))
    .setGas(gas)
    .setFunctionParameters(Buffer.from(data.replace(/^0x/, ""), "hex"));
  if (opts.valueHbar) tx.setPayableAmount(new Hbar(opts.valueHbar));
  const operator = client.operatorAccountId as AccountId;
  tx.setTransactionId(TransactionId.generate(operator));
  const txIdSdk = tx.transactionId!.toString();
  const txId = normaliseTxId(txIdSdk);
  try {
    const resp = await tx.execute(client);
    const receipt = await resp.getReceipt(client);
    return { ok: receipt.status === Status.Success, status: receipt.status.toString(), txId, link: hashscanTx(txId), gas };
  } catch (e: any) {
    const status = e?.status?.toString?.() ?? String(e?.message ?? e);
    const reason = status === "CONTRACT_REVERT_EXECUTED" ? await revertReason(txId, opts.abis) : undefined;
    return { ok: false, status, txId, link: hashscanTx(txId), gas, error: reason };
  }
}

/** Wait until the mirror node knows a transaction; returns all its records (parent + children). */
export async function mirrorTx(txId: string, timeoutMs = 30_000): Promise<any[] | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const j = await mirror<{ transactions: any[] }>(`/api/v1/transactions/${txId}`).catch(() => null);
    if (j?.transactions?.length) return j.transactions;
    await sleep(500);
  }
  return null;
}

/** Freeze status of an account for a token from the mirror node: "FROZEN" | "UNFROZEN" | ... */
export async function freezeStatus(accountId: string, tokenId: string): Promise<{ freeze: string; balance: number } | null> {
  const j = await mirror<{ tokens: { token_id: string; freeze_status: string; balance: number }[] }>(
    `/api/v1/accounts/${accountId}/tokens?token.id=${tokenId}`,
  );
  const t = j?.tokens?.find((x) => x.token_id === tokenId);
  return t ? { freeze: t.freeze_status, balance: t.balance } : null;
}

/** Token balance from the mirror node `balances` endpoint (lags a few seconds). */
export async function tokenBalance(accountId: string, tokenId: string): Promise<bigint> {
  const j = await mirror<{ balances: { balance: number }[] }>(`/api/v1/tokens/${tokenId}/balances?account.id=${accountId}`);
  return BigInt(j?.balances?.[0]?.balance ?? 0);
}
