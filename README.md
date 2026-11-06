# Levee

[![tests](https://github.com/0xvikram/levee/actions/workflows/test.yml/badge.svg)](https://github.com/0xvikram/levee/actions/workflows/test.yml)

**No receipt, no movement.**

Levee guards a stablecoin treasury on Hedera. Every token that leaves the treasury must have a public receipt on Hedera first. If tokens leave without one, a contract freezes the treasury and takes the tokens back, in under 10 seconds.

Built for ETHGlobal Mumbai 2026. Main track: Hedera "Tokenize with Hedera Studios" (Stablecoin Studio). Also submitted to Arkiv "Build from scratch".

- Demo video: (link added at submission)
- Hosted dashboard: https://levee-theta.vercel.app (live view: https://levee-theta.vercel.app/live, reads the chain directly)
- Live testnet run log: [docs/LIVE_RUN.md](docs/LIVE_RUN.md)
- The 60-second pitch and demo script: [docs/PITCH.md](docs/PITCH.md)

## The use case

A company issues its own stablecoin with Hedera Stablecoin Studio, keeps it in a treasury account, and pays people from it: payroll, vendor payouts, refunds.

## The one rule

**Every token that leaves the treasury must have a receipt on Hedera (an HCS topic) first.**

```mermaid
flowchart LR
  A[Payout app] -- "pay Asha 500" --> R[(Receipt on Hedera HCS)]
  R --> T[Treasury pays]
  T --> W{Watcher checks every movement}
  W -- receipt found --> OK[match ✓]
  W -- no receipt --> C[Contract freezes + claws back]
  C --> AD[2 of 3 admins reopen]
```

## The story in three steps

**1. A normal payment.** The payout app asks Levee "pay Asha 500". Levee writes the receipt on Hedera, waits for consensus, then sends the payment. The watcher sees the payment, finds its receipt, and marks it ✓. In live runs: 393 of 393 payments matched with no false alarm (runs B, C and D, after the Mirror read fixes in [Design decisions](#design-decisions)), at about 0.02 HBAR per payment.

**2. A theft.** A hacker with stolen treasury keys sends tokens straight out, skipping Levee. The watcher sees money leave with no receipt. The close-only contract freezes the treasury, takes the tokens back from the hacker's account (wipe), and freezes that account. The incident is logged on Hedera.

| run | stolen | detected | treasury frozen | taken back + hacker frozen | on HashScan |
|---|---|---|---|---|---|
| first full run | 10,000 RUPC | 4.19 s | 6.44 s | 8.31 s | [theft](https://hashscan.io/testnet/transaction/0.0.11333495-1793935170-233904996) · [freeze](https://hashscan.io/testnet/transaction/0.0.11333487-1793935173-898405003) · [wipe](https://hashscan.io/testnet/transaction/0.0.11333487-1793935180-013412119) |
| latest run | 1,000 RUPC | 2.87 s | 4.85 s | 6.86 s | [theft](https://hashscan.io/testnet/transaction/0.0.11333495-1793942673-449451952) · [freeze](https://hashscan.io/testnet/transaction/0.0.11333487-1793942676-864043046) · [wipe](https://hashscan.io/testnet/transaction/0.0.11333487-1793942678-498951813) |

Times are seconds after the theft reached consensus, on the watcher's clock (consensus times and a third run are under [Measured results](#measured-results)). Incident log: topic [0.0.11333500](https://hashscan.io/testnet/topic/0.0.11333500), latest incident is message 5.

**3. Reopen.** Only 2 of 3 admins together can unfreeze. The contract and the watcher can close things but can never reopen them. The latest run was reopened this way: treasury [propose](https://hashscan.io/testnet/transaction/0.0.11333483-1793942707-749023249) / [approve](https://hashscan.io/testnet/transaction/0.0.11333484-1793942710-022256943).

## Add-on rules

The one rule is the core. A company would add these checks one at a time; in the code today all three are already on. If any fails, Levee refuses the payment: no receipt, no money.

- **Spending caps:** a limit per payment and per day.
- **Known payees only:** money can only go to approved accounts.
- **Payout-machine health pass on Arkiv (the "Leash"):** the machine asking for a payment must be healthy and online. Its pass lives on Arkiv and expires in 3 minutes unless renewed. See the [Arkiv](#arkiv) section below and [arkiv/](arkiv/).

One safety check is always on: Levee will not sign a payment if the watcher has not checked in on Hedera for 2 minutes (no watcher, no payments).

## Problem

A stablecoin issuer's treasury key, or the server that holds it, is the single point of failure. When an attacker gets the key, the tokens move in one transaction and the issuer finds out from users or from a price chart.

| incident | when | what happened | source |
|---|---|---|---|
| Resolv USR | 22 Mar 2026 | Attacker minted ~80M unbacked USR and extracted ~$25M before the protocol was paused | [The Block](https://www.theblock.co/post/394582/resolvs-usr-stablecoin-depegs-after-attacker-mints-80-million-unbacked-tokens-extracts-roughly-25-million) |
| StablR (EURR, USDR) | 24 May 2026 | Minting multisig compromised; unbacked tokens issued; ~$2.8M extracted on-chain | [Cointelegraph](https://cointelegraph.com/news/euro-and-usd-stablecoins-depeg-amid-ongoing-28m-stablr-exploit) |
| Gala Games | 20 May 2024 | Compromised admin address minted 5B GALA (~$200M); the attacker sold ~$21M before the wallet was frozen | [The Block](https://www.theblock.co/post/295723/gala-games-exploiter-returns-21-million-taken-from-the-200-million-exploit) |

All three were key or admin compromises, and in each the response (pause, freeze, burn) came after people noticed. Levee makes the "notice and contain" part automatic for both treasury transfers and mints, and makes every legitimate move leave a public receipt first, so "unreceipted" is a precise, machine-checkable definition of theft.

## How it works in depth

In the code, the "payout app" is a payout machine (for example `payouts-server`) that calls the gate, and "Levee" is the gate plus the watcher and the contract.

Four parts. Each one only does one job.

1. **Leash (machine passes on Arkiv).** Each company machine runs an agent that sends a signed heartbeat every 60 s with 7 read-only health checks. The checker keeps a pass for the machine on Arkiv that expires 180 s after the last good heartbeat. A failing check deletes the pass at once. A sleeping laptop just loses its pass. See [docs/LEASH.md](docs/LEASH.md).
2. **Gate (receipt before money).** A machine asks the gate to pay someone. The gate checks: live pass, per-transfer cap, daily cap, known destination, and a fresh watcher heartbeat. If all pass, it fixes the transaction id, writes an `approved` receipt with that id to an HCS topic, waits for consensus, and only then adds its signature as the 2nd of 3 treasury keys. Anything else is refused with a reason and no money moves.
3. **Watcher (match every movement).** The watcher reads every RUPC movement on the Mirror Node and matches it by transaction id to a receipt that reached consensus before it. A movement with no receipt, a receipt that came after it, a reused or mismatched receipt, a cap break, an unknown destination, or a new allowance on the treasury is a breach.
4. **ContainmentController (close only).** On a breach the watcher calls a small contract that holds the Studio freeze, wipe, burn and pause roles. It freezes the treasury, wipes and freezes the receiver, burns unauthorised supply, and optionally pauses the token. The watcher can only close things. Unfreeze, unpause and changing the watcher need 2 of the 3 admins. The incident (breach, each step, its tx id and timing) is published to an HCS topic.

```mermaid
flowchart LR
  subgraph Machines
    A1[agent: payouts-server]
    A2[agent: laptop]
  end
  A1 -- signed heartbeat 60 s --> C[checker]
  A2 -- signed heartbeat 60 s --> C
  C -- create / extend / delete pass, 180 s expiry --> ARK[(Arkiv: levee.pass.v1)]

  A1 -- POST /request --> G[gate]
  G -- pass live? --> C
  G -- watcher heartbeat fresh? --> HB[(HCS heartbeats topic)]
  G -- 1. approved receipt, wait for consensus --> RT[(HCS receipts topic)]
  G -- 2. sign 2 of 3, execute --> T[treasury 2-of-3 KeyList]
  T -- RUPC transfer --> P[payee]

  MN[Mirror Node REST] --> W[watcher]
  RT --> MN
  T --> MN
  W -- heartbeat every 30 s --> HB
  W -- breach: freeze / wipe / burn / pause --> CC[ContainmentController]
  CC -- Studio roles --> TOK[Stablecoin Studio token RUPC]
  W -- incident report --> IT[(HCS incidents topic)]
  AD[3 admins] -- 2 of 3: unfreeze / unpause --> CC
```

## Hedera services used

| service | what Levee uses it for | file |
|---|---|---|
| Stablecoin Studio v4 | RUPC is a real Studio token from the testnet factory `0.0.7353542`; cash-in, freeze, wipe, burn, pause go through the Studio proxy and its role system | [src/setup/token.ts](src/setup/token.ts), [src/setup/studio.ts](src/setup/studio.ts) |
| HTS keys and Studio roles | The controller holds FREEZE, WIPE, BURN and PAUSE roles and never DEFAULT_ADMIN. The gate holds the cash-in role with an unlimited supplier allowance, so legitimate mints are gated too | [src/setup/controller.ts](src/setup/controller.ts) |
| HCS topics with submit keys | 3 topics. receipts: submit key = gate key. incidents and heartbeats: submit key = watcher key. No admin key, so nobody can change the submit key or delete a topic | [src/setup/topics.ts](src/setup/topics.ts), [src/shared/hcs.ts](src/shared/hcs.ts) |
| KeyList threshold account | The company treasury key is a 2-of-3 KeyList {treasurySigner, gate, cold}. Every normal payout needs the gate's signature, and the gate only signs after its receipt is on HCS | [src/setup/accounts.ts](src/setup/accounts.ts) |
| Transaction freezing (fixed tx id) | The gate freezes the transfer (SDK `freezeWith`) before writing the receipt, so the receipt names the exact tx id that will appear on chain | [src/gate/server.ts](src/gate/server.ts) |
| Mirror Node REST | Token movements per account, topic messages, freeze status, block lag (watcher fails closed above 20 s lag), free gas estimates and contract calls | [src/shared/mirror.ts](src/shared/mirror.ts), [src/watcher/watcher.ts](src/watcher/watcher.ts) |
| Smart contract (Hedera EVM) | `ContainmentController.sol`: close-only actions for the watcher, 2-of-3 proposals for anything that opens | [contracts/ContainmentController.sol](contracts/ContainmentController.sol) |
| JSON-RPC relay | Controller deploy through Hashio (EthereumTransaction, gas only) | [src/setup/controller.ts](src/setup/controller.ts) |

## Arkiv

Arkiv powers the payout-machine health pass (the "Leash" add-on rule). Leash stores one pass per machine as an Arkiv entity (`levee.pass.v1`) owned by the checker wallet, with a 180 s lifetime and `permissionlessExtension: false`. Silence means no pass, without a revocation list or a cron job. The gate fails closed if Arkiv's latest block is 10 s or older.

- Why Arkiv: [arkiv/why-arkiv.md](arkiv/why-arkiv.md)
- Schema: [arkiv/schema.md](arkiv/schema.md)
- How we use it, with live entities: [arkiv/how-you-use-arkiv.md](arkiv/how-you-use-arkiv.md)
- Who else can use it: [arkiv/reach.md](arkiv/reach.md)
- Friction log: [arkiv/friction.md](arkiv/friction.md)

## Live on testnet

All IDs are on Hedera testnet, deployed 6 Nov 2026 (also in [dashboard/src/lib/config.ts](dashboard/src/lib/config.ts)).

| what | id |
|---|---|
| Token RUPC (Studio v4, 6 decimals) | [0.0.11333594](https://hashscan.io/testnet/token/0.0.11333594) |
| Studio factory | [0.0.7353542](https://hashscan.io/testnet/contract/0.0.7353542) |
| ContainmentController | [0.0.11333603](https://hashscan.io/testnet/contract/0.0.11333603) |
| Receipts topic (submit key: gate) | [0.0.11333498](https://hashscan.io/testnet/topic/0.0.11333498) |
| Incidents topic (submit key: watcher) | [0.0.11333500](https://hashscan.io/testnet/topic/0.0.11333500) |
| Heartbeats topic (submit key: watcher) | [0.0.11333501](https://hashscan.io/testnet/topic/0.0.11333501) |
| Company treasury (2-of-3 KeyList) | [0.0.11333495](https://hashscan.io/testnet/account/0.0.11333495) |
| Payees | [0.0.11333490](https://hashscan.io/testnet/account/0.0.11333490), [0.0.11333492](https://hashscan.io/testnet/account/0.0.11333492) |
| Demo attacker | [0.0.11333494](https://hashscan.io/testnet/account/0.0.11333494) |
| Admins | [0.0.11333483](https://hashscan.io/testnet/account/0.0.11333483), [0.0.11333484](https://hashscan.io/testnet/account/0.0.11333484), [0.0.11333485](https://hashscan.io/testnet/account/0.0.11333485) |

## Measured results

All runs on testnet, 6 Nov 2026. Raw numbers are in [docs/LIVE_RUN.md](docs/LIVE_RUN.md) and the incident messages on topic [0.0.11333500](https://hashscan.io/testnet/topic/0.0.11333500).

### Stolen-key drain (the attack bypasses the gate with 2 of the 3 treasury keys)

Times are measured from the theft's consensus timestamp. "Watcher" columns are the watcher's own clock when each step's receipt came back (as published in the incident). "Consensus" columns are the containment transaction's consensus timestamp on the Mirror Node.

| run | amount | detected (watcher) | treasury frozen (watcher / consensus) | receiver wiped + frozen (watcher / consensus) | txs |
|---|---|---|---|---|---|
| **latest run** (fresh Mirror reads + coverage proof) | 1,000 RUPC | 2.87 s | 4.85 s / 4.17 s | 6.86 s / 5.62 s | [theft](https://hashscan.io/testnet/transaction/0.0.11333495-1793942673-449451952) · [freeze](https://hashscan.io/testnet/transaction/0.0.11333487-1793942676-864043046) · [wipe](https://hashscan.io/testnet/transaction/0.0.11333487-1793942678-498951813) |
| second run (3 s receipt grace only) | 1,000 RUPC | 6.89 s | 9.44 s / 8.28 s | 10.72 s / 10.17 s | [theft](https://hashscan.io/testnet/transaction/0.0.11333495-1793940607-721315934) · [freeze](https://hashscan.io/testnet/transaction/0.0.11333487-1793940615-613691402) · [wipe](https://hashscan.io/testnet/transaction/0.0.11333487-1793940618-278571902) |
| first full run (before the grace) | 10,000 RUPC | 4.19 s | 6.44 s / 5.48 s | 8.31 s / 7.22 s | [theft](https://hashscan.io/testnet/transaction/0.0.11333495-1793935170-233904996) · [freeze](https://hashscan.io/testnet/transaction/0.0.11333487-1793935173-898405003) · [wipe](https://hashscan.io/testnet/transaction/0.0.11333487-1793935180-013412119) |

The second run was slower because the watcher waited out most of the 3 s receipt grace on a quiet receipts topic. The latest run reads the Mirror Node fresh and proves from one answer that no receipt can still be unread, so it judges the theft without waiting (see Design decisions). The latest run was reopened 2 of 3 afterwards: treasury [propose](https://hashscan.io/testnet/transaction/0.0.11333483-1793942707-749023249) / [approve](https://hashscan.io/testnet/transaction/0.0.11333484-1793942710-022256943), attacker [propose](https://hashscan.io/testnet/transaction/0.0.11333483-1793942713-763876883) / [approve](https://hashscan.io/testnet/transaction/0.0.11333484-1793942712-224380819). The second run was reopened the same way: treasury [propose](https://hashscan.io/testnet/transaction/0.0.11333483-1793940640-406300935) / [approve](https://hashscan.io/testnet/transaction/0.0.11333484-1793940644-187266580), attacker [propose](https://hashscan.io/testnet/transaction/0.0.11333483-1793940643-925485422) / [approve](https://hashscan.io/testnet/transaction/0.0.11333484-1793940645-297104239).

### Normal payouts and false alarms

| run | payouts | matched | breaches | notes |
|---|---|---|---|---|
| A (before the grace) | 100 planned | 5 | 1 false alarm | Receipt reached consensus 0.88 s before the transfer, but the receipts read got a cached Mirror answer (the public Mirror sits behind a CDN with `max-age=1`) that did not include it yet. Containment then froze the treasury, so 94 later transfers failed |
| B (grace on) | 100 | 100 | 0 | 42,595 RUPC moved in 376 s |
| C (grace on) | 193 of 300 | 193 | 0 | 3 matches needed the grace. The Mac slept after 193; the other 107 were refused `no-pass` (pass expired), as designed |
| D (fresh reads + coverage proof) | 100 | 100 | 0 | 0 incidents, 0 late matches |

| metric | value | source |
|---|---|---|
| Gate latency (request to signed transfer) | p50 3.66 s (run B), 3.47 s (run C) | LIVE_RUN.md §2 |
| Watcher match after the gate's reply | p50 2.2 s, p95 4.0 s (B) / 3.7 s (C); p50 1.58 s, max 2.92 s (D) | LIVE_RUN.md §2 |
| Fee per gated payout | ≈ 0.020 HBAR (0.016 transfer + 0.004 receipt) | LIVE_RUN.md, Budget |
| Fee per containment | ≈ 0.23 HBAR (freeze 0.096 + wipe+freeze 0.138, latest run) | Mirror Node `charged_tx_fee` |
| Gate throughput (one gate, serial) | ≈ 0.27 payouts/s (100 in 376 s) | LIVE_RUN.md run B |
| Mirror visibility after consensus | median 2.95 s over 3 runs (early test); ingest lag p50 1.7 s, p99 2.8 s with fresh reads | [docs/FIRST_HOUR_TESTS.md](docs/FIRST_HOUR_TESTS.md) T4, LIVE_RUN.md §4 |
| Unit tests | 272 root (incl. controller EVM tests) + 78 dashboard, no network or keys | `npx vitest run`, CI |

Gate refusals seen live (no money moves, no receipt written): `no-pass` (laptop failing the remote-access check, 347 ms), `over-transfer-cap` (669 ms), `unknown-destination` (969 ms), `no-pass` for a never-enrolled machine (20 ms).

## Design decisions

- **Call the Studio factory directly.** The Studio SDK's `StableCoin.create()` always sends 80 HBAR and a 10M gas limit. `src/setup/token.ts` builds the same request and calls the factory's `deployStableCoin` with a Mirror Node gas estimate (+15%). The token is a normal Studio token; any Studio tooling can manage it.
- **Containment order: freeze treasury, then wipe → freeze receiver, then burn, then pause.** The treasury goes first to stop further outflows. Hedera refuses to wipe a frozen account (`ACCOUNT_FROZEN_FOR_TOKEN`, test T2), so the controller wipes before it freezes, in one transaction; for an already frozen account `wipeFrozen` unfreezes, wipes and refreezes atomically. A paused token rejects freeze, wipe and burn (`TOKEN_IS_PAUSED`, test T3), so pause is always last and off by default (`PAUSE_ON_BREACH`).
- **Close-only watcher.** The watcher key can freeze, wipe, burn and pause. It cannot unfreeze, unpause or replace itself; those need 2 of 3 admins on the controller. A stolen watcher key can cause an outage, not a theft.
- **Fresh Mirror reads, a coverage proof, and a grace as backstop.** Run A raised a false alarm because the public Mirror Node sits behind a CDN with `max-age=1`, so an unchanged URL can return an answer about 1 s old: the receipts read was older than the movements read. The watcher now makes every polling URL unique (cache-busted) and reads, in one ascending listing, every transaction touching the watched accounts or the gate. Every receipt is a gate-paid message, so an answer that already holds the movement and no gate message before it proves the movement has no receipt, and the watcher acts at once. A movement whose only fault is "no receipt yet" and that is not proven still waits up to `WATCHER_RECEIPT_GRACE_MS` (3 s). The receipt must still have reached consensus before the movement. (commits `2627532`, `4f53393`)
- **Fail closed everywhere.** No pass, Arkiv block older than 10 s, watcher heartbeat older than 120 s, or Mirror lag above 20 s: the gate refuses. A sleeping machine is reported `offline`, never as a breach.
- **Machine profiles fixed at enrolment.** `laptop` runs all 7 checks; `server` and `ci` skip disk, extensions and remote-access. A machine cannot switch profile later to skip checks.
- **Receipt before signature, by tx id.** The gate fixes the transaction id first, so the receipt and the transfer refer to the same id and the watcher's match is exact, not heuristic.

## Quick start

Needs Node 20+ (CI uses 24), a Hedera testnet account from [portal.hedera.com](https://portal.hedera.com), and a funded Arkiv Rabdi wallet ([hub.arkiv.network](https://hub.arkiv.network)).

```sh
npm ci
cp .env.example .env          # OPERATOR_ID, OPERATOR_KEY, ARKIV_PRIVATE_KEY, ARKIV_ACCESS_KEY, caps
npm run setup                 # accounts -> topics -> Studio token -> controller (skips what exists)
npm run setup:status          # what is left + operator balance
npm run t1 && npm run t2 && npm run t3 && npm run t4   # live role, wipe-order, pause, timing tests

scripts/demo/up.sh            # checker (Arkiv) -> agents -> watcher -> gate; keeps the Mac awake
npx tsx scripts/demo/normal-path.ts          # 1 approved payout + 3 refusals
npx tsx scripts/demo/normal-load.ts 100      # false-alarm test: asserts matched == N, breaches == 0
npx tsx scripts/attack.ts 1000               # stolen 2-of-3 keys drain 1,000 RUPC around the gate
npx tsx scripts/reopen.ts treasury attacker  # 2-of-3 admins unfreeze after the incident
scripts/demo/down.sh

cd dashboard && npm ci && npm run dev        # landing + /live control room on :5173
DEMO_MODE=1 npm run demo:runner              # (repo root) lets the dashboard run pay / attack / reopen; 127.0.0.1 only
```

`state/` holds keys and deployment output and is gitignored. Tests: `npx vitest run` (root) and `cd dashboard && npx vitest run`. API reference: [docs/API.md](docs/API.md).

## Network impact (projection)

Per company that adopts Levee, from the setup plan in `src/setup/plan.ts`:

- New accounts: 6 (3 admins, watcher, gate, 2-of-3 treasury), plus one association per payee.
- Other entities: 3 HCS topics, 1 Studio token (or an existing one), 1 contract.
- Per payout: 2 transactions (1 HCS receipt + 1 HTS transfer).
- Watcher heartbeats: 1 HCS message every 30 s = 2,880 per day per watcher.
- Per incident: 2 to 4 contract calls + 1 HCS incident message.

Worked example, labelled as a projection, not traction: a payout fintech doing 1,000 payouts a day would add 2,000 payout transactions plus 2,880 heartbeats, about 4,880 transactions a day (≈ 146,000 a month). At the measured ≈ 0.020 HBAR per payout, fees for the payouts alone are about 20 HBAR a day. Ten such companies would add 60 accounts and about 1.5M transactions a month.

## Mainnet readiness

- **Dedicated Mirror Node.** The public Mirror Node has a CDN cache (`max-age=1`), ingest lag (p50 1.7 s, p99 2.8 s measured) and rate limits. Production should use a paid or self-hosted Mirror Node. We measured the Mirror gRPC topic subscription at about 0.3 s earlier than fresh REST, but a stream cannot prove that nothing was missed on a quiet topic, so it was not adopted (`scripts/demo/mirror-stream-lag.ts`).
- **Keys in KMS or HSM.** Gate, watcher, admin and treasury keys are files in `state/` for the demo. On mainnet they belong in a KMS/HSM with per-key policies; the cold treasury key stays offline.
- **Audit.** `ContainmentController.sol` has not been audited.
- **Gate throughput.** One gate is serial and measured at ≈ 0.27 payouts/s (p50 3.66 s each, most of it HCS consensus and transfer execution). To scale: run several gates, each with its own pre-assigned daily budget and destination set, or batch several payouts into one receipt and one multi-party transfer. The watcher is read-only and not the bottleneck.
- **Fees.** ≈ 0.020 HBAR per payout and ≈ 0.23 HBAR per containment on testnet. HCS and HTS fees are fixed in USD on Hedera, so the cost per payout does not swing with token price.

## Known limits

- One Mac played both demo machines (`payouts-server` and `laptop-vikram`); only macOS checks exist.
- The heartbeat checks are read-only user-space checks. A root-level attacker on the machine can lie to them; the pass only raises the bar.
- Containment is fast but not instant: the stolen tokens sit in the receiving account for about 6 to 10 s (5.6 s to the wipe's consensus in the latest run). If the attacker moves them on inside that window, the wipe takes only what is left and the receiver is frozen; onward hops are not followed yet (`src/watcher/contain.ts`).
- The public Mirror Node is the only data source; when it lags over 20 s the gate stops all payouts.
- While the watcher is down the gate signs nothing, but a theft that skips the gate in that window is not contained automatically: on restart the watcher reports the day's past breaches without acting on them (`src/watcher/index.ts`).
- Run C did not reach 300 transfers (the Mac slept). The 300 run was not repeated.
- One token, one treasury, one gate per deployment.

## Roadmap

1. Attach to existing Studio tokens: grant the controller the four roles on any Studio token, no redeploy ([docs/BUSINESS.md](docs/BUSINESS.md)).
2. Dedicated Mirror Node for the watcher; target detection under 2 s (2.87 s on the public one today).
3. Windows and Linux agents; MDM-signed baselines.
4. Several gates with split budgets; batched receipts.
5. Audit of the controller; KMS key support.
6. Hosted watcher for Studio issuers who do not want to run infrastructure.

## AI use

Built with Claude Code by Anthropic, which wrote most of the code, tests and docs under review. Images and videos on the landing page were generated with Google Flow / Veo; their watermark is kept. Human decisions by Vikram Singh: the idea, the track choices, the design direction, and review of what was built.

## Team

Vikram Singh.

## License

MIT, see [LICENSE](LICENSE).
