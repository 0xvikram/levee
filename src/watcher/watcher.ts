// Watcher core (I/O injected so a whole tick can be tested offline).
// Every tick: read new treasury / token-treasury transactions FIRST, then new receipts
// (so any receipt that reached consensus before a movement we saw is already readable),
// match, and contain breaches.
import type { Breach, Movement, Receipt, Rules } from "../shared/types.js";
import {
  extractAllowances,
  extractMovements,
  type MirrorClient,
  type MirrorTransaction,
} from "../shared/mirror.js";
import { receiptFromMessage, type IncidentOut } from "../shared/hcs.js";
import { compareConsensus, consensusToMs } from "../shared/txid.js";
import { matchMovements, newMatchState, type MatchState } from "./match.js";
import {
  buildIncident,
  executeContainment,
  firstBreachAt,
  incidentIdFor,
  planContainment,
  type ContainmentState,
  type ControllerCall,
  type WatcherBreach,
} from "./contain.js";

export type WatcherMirror = Pick<
  MirrorClient,
  "transactionsSince" | "topicMessagesSince" | "tokenRelationship" | "tokenInfo" | "latestBlockTimestamp"
>;

export interface WatcherConfig {
  token: string;
  treasury: string;
  tokenTreasury: string;
  receiptsTopic: string;
  rules: Rules;
  pauseOnBreach: boolean;
  maxLagMs?: number; // default 20 s
  /**
   * How long a movement with no receipt yet may wait for its receipt to become readable before it
   * is a "no-receipt" breach. Needed because the Mirror Node's REST endpoints are served by several
   * replicas: a fresh one can return the transfer while the next request (topic messages) lands on
   * one a second behind, which raised a false alarm live (docs/LIVE_RUN.md). It cannot excuse a real
   * breach: the receipt must still have reached consensus BEFORE the movement, and the wait ends
   * early once any receipt with a later consensus time has been read (the read is then complete).
   * Default 0 (judge at once); the service sets WATCHER_RECEIPT_GRACE_MS (default 3000).
   */
  receiptGraceMs?: number;
}

export interface WatcherDeps {
  mirror: WatcherMirror;
  call: ControllerCall;
  publishIncident: (i: IncidentOut) => Promise<void>;
  emit?: (event: string, data: unknown) => void;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface BreachView {
  txId: string;
  reason: string;
  to?: string;
  amount?: string;
  kind?: string;
  consensusAt: string;
  historic?: boolean;
}

export const toView = (b: WatcherBreach, historic = false): BreachView =>
  b.reason === "treasury-allowance"
    ? { txId: b.allowance.txId, reason: b.reason, consensusAt: b.allowance.consensusAt, ...(historic ? { historic } : {}) }
    : {
        txId: b.movement.txId,
        reason: b.reason,
        to: b.movement.to,
        amount: b.movement.amount,
        kind: b.movement.kind,
        consensusAt: b.movement.consensusAt,
        ...(historic ? { historic } : {}),
      };

/** Dedupe raw Mirror records (the same record can come back for both watched accounts). */
export function dedupeTxs(txs: MirrorTransaction[]): MirrorTransaction[] {
  const seen = new Map<string, MirrorTransaction>();
  for (const t of txs) seen.set(`${t.consensus_timestamp}|${t.transaction_id}|${t.nonce ?? 0}`, t);
  return [...seen.values()].sort((a, b) => compareConsensus(a.consensus_timestamp, b.consensus_timestamp));
}

export class Watcher {
  readonly receipts = new Map<string, Receipt>();
  readonly match: MatchState = newMatchState();
  receiptSeq = 0;
  cursors: Record<string, string> = {};
  matchedCount = 0;
  breaches: BreachView[] = [];
  incidents: IncidentOut[] = [];
  invalidReceipts = 0;
  /** movements still waiting (within receiptGraceMs) for their receipt to be readable */
  readonly pending = new Map<string, { movement: Movement; firstSeenMs: number }>();
  /** highest consensus time of any receipts-topic message read so far (all earlier ones are read too) */
  receiptsReadTo = "0.0";
  lagMs = Number.POSITIVE_INFINITY; // fail closed until measured
  lastTickOkAt = 0;
  lastError: string | null = null;
  private now: () => number;

