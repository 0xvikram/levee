# Reach

Honest status on 6 Nov 2026: Levee is the only user of `levee.pass.v1`. One company (the demo), two machines (`payouts-server`, `laptop-vikram`), both on one Mac. No outside integrators yet.

## Who could use the pass

- **Any team whose machines can move money.** The schema is not tied to Hedera or to Levee's gate: one entity per machine, owned by the company's checker wallet, alive only while the machine keeps passing its checks. A custody desk, a payouts server, or a DAO signer's laptop fits the same shape.
- **Any service that needs "is this device healthy right now".** A gate, a CI deploy step, an internal admin panel or a signing service can read the pass with one `getEntity` and the rule "exists, owned by the checker, not expired". No API key from us, no database we run.
- **Auditors.** Because extensions and creations are on Arkiv, an auditor can see from the explorer when a machine last held a pass, without trusting the company's own logs.

## What is live today

- Two `levee.pass.v1` entities on Rabdi for `payouts-server`, with 43 and 15+ operations (see [how-you-use-arkiv.md](how-you-use-arkiv.md)).
- One heartbeat round every 60 s per machine, batched into a single transaction per 300 ms window.

## Next

- Windows and Linux agents (only macOS checks exist today).
- Per-role check sets and MDM-signed baselines.
- A small read-only client so other services can check a pass without the Levee checker.
