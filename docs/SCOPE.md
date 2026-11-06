# Levee: scope and hard limits

Levee is a circuit breaker for stablecoin issuers on Hedera. Every token that leaves the issuer's treasury must have a receipt on Hedera first. If tokens move without one — stolen keys, a rogue insider — Levee freezes the treasury and takes them back in about seven seconds, and only 2 of 3 admins can reopen.

- **One user:** the issuer's treasury and ops team.
- **One threat:** someone signs with the treasury's keys outside the normal process.
- **One rule:** no receipt, no movement.
- **One response:** freeze and claw back (a known partner is frozen, never clawed back).

**Why issuers only.** Clawing tokens back needs the token's own freeze and wipe keys. Only the issuer holds those; Hedera Stablecoin Studio gives them to the issuer and lets the issuer hand them to a contract as roles. The big losses were issuer-side too: Resolv (~$25M), StablR (~$2.8M), Gala (unauthorised 5B GALA mint, ~$21M sold). Sources are in the [README](../README.md#problem).

**Example used everywhere.** A rupee stablecoin issuer with token RUPC ([0.0.11333594](https://hashscan.io/testnet/token/0.0.11333594), live on testnet). Its treasury sends RUPC to its distributors and partners: Asha Pay (distributor, [0.0.11333490](https://hashscan.io/testnet/account/0.0.11333490)) and Ravi Exchange (partner, [0.0.11333492](https://hashscan.io/testnet/account/0.0.11333492)).

**Claw back means wipe.** The tokens are wiped from the receiver's account with the token's wipe key, so total supply drops by that amount. They do not travel back to the treasury; the issuer re-mints if it wants the treasury balance restored.

**Partners are frozen, never wiped.** If the receiver is a known recipient (the setup payees, Asha Pay and Ravi Exchange), the watcher only freezes it, with the note "known partner: frozen, not wiped; admins decide". Only unknown receivers are wiped. Reason: the run A false alarm on the morning of 6 Nov 2026 wiped Asha Pay before this rule existed (commit `3c9bb93`, `src/watcher/contain.ts`). The rule lives in the watcher, not in the contract (see the watcher key limit below).

## Phase 1: the product (built, live on testnet)

**What it does.** The issuer's payout service asks Levee to send, for example, 500 RUPC to Asha Pay. Levee writes a receipt to an HCS topic, waits for consensus, then adds its signature as one of the two treasury keys a payment needs (the treasury is a 2-of-3 KeyList). The watcher checks every RUPC movement against the receipts. Any treasury outflow without a receipt that reached consensus before it leads to: freeze the treasury, wipe the tokens from an unknown receiver and freeze it (a known partner is only frozen). A mint without a receipt leads to: wipe the minted tokens from the receiver and freeze it; the treasury is not frozen, because a mint is not a treasury outflow. Only 2 of 3 admins can reopen.

**Proof (testnet, 6 Nov 2026).** Stolen treasury keys: detected 2.87 s, treasury frozen 4.85 s, tokens wiped and receiver frozen 6.86 s after the theft reached consensus. Stolen minting key: 5,000 RUPC minted to the attacker with no receipt, detected 4.65 s, wiped + frozen 7.53 s (watcher clock; 6.09 s by consensus), total supply back to the pre-mint value, the attacker's retry bounced `ACCOUNT_FROZEN_FOR_TOKEN` ([LIVE_RUN.md](LIVE_RUN.md) §5). 0 false alarms in 393 receipted payments (runs B, C, D; one later signed payment also matched and is not counted). Both incidents reopened live with 2 of 3 admins. Links and raw numbers: [README](../README.md#measured-results), [LIVE_RUN.md](LIVE_RUN.md).

**Hard limits.**

- Only tokens the issuer created with Stablecoin Studio. It cannot touch USDC or any token you do not issue, because it needs the token's freeze and wipe keys.
- One token, one treasury, one gate per deployment. Testnet only.
- It takes back only what is still in the receiver's account. It does not follow later hops: if the thief moves tokens on before the wipe (about 5.6 s to the wipe's consensus in the latest run), the onward account is not touched (`src/watcher/contain.ts`).
- If the watcher is down, the gate refuses every payment (`no-watcher`, `src/gate/decide.ts`). But a direct theft in that window is not undone after restart: the watcher reports it as a past breach and does not act (`src/watcher/index.ts`, priming).
- Payments that have a valid receipt are trusted. A wrong but approved payment is not caught.
- A stolen minting (CASHIN) key can mint again after its first mint is wiped. Revoking the role or pausing the token is not automatic yet; `PAUSE_ON_BREACH` exists but is off by default. Burning unauthorised supply left in the token treasury (`burnSupply`) is unit-tested only, never run live.
- The watcher key, through the controller, can freeze any account and wipe receivers' balances. The partner rule is enforced in the watcher's code, not on chain (no on-chain allowlist yet), so a stolen watcher key calling the controller directly could also wipe a partner. It can never unfreeze, unpause, pay, mint or replace itself. Production needs it in a KMS/HSM and an on-chain partner guard (phase 3).
- Everything in the demo runs on one Mac. The gate process also loads the issuer's treasury-signer key, so it signs with key 1 (treasury signer) and key 2 (gate) of the 2-of-3 from one process (`src/gate/server.ts`). In a real setup the issuer's service holds its own key and Levee holds only the gate key.

## Phase 2: stricter rules (built, always on in today's code)

Extra checks before Levee signs. If any fails, nothing is signed and no receipt is written. They are always on in today's code; the caps are set in `.env`; there is no switch to turn a check off yet.

- **Signed requests from an allowed machine:** every send request is signed by the requesting machine's enrolled key (EIP-191 over canonical JSON `{machine,to,amount,kind,nonce,sentAt}`). The gate refuses `unknown-machine` (not enrolled, or the checker cannot be asked: fails closed), `bad-signature` (unsigned, or not that machine's key), `stale-request` (`sentAt` more than 60 s off), `replayed-request` (nonce already used) and `wrong-role` (role not in `GATE_ALLOWED_ROLES`, default `finance,payouts`). Demo: `payouts-server` has role `payouts`; `laptop-vikram` has role `employee` and is refused. Enrolment is locked by a per-run `ENROL_TOKEN`. Live: [LIVE_RUN.md](LIVE_RUN.md) §6.
- **Caps:** a limit per payment (`CAP_PER_TRANSFER`) and per day (`CAP_PER_DAY`).
- **Known recipients only:** RUPC can only go to the recipient list set at setup (Asha Pay, Ravi Exchange).
- **Machine-health pass on Arkiv:** the service that requests payments must hold a live pass. Its agent sends signed health checks every 60 s; the pass is an Arkiv entity that expires 180 s after the last good check. See [arkiv/](../arkiv/) and [LEASH.md](LEASH.md).

