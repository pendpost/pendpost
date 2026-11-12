// flags.mjs - the single auditable home for pendpost's OPT-IN security posture.
//
// Mirrors lib/mode.mjs: tiny, pure, env-driven, fail-closed, read at call time
// (never cached), so a deployment's posture is decided by the environment it runs
// in and is trivially testable. Every capability here defaults OFF; with the
// default (unset / loopback) host the optional auth gate is inert, so the
// loopback-only, no-auth default runtime posture is byte-for-byte unchanged.
//
// Scope is deliberately narrow: this module owns ONLY the optional in-server auth
// gate (the always-on hardening path). Platform enablement stays in
// lib/mode.mjs's credential-presence model; the cloud dispatch
// target is a documented interface (docs/specs/cloud-integration-contract.md) the
// proprietary runtime implements in its own repo, never a flag in the core.
import crypto from 'node:crypto';

// Hosts that mean "loopback only" - the default, safe posture. An unset
// PENDPOST_HOST falls here too (server.mjs defaults HOST to 127.0.0.1).
const LOOPBACK_HOSTS = new Set(['', '127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1']);

function hostValue() {
  return String(process.env.PENDPOST_HOST || '').trim().toLowerCase();
}

// True when the configured host is a loopback address (or unset). Exported so
// server.mjs and the gate share one definition of "is this a local bind".
export function isLoopbackHost(host = hostValue()) {
  return LOOPBACK_HOSTS.has(host);
}

// The configured bearer token, or null when unset/blank.
export function authToken() {
  const t = String(process.env.PENDPOST_AUTH_TOKEN || '').trim();
  return t || null;
}

// The optional in-server auth gate is ACTIVE only when BOTH hold:
//   1. the server is bound to a NON-loopback host (PENDPOST_HOST is a real
//      address, e.g. 0.0.0.0 or a Tailscale IP), AND
//   2. a token is set (PENDPOST_AUTH_TOKEN).
// With the default (unset/loopback) host it is OFF regardless of the token, so the
// loopback request path never changes. Binding non-loopback WITHOUT a token is
// refused at boot (bindRefusal below) unless PENDPOST_ALLOW_UNAUTHENTICATED=1 says
// the port is only published on host loopback.
export function authGateEnabled() {
  if (isLoopbackHost()) return false;
  return authToken() !== null;
}

// Explicit operator opt-out for the one posture that is safe without a token: the
// process binds a non-loopback address INSIDE a container whose port is published
// only on the host's loopback (docker-compose.yml maps 127.0.0.1:8090:8090).
export function unauthenticatedBindAllowed() {
  return String(process.env.PENDPOST_ALLOW_UNAUTHENTICATED || '').trim() === '1';
}

// Fail closed at boot. A non-loopback bind with no token used to leave the gate OFF,
// and the only remaining check was the Host allowlist, which a non-browser network
// peer sets itself ("Host: 127.0.0.1:8090"). That peer then got every REST route,
// every MCP tool and the Studio owner token. So server.mjs refuses to start in that
// posture unless the operator explicitly opts out. Returns the refusal message, or
// null when the posture is safe to start.
export function bindRefusal(host = hostValue()) {
  if (isLoopbackHost(host)) return null;
  if (authToken() !== null) return null;
  if (unauthenticatedBindAllowed()) return null;
  return `refusing to listen on ${host} without PENDPOST_AUTH_TOKEN: anyone who can reach this port would control pendpost. `
    + 'Set PENDPOST_AUTH_TOKEN (see site-docs/always-on.mdx), or publish the port on host loopback only '
    + '(docker run -p 127.0.0.1:8090:8090 ...) and set PENDPOST_ALLOW_UNAUTHENTICATED=1.';
}

// Length-guarded constant-time string compare so token verification does not leak
// length or content through timing.
function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// The gate decision for one request. Returns { ok:true } when the gate is OFF (the
// loopback default - no header is read, behavior is unchanged) OR when a valid
// "Authorization: Bearer <token>" is present. Returns { ok:false, status:401,
// message } when the gate is ON and the token is missing or wrong. Pure: takes a
// request-like object ({ headers }) so it is unit-testable without a live server.
export function checkAuth(req) {
  if (!authGateEnabled()) return { ok: true };
  const token = authToken();
  const header = String((req && req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
  const m = header.match(/^Bearer\s+(.+)$/i);
  const presented = m ? m[1].trim() : null;
  if (!presented) {
    return { ok: false, status: 401, message: 'authorization required: set Authorization: Bearer <PENDPOST_AUTH_TOKEN>' };
  }
  if (!timingSafeEqualStr(presented, token)) {
    return { ok: false, status: 401, message: 'invalid token' };
  }
  return { ok: true };
}
