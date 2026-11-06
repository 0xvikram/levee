#!/usr/bin/env bash
# Start the Levee demo (checker, agents, watcher, gate). Args pass through to up.ts:
#   scripts/demo/up.sh [--memory] [--no-laptop] [--restart]
set -euo pipefail
cd "$(dirname "$0")/../.."
exec node_modules/.bin/tsx scripts/demo/up.ts "$@"
