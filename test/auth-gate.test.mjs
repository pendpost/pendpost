#!/usr/bin/env node
// test/auth-gate.test.mjs - the OPTIONAL in-server auth gate (lib/flags.mjs).
//
// Proves the gate is OFF by default (loopback posture byte-for-byte unchanged: no
// host or token => no auth required), that it activates ONLY when the server is
// bound to a non-loopback host AND a token is set, and that when active it rejects
// a missing or wrong bearer token (401) while accepting the correct one.
//
// Zero-dep node:assert. The flags read process.env at CALL time, so the test just
// sets the environment per case and restores it at the end.
import assert from 'node:assert';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const { authGateEnabled, checkAuth, authToken, isLoopbackHost, bindRefusal } = await import('../lib/flags.mjs');
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const savedHost = process.env.PENDPOST_HOST;
const savedToken = process.env.PENDPOST_AUTH_TOKEN;
const savedPublic = process.env.PENDPOST_PUBLIC_HOST;
const savedAllow = process.env.PENDPOST_ALLOW_UNAUTHENTICATED;

const setEnv = (host, token) => {
  if (host === undefined) delete process.env.PENDPOST_HOST; else process.env.PENDPOST_HOST = host;
  if (token === undefined) delete process.env.PENDPOST_AUTH_TOKEN; else process.env.PENDPOST_AUTH_TOKEN = token;
};
const bearer = (t) => ({ headers: { authorization: `Bearer ${t}` } });

