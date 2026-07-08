#!/usr/bin/env node
// test/x-reply-chain.test.mjs - the X reply-chain field (xReplyTo) survives the
// write/read seam.
//
// Pure assertions, no manifest, no I/O (same shape as article-fields.test.mjs):
//   1. normalizePost (the read DTO) SURFACES xReplyTo - a field that persists on
//      write but is dropped by the read DTO is invisible to plan_get / the
//      dashboard with no error (write-side/read-side parity rule).
//   2. validateFieldValues ACCEPTS a valid post-id reference (and null to clear)
//      and REJECTS non-string / bad-charset values - every create/update passes
//      through this validator.
// The engine half (parent xPostId resolution, fail-closed skip until the parent
// has published, reply.in_reply_to_tweet_id on the create payload) is covered by
// the live chain check in scripts/x-social.mjs, not mocked here.
import assert from 'node:assert';
import { normalizePost } from '../lib/plans.mjs';
import { validateFieldValues } from '../lib/writes.mjs';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL - ${name}: ${err.message}`);
  }
}

// --- 1. normalizePost surfaces xReplyTo ------------------------------------
const planEntry = { id: 'test-campaign' };
const plan = { timezone: 'UTC' };
const replyPost = {
  id: 'launch-thread-2',
  type: 'text',
  platforms: ['x'],
  caption: 'part two',
  xReplyTo: 'x-launch-thread',
};
const dto = normalizePost(planEntry, plan, replyPost);
check('normalizePost surfaces xReplyTo', () => assert.equal(dto.xReplyTo, 'x-launch-thread'));

const bareDto = normalizePost(planEntry, plan, { id: 'solo', type: 'text', platforms: ['x'] });
check('normalizePost defaults xReplyTo to null when absent', () => assert.equal(bareDto.xReplyTo, null));

// --- 2. validateFieldValues guards the post-id reference -------------------
check('valid post-id reference passes', () => assert.equal(validateFieldValues({ xReplyTo: 'x-launch-thread' }), null));
check('null (clear) passes', () => assert.equal(validateFieldValues({ xReplyTo: null }), null));

const badChars = validateFieldValues({ xReplyTo: 'not a post id!' });
check('bad-charset reference is rejected', () => {
  assert.ok(badChars, 'expected an error body');
  assert.equal(badChars.code, 'invalid_input');
  assert.match(badChars.message, /xReplyTo must be a/);
});

const nonString = validateFieldValues({ xReplyTo: 42 });
check('non-string reference is rejected', () => {
  assert.ok(nonString, 'expected an error body');
  assert.equal(nonString.code, 'invalid_input');
});

// --- 3. mock driver mirrors the fail-closed thread contract ----------------
// The real engine (scripts/x-social.mjs cmdPublishDue) emits a STRUCTURED result
// for an unresolvable parent instead of a silent skip: parent_unpublished is
// deferrable (retry once the parent lands), parent_missing is terminal. The mock
// driver mirrors this exactly so tests/demos exercise the live semantics. These
// checks lock that mirror - the seam the cloud worker's defer logic consumes.
const fsm = await import('node:fs');
const osm = await import('node:os');
const pathm = await import('node:path');
const { runMockCommand } = await import('../lib/drivers/mock-driver.mjs');

const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'pendpost-xreply-'));
const planPath = pathm.join(dir, 'post-plan.json');
const mkPlan = (posts) => fsm.writeFileSync(planPath, JSON.stringify({ campaign: 'thread-c', posts }, null, 2));

// (a) parent not yet published -> the child DEFERS with a structured result.
mkPlan([
  { id: 'p1', platforms: ['x'], type: 'text', caption: 'root' },
  { id: 'p2', platforms: ['x'], type: 'text', caption: 'reply', xReplyTo: 'p1' },
]);
const deferred = await runMockCommand({ platform: 'x', command: 'publish-due', planPath, only: 'p2' });
check('unpublished parent defers the reply (parent_unpublished, deferred:true, never silent)', () => {
  const r = (deferred.results || [])[0];
  assert.ok(r, 'expected a structured result, not an empty envelope');
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'parent_unpublished');
  assert.equal(r.deferred, true);
  const saved = JSON.parse(fsm.readFileSync(planPath, 'utf8'));
  assert.ok(!saved.posts[1].xPostId, 'the deferred reply must not mint an id');
});

// (b) parent published -> the reply publishes.
mkPlan([
  { id: 'p1', platforms: ['x'], type: 'text', caption: 'root', xPostId: '111' },
  { id: 'p2', platforms: ['x'], type: 'text', caption: 'reply', xReplyTo: 'p1' },
]);
const published = await runMockCommand({ platform: 'x', command: 'publish-due', planPath, only: 'p2' });
check('published parent lets the reply publish', () => {
  const r = (published.results || [])[0];
  assert.ok(r && r.ok === true, 'expected a successful publish result');
  const saved = JSON.parse(fsm.readFileSync(planPath, 'utf8'));
  assert.ok(saved.posts[1].xPostId, 'the reply minted an id');
});

// (c) dangling reference -> terminal parent_missing (a config error, not a defer).
mkPlan([
  { id: 'p2', platforms: ['x'], type: 'text', caption: 'reply', xReplyTo: 'ghost' },
]);
const missing = await runMockCommand({ platform: 'x', command: 'publish-due', planPath, only: 'p2' });
check('dangling xReplyTo is terminal parent_missing (not deferred)', () => {
  const r = (missing.results || [])[0];
  assert.ok(r, 'expected a structured result');
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'parent_missing');
  assert.ok(!r.deferred, 'parent_missing must not be marked deferrable');
});

if (failures) {
  console.error(`x-reply-chain: ${failures} failure(s)`);
  process.exit(1);
}
console.log('x-reply-chain: all checks passed');
