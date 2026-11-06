# Hedera / Stablecoin Studio friction log

Notes for the Hedera and Stablecoin Studio teams, written while building Levee on testnet (5 to 6 Nov 2026). Each item: what happened, how we worked around it, and a suggestion. Evidence is in the repo or on testnet.

## 1. Studio SDK `StableCoin.create()` always sends 80 HBAR and a 10M gas limit

- **What happened.** The SDK's create path sends a fixed 80 HBAR of msg.value and a 10,000,000 gas limit. Hedera charges at least 80% of the gas limit, so that is about 12 HBAR of gas on top of the HTS create fee. Our operator had a few HBAR at the time and could not afford it.
- **Workaround.** `src/setup/token.ts` builds the same request and calls the factory's `deployStableCoin` (testnet factory `0.0.7353542`) directly with a Mirror Node gas estimate +15% (about 1.25M gas) and only the msg.value we could spare. Below about 20 HBAR of msg.value the HTS create reverts with `ResponseCodeInvalid(9 = INSUFFICIENT_TX_FEE)` (docs/FIRST_HOUR_TESTS.md).
- **Suggestion.** Let `create()` take optional `gas` and `value`, or estimate gas through the Mirror Node by default. Document the minimum msg.value for the HTS create fee.

## 2. Cash-in role is granted with `grantUnlimitedSupplierRole`, not `grantRole`

- **What happened.** We expected to grant the CASHIN role with the generic `grantRole(role, account)`, like the other roles. Studio v4 instead uses `grantUnlimitedSupplierRole(address)` (or the limited variant) on the SupplierAdminFacet, and cash-in is `mint(address,int64)` on the proxy.
- **Workaround.** `src/setup/controller.ts` grants the gate the supplier role through `grantUnlimitedSupplierRole`.
- **Suggestion.** Make `grantRole(CASHIN_ROLE, …)` revert with a message that points to the supplier functions, and list the role-to-function map in the Studio contracts README.

## 3. `INVALID_ACCOUNT_ID` when passing the long-zero address of an aliased account

- **What happened.** In our first live drain the treasury freeze worked but `wipeAndFreeze` on the attacker failed (incident message seq 1 on topic [0.0.11333500](https://hashscan.io/testnet/topic/0.0.11333500)). The attacker account has an EVM alias; we passed its long-zero address (`0x000…<num>`), and the Studio call through the HTS precompile returned `INVALID_ACCOUNT_ID`.
- **Workaround.** Commit `7a09320`: the watcher resolves each account's real EVM address from the Mirror Node (alias if it has one, else long-zero) before any Studio call (`src/watcher/index.ts`, `resolveEvm`). The threshold-key treasury has no alias, so it keeps its long-zero address.
- **Suggestion.** Accept the long-zero address for aliased accounts in the HTS system contract, or document clearly that it is rejected and return a more specific error.

## 4. The public Mirror Node's CDN cache can serve a ~1 s old answer

- **What happened.** In false-alarm run A, the watcher read a treasury transfer, then read the receipts topic and did not find the receipt. The receipt had reached consensus 0.88 s before the transfer. We first blamed replicas disagreeing; a probe (`scripts/demo/mirror-lag.ts`) showed the real cause: the public REST API sits behind a CDN and answers `cache-control: public, max-age=1`, so a repeated URL (our receipts query) can return a cached answer about 1 s old while a fresh URL is current. Containment froze the treasury: one false alarm in 100 payouts. In run C, 3 of 193 matches needed a wait for the same reason (docs/LIVE_RUN.md §2).
- **Workaround.** Commit `2627532` added a 3 s receipt grace. Commit `4f53393` fixed the cause: every polling URL is made unique (cache-busted), and one ascending listing of every transaction touching the watched accounts or the gate proves when no receipt can still be unread, so a theft is judged at once (detection 2.87 s, 0 false alarms in 393 payments since; docs/LIVE_RUN.md §4).
- **Suggestion.** Document the CDN `max-age` on the public Mirror Node REST API, and return the latest ingested consensus timestamp as a response header (or support a "consistent as of timestamp T" parameter), so clients can tell whether an answer is fresh and whether two reads are comparable.

## 5. A frozen account cannot be wiped

- **What happened.** `wipe` on an account that is frozen for the token fails with `ACCOUNT_FROZEN_FOR_TOKEN` (test T2, [tx](https://hashscan.io/testnet/transaction/0.0.11333487-1793934777-542893691)). For containment this means a naive "freeze first, then wipe" plan fails.
- **Workaround.** `ContainmentController.wipeAndFreeze` wipes then freezes in one transaction. For an account that is already frozen, `wipeFrozen` unfreezes, wipes and refreezes in one transaction, so it never ends unfrozen.
- **Suggestion.** Document this in the HTS wipe docs, or allow the wipe key holder to wipe a frozen account (the freeze is usually there because the funds are suspect).

## 6. Pause blocks freeze, wipe and burn

- **What happened.** Once the token is paused, `freeze` and `wipeAndFreeze` revert with `TOKEN_IS_PAUSED` (test T3, [tx](https://hashscan.io/testnet/transaction/0.0.11333487-1793934811-416068533)). Pausing first, which feels like the safe reaction to a breach, makes cleanup impossible until someone unpauses.
- **Workaround.** Pause is always the last containment step and is off by default (`PAUSE_ON_BREACH`). Unpause needs 2 of 3 admins.
- **Suggestion.** Document the interaction prominently in the Studio and HTS docs. Consider letting freeze and wipe work on a paused token, since they only reduce what can move.

## 7. `sequencenumber=gt:0` returns HTTP 400

- **What happened.** `GET /api/v1/topics/{id}/messages?sequencenumber=gt:0` returns 400 on testnet. `gt:N` for N ≥ 1 and `gte:1` work.
- **Workaround.** `src/shared/mirror.ts` always asks for `gte:N+1`.
- **Suggestion.** Accept `gt:0` (it is the natural "everything after the start" cursor), or say in the error body which values are allowed.

## 8. `eth_call` can return the old state right after a transaction

- **What happened.** In test T1 we read `proposalCount()` through `eth_call` right after `propose()` succeeded and sometimes got the old value, so `approve()` was sent for the wrong proposal id.
- **Workaround.** Read the count before proposing and use `before + 1` (`scripts/tests/common.ts`, `scripts/tests/t3-pause.ts`).
- **Suggestion.** Document the read-after-write lag of the Mirror-backed `eth_call`, or support a block tag that waits for a given consensus timestamp.

## 9. Gas estimate for `approve()` misses the unfreeze it executes

- **What happened.** The second admin's `approve()` reaches the threshold and executes `unfreeze` on the Studio proxy (HTS system contract). A gas estimate taken before the proposal is visible to the estimator does not include that work, so the estimated gas was too low for the call to succeed.
- **Workaround.** Fixed gas of 900,000 for `approve` (`scripts/tests/common.ts`).
- **Suggestion.** Same root cause as 8: an estimator that can be told "as of after transaction X" would fix both.

## What worked well

- HCS topics with a submit key gave us an append-only, ordered, timestamped receipt log for 0.004 HBAR a message.
- Freezing a transaction (`freezeWith`) fixes its id before any signature, which is what makes "receipt first, then sign" exact.
- Threshold KeyLists made the 2-of-3 treasury a one-line change in account creation.
- Mirror Node contract-call simulation let us check that the factory request and the controller deploy were correct before we had the HBAR to send them.
