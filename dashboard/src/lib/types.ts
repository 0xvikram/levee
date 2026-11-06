// Shapes the services emit (mirrors src/shared/types.ts, src/watcher/watcher.ts, src/checker/core.ts).
export interface Movement {
  txId: string;
  consensusAt: string;
  token: string;
  from: string | null;
  to: string;
  amount: string;
  kind: "transfer" | "mint";
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

export interface IncidentAction {
  step: string;
  account?: string;
  amount?: string;
  txId?: string;
  ok: boolean;
  atMs: number;
  error?: string;
}

export interface Incident {
  v: 1;
  type: "incident";
  incidentId: string;
  token: string;
  breaches: { txId: string; to: string; amount: string; reason: string }[];
  actions: IncidentAction[];
  detectedMs: number;
  containedMs?: number;
}

export interface WatcherSnapshot {
  healthy: boolean;
  lagMs: number | null;
  matched: number;
  receipts: number;
  breaches: BreachView[];
  incidents: Incident[];
  lastBeat?: string | null;
  lastError?: string | null;
  treasury?: string;
  token?: string;
}

export interface GateDecision {
  at: string;
  machine: string;
  to: string;
  amount: string;
  kind: "transfer" | "mint";
  ok: boolean;
  reason?: string;
  detail?: string;
  txId?: string;
}

export interface PassView {
  machine: string;
  live: boolean;
  kind: string;
  expiresAt: string | null;
  reason: string | null;
  arkivEntityKey?: string | null;
  lastHeartbeatAt?: string | null;
}

export interface CheckerEvent {
  type: string;
  at: number;
  data: { machine?: string; ok?: boolean; expiresAtMs?: number; renewed?: boolean; failing?: string[]; role?: string };
}
