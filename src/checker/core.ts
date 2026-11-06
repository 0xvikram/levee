// Checker logic, free of HTTP so it can be unit-tested with a MemoryPassStore.
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { Hex } from "viem";
import type { PassStore } from "../shared/arkiv.js";
import { failingChecks, verifySigned, type SignedHeartbeat } from "../agent/protocol.js";
import { isProfile, type Profile } from "../agent/checks.js";

export const NONCE_TTL_MS = 60_000;
export const MAX_BLOCK_AGE_S = 10;
export const MAX_CLOCK_SKEW_MS = 120_000;

export interface MachineState {
  machine: string;
  role: string;
  /** fixed at enrolment; older state files have none = laptop */
  profile?: Profile;
  publicKey: Hex;
  lastSeq: number;
  lastHeartbeatAt: number | null;
  lastGoodAt: number | null;
  /** true when the most recent heartbeat had a failing check: pass is denied at once */
  denied: boolean;
  reason: string | null;
  checks: Record<string, string>;
}

export type PassKind = "ok" | "offline" | "unhealthy" | "unverifiable" | "unknown";

export interface PassView {
  machine: string;
  live: boolean;
  kind: PassKind;
  expiresAt: string | null;
  reason: string | null;
  arkivEntityKey: string | null;
  arkivBlockAgeSeconds: number | null;
  checks?: Record<string, string>;
  lastHeartbeatAt?: string | null;
  profile?: Profile;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface CoreOptions {
  store: PassStore;
  passSeconds: number;
  now?: () => number;
  stateFile?: string; // persist enrolments across restarts
  enrolToken?: string;
}

export class CheckerCore {
  readonly events = new EventEmitter();
  private machines = new Map<string, MachineState>();
  private nonces = new Map<string, { machine: string; expires: number }>();
  private now: () => number;

  constructor(private o: CoreOptions) {
    this.now = o.now ?? Date.now;
    if (o.stateFile && fs.existsSync(o.stateFile)) {
      for (const m of JSON.parse(fs.readFileSync(o.stateFile, "utf8")) as MachineState[]) this.machines.set(m.machine, m);
    }
  }

  private persist() {
    if (!this.o.stateFile) return;
    fs.mkdirSync(path.dirname(this.o.stateFile), { recursive: true });
    fs.writeFileSync(this.o.stateFile, JSON.stringify([...this.machines.values()], null, 2));
  }

  private emit(type: string, data: unknown) {
    this.events.emit("event", { type, at: this.now(), data });
  }

  enrol(body: { machine?: string; publicKey?: string; role?: string; profile?: string }, token?: string) {
    if (this.o.enrolToken && token !== this.o.enrolToken) throw new HttpError(401, "bad enrol token");
    const { machine, publicKey } = body;
    const role = body.role ?? "employee";
    if (!machine || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(machine)) throw new HttpError(400, "bad machine name");
    if (!publicKey || !/^0x04[0-9a-fA-F]{128}$/.test(publicKey)) throw new HttpError(400, "publicKey must be an uncompressed secp256k1 key (0x04...)");
    if (!/^[\w .-]{1,32}$/.test(role)) throw new HttpError(400, "bad role");
    const profile = body.profile ?? "laptop";
    if (!isProfile(profile)) throw new HttpError(400, "profile must be laptop, server or ci");
    const cur = this.machines.get(machine);
    if (cur && cur.publicKey.toLowerCase() !== publicKey.toLowerCase()) throw new HttpError(409, "machine already enrolled with another key");
    // The profile decides which checks may be skipped, so it can never change after enrolment.
    if (cur && (cur.profile ?? "laptop") !== profile) throw new HttpError(409, `machine already enrolled with profile ${cur.profile ?? "laptop"}`);
    if (!cur) {
      this.machines.set(machine, { machine, role, profile, publicKey: publicKey as Hex, lastSeq: 0, lastHeartbeatAt: null, lastGoodAt: null, denied: false, reason: null, checks: {} });
      this.persist();
      this.emit("enrol", { machine, role, profile });
    }
    return { ok: true, machine, role: cur?.role ?? role, profile };
  }

  nonce(machine: string | undefined) {
    if (!machine || !this.machines.has(machine)) throw new HttpError(404, "unknown machine");
    const t = this.now();
    for (const [n, v] of this.nonces) if (v.expires < t) this.nonces.delete(n);
    const nonce = randomBytes(16).toString("hex");
    this.nonces.set(nonce, { machine, expires: t + NONCE_TTL_MS });
    return { nonce, ttlSeconds: NONCE_TTL_MS / 1000 };
  }

