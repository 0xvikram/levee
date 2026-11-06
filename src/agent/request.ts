// Signed gate requests: the machine that asks for a money move signs it with its own Leash key
// (state/machine-<name>.key, the same secp256k1 / EIP-191 key that signs its heartbeats).
// The gate checks the signature against the public key the checker stored at enrolment, so naming
// a machine is no longer enough: you must hold that machine's key.
//
// Wire body (flat, so the old fields keep their place):
//   {machine, to, amount, kind, nonce, sentAt, signature}
// signature = EIP-191 personal_sign over canonicalJson({machine, to, amount, kind, nonce, sentAt}).
//
// CLI: npm run request -- --machine payouts-server --to 0.0.x --amount 500 [--kind transfer|mint] [--units] [--gate URL]
//   --amount is in whole tokens (scaled by the token's decimals from state/deploy.json); --units sends it as-is.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage, type Hex } from "viem";
import { publicKeyToAddress } from "viem/utils";
import { canonicalJson } from "./protocol.js";
import { keyFile } from "./heartbeat.js";

export type RequestKind = "transfer" | "mint";

export interface RequestPayload {
  machine: string;
  to: string;
  /** smallest unit, decimal string */
  amount: string;
  kind: RequestKind;
  /** random hex, never reused */
  nonce: string;
  /** unix ms */
  sentAt: number;
}

export interface SignedRequestBody extends RequestPayload {
  signature: Hex;
}

/** The exact bytes that are signed: only these six fields, in canonical order. */
export function requestMessage(p: RequestPayload): string {
  return canonicalJson({ machine: p.machine, to: p.to, amount: p.amount, kind: p.kind, nonce: p.nonce, sentAt: p.sentAt });
}

export const newRequestNonce = (): string => randomBytes(16).toString("hex");

/** Pure signer (tests, and any caller that already holds the key). Amount is normalised to a decimal string. */
export async function signRequestWithKey(
  privateKey: Hex,
  machine: string,
  r: { to: string; amount: string | number | bigint; kind?: RequestKind },
  o: { nonce?: string; sentAt?: number } = {},
): Promise<SignedRequestBody> {
  const payload: RequestPayload = {
    machine,
    to: r.to,
    amount: BigInt(r.amount).toString(),
    kind: r.kind ?? "transfer",
    nonce: o.nonce ?? newRequestNonce(),
    sentAt: o.sentAt ?? Date.now(),
  };
  const signature = await privateKeyToAccount(privateKey).signMessage({ message: requestMessage(payload) });
  return { ...payload, signature };
}

/** Reads an existing machine key. Unlike ensureKey it never creates one: a request from an unenrolled key is pointless. */
export function loadMachineKey(machine: string): Hex {
  const f = keyFile(machine);
  if (!fs.existsSync(f)) throw new Error(`no key for machine ${machine} (expected ${path.relative(process.cwd(), f)}; enrol it with npm run agent -- --machine ${machine} --enrol)`);
  return fs.readFileSync(f, "utf8").trim() as Hex;
}

/** Loads the machine's key and returns the signed request body, ready to POST to the gate's /request. */
export async function signedRequest(machine: string, r: { to: string; amount: string | number | bigint; kind?: RequestKind }): Promise<SignedRequestBody> {
  return signRequestWithKey(loadMachineKey(machine), machine, r);
}

/** True when `signature` over the payload recovers to `publicKey` (uncompressed 0x04...). Never throws. */
export async function verifyRequestSignature(publicKey: Hex, payload: RequestPayload, signature: string): Promise<boolean> {
  try {
    return await verifyMessage({ address: publicKeyToAddress(publicKey), message: requestMessage(payload), signature: signature as Hex });
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ CLI

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const { env, readState } = await import("../shared/config.js");
  const machine = arg("machine");
  const to = arg("to");
  const amountArg = arg("amount");
  const kind = (arg("kind") ?? "transfer") as RequestKind;
  if (!machine || !to || !amountArg) throw new Error("usage: npm run request -- --machine <name> --to 0.0.x --amount <whole tokens> [--kind transfer|mint] [--units] [--gate URL]");
  if (kind !== "transfer" && kind !== "mint") throw new Error('--kind must be "transfer" or "mint"');
  if (!/^\d+$/.test(amountArg)) throw new Error("--amount must be a positive integer");
  let amount = BigInt(amountArg);
  if (!process.argv.includes("--units")) amount *= 10n ** BigInt(readState().token.decimals ?? 0);
  const gate = arg("gate") ?? process.env.GATE_URL ?? `http://localhost:${env.gatePort}`;

  const body = await signedRequest(machine, { to, amount, kind });
  const t0 = Date.now();
  const res = await fetch(`${gate}/request`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const reply = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; detail?: string; txId?: string; receiptTxId?: string; receipt?: { sequence?: number } };
  console.log(`${machine} -> ${to} ${amount} (${kind}), signed: HTTP ${res.status} in ${Date.now() - t0} ms`);
  if (reply.ok) {
    console.log(`receipt seq ${reply.receipt?.sequence ?? "?"}  https://hashscan.io/testnet/transaction/${reply.receiptTxId}`);
    console.log(`transfer        https://hashscan.io/testnet/transaction/${reply.txId}`);
  } else {
    console.log(`refused: ${reply.reason ?? "?"}${reply.detail ? ` (${reply.detail})` : ""}`);
  }
  console.log(JSON.stringify(reply));
  if (!reply.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(`[request] ${(e as Error).message}`);
    process.exit(1);
  });
}
