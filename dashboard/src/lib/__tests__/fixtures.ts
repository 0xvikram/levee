// Real frames from the testnet run on 6 Nov 2026 (watcher /events).
import type { BreachView, Incident, Movement } from "../types";

export const BREACH: BreachView = {
  txId: "0.0.11333495-1793935170-233904996",
  reason: "no-receipt",
  to: "0.0.11333494",
  amount: "10000000000",
  kind: "transfer",
  consensusAt: "1793935176.883570919",
};
export const INCIDENT_ID = "0x5fcb09e6583c5fae17018fe8228139cfeaf3487b81a29770ae9cab5a5bf8b8da";
export const INCIDENT: Incident = {
  v: 1,
  type: "incident",
  incidentId: INCIDENT_ID,
  token: "0.0.11333594",
  breaches: [{ txId: BREACH.txId, to: "0.0.11333494", amount: "10000000000", reason: "no-receipt" }],
  actions: [
    { step: "freezeAccount", account: "0.0.11333495", txId: "0.0.11333487-1793935173-898405003", ok: true, atMs: 6444 },
    { step: "wipeAndFreeze", account: "0.0.11333494", amount: "10000000000", txId: "0.0.11333487-1793935180-013412119", ok: true, atMs: 8309 },
  ],
  detectedMs: 4193,
  containedMs: 8309,
};
export const MATCHED: Movement = {
  txId: "0.0.11333495-1793935100-000000001",
  consensusAt: "1793935105.000000000",
  token: "0.0.11333594",
  from: "0.0.11333495",
  to: "0.0.11333490",
  amount: "250000000",
  kind: "transfer",
};
