#!/usr/bin/env node
// test/reviewers-store.test.mjs - W1 core reviewer store (spec 48, R10).
//
// One process, one PENDPOST_ROOT (util binds DATA_ROOT once at import). We boot a
// multi-client registry, create a client, then exercise lib/reviewers.mjs CRUD:
// mint (token shown once, hash stored, never the raw token), 0600 file mode, slug
// rules, dup-name refusal, constant-time verify accept/reject, revoke, opt-in
// expiry, and the reserved `reviewer:` actor-namespace refusal on the operator
// write/admin faces (writes.mjs setApproval + clients.mjs admin + the reviewers
// admin itself).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-rev-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
const { createClient } = await import('../lib/clients.mjs');
const {
  createReviewer, listReviewers, revokeReviewer, verifyToken,
  hasActiveReviewers, refuseReviewerActor, RESERVED_ACTOR_RE,
} = await import('../lib/reviewers.mjs');
const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { setActiveClient } = await import('../lib/clients.mjs');

try {
  initMultiClient();
  const created = createClient({ id: 'acme', displayName: 'Acme Co', actor: 'owner' });
  ok(created.ok, 'createClient acme');

  // ---- mint: token shown once, hash stored, tail for display ----
  const mint = createReviewer({ clientId: 'acme', name: 'Martina', actor: 'owner' });
  ok(mint.ok && typeof mint.token === 'string' && mint.token.length >= 20, 'mint returns a raw token once');
  ok(mint.reviewer.id === 'martina', 'reviewer id is a slug of the name');
  ok(mint.actorString === 'reviewer:acme/martina', 'mint returns the server-minted actor string');
  ok(mint.reviewer.tokenTail === mint.token.slice(-4), 'public reviewer carries only the 4-char tail');
  ok(mint.reviewer.tokenHash === undefined && mint.reviewer.token === undefined, 'public reviewer never carries the hash or the raw token');

  // ---- the on-disk store: 0600, hash != raw token ----
  const storePath = path.join(clientRoot('acme'), 'reviewers.json');
  ok(fs.existsSync(storePath), 'reviewers.json exists on disk');
  const mode = fs.statSync(storePath).mode & 0o777;
  ok(mode === 0o600, `reviewers.json is 0600 (got ${mode.toString(8)})`);
  const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const stored = raw.reviewers.find((r) => r.id === 'martina');
  ok(stored && typeof stored.tokenHash === 'string' && stored.tokenHash.length >= 40, 'stored record carries a tokenHash');
  ok(stored.tokenHash !== mint.token, 'stored tokenHash never equals the raw token');
  ok(!JSON.stringify(raw).includes(mint.token), 'the raw token is nowhere in the store file');
  ok(stored.expiresAt === null && stored.revokedAt === null, 'default: no expiry, not revoked');

  // ---- mint uniqueness ----
  const mint2 = createReviewer({ clientId: 'acme', name: 'Bruno', actor: 'owner' });
  ok(mint2.ok && mint2.token !== mint.token, 'a second mint yields a different token');

  // ---- dup-name refusal (active) ----
  const dup = createReviewer({ clientId: 'acme', name: 'Martina', actor: 'owner' });
  ok(dup.code === 'invalid_input' && /already exists/.test(dup.message), 'dup active name refused');

  // ---- slug rules: name must contain an alnum ----
  const bad = createReviewer({ clientId: 'acme', name: '!!!', actor: 'owner' });
  ok(bad.code === 'invalid_input', 'a name with no alnum is refused');

  // ---- verifyToken: constant-time accept / reject ----
  const v = verifyToken(mint.token);
  ok(v && v.clientId === 'acme' && v.reviewer.id === 'martina', 'verifyToken accepts a valid token and resolves client+reviewer');
  ok(verifyToken('not-a-real-token') === null, 'verifyToken rejects an unknown token (null, no oracle)');
  ok(verifyToken('') === null && verifyToken(null) === null, 'verifyToken rejects empty/null');

  // ---- hasActiveReviewers ----
  ok(hasActiveReviewers() === true, 'hasActiveReviewers true while an active reviewer exists');

  // ---- listReviewers never leaks the hash ----
  const list = listReviewers({ clientId: 'acme' });
  ok(list.ok && list.reviewers.length === 2, 'listReviewers returns both reviewers');
  ok(list.reviewers.every((r) => r.tokenHash === undefined && r.token === undefined), 'listReviewers leaks neither hash nor token');

  // ---- revoke: verifyToken then rejects, list shows revoked ----
  const rev = revokeReviewer({ clientId: 'acme', reviewerId: 'martina', actor: 'owner' });
  ok(rev.ok && rev.reviewer.revoked === true, 'revoke marks the reviewer revoked');
  ok(verifyToken(mint.token) === null, 'a revoked token no longer verifies (no oracle vs unknown)');

  // ---- opt-in expiry ----
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 3600_000).toISOString();
  const expM = createReviewer({ clientId: 'acme', name: 'Elena', actor: 'owner', expiresAt: future });
  ok(expM.ok && expM.reviewer.expiresAt === future, 'expiry is an opt-in field, stored as given');
  ok(verifyToken(expM.token) !== null, 'a not-yet-expired token verifies');
  const expP = createReviewer({ clientId: 'acme', name: 'Old', actor: 'owner', expiresAt: past });
  ok(expP.ok, 'a reviewer with a past expiry still mints (opt-in value trusted)');
  ok(verifyToken(expP.token) === null, 'an already-expired token does not verify');

  // ---- reserved actor-namespace refusal ----
  ok(RESERVED_ACTOR_RE.test('reviewer:acme/martina'), 'RESERVED_ACTOR_RE matches the reviewer namespace');
  ok(refuseReviewerActor('reviewer:acme/x')?.code === 'invalid_input', 'refuseReviewerActor rejects a reviewer: actor');
  ok(refuseReviewerActor('owner') === null, 'refuseReviewerActor passes a normal actor');

  // operator faces reject a body-supplied reviewer: actor
  const revAdmin = createReviewer({ clientId: 'acme', name: 'Nope', actor: 'reviewer:acme/martina' });
  ok(revAdmin.code === 'invalid_input', 'reviewer admin refuses a reviewer: actor');

  // writes.mjs chokepoint (setApproval) refuses a body-supplied reviewer: actor
  setActiveClient({ id: 'acme', actor: 'owner' });
  await createCampaign({ id: 'c1', note: 'c1', timezone: 'UTC', actor: 'owner' });
  const post = await createPost({ campaign: 'c1', post: { id: 'p1', type: 'text', platforms: ['x'], caption: 'hi', scheduledAt: new Date(Date.now() + 86400_000).toISOString() }, actor: 'agent:claude' });
  ok(post.ok, 'seeded a post');
  const spoof = await approvePost({ campaign: 'c1', postId: post.post.id, actor: 'reviewer:acme/martina' });
  ok(spoof.code === 'invalid_input', 'setApproval refuses a body-supplied reviewer: actor (spoof guard)');

  console.log(`\nreviewers-store: ${pass} assertions passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
