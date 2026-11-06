// T4: how fast an unreceipted treasury transfer becomes visible on the Mirror Node REST API.
// Sends 1 RUPC treasury -> attacker (2-of-3: treasurySigner + cold, no gate, no receipt), then polls
//   GET /api/v1/transactions?account.id=<treasury>&order=desc&limit=10   every 250 ms
// (the query a watcher would use) and records ms from consensus timestamp to first sight.
// Median of 3 runs. Local clock skew adds error; we print the NTP-free check (submit -> seen) too.
// Run: npm run t4
import { Log, state } from "./common.js";
import { treasuryTransfer } from "./transfer.js";
import { mirror, mirrorTx, sleep } from "../../src/setup/net.js";
import { median, toUnits } from "../../src/setup/plan.js";
import { consensusToMs } from "../../src/shared/txid.js";
import { saveFixture } from "../../src/setup/fixtures.js";

const log = new Log("T4", "detection timing (consensus -> visible on Mirror Node REST)");
const RUNS = Number(process.env.T4_RUNS ?? 3);

async function waitSeen(txId: string, timeoutMs = 30_000): Promise<{ seenAt: number; consensus: string } | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const j = await mirror<{ transactions: { transaction_id: string; consensus_timestamp: string }[] }>(
      `/api/v1/transactions?account.id=${state.treasury.id}&order=desc&limit=10`,
    ).catch(() => null);
    const hit = j?.transactions?.find((t) => t.transaction_id === txId);
    if (hit) return { seenAt: Date.now(), consensus: hit.consensus_timestamp };
    await sleep(250);
  }
  return null;
}

async function main() {
  const lags: number[] = [];
  const submitToSeen: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await treasuryTransfer(state.attacker.id, toUnits(1n, state.token.decimals));
    log.step(`run ${i + 1}: unreceipted treasury -> attacker 1 RUPC`, r);
    if (!r.ok) continue;
    const seen = await waitSeen(r.txId);
    if (!seen) {
      log.check(`run ${i + 1}: visible on mirror`, false, "not seen within 30 s");
      continue;
    }
    const lag = seen.seenAt - consensusToMs(seen.consensus);
    lags.push(lag);
    submitToSeen.push(seen.seenAt - r.submittedAt);
    log.note(`  run ${i + 1}: consensus ${seen.consensus}, seen +${lag} ms after consensus (${seen.seenAt - r.submittedAt} ms after submit)`);
    if (i === 0) {
      const recs = await mirrorTx(r.txId);
      if (recs) saveFixture("mirror-transfer.json", { _note: `GET /api/v1/transactions/${r.txId}: plain HTS token transfer treasury -> attacker, payer = treasury, signed 2-of-3`, transactions: recs });
    }
    await sleep(1500);
  }
  const m = median(lags);
  log.check(`median consensus -> mirror visibility over ${lags.length} run(s)`, lags.length === RUNS, `${Math.round(m)} ms (runs: ${lags.join(", ")} ms; submit -> seen median ${Math.round(median(submitToSeen))} ms)`);
  log.finish();
}

main().catch((e) => {
  log.check("script error", false, String(e?.message ?? e));
  log.finish();
});
