# Arkiv SDK 1.0 / Rabdi friction log

Honest notes for the Arkiv team, written while building Leash (6 Nov 2026).

1. The funded wallet is a prerequisite for everything that writes, and the faucet is behind the hub web UI. A 0 tGLM wallet makes `createEntity` fail only at send time; there is no cheap dry run / gas estimate in the SDK to detect it earlier (we call `eth_getBalance` ourselves).
2. `rabdi({ accessKey: "" })` works but prints a warning and the public endpoint rate limits `arkiv_query` hard (429 can hang ~30 min). We had to design the store to avoid queries on the hot path (query once to discover the key, then `getEntity`).
3. Expiry is in blocks, `$expiresAt` returns a block height. Turning it into wall-clock needs `arkiv_getBlockTiming` (not documented in the README); the README's examples only show `fromDays`.
4. `ExpirationTime.fromSeconds` throws unless the value is a multiple of the 2 s block time, so 180 is fine but arbitrary env values need rounding (we round up to even).
5. `extendEntity` sets a new expiry, never adds, and rejects shortening. Inside a batch, one rejected extension fails the whole transaction, so we retry operations one by one to isolate the bad one.
6. `permissionlessExtension` is a creation flag that cannot be changed later; the default is false, which is what we want, but it is worth passing explicitly so the intent is visible in code review.
7. `NoEntityFoundError` is the only signal for "expired": an expired entity is indistinguishable from one that never existed, so "expired vs. never created" needs our own bookkeeping.
8. README install section lists `viem` as a peer dependency to install by hand, and mentions Node 22.10+.
(Add live-run findings below once the wallet is funded.)
