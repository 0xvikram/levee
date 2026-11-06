// Public Mirror Node reads (no keys). Used as a fallback when the local services are off,
// and for facts the services do not expose (freeze status for the reopen panel).
import { MIRROR, deploy } from "./config";
import type { Incident } from "./types";

export function b64ToText(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function parseIncidentMessage(b64: string): Incident | null {
  try {
    const v = JSON.parse(b64ToText(b64));
    if (v?.type === "incident" && Array.isArray(v.actions) && Array.isArray(v.breaches)) return v as Incident;
  } catch {
    /* not an incident */
  }
  return null;
}

export async function latestIncident(): Promise<{ incident: Incident; consensusAt: string; sequence: number } | null> {
  const r = await fetch(`${MIRROR}/api/v1/topics/${deploy.topics.incidents}/messages?order=desc&limit=5`);
  if (!r.ok) return null;
  const j = (await r.json()) as { messages?: { message: string; consensus_timestamp: string; sequence_number: number }[] };
  for (const m of j.messages ?? []) {
    const incident = parseIncidentMessage(m.message);
    if (incident) return { incident, consensusAt: m.consensus_timestamp, sequence: m.sequence_number };
  }
  return null;
}

export type FreezeStatus = "FROZEN" | "UNFROZEN" | "NOT_APPLICABLE" | "UNKNOWN";

export async function freezeStatus(account: string): Promise<FreezeStatus> {
  const r = await fetch(`${MIRROR}/api/v1/accounts/${account}/tokens?token.id=${deploy.token.tokenId}`);
  if (!r.ok) return "UNKNOWN";
  const j = (await r.json()) as { tokens?: { freeze_status?: string }[] };
  const s = j.tokens?.[0]?.freeze_status;
  return s === "FROZEN" || s === "UNFROZEN" || s === "NOT_APPLICABLE" ? s : "UNKNOWN";
}

export interface TokenRelation {
  balance: string | null; // smallest unit
  freeze: FreezeStatus;
}

/** Balance + freeze status of one account for the deployed token (one Mirror call). */
export async function tokenRelation(account: string): Promise<TokenRelation> {
  const r = await fetch(`${MIRROR}/api/v1/accounts/${account}/tokens?token.id=${deploy.token.tokenId}`);
  if (!r.ok) return { balance: null, freeze: "UNKNOWN" };
  const j = (await r.json()) as { tokens?: { freeze_status?: string; balance?: number | string }[] };
  const t = j.tokens?.[0];
  const s = t?.freeze_status;
  return {
    balance: t?.balance === undefined ? null : String(t.balance),
    freeze: s === "FROZEN" || s === "UNFROZEN" || s === "NOT_APPLICABLE" ? s : "UNKNOWN",
  };
}
