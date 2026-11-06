# Levee: how to explain it

One user (a stablecoin issuer's treasury team), one threat (someone signs with the treasury's keys outside the process), one rule (no receipt, no movement), one response (freeze and claw back). Use the same words every time: payout service, receipt, watcher, contract, admins. Don't pitch it as a salary tool or an AI-agent tool.

## 60 seconds (spoken)

> **No receipt, no movement.**
>
> Levee is a circuit breaker for stablecoin issuers on Hedera.
>
> Take a rupee stablecoin issuer. Its token is RUPC. Its treasury sends RUPC to distributors and partners all day.
>
> The rule: every token that leaves the treasury must have a receipt on Hedera first.
>
> Normal day: the payout service asks Levee to send 500 RUPC to Asha Pay. Levee writes the receipt, waits for consensus, then adds its signature, one of the two treasury keys needed. The watcher finds the receipt and ticks it off.
>
> Now someone steals the treasury keys, or an insider goes rogue, and sends tokens straight out. No receipt. The watcher sees it, and a contract freezes the treasury, takes the tokens back from the receiver and freezes that account. On testnet: detected in 2.87 seconds, all done in 6.86.
>
> Same rule for a stolen minting key: 5,000 RUPC minted with no receipt, wiped from the attacker in 7.5 seconds, supply back where it was.
>
> To reopen, 2 of 3 admins must sign. The contract can close things, never open them.
>
> It only works for tokens you issue, because it needs the token's own freeze and wipe keys. That is why it is for issuers.

## 30 seconds (spoken)

> Levee is a circuit breaker for stablecoin issuers on Hedera. Every token that leaves the issuer's treasury needs a receipt on Hedera first. Sending 500 RUPC to Asha Pay gets a receipt and goes out. If stolen keys or a rogue insider move tokens without one, Levee freezes the treasury and takes them back in about seven seconds. Only 2 of 3 admins can reopen.

## Demo click order (dashboard `/live`)

The buttons run on a laptop with the local runner (`DEMO_MODE=1 npm run demo:runner`). The hosted `/live` page shows the chain state and replays the latest real incident.

