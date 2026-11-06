#!/usr/bin/env bash
# Stop every service started by scripts/demo/up.sh, the issuer signer included (each runs in its own process group).
set -uo pipefail
cd "$(dirname "$0")/../.."
PIDS=state/demo.pids.json
if [ ! -f "$PIDS" ]; then echo "no demo running (state/demo.pids.json missing)"; exit 0; fi
node -e '
const pids = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const [name, pid] of Object.entries(pids)) {
  try { process.kill(-pid, "SIGTERM"); console.log(`stopped ${name} (pgid ${pid})`); }
  catch { try { process.kill(pid, "SIGTERM"); console.log(`stopped ${name} (pid ${pid})`); } catch { console.log(`${name} was not running`); } }
}' "$PIDS"
sleep 1
node -e '
const pids = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const pid of Object.values(pids)) { try { process.kill(-pid, "SIGKILL"); } catch {} }' "$PIDS"
rm -f "$PIDS"
