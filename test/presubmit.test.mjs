#!/usr/bin/env node
// test/presubmit.test.mjs - pre-submit validation reads (spec 09, Pattern P3
// engine read verb + Pattern P4 read tool), run mock-mode end-to-end:
//
//   1. RAW ENGINE: reddit `presubmit` flags a required flair (warning) + a
//      restricted subreddit (problem); tiktok `presubmit` flags an over-limit
//      caption + a disallowed privacy level (both problems); a clean tiktok
//      post (short caption, default privacy) returns ready:true with empty
//      problems/warnings.
//   2. NEEDS_SCOPE (P9): PENDPOST_MOCK_UNGRANTED degrades to
//      { ok:true, ready:null, warnings:[{code:'needsScope'}] } - never a throw.
//   3. LIB FACE: presubmitCheck(campaign, postId) merges the per-lane rows into
//      the SAME { ok:true, platforms:{ <p>: {ready,problems,warnings} } } shape
//      platformValidate returns; a non-reddit/tiktok post yields an EMPTY
//      platforms map (never a false claim for a lane this spec doesn't cover);
//      invalid campaign/post ids are a clean errorBody.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib
// (util binds WORKSPACE_ROOT at import; mirrors test/platform-validate-wave2.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-presubmit-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_MOCK_UNGRANTED;

const plansDir = path.join(WS, 'data', 'plans');
const campDir = path.join(plansDir, 'wave-presubmit');
fs.mkdirSync(campDir, { recursive: true });

const FUTURE = '2099-01-01T09:00:00Z';
const post = (id, platforms, extra = {}) => ({
  id, platforms, type: 'text', scheduledAt: FUTURE, caption: 'a quiet note',
  status: 'planned', executionMode: 'fully-scheduled',
  approval: 'approved', approvalBy: 'owner', approvalAt: '2026-01-01T00:00:00Z',
  createdBy: 'agent:claude', ...extra,
});

const PLAN_ABS = path.join(campDir, 'post-plan.json');

fs.writeFileSync(path.join(plansDir, 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'wave-presubmit', path: 'data/plans/wave-presubmit/post-plan.json', active: true }],
}, null, 2));
fs.writeFileSync(PLAN_ABS, JSON.stringify({
  campaign: 'Pre-submit readiness',
  timezone: 'UTC',
  posts: [
    post('reddit-flagged', ['reddit']),
    // A title over the mock subreddit's title_text_max_length (100) - §2's
    // "title over the subreddit limit" acceptance scenario.
    post('reddit-longtitle', ['reddit'], { title: 'T'.repeat(120) }),
    post('tiktok-flagged', ['tiktok'], { ttCaption: 'a'.repeat(2300), ttPrivacy: 'PUBLIC_TO_EVERYONE' }),
    post('tiktok-clean', ['tiktok'], { ttCaption: 'a short, on-brand caption' }),
    post('other-lane-only', ['instagram']),
  ],
}, null, 2));

