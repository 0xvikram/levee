# Levee HTTP + SSE API

Three local services. All JSON. Amounts are **strings in the token's smallest unit** (RUPC has 6 decimals: `"500000000"` = 500 RUPC). Account ids are `0.0.x`; transaction ids use the Mirror spelling `0.0.x-<sec>-<nanos9>`; consensus times are `"<sec>.<nanos9>"`.

| service | default port | env |
|---|---|---|
| gate | 8710 | `GATE_PORT` |
| watcher | 8711 | `WATCHER_PORT` |
| checker | 8712 | `CHECKER_PORT` |

All three `/events` endpoints are Server-Sent Events with `Access-Control-Allow-Origin: *`. Comment lines (`: connected`, `: ping`, `: ka`) are keep-alives. The watcher's `/state` also sends CORS `*`; the other JSON endpoints do not (proxy them, or read them server side).

**Shape changes in this revision** (all additive, nothing removed or renamed):

- gate `POST /request` 200 reply: new `receiptTxId`.
- gate `decision` SSE event: new `receiptTxId`, `receiptSequence` on approved requests.
- gate `GET /health`: new `capPerTransfer`, `capPerDay`, `spentToday`, `knownDestinations`.
- watcher `GET /state`: new `pendingReceipts`, `lateReceiptMatches` (see WATCHER_RECEIPT_GRACE_MS).
- checker `GET /pass/:machine` and `/passes`: new `profile`; `checks` values may now be `"skip"`.
- checker `POST /enrol`: new optional `profile` in body and reply.
- checker `enrol` event data: new `profile`.
- Caps are now really enforced in whole RUPC (a unit bug made them 0.01 RUPC). The API was always smallest unit; only the cap values changed.

---

## Gate (`:8710`)

### `POST /request`

Body: `{ "machine": "payouts-server", "to": "0.0.11333490", "amount": "500000000", "kind": "transfer" }` (`kind` defaults to `"transfer"`; `"mint"` = Studio cash-in; `amount` may also be a safe JS integer).

Order: pass check → rules (per-transfer cap, daily cap, known destination) → watcher heartbeat younger than 120 s → freeze tx (id fixed) → receipt to HCS, wait for consensus → sign + execute. Requests are processed one at a time.

| status | body |
|---|---|
| 200 | `{ ok: true, receipt: Receipt & { sequence }, receiptTxId, txId, timings }` |
| 400 | `{ ok: false, reason: "bad-request", detail }` |
| 403 | `{ ok: false, reason, detail }`, reason ∈ `no-pass`, `over-transfer-cap`, `over-daily-cap`, `unknown-destination`, `no-watcher` |
| 502 | `{ ok: false, reason: "execute-failed", detail, txId, receipt, timings }` (receipt was written, execution failed) |
| 500 | `{ ok: false, reason: "internal", detail }` |

`Receipt` = `{ v: 1, type: "receipt", txId, token, from, to, amount, kind, machine, approvedAt }`.
`timings` (ms since the request arrived unless noted): `passMs`, `heartbeatMs`, `receiptMs` (duration of the HCS submit), `executeMs` (duration of sign+execute), `totalMs`.

### `GET /health`

`{ ok: true, service: "gate", served, treasury, token, sseClients, capPerTransfer, capPerDay, spentToday, knownDestinations }` — caps and `spentToday` (UTC day, reserved when a receipt is written) are smallest-unit strings.

### `GET /events` (SSE)

Replays the last 50 frames on connect. Frames have `id:` and `event: decision`:

```json
{ "at": "ISO", "machine": "payouts-server", "to": "0.0.x", "amount": "500000000", "kind": "transfer",
  "ok": true, "txId": "0.0.x-…", "receiptTxId": "0.0.x-…", "receiptSequence": 12,
  "timings": { "passMs": 0, "heartbeatMs": 0, "receiptMs": 0, "executeMs": 0, "totalMs": 0 } }
```

Refusals: `ok: false, reason, detail, timings` (no txId). Execute failures: `ok: false, reason: "execute-failed", detail, txId, timings`.

---

## Watcher (`:8711`)

### `GET /health`

200 when healthy, 503 otherwise: `{ ok, service: "watcher", lagMs, lastBeat }`. Healthy = Mirror lag ≤ 20 s and a tick succeeded within 20 s. An unhealthy watcher withholds heartbeats, so the gate refuses everything (`no-watcher`).

