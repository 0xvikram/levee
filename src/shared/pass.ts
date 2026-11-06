// Leash pass check: is this machine's pass currently live? The checker service owns
// the truth; the gate only asks it. Fails closed: any error means "not live".
import { env } from "./config.js";

export interface PassStatus {
  live: boolean;
  reason?: string;
  expiresAt?: string;
}

export interface PassChecker {
  isLive(machine: string): Promise<PassStatus>;
}

export class HttpPassChecker implements PassChecker {
  constructor(
    private baseUrl = `http://localhost:${env.checkerPort}`,
    private timeoutMs = 2000,
  ) {}

  async isLive(machine: string): Promise<PassStatus> {
    try {
      const res = await fetch(`${this.baseUrl}/pass/${encodeURIComponent(machine)}`, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok && res.status !== 403 && res.status !== 404) return { live: false, reason: `checker http ${res.status}` };
      const body = (await res.json()) as Partial<PassStatus>;
      if (typeof body.live !== "boolean") return { live: false, reason: "checker gave no answer" };
      return {
        live: body.live,
        ...(body.reason ? { reason: String(body.reason) } : {}),
        ...(body.expiresAt ? { expiresAt: String(body.expiresAt) } : {}),
      };
    } catch (e) {
      return { live: false, reason: `checker unreachable: ${(e as Error).message}` };
    }
  }
}

/** Test double: every machine has a live pass. */
export const alwaysLive: PassChecker = {
  async isLive() {
    return { live: true, expiresAt: new Date(Date.now() + 180_000).toISOString() };
  },
};

/** Test double: no machine has a live pass. */
export const neverLive = (reason = "pass expired"): PassChecker => ({
  async isLive() {
    return { live: false, reason };
  },
});
