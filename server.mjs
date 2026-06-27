#!/usr/bin/env node
/**
 * pendpost - local-first, MCP-native social planner.
 *
 * One process, four faces:
 *   /api/*    JSON API over the plan store + asset scanner + account health
 *   /mcp      MCP streamable-HTTP endpoint (JSON-RPC 2.0, zero-dep)
 *   /media    range-request streaming of local renders (data/ only)
 *   /         the built dashboard SPA (app/dist)
 *
 * Binds 127.0.0.1 only - this is a local tool; publishing is inherently local
 * (renders are gitignored local files, no hosting layer by design).
 * Phase A surface: read routes + the Meta-368 block recorder. The scheduler
 * daemon arrives in Phase B; publishing stays with the CLI siblings
 * (scripts/meta-social.mjs etc.) until then.
 */
import http from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { sendJson, errorBody, logLine, VERSION } from './lib/util.mjs';
import { REPO_ROOT } from './lib/dashboard.mjs';
import { handleApi } from './lib/api.mjs';
import { handleMcp } from './lib/mcp.mjs';
import { serveMedia } from './lib/media.mjs';
import { serveStatic } from './lib/static.mjs';
import { absorbMetaBlockSentinel } from './lib/accounts.mjs';
import { initMultiClient } from './lib/multi-client.mjs';
import { bootScheduler } from './lib/scheduler.mjs';
import { bootCoverBackfill } from './lib/writes.mjs';
import { bootApprovalNotifier } from './lib/notify.mjs';
import { startHealthSchedule } from './lib/health.mjs';
import { authGateEnabled, checkAuth } from './lib/flags.mjs';

const PORT = Number(process.env.PENDPOST_PORT || 8090);
// Loopback by default - this is a local tool. PENDPOST_HOST exists ONLY so the
// container image can bind 0.0.0.0 inside its own network namespace; the host
// still exposes it on 127.0.0.1 (docker-compose maps 127.0.0.1:8090:8090).
const HOST = process.env.PENDPOST_HOST || '127.0.0.1';

// SEC-1: loopback binding does NOT stop a malicious website in the owner's
// browser from reading this API cross-origin. Only pendpost's own origins
// (and the Vite dev server) get CORS; requests without an Origin header
// (MCP clients, curl) pass untouched; any other Origin is rejected.
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  'http://127.0.0.1:5179',
  'http://localhost:5179',
]);

// DNS-rebinding defense: a malicious site can rebind its hostname to
// 127.0.0.1, making the browser send SAME-ORIGIN requests (no Origin header,
// which the CORS check deliberately passes for curl/MCP clients) with
// Host: attacker.com:8090. Rejecting unknown Hosts closes that hole. The
// :5179 entries cover the Vite dev proxy, which forwards the original Host.
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  '127.0.0.1:5179',
  'localhost:5179',
]);

// Optional always-on hardening (site-docs/always-on.mdx). When the auth gate is
// ACTIVE (non-loopback bind + PENDPOST_AUTH_TOKEN set), the bearer token is the
// security boundary, so the public host(s) the deployment is reached at are
// allowed too. PENDPOST_PUBLIC_HOST is a comma-list of host[:port] (e.g.
// "pendpost.example.com" or "100.64.0.2:8090"). With the loopback default the gate
// is OFF and these allowlists stay byte-for-byte unchanged.
if (authGateEnabled()) {
  for (const h of String(process.env.PENDPOST_PUBLIC_HOST || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    ALLOWED_HOSTS.add(h);
    ALLOWED_ORIGINS.add(`https://${h}`);
    ALLOWED_ORIGINS.add(`http://${h}`);
  }
}

const server = http.createServer(async (req, res) => {
  const host = String(req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    sendJson(res, 421, errorBody('invalid_input', `host not allowed: ${host || '(missing)'}`));
    return;
  }
  const origin = req.headers.origin;
  if (origin) {
    if (!ALLOWED_ORIGINS.has(origin)) {
      sendJson(res, 403, errorBody('invalid_input', `origin not allowed: ${origin}`));
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  } catch {
    sendJson(res, 400, errorBody('invalid_input', 'bad url'));
    return;
  }
  // Optional auth gate (off by default; see lib/flags.mjs). A no-op on the loopback
  // default - checkAuth returns ok without reading the request - so the local
  // posture is byte-for-byte unchanged. When active it fail-closes every face (api,
  // mcp, media, spa) on a missing/wrong bearer token. The readiness probe
  // (GET /api/health) is exempt so always-on platform health checks (Fly, Render,
  // Railway) work without the token; it returns only setup/readiness status.
  if (!(req.method === 'GET' && url.pathname === '/api/health')) {
    const gate = checkAuth(req);
    if (!gate.ok) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      sendJson(res, gate.status, errorBody('invalid_input', gate.message));
      return;
    }
  }
  try {
    if (url.pathname === '/mcp') return await handleMcp(req, res);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname === '/media') return serveMedia(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    logLine('err', `${req.method} ${url.pathname}: ${err.stack || err.message}`);
    if (!res.headersSent) sendJson(res, 500, errorBody('engine_failure', err.message));
    return undefined;
  }
});

// Under launchd KeepAlive an unhandled EADDRINUSE would crash-loop the agent
// (SCHED-2). Exit 0 = clean for launchd; ThrottleInterval paces any retries.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logLine('err', `port ${PORT} already in use - another pendpost instance is running; exiting cleanly`);
    process.exit(0);
  }
  logLine('err', `server error: ${err.stack || err.message}`);
  process.exit(1);
});

// Opt-in periodic GitHub update check: refresh the update status (the SPA's
// "update available" prompt reads it via /api/health) shortly after boot and
// every 30 min, by spawning the READ-ONLY git-check. Gated on the .build-on-boot
// sentinel so shipped installs stay dormant; a no-op off a git checkout. Both
// timers are unref'd so they never keep the process alive.
function startUpdateCheckSchedule() {
  if (!existsSync(path.join(REPO_ROOT, '.build-on-boot'))) return;
  const script = path.join(REPO_ROOT, 'scripts', 'dashboard-build.mjs');
  const run = () => execFile(process.execPath, [script, 'git-check'], { cwd: REPO_ROOT }, () => {});
  setTimeout(run, 12_000).unref();
  setInterval(run, 30 * 60 * 1000).unref();
}

server.listen(PORT, HOST, () => {
  logLine('ok', `pendpost ${VERSION} on http://${HOST}:${PORT} (dashboard / · api /api · mcp /mcp) pid ${process.pid}`);
  // Idempotent, zero-loss boot migration of any legacy single workspace into
  // data/clients/default/ - MUST run before the scheduler/sentinel touch state,
  // so they read the migrated per-client files (activeRoot()), not the originals.
  initMultiClient();
  absorbMetaBlockSentinel();
  bootScheduler();
  bootApprovalNotifier();
  startHealthSchedule();
  startUpdateCheckSchedule();
  // US-ASSET-13 follow-up: one-time, best-effort first-frame cover backfill for
  // every active client's cover-less media. Fire-and-forget so it never delays
  // listen; idempotent, so it is a near-no-op on every boot after the first.
  bootCoverBackfill();
});