A movement with no receipt yet waits up to `WATCHER_RECEIPT_GRACE_MS` (default 3000) for the receipt to be served before a `no-receipt` breach is raised (the public Mirror Node is behind a CDN with `max-age=1`, so the watcher cache-busts every read and, while a movement is held, proves from one transaction listing that no receipt exists before it, which raises the breach early; the grace is the backstop if that proof read fails; see docs/LIVE_RUN.md §4). The receipt must still have reached consensus before the movement.

### `GET /state`

```
{ healthy, lagMs | null, matched (count since start), receipts (count), invalidReceipts, receiptSeq,
  pendingReceipts (movements waiting for a late-served receipt), lateReceiptMatches (count matched after waiting),
  cursors: { [account]: consensusTs }, breaches: BreachView[] (last 50), incidents: IncidentOut[] (last 20),
  lastTickOkAt: ISO | null, lastError: string | null, lastBeat: ISO | null,
  pauseOnBreach, treasury, token, tokenTreasury }
```

`BreachView` = `{ txId, reason, to?, amount?, kind?, consensusAt, historic? }`; `reason` ∈ `no-receipt`, `receipt-after-movement`, `receipt-mismatch`, `receipt-reused`, `over-transfer-cap`, `over-daily-cap`, `unknown-destination`, `treasury-allowance`. `historic: true` = seen while priming, reported but not contained.

`IncidentOut` = `{ v: 1, type: "incident", incidentId (0x…32 bytes), token, breaches: [{ txId, to, amount, reason }], actions: [{ step, account?, amount?, txId?, ok, atMs }], detectedMs, containedMs? }` (`detectedMs`/`containedMs`/`atMs` are measured from the breach's consensus time).

### `GET /events` (SSE)

Replays the last 100 frames. Named events:

| event | data |
|---|---|
| `matched` | Movement `{ txId, consensusAt, token, from (null for mint), to, amount, kind }` |
| `breach` | BreachView |
| `detected` | `{ incidentId, breaches: BreachView[], detectedMs }` |
| `plan` | `{ incidentId, steps: [{ step, account?, amount?, why }] }`, step ∈ `freezeAccount`, `wipeAndFreeze`, `wipeFrozen`, `burnSupply`, `pauseToken` |
| `step` | `{ incidentId, step, account?, amount?, txId, atMs }` |
| `incident` | IncidentOut |
| `health` | `{ healthy: true, lagMs, heartbeatAt }` or `{ healthy: false, lagMs, lastError }` (every 30 s) |

---

## Checker (`:8712`)

### `POST /enrol`

Body `{ machine, publicKey (0x04… uncompressed secp256k1), role?, profile? }`, header `x-enrol-token` when `ENROL_TOKEN` is set. `profile` ∈ `laptop` (default), `server`, `ci`, fixed at enrolment. Reply `{ ok: true, machine, role, profile }`. Errors `{ ok: false, error }` with 400 (bad input), 401 (token), 409 (different key or different profile).

### `GET /nonce?machine=` → `{ nonce, ttlSeconds: 60 }` (404 unknown machine)

### `POST /heartbeat`

Body `{ payload: { machine, seq, nonce, checks: { [checkId]: "ok" | "fail" | "skip" }, evidenceHash, sentAt, profile? }, signature }`. Replies `{ ok: true, renewed: true, expiresAt, arkivEntityKey }` or `{ ok: false, renewed: false, reason }`. Errors 400/401/404/409/503 as `{ ok: false, error }`. See docs/LEASH.md for the rules.

### `GET /pass/:machine`, `GET /passes` (array of the same)

```
{ machine, live, kind: "ok" | "offline" | "unhealthy" | "unverifiable" | "unknown",
  expiresAt: ISO | null, reason: string | null, arkivEntityKey: string | null, arkivBlockAgeSeconds: number | null,
  checks?: { [checkId]: "ok" | "fail" | "skip" }, profile?: "laptop" | "server" | "ci", lastHeartbeatAt?: ISO | null }
```

### `GET /events` (SSE)

Unnamed frames (`data:` only, so `event` is `message`): `{ type, at (ms), data }`.

| type | data |
|---|---|
| `enrol` | `{ machine, role, profile }` |
| `heartbeat` (good) | `{ machine, ok: true, expiresAtMs, entityKey }` |
| `heartbeat` (failing check) | `{ machine, ok: false, failing: checkId[], revoked }` |
| `heartbeat` (Arkiv write failed) | `{ machine, ok: true, renewed: false, error }` |

Check ids: `persistence`, `remote-access`, `ports`, `devtools`, `protections`, `disk`, `extensions`.
