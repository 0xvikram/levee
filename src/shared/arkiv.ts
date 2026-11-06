// Arkiv pass store for Leash. One 'pass' entity per machine on Arkiv (Rabdi testnet).
// Only the checker wallet owns/extends passes; permissionlessExtension is explicitly OFF.
// Expiry on Arkiv is the liveness signal: no good heartbeat -> the entity expires -> no pass.
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, eq } from "@arkiv-network/sdk/query";
import { defineSchema, str } from "@arkiv-network/sdk/schema";
import { http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "./config.js";

export type PassStatus = "live" | "unhealthy";

export interface PassInput {
  machine: string;
  role: string;
  postureHash: string;
  status: PassStatus;
}

export interface PassRecord extends PassInput {
  entityKey: string;
  owner: string;
  expiresAtMs: number; // wall-clock estimate of expiry
}

export interface PassStore {
  /** wallet that owns every pass this store writes (the checker) */
  readonly checkerAddress: string;
  /** create the pass if missing, else patch changed fields and extend expiry to now+ttl */
  upsertPass(p: PassInput, ttlSeconds: number): Promise<PassRecord>;
  /** extend only (no attribute change); null if there is no live pass */
  extendPass(machine: string, ttlSeconds: number): Promise<PassRecord | null>;
  /** delete the pass entity now (immediate revocation; expiry alone would take up to ttl) */
  revokePass(machine: string): Promise<boolean>;
  /** null when missing or expired */
  getPass(machine: string): Promise<PassRecord | null>;
  listPasses(): Promise<PassRecord[]>;
  /** seconds since the latest block; null when Arkiv is unreachable */
  latestBlockAge(): Promise<number | null>;
}

// ---------------- in-memory store (tests, offline demo) ----------------

export class MemoryPassStore implements PassStore {
  readonly checkerAddress: string;
  blockAge: number | null = 1;
  private rows = new Map<string, PassRecord>();
  private n = 0;
  constructor(private now: () => number = Date.now, checkerAddress = "0xChecker") {
    this.checkerAddress = checkerAddress;
  }
  private live(r: PassRecord | undefined) {
    return r && r.expiresAtMs > this.now() ? r : null;
  }
  async upsertPass(p: PassInput, ttlSeconds: number) {
    const cur = this.live(this.rows.get(p.machine));
    const rec: PassRecord = cur
      ? { ...cur, ...p }
      : { ...p, entityKey: `0xmem${(++this.n).toString(16).padStart(60, "0")}`, owner: this.checkerAddress, expiresAtMs: 0 };
    rec.expiresAtMs = Math.max(rec.expiresAtMs, this.now() + ttlSeconds * 1000); // never shortens, like Arkiv
    this.rows.set(p.machine, rec);
    return { ...rec };
  }
  async extendPass(machine: string, ttlSeconds: number) {
    const cur = this.live(this.rows.get(machine));
    if (!cur) return null;
    cur.expiresAtMs = Math.max(cur.expiresAtMs, this.now() + ttlSeconds * 1000);
    return { ...cur };
  }
  async revokePass(machine: string) {
    return this.rows.delete(machine);
  }
  async getPass(machine: string) {
    const r = this.live(this.rows.get(machine));
    return r ? { ...r } : null;
  }
  async listPasses() {
    return [...this.rows.values()].filter((r) => this.live(r)).map((r) => ({ ...r }));
  }
  async latestBlockAge() {
    return this.blockAge;
  }
  /** test helper: plant a pass owned by someone else (an attacker-created entity) */
  injectForeign(p: PassInput, owner: string, ttlSeconds: number) {
    this.rows.set(p.machine, { ...p, entityKey: "0xforeign", owner, expiresAtMs: this.now() + ttlSeconds * 1000 });
  }
}

// ---------------- real Arkiv store ----------------

export const PassSchema = defineSchema("levee.pass.v1", {
  machine: str().indexed(),
  role: str().indexed(),
  postureHash: str().indexed(),
  status: str().indexed(),
});

const BLOCK_SECONDS = 2;
const evenSeconds = (s: number) => Math.ceil(s / BLOCK_SECONDS) * BLOCK_SECONDS;

interface PendingOp {
  kind: "create" | "patch" | "extend" | "delete";
  machine: string;
  input?: PassInput;
  ttl: number;
  resolve: () => void;
  reject: (e: unknown) => void;
}

export class ArkivPassStore implements PassStore {
  readonly checkerAddress: string;
  private pub;
  private wallet;
  private keys = new Map<string, Hex>(); // machine -> entity key cache (getEntity is not rate limited like arkiv_query)
  private known = new Map<string, PassInput>(); // last attributes written, to skip no-op patches
  private queue: PendingOp[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private blockCache: { at: number; age: number | null } | null = null;
  private timing: { block: number; time: number; duration: number } | null = null;

  constructor(privateKey = env.arkivPrivateKey, accessKey = env.arkivAccessKey, private batchWindowMs = 300) {
    if (!privateKey) throw new Error("ARKIV_PRIVATE_KEY is not set");
    const account = privateKeyToAccount((privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex);
    this.checkerAddress = account.address;
    const chain = rabdi({ accessKey });
    this.pub = createPublicClient({ chain, transport: http() });
    this.wallet = createWalletClient({ chain, transport: http(), account });
  }

  async balance(): Promise<bigint> {
    return this.pub.getBalance({ address: this.checkerAddress as Hex });
  }

  private enqueue(op: Omit<PendingOp, "resolve" | "reject">): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ ...op, resolve, reject });
      if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.batchWindowMs);
    });
  }

  /** All writes queued inside one window go out as ONE executeBatch transaction (one block). */
  async flush(): Promise<void> {
    this.timer = null;
    const ops = this.queue.splice(0);
    if (!ops.length) return;
    const sendBatch = async (list: PendingOp[]) => {
      const creates = list.filter((o) => o.kind === "create");
      const patches = list.filter((o) => o.kind === "patch");
      const extendsOps = list.filter((o) => o.kind === "extend" || o.kind === "patch");
      const deletes = list.filter((o) => o.kind === "delete");
      const res = await this.wallet.executeBatch({
        creates: creates.map((o) => ({
          schema: PassSchema,
          values: { ...o.input! },
          expiration: ExpirationTime.fromSeconds(evenSeconds(o.ttl)),
          flags: { readonly: false, permissionlessExtension: false },
        })),
        patches: patches.map((o) => ({ schema: PassSchema, entityKey: this.keys.get(o.machine)!, set: { ...o.input! } })),
        deletes: deletes.map((o) => ({ entityKey: this.keys.get(o.machine)! })),
        extensions: extendsOps.map((o) => ({ entityKey: this.keys.get(o.machine)!, expiration: ExpirationTime.fromSeconds(evenSeconds(o.ttl)) })),
      } as never);
      creates.forEach((o, i) => this.keys.set(o.machine, (res as { createdEntities: Hex[] }).createdEntities[i]));
    };
    try {
      await sendBatch(ops);
      ops.forEach((o) => o.resolve());
    } catch (batchErr) {
      if (ops.length === 1) return ops[0].reject(batchErr);
      for (const o of ops) {
        // isolate the failing op (e.g. an extend that would shorten expiry)
        try {
          await sendBatch([o]);
          o.resolve();
        } catch (e) {
          o.reject(e);
        }
      }
    }
  }

  private async blockTiming() {
    const t = await this.pub.getBlockTiming();
    this.timing = { block: Number(t.currentBlock), time: t.currentBlockTime, duration: t.blockDuration };
    return this.timing;
  }

  async getPass(machine: string): Promise<PassRecord | null> {
    let key = this.keys.get(machine);
    if (!key) {
      // Discovery by query (rate limited without an access key), only owner-created passes count.
      const res = await this.pub
        .select({ $key: true })
        .from(PassSchema)
        .where(eq("machine", machine))
        .ownedBy(this.checkerAddress as Hex)
        .limit(1)
        .fetch();
      key = res.entities[0]?.$key as Hex | undefined;
      if (!key) return null;
      this.keys.set(machine, key);
    }
    let e;
    try {
      e = await this.pub.getEntity(key, PassSchema);
    } catch (err) {
      if ((err as Error).name === "NoEntityFoundError") {
        this.keys.delete(machine);
        return null;
      }
      throw err;
    }
    return this.toRecord(e as never);
  }

  private async toRecord(e: Record<string, any>): Promise<PassRecord> {
    const t = await this.blockTiming();
    const expiresBlock = Number(e.$expiresAt);
    const expiresAtMs = (t.time + (expiresBlock - t.block) * t.duration) * 1000;
    const rec: PassRecord = {
      machine: e.machine.value,
      role: e.role.value,
      postureHash: e.postureHash.value,
      status: e.status.value,
      entityKey: e.$key,
      owner: e.$owner,
      expiresAtMs,
    };
    this.keys.set(rec.machine, rec.entityKey as Hex);
    this.known.set(rec.machine, { machine: rec.machine, role: rec.role, postureHash: rec.postureHash, status: rec.status });
    return rec;
  }

  async listPasses(): Promise<PassRecord[]> {
    const res = await this.pub.select().from(PassSchema).ownedBy(this.checkerAddress as Hex).limit(100).fetch();
    const out: PassRecord[] = [];
    for (const e of res.entities) out.push(await this.toRecord(e as never));
    return out;
  }

  async upsertPass(p: PassInput, ttlSeconds: number): Promise<PassRecord> {
    const cur = await this.getPass(p.machine);
    if (!cur) {
      await this.enqueue({ kind: "create", machine: p.machine, input: p, ttl: ttlSeconds });
    } else {
      const same = cur.role === p.role && cur.postureHash === p.postureHash && cur.status === p.status;
      await this.enqueue({ kind: same ? "extend" : "patch", machine: p.machine, input: p, ttl: ttlSeconds });
    }
    const after = await this.getPass(p.machine);
    if (!after) throw new Error("pass not readable after write");
    return after;
  }

  async revokePass(machine: string): Promise<boolean> {
    const cur = await this.getPass(machine);
    if (!cur) return false;
    await this.enqueue({ kind: "delete", machine, ttl: 0 });
    this.keys.delete(machine);
    this.known.delete(machine);
    return true;
  }

  async extendPass(machine: string, ttlSeconds: number): Promise<PassRecord | null> {
    const cur = await this.getPass(machine);
    if (!cur) return null;
    await this.enqueue({ kind: "extend", machine, ttl: ttlSeconds });
    return this.getPass(machine);
  }

  async latestBlockAge(): Promise<number | null> {
    const now = Date.now();
    if (this.blockCache && now - this.blockCache.at < 1000) return this.blockCache.age;
    let age: number | null = null;
    try {
      const b = await this.pub.getBlock();
      age = Math.max(0, now / 1000 - Number(b.timestamp));
    } catch {
      age = null;
    }
    this.blockCache = { at: now, age };
    return age;
  }
}

export function createPassStore(): PassStore {
  return new ArkivPassStore();
}
