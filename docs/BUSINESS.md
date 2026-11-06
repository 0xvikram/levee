# Levee: business model (one page)

Status: hackathon prototype on Hedera testnet. No customers, no revenue, no pilots yet. Everything about pricing and market below is a hypothesis to test, not a result.

## Lean Canvas

| block | Levee |
|---|---|
| **Problem** | 1. A stolen treasury or minter key empties or inflates a stablecoin in one transaction (Resolv USR, Mar 2026, ~$25M extracted; StablR, May 2026, ~$2.8M extracted; sources in the README). 2. Issuers can freeze, but only after a human notices. 3. Auditors and regulators cannot easily check that every treasury move was approved. |
| **Customer segments** | Stablecoin Studio issuers on Hedera; payout and remittance fintechs that hold a Studio token treasury; DAOs and treasuries that pay contributors from a multisig. |
| **Unique value proposition** | Every legitimate move leaves a public receipt on HCS first. Anything without one is frozen and clawed back in about 10 s, with a public incident record. Reopening needs 2 of 3 admins. |
| **Solution** | Gate (receipt before signature), watcher (match every movement by tx id), ContainmentController (close-only roles on the Studio token), Leash (machine passes on Arkiv). |
| **Channels** | Hedera / Stablecoin Studio ecosystem (docs, partner listings, hackathon showcase); direct outreach to Studio issuers visible on testnet and mainnet; security auditors who see the incident pattern; open-source repo. |
| **Revenue streams (hypothesis)** | Monthly fee per protected treasury; per-payout fee above a free tier; paid hosted watcher with alerting; incident-response support. |
| **Cost structure** | Hedera fees (measured ≈ 0.020 HBAR per gated payout, ≈ 0.23 HBAR per containment on testnet); a dedicated Mirror Node or provider; hosting for gate and watcher; a contract audit; KMS/HSM. |
| **Key metrics** | Treasuries protected; gated payouts per month; false alarms per 1,000 payouts (target 0; measured 0 in 293 after the grace fix); median detection and containment time; incidents contained. |
| **Unfair advantage** | Built on Studio's own role model, so it attaches to an existing token without migration. Receipts are on HCS, so the audit trail is public and not ours to edit. |

## Who buys, and why

| buyer | pain | what they get |
|---|---|---|
| Stablecoin Studio issuer | A key leak means unbacked supply or a drained treasury, then a depeg | Automatic freeze, wipe and burn; a public record of every approved move |
| Payout / remittance fintech | Payout servers hold hot keys; a compromised server can send anywhere | Caps, known destinations and machine health checks before any signature; theft contained in seconds |
| DAO / treasury | Multisig signers are people on laptops | Signers' machines must hold a live pass; unapproved outflows are frozen |

## Pricing hypothesis (not validated)

These numbers are placeholders to test in conversations, not quotes.

| tier | who | hypothesis |
|---|---|---|
| Open source | Self-hosted, one treasury | Free |
| Hosted | Studio issuer or fintech, up to 10,000 payouts/month | Flat monthly fee per treasury |
| Volume | Above 10,000 payouts/month | Small per-payout fee on top |

The test: would a buyer pay a monthly fee that is a small fraction of one incident's loss? We will ask that directly (see [VALIDATION.md](VALIDATION.md)).

## Go to market

1. **Hackathon to first conversations.** Use ETHGlobal Mumbai to talk to Hedera, Stablecoin Studio and payout teams; record each one in VALIDATION.md.
2. **Free pilots on testnet.** Attach Levee to a pilot issuer's existing Studio testnet token (steps below) and run their payout flow through the gate for two weeks.
3. **Studio ecosystem listing.** Ask to be listed as a Studio add-on; publish the controller as a reusable contract.
4. **Mainnet with one design partner** after an audit and KMS support.

## How Levee attaches to an existing Studio token

No new token and no migration. The issuer keeps DEFAULT_ADMIN.

1. Deploy `ContainmentController` with the token's proxy address, the watcher address and 3 admin addresses (`npm run setup:controller`).
2. From the Studio admin, grant the controller FREEZE_ROLE, WIPE_ROLE, BURN_ROLE and PAUSE_ROLE. Never DEFAULT_ADMIN.
3. Create 3 HCS topics (receipts, incidents, heartbeats) with submit keys for the gate and watcher (`npm run setup:topics`).
4. Change the paying treasury's key to a 2-of-3 KeyList that includes the gate key. Normal payouts now need the gate's signature, which it gives only after writing a receipt.
5. Optional: grant the gate the cash-in (supplier) role so mints are gated too.
6. Start the watcher, gate and checker. Removing Levee is the reverse: revoke the four roles and change the treasury key back.

## Roadmap

| when | what |
|---|---|
| Now (hackathon) | Testnet: Studio token, gate, watcher, controller, Arkiv passes, dashboard; measured runs in docs/LIVE_RUN.md |
| Next 1 to 2 months | 3 to 5 validation conversations a week; one testnet pilot on an existing Studio token; Mirror gRPC for faster detection |
| Next 3 to 6 months | Controller audit; KMS/HSM keys; several gates with split budgets; Windows/Linux agents |
| Later | Hosted watcher; mainnet design partner; onward-hop tracing for stolen funds |
