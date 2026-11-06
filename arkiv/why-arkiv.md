# Why Arkiv

Leash needs a liveness signal that a thief on the company's own network cannot fake and that disappears by itself when nobody renews it. Arkiv gives exactly that as a primitive:

- Expiry is native: a pass is an entity with a lifetime. No cron, no revocation list, no "forgot to revoke". Silence equals no pass.
- Owner-only extension: only the checker wallet can keep a pass alive (`permissionlessExtension: false`), so the signal cannot be forged from outside the checker.
- Public and auditable: anyone (an auditor, the gate, a judge) can query `levee.pass.v1` by machine and see when a machine last had a live pass, with the block it happened in.
- Indexed queries: "which machines have a live pass right now" is one `arkiv_query`, not a database we run.
- Cheap enough to be a heartbeat: one batched transaction per round for every machine.

A normal database would work for one company, but its operator could silently edit it. Arkiv makes the history tamper-evident and the expiry rule not ours to bend.
