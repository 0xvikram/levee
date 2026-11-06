# How Levee uses Arkiv

1. Create: first good heartbeat for a machine creates `levee.pass.v1` (owner = checker wallet, expiry now + 180 s, `permissionlessExtension: false`).
2. Extend: every later good heartbeat sets expiry to now + 180 s. Writes for all machines in a 300 ms window go out as a single `executeBatch` (creates, patches, extensions, deletes).
3. Patch: only when `postureHash` or `role` changed.
4. Delete: when a heartbeat reports a failing check, the pass entity is deleted at once (immediate revocation instead of waiting up to 180 s).
5. Read: the gate asks the checker, which verifies `getEntity` (exists, `$owner` = checker, `$expiresAt` in the future) and that the latest block is under 10 s old, else fails closed.
6. Discover: `arkiv_query` through the typed schema, `ownedBy(checker)`, only on first sight of a machine or for the dashboard.

Code: `src/shared/arkiv.ts` (ArkivPassStore), `src/checker/core.ts` (pass logic).

## Live on Rabdi (6 Nov 2026)

The checker ran against the real Rabdi testnet for the whole Hedera live run (docs/LIVE_RUN.md). Explorer: https://rabdi.explorer.arkiv.network

| entity | machine | what the explorer shows | first tx |
|---|---|---|---|
| [`0x13712f0c…b4d30ddd`](https://rabdi.explorer.arkiv.network/entity/0x13712f0cde60f187c6ba55fc4d4035911e0efa010fbb135fee7d1d6db4d30ddd) | `payouts-server` | 1 create (block 275233, 03:37:08 UTC) + 42 extends, last at 04:22:48 UTC | [create](https://rabdi.explorer.arkiv.network/tx/0x8e543021497263d11846e8b7f47dd94497d6954507332c4c5ac5e9057bccad88) |
| [`0x8617a742…c6cf9b63`](https://rabdi.explorer.arkiv.network/entity/0x8617a7424dc899e9ec778baa244810f3c0019ceaeb579db859f8d298c6cf9b63) | `payouts-server` | 1 create (block 277389, 04:49:00 UTC) + 14 extends by 05:04 UTC, still being extended | [create](https://rabdi.explorer.arkiv.network/tx/0x21b0b2361a2ee2031da936382ca4f6b31675de993c8e52e43697bca37f69f53f) |

The first entity is the pass used for the normal path and false-alarm runs B and C (the normal-path record in `state/live-normal-path-*.json` names it as `arkivEntityKey`). Its last extension is at 04:22:48 UTC; the Mac went into idle sleep at 04:22:54 UTC (`pmset` log, LIVE_RUN.md run C). Nobody extended it, so it expired 180 s later and the gate refused the remaining 107 payouts with `no-pass: … pass expired`. After wake the agent's next good heartbeat created the second entity. That is the expiry rule doing its job with no revocation step.

`laptop-vikram` has no live entity: its remote-access check fails on every heartbeat, so the checker keeps no pass for it (`arkivEntityKey: null` on `GET /passes`) and the gate refuses it with `no-pass`.

Attributes on the live entities, as the explorer shows them: `arkiv.schema = levee.pass.v1`, `machine`, `role`, `postureHash`, `status = live`, lifetime 90 blocks.
