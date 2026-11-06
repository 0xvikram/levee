# Levee HTTP + SSE API

Three local services. All JSON. Amounts are **strings in the token's smallest unit** (RUPC has 6 decimals: `"500000000"` = 500 RUPC). Account ids are `0.0.x`; transaction ids use the Mirror spelling `0.0.x-<sec>-<nanos9>`; consensus times are `"<sec>.<nanos9>"`.

| service | default port | env |
|---|---|---|
| gate | 8710 | `GATE_PORT` |
| watcher | 8711 | `WATCHER_PORT` |
| checker | 8712 | `CHECKER_PORT` |

All three `/events` endpoints are Server-Sent Events with `Access-Control-Allow-Origin: *`. Comment lines (`: connected`, `: ping`, `: ka`) are keep-alives. The watcher's `/state` also sends CORS `*`; the other JSON endpoints do not (proxy them, or read them server side).

**Breaking change in this revision: gate requests must be signed.** `POST /request` now needs `nonce`, `sentAt` and `signature` from the requesting machine's enrolled key; an unsigned body is refused `403 bad-signature`. New 403 reasons: `unknown-machine`, `bad-signature`, `stale-request`, `replayed-request`, `wrong-role`. New checker endpoint `GET /machine/:name`. New `timings.authMs`. Use `npm run request` instead of `curl`.

**Earlier shape changes** (all additive, nothing removed or renamed):

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

Body (signed by the requesting machine's key):

```json
{ "machine": "payouts-server", "to": "0.0.11333490", "amount": "500000000", "kind": "transfer",
  "nonce": "<16-64 hex chars, never reused>", "sentAt": 1793975149000, "signature": "0x<65 bytes hex>" }
```

`kind` defaults to `"transfer"`; `"mint"` = Studio cash-in; `amount` may also be a safe JS integer. `sentAt` is unix ms. `signature` is an EIP-191 (`personal_sign`) signature with the machine's key (`state/machine-<name>.key`, the same secp256k1 key that signs its heartbeats) over the canonical JSON of exactly `{machine, to, amount, kind, nonce, sentAt}`, with `amount` as a decimal string (`src/agent/request.ts`, `requestMessage`).

Don't hand-build it; use the CLI from the repo root, which signs and posts it:

```sh
npm run request -- --machine payouts-server --to 0.0.11333490 --amount 500
#   --amount is whole tokens (scaled by the token's decimals); --units sends it as-is
#   [--kind transfer|mint] [--gate http://localhost:8710]
```

A raw `curl` with an unsigned body is refused `403 bad-signature`.

Order: parse (400) → who is asking (`src/gate/auth.ts`: the machine is enrolled at the checker, `GET /machine/:name`; the signature recovers to its enrolled key; `sentAt` within 60 s of the gate clock; `(machine, nonce)` not seen before; enrolled role in `GATE_ALLOWED_ROLES`, default `finance,payouts`) → pass check → rules (per-transfer cap, daily cap, known destination) → watcher heartbeat younger than 120 s → freeze tx (id fixed) → receipt to HCS, wait for consensus → sign + execute. Requests are processed one at a time. If the checker cannot be asked, the request is refused `unknown-machine` (fails closed).

| status | body |
|---|---|
| 200 | `{ ok: true, receipt: Receipt & { sequence }, receiptTxId, txId, timings }` |
| 400 | `{ ok: false, reason: "bad-request", detail }` |
| 403 | `{ ok: false, reason, detail }`, see the reasons below |
| 502 | `{ ok: false, reason: "execute-failed", detail, txId, receipt, timings }` (receipt was written, execution failed) |
| 500 | `{ ok: false, reason: "internal", detail }` |

403 reasons. Check order: unsigned (`bad-signature`) → `unknown-machine` → wrong key (`bad-signature`) → `stale-request` → `replayed-request` → `wrong-role` → `no-pass` → caps and recipient → `no-watcher`.

| reason | when |
|---|---|
| `bad-signature` | `signature`, `nonce` or `sentAt` missing or malformed (unsigned request), or the signature does not recover to the machine's enrolled key (for example another machine's key naming `payouts-server`) |
| `unknown-machine` | the machine is not enrolled with the checker, or the checker could not be asked |
| `stale-request` | `sentAt` more than 60 s from the gate clock |
| `replayed-request` | this `(machine, nonce)` was already used (in-memory cache; forgotten on a gate restart) |
| `wrong-role` | the machine's enrolled role is not in `GATE_ALLOWED_ROLES` (default `finance,payouts`; demo: `laptop-vikram` = `employee`) |
| `no-pass` | no live Leash pass on Arkiv |
| `over-transfer-cap` | amount above `CAP_PER_TRANSFER` |
| `over-daily-cap` | today's spend + amount above `CAP_PER_DAY` |
| `unknown-destination` | `to` is not a known recipient |
| `no-watcher` | no watcher heartbeat on HCS in the last 120 s |

`Receipt` = `{ v: 1, type: "receipt", txId, token, from, to, amount, kind, machine, approvedAt }`.
`timings` (ms since the request arrived unless noted): `authMs`, `passMs`, `heartbeatMs`, `receiptMs` (duration of the HCS submit), `executeMs` (duration of sign+execute), `totalMs`.

### `GET /health`

`{ ok: true, service: "gate", served, treasury, token, sseClients, capPerTransfer, capPerDay, spentToday, knownDestinations }` — caps and `spentToday` (UTC day, reserved when a receipt is written) are smallest-unit strings.

### `GET /events` (SSE)

Replays the last 50 frames on connect. Frames have `id:` and `event: decision`:

```json
{ "at": "ISO", "machine": "payouts-server", "to": "0.0.x", "amount": "500000000", "kind": "transfer",
  "ok": true, "txId": "0.0.x-…", "receiptTxId": "0.0.x-…", "receiptSequence": 12,
  "timings": { "passMs": 0, "heartbeatMs": 0, "receiptMs": 0, "executeMs": 0, "totalMs": 0 } }
```

Refusals (including the signature, role and replay refusals): `ok: false, reason, detail, timings` (no txId). Execute failures: `ok: false, reason: "execute-failed", detail, txId, timings`.

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

Body `{ machine, publicKey (0x04… uncompressed secp256k1), role?, profile? }`, header `x-enrol-token` when `ENROL_TOKEN` is set (compared in constant time). `scripts/demo/up.sh` makes a random `ENROL_TOKEN` per run and passes it only to the processes it starts; without `ENROL_TOKEN` the endpoint is open. `role` defaults to `employee`; `profile` ∈ `laptop` (default), `server`, `ci`, fixed at enrolment. Reply `{ ok: true, machine, role, profile }`. Errors `{ ok: false, error }` with 400 (bad input), 401 (`bad enrol token`), 409 (different key or different profile).

### `GET /machine/:name`

The enrolment record the gate uses to verify a signed request and judge its role: `{ machine, publicKey, role, profile }`. 404 `{ ok: false, error: "unknown machine" }` if not enrolled. Read from the checker's local enrolment state, not from Arkiv.

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
