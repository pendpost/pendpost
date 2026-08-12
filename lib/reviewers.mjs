// reviewers.mjs - the core reviewer store (spec 48, R10 "client review link").
//
// CRUD over clients/<id>/reviewers.json: the identity primitive for the client
// review link. A reviewer has NO account, NO password, NO session - a 128-bit
// random token IS the whole identity, and its ACTOR string on the approval
// chokepoint is `reviewer:<clientId>/<reviewerId>`, minted server-side from the
// authenticated token, never accepted from a request body (spec 48 §3.2).
//
// STORAGE POSTURE: the file is 0600 and gitignored (same posture as the
// per-client .env), but unlike the .env we store a HASH of the token, never the
// raw token - the raw token is shown to the operator EXACTLY ONCE at mint and
// then only its 4-char tail is displayable. A stolen store file therefore leaks
// no live token. Mirrors the atomic-write + slug + requireActor idioms from
// lib/clients.mjs.
//
// The `reviewer:` actor namespace is RESERVED: refuseReviewerActor() is imported
// by the operator write/admin faces (lib/writes.mjs setApproval, lib/clients.mjs)
// so an MCP/REST caller can never forge a reviewer identity from the loopback
// side. REVIEWER_TRUST is a process-private Symbol the review ingest passes to
// setApproval to authorize the ONE legitimate server-minted reviewer actor; a
// JSON request body can never carry a Symbol key, so the trust cannot be forged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { errorBody } from './util.mjs';
import { clientRoot, readRegistry } from './multi-client.mjs';