try {
  // ---- (1) loopback default: gate OFF, no auth required (unchanged posture) ---
  setEnv(undefined, undefined);
  ok(authGateEnabled() === false, 'default (no host, no token): gate is OFF');
  ok(checkAuth({ headers: {} }).ok === true, 'default: a request needs no authorization (loopback posture unchanged)');

  // ---- (2) a token alone on loopback does NOT gate (default preserved) --------
  setEnv(undefined, 'secret-token');
  ok(authGateEnabled() === false, 'token set but loopback host: gate stays OFF (default preserved)');
  ok(checkAuth({ headers: {} }).ok === true, 'token on loopback: still no auth required');
  setEnv('127.0.0.1', 'secret-token');
  ok(authGateEnabled() === false, 'explicit 127.0.0.1 + token: gate stays OFF');
  setEnv('localhost', 'secret-token');
  ok(authGateEnabled() === false, 'localhost + token: gate stays OFF');

  // ---- (3) non-loopback bind WITHOUT a token: still OFF (relies on a tunnel) --
  setEnv('0.0.0.0', undefined);
  ok(authGateEnabled() === false, 'non-loopback host but no token: gate OFF (tunnel/zero-trust expected in front)');
  ok(checkAuth({ headers: {} }).ok === true, 'non-loopback, no token: no in-server auth (documented tunnel pattern)');

  // ---- (4) non-loopback bind + token: gate ON, bearer enforced ----------------
  setEnv('0.0.0.0', 'secret-token');
  ok(authGateEnabled() === true, 'non-loopback host + token: gate is ON');
  ok(authToken() === 'secret-token', 'authToken() returns the configured token');
  const missing = checkAuth({ headers: {} });
  ok(missing.ok === false && missing.status === 401, 'gate ON: a missing Authorization header is 401');
  const wrong = checkAuth(bearer('nope'));
  ok(wrong.ok === false && wrong.status === 401, 'gate ON: a wrong bearer token is 401');
  ok(checkAuth(bearer('secret-token')).ok === true, 'gate ON: the correct bearer token is accepted');
  ok(checkAuth({ headers: { authorization: 'bearer secret-token' } }).ok === true, 'gate ON: the Bearer scheme is case-insensitive');
  ok(checkAuth({ headers: { authorization: 'Basic secret-token' } }).ok === false, 'gate ON: a non-Bearer scheme is rejected');
  // length-different wrong token still 401 (constant-time compare guards length)
  ok(checkAuth(bearer('x')).ok === false, 'gate ON: a length-mismatched token is rejected');

  // ---- (5) a Tailscale IP host behaves like any non-loopback bind ------------
  setEnv('100.64.0.2', 'secret-token');
  ok(authGateEnabled() === true, 'a Tailscale IP host + token enables the gate');
  ok(checkAuth(bearer('secret-token')).ok === true, 'Tailscale IP: correct token accepted');

  // ---- (6) isLoopbackHost classification -------------------------------------
  ok(isLoopbackHost('127.0.0.1') && isLoopbackHost('localhost') && isLoopbackHost('::1') && isLoopbackHost(''), 'isLoopbackHost: loopback + empty classified as loopback');
  ok(!isLoopbackHost('0.0.0.0') && !isLoopbackHost('100.64.0.2'), 'isLoopbackHost: 0.0.0.0 and a Tailscale IP are non-loopback');

  // ---- (7) fail closed at boot: non-loopback bind without a token is refused ---
  // Regression (security audit 2026-11): with the gate OFF the Host allowlist was the
  // only control, and a network peer sets Host itself, getting REST, MCP and the
  // Studio token. The documented `docker run -p 8090:8090` image hit exactly this.
  delete process.env.PENDPOST_ALLOW_UNAUTHENTICATED;
  setEnv('0.0.0.0', undefined);
  ok(typeof bindRefusal() === 'string' && /PENDPOST_AUTH_TOKEN/.test(bindRefusal()), 'non-loopback bind with no token: boot is refused');
  setEnv('100.64.0.2', undefined);
  ok(typeof bindRefusal() === 'string', 'Tailscale IP with no token: boot is refused');
  setEnv('0.0.0.0', 'secret-token');
  ok(bindRefusal() === null, 'non-loopback bind with a token: boot allowed (gate ON)');
  setEnv(undefined, undefined);
  ok(bindRefusal() === null, 'loopback default: boot allowed (unchanged)');
  setEnv('0.0.0.0', undefined);
  process.env.PENDPOST_ALLOW_UNAUTHENTICATED = '1';
  ok(bindRefusal() === null, 'explicit PENDPOST_ALLOW_UNAUTHENTICATED=1 (loopback-published container): boot allowed');
  process.env.PENDPOST_ALLOW_UNAUTHENTICATED = 'yes';
  ok(typeof bindRefusal() === 'string', 'only the exact value 1 opts out');
  delete process.env.PENDPOST_ALLOW_UNAUTHENTICATED;

  // The real server exits non-zero before binding in that posture.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-bindrefusal-'));
  const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
  const env = { ...process.env, PENDPOST_ROOT: root, PENDPOST_HOST: '0.0.0.0', PENDPOST_PORT: '0', PENDPOST_STUDIO_TOKEN_DIR: root };
  delete env.PENDPOST_AUTH_TOKEN; delete env.PENDPOST_ALLOW_UNAUTHENTICATED; delete env.PENDPOST_MODE;
  const r = spawnSync(process.execPath, [serverPath], { env, encoding: 'utf8', timeout: 20000 });
  fs.rmSync(root, { recursive: true, force: true });
  ok(r.status === 1 && /refusing to listen on 0\.0\.0\.0/.test(`${r.stdout}${r.stderr}`), 'server.mjs on 0.0.0.0 with no token exits 1 with the refusal message');

  console.log(`[auth-gate] OK - gate OFF by default (loopback unchanged), activates only on non-loopback host + token, bearer enforced (${pass} assertions).`);
} catch (err) {
  console.error(`[auth-gate] FAIL: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (savedHost === undefined) delete process.env.PENDPOST_HOST; else process.env.PENDPOST_HOST = savedHost;
  if (savedToken === undefined) delete process.env.PENDPOST_AUTH_TOKEN; else process.env.PENDPOST_AUTH_TOKEN = savedToken;
  if (savedPublic === undefined) delete process.env.PENDPOST_PUBLIC_HOST; else process.env.PENDPOST_PUBLIC_HOST = savedPublic;
  if (savedAllow === undefined) delete process.env.PENDPOST_ALLOW_UNAUTHENTICATED; else process.env.PENDPOST_ALLOW_UNAUTHENTICATED = savedAllow;
}
