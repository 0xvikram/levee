// Small helpers shared by the live demo scripts (gate requests, watcher SSE, links).
import { env, readState, type DeployState } from "../../src/shared/config.js";
import { signedRequest } from "../../src/agent/request.js";

// Lazy-tolerant: unit tests import the pure helpers on machines without state/deploy.json.
export const state: DeployState = (() => {
  try {
    return readState();
  } catch {
    return { token: { decimals: 6 } } as DeployState;
  }
})();
export const GATE = process.env.GATE_URL ?? `http://localhost:${env.gatePort}`;
export const WATCHER = process.env.WATCHER_URL ?? `http://localhost:${env.watcherPort}`;
export const CHECKER = process.env.CHECKER_URL ?? `http://localhost:${env.checkerPort}`;
export const units = (whole: number | bigint): string => (BigInt(whole) * 10n ** BigInt(state.token.decimals)).toString();
export const hashscanTx = (txId: string) => `https://hashscan.io/testnet/transaction/${txId}`;
export const hashscanTopic = (topic: string) => `https://hashscan.io/testnet/topic/${topic}`;
export const hashscanAccount = (id: string) => `https://hashscan.io/testnet/account/${id}`;

export interface GateReply {
  status: number;
  ms: number;
  body: { ok: boolean; reason?: string; detail?: string; txId?: string; receiptTxId?: string; receipt?: { sequence?: number }; timings?: Record<string, number> };
}

/** POST a request to the gate, signed with the machine's own key (state/machine-<name>.key). */
export async function gateRequest(machine: string, to: string, amount: string, kind: "transfer" | "mint" = "transfer"): Promise<GateReply> {
  const body = await signedRequest(machine, { to, amount, kind });
  const t0 = Date.now();
  const r = await fetch(`${GATE}/request`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, ms: Date.now() - t0, body: (await r.json()) as GateReply["body"] };
}

export async function getJson<T = any>(url: string): Promise<T> {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return (await r.json()) as T;
}

export interface SseFrame {
  id?: string;
  event: string;
  data: any;
  receivedAt: number;
}

/** Parse an SSE text buffer into complete frames; returns frames and the unconsumed rest. */
export function parseSse(buf: string, now = Date.now()): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  const parts = buf.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  for (const block of parts) {
    let event = "message";
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const k = i < 0 ? line : line.slice(0, i);
      const v = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (k === "event") event = v;
      else if (k === "data") data.push(v);
      else if (k === "id") id = v;
    }
    if (!data.length) continue;
    let parsed: unknown = data.join("\n");
    try {
      parsed = JSON.parse(parsed as string);
    } catch {
      /* keep text */
    }
    frames.push({ id, event, data: parsed, receivedAt: now });
  }
  return { frames, rest };
}

/** Subscribe to an SSE endpoint; calls onFrame for each frame until stop() is called. */
export function subscribe(url: string, onFrame: (f: SseFrame) => void): { stop: () => void; ready: Promise<void> } {
  const ac = new AbortController();
  let markReady: () => void = () => {};
  const ready = new Promise<void>((r) => (markReady = r));
  (async () => {
    const res = await fetch(url, { signal: ac.signal });
    markReady();
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const { frames, rest } = parseSse(buf);
      buf = rest;
      for (const f of frames) onFrame(f);
    }
  })().catch(() => markReady());
  return { stop: () => ac.abort(), ready };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