The watcher re-checks caps and the recipient list on every movement too, so a receipt that breaks them is still a breach (`src/watcher/match.ts`).

**Hard limits.**

- Health checks exist for macOS only, and they are self-reported by the machine's own agent. A root-level attacker on that machine can lie to them and also holds the machine key that signs its requests.
- Enrolment records (public key, role) live in the checker's local state, not on Arkiv. `/enrol` is open if `ENROL_TOKEN` is unset (`up.sh` always sets one).
- The replay cache is in memory; a gate restart forgets used nonces, so a captured request could be replayed inside its 60 s window after a restart.
- All of these checks are always on; there is no switch to turn one off yet. The phase-1 rule does not depend on them.

### Arkiv (secondary track)

Arkiv holds the phase-2 health pass: one entity per machine (`levee.pass.v1`), owned by the checker wallet, 180 s lifetime, `permissionlessExtension: false`. Silence means no pass, with no revocation list or cron job. The gate fails closed if Arkiv's latest block is 10 s or older. Details: [why Arkiv](../arkiv/why-arkiv.md), [schema](../arkiv/schema.md), [how we use it](../arkiv/how-you-use-arkiv.md), [reach](../arkiv/reach.md), [friction log](../arkiv/friction.md).

## Phase 3: roadmap (not built)

None of this is built. Do not claim it.

- **Custodian / MPC approval callback.** For issuers whose treasury keys sit with a custodian, Levee would answer the custodian's approve-or-reject callback instead of co-signing. The Fireblocks API co-signer callback is one example of this pattern. There is no partnership or integration.
- **Stop a stolen minting key from minting again.** Detection and wipe of an unauthorised mint are built and ran live (phase 1, [LIVE_RUN.md](LIVE_RUN.md) §5). Not built: taking the CASHIN role away from the key that minted, or pausing the token automatically (`PAUSE_ON_BREACH` exists, off by default). The burn of unauthorised supply left in the token treasury (`burnSupply`) is coded and unit-tested but never run live.
- **On-chain partner guard.** Make the controller itself refuse to wipe a known partner, so a stolen watcher key cannot either.
- Several tokens and treasuries per deployment.
- A dedicated Mirror Node (target detection under 2 s).
- Keys in KMS or HSM.
- An audit of `ContainmentController.sol`.
- Mainnet.

