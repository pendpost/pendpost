#!/bin/bash
# launcher.sh - the executable inside "pendpost.app".
#
# Double-click behavior (KISS, zero terminal):
#   1. ALWAYS restart the launchd agent so a click picks up the latest backend
#      code AND re-runs serve.sh's staleness-gated dashboard rebuild (a still-
#      answering but STALE server is the bug a plain health check misses); if the
#      agent was never installed, run install.sh. Then wait for it to bind.
#   2. Open the dashboard as its OWN Chrome app window (no tabs, no URL bar);
#      plain default-browser fallback when Chrome is missing.
#
# Deliberately does NOT stop the server on window close: the background
# service is the scheduler that publishes due posts - it must outlive the
# window. It idles at ~0 CPU.
set -u

REPO_ROOT="__REPO__"
LABEL="pendpost"
URL="http://127.0.0.1:8090"

healthy() {
  curl -s -m 1 "$URL/api/health" >/dev/null 2>&1
}

# Always restart the agent (kickstart -k restarts a running job; a non-zero status
# means it was never installed -> bootstrap via install.sh), then wait for the fresh
# server to bind. Unconditional so a click always picks up the latest code.
launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null \
  || bash "$REPO_ROOT/install.sh" >/dev/null 2>&1
for _ in $(seq 1 24); do
  healthy && break
  sleep 0.25
done

if ! healthy; then
  osascript -e 'display alert "pendpost" message "The pendpost server failed to start. Check in Terminal: node server.mjs" as critical' >/dev/null 2>&1
  exit 1
fi

# Chrome app window (chromeless). `open -na` spawns a new Chrome process that
# forwards --app to the running instance, so this works whether or not Chrome
# is already open.
if [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="$URL"
else
  open "$URL"
fi
