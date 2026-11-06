// Who is asking? Every gate request must be signed by the requesting machine's own Leash key.
// Order: machine known to the checker -> signature recovers to its enrolled key -> sentAt fresh
// -> nonce never seen -> enrolled role allowed. Only then does the gate look at the pass, rules
// and watcher. Fails closed: if the checker cannot be asked, the request is refused.
import type { Hex } from "viem";
import { env } from "../shared/config.js";
import { verifyRequestSignature, type RequestPayload } from "../agent/request.js";
import type { GateRequest } from "./decide.js";

export const REQUEST_MAX_AGE_MS = 60_000;
export const REPLAY_CACHE_MAX = 50_000;
export const DEFAULT_ALLOWED_ROLES = ["finance", "payouts"];

export type AuthRefusal = "unknown-machine" | "bad-signature" | "stale-request" | "replayed-request" | "wrong-role";

export interface MachineRecord {
  machine: string;
  publicKey: Hex;
  role: string;
  profile?: string;
}

/** Where the gate learns each machine's enrolled public key and role (the checker). */
export interface MachineDirectory {
  /** null = not enrolled. Throws when the directory cannot be asked. */
  lookup(machine: string): Promise<MachineRecord | null>;
}

export class HttpMachineDirectory implements MachineDirectory {
  constructor(
    private baseUrl = process.env.CHECKER_URL ?? `http://localhost:${env.checkerPort}`,
    private timeoutMs = 2000,
  ) {}

  async lookup(machine: string): Promise<MachineRecord | null> {
    const res = await fetch(`${this.baseUrl}/machine/${encodeURIComponent(machine)}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`checker http ${res.status}`);
    const b = (await res.json()) as Partial<MachineRecord>;
    if (typeof b.publicKey !== "string" || typeof b.role !== "string") throw new Error("checker gave no machine record");
    return { machine, publicKey: b.publicKey as Hex, role: b.role, ...(b.profile ? { profile: String(b.profile) } : {}) };
  }
}

/** Fixed directory for tests. */
export const staticDirectory = (records: MachineRecord[]): MachineDirectory => ({
  async lookup(machine) {
    return records.find((r) => r.machine === machine) ?? null;
  },
});

export function allowedRolesFromEnv(v = process.env.GATE_ALLOWED_ROLES): string[] {
  const roles = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return roles.length ? roles : DEFAULT_ALLOWED_ROLES;
}

/** Remembers (machine, nonce) pairs for longer than a request can stay fresh. Bounded; oldest go first. */
export class ReplayCache {
  private seen = new Map<string, number>(); // key -> forget-after (ms); insertion order = age order
  constructor(
    private ttlMs = 2 * REQUEST_MAX_AGE_MS,
    private max = REPLAY_CACHE_MAX,
  ) {}

  /** true if new (and now remembered), false if seen before. */
  remember(key: string, nowMs: number): boolean {
    for (const [k, until] of this.seen) {
      if (until > nowMs) break;
      this.seen.delete(k);
    }
    if (this.seen.has(key)) return false;
    this.seen.set(key, nowMs + this.ttlMs);
    // Only signed, fresh requests reach here, so filling it takes a machine key; evicting the oldest is safe
    // once the cache is bigger than one freshness window can produce.
    while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value!);
    return true;
  }

  get size() {
    return this.seen.size;
  }
}

export interface SignedFields {
  nonce: string;
  sentAt: number;
  signature: string;
}

/** The signed-request fields on top of the plain request. Missing or malformed = unsigned = 403 bad-signature. */
export function parseSignedFields(body: unknown): { ok: true; value: SignedFields } | { ok: false; reason: "bad-signature"; detail: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const bad = (detail: string) => ({ ok: false as const, reason: "bad-signature" as const, detail });
  if (typeof b.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(b.signature)) {
    return bad("unsigned request: signature missing or malformed; requests must be signed with the machine key (npm run request -- --machine <name> ...)");
  }
  if (typeof b.nonce !== "string" || !/^[0-9a-fA-F]{16,64}$/.test(b.nonce)) return bad("unsigned request: nonce must be 16-64 hex chars");
  if (typeof b.sentAt !== "number" || !Number.isSafeInteger(b.sentAt) || b.sentAt <= 0) return bad("unsigned request: sentAt must be unix ms");
  return { ok: true, value: { nonce: b.nonce, sentAt: b.sentAt, signature: b.signature } };
}

export type AuthResult = { ok: true; machine: MachineRecord } | { ok: false; reason: AuthRefusal; detail: string };

export class RequestAuthenticator {
  constructor(
    private directory: MachineDirectory,
    private allowedRoles: string[] = DEFAULT_ALLOWED_ROLES,
    private replay = new ReplayCache(),
    private maxAgeMs = REQUEST_MAX_AGE_MS,
  ) {}

  /** `req` is the already-parsed plain request (amount normalised); `body` is the raw body for the signed fields. */
  async check(req: GateRequest, body: unknown, nowMs = Date.now()): Promise<AuthResult> {
    const f = parseSignedFields(body);
    if (!f.ok) return f;
    let m: MachineRecord | null;
    try {
      m = await this.directory.lookup(req.machine);
    } catch (e) {
      return { ok: false, reason: "unknown-machine", detail: `could not look up ${req.machine} at the checker (failing closed): ${(e as Error).message}` };
    }
    if (!m) return { ok: false, reason: "unknown-machine", detail: `${req.machine} is not enrolled with the checker` };
    const payload: RequestPayload = { machine: req.machine, to: req.to, amount: req.amount, kind: req.kind, nonce: f.value.nonce, sentAt: f.value.sentAt };
    if (!(await verifyRequestSignature(m.publicKey, payload, f.value.signature))) {
      return { ok: false, reason: "bad-signature", detail: `signature does not match ${req.machine}'s enrolled key` };
    }
    const age = nowMs - f.value.sentAt;
    if (Math.abs(age) > this.maxAgeMs) {
      return { ok: false, reason: "stale-request", detail: `sentAt is ${Math.round(age / 1000)} s from the gate clock (max ${this.maxAgeMs / 1000} s)` };
    }
    if (!this.replay.remember(`${req.machine}:${f.value.nonce.toLowerCase()}`, nowMs)) {
      return { ok: false, reason: "replayed-request", detail: "this nonce was already used" };
    }
    if (!this.allowedRoles.includes(m.role)) {
      return { ok: false, reason: "wrong-role", detail: `role ${m.role} may not request money moves (allowed: ${this.allowedRoles.join(", ")})` };
    }
    return { ok: true, machine: m };
  }
}
