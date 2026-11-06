# First-hour tests

Live checks on Hedera testnet that the containment plan works with a real Stablecoin Studio token.
Each test writes its own section below (between the `<!-- Tn -->` markers) when it runs.

## How to run

```sh
npm run setup            # accounts -> topics -> token -> controller (each step skips what exists)
npm run setup:status     # what is left + operator balance
npm run t1 && npm run t2 && npm run t3 && npm run t4
```

## Status (6 Nov 2026)

**Done. T1-T4 all pass live** (results below). Setup completed after a testnet HBAR top-up: token RUPC `0.0.11333594`, controller `0.0.11333603`, topics `0.0.11333498` / `0.0.11333500` / `0.0.11333501`. Later live runs (normal path, false-alarm runs, stolen-key drain, 2-of-3 reopen) are in [LIVE_RUN.md](LIVE_RUN.md).

The cost table below is the plan written while setup was blocked on HBAR; the "Measured" column was filled where we measured it.

| Step | Estimate (HBAR) | Measured |
|---|---|---|
| 9 accounts | 7.2 | 6.85 (0.76 each) |
| 3 topics | 1.35 | 0.88 |
| Studio token (deployStableCoin) | ~17.7 (+30 held as msg.value) | other users' factory calls on testnet: 17.5-18.4 |
| 4 token associations | 3.0 | |
| cash-in 1,000,000 RUPC | 0.33 | |
| controller deploy (relay, gas only) + 5 grants | ~2.6 | deploy simulated on Mirror Node: 1.29M gas |
| account HBAR balances (admins 0.5 each, watcher 1.5, gate 1, treasury 1) | 5.0 | deferred |
| T1-T4 | ~4 | |

## Findings from setup

- Studio SDK `StableCoin.create()` always sends 80 HBAR and a 10M gas limit; `token.ts` calls the
  factory's `deployStableCoin` directly with the same request instead. The request encodes correctly:
  a Mirror Node simulation runs it up to the HTS create call, which needs ≥ ~20 HBAR of msg.value
  (below that it reverts `ResponseCodeInvalid(9 = INSUFFICIENT_TX_FEE)`).
- `ContainmentController` bytecode deploys on Hedera (cancun target) in a Mirror Node simulation: 1,288,203 gas.
- Studio v4 `freeze/unfreeze/wipe/burn/pause/unpause` all return `bool`, matching `IStudioToken` in the controller.
- Studio cash-in is `mint(address,int64)` on the proxy; the CASHIN role is granted with
  `grantUnlimitedSupplierRole(address)` (SupplierAdminFacet), not `grantRole`.
- Demo accounts have an EVM alias, so `msg.sender` is the alias address for both HAPI ContractExecute and
  JSON-RPC calls; the treasury (threshold key) uses its long-zero address.

<!-- T1:start -->
## T1: controller holds the roles (freeze by watcher, 2-of-3 unfreeze)

**Result: PASS** — run 2026-11-06T03:12:33.518Z

