# Arkiv schema: `levee.pass.v1`

One entity per machine. Created and owned by the checker wallet.

| attribute | type | indexed | meaning |
|---|---|---|---|
| machine | str | yes | machine name, e.g. `laptop-1` |
| role | str | yes | `employee`, `finance`, ... |
| postureHash | str | yes | sha256 over the 7 check evidence hashes at the last good heartbeat |
| status | str | yes | `live` (a failing machine's pass is deleted, not patched) |

System fields used: `$owner` (must equal the checker wallet), `$expiresAt` (block height; converted to time with `arkiv_getBlockTiming`).

Creation flags: `readonly: false` (postureHash/status are patched), `permissionlessExtension: false` (only the owner may extend).
Lifetime: 180 s (90 blocks at 2 s). Each good heartbeat sets expiry to now + 180 s; extension never shortens.
Defined in `src/shared/arkiv.ts` (`PassSchema`).
