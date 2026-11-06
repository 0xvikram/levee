# Why Arkiv

Leash needs a liveness signal that disappears by itself when nobody renews it, and that only the company's checker can keep alive. Arkiv gives exactly that as a primitive:

- Expiry is native: a pass is an entity with a lifetime. No cron, no revocation list, no "forgot to revoke". Silence equals no pass.
- Owner-only extension: only the checker wallet can keep a pass alive (`permissionlessExtension: false`), and the checker reports a pass as live only if the entity is owned by the checker wallet, so a pass cannot be planted or extended from outside the checker.
- Public and auditable: anyone (an auditor, the gate, a judge) can query `levee.pass.v1` by machine and see when a machine last had a live pass, with the block it happened in.
- Indexed queries: "which machines have a live pass right now" is one `arkiv_query`, not a database we run.
- Cheap enough to be a heartbeat: one batched transaction per round for every machine.

A normal database would work for one company, but its operator could silently edit it. Arkiv makes the history tamper-evident and the expiry rule not ours to bend.

## What is true today, and what is not

- **Requests are tied to the machine.** A payment request must be signed by the requesting machine's enrolled key (the same key that signs its heartbeats), be fresh (60 s) and unreplayed, and come from an allowed role (`finance`, `payouts`). So a pass only helps the machine that holds it: someone on the network who merely names `payouts-server` is refused `bad-signature`.
- **Enrolment is locked** by a per-run `ENROL_TOKEN`, so nobody can enrol a new machine (and get it a pass) without the token.
- **The pass expires** 180 s after the last good heartbeat, and is deleted at once when a check fails.
- **Limits.** The health checks are macOS only and self-reported by the machine's own agent: a root-level attacker on that machine can make it report healthy and can use its key. Enrolment records (key, role) live in the checker's local state, not on Arkiv. The pass raises the bar; it does not make a compromised machine trustworthy.
