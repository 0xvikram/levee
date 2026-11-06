# Live run: normal path and false-alarm test (Hedera testnet, 6 Nov 2026)

Everything below ran live on Hedera testnet with the real Arkiv Rabdi pass store. Token RUPC `0.0.11333594` (6 decimals), treasury `0.0.11333495`, payee0 `0.0.11333490`, payee1 `0.0.11333492`, receipts topic [`0.0.11333498`](https://hashscan.io/testnet/topic/0.0.11333498). Raw results are in `state/live-normal-path-*.json` and `state/normal-load-*.json` (gitignored).

## Bring the demo up / down

```
scripts/demo/up.sh                       # checker (Arkiv) -> agents -> watcher (WATCHER_SINCE=now) -> gate
CAP_PER_DAY=300000 scripts/demo/up.sh    # same, with a raised daily cap (used for the load runs)
scripts/demo/down.sh                     # stops every service started by up.sh
```

`up.sh` enrols `payouts-server` (profile server) and `laptop-vikram` (profile laptop) on first run, starts one heartbeat loop per machine, waits until the watcher `/health` is ok, the gate answers and `payouts-server` holds a live Arkiv pass, then prints the URLs. Logs: `state/logs/{checker,watcher,gate,agent-payouts-server,agent-laptop-vikram}.log`. Flags: `--memory` (checker without Arkiv), `--no-laptop`, `--restart`.

Then:

```
npx tsx scripts/demo/normal-path.ts            # 1 approved payout + 3 refusals
npx tsx scripts/demo/normal-load.ts 100        # false-alarm test (N transfers, asserts matched == N, breaches == 0)
npx tsx scripts/demo/balances.ts               # HBAR left on operator / gate / treasury / watcher
```

### Making the laptop refusal robust

`laptop-vikram` is refused today because Parsec is installed and running (remote-access check). FileVault was turned on during the session, so the disk check now passes. If Parsec is quit, the laptop becomes healthy. To keep the refusal for a demo regardless:

```
echo remote-access > state/simulate-laptop-vikram.fail     # takes effect on the next heartbeat (≤ 60 s); empty the file to clear
# or start the agent with: --simulate-fail remote-access   (camelCase remoteAccess also accepted)
```

The checker then reports `kind: "unhealthy", reason: "check failed: remote-access"` and deletes the pass on Arkiv.

## 1. Normal path (default caps: 10,000 RUPC per transfer, 50,000 RUPC per day)

Run at 03:53:26 UTC with the demo freshly up.

| step | result | link |
|---|---|---|
| pass | `payouts-server` live (server profile, 4/4 checks ok; disk/extensions/remote-access `skip`), Arkiv entity `0x13712f0c…4d30ddd`, block age 0.7 s | |
| request | `POST /request {machine: payouts-server, to: payee0, amount: 500000000}` → **200 in 4.0 s** | |
| receipt | HCS receipts topic, seq 1, consensus 1793937207.136 | [receipt tx](https://hashscan.io/testnet/transaction/0.0.11333489-1793937200-519056972) |
| transfer | treasury → payee0, 500 RUPC, signed treasurySigner + gate (2 of 3) | [transfer tx](https://hashscan.io/testnet/transaction/0.0.11333495-1793937199-767624290) |
| watcher | `matched` event 3.4 s after the gate replied; 0 breaches | |

Gate timings: pass check 654 ms, watcher heartbeat lookup 367 ms (in parallel), receipt to consensus 1,774 ms, sign + execute 1,567 ms, total 4,000 ms.

Refusals (no money moves, no receipt written):

| request | HTTP | reason | detail | time |
|---|---|---|---|---|
| `laptop-vikram` → payee0, 500 RUPC | 403 | `no-pass` | check failed: remote-access | 347 ms |
| `payouts-server` → payee0, 10,001 RUPC | 403 | `over-transfer-cap` | amount 10001000000 > cap 10000000000 | 669 ms |
| `payouts-server` → attacker `0.0.11333494`, 500 RUPC | 403 | `unknown-destination` | 0.0.11333494 is not a known destination | 969 ms |
| `ghost-box` (never enrolled) → payee0 | 403 | `no-pass` | unknown machine | 20 ms |

Normal-path cost: 0.004 HBAR (gate, receipt) + 0.016 HBAR (treasury, transfer).

## 2. False-alarm test

`scripts/demo/normal-load.ts N` sends N gate-approved transfers from `payouts-server`, spread at random over payee0/payee1, amounts 10–900 RUPC with random micro-units (deterministic from `--seed`), one after another (the gate serialises requests anyway). It listens to the watcher SSE feed, waits for every `matched` event, then compares `GET /state` before and after. Pass = every request approved, matched == N (both SSE and `/state` delta), breaches == 0, incidents == 0.

**Daily cap raised for these runs:** `CAP_PER_DAY=200000` (100-transfer runs) and `CAP_PER_DAY=300000` (300-transfer run), because N × ~450 RUPC plus the day's earlier spend exceeds the default 50,000 RUPC. The per-transfer cap stayed at 10,000 RUPC. The script reads the caps and today's spend from gate `/health` and refuses to start (printing the CAP_PER_DAY to use) if the plan would not fit.

### Run A: N = 100 (before the fix): FAILED, 1 false alarm

| N | approved | matched | breaches | duration | HBAR |
|---|---|---|---|---|---|
| 100 | 6 (then 94 `execute-failed`) | 5 | **1 (no-receipt)** | 427 s | 2.27 |

Transfer #5 ([tx](https://hashscan.io/testnet/transaction/0.0.11333495-1793937268-268749224), 415.19 RUPC to payee0) was flagged `no-receipt` 2.0 s after consensus and contained in 6.2 s (treasury frozen, payee0 wiped + frozen). Its receipt existed: seq 7, consensus `1793937276.028`, **0.88 s before** the transfer (`1793937276.906`). The watcher reads movements first and receipts second, which is correct only if both reads see the same Mirror state. They don't. We first put this down to Mirror replicas disagreeing; the later probe (`scripts/demo/mirror-lag.ts`) found the real cause: the public Mirror Node sits behind a CDN that answers with `cache-control: public, max-age=1`, so an unchanged URL (the receipts query) can return an answer about 1 s old while the movements query is fresh. Fixed for good in commit `4f53393` (section 4). Every later request then failed with `ACCOUNT_FROZEN_FOR_TOKEN` (the receipts were written, the transfers were refused by the network).

Fix (commit `2627532`, tests in `tests/watcher/watcher.test.ts`): a movement whose only fault is "no receipt yet" waits up to `WATCHER_RECEIPT_GRACE_MS` (default 3000 ms, from first sight) for the receipt to be served, and is judged at once when the receipts read already contains any message with a later consensus time (then the read is provably complete for that moment). Nothing else changes: the receipt still has to have reached consensus *before* the movement, so a receipt written after a theft is still `receipt-after-movement`. The price is up to 3 s more detection time for a real theft when the receipts topic is quiet (see section 3). Treasury and payee0 were reopened 2-of-3 ([propose](https://hashscan.io/testnet/transaction/0.0.11333483-1793937812-233962327), [approve](https://hashscan.io/testnet/transaction/0.0.11333484-1793937811-620431195); payee0 [propose](https://hashscan.io/testnet/transaction/0.0.11333483-1793937816-300565636), [approve](https://hashscan.io/testnet/transaction/0.0.11333484-1793937818-321896526)).

### Run B: N = 100 (after the fix): PASS

| N | approved | matched | breaches | incidents | duration | HBAR spent |
|---|---|---|---|---|---|---|
| 100 | 100 | **100** | **0** | 0 | 376 s | 2.02 (treasury 1.61, gate 0.39, watcher 0.03) |

42,595 RUPC moved. Gate latency p50 3.66 s / max 4.94 s. Watcher `matched` after the gate's reply: p50 2.2 s, p95 4.0 s, max 4.7 s. [first](https://hashscan.io/testnet/transaction/0.0.11333495-1793937855-159034626) · [last](https://hashscan.io/testnet/transaction/0.0.11333495-1793938223-565710647).

### Run C: N = 300 (after the fix): 193 sent before the Mac fell asleep, 193 matched, 0 breaches

| N planned | approved | matched | breaches | incidents | late-receipt saves | duration | HBAR spent |
|---|---|---|---|---|---|---|---|
| 300 | 193 | **193** | **0** | 0 | 3 | 2,229 s (incl. ~26 min asleep) | 3.92 (treasury 3.12, gate 0.75, watcher 0.06) |

`CAP_PER_DAY=300000`, seed 3. Gate latency p50 3.47 s / max 5.45 s; watcher `matched` after the gate's reply p50 2.2 s, p95 3.7 s, max 4.9 s. [first](https://hashscan.io/testnet/transaction/0.0.11333495-1793938292-519560107) · [last approved](https://hashscan.io/testnet/transaction/0.0.11333495-1793938965-422941710).

**Three of the 193 matched only because of the receipt grace** (`lateReceiptMatches: 3`): without the fix this run would have raised three false alarms, so the stale-read race is real and recurring (about 1 in 65 transfers here, 1 in 100 in run A). Its cause is the CDN cache, see section 4.

The run did not reach 300 because **the Mac went into idle sleep** at 04:22:54 UTC (`pmset -g log`: "Entering Sleep state due to 'Idle Sleep'") and stayed asleep until ~04:48. All services paused. The remaining 107 requests were refused `no-pass: no heartbeat for 537 s, pass expired (machine offline or asleep, not a breach)`, which is the designed behaviour: a sleeping machine loses its pass and that is reported as offline, never as a breach. After wake the watcher withheld heartbeats until its ticks were fresh again (fail closed), then recovered by itself; the agent re-created its Arkiv pass. `up.sh` now runs `caffeinate -i -m -s` for the life of the demo (opt out with `--allow-sleep`). The 300 run was not repeated (the main session asked for no further runs from this agent).

## 3. Containment with the grace in place: stolen-key drain + 2-of-3 reopen

Run by the main session after the fix, with `WATCHER_RECEIPT_GRACE_MS=3000`. `scripts/attack.ts 1000` signs a treasury transfer with two stolen keys (treasurySigner + cold), skipping the gate, so no receipt exists.

| step | watcher clock (from theft consensus) | consensus (from theft consensus) | link |
|---|---|---|---|
| theft: treasury → attacker `0.0.11333494`, 1,000 RUPC | 0 | consensus `1793940613.009` | [tx](https://hashscan.io/testnet/transaction/0.0.11333495-1793940607-721315934) |
| detected (`no-receipt`) | 6.89 s | | |
| treasury frozen (`freezeAccount`) | 9.44 s | 8.28 s | [tx](https://hashscan.io/testnet/transaction/0.0.11333487-1793940615-613691402) |
| attacker wiped + frozen (`wipeAndFreeze`, 1,000 RUPC) | 10.72 s | 10.17 s | [tx](https://hashscan.io/testnet/transaction/0.0.11333487-1793940618-278571902) |
| incident published | | seq 4, consensus `1793940623.958` | [topic 0.0.11333500](https://hashscan.io/testnet/topic/0.0.11333500) |

"Watcher clock" is what the incident message reports (`detectedMs`, `actions[].atMs`): the watcher's time when each step's receipt came back. "Consensus" is the containment transaction's consensus timestamp on the Mirror Node. Containment fees: freeze 0.096 HBAR, wipe + freeze 0.138 HBAR (Mirror `charged_tx_fee`).

Compared with the first drain before the fix (10,000 RUPC; detected 4.19 s, treasury frozen 6.44 s, wiped + frozen 8.31 s; [theft](https://hashscan.io/testnet/transaction/0.0.11333495-1793935170-233904996), [freeze](https://hashscan.io/testnet/transaction/0.0.11333487-1793935173-898405003), [wipe](https://hashscan.io/testnet/transaction/0.0.11333487-1793935180-013412119)), detection is 2.7 s later, as expected: the receipts topic was quiet, so the watcher waited out most of the 3 s grace before judging the movement.

2-of-3 reopen afterwards (`scripts/reopen.ts treasury attacker`), admin0 proposes, admin1 approves and the approval executes the unfreeze:

| account | propose (admin0) | approve (admin1) |
|---|---|---|
| treasury `0.0.11333495` | [tx](https://hashscan.io/testnet/transaction/0.0.11333483-1793940640-406300935) | [tx](https://hashscan.io/testnet/transaction/0.0.11333484-1793940644-187266580) |
| attacker `0.0.11333494` | [tx](https://hashscan.io/testnet/transaction/0.0.11333483-1793940643-925485422) | [tx](https://hashscan.io/testnet/transaction/0.0.11333484-1793940645-297104239) |

All seven transactions above returned `SUCCESS` on the Mirror Node (checked 6 Nov 2026).

## 4. After the detection fix: fresh Mirror reads + coverage proof

Commit `4f53393`. The watcher makes every polling URL unique (cache-busted `timestamp=lte:` parameter) so the CDN in front of the public Mirror Node (`max-age=1`) cannot serve it an old answer, and reads one ascending listing of every transaction touching the watched accounts or the gate. Every receipt is a gate-paid submit to the receipts topic, so an answer that holds the movement and no gate submit before it proves the movement has no receipt: breach at once instead of after the 3 s grace. The grace stays as the backstop. Run by the main session, 6 Nov 2026.

### Stolen-key drain, 1,000 RUPC

| step | watcher clock (from theft consensus) | consensus (from theft consensus) | link |
|---|---|---|---|
| theft: treasury → attacker `0.0.11333494`, 1,000 RUPC | 0 | consensus `1793942679.469` | [tx](https://hashscan.io/testnet/transaction/0.0.11333495-1793942673-449451952) |
| detected (`no-receipt`) | 2.865 s | | |
| treasury frozen (`freezeAccount`) | 4.845 s | 4.17 s | [tx](https://hashscan.io/testnet/transaction/0.0.11333487-1793942676-864043046) |
| attacker wiped + frozen (`wipeAndFreeze`, 1,000 RUPC) | 6.861 s | 5.62 s | [tx](https://hashscan.io/testnet/transaction/0.0.11333487-1793942678-498951813) |
| incident published | | seq 5, consensus `1793942686.777` | [topic 0.0.11333500](https://hashscan.io/testnet/topic/0.0.11333500) |

Watcher-clock values are the incident's `detectedMs` and `actions[].atMs`; consensus values are from the Mirror Node for the same tx ids. Containment fees: freeze 0.096 HBAR, wipe + freeze 0.138 HBAR (`charged_tx_fee`). Detection is 4 s faster than the grace-only run in section 3 and 1.3 s faster than the first run.

2-of-3 reopen afterwards:

| account | propose (admin0) | approve (admin1) |
|---|---|---|
| treasury `0.0.11333495` | [tx](https://hashscan.io/testnet/transaction/0.0.11333483-1793942707-749023249) | [tx](https://hashscan.io/testnet/transaction/0.0.11333484-1793942710-022256943) |
| attacker `0.0.11333494` | [tx](https://hashscan.io/testnet/transaction/0.0.11333483-1793942713-763876883) | [tx](https://hashscan.io/testnet/transaction/0.0.11333484-1793942712-224380819) |

All seven transactions returned `SUCCESS` on the Mirror Node (checked 6 Nov 2026).

### Run D: N = 100 (seed 5): PASS

| N | approved | matched | breaches | incidents | late-receipt saves |
|---|---|---|---|---|---|
| 100 | 100 | **100** | **0** | 0 | 0 |

Watcher `matched` after the gate's reply: p50 1.58 s, max 2.92 s. False-alarm-free payments since the fixes: 393 (runs B, C, D).

### Mirror measurements

- Ingest lag (consensus to first fresh REST sight): p50 1.7 s, p99 2.8 s.
- gRPC `TopicMessageQuery` delivers about 0.3 s earlier than fresh REST polling, but a stream cannot prove coverage on a quiet topic (no message means either nothing happened or nothing arrived yet), so it was not adopted (`scripts/demo/mirror-stream-lag.ts`).

## 5. Stolen minting key: unauthorised mint, wiped + frozen, 2-of-3 reopen

The headline stablecoin incidents (Resolv, StablR, Gala) were unauthorised mints, so this run proves the mint path live. The gate account holds the Studio CASHIN (supplier) role, so `scripts/attack-mint.ts 5000` plays a thief with the gate's key: it calls the Studio proxy's cash-in `mint(address,int64)` directly, 5,000 RUPC to the attacker `0.0.11333494`, skipping the gate, so no receipt exists. On the Mirror Node a cash-in is a parent CONTRACTCALL, a child TOKENMINT to the token treasury (the proxy `0.0.11333593`), then a child CRYPTOTRANSFER proxy → attacker; the watcher reads the proxy's transactions and reports one `mint` to the attacker under the parent tx id. Run 6 Nov 2026 with the watcher restarted on commit `3c9bb93` (known partners are frozen, never wiped), `CAP_PER_TRANSFER=10000`, `CAP_PER_DAY=300000`, `WATCHER_SINCE=now`.

| step | watcher clock (from mint consensus) | consensus (from mint consensus) | link |
|---|---|---|---|
| theft: cash-in of 5,000 RUPC to attacker `0.0.11333494` (TOKENMINT to the proxy, then transfer) | 0 | consensus `1793975103.259` | [tx](https://hashscan.io/testnet/transaction/0.0.11333489-1793975099-404424918) |
| detected (`no-receipt`, kind `mint`) | 4.650 s | | |
| attacker wiped + frozen (`wipeAndFreeze`, 5,000 RUPC: TOKENWIPE + TOKENFREEZE) | 7.527 s | 6.09 s | [tx](https://hashscan.io/testnet/transaction/0.0.11333487-1793975101-804305541) |
| incident published | | seq 7, consensus `1793975111.059` | [topic 0.0.11333500](https://hashscan.io/testnet/topic/0.0.11333500) |
| attacker's second attempt: 0.000001 RUPC attacker → treasury | | `ACCOUNT_FROZEN_FOR_TOKEN` | [tx](https://hashscan.io/testnet/transaction/0.0.11333489-1793975151-294777090) |

Total supply (Mirror `total_supply`, smallest units): **967,484,808,697 before**, 972,484,808,697 right after the mint (computed: the TOKENMINT child adds 5,000,000,000; the Mirror does not serve historical supply), **967,484,808,697 after the wipe** (a wipe burns the tokens). The supply is back to the pre-mint value; the attacker's 103 RUPC from before the run were left alone, because the wipe takes only what the incident minted.

The planner did **not** freeze the treasury, and that is right: a mint is not a treasury outflow, the treasury did not move, and freezing it would have stopped legitimate payouts without containing anything. The plan was one step, `wipeAndFreeze` on the receiver. The step that would actually stop a second mint with the same stolen key is taking the CASHIN role away from the gate account (or pausing the token, `PAUSE_ON_BREACH`); the controller does not do that yet (follow-up).

2-of-3 reopen afterwards (`scripts/reopen.ts treasury attacker`; the treasury was not frozen, so it was skipped):

| account | propose (admin0) | approve (admin1, executes the unfreeze) |
|---|---|---|
| attacker `0.0.11333494` | [tx](https://hashscan.io/testnet/transaction/0.0.11333483-1793975174-741999973) | [tx](https://hashscan.io/testnet/transaction/0.0.11333484-1793975176-022104293) |

All transactions above were checked on the Mirror Node: mint, wipe + freeze, propose and approve (with its TOKENUNFREEZE child) `SUCCESS`; the second attempt `ACCOUNT_FROZEN_FOR_TOKEN`. Attacker after reopen: 103 RUPC, `UNFROZEN`. Fees (`charged_tx_fee`): mint 0.126, wipe + freeze 0.138, second attempt 0.016, propose 0.098, approve 0.135 HBAR; ≈ 0.54 HBAR for the whole run including the incident message and the restarted watcher's heartbeats.

## Budget

| | operator | gate | treasury | watcher |
|---|---|---|---|---|
| start of this session | 58.18 | 2.85 | 0.90 | 3.70 |
| end | 44.17 | 4.33 | 5.56 | 3.12 |

Operator spent 14 HBAR, all on top-ups (treasury 4+4+3, gate 2+1). Network fees for the whole session ≈ 8.3 HBAR: normal path 0.02, run A 2.27 (mostly fees of the 94 transfers refused by the frozen treasury), run B 2.02, run C 3.92, plus reopens and heartbeats. A gated transfer costs ≈ 0.020 HBAR (0.016 transfer paid by the treasury + 0.004 receipt paid by the gate).
