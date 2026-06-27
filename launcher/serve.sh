#!/bin/sh
# serve.sh - the launchd entrypoint (ProgramArguments points here). It optionally
# kicks off a staleness-gated dashboard rebuild IN THE BACKGROUND, then exec's the
# server immediately - so opening the app NEVER waits on a build. $1 is the
# absolute node path the plist passes (launchd's PATH is minimal).
#
# OPT-IN + DORMANT: the background rebuild runs only when a gitignored
# `.build-on-boot` sentinel exists in the repo root. A shipped install has no
# sentinel, so this is a no-op wrapper that just runs the server - end users have
# no toolchain and want a fast boot.
#
# SAFE: scripts/dashboard-build.mjs builds to a temp dir and ATOMICALLY swaps into
# app/dist only on success (a failed build keeps serving the last good bundle), is
# a no-op when app/dist is already up to date, and holds a lock so a boot rebuild
# and an on-demand rebuild never collide. The new bundle is picked up on the next
# browser reload (the SPA surfaces an "update available" prompt when it lands).
set -u
NODE="${1:?usage: serve.sh <node-path>}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$REPO/.build-on-boot" ]; then
  ( "$NODE" "$REPO/scripts/dashboard-build.mjs" build --if-stale >/tmp/pendpost-build.log 2>&1 ) &
fi

cd "$REPO" || exit 1
# exec so node REPLACES this shell: launchd then sees the server's real exit code
# (the KeepAlive SuccessfulExit=false contract - exit 0 on EADDRINUSE must NOT
# relaunch-loop).
exec "$NODE" server.mjs