// The reviewer id is a slug (a path-safe directory-free key that also becomes an
// actor-string segment): lowercase alnum with interior hyphens, same shape as the
// client slug in lib/clients.mjs / lib/multi-client.mjs.
function slugify(name) {
  return String(name || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---- the reserved actor namespace (shared with the operator faces) ----------

// A body-supplied actor of the form `reviewer:...` is ALWAYS refused on the
// operator write/config/admin faces: that identity is minted server-side from a
// review token and can never be self-declared by a loopback caller (spec 48
// §3.2, the spoofing note). Leading whitespace is tolerated so " reviewer:x" is
// caught too.
export const RESERVED_ACTOR_RE = /^\s*reviewer:/i;

export function refuseReviewerActor(actor) {
  if (typeof actor === 'string' && RESERVED_ACTOR_RE.test(actor)) {
    return errorBody('invalid_input', 'the "reviewer:" actor namespace is reserved: it is minted server-side from a review token and cannot be supplied by a caller');
  }
  return null;
}

// A process-private trust marker. The review ingest (lib/review-ingest.mjs) adds
// this Symbol key to its setApproval args to authorize the one legitimate
// server-minted reviewer actor; a JSON request body cannot represent a Symbol
// key, so an operator-face caller can never set it.
export const REVIEWER_TRUST = Symbol('pendpost.reviewerTrust');

// Operator-face actor guard for the reviewer admin verbs: same required-actor
// rule as clients.mjs/writes.mjs, PLUS the reserved-namespace refusal.
function requireActor(actor) {
  if (typeof actor !== 'string' || !actor.trim() || actor.trim().toLowerCase() === 'unknown') {
    return errorBody('invalid_input', 'actor is required (who is doing this - e.g. "owner")');
  }
  return refuseReviewerActor(actor);
}

// ---- store I/O (atomic + 0600, mirroring writeEnvVars) ----------------------

function reviewersPath(clientId) {
  return path.join(clientRoot(clientId), 'reviewers.json');
}

function readReviewers(clientId) {
  let p;
  try { p = reviewersPath(clientId); } catch { return []; }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (parsed && Array.isArray(parsed.reviewers)) return parsed.reviewers;
    return [];
  } catch {
    return [];
  }
}

function writeReviewers(clientId, reviewers) {
  const p = reviewersPath(clientId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ reviewers }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch { /* best-effort: rename already carried the tmp perms */ }
}

// ---- token + lifecycle helpers ----------------------------------------------

function hashTokenHex(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}
function hashTokenBuf(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest();
}

function reviewerActive(r, now = Date.now()) {
  if (!r || r.revokedAt) return false;
  if (r.expiresAt && Date.parse(r.expiresAt) <= now) return false;
  return true;
}

// The safe public projection: NEVER carries tokenHash or the raw token.
function publicReviewer(r, now = Date.now()) {
  const expired = Boolean(r.expiresAt && Date.parse(r.expiresAt) <= now);
  return {
    id: r.id,
    name: r.name,
    tokenTail: r.tokenTail || null,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    revokedAt: r.revokedAt || null,
    expiresAt: r.expiresAt || null,
    revoked: Boolean(r.revokedAt),
    expired,
    active: reviewerActive(r, now),
  };
}

function clientExists(clientId) {
  const registry = readRegistry();
  if (!registry || !Array.isArray(registry.clients)) return true; // legacy single-workspace: trust the slug
  return registry.clients.some((c) => c.id === clientId);
}

// ---- change notification (fail-closed listener start/stop) ------------------
//
// The review listener starts only while >=1 active reviewer exists and stops
// when none do. reviewers.mjs must NOT import review-server.mjs (that would be a
// cycle: the listener imports this store), so instead the listener SUBSCRIBES
// here and we emit on every create/revoke.
const changeListeners = new Set();
export function onReviewersChanged(cb) {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}
function emitReviewersChanged() {
  for (const cb of changeListeners) {
    try { cb(); } catch { /* a subscriber must never break a store write */ }
  }
}

// ---- CRUD -------------------------------------------------------------------

// Mint a reviewer. Returns the raw token EXACTLY ONCE (never persisted, only its
// hash + 4-char tail are stored). expiresAt is OPTIONAL and defaults to null (no
// expiry; the link lives until explicitly revoked - owner decision O3).
export function createReviewer({ clientId, name, actor, expiresAt = null } = {}) {
  const actErr = requireActor(actor);
  if (actErr) return actErr;
  if (typeof name !== 'string' || !name.trim()) {
    return errorBody('invalid_input', 'name is required');
  }
  const base = slugify(name);
  if (!base) {
    return errorBody('invalid_input', 'name must contain at least one letter or digit');
  }
  let expIso = null;
  if (expiresAt != null) {
    const t = Date.parse(expiresAt);
    if (Number.isNaN(t)) return errorBody('invalid_input', 'expiresAt must be an ISO timestamp or null');
    expIso = new Date(t).toISOString();
  }
  if (!clientExists(clientId)) {
    return errorBody('unknown_campaign', `unknown client: ${clientId}`);
  }
  try { clientRoot(clientId); } catch (err) { return errorBody('invalid_input', err.message); }

  const reviewers = readReviewers(clientId);
  const now = Date.now();
  const trimmedName = name.trim();
  // Dup-name is checked among ACTIVE reviewers only, so a name can be re-used
  // after revoke/expiry ("Invite again", matrix row 6).
  if (reviewers.some((r) => reviewerActive(r, now) && String(r.name).trim().toLowerCase() === trimmedName.toLowerCase())) {
    return errorBody('invalid_input', `a reviewer with this name already exists for ${clientId}`);
  }
  // id uniqueness across ALL records (revoked included) so the actor string and
  // the store key never collide with a prior reviewer.
  const takenIds = new Set(reviewers.map((r) => r.id));
  let id = base;
  let n = 2;
  while (takenIds.has(id)) { id = `${base}-${n}`; n += 1; }

  const rawToken = crypto.randomBytes(16).toString('base64url'); // 128-bit
  const record = {
    id,
    name: trimmedName,
    tokenHash: hashTokenHex(rawToken),
    tokenTail: rawToken.slice(-4),
    createdAt: new Date().toISOString(),
    createdBy: actor.trim(),
    revokedAt: null,
    expiresAt: expIso,
  };
  reviewers.push(record);
  writeReviewers(clientId, reviewers);
  emitReviewersChanged();
  // The server is the only place that knows the review listener's bind, so it composes
  // the shareable link rather than letting the GUI hard-code a loopback URL: an operator
  // who widened the bind (PENDPOST_REVIEW_HOST / PENDPOST_REVIEW_PORT for the LAN + tunnel
  // path) copies the right address. Mirrors reviewHost()/reviewPort() in review-server.mjs
  // (kept inline to avoid a cycle, since review-server imports this module). A bind-all
  // 0.0.0.0 is emitted as configured; the operator substitutes their reachable host.
  const reviewHost = process.env.PENDPOST_REVIEW_HOST || '127.0.0.1';
  const reviewPort = Number(process.env.PENDPOST_REVIEW_PORT || 8091);
  return {
    ok: true,
    reviewer: publicReviewer(record, now),
    token: rawToken, // shown ONCE; never returned again
    actorString: `reviewer:${clientId}/${id}`,
    reviewUrl: `http://${reviewHost}:${reviewPort}/review/${rawToken}`, // shown ONCE with the token
  };
}

export function listReviewers({ clientId } = {}) {
  try { clientRoot(clientId); } catch (err) { return errorBody('invalid_input', err.message); }
  const now = Date.now();
  return { ok: true, reviewers: readReviewers(clientId).map((r) => publicReviewer(r, now)) };
}

// Revoke is the intended lifecycle end (matrix row 19). Idempotent: revoking an
// already-revoked reviewer is a no-op success.
export function revokeReviewer({ clientId, reviewerId, actor } = {}) {
  const actErr = requireActor(actor);
  if (actErr) return actErr;
  try { clientRoot(clientId); } catch (err) { return errorBody('invalid_input', err.message); }
  const reviewers = readReviewers(clientId);
  const r = reviewers.find((x) => x.id === reviewerId);
  if (!r) return errorBody('unknown_campaign', `unknown reviewer: ${reviewerId}`);
  if (r.revokedAt) return { ok: true, reviewer: publicReviewer(r) };
  r.revokedAt = new Date().toISOString();
  writeReviewers(clientId, reviewers);
  emitReviewersChanged();
  return { ok: true, reviewer: publicReviewer(r) };
}

// Resolve a raw token to { clientId, reviewer } across every client, or null.
// CONSTANT-TIME compare via crypto.timingSafeEqual on the fixed-length sha256
// digests; an unknown, revoked, or expired token all resolve to null so the
// listener renders one neutral page (no oracle distinguishing them). The scan
// covers every client so the resolution time does not leak WHICH client owns a
// token.
export function verifyToken(rawToken) {
  if (typeof rawToken !== 'string' || !rawToken) return null;
  const incoming = hashTokenBuf(rawToken);
  const registry = readRegistry();
  const clients = registry && Array.isArray(registry.clients) ? registry.clients : [{ id: 'default' }];
  const now = Date.now();
  let match = null;
  for (const c of clients) {
    for (const r of readReviewers(c.id)) {
      if (typeof r.tokenHash !== 'string') continue;
      let stored;
      try { stored = Buffer.from(r.tokenHash, 'hex'); } catch { continue; }
      if (stored.length !== incoming.length) continue;
      if (crypto.timingSafeEqual(incoming, stored) && reviewerActive(r, now)) {
        match = { clientId: c.id, reviewer: r };
      }
    }
  }
  return match;
}

// True while at least one active (unrevoked, unexpired) reviewer exists for any
// client - the fail-closed gate for whether the review listener runs at all.
export function hasActiveReviewers() {
  const registry = readRegistry();
  const clients = registry && Array.isArray(registry.clients) ? registry.clients : [{ id: 'default' }];
  const now = Date.now();
  for (const c of clients) {
    for (const r of readReviewers(c.id)) {
      if (reviewerActive(r, now)) return true;
    }
  }
  return false;
}

export { reviewerActive, publicReviewer };