note: payee1 started as FROZEN; reopening it before the test
- PASS: admin0 propose(Unfreeze) — expected success, got SUCCESS ([0.0.11333483-1793934735-326290532](https://hashscan.io/testnet/transaction/0.0.11333483-1793934735-326290532))
- PASS: admin1 approve(5) — expected success, got SUCCESS ([0.0.11333484-1793934734-424992898](https://hashscan.io/testnet/transaction/0.0.11333484-1793934734-424992898))
- PASS: watcher freezeAccount(payee1) — expected success, got SUCCESS ([0.0.11333487-1793934738-147501159](https://hashscan.io/testnet/transaction/0.0.11333487-1793934738-147501159))
- PASS: payee1 is FROZEN on the mirror node — status FROZEN
- PASS: gate (non-watcher, non-admin) freezeAccount(payee0) reverts — expected failure, got CONTRACT_REVERT_EXECUTED / NotWatcherOrAdmin() ([0.0.11333489-1793934739-965101241](https://hashscan.io/testnet/transaction/0.0.11333489-1793934739-965101241))
- PASS: revert reason is NotWatcherOrAdmin — NotWatcherOrAdmin()
- PASS: admin0 propose(Unfreeze) — expected success, got SUCCESS ([0.0.11333483-1793934744-630792981](https://hashscan.io/testnet/transaction/0.0.11333483-1793934744-630792981))
- PASS: admin1 approve(6) — expected success, got SUCCESS ([0.0.11333484-1793934746-146817866](https://hashscan.io/testnet/transaction/0.0.11333484-1793934746-146817866))
- PASS: payee1 is UNFROZEN after 2-of-3 — status UNFROZEN
<!-- T1:end -->

<!-- T2:start -->
## T2: wipe order (frozen accounts cannot be wiped)

**Result: PASS** — run 2026-11-06T03:13:17.182Z

- PASS: setup: treasury -> attacker 200 RUPC — expected success, got SUCCESS ([0.0.11333495-1793934768-194891753](https://hashscan.io/testnet/transaction/0.0.11333495-1793934768-194891753))
- PASS: watcher wipeAndFreeze(attacker, 50) — expected success, got SUCCESS ([0.0.11333487-1793934774-302498583](https://hashscan.io/testnet/transaction/0.0.11333487-1793934774-302498583))
- PASS: attacker FROZEN — after wipeAndFreeze
- PASS: wipeAndFreeze on an already FROZEN account fails — expected failure, got CONTRACT_REVERT_EXECUTED / ResponseCodeInvalid(165 = ACCOUNT_FROZEN_FOR_TOKEN) ([0.0.11333487-1793934777-542893691](https://hashscan.io/testnet/transaction/0.0.11333487-1793934777-542893691))
  exact error: CONTRACT_REVERT_EXECUTED / ResponseCodeInvalid(165 = ACCOUNT_FROZEN_FOR_TOKEN)
- PASS: watcher wipeFrozen(attacker, 50) — expected success, got SUCCESS ([0.0.11333487-1793934780-476395531](https://hashscan.io/testnet/transaction/0.0.11333487-1793934780-476395531))
- PASS: attacker still FROZEN after wipeFrozen — unfreeze/wipe/freeze in one tx
- PASS: attacker balance dropped by 100 RUPC (2 wipes) — before 200000000, after 100000000 (smallest units)
- PASS: admin0 propose(Unfreeze) — expected success, got SUCCESS ([0.0.11333483-1793934787-156753364](https://hashscan.io/testnet/transaction/0.0.11333483-1793934787-156753364))
- PASS: admin1 approve(7) — expected success, got SUCCESS ([0.0.11333484-1793934788-072163188](https://hashscan.io/testnet/transaction/0.0.11333484-1793934788-072163188))
- PASS: cleanup: attacker UNFROZEN — 2-of-3 unfreeze
<!-- T2:end -->

<!-- T3:start -->
## T3: pause behaviour (pause last; 2-of-3 unpause)

**Result: PASS** — run 2026-11-06T03:13:49.102Z

- PASS: watcher pauseToken() — expected success, got SUCCESS ([0.0.11333487-1793934810-515328352](https://hashscan.io/testnet/transaction/0.0.11333487-1793934810-515328352))
- PASS: token PAUSED on the mirror node — pause_status
- PASS: freezeAccount while paused fails — expected failure, got CONTRACT_REVERT_EXECUTED / ResponseCodeInvalid(265 = TOKEN_IS_PAUSED) ([0.0.11333487-1793934811-416068533](https://hashscan.io/testnet/transaction/0.0.11333487-1793934811-416068533))
- PASS: wipeAndFreeze while paused fails — expected failure, got CONTRACT_REVERT_EXECUTED / ResponseCodeInvalid(265 = TOKEN_IS_PAUSED) ([0.0.11333487-1793934816-450672926](https://hashscan.io/testnet/transaction/0.0.11333487-1793934816-450672926))
  exact error: CONTRACT_REVERT_EXECUTED / ResponseCodeInvalid(265 = TOKEN_IS_PAUSED)
  exact error: CONTRACT_REVERT_EXECUTED / ResponseCodeInvalid(265 = TOKEN_IS_PAUSED)
- PASS: admin0 propose(Unpause) — expected success, got SUCCESS ([0.0.11333483-1793934820-110674293](https://hashscan.io/testnet/transaction/0.0.11333483-1793934820-110674293))
- PASS: admin2 approve(8) — expected success, got SUCCESS ([0.0.11333485-1793934820-084003200](https://hashscan.io/testnet/transaction/0.0.11333485-1793934820-084003200))
- PASS: token UNPAUSED after 2-of-3 — pause_status
<!-- T3:end -->

<!-- T4:start -->
## T4: detection timing (consensus -> visible on Mirror Node REST)

**Result: PASS** — run 2026-11-06T03:14:14.156Z

- PASS: run 1: unreceipted treasury -> attacker 1 RUPC — expected success, got SUCCESS ([0.0.11333495-1793934832-507092702](https://hashscan.io/testnet/transaction/0.0.11333495-1793934832-507092702))
  run 1: consensus 1793934839.585335104, seen +2947 ms after consensus (3522 ms after submit)
- PASS: run 2: unreceipted treasury -> attacker 1 RUPC — expected success, got SUCCESS ([0.0.11333495-1793934839-738618997](https://hashscan.io/testnet/transaction/0.0.11333495-1793934839-738618997))
  run 2: consensus 1793934844.805179104, seen +2736 ms after consensus (3194 ms after submit)
- PASS: run 3: unreceipted treasury -> attacker 1 RUPC — expected success, got SUCCESS ([0.0.11333495-1793934844-547615023](https://hashscan.io/testnet/transaction/0.0.11333495-1793934844-547615023))
  run 3: consensus 1793934849.540604104, seen +3115 ms after consensus (3607 ms after submit)
- PASS: median consensus -> mirror visibility over 3 run(s) — 2947 ms (runs: 2947, 2736, 3115 ms; submit -> seen median 3522 ms)
<!-- T4:end -->
