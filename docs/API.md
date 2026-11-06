# Levee HTTP + SSE API

Four local services. All JSON. Amounts are **strings in the token's smallest unit** (RUPC has 6 decimals: `"500000000"` = 500 RUPC). Account ids are `0.0.x`; transaction ids use the Mirror spelling `0.0.x-<sec>-<nanos9>`; consensus times are `"<sec>.<nanos9>"`.

| service | default port | env |
|---|---|---|
| gate | 8710 | `GATE_PORT` |
| watcher | 8711 | `WATCHER_PORT` |
| checker | 8712 | `CHECKER_PORT` |
| issuer signer | 8715 (127.0.0.1 only) | `SIGNER_PORT`; the gate finds it at `SIGNER_URL` (default `http://127.0.0.1:8715`) |

All four `/events` endpoints are Server-Sent Events with `Access-Control-Allow-Origin: *`. Comment lines (`: connected`, `: ping`, `: ka`) are keep-alives. The watcher's `/state` also sends CORS `*`; the other JSON endpoints do not (proxy them, or read them server side).

**Change in this revision: transfers are Hedera Scheduled Transactions with two separate signers.** The gate creates a schedule signed with its own key, writes the receipt, then the issuer signer (a separate process holding only the treasury-signer key) adds the second signature after it finds the receipt on Hedera. Gate transfer replies and `decision` events gain `scheduleId`, `scheduledTxId` (= `txId`), `signTxId`; the receipt gains `scheduleId`; `timings` gain `scheduleMs`, `signerMs`, `signerVerifyMs`, `signerSignMs` and lose `executeMs` for transfers (mints keep it); new failure statuses `502 schedule-failed`, `502 signer-refused`, `504 signer-unavailable`. `txId` keeps its meaning: the id the money movement has on the Mirror Node. Mints are unchanged.

**Earlier breaking change: gate requests must be signed.** `POST /request` now needs `nonce`, `sentAt` and `signature` from the requesting machine's enrolled key; an unsigned body is refused `403 bad-signature`. New 403 reasons: `unknown-machine`, `bad-signature`, `stale-request`, `replayed-request`, `wrong-role`. New checker endpoint `GET /machine/:name`. New `timings.authMs`. Use `npm run request` instead of `curl`.

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

Order: parse (400) → who is asking (`src/gate/auth.ts`: the machine is enrolled at the checker, `GET /machine/:name`; the signature recovers to its enrolled key; `sentAt` within 60 s of the gate clock; `(machine, nonce)` not seen before; enrolled role in `GATE_ALLOWED_ROLES`, default `finance,payouts`) → pass check → rules (per-transfer cap, daily cap, known destination) → watcher heartbeat younger than 120 s → then, for a **transfer**:

