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

if (failures) {
  console.error(`x-reply-chain: ${failures} failure(s)`);
  process.exit(1);
}
console.log('x-reply-chain: all checks passed');
