#!/usr/bin/env node
// test/comment-watch.test.mjs - the own-post comment monitor (lib/comment-watch.mjs).
//
// The mirror image of radar-sweep's reconcileAuthorReplies: that watches reply-threads we
// started on strangers' posts; this watches comments OTHERS leave on OUR own published posts.
// It reuses the existing listComments seam (never re-implements a lane read), diffs each read
// comment against a `seen` ledger in state.json (never a plan), keeps the unanswered set in
// state.comments so the aggregated inbox needs no live re-read, logs one 'comments-new'
// Activity entry per batch, and drops a comment when the owner replies/dismisses (resolve) or
// it disappears on-platform. Fail-closed: OFF => inert, no state write.
//
// Pure helpers (dueEvery, mergeComments) are unit-tested directly; the sweep is driven with an
// injected readComments stub (the reconcileCopyFollowups fetchThread precedent) so no engine
// spawns and no network is touched.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-cw-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });

const NOW = Date.parse('2026-08-06T12:00:00.000Z');
const HOUR = 3600 * 1000;
const recent = new Date(NOW - 2 * 24 * HOUR).toISOString(); // 2 days ago (inside the 14d window)
const newer = new Date(NOW - 1 * HOUR).toISOString(); // 1 hour ago (the newest comment - drives the sort)
const stale = new Date(NOW - 40 * 24 * HOUR).toISOString(); // 40 days ago (outside the window)

// A campaign with one RECENT youtube post (minted id) and one STALE youtube post.
const CAMP = 'camp1';
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [{ id: CAMP, path: 'data/plans/camp1.json', active: true }] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'plans', 'camp1.json'), JSON.stringify({
  campaign: CAMP,
  posts: [
    { id: 'p-recent', type: 'video', platforms: ['youtube'], ytVideoId: 'yt-recent', postedAt: recent, caption: 'my recent video' },
    { id: 'p-recent2', type: 'video', platforms: ['youtube'], ytVideoId: 'yt-recent-2', postedAt: recent, caption: 'my second recent video' },
    { id: 'p-stale', type: 'video', platforms: ['youtube'], ytVideoId: 'yt-stale', postedAt: stale, caption: 'my old video' },
  ],
}, null, 2));

const { dueEvery, mergeComments, commentKey, commentSweep, commentInbox, resolveComment } = await import('../lib/comment-watch.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');
const { loadState } = await import('../lib/state.mjs');
const enable = (v = {}) => setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { commentWatch: { enabled: true, ...v } } } });

// A readComments stub: (campaign, postId, platform) -> a listComments-shaped result.
function stub(map) {
  return async ({ campaign, postId, platform }) => map[`${campaign}:${postId}:${platform}`] || { ok: true, items: [] };
}
const comment = (id, text, ts) => ({ commentId: id, author: `author-${id}`, text, ts, permalink: `https://yt/${id}`, kind: 'comment' });

