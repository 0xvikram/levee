// Agent side of the heartbeat: fetch nonce, build canonical payload, sign, POST.
import fs from "node:fs";
import path from "node:path";
import type { Hex } from "viem";
import type { CheckResult, Profile } from "./checks.js";
import { buildPayload, newMachineKey, publicKeyOf, signPayload, type SignedHeartbeat } from "./protocol.js";

export const stateDir = () => path.resolve("state");
export const keyFile = (m: string) => path.join(stateDir(), `machine-${m}.key`);
const seqFile = (m: string) => path.join(stateDir(), `machine-${m}.seq`);
/** Per-machine baseline (two demo machines can run on one Mac). Falls back to the legacy shared file for reading. */
export const baselineFile = (machine?: string) => path.join(stateDir(), machine ? `baseline-${machine}.json` : "baseline.json");

/** Creates the machine key (0600) if missing. Returns the private key. */
export function ensureKey(machine: string): Hex {
  fs.mkdirSync(stateDir(), { recursive: true });
  if (!fs.existsSync(keyFile(machine))) fs.writeFileSync(keyFile(machine), newMachineKey(), { mode: 0o600 });
  return fs.readFileSync(keyFile(machine), "utf8").trim() as Hex;
}

export function nextSeq(machine: string): number {
  let last = 0;
  try {
    last = Number(fs.readFileSync(seqFile(machine), "utf8")) || 0;
  } catch {
    /* first run */
  }
  const seq = last + 1;
  fs.writeFileSync(seqFile(machine), String(seq));
  return seq;
}

async function json(res: Response) {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, ok: res.ok, body };
}

export async function enrolMachine(checkerUrl: string, machine: string, role: string, token?: string, profile: Profile = "laptop") {
  const publicKey = publicKeyOf(ensureKey(machine));
  const res = await fetch(`${checkerUrl}/enrol`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-enrol-token": token } : {}) },
    body: JSON.stringify({ machine, publicKey, role, profile }),
  });
  return json(res);
}

export async function sendHeartbeat(checkerUrl: string, machine: string, key: Hex, results: CheckResult[], seq: number, profile?: Profile) {
  const n = await json(await fetch(`${checkerUrl}/nonce?machine=${encodeURIComponent(machine)}`));
  if (!n.ok) throw new Error(`nonce: ${n.status} ${String(n.body.error ?? "")}`);
  const signed: SignedHeartbeat = await signPayload(key, buildPayload(machine, seq, String(n.body.nonce), results, Date.now(), profile));
  return json(
    await fetch(`${checkerUrl}/heartbeat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) }),
  );
}
