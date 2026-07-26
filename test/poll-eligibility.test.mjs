#!/usr/bin/env node
// test/poll-eligibility.test.mjs - spec 10 (native poll), the P2 double-edit trap.
// A media-less `poll` TYPE must be added to BOTH media predicates or every poll is
// stranded "media missing" forever:
//   - lib/plans.mjs postNeedsMedia (the platformValidate/pendpostHealth readiness rule)
//   - lib/scheduler.mjs eligibleDuePosts (the SACRED shared scheduler filter, a
//     LITERAL duplicate of the same rule)
// This test asserts a media-less poll (a) is NOT flagged as needing media, and (b)
// passes through the scheduler's eligibility filter - alongside a text control (the
// pre-existing media-less type) and a video counter-example (still needs media).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-poll-elig-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const { postNeedsMedia } = await import('../lib/plans.mjs');
const { eligibleDuePosts } = await import('../lib/scheduler.mjs');

try {
  // ---- 1. postNeedsMedia: a poll is media-less, like text ------------------
  ok(postNeedsMedia({ type: 'poll' }) === false, 'postNeedsMedia(poll) === false (a poll carries no media)');
  ok(postNeedsMedia({ type: 'text' }) === false, 'postNeedsMedia(text) === false (the pre-existing media-less type)');
  ok(postNeedsMedia({ type: 'video' }) === true, 'postNeedsMedia(video) === true (the media counter-example)');

  // ---- 2. eligibleDuePosts: a media-less poll IS eligible ------------------
  // Build the NORMALIZED post shape the scheduler filter reads (approval / status /
  // executionMode / editedSinceApproval / media.exists). A poll with media.exists:false
  // must survive the filter's media gate exactly like a text post.
  const mk = (id, type, mediaExists) => ({
    id, type,
    approval: 'approved',
    status: 'planned',
    executionMode: 'fully-scheduled',
    scheduledAt: '2020-01-01T00:00:00Z',
    platforms: ['x'],
    media: { exists: mediaExists },
    ids: {},
  });
  const campaigns = [{
    id: 'poll-camp',
    posts: [
      mk('pl1', 'poll', false), // media-less poll -> eligible
      mk('txt1', 'text', false), // media-less text control -> eligible
      mk('v1', 'video', false), // video with no media -> NOT eligible (media gate)
    ],
  }];

  const eligibleIds = [...eligibleDuePosts(campaigns)].map(({ post }) => post.id);
  ok(eligibleIds.includes('pl1'), 'eligibleDuePosts yields the media-less poll (both predicates updated)');
  ok(eligibleIds.includes('txt1'), 'eligibleDuePosts still yields the media-less text control');
  ok(!eligibleIds.includes('v1'), 'eligibleDuePosts still SKIPS a video with no media (the gate is intact for media types)');

  // A poll scoped by postId resolves to itself (the scheduler can target one poll).
  const scoped = [...eligibleDuePosts(campaigns, { postId: 'pl1' })].map(({ post }) => post.id);
  ok(scoped.length === 1 && scoped[0] === 'pl1', 'a media-less poll is eligible when scoped by postId');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