1. Open `/live`. Point at the treasury card: "This is the issuer's RUPC treasury. Open: every transfer out needs a receipt first."
2. Click the pay button (it sends 500 RUPC to Asha Pay, the distributor; the runner signs the request with `payouts-server`'s machine key, the same as `npm run request -- --machine payouts-server --to 0.0.11333490 --amount 500`). The receipt appears, then the transfer, then the row turns ✓ matched.
3. Click **Steal / Simulate theft** (the button steals 10,000 RUPC; the latest recorded run used 1,000 and the timing does not depend on the amount). The stopwatch runs: detected, treasury frozen, tokens taken back and receiver frozen.
4. Open the HashScan links in the run log: the theft, the freeze, the wipe, and the incident message on topic 0.0.11333500.
5. Click **Reopen (2 of 3)**. Two admins sign; the treasury shows open again.

Latest recorded numbers (6 Nov 2026, watcher clock from the theft's consensus): detected 2.87 s, treasury frozen 4.85 s, taken back + frozen 6.86 s. Stolen minting key: detected 4.65 s, wiped + frozen 7.53 s. Links are in the README.

Say it if asked: the whole demo runs on one Mac (checker, gate, watcher, both machine agents), and every key file sits on that Mac. The signing itself is split: the gate signs a Hedera scheduled transfer with its own key only, and a separate issuer-signer process adds the second signature after it finds the receipt on Hedera. In a real setup those run on separate machines.

## Likely questions

**1. What if the watcher is down?**
No payments go out. The gate refuses to sign unless the watcher posted a heartbeat on Hedera in the last 2 minutes (`src/gate/decide.ts`, reason `no-watcher`). It also refuses if the Mirror Node is more than 20 s behind. Honest limit: a thief who skips the gate while the watcher is down is not stopped automatically. When the watcher restarts it re-reads the day's movements and reports that theft as a past breach, but it does not claw it back on its own (`src/watcher/index.ts`, priming). An admin has to act. A second, independent watcher would close this gap; it is not built.

**2. What if the hacker moves the money on fast?**
The treasury is frozen first, so no more can leave. The wipe takes whatever is still in the hacker's account (an unknown receiver; a known partner is only frozen, never wiped), and that account is frozen even if it is empty (`src/watcher/contain.ts`). Tokens already moved to a second account are not chased yet; that is on the roadmap. In the latest run the hacker had about 5.6 s before the wipe reached consensus.

**3a. Why issuers?**
Claw-back needs the token's own freeze and wipe keys, and only the issuer holds them. Stablecoin Studio gives them to the issuer as roles it can hand to Levee's contract. The big losses were issuer-side too: Resolv (~$25M), StablR (~$2.8M), Gala (unauthorised 5B GALA mint, ~$21M sold). Sources in the README.

**3b. Can it protect USDC?**
No. Levee only protects tokens you issue, because it needs the token's freeze and wipe keys. Nobody but Circle has those for USDC.

**3c. What about Binance, Fireblocks, custodians?**
The watcher does not care who signed: it reads every movement from the Mirror Node, so an outflow without a receipt is caught whatever wallet or custodian signed it. Today the issuer's own service asks the Levee gate. A custodian or MPC approval callback (the pattern of, for example, the Fireblocks API co-signer callback) is phase 3 and not built; no integration or partnership. An exchange is a recipient: its deposit account goes on the allowlist like Asha Pay. That works as a recipient but is untested with a real exchange.

**3d. Why Hedera?**
Stablecoin Studio gives the token native freeze, wipe, burn and pause roles, so a contract can claw back without custom token code. HCS gives every receipt a public, ordered consensus timestamp, and its submit key means only the gate can write receipts. Threshold keys (2 of 3) are built in. Fees are low and fixed in USD.

**4. Why not just a multisig?**
The treasury already is a 2-of-3 multisig. A multisig stops one stolen key. It does not stop a stolen quorum or a rogue insider who holds enough keys, and the demo attack uses exactly two stolen keys. Levee is the second line: it notices the move and undoes it.

**5. Why a receipt before the payment, not after?**
Hedera orders both by consensus time, so "receipt came first" is provable. A receipt written after the money moved is itself flagged (`receipt-after-movement`). The gate also fixes the payment's transaction id before writing the receipt, so the match is exact.

**6. False alarms?**
0 in 393 live payments since the fixes (plus one later signed payment, also matched). Before them we had 1 in 100: the public Mirror Node sits behind a CDN that can serve a 1 s old answer, so the watcher missed a receipt that existed, and that false alarm wiped our real partner Asha Pay. Now it reads fresh, proves from one answer that no receipt can still be unread before acting, and keeps a 3 s grace as a backstop. And a known partner is never wiped any more, only frozen until admins decide. Details in `docs/LIVE_RUN.md`.

**7. What does it cost?**
About 0.02 HBAR per payment (0.016 transfer + 0.004 receipt) and about 0.23 HBAR per containment, measured on testnet. Plus one watcher heartbeat every 30 s.

**8. How does Arkiv fit?**
It powers one phase-2 rule. The machine that requests payments must be healthy and online before the gate will sign its payment requests. Its pass is an Arkiv entity that expires 3 minutes after its last good health check, and only the checker can extend it, so a dead or switched-off machine loses its pass without anyone revoking it. The gate also refuses if Arkiv itself is stale. Every request must be signed by that same machine's enrolled key, fresh and never replayed, and the machine's role must be allowed (`payouts-server` yes, `laptop-vikram` no: `wrong-role`), so "only a healthy payout machine can ask" is enforced, not just claimed. Honest limits: the checks are macOS only and self-reported by the machine's own agent, so a root-level attacker on that machine can lie to them and use its key. See `arkiv/`.

**9. What can a stolen watcher key do?**
Freeze accounts and wipe receivers' balances through the contract. The "never wipe a partner" rule lives in the watcher's code, not on chain yet, so a stolen watcher key could wipe a partner too. It can never unfreeze, pay or mint, and wiped tokens are burned, not sent anywhere. Production needs the key in a KMS/HSM and an on-chain partner guard (roadmap).

## Objections

| objection | answer |
|---|---|
| "Fireblocks or a multisig already stops this." | They stop bad requests that go through them, before signing. A stolen quorum or an insider signing outside them is not seen; the demo attack uses two of the three treasury keys. Levee watches the ledger whoever signed, and undoes what has no receipt. Use both: Fireblocks (HTS supported since July 2026) as the first line, Levee as the second. |
| "Wiping is risky." | A known partner is never wiped, only frozen until admins decide; only unknown receivers are wiped, and only the amount of the incident. 0 false alarms in 393 payments after the fixes; reopening needs 2 of 3 admins. Honest limit: the partner rule is in the watcher, not yet on chain. |
| "Hedera's stablecoin market is ~$25M, and USDC can't be wiped." | True on both: about $25M ([DefiLlama](https://defillama.com/chain/hedera)), and USDC on Hedera (0.0.456858) has a freeze key but no wipe key. Levee is for issuers who launch their own token on Stablecoin Studio and so hold the wipe key; the market for that is early. |

Not built, so don't claim it: per-machine limits (roles are checked, limits are per deployment), automatically stopping a stolen minting key from minting again, an on-chain partner guard, following stolen tokens across hops, a custodian callback, mainnet, or an audit. Full list: `docs/SCOPE.md`.