  async heartbeat(hb: SignedHeartbeat) {
    const p = hb?.payload;
    if (!p || typeof p.machine !== "string" || typeof hb.signature !== "string") throw new HttpError(400, "malformed heartbeat");
    const m = this.machines.get(p.machine);
    if (!m) throw new HttpError(404, "unknown machine");
    // nonce first, and always burn it: a replayed or stolen heartbeat can never be accepted twice
    const n = this.nonces.get(p.nonce);
    this.nonces.delete(p.nonce);
    if (!n || n.machine !== p.machine || n.expires < this.now()) throw new HttpError(400, "nonce unknown, expired or already used");
    if (!(await verifySigned(m.publicKey, hb))) throw new HttpError(401, "bad signature");
    if (!Number.isInteger(p.seq) || p.seq <= m.lastSeq) throw new HttpError(409, `seq must increase (last ${m.lastSeq})`);
    if (Math.abs(this.now() - p.sentAt) > MAX_CLOCK_SKEW_MS) throw new HttpError(400, "sentAt too far from checker clock");
    const profile = m.profile ?? "laptop";
    if (p.profile !== undefined && p.profile !== profile) throw new HttpError(400, `heartbeat profile ${String(p.profile)} does not match enrolled profile ${profile}`);
    m.lastSeq = p.seq;
    m.lastHeartbeatAt = this.now();
    m.checks = p.checks;
    const failing = failingChecks(p.checks ?? {}, profile);
    if (failing.length) {
      m.denied = true;
      m.reason = `check failed: ${failing.join(", ")}`;
      this.persist();
      // do not renew; also revoke on Arkiv right away (best effort, expiry would catch it anyway)
      let revoked = false;
      try {
        revoked = await this.o.store.revokePass(m.machine);
      } catch {
        /* expiry will still remove it */
      }
      this.emit("heartbeat", { machine: m.machine, ok: false, failing, revoked });
      return { ok: false, renewed: false, reason: m.reason };
    }
    try {
      const rec = await this.o.store.upsertPass({ machine: m.machine, role: m.role, postureHash: p.evidenceHash, status: "live" }, this.o.passSeconds);
      m.denied = false;
      m.reason = null;
      m.lastGoodAt = this.now();
      this.persist();
      this.emit("heartbeat", { machine: m.machine, ok: true, expiresAtMs: rec.expiresAtMs, entityKey: rec.entityKey });
      return { ok: true, renewed: true, expiresAt: new Date(rec.expiresAtMs).toISOString(), arkivEntityKey: rec.entityKey };
    } catch (e) {
      m.reason = "arkiv write failed";
      this.persist();
      this.emit("heartbeat", { machine: m.machine, ok: true, renewed: false, error: (e as Error).message });
      throw new HttpError(503, `arkiv write failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }

  /** Gate question. Fails closed on anything it cannot verify. */
  async pass(machine: string): Promise<PassView> {
    const base = { machine, arkivEntityKey: null, arkivBlockAgeSeconds: null as number | null, expiresAt: null };
    const m = this.machines.get(machine);
    if (!m) return { ...base, live: false, kind: "unknown", reason: "unknown machine" };
    const extra = { checks: m.checks, profile: m.profile ?? "laptop", lastHeartbeatAt: m.lastHeartbeatAt ? new Date(m.lastHeartbeatAt).toISOString() : null };
    let age: number | null = null;
    try {
      age = await this.o.store.latestBlockAge();
    } catch {
      age = null;
    }
    const withAge = { ...base, ...extra, arkivBlockAgeSeconds: age };
    if (m.denied) return { ...withAge, live: false, kind: "unhealthy", reason: m.reason };
    if (age === null) return { ...withAge, live: false, kind: "unverifiable", reason: "arkiv unreachable (failing closed)" };
    if (age >= MAX_BLOCK_AGE_S) return { ...withAge, live: false, kind: "unverifiable", reason: `arkiv latest block is ${age.toFixed(0)}s old (failing closed)` };
    let rec;
    try {
      rec = await this.o.store.getPass(machine);
    } catch (e) {
      return { ...withAge, live: false, kind: "unverifiable", reason: `arkiv read failed: ${(e as Error).message.split("\n")[0]}` };
    }
    if (!rec) {
      const quiet = m.lastGoodAt ? `no heartbeat for ${Math.round((this.now() - m.lastGoodAt) / 1000)}s, pass expired (machine offline or asleep, not a breach)` : "no pass yet (no healthy heartbeat received)";
      return { ...withAge, live: false, kind: "offline", reason: quiet };
    }
    const withRec = { ...withAge, arkivEntityKey: rec.entityKey, expiresAt: new Date(rec.expiresAtMs).toISOString() };
    if (rec.owner.toLowerCase() !== this.o.store.checkerAddress.toLowerCase()) return { ...withRec, live: false, kind: "unverifiable", reason: "pass entity is not owned by the checker wallet" };
    if (rec.expiresAtMs <= this.now()) return { ...withRec, live: false, kind: "offline", reason: "pass expired" };
    return { ...withRec, live: true, kind: "ok", reason: null };
  }

  async passes(): Promise<PassView[]> {
    return Promise.all([...this.machines.keys()].map((k) => this.pass(k)));
  }
}