function runEngine(script, only) {
  const out = execFileSync(process.execPath, [
    path.join(REPO, script), 'presubmit', '--plan', PLAN_ABS, '--only', only, '--json',
  ], {
    cwd: REPO,
    env: { ...process.env, PENDPOST_ROOT: WS },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}
function presubmitRow(envelope, postId) {
  return Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.postId === postId && r.action === 'presubmit') : null;
}
function hasCode(list, code) {
  return Array.isArray(list) && list.some((r) => r && r.code === code);
}

try {
  // ===== (1) RAW ENGINE: reddit flags flair-required (warning) + restricted (problem) =====
  const redditEnv = runEngine('scripts/reddit-social.mjs', 'reddit-flagged');
  ok(redditEnv.ok === true, 'reddit presubmit: engine envelope ok:true (never a throw past the envelope)');
  const redditRow = presubmitRow(redditEnv, 'reddit-flagged');
  ok(redditRow && redditRow.ok === true, 'reddit presubmit: returns an ok:true row');
  ok(redditRow.ready === false, 'reddit presubmit: a restricted subreddit is NOT ready');
  ok(hasCode(redditRow.problems, 'flairRequired'), 'reddit presubmit: flags flair-required as a BLOCKING problem (spec 36)');
  ok(hasCode(redditRow.problems, 'restricted'), 'reddit presubmit: flags the restricted subreddit as a problem');
  ok(!hasCode(redditRow.problems, 'titleRule'), 'reddit presubmit: a short title does NOT trip the title-length rule');

  // ===== (1a2) RAW ENGINE: a title over title_text_max_length flags titleRule (§2) =====
  const redditLongEnv = runEngine('scripts/reddit-social.mjs', 'reddit-longtitle');
  const redditLongRow = presubmitRow(redditLongEnv, 'reddit-longtitle');
  ok(redditLongRow && redditLongRow.ready === false, 'reddit presubmit: an over-length title is NOT ready');
  ok(hasCode(redditLongRow.problems, 'titleRule'), 'reddit presubmit: a title over the subreddit limit flags the titleRule problem');

  // ===== (1b) RAW ENGINE: tiktok flags an over-limit caption + a disallowed privacy =====
  const ttFlaggedEnv = runEngine('scripts/tiktok-social.mjs', 'tiktok-flagged');
  ok(ttFlaggedEnv.ok === true, 'tiktok presubmit: engine envelope ok:true');
  const ttFlaggedRow = presubmitRow(ttFlaggedEnv, 'tiktok-flagged');
  ok(ttFlaggedRow && ttFlaggedRow.ok === true, 'tiktok presubmit: returns an ok:true row');
  ok(ttFlaggedRow.ready === false, 'tiktok presubmit: an over-limit caption + disallowed privacy is NOT ready');
  ok(hasCode(ttFlaggedRow.problems, 'captionLength'), 'tiktok presubmit: flags the over-limit caption as a problem');
  ok(hasCode(ttFlaggedRow.problems, 'privacy'), 'tiktok presubmit: flags the disallowed privacy level as a problem');

  // ===== (1c) RAW ENGINE: a clean tiktok post returns ready:true, empty arrays =====
  const ttCleanEnv = runEngine('scripts/tiktok-social.mjs', 'tiktok-clean');
  const ttCleanRow = presubmitRow(ttCleanEnv, 'tiktok-clean');
  ok(ttCleanRow && ttCleanRow.ok === true && ttCleanRow.ready === true, 'tiktok presubmit: a well-shaped post is ready:true');
  ok(ttCleanRow.problems.length === 0 && ttCleanRow.warnings.length === 0, 'tiktok presubmit: a clean post carries empty problems/warnings arrays');

  // ===== (2) needs_scope degrade (P9): mock-ungranted -> ready:null + a warning, never a throw =====
  process.env.PENDPOST_MOCK_UNGRANTED = 'reddit';
  const ungrantedEnv = runEngine('scripts/reddit-social.mjs', 'reddit-flagged');
  ok(ungrantedEnv.ok === true, 'reddit presubmit (ungranted): top envelope stays ok:true (degrade, never throw)');
  const ungrantedRow = presubmitRow(ungrantedEnv, 'reddit-flagged');
  ok(ungrantedRow && ungrantedRow.ok === true && ungrantedRow.ready === null, 'reddit presubmit (ungranted): degrades to ok:true/ready:null');
  ok(hasCode(ungrantedRow.warnings, 'needsScope') && ungrantedRow.problems.length === 0, 'reddit presubmit (ungranted): carries a needsScope warning, no problems');
  delete process.env.PENDPOST_MOCK_UNGRANTED;

  // ===== (3) LIB FACE: presubmitCheck merges into the platform-validate shape =====
  const { presubmitCheck } = await import('../lib/writes.mjs');

  const redditCheck = await presubmitCheck({ campaign: 'wave-presubmit', postId: 'reddit-flagged' });
  ok(redditCheck.ok === true, 'presubmitCheck(reddit-flagged): ok:true');
  ok(redditCheck.platforms.reddit && redditCheck.platforms.reddit.ready === false, 'presubmitCheck(reddit-flagged): platforms.reddit.ready === false');
  ok(hasCode(redditCheck.platforms.reddit.problems, 'flairRequired') && hasCode(redditCheck.platforms.reddit.problems, 'restricted'),
    'presubmitCheck(reddit-flagged): merges the engine row verbatim (flairRequired + restricted problems, spec 36)');

  const ttCheck = await presubmitCheck({ campaign: 'wave-presubmit', postId: 'tiktok-clean' });
  ok(ttCheck.ok === true && ttCheck.platforms.tiktok, 'presubmitCheck(tiktok-clean): ok:true, carries a tiktok entry');
  ok(ttCheck.platforms.tiktok.ready === true && ttCheck.platforms.tiktok.problems.length === 0 && ttCheck.platforms.tiktok.warnings.length === 0,
    'presubmitCheck(tiktok-clean): ready:true, empty problems/warnings arrays');

  const otherCheck = await presubmitCheck({ campaign: 'wave-presubmit', postId: 'other-lane-only' });
  ok(otherCheck.ok === true && Object.keys(otherCheck.platforms).length === 0,
    'presubmitCheck(other-lane-only): a non-reddit/tiktok post yields an EMPTY platforms map (never a false claim for an uncovered lane)');

  // ===== (4) clean errorBody on invalid ids (no throw, no engine spawn) =====
  const badCampaign = await presubmitCheck({ campaign: 'does-not-exist', postId: 'x' });
  ok(badCampaign.ok !== true && badCampaign.code === 'unknown_campaign', 'presubmitCheck: an unknown campaign is a clean unknown_campaign errorBody');
  const badPost = await presubmitCheck({ campaign: 'wave-presubmit', postId: 'does-not-exist' });
  ok(badPost.ok !== true && badPost.code === 'unknown_post', 'presubmitCheck: an unknown post is a clean unknown_post errorBody');

  console.log(`[presubmit] OK - reddit/tiktok pre-submit reads flag subreddit rules + creator settings, degrade cleanly on a missing scope, and merge into the platform-validate shape (${pass} assertions).`);
} catch (err) {
  console.error(`[presubmit] FAIL - ${err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
