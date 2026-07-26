#!/bin/sh
# dev-live.sh - `npm run dev:live`. Boots a LOCAL, READ/COMPOSE-ONLY dev Studio pointed at
# the operator's REAL data dir (this repo's data/clients/*, every connected client) so new
# features can be tried against live campaigns / posts / Radar signals / warmth WITHOUT the live
# install. It runs TWO processes:
#   1. a dev API (server.mjs) with PENDPOST_DEV_READONLY=1 on a SEPARATE port (default 8099),
#      reading the SAME data dir as the live launchd daemon (`pendpost`, port 8090). The
#      read-only guard (lib/dev-mode.mjs) hard-disables the scheduler tick, the publish path
#      (runDueExclusive), and every approval write - so the daemon stays the SOLE writer of
#      publish/schedule/approval state. Two live writers is the failure mode; it is designed out.
#   2. the Vite Studio (port 5179) with its /api proxy pointed at the dev API (not 8090), so
#      the whole app talks to the read-only instance.
# Ctrl-C stops both. The live daemon on 8090 is never touched.
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEV_PORT="${PENDPOST_DEV_PORT:-8099}"
STUDIO_PORT="${PENDPOST_STUDIO_PORT:-5179}"

echo "pendpost dev:live - READ/COMPOSE-ONLY against your live data (repo data/clients/*)."
echo "  dev API   : http://127.0.0.1:${DEV_PORT}  (PENDPOST_DEV_READONLY=1)"
echo "  Studio    : http://127.0.0.1:${STUDIO_PORT}"
echo "  live daemon (port 8090) is NOT touched; it remains the only writer of publish state."
echo "  publishing / approving / the scheduler tick are all disabled in this instance."
echo "  tip: back up data/clients/* before a long session (see docs)."
echo ""

cd "$REPO" || exit 1

# 1. the read-only dev API against the live data dir (default root = repo data/).
PENDPOST_DEV_READONLY=1 PENDPOST_PORT="$DEV_PORT" node server.mjs &
API_PID=$!

# 2. the Studio, proxying /api + /media to the dev API instead of the live daemon.
VITE_API_TARGET="http://127.0.0.1:${DEV_PORT}" npm --prefix app run dev -- --port "$STUDIO_PORT" &
STUDIO_PID=$!

# Stop both together on Ctrl-C / exit.
trap 'kill "$API_PID" "$STUDIO_PID" 2>/dev/null' INT TERM EXIT
wait
