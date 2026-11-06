// Heartbeat wire format shared by the agent (signs) and the checker (verifies).
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { verifyMessage, type Hex } from "viem";
import { publicKeyToAddress } from "viem/utils";
import { sha256, CHECK_IDS, type CheckId, type CheckResult } from "./checks.js";

export interface HeartbeatPayload {
  machine: string;
  seq: number;
  nonce: string;
  checks: Record<string, "ok" | "fail">;
  evidenceHash: string;
  sentAt: number; // unix ms
}

export interface SignedHeartbeat {
  payload: HeartbeatPayload;
  signature: Hex;
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export function buildPayload(machine: string, seq: number, nonce: string, results: CheckResult[], sentAt = Date.now()): HeartbeatPayload {
  const checks: Record<string, "ok" | "fail"> = {};
  for (const r of results) checks[r.id] = r.ok ? "ok" : "fail";
  const evidenceHash = sha256(canonicalJson(results.map((r) => [r.id, r.evidenceHash])));
  return { machine, seq, nonce, checks, evidenceHash, sentAt };
}

export const newMachineKey = (): Hex => generatePrivateKey();
export const publicKeyOf = (privateKey: Hex): Hex => privateKeyToAccount(privateKey).publicKey;

export async function signPayload(privateKey: Hex, payload: HeartbeatPayload): Promise<SignedHeartbeat> {
  const signature = await privateKeyToAccount(privateKey).signMessage({ message: canonicalJson(payload) });
  return { payload, signature };
}

export async function verifySigned(publicKey: Hex, hb: SignedHeartbeat): Promise<boolean> {
  try {
    return await verifyMessage({ address: publicKeyToAddress(publicKey), message: canonicalJson(hb.payload), signature: hb.signature });
  } catch {
    return false;
  }
}

/** Every one of the 7 checks must be present and "ok". Returns failing ids (missing counts as failing). */
export function failingChecks(checks: Record<string, string>): CheckId[] {
  return CHECK_IDS.filter((id) => checks[id] !== "ok");
}