## Threats

| threat | Levee | how | evidence |
|---|---|---|---|
| Stolen treasury keys | ✅ reverses it | Outflow with no receipt → freeze treasury, wipe + freeze receiver | Live: 2.87 s detect, 6.86 s contained ([LIVE_RUN.md](LIVE_RUN.md)) |
| Insider moving tokens outside the process | ✅ reverses it | Same rule: no receipt is a breach, whoever signed | Same code path as above (`src/watcher/match.ts`) |
| Compromised payout service asking for odd payments | ⚠️ phase-2 rules | Caps and the recipient list refuse them at the gate and flag them at the watcher | Live refusals `over-transfer-cap`, `unknown-destination` ([README](../README.md#measured-results)) |
| Unauthorised mint with a stolen minting key | ✅ reverses the mint, ⚠️ not a repeat | Mint without receipt → wipe + freeze receiver (live); burn if left in the token treasury (unit tests only). The key keeps its CASHIN role, so it can mint again | Live: 4.65 s detect, 7.53 s wiped + frozen ([LIVE_RUN.md](LIVE_RUN.md) §5) |
| Forged or replayed payment requests | ✅ refused | Requests must be signed by the enrolled machine key, fresh, unreplayed, with an allowed role | Live: `bad-signature`, `wrong-role`, `replayed-request`, `stale-request` ([LIVE_RUN.md](LIVE_RUN.md) §6) |
| Stolen watcher key | ⚠️ outage and loss, no gain | Can freeze accounts and wipe receivers (partners too: the guard is off-chain); cannot unfreeze, pay or mint | `contracts/ContainmentController.sol` |
| Watcher down during a theft | ❌ | Gate refuses payments, but the theft is only reported after restart | `src/watcher/index.ts` priming |
| Thief moves funds onward | ⚠️ partial | Treasury frozen first; wipe takes what is left; receiver frozen; next hop not followed | `src/watcher/contain.ts` |
| Tokens you did not issue (USDC) | ❌ | No freeze or wipe key | By design |
| Approved payment to the wrong recipient | ❌ | A valid receipt is trusted | By design |
| 2 of 3 admins colluding | ❌ | They can reopen and reset the watcher | `contracts/ContainmentController.sol` |

## Works with your signer

| setup | status | how it works |
|---|---|---|
| A. Issuer's own payout service + Levee gate | Built | The service asks the gate with a signed request (`npm run request`, `POST /request`). The treasury is a 2-of-3 KeyList; the gate signs only after the receipt reaches consensus (`src/gate/server.ts`) |
| B. Custodian / MPC callback | Roadmap (phase 3) | Levee would answer the custodian's approval callback. Not built |
| C. Exchange as a destination | Works as a recipient; untested with a real exchange | An exchange deposit account is just an allowlisted recipient. It must be associated with the token |

The watcher does not care who signed. It reads every movement from the Mirror Node and checks it against the receipts, so any outflow without a receipt is caught, whatever wallet or custodian produced the signature.

## Settings vs fixed

| settable | how |
|---|---|
| Caps per payment and per day | `CAP_PER_TRANSFER`, `CAP_PER_DAY` in `.env` |
| Recipient list | The payees in `state/deploy.json`, written at setup |
| Which phase-2 rules are on | Not a setting yet: all are always on in the code. Raising caps loosens them |
| Roles allowed to request payments | `GATE_ALLOWED_ROLES` (default `finance,payouts`) |
| Enrolment lock | `ENROL_TOKEN` on the checker (`up.sh` makes a random one per run) |
| `PAUSE_ON_BREACH` | Off by default. When on, the token is paused after the other steps |
| Watcher | Changed only by a 2-of-3 admin proposal (`SetWatcher`) |
| Admins | Set when the controller is deployed; cannot be changed afterwards |

| fixed | where |
|---|---|
| The receipt must reach consensus before the movement | `src/watcher/match.ts` (`receipt-after-movement`) |
| The contract can only close things, never open, pay or mint | `ContainmentController.sol`: the watcher can freeze, wipe, burn and pause; it has no transfer or mint function |
| A known partner is frozen, never wiped | `src/watcher/contain.ts` (`PARTNER_WHY`); enforced by the watcher, not on chain |
| Reopen needs 2 different admins | `THRESHOLD = 2`, a repeat approval reverts `AlreadyApproved` |
| Every incident is public on HCS | Incidents topic [0.0.11333500](https://hashscan.io/testnet/topic/0.0.11333500), submit key = watcher |
