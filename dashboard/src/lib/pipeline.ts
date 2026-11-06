// Pipeline row for the one rule: Request (issuer app) → Receipt (Hedera) → Transfer → Check.
// Check ends in ✓ (matched to its receipt) or ✗ (no receipt: the contract contains it).
// Pure reducer from service events to node tones + the connector pulses to animate.
// SSE replays history on (re)connect, so events older than FRESH_MS never light the row.

export const NODES = ["request", "receipt", "transfer", "check"] as const;
export type NodeId = (typeof NODES)[number];
export const NODE_LABEL: Record<NodeId, string> = {
  request: "Request",
  receipt: "Receipt",
  transfer: "Transfer",
  check: "Check",
};
export const NODE_SUB: Record<NodeId, string> = {
  request: "issuer app",
  receipt: "on Hedera",
  transfer: "from treasury",
  check: "✓ matched · ✗ contain",
};

/** idle · ok (olive) · refused (neutral amber, never red) · breach (red, live only) · settled (olive after a breach) */
export type Tone = "idle" | "ok" | "refused" | "breach" | "settled";

export interface PipelineState {
  nodes: Record<NodeId, { tone: Tone; at: number }>;
  /** connector i joins node i and i+1; key restarts the CSS pulse */
  links: { tone: Tone; key: number }[];
  caption: string;
  seq: number;
}

export type PipelineAction =
  | { type: "approved"; eventMs: number; now: number }
  | { type: "refused"; reason: string; eventMs: number; now: number }
  | { type: "matched"; eventMs: number; now: number }
  | { type: "breach"; eventMs: number; now: number; historic?: boolean }
  | { type: "contained"; seconds: number; now: number }
  | { type: "tick"; now: number };

export const FRESH_MS = 60_000;
export const SETTLE_MS = 9_000;
const idleNode = { tone: "idle" as Tone, at: 0 };

export const initialPipeline: PipelineState = {
  nodes: Object.fromEntries(NODES.map((n) => [n, idleNode])) as PipelineState["nodes"],
  links: NODES.slice(1).map(() => ({ tone: "idle" as Tone, key: 0 })),
  caption: "Waiting for the next treasury move",
  seq: 0,
};

function light(s: PipelineState, now: number, tones: Partial<Record<NodeId, Tone>>, linkIdx: number[], linkTone: Tone, caption: string, reset = false): PipelineState {
  const seq = s.seq + 1;
  const nodes = { ...(reset ? initialPipeline.nodes : s.nodes) };
  for (const [k, t] of Object.entries(tones) as [NodeId, Tone][]) nodes[k] = { tone: t, at: now };
  const links = (reset ? initialPipeline.links : s.links).map((l, i) => (linkIdx.includes(i) ? { tone: linkTone, key: seq * 10 + i } : l));
  return { nodes, links, caption, seq };
}

const fresh = (a: { eventMs: number; now: number }) => a.now - a.eventMs <= FRESH_MS;

export function pipelineReducer(s: PipelineState, a: PipelineAction): PipelineState {
  const breachLive = s.nodes.check.tone === "breach";
  switch (a.type) {
    case "approved":
      if (!fresh(a) || breachLive) return s;
      return light(s, a.now, { request: "ok", receipt: "ok", transfer: "ok" }, [0, 1], "ok", "Receipt written on Hedera, then the tokens were sent", true);
    case "refused":
      if (!fresh(a) || breachLive) return s;
      return light(s, a.now, { request: "refused", receipt: "refused" }, [0], "refused", `Refused, no receipt written: ${a.reason}`, true);
    case "matched":
      if (!fresh(a) || breachLive) return s;
      return light(s, a.now, { transfer: "ok", check: "ok" }, [2], "ok", "Check ✓ the transfer matched its receipt");
    case "breach":
      if (a.historic || !fresh(a)) return s;
      return light(s, a.now, { transfer: "breach", check: "breach" }, [2], "breach", "Check ✗ no receipt: freezing the treasury and clawing the tokens back", true);
    case "contained": {
      if (!breachLive) return s;
      const next = light(s, a.now, { transfer: "settled", check: "settled" }, [], "settled", `Contained in ${a.seconds.toFixed(2)} s`);
      next.links = next.links.map((l) => (l.tone === "breach" ? { ...l, tone: "settled" } : l));
      return next;
    }
    case "tick": {
      if (breachLive) return s;
      let changed = false;
      const nodes = { ...s.nodes };
      for (const n of NODES) {
        const v = nodes[n];
        if (v.tone !== "idle" && a.now - v.at > SETTLE_MS) {
          nodes[n] = idleNode;
          changed = true;
        }
      }
      if (!changed) return s;
      const allIdle = NODES.every((n) => nodes[n].tone === "idle");
      return { ...s, nodes, links: allIdle ? initialPipeline.links : s.links, caption: allIdle ? initialPipeline.caption : s.caption };
    }
  }
}
