# First-hour tests

Live checks on Hedera testnet that the containment plan works with a real Stablecoin Studio token.
Each test writes its own section below (between the `<!-- Tn -->` markers) when it runs.

## How to run

```sh
npm run setup            # accounts -> topics -> token -> controller (each step skips what exists)
npm run setup:status     # what is left + operator balance
npm run t1 && npm run t2 && npm run t3 && npm run t4
```

## Status (6 Nov 2026)

**Blocked on test HBAR.** Accounts and topics exist; the Studio token and the controller do not yet.
The operator (0.0.11333301) is down to ~2.3 HBAR. The rest of setup plus T1-T4 needs about **40 HBAR**,
and the token step needs ~30 HBAR on hand at once (HTS create fee forwarded as msg.value; the unused part comes back).
One daily top-up of 100 HBAR at portal.hedera.com covers everything.

| Step | Estimate (HBAR) | Measured |
|---|---|---|
| 9 accounts | 7.2 | 6.85 (0.76 each) |
| 3 topics | 1.35 | 0.88 |
| Studio token (deployStableCoin) | ~17.7 (+30 held as msg.value) | other users' factory calls on testnet: 17.5-18.4 |
| 4 token associations | 3.0 | |
| cash-in 1,000,000 RUPC | 0.33 | |
| controller deploy (relay, gas only) + 5 grants | ~2.6 | deploy simulated on Mirror Node: 1.29M gas |
| account HBAR balances (admins 0.5 each, watcher 1.5, gate 1, treasury 1) | 5.0 | deferred |
| T1-T4 | ~4 | |

## Findings so far (before the token exists)

- Studio SDK `StableCoin.create()` always sends 80 HBAR and a 10M gas limit; `token.ts` calls the
  factory's `deployStableCoin` directly with the same request instead. The request encodes correctly:
  a Mirror Node simulation runs it up to the HTS create call, which needs ≥ ~20 HBAR of msg.value
  (below that it reverts `ResponseCodeInvalid(9 = INSUFFICIENT_TX_FEE)`).
- `ContainmentController` bytecode deploys on Hedera (cancun target) in a Mirror Node simulation: 1,288,203 gas.
- Studio v4 `freeze/unfreeze/wipe/burn/pause/unpause` all return `bool`, matching `IStudioToken` in the controller.
- Studio cash-in is `mint(address,int64)` on the proxy; the CASHIN role is granted with
  `grantUnlimitedSupplierRole(address)` (SupplierAdminFacet), not `grantRole`.
- Demo accounts have an EVM alias, so `msg.sender` is the alias address for both HAPI ContractExecute and
  JSON-RPC calls; the treasury (threshold key) uses its long-zero address.
