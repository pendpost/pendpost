#!/usr/bin/env node
// gbp-reviews.test.mjs - GBP read + reply to customer reviews (spec 03, Pattern P6
// engagement) run credential-free, no network.
//
// Proves, end-to-end through the REAL engine entrypoint + the REAL lib read/write face:
//   1. the gbp `reviews` verb returns the P6 inbound shape (kind:'review', a 1-5
//      rating from the star map, postId:null, the full reviewId as commentId).
//   2. `reply-to-review` upserts ok, and DEGRADES honestly (P9, never a throw):
//      over-length text -> invalid_input; a stale id -> review_missing; an ungranted
//      project (Business Profile API pending approval) -> needs_scope.
//   3. the lib listReviews() diffs + logs each NEW review as a 'review-received'
//      Activity entry (seen ids in state.json, never a plan), and a FAILED read
//      resolves { ok:false } - never a false-empty { ok:true, items:[] }.
//   4. the lib replyToReview() requires an actor, logs a 'review-reply' entry, and maps
//      the engine degrades onto the shared error envelope (not_configured / invalid_input).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

// PENDPOST_ROOT must be set BEFORE importing lib (util binds WORKSPACE_ROOT at import).
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-gbprev-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_MOCK_UNGRANTED;
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });

// Run the engine binary directly. extraEnv can override/unset PENDPOST_MODE (null = delete)
// so the not-configured failed-read path exercises the LIVE engine with no creds/network.
function runEngine(args, extraEnv = {}) {
  const env = { ...process.env, PENDPOST_ROOT: WS, ...extraEnv };
  for (const [k, v] of Object.entries(extraEnv)) if (v === null) delete env[k];
  const out = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'gbp-social.mjs'), ...args], { cwd: REPO, env, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

const { listReviews, replyToReview } = await import('../lib/writes.mjs');
const { loadState } = await import('../lib/state.mjs');

try {
  // ---- 1. engine `reviews` -> the P6 inbound shape --------------------------
  const rev = runEngine(['reviews', '--json', '--actor', 'inbox']);
  ok(rev.ok === true && Array.isArray(rev.results) && rev.results.length === 1, 'reviews emits exactly one result row');
  const row = rev.results[0];
  ok(row.platform === 'gbp' && row.action === 'reviews' && row.ok === true, 'the row is { platform:gbp, action:reviews, ok:true }');
  ok(Array.isArray(row.items) && row.items.length >= 2, 'the row carries 2+ fabricated reviews');
  ok(row.items.every((it) => it.kind === 'review'), 'every item is kind:"review"');
  ok(row.items.every((it) => it.postId === null), 'every item has postId:null (a review is not post-scoped)');
  ok(row.items.every((it) => Number.isInteger(it.rating) && it.rating >= 1 && it.rating <= 5), 'every item has a 1-5 integer rating (star map)');
  ok(row.items.some((it) => it.reply), 'at least one review already carries an owner reply');
  ok(typeof row.averageRating === 'number' && Number.isInteger(row.totalReviewCount), 'the row carries averageRating + totalReviewCount');

  // ---- 2. engine `reply-to-review`: ok + the three degrades -----------------
  const rid = row.items[0].commentId;
  const okReply = runEngine(['reply-to-review', '--review-id', rid, '--text', 'Thank you!', '--json', '--actor', 'owner']);
  ok(okReply.ok === true && okReply.results[0].action === 'reply-to-review' && okReply.results[0].id === rid,
    'reply-to-review upserts ok and echoes { action:reply-to-review, id:reviewId }');

  const over = runEngine(['reply-to-review', '--review-id', rid, '--text', 'x'.repeat(4097), '--json', '--actor', 'owner']);
  ok(over.ok === false && over.code === 'invalid_input', 'an over-length (>4096) reply degrades to invalid_input');

  const missing = runEngine(['reply-to-review', '--review-id', 'accounts/1/locations/2/reviews/missing', '--text', 'hi', '--json', '--actor', 'owner']);
  ok(missing.ok === false && missing.code === 'review_missing', 'a stale review id degrades to review_missing (the 404 branch)');

  const ung = runEngine(['reply-to-review', '--review-id', rid, '--text', 'hi', '--json', '--actor', 'owner'], { PENDPOST_MOCK_UNGRANTED: 'gbp' });
  ok(ung.ok === false && ung.error === 'needs_scope' && ung.scope === 'business.manage', 'an ungranted project degrades to needs_scope (scope business.manage)');

  const ungRead = runEngine(['reviews', '--json', '--actor', 'inbox'], { PENDPOST_MOCK_UNGRANTED: 'gbp' });
  ok(ungRead.ok === false && ungRead.error === 'needs_scope', 'an ungranted reviews READ degrades to needs_scope at the top envelope');

  // ---- 3. a FAILED read is ok:false, NEVER a false-empty items:[] -----------
  // No account/location id set + LIVE engine (no mock) -> not_configured, no network.
  const failRead = runEngine(['reviews', '--json', '--actor', 'inbox'], { PENDPOST_MODE: null });
  ok(failRead.ok === false && failRead.code === 'not_configured', 'a genuinely failed read is ok:false (not_configured), never a false-empty items:[]');

  // ---- 4. the lib listReviews() logs NEW reviews + dedups -------------------
  const lib1 = await listReviews({});
  ok(lib1.ok === true && Array.isArray(lib1.items) && lib1.items.length >= 2, 'listReviews() resolves ok:true with the review items');
  ok(lib1.items.every((it) => it.kind === 'review' && it.postId === null), 'listReviews items keep the P6 shape (kind:review, postId:null)');
  const logged = (loadState().activity || []).filter((e) => e.action === 'review-received');
  ok(logged.length >= 2, 'each NEW review is logged as a review-received Activity entry');
  ok(logged.every((e) => e.platform === 'gbp' && e.reviewId && (e.rating === null || Number.isInteger(e.rating))), 'the logged entry carries platform:gbp + reviewId + rating');
  const before = (loadState().activity || []).length;
  await listReviews({});
  const after = (loadState().activity || []).length;
  ok(after === before, 'a second read logs NO duplicate review-received entries (seen-id dedup)');
  ok(Array.isArray(loadState().gbpReviews?.seen) && loadState().gbpReviews.seen.length >= 2, 'seen review ids are cached under state.gbpReviews.seen (never a plan file)');

  // ---- 4b. listReviews() PRESERVES the engine's not_configured code ----------
  // A not-connected lane (no account/location ids + LIVE engine) must resolve ok:false
  // with code:'not_configured' - NOT collapsed to engine_failure - so the Studio can render
  // it as SILENCE (a not-connected GBP lane is not an error; spec 03 review). The engine
  // assertion above proves the ENVELOPE; this proves the LIB read face preserves the code.
  const savedMode = process.env.PENDPOST_MODE;
  delete process.env.PENDPOST_MODE;
  const libUnconfigured = await listReviews({});
  if (savedMode !== undefined) process.env.PENDPOST_MODE = savedMode;
  ok(libUnconfigured.ok === false && libUnconfigured.code === 'not_configured',
    'listReviews() preserves the engine not_configured code (never collapsed to engine_failure)');
  ok(Array.isArray(libUnconfigured.items) && libUnconfigured.items.length === 0,
    'the not_configured read carries an empty items[] (never a false-populated list)');

  // ---- 5. the lib listReviews() honest degrades -----------------------------
  process.env.PENDPOST_MOCK_UNGRANTED = 'gbp';
  const libScope = await listReviews({});
  delete process.env.PENDPOST_MOCK_UNGRANTED;
  ok(libScope.ok === true && libScope.needsScope === true && libScope.scope === 'business.manage' && libScope.items.length === 0,
    'listReviews ungranted resolves ok:true + needsScope (reachable), items:[] - the honest authorize affordance');

  // ---- 6. the lib replyToReview(): actor gate + logging + degrades ----------
  const noActor = await replyToReview({ reviewId: rid, text: 'hi' });
  ok(noActor.ok !== true && noActor.code === 'invalid_input', 'replyToReview rejects a missing actor (invalid_input)');
  const unknownActor = await replyToReview({ reviewId: rid, text: 'hi', actor: 'unknown' });
  ok(unknownActor.ok !== true && unknownActor.code === 'invalid_input', 'replyToReview rejects actor "unknown"');

  const libReply = await replyToReview({ reviewId: rid, text: 'Thanks so much!', actor: 'owner' });
  ok(libReply.ok === true && libReply.reviewId === rid && libReply.platform === 'gbp', 'replyToReview upserts ok { reviewId, platform:gbp }');
  ok((loadState().activity || []).some((e) => e.action === 'review-reply' && e.ok === true && e.reviewId === rid), 'a successful reply logs an ok review-reply Activity entry');

  const libMissing = await replyToReview({ reviewId: 'accounts/1/locations/2/reviews/missing', text: 'hi', actor: 'owner' });
  ok(libMissing.ok !== true && libMissing.code === 'invalid_input' && libMissing.error === 'review_missing', 'replyToReview maps review_missing -> invalid_input carrying error:review_missing');

  process.env.PENDPOST_MOCK_UNGRANTED = 'gbp';
  const libReplyScope = await replyToReview({ reviewId: rid, text: 'hi', actor: 'owner' });
  delete process.env.PENDPOST_MOCK_UNGRANTED;
  ok(libReplyScope.ok !== true && libReplyScope.code === 'not_configured' && libReplyScope.needsScope === true, 'replyToReview ungranted -> not_configured + needsScope (authorize affordance)');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[gbp-reviews] OK - P6 review shape, upsert + invalid_input/review_missing/needs_scope degrades, listReviews log+dedup+honest-fail, replyToReview actor gate + logging (${pass} assertions).`);
} catch (err) {
  console.error(`[gbp-reviews] FAIL - ${err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
