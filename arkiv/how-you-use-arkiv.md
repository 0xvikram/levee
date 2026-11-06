# How Levee uses Arkiv (draft)

1. Create: first good heartbeat for a machine creates `levee.pass.v1` (owner = checker wallet, expiry now + 180 s, `permissionlessExtension: false`).
2. Extend: every later good heartbeat sets expiry to now + 180 s. Writes for all machines in a 300 ms window go out as a single `executeBatch` (creates, patches, extensions, deletes).
3. Patch: only when `postureHash` or `role` changed.
4. Delete: when a heartbeat reports a failing check, the pass entity is deleted at once (immediate revocation instead of waiting up to 180 s).
5. Read: the gate asks the checker, which verifies `getEntity` (exists, `$owner` = checker, `$expiresAt` in the future) and that the latest block is under 10 s old, else fails closed.
6. Discover: `arkiv_query` through the typed schema, `ownedBy(checker)`, only on first sight of a machine or for the dashboard.

Code: `src/shared/arkiv.ts` (ArkivPassStore), `src/checker/core.ts` (pass logic). Live status and transaction hashes: TODO after the wallet is funded (`npm run arkiv:smoke`).
