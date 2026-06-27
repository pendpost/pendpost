// flags.mjs - the single auditable home for pendpost's OPT-IN security posture.
//
// Mirrors lib/mode.mjs: tiny, pure, env-driven, fail-closed, read at call time
// (never cached), so a deployment's posture is decided by the environment it runs
// in and is trivially testable. Every capability here defaults OFF; with the
// default (unset / loopback) host the optional auth gate is inert, so the
// loopback-only, no-auth default runtime posture is byte-for-byte unchanged.
//
// Scope is deliberately narrow: this module owns ONLY the optional in-server auth
// gate (the always-on hardening path). Platform enablement (including the Bluesky
// lane) stays in lib/mode.mjs's credential-presence model; the cloud dispatch
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
// loopback request path never changes. Binding non-loopback WITHOUT a token also
// leaves it OFF - that posture relies on a tunnel/zero-trust proxy in front
// (site-docs/always-on.mdx), which is the recommended pattern.
export function authGateEnabled() {
  if (isLoopbackHost()) return false;
  return authToken() !== null;
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