  constructor(
    readonly cfg: WatcherConfig,
    private deps: WatcherDeps,
    sinceTs: string,
  ) {
    this.now = deps.now ?? Date.now;
    for (const a of this.watched()) this.cursors[a] = sinceTs;
  }

  private watched(): string[] {
    return [...new Set([this.cfg.treasury, this.cfg.tokenTreasury])];
  }

  private emit(event: string, data: unknown) {
    this.deps.emit?.(event, data);
  }

  /** Healthy = mirror not lagging and a tick succeeded recently. Unhealthy watchers stop heartbeating. */
  healthy(): boolean {
    const max = this.cfg.maxLagMs ?? 20_000;
    return this.lastTickOkAt > 0 && this.lagMs <= max && this.now() - this.lastTickOkAt <= max;
  }

  /** Update read lag from the newest Mirror block. */
  async measureLag(): Promise<number> {
    const ts = await this.deps.mirror.latestBlockTimestamp();
    this.lagMs = ts ? Math.max(0, this.now() - consensusToMs(ts)) : Number.POSITIVE_INFINITY;
    return this.lagMs;
  }

  /**
   * One pass. `contain=false` is used when priming from the start of the day: matched
   * movements rebuild the daily spend, breaches are reported as historic but not acted on.
   */
  async tick(contain = true): Promise<{ matched: Movement[]; breaches: WatcherBreach[]; incident?: IncidentOut }> {
    try {
      // 1. movements first
      const pages = await Promise.all(this.watched().map((a) => this.deps.mirror.transactionsSince(a, this.cursors[a])));
      const nextCursors = { ...this.cursors };
      this.watched().forEach((a, i) => {
        const p = pages[i];
        if (p.length) nextCursors[a] = p[p.length - 1].consensus_timestamp;
      });
      const txs = dedupeTxs(pages.flat());

      // 2. then receipts
      const msgs = await this.deps.mirror.topicMessagesSince(this.cfg.receiptsTopic, this.receiptSeq);
      let seq = this.receiptSeq;
      for (const m of msgs) {
        seq = Math.max(seq, m.sequence);
        if (compareConsensus(m.consensusAt, this.receiptsReadTo) > 0) this.receiptsReadTo = m.consensusAt;
        const p = receiptFromMessage(m);
        if (!p.ok) {
          this.invalidReceipts++;
          continue;
        }
        if (!this.receipts.has(p.value.txId)) this.receipts.set(p.value.txId, p.value); // first (earliest) wins
      }
      this.receiptSeq = seq;
      this.cursors = nextCursors;

      // 3. match
      const opts = { token: this.cfg.token, treasury: this.cfg.treasury, tokenTreasury: this.cfg.tokenTreasury };
      const fresh = extractMovements(txs, opts);
      const movements = [...[...this.pending.values()].map((p) => p.movement), ...fresh];
      const res = matchMovements(movements, this.receipts, this.cfg.rules, this.match);
      res.breaches = this.holdForLateReceipts(res, fresh, contain);
      const allowances = extractAllowances(txs, this.cfg.treasury);
      const breaches: WatcherBreach[] = [...res.breaches, ...allowances.map((a) => ({ reason: "treasury-allowance" as const, allowance: a }))];
      this.matchedCount += res.matched.length;
      for (const m of res.matched) this.emit("matched", m);
      this.lastTickOkAt = this.now();
      this.lastError = null;

      if (breaches.length === 0) return { matched: res.matched, breaches };
      const views = breaches.map((b) => toView(b, !contain));
      this.breaches.push(...views);
      if (this.breaches.length > 200) this.breaches.splice(0, this.breaches.length - 200);
      for (const v of views) this.emit("breach", v);
      if (!contain) return { matched: res.matched, breaches };

      const incident = await this.contain(breaches);
      return { matched: res.matched, breaches, incident };
    } catch (e) {
      this.lastError = (e as Error).message;
      this.deps.log?.(`tick failed: ${this.lastError}`);
      throw e;
    }
  }

