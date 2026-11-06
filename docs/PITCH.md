# Levee: how to explain it

One use case, one rule, then add-ons. Use the same words every time: payout app, receipt, watcher, contract, admins.

## 60 seconds (spoken)

> **No receipt, no movement.**
>
> A company makes its own stablecoin with Hedera Stablecoin Studio. It keeps the coins in a treasury and pays people from it: payroll, payouts.
>
> Levee adds one rule: every token that leaves the treasury must have a receipt on Hedera first.
>
> A normal payment: the payout app asks Levee "pay Asha 500". Levee writes the receipt on Hedera, then sends the money. The watcher sees the payment, finds its receipt, and marks it done.
>
> Now a theft: a hacker steals the treasury keys and sends tokens straight out, skipping Levee. The watcher sees money leave with no receipt. A contract freezes the treasury, takes the tokens back from the hacker's account, and freezes that account. The incident is written on Hedera. On testnet that took under 7 seconds.
>
> To reopen, 2 of 3 admins must sign together. The contract and the watcher can close things, never open them.
>
> On top of the one rule you can switch on more checks, one at a time: spending caps, known payees only, and a health pass for the payout machine that lives on Arkiv and expires in 3 minutes.

## 30 seconds (spoken)

> No receipt, no movement. A company pays people from its Stablecoin Studio treasury. Levee's one rule: every payment needs a receipt on Hedera first. Normal payments get a receipt, then go out, and the watcher ticks them off. If a hacker with stolen keys moves money without a receipt, a contract freezes the treasury and takes the tokens back in seconds. Only 2 of 3 admins can reopen it.

## Demo click order (dashboard `/live`)

The buttons run on a laptop with the local runner (`DEMO_MODE=1 npm run demo:runner`). The hosted `/live` page shows the chain state and replays the latest real incident.

1. Open `/live`. Point at the treasury card: "Open, every payout needs a receipt first."
2. Click **Pay Asha 500**. The receipt appears, then the payment, then the row turns ✓ matched.
3. Click **Steal / Simulate theft** (the button steals 10,000 RUPC; the latest recorded run used 1,000 and the timing does not depend on the amount). The stopwatch runs: detected, treasury frozen, tokens taken back and hacker frozen.
4. Open the HashScan links in the run log: the theft, the freeze, the wipe, and the incident message on topic 0.0.11333500.
5. Click **Reopen (2 of 3)**. Two admins sign; the treasury shows open again.

Latest recorded numbers (6 Nov 2026, watcher clock from the theft's consensus): detected 2.87 s, treasury frozen 4.85 s, taken back + frozen 6.86 s. Links are in the README.

## Likely questions

**1. What if the watcher is down?**
No payments go out. The gate refuses to sign unless the watcher posted a heartbeat on Hedera in the last 2 minutes (`src/gate/decide.ts`, reason `no-watcher`). It also refuses if the Mirror Node is more than 20 s behind. Honest limit: a thief who skips the gate while the watcher is down is not stopped automatically. When the watcher restarts it re-reads the day's movements and reports that theft as a past breach, but it does not claw it back on its own (`src/watcher/index.ts`, priming). An admin has to act. A second, independent watcher would close this gap; it is not built.

**2. What if the hacker moves the money on fast?**
The treasury is frozen first, so no more can leave. The wipe takes whatever is still in the hacker's account, and that account is frozen even if it is empty (`src/watcher/contain.ts`). Tokens already moved to a second account are not chased yet; that is on the roadmap. In the latest run the hacker had about 5.6 s before the wipe reached consensus.

**3. Why Hedera?**
Stablecoin Studio gives the token native freeze, wipe, burn and pause roles, so a contract can claw back without custom token code. HCS gives every receipt a public, ordered consensus timestamp, and its submit key means only the gate can write receipts. Threshold keys (2 of 3) are built in. Fees are low and fixed in USD.

**4. Why not just a multisig?**
The treasury already is a 2-of-3 multisig. A multisig stops one stolen key. It does not stop a stolen quorum or a hacked payout server, and the demo attack uses exactly two stolen keys. Levee is the second line: it notices the move and undoes it.

**5. Why a receipt before the payment, not after?**
Hedera orders both by consensus time, so "receipt came first" is provable. A receipt written after the money moved is itself flagged (`receipt-after-movement`). The gate also fixes the payment's transaction id before writing the receipt, so the match is exact.

**6. False alarms?**
0 in 393 live payments since the fixes. Before them we had 1 in 100: the public Mirror Node sits behind a CDN that can serve a 1 s old answer, so the watcher missed a receipt that existed. Now it reads fresh, proves from one answer that no receipt can still be unread before acting, and keeps a 3 s grace as a backstop. Details in `docs/LIVE_RUN.md`.

**7. What does it cost?**
About 0.02 HBAR per payment (0.016 transfer + 0.004 receipt) and about 0.23 HBAR per containment, measured on testnet. Plus one watcher heartbeat every 30 s.

**8. How does Arkiv fit?**
It powers one add-on rule. The payout machine must be healthy and online before the gate will sign its payment requests. Its pass is an Arkiv entity that expires 3 minutes after its last good health check, and only the checker can extend it, so a dead or switched-off machine loses its pass without anyone revoking it. The gate also refuses if Arkiv itself is stale. See `arkiv/`.

Not built, so don't claim it: per-machine roles or per-machine limits (the gate checks the pass, caps, known payee and watcher heartbeat only), following stolen tokens across hops, mainnet, or an audit.
