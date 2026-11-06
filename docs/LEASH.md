# Leash (phase 2): machine health passes on Arkiv

A company machine only gets to ask for money moves while it holds a live **pass**, and only by signing the request with its own enrolled key. The pass is one Arkiv entity per machine that expires 180 s after its last good heartbeat. The agent never judges transactions; it only says whether the machine is healthy.

**Role is enforced.** Each machine is enrolled with a role (default `employee`). The gate accepts payment requests only from machines whose role is in `GATE_ALLOWED_ROLES` (default `finance,payouts`). Demo: `payouts-server` is enrolled as `payouts` (allowed); `laptop-vikram` as `employee`, so even with a live pass it would be refused `wrong-role`.

**Requests are signed by the same key as heartbeats.** `npm run request -- --machine payouts-server --to 0.0.x --amount 500` (from the repo root) signs canonical JSON `{machine,to,amount,kind,nonce,sentAt}` with `state/machine-<name>.key` (EIP-191). The gate fetches the enrolled key and role from the checker (`GET /machine/:name`) and refuses `bad-signature`, `unknown-machine`, `stale-request` (more than 60 s), `replayed-request` or `wrong-role` before it looks at the pass. Naming a machine is not enough; you need its key. Details: [API.md](API.md#post-request).

```
agent (each machine)  --signed heartbeat every 60 s-->  checker  --create/extend-->  Arkiv entity "levee.pass.v1"
                                                          ^                                   |
                                                    GET /pass/:machine  <------- gate --------+ (live only if entity exists, owned by checker, unexpired, Arkiv block < 10 s old)
                                                    GET /machine/:name  <------- gate  (enrolled key + role, to verify the signed request)
```

## The 7 checks (macOS, read-only, no sudo)

| id | what | fails when |
|---|---|---|
| persistence | names+mtimes in ~/Library/LaunchAgents, /Library/LaunchAgents, /Library/LaunchDaemons | differs from state/baseline.json |
| remote-access | AnyDesk, TeamViewer, RustDesk, ScreenConnect, Splashtop, Parsec in /Applications or running | any present |
| ports | `netstat -anv -p tcp` listeners on 22 3389 5900 2375 6379 8888 9222 9229 5432 6443 10250 | bound beyond loopback |
| devtools | sha256 of node, python3, git, npm, brew, ~/.pyenv/shims/* | differs from baseline |
| protections | `spctl --status`, `csrutil status` | Gatekeeper or SIP off |
| disk | `fdesetup status` | FileVault off |
| extensions | ~/.vscode and ~/.cursor extensions added in last 24 h (+ `npm ls -g` count) | any new |

## Machine profiles (`--profile laptop|server|ci`, default laptop)

| profile | checks run | skipped |
|---|---|---|
| laptop | all 7 | none |
| server | persistence, ports, devtools, protections | disk, extensions, remote-access |
| ci | same as server | same as server |

Why the three are laptop-only:

- **disk (FileVault)** protects a lost or stolen laptop. A server's disk sits in a locked rack or is a cloud volume with its own at-rest encryption, and FileVault is a per-user macOS laptop control that a headless box usually cannot enable without a person at boot.
- **extensions** looks for newly installed VS Code / Cursor extensions, a common route onto a developer's laptop. Nobody installs editor extensions on a payouts server or a CI runner, so the check proves nothing there.
- **remote-access** flags consumer remote-desktop apps (AnyDesk, Parsec...). Servers are reached over the ops path (SSH bastion, SSM), which the **ports** check already polices (22, 3389, 5900 must not be exposed).

Persistence, ports, dev-tool integrity and OS protections are what a server compromise actually changes, so they stay on for every profile.

**The profile is fixed at enrolment.** `POST /enrol` stores it; enrolling again with a different profile returns 409. The checker judges every heartbeat by the stored profile, so a laptop cannot "become a server" to skip checks: a heartbeat whose `profile` differs from the enrolled one is rejected (400), and a laptop heartbeat that omits or marks a check `skip` is treated as failing. Skipped checks are sent as `"skip"` in `checks` so the evidence shows what was not run.

**Port allowlist (`LEVEE_ALLOW_PORTS`, off by default).** A DB host is expected to listen on 5432. Setting `LEVEE_ALLOW_PORTS=5432` on that machine's agent stops the ports check failing on it; the allowlisted ports are printed in the check detail and folded into the evidence hash, so the exception is visible on every heartbeat. It is not used in the demo (the demo Mac exposes no sensitive port).

**Demo machines (one Mac plays both):** `payouts-server` (profile server, healthy: 4/4) and `laptop-vikram` (profile laptop, unhealthy on purpose: Parsec is installed and running, so remote-access fails). FileVault is now on, so the disk check passes. If Parsec is quit the laptop would turn healthy; for a guaranteed refusal use `--simulate-fail remote-access` (camelCase `remoteAccess` also accepted) or `echo remote-access > state/simulate-laptop-vikram.fail`. Each machine has its own baseline file, `state/baseline-<machine>.json` (falls back to the legacy `state/baseline.json`).

## Trust rules

- Heartbeat = canonical JSON `{machine, seq, nonce, checks, evidenceHash, sentAt}` signed (secp256k1, EIP-191) with `state/machine-<name>.key` (0600, created by `--enrol`).
- Checker rejects: unknown nonce, expired nonce (60 s), replayed nonce (always burned), bad signature, seq not increasing, clock skew over 120 s.
- Any failing check: no renewal, reason recorded, pass denied at once, entity deleted on Arkiv (best effort).
- A sleeping or offline laptop simply stops heartbeating, so its pass expires. That is reported as `kind: "offline"`, never as a breach.
- Fail closed: if Arkiv is unreachable or its latest block is 10 s or older, `live` is false.
- Only the checker wallet owns passes and can extend them. Entities are created with `permissionlessExtension: false` (SDK default, set explicitly).

## API (checker, port 8712)

`POST /enrol {machine, publicKey, role, profile}` (header `x-enrol-token`) · `GET /machine/:name` → `{machine, publicKey, role, profile}` · `GET /nonce?machine=` · `POST /heartbeat` · `GET /pass/:machine` → `{live, kind, expiresAt, reason, arkivEntityKey, arkivBlockAgeSeconds}` · `GET /passes` · `GET /events` (SSE). `/enrol` is locked by `ENROL_TOKEN` when it is set on the checker (and agent); `scripts/demo/up.sh` makes a random one per run and passes it only to the processes it starts. Without `ENROL_TOKEN`, `/enrol` is open (401 `bad enrol token` only when a token is set).

## Limits

- macOS checks only, self-reported by the machine's own agent. A root-level attacker on the machine can lie to them and also holds the key that signs its requests.
- Enrolment records (public key, role) are kept in the checker's local state file, not on Arkiv.
- In the demo both machines run on one Mac.

## Run

```
npm run checker                      # real Arkiv (needs tGLM in ARKIV_PRIVATE_KEY wallet)
npm run checker -- --memory          # offline: passes kept in memory, nothing written to Arkiv
npm run agent -- --machine laptop-1 --enrol         # key + baseline + register (once)
npm run agent -- --machine payouts-server --profile server --enrol   # server profile (pass --profile on every run)
npm run agent -- --machine laptop-1                 # heartbeat loop (--interval 60)
npm run agent -- --machine laptop-1 --once          # one heartbeat
npm run agent -- --machine laptop-1 --simulate-fail ports   # demo an unhealthy machine
echo disk > state/simulate-laptop-1.fail            # flip a failure on mid-run (empty the file to clear)
npm run arkiv:smoke                  # live create/extend/delete of one pass (skips if balance is 0)
npx vitest run tests/agent tests/checker
```

Set `ARKIV_ACCESS_KEY` (free at hub.arkiv.network/access-keys). Without it Rabdi uses the public endpoint, where `arkiv_query` is rate limited (a 429 can hang ~30 min), so the store only queries to discover a pass it has not seen, then uses `getEntity` by key.

## Cost note

One executeBatch transaction per 300 ms window carries every create/patch/extend/delete queued in it, so N machines cost one transaction per heartbeat round, not N.
