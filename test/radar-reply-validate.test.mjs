#!/usr/bin/env node
// test/radar-reply-validate.test.mjs - platformValidate must judge a Radar reply as the
// COMMENT it is, not as the subreddit SUBMISSION it is not.
//
// The defect this pins (observed live on radar-reddit-mrkw3vy3ud): platformValidate's
// reddit branch was written for cmdPublishDue's submit path, so it demanded a destination
// subreddit and a title of EVERY reddit post. A Radar reply has neither by construction -
// scripts/reddit-social.mjs:596-626 POSTs it to /api/comment, where the parent fullname is
// the whole address and a comment body has no title and no 300-char cap. The operator saw
// "title is 611 chars - Reddit caps at 300" against a reply body that is not a title, and
// "Reddit subreddit not set" against a reply that needs no subreddit. Both are noise that
// trains the eye to ignore the pre-publish panel.
//
// The discriminator is the radarReplyTo FIELD, matching the precedent already set for the
// warmth judge at app/src/lib/format.js:434 (`if (post?.radarReplyTo) return {advisories:[]}`).
//
// What must NOT be exempted, and is asserted here: CONNECTIVITY. A comment still needs a
// token, so an unconnected lane still blocks with needsSetup. The reply exemption is
// scoped to the two submission-shaped rules (subreddit + title), nothing wider.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib (util binds
// WORKSPACE_ROOT at import; mirrors test/platform-validate-lanes.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-reply-validate-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;

const plansDir = path.join(WS, 'data', 'plans');
const campDir = path.join(plansDir, 'radar');
fs.mkdirSync(campDir, { recursive: true });

const FUTURE = '2099-01-01T09:00:00Z';
const REPLY_TO = { url: 'https://reddit.com/r/askswitzerland/comments/abc/x', source: 'reddit', externalId: 't3_abc' };
// A reply body well past Reddit's 300-char TITLE cap. As a comment this is unremarkable
// (comments cap at 10k); it is only "too long" if you mistake it for a title.
const LONG_BODY = 'Sounds like you have already done the hard part by getting to a shortlist. '.repeat(9);

const post = (id, extra = {}) => ({
  id, platforms: ['reddit'], type: 'text', scheduledAt: FUTURE, caption: 'a quiet note',
  status: 'planned', executionMode: 'fully-scheduled',
  approval: 'approved', approvalBy: 'owner', approvalAt: '2026-01-01T00:00:00Z',
  createdBy: 'agent:radar', ...extra,
});

fs.writeFileSync(path.join(plansDir, 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'radar', path: 'data/plans/radar/post-plan.json', active: true }],
}, null, 2));
fs.writeFileSync(path.join(campDir, 'post-plan.json'), JSON.stringify({
  campaign: 'Radar replies',
  timezone: 'UTC',
  posts: [
    // The reply under test: no title, no subreddit, a body far past the title cap.
    post('rr-reply', { caption: LONG_BODY, radarReplyTo: REPLY_TO }),
    // The control: byte-identical EXCEPT it carries no radarReplyTo, proving the field
    // (not the lane, not the length) is the discriminator.
    post('rr-submit', { caption: LONG_BODY }),
  ],
}, null, 2));

const { platformValidate } = await import('../lib/writes.mjs');
const validate = async (postId) => {
  const r = await platformValidate({ campaign: 'radar', postId });
  assert.ok(r.ok, `platformValidate(${postId}): ${JSON.stringify(r)}`);
  return r.platforms.reddit;
};

try {
  // ===== (1) unconnected: connectivity is NOT exempted, for a reply or a submission =====
  const coldReply = await validate('rr-reply');
  ok(coldReply.problems.some((p) => /not connected/i.test(p)),
    'a reply on an unconnected lane still blocks: a comment needs a token too');
  ok(coldReply.needsSetup === true,
    'the unconnected reply still routes the operator to Setup (needsSetup)');

  // ===== (2) connected, but no subreddit: the submission-only rules must not fire =====
  fs.writeFileSync(path.join(WS, '.env'), [
    'REDDIT_CLIENT_ID=sentinel-cid',
    'REDDIT_CLIENT_SECRET=sentinel-secret',
    'REDDIT_USERNAME=sentinel-user',
    'REDDIT_PASSWORD=sentinel-pass',
    '',
  ].join('\n'), { mode: 0o600 });

  const reply = await validate('rr-reply');
  ok(!reply.problems.some((p) => /REDDIT_SUBREDDIT|subreddit/i.test(p)),
    'a reply does NOT block on a missing subreddit: the parent fullname is the whole address');
  ok(!reply.problems.some((p) => /title/i.test(p)),
    'a reply does NOT block on a missing title: a comment has no title field');
  ok(!reply.warnings.some((w) => /300/.test(w)),
    'a reply body past 300 chars carries NO title-cap warning (the 611-char lie)');
  ok(reply.ready === true,
    'a connected, well-shaped reply is ready: nothing submission-shaped blocks it');

  // ===== (3) the control: the SAME body without radarReplyTo still gets the old rules =====
  const submit = await validate('rr-submit');
  ok(submit.problems.some((p) => /REDDIT_SUBREDDIT|subreddit/i.test(p)),
    'the control submission STILL blocks on the missing subreddit (radarReplyTo is the discriminator)');
  ok(submit.warnings.some((w) => /300/.test(w)),
    'the control submission STILL warns that its title is over the 300 cap');

  console.log(`[radar-reply-validate] OK - a Radar reply validates as a comment (no subreddit, no title, no 300-cap warning) while connectivity still blocks and a plain submission keeps every submit-path rule (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