1. `ScheduleCreate` of the fixed `TransferTransaction` treasury → `to`, signed and paid by the gate key only (key 2 of the treasury's 2-of-3; payer of the scheduled transfer = the gate), expiring after `SCHEDULE_TTL_S` (default 300 s), `waitForExpiry = false` so it executes as soon as the last signature lands.
2. Receipt to HCS naming the scheduled transaction id and the schedule id; wait for consensus.
3. `POST {SIGNER_URL}/schedule {scheduleId}` and wait (up to `SIGNER_WAIT_S`, default 75 s) for the issuer signer: it re-checks everything on the Mirror Node and signs with the treasury-signer key (key 1), which makes Hedera execute the transfer.

For a **mint** (unchanged): freeze the cash-in call (id fixed) → receipt → sign with the gate key (the account holding the cash-in role) and execute.

Steps up to the receipt are processed one request at a time; waiting for the issuer signer is not.

**Transaction id.** A scheduled transfer executes under the `ScheduleCreate`'s transaction id with the scheduled flag (SDK `0.0.gate@sec.nanos?scheduled`). The Mirror Node lists it under the same `transaction_id` (`0.0.gate-sec-nanos`) as the `SCHEDULECREATE`, with `scheduled: true` on the `CRYPTOTRANSFER` (fixture `tests/fixtures/mirror-scheduled-transfer.json`). The gate fixes that id before anything is written, puts it in the receipt as `txId`, and the watcher matches it without change. If the checker cannot be asked, the request is refused `unknown-machine` (fails closed).

| status | body |
|---|---|
| 200 | transfer: `{ ok: true, receipt: Receipt & { sequence }, txId, scheduleId, scheduledTxId, receiptTxId, receiptSequence, signTxId, executedStatus: "SUCCESS", timings }`; mint: `{ ok: true, receipt: Receipt & { sequence }, receiptTxId, txId, timings }` |
| 400 | `{ ok: false, reason: "bad-request", detail }` |
| 403 | `{ ok: false, reason, detail }`, see the reasons below |
| 502 | `{ ok: false, reason: "schedule-failed", detail, txId, timings }`: the ScheduleCreate failed; no receipt was written |
| 502 | `{ ok: false, reason: "signer-refused", detail, txId, scheduleId, scheduledTxId, receiptTxId, receiptSequence, receipt, signer, timings }`: the receipt was written, the issuer signer refused (`signer` = its decision); the schedule expires unexecuted |
| 504 | same shape, `reason: "signer-unavailable"`: the issuer signer did not answer. Its own poll may still judge (and sign) the schedule before it expires |
| 502 | mint: `{ ok: false, reason: "execute-failed", detail, txId, receipt, timings }` (receipt was written, execution failed) |
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

`Receipt` = `{ v: 1, type: "receipt", txId, token, from, to, amount, kind, machine, approvedAt, scheduleId? }` (`scheduleId` on transfers).
`timings` (ms since the request arrived unless noted): `authMs`, `passMs`, `heartbeatMs`, `scheduleMs` (duration of the ScheduleCreate), `receiptMs` (duration of the HCS submit), `signerMs` (duration of the call to the issuer signer), `signerVerifyMs` / `signerSignMs` (the signer's own Mirror check and ScheduleSign), `executeMs` (mint only: sign + execute), `totalMs`.

### `GET /health`

`{ ok: true, service: "gate", served, treasury, token, sseClients, capPerTransfer, capPerDay, spentToday, knownDestinations, signing }` — caps and `spentToday` (UTC day, reserved when a receipt is written) are smallest-unit strings.

### `GET /events` (SSE)

Replays the last 50 frames on connect. Frames have `id:` and `event: decision`:

```json
{ "at": "ISO", "machine": "payouts-server", "to": "0.0.x", "amount": "500000000", "kind": "transfer",
  "ok": true, "txId": "0.0.x-…", "scheduleId": "0.0.x", "scheduledTxId": "0.0.x-…", "receiptTxId": "0.0.x-…", "receiptSequence": 12,
  "signTxId": "0.0.x-…", "timings": { "passMs": 0, "heartbeatMs": 0, "scheduleMs": 0, "receiptMs": 0, "signerMs": 0, "totalMs": 0 } }
```

Mints: `txId`, `receiptTxId`, `receiptSequence`, `timings.executeMs` (no schedule fields). Refusals (including the signature, role and replay refusals): `ok: false, reason, detail, timings` (no txId). Failures after approval: `ok: false, reason: "schedule-failed" | "signer-refused" | "signer-unavailable" | "execute-failed", detail, txId, timings` (plus the schedule and receipt fields once they exist).

---

## Issuer signer (`127.0.0.1:8715`)

`npm run signer` (`src/signer/server.ts`). A separate process that loads **only** the issuer's treasury-signer key (key 1 of the treasury's 2-of-3). It pays for its ScheduleSign from its own account `issuerSigner` in `state/deploy.json`, whose key is that same treasury-signer key (created once with `npm run setup:signer`). Binds to 127.0.0.1. Env: `SIGNER_PORT` (8715), `SIGNER_RECEIPT_WAIT_S` (60), `SIGNER_POLL_S` (10; 0 = notifications only).

It signs a schedule only if all of these hold, read from the Mirror Node (`src/signer/verify.ts`):

1. the schedule was created by the gate account, is not deleted, not executed, not expired;
2. its body is one plain token transfer of RUPC: treasury −amount, recipient +amount, nothing else (no HBAR, NFTs, allowances, aliases, other transaction types);
3. a receipt for exactly that scheduled transaction id is on the receipts topic, paid by the gate, with the same token, from, to, amount, `kind: "transfer"` and (if present) schedule id;
4. the gate's rules still pass: per-transfer cap, daily cap (every receipt that UTC day before this one), known recipients.

"No receipt yet" is re-checked every 0.75 s for up to `SIGNER_RECEIPT_WAIT_S`, then refused for good; every other failure is refused at once. A decision is final for the life of the process (a refused schedule is never signed later by it). Besides the gate's notification it polls `GET /api/v1/schedules?account.id=<gate>` every `SIGNER_POLL_S`, so a schedule the gate never announced (for example made with a stolen gate key) is still judged, and refused if it has no receipt.

### `POST /schedule`

Body `{ "scheduleId": "0.0.x" }` (400 otherwise). Waits for the decision.

| status | body |
|---|---|
| 200 | `{ ok: true, scheduleId, scheduledTxId, transfer: { token, from, to, amount }, receiptSequence, receiptConsensusAt, signTxId, status: "SUCCESS", executedStatus: "SUCCESS", verifyMs, signMs, at }` |
| 409 | `{ ok: false, scheduleId, scheduledTxId?, reason, detail, at, verifyMs }` |

Refusal reasons: `schedule-not-found`, `not-from-gate`, `deleted`, `already-executed`, `expired`, `not-a-plain-transfer`, `wrong-token`, `not-from-treasury`, `no-receipt`, `receipt-not-from-gate`, `receipt-mismatch`, `over-transfer-cap`, `over-daily-cap`, `unknown-destination`, `sign-failed`.

### `GET /decisions`

`{ ok: true, decisions: [...] }`: the last 50 decisions, same shape as `POST /schedule` replies.

### `GET /health`

`{ ok: true, service: "issuer signer", gate, treasury, token, receiptsTopic, receiptsRead, signed, refused, pending, sseClients }`.

### `GET /events` (SSE)

Replays the last 50 frames. `event: signed` and `event: refused`, data = the decision.

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