try {
  // ---- dueEvery (interval cadence clock) -----------------------------------
  ok(dueEvery(null, 4 * HOUR, NOW) === true, 'dueEvery: never swept -> due');
  ok(dueEvery(new Date(NOW - 1 * HOUR).toISOString(), 4 * HOUR, NOW) === false, 'dueEvery: swept 1h ago, 4h interval -> not due');
  ok(dueEvery(new Date(NOW - 5 * HOUR).toISOString(), 4 * HOUR, NOW) === true, 'dueEvery: swept 5h ago, 4h interval -> due');

  // ---- mergeComments (pure diff + foundAt preservation) --------------------
  const c1 = { ...comment('c1', 'hi', recent), lane: 'youtube', platform: 'youtube', campaign: CAMP, postId: 'p-recent' };
  const c2 = { ...comment('c2', 'yo', recent), lane: 'youtube', platform: 'youtube', campaign: CAMP, postId: 'p-recent' };
  const m1 = mergeComments([], [c1, c2], new Set(), NOW);
  ok(m1.items.length === 2 && m1.newCount === 2, 'mergeComments: two fresh, none seen -> both items, newCount 2');
  ok(m1.items.every((i) => i.foundAt === new Date(NOW).toISOString()), 'mergeComments: fresh items stamp foundAt=now');
  // c1 already known (older foundAt) preserved; c2 new
  const prevC1 = { ...c1, foundAt: '2026-08-01T00:00:00.000Z' };
  const m2 = mergeComments([prevC1], [c1, c2], new Set(), NOW);
  ok(m2.items.find((i) => i.commentId === 'c1').foundAt === '2026-08-01T00:00:00.000Z', 'mergeComments: an already-seen item keeps its original foundAt');
  ok(m2.newCount === 1, 'mergeComments: only the genuinely new comment counts as new');
  // a comment whose key is in `seen` is excluded
  const m3 = mergeComments([], [c1, c2], new Set([commentKey(c1)]), NOW);
  ok(m3.items.length === 1 && m3.items[0].commentId === 'c2', 'mergeComments: a seen (resolved) comment is excluded');
  // a prev item NOT in fresh, whose scope WAS read this sweep, is dropped (deleted on-platform)
  const scope = `${CAMP}:p-recent:youtube`;
  const m4 = mergeComments([prevC1], [c2], new Set(), NOW, new Set([scope]));
  ok(m4.items.length === 1 && m4.items[0].commentId === 'c2', 'mergeComments: a comment gone from a READ scope is dropped (deleted on-platform)');
  // a prev item whose scope was NOT read this sweep (needs_scope / lane error / aged out) is
  // CARRIED FORWARD - an unanswered comment must never vanish on a transient read gap.
  const m5 = mergeComments([prevC1], [], new Set(), NOW, new Set() /* nothing read */);
  ok(m5.items.length === 1 && m5.items[0].commentId === 'c1', 'mergeComments: an unread scope carries its cached items forward (no false wipe)');

  // ---- commentSweep: fail-closed when disabled -----------------------------
  const off = await commentSweep({ force: true, now: NOW, readComments: stub({}) });
  ok(off === null, 'sweep: disabled -> null (fail-closed)');
  ok(loadState().comments === undefined, 'sweep: disabled -> no state.comments write');

  // ---- commentSweep: reads the RECENT post, ignores the STALE one ----------
  enable();
  const swept = await commentSweep({ force: true, now: NOW, readComments: stub({
    // c1 is older, c2 is newer - the inbox must show c2 as the preview (newest-first).
    [`${CAMP}:p-recent:youtube`]: { ok: true, items: [comment('c1', 'love it', recent), comment('c2', 'question?', newer)], platform: 'youtube' },
    // the stale post is outside the window - if the sweep read it, this would add items
    [`${CAMP}:p-stale:youtube`]: { ok: true, items: [comment('cx', 'old', stale)], platform: 'youtube' },
  }) });
  ok(swept && swept.items === 2, 'sweep: only the in-window posts are read (2 items, stale post skipped)');
  ok(loadState().comments.items.length === 2, 'sweep: unanswered items persisted to state.comments');
  ok(loadState().comments.sources.youtube.ok === true, 'sweep: per-lane source status recorded ok');

  // ---- commentInbox: aggregates by post ------------------------------------
  const inbox = commentInbox();
  ok(inbox.ok === true && inbox.enabled === true, 'inbox: ok + enabled');
  ok(inbox.unanswered === 2, 'inbox: unanswered count is 2');
  const grp = inbox.posts.find((p) => p.postId === 'p-recent');
  ok(grp && grp.unanswered === 2, 'inbox: the post group carries its unanswered count');
  ok(grp.caption && grp.caption.includes('recent'), 'inbox: the post group is enriched with the caption (plan join)');
  ok(Array.isArray(grp.comments) && grp.comments.length === 2, 'inbox: the group carries its comment items');
  // B1: the group's comments are sorted newest-first, so the row preview (comments[0]) and the
  // lastCommentTs beside it are the SAME comment - never a preview from one comment with a
  // timestamp from another.
  ok(grp.comments[0].commentId === 'c2', 'inbox: comments are sorted newest-first (c2 leads)');
  ok(grp.lastCommentTs === grp.comments[0].ts, 'inbox: lastCommentTs matches the previewed (newest) comment');

  // ---- resolveComment: reply/dismiss removes the item, seen prevents return -
  const r = resolveComment({ key: commentKey({ lane: 'youtube', postId: 'p-recent', commentId: 'c1' }), reason: 'replied', actor: 'owner' });
  ok(r.ok === true, 'resolve: ok');
  ok(loadState().comments.items.length === 1, 'resolve: the replied comment leaves the unanswered set');
  ok(commentInbox().unanswered === 1, 'resolve: inbox unanswered drops to 1');
  // a re-sweep must NOT bring the resolved comment back
  await commentSweep({ force: true, now: NOW + HOUR, readComments: stub({
    [`${CAMP}:p-recent:youtube`]: { ok: true, items: [comment('c1', 'love it', recent), comment('c2', 'question?', recent)], platform: 'youtube' },
  }) });
  ok(!loadState().comments.items.find((i) => i.commentId === 'c1'), 'resolve: a resolved comment never re-surfaces on the next sweep');
  ok(loadState().comments.items.length === 1, 'resolve: only the still-open comment remains after re-sweep');

  // ---- needs_scope degrade: honest per-lane state, never a false zero -------
  // EVERY post in the lane must fail for the lane to read as degraded (success wins, B2).
  const NEEDS = { ok: true, items: [], needsScope: true, scope: 'youtube.force-ssl', platform: 'youtube' };
  await commentSweep({ force: true, now: NOW + 2 * HOUR, readComments: stub({
    [`${CAMP}:p-recent:youtube`]: NEEDS,
    [`${CAMP}:p-recent2:youtube`]: NEEDS,
  }) });
  ok(loadState().comments.sources.youtube.ok === false && loadState().comments.sources.youtube.error === 'needs_scope', 'sweep: a lane whose EVERY post failed records ok:false + the reason, not a false zero');
  ok(loadState().comments.sources.youtube.scope === 'youtube.force-ssl', 'sweep: the needs_scope entry carries the scope to authorize');
  ok(loadState().comments.items.find((i) => i.commentId === 'c2'), 'sweep: an unreadable (needs_scope) lane PRESERVES its cached unanswered items (no false wipe)');

  // ---- B2: success wins - one post reading OK keeps the lane readable even if a sibling post
  // in the same lane failed (a single post's blip never degrades the whole lane's inbox row).
  await commentSweep({ force: true, now: NOW + 3 * HOUR, readComments: stub({
    [`${CAMP}:p-recent:youtube`]: { ok: true, items: [comment('c2', 'question?', newer)], platform: 'youtube' },
    [`${CAMP}:p-recent2:youtube`]: NEEDS,
  }) });
  ok(loadState().comments.sources.youtube.ok === true, 'sweep: success wins - one OK post keeps the lane ok:true despite a sibling post failing');
} catch (err) {
  failures += 1;
  console.error('  FAIL - threw:', (err && err.stack) || err);
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
