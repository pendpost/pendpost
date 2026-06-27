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

const { authGateEnabled, checkAuth, authToken, isLoopbackHost } = await import('../lib/flags.mjs');

const savedHost = process.env.PENDPOST_HOST;
const savedToken = process.env.PENDPOST_AUTH_TOKEN;
const savedPublic = process.env.PENDPOST_PUBLIC_HOST;

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

  console.log(`[auth-gate] OK - gate OFF by default (loopback unchanged), activates only on non-loopback host + token, bearer enforced (${pass} assertions).`);
} catch (err) {
  console.error(`[auth-gate] FAIL: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (savedHost === undefined) delete process.env.PENDPOST_HOST; else process.env.PENDPOST_HOST = savedHost;
  if (savedToken === undefined) delete process.env.PENDPOST_AUTH_TOKEN; else process.env.PENDPOST_AUTH_TOKEN = savedToken;
  if (savedPublic === undefined) delete process.env.PENDPOST_PUBLIC_HOST; else process.env.PENDPOST_PUBLIC_HOST = savedPublic;
}
