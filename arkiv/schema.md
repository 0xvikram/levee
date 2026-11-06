# Arkiv schema: `levee.pass.v1`

One entity per machine. Created and owned by the checker wallet.

| attribute | type | indexed | meaning |
|---|---|---|---|
| machine | str | yes | machine name, e.g. `laptop-1` |
| role | str | yes | `employee`, `finance`, `payouts`, ... (copied from enrolment; the gate checks the role from the checker's enrolment record, `GET /machine/:name`, not from this attribute) |
| postureHash | str | yes | sha256 over the 7 check evidence hashes at the last good heartbeat |
| status | str | yes | `live` (a failing machine's pass is deleted, not patched) |

System fields used: `$owner` (must equal the checker wallet), `$expiresAt` (block height; converted to time with `arkiv_getBlockTiming`).

Creation flags: `readonly: false` (postureHash/status are patched), `permissionlessExtension: false` (only the owner may extend).
Lifetime: 180 s (90 blocks at 2 s). Each good heartbeat sets expiry to now + 180 s; extension never shortens.
Defined in `src/shared/arkiv.ts` (`PassSchema`).

## Queries the checker uses

All reads go through `ArkivPassStore` in `src/shared/arkiv.ts`; the gate never reads Arkiv itself, it asks the checker (`GET /pass/:machine`, `src/shared/pass.ts`).

| when | call | code |
|---|---|---|
| Find a machine's pass the first time (key not cached yet) | `select({ $key: true }).from(PassSchema).where(eq("machine", <name>)).ownedBy(<checker wallet>).limit(1).fetch()` | `getPass` |
| Every pass check after that | `getEntity(<entity key>, PassSchema)`; `NoEntityFoundError` = expired or deleted = no pass | `getPass` |
| List all passes (dashboard, `GET /passes`) | `select().from(PassSchema).ownedBy(<checker wallet>).limit(100).fetch()` | `listPasses` |
| Freshness (fail closed at 10 s or older) | `getBlock()` latest block timestamp | `latestBlockAge` |
| Expiry to wall clock | `getBlockTiming()` (`arkiv_getBlockTiming`), cached | `toRecord` |

A pass is live only if: Arkiv's latest block is under 10 s old, the entity exists, `$owner` equals the checker wallet, and its expiry is in the future (`src/checker/core.ts`, `pass`). The `ownedBy` filter means a look-alike entity created by another wallet is never found.