  /**
   * Movements whose only problem is "no receipt yet" wait up to receiptGraceMs (from first sight)
   * unless the receipts read already covers their consensus time. Returns the breaches to act on now.
   */
  private holdForLateReceipts(res: { matched: Movement[]; breaches: Breach[] }, fresh: Movement[], contain: boolean): Breach[] {
    const key = (m: Movement) => `${m.txId}|${m.to}|${m.amount}|${m.kind}`;
    const grace = contain ? (this.cfg.receiptGraceMs ?? 0) : 0;
    const now = this.now();
    for (const m of fresh) if (!this.pending.has(key(m))) this.pending.set(key(m), { movement: m, firstSeenMs: now });
    const keep: Breach[] = [];
    const waiting = new Set<string>();
    for (const b of res.breaches) {
      const k = key(b.movement);
      const p = this.pending.get(k);
      const covered = compareConsensus(this.receiptsReadTo, b.movement.consensusAt) > 0;
      if (b.reason === "no-receipt" && p && !covered && now - p.firstSeenMs < grace) {
        waiting.add(k);
        continue;
      }
      keep.push(b);
    }
    for (const k of [...this.pending.keys()]) if (!waiting.has(k)) this.pending.delete(k);
    return keep;
  }

  async containmentState(breaches: WatcherBreach[]): Promise<ContainmentState> {
    const accounts = new Set<string>([this.cfg.treasury, this.cfg.tokenTreasury]);
    for (const b of breaches) if (b.reason !== "treasury-allowance") accounts.add(b.movement.to);
    const frozen = new Set<string>();
    const balances = new Map<string, bigint>();
    const [info, ...rels] = await Promise.all([
      this.deps.mirror.tokenInfo(this.cfg.token).catch(() => null),
      ...[...accounts].map((a) =>
        this.deps.mirror
          .tokenRelationship(a, this.cfg.token)
          .then((r) => ({ a, r }))
          .catch(() => ({ a, r: null })),
      ),
    ]);
    for (const { a, r } of rels) {
      if (!r) continue;
      if (r.frozen) frozen.add(a);
      balances.set(a, r.balance);
    }
    return {
      treasury: this.cfg.treasury,
      tokenTreasury: this.cfg.tokenTreasury,
      frozen,
      balances,
      pauseOnBreach: this.cfg.pauseOnBreach,
      paused: info?.pause_status === "PAUSED",
    };
  }

  async contain(breaches: WatcherBreach[]): Promise<IncidentOut> {
    const detectedAtMs = this.now();
    const incidentId = incidentIdFor(breaches);
    const breachAt = firstBreachAt(breaches);
    this.emit("detected", { incidentId, breaches: breaches.map((b) => toView(b)), detectedMs: detectedAtMs - consensusToMs(breachAt) });
    const cs = await this.containmentState(breaches);
    const steps = planContainment(breaches, cs);
    this.emit("plan", { incidentId, steps });
    const results = await executeContainment(steps, incidentId, breachAt, async (s, id) => {
      const r = await this.deps.call(s, id);
      this.emit("step", { incidentId, step: s.step, account: s.account, amount: s.amount, txId: r.txId, atMs: this.now() - consensusToMs(breachAt) });
      return r;
    }, this.now);
    const incident = buildIncident({ incidentId, token: this.cfg.token, breaches, results, detectedAtMs });
    this.incidents.push(incident);
    if (this.incidents.length > 50) this.incidents.shift();
    this.emit("incident", incident);
    try {
      await this.deps.publishIncident(incident);
    } catch (e) {
      this.deps.log?.(`incident publish failed: ${(e as Error).message}`);
    }
    return incident;
  }

  snapshot() {
    return {
      healthy: this.healthy(),
      lagMs: Number.isFinite(this.lagMs) ? this.lagMs : null,
      matched: this.matchedCount,
      receipts: this.receipts.size,
      invalidReceipts: this.invalidReceipts,
      receiptSeq: this.receiptSeq,
      pendingReceipts: this.pending.size,
      cursors: this.cursors,
      breaches: this.breaches.slice(-50),
      incidents: this.incidents.slice(-20),
      lastTickOkAt: this.lastTickOkAt ? new Date(this.lastTickOkAt).toISOString() : null,
      lastError: this.lastError,
    };
  }
}

/** "seconds.nanos" for the start of the UTC day containing `ms`. */
export function startOfUtcDay(ms: number): string {
  const d = new Date(ms);
  return `${Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000)}.000000000`;
}
