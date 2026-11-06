# Layer 1: Leash (machine health passes on Arkiv)

A company machine only gets to ask for money moves while it holds a live **pass**. The pass is one Arkiv entity per machine that expires 180 s after its last good heartbeat. The agent never judges transactions; it only says whether the machine is healthy.

```
agent (each machine)  --signed heartbeat every 60 s-->  checker  --create/extend-->  Arkiv entity "levee.pass.v1"
                                                          ^                                   |
                                                    GET /pass/:machine  <------- gate --------+ (live only if entity exists, owned by checker, unexpired, Arkiv block < 10 s old)
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

The demo Mac has FileVault off, so check 6 fails on purpose: it shows an unhealthy machine.

## Trust rules

- Heartbeat = canonical JSON `{machine, seq, nonce, checks, evidenceHash, sentAt}` signed (secp256k1, EIP-191) with `state/machine-<name>.key` (0600, created by `--enrol`).
- Checker rejects: unknown nonce, expired nonce (60 s), replayed nonce (always burned), bad signature, seq not increasing, clock skew over 120 s.
- Any failing check: no renewal, reason recorded, pass denied at once, entity deleted on Arkiv (best effort).
- A sleeping or offline laptop simply stops heartbeating, so its pass expires. That is reported as `kind: "offline"`, never as a breach.
- Fail closed: if Arkiv is unreachable or its latest block is 10 s or older, `live` is false.
- Only the checker wallet owns passes and can extend them. Entities are created with `permissionlessExtension: false` (SDK default, set explicitly).

## API (checker, port 8712)

`POST /enrol {machine, publicKey, role}` · `GET /nonce?machine=` · `POST /heartbeat` · `GET /pass/:machine` → `{live, kind, expiresAt, reason, arkivEntityKey, arkivBlockAgeSeconds}` · `GET /passes` · `GET /events` (SSE). Set `ENROL_TOKEN` on the checker (and agent) to require a token on `/enrol`.

## Run

```
npm run checker                      # real Arkiv (needs tGLM in ARKIV_PRIVATE_KEY wallet)
npm run checker -- --memory          # offline: passes kept in memory, nothing written to Arkiv
npm run agent -- --machine laptop-1 --enrol         # key + baseline + register (once)
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
