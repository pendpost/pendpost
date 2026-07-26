#!/usr/bin/env node
// test/nostr-longform-eligibility.test.mjs - Spec 18, the #1 P2 double-edit trap.
// A media-less `nostr-longform` TYPE must be added to BOTH media predicates or every
// article is stranded "media missing" forever:
//   - lib/plans.mjs postNeedsMedia (the platformValidate/pendpostHealth readiness rule)
//   - lib/scheduler.mjs eligibleDuePosts (the SACRED shared scheduler filter, a
//     LITERAL duplicate of the same rule)
// This test asserts a media-less nostr-longform article (a) is NOT flagged as needing
// media, and (b) passes through the scheduler's eligibility filter - alongside a text
// control and a video counter-example (still needs media). Mirrors poll-eligibility.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-nostr-elig-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const { postNeedsMedia } = await import('../lib/plans.mjs');
const { eligibleDuePosts } = await import('../lib/scheduler.mjs');

try {
  // ---- 1. postNeedsMedia: a nostr-longform article is media-less, like text --------
  ok(postNeedsMedia({ type: 'nostr-longform' }) === false, 'postNeedsMedia(nostr-longform) === false (the article body is Markdown, not a render)');
  ok(postNeedsMedia({ type: 'text' }) === false, 'postNeedsMedia(text) === false (the pre-existing media-less type)');
  ok(postNeedsMedia({ type: 'video' }) === true, 'postNeedsMedia(video) === true (the media counter-example)');

  // ---- 2. eligibleDuePosts: a media-less nostr-longform article IS eligible ---------
  // The normalized post shape the scheduler filter reads (approval / status /
  // executionMode / media.exists). A nostr-longform with media.exists:false must survive
  // the filter's media gate exactly like a text post.
  const mk = (id, type, mediaExists) => ({
    id, type,
    approval: 'approved',
    status: 'planned',
    executionMode: 'fully-scheduled',
    scheduledAt: '2020-01-01T00:00:00Z',
    platforms: ['nostr'],
    media: { exists: mediaExists },
    ids: {},
  });
  const campaigns = [{
    id: 'nostr-camp',
    posts: [
      mk('nl1', 'nostr-longform', false), // media-less article -> eligible
      mk('txt1', 'text', false), // media-less text control -> eligible
      mk('v1', 'video', false), // video with no media -> NOT eligible (media gate)
    ],
  }];

  const eligibleIds = [...eligibleDuePosts(campaigns)].map(({ post }) => post.id);
  ok(eligibleIds.includes('nl1'), 'eligibleDuePosts yields the media-less nostr-longform article (both predicates updated)');
  ok(eligibleIds.includes('txt1'), 'eligibleDuePosts still yields the media-less text control');
  ok(!eligibleIds.includes('v1'), 'eligibleDuePosts still SKIPS a video with no media (the gate is intact for media types)');

  // A nostr-longform scoped by postId resolves to itself (the scheduler can target one).
  const scoped = [...eligibleDuePosts(campaigns, { postId: 'nl1' })].map(({ post }) => post.id);
  ok(scoped.length === 1 && scoped[0] === 'nl1', 'a media-less nostr-longform article is eligible when scoped by postId');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
