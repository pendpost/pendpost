#!/usr/bin/env node
// bin/pendpost.mjs - the `pendpost` / `npx pendpost` entry point. Builds the
// dashboard on first run if it is not present, then boots the server. With no
// credentials the server runs in MOCK mode, so a fresh install drives the full
// draft -> approve -> schedule -> publish -> insights loop with zero setup.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_ROOT = path.resolve(__dirname, '..');

const arg = process.argv[2];

if (arg === '--help' || arg === '-h') {
  console.log(`pendpost - agent-operated social ops with a human approval gate

Usage: pendpost [--help] [--version] [--stdio]

Starts the local pendpost server (dashboard + REST /api + MCP /mcp) on
http://127.0.0.1:8090. With no credentials it runs in MOCK mode: drive the full
draft -> approve -> schedule -> publish -> insights loop with zero setup.

  --stdio   also speak MCP over stdio (for one-click Claude Desktop / .mcpb use);
            the local dashboard still runs so you can approve posts in the browser.

Environment:
  PENDPOST_PORT        port to bind (default 8090)
  PENDPOST_ROOT        workspace dir for .env + config.json + data/ (default: install dir)
  PENDPOST_MODE        force "mock" or "live" (default: auto - live only where creds exist)
  PENDPOST_HOST        bind host (default 127.0.0.1; the docker image sets 0.0.0.0)

Add credentials in a .env at the workspace root to publish for real (see .env.example).`);
  process.exit(0);
}

if (arg === '--version' || arg === '-v') {
  const pkg = JSON.parse(fs.readFileSync(path.join(INSTALL_ROOT, 'package.json'), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

// `--stdio`: speak MCP over stdio (the one-click .mcpb path) IN ADDITION to the
// local dashboard. stdout is the JSON-RPC channel, so every log must go to stderr;
// redirect console.* BEFORE booting the server so no banner can corrupt the
// protocol. childStdio routes the (rare) first-run dashboard build to stderr too.
const STDIO = arg === '--stdio';
if (STDIO) {
  console.log = (...a) => console.error(...a);
  console.info = (...a) => console.error(...a);
  console.debug = (...a) => console.error(...a);
}
const childStdio = STDIO ? ['ignore', 2, 2] : 'inherit';

// Build the dashboard on first run if missing (a published package ships
// app/dist; a fresh git checkout does not).
const distIndex = path.join(INSTALL_ROOT, 'app', 'dist', 'index.html');
if (!fs.existsSync(distIndex)) {
  const appDir = path.join(INSTALL_ROOT, 'app');
  console.error('[pendpost] building the dashboard (one time)...');
  if (!fs.existsSync(path.join(appDir, 'node_modules'))) {
    const install = spawnSync('npm', ['install'], { cwd: appDir, stdio: childStdio, shell: process.platform === 'win32' });
    if (install.status !== 0) { console.error('[pendpost] npm install failed in app/ - cannot build the dashboard.'); process.exit(1); }
  }
  const build = spawnSync('npm', ['run', 'build'], { cwd: appDir, stdio: childStdio, shell: process.platform === 'win32' });
  if (build.status !== 0) { console.error('[pendpost] dashboard build failed.'); process.exit(1); }
}

// Boot the server in THIS process (server.mjs runs server.listen() at module load).
await import(pathToFileURL(path.join(INSTALL_ROOT, 'server.mjs')).href);

// In --stdio mode, attach the stdio MCP transport once the in-process state is up.
// It dispatches through the SAME handler as POST /mcp (lib/mcp.mjs handleRpc), so
// the .mcpb stdio face and the HTTP face stay in lockstep. Non-blocking.
if (STDIO) {
  const { runStdio } = await import(pathToFileURL(path.join(INSTALL_ROOT, 'lib', 'stdio.mjs')).href);
  runStdio();
}

// Concise ready banner, printed once the server answers. The URL is built from
// the SAME env defaults server.mjs binds (PENDPOST_PORT / PENDPOST_HOST), so
// it always matches the listening socket. We poll /api/health (bounded, ~6s) so
// the banner appears only after the server is actually up, not before it binds.
// Under --stdio the console.* redirect sends this to stderr (the human still sees
// where to open the approval dashboard; stdout stays a clean protocol channel).
const PORT = Number(process.env.PENDPOST_PORT || 8090);
const HOST = process.env.PENDPOST_HOST || '127.0.0.1';
const URL_BASE = `http://${HOST}:${PORT}`;
const MODE = String(process.env.PENDPOST_MODE || '').trim().toLowerCase();
const modeNote = MODE === 'live'
  ? 'Mode: live (forced) - lanes with a credential in .env publish for real.'
  : MODE === 'mock'
    ? 'Mode: mock (forced) - every lane is simulated; no real API calls.'
    : 'Mode: auto - a lane goes live only where its credential is present in .env, else mock.';

async function waitListening() {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${URL_BASE}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

if (await waitListening()) {
  console.log(`\npendpost is ready at ${URL_BASE}`);
  console.log('Open the Setup tab to connect platforms (or skip the ones you do not use).');
  console.log(modeNote);
}
