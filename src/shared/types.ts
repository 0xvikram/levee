// Shared data shapes. Amounts are in the token's smallest unit (integer, as string or bigint).

/** Written by the gate to the HCS receipt topic BEFORE the transfer is submitted. */
export interface Receipt {
  v: 1;
  type: "receipt";
  txId: string; // normalised form: 0.0.123-1700000000-000000000
  token: string; // 0.0.x
  from: string; // 0.0.x
  to: string; // 0.0.x
  amount: string; // integer in smallest unit
  kind: "transfer" | "mint";
  machine: string; // which machine asked
  approvedAt: string; // ISO time, informational only
  /** consensus timestamp of the HCS message, filled in when read back from the Mirror Node */
  consensusAt?: string; // "seconds.nanos"
}

/** One treasury-relevant token movement seen on the Mirror Node. */
export interface Movement {
  txId: string; // normalised
  consensusAt: string; // "seconds.nanos"
  token: string;
  from: string | null; // null for a mint
  to: string;
  amount: string;
  kind: "transfer" | "mint";
}

export interface Rules {
  token: string;
  treasury: string;
  capPerTransfer: bigint;
  capPerDay: bigint;
  knownDestinations: string[];
}

export type BreachReason =
  | "no-receipt"
  | "receipt-after-movement"
  | "receipt-mismatch"
  | "receipt-reused"
  | "over-transfer-cap"
  | "over-daily-cap"
  | "unknown-destination";

export interface Breach {
  movement: Movement;
  reason: BreachReason;
}

export interface Incident {
  v: 1;
  type: "incident";
  incidentId: string;
  token: string;
  breaches: { txId: string; to: string; amount: string; reason: BreachReason }[];
  actions: { step: string; account?: string; amount?: string; txId?: string; ok: boolean; atMs: number; note?: string; error?: string }[];
  detectedMs: number; // ms from movement consensus to detection
  containedMs?: number; // ms from movement consensus to last containment step
}
