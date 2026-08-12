#!/usr/bin/env node
// test/lint-gate-effective-text.test.mjs - ux-audit 2026-08-04 B4 (dim-6 parity
// P2, matrix rows 5-6): the publish-time lint gate must lint the EFFECTIVE
// per-lane text (the same `override || caption` resolution the engines publish,
// e.g. x-social.mjs tweetText = xCaption || caption), never the shared caption
// alone. Two failure directions, each proven per lane:
//   1. GATE LEAK: an error-tripping per-lane override behind a clean shared
//      caption must be lint-blocked (before B4 it sailed through the gate and
//      the platform refused at publish time - invisible to Pruefen).
//   2. FALSE BLOCK: a clean per-lane override behind an error-tripping shared
//      caption must PUBLISH (before B4 the gate linted the caption the engine
//      never sends and blocked a publishable post).
// Plus the no-override baseline: without an override the caption is still the
// linted text (unchanged behavior, same guarantee test/lint-gate.test.mjs holds
// for instagram).
//
// Driven against the REAL scheduler publish path (runDueExclusive) in mock
// mode. Error rules used: caption-hard-cap (x, 280) and broken-link (any lane).
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-lint-eff-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.META_PUBLISHING_PAUSED;

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
// A tiny valid PNG so media gates pass for the x image posts.
fs.writeFileSync(path.join(WS, 'data', 'media', 'pic.png'), Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000d49444154789c626001000000ffff03000006000557bfabd4'
  + '0000000049454e44ae426082', 'hex'));

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');
const { brandLint } = await import('../lib/lint.mjs');
const { effectiveLaneText } = await import('../lib/capabilities.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { loadState } = await import('../lib/state.mjs');

const getPost = (camp, id) => (loadPlanStore().campaigns.find((c) => c.id === camp)?.posts || []).find((p) => p.id === id);
const activity = () => loadState().activity || [];
const lintRow = (camp, id) => activity().find((e) => e.campaign === camp && e.postId === id && e.action === 'lint-blocked');

// > 280 plain chars: trips ONLY caption-hard-cap (error, x) + caption-length
// (warn) - no URLs, no other tells.
const OVER_280 = 'a'.repeat(300);
// A bare scheme with no host -> broken-link (severity error on every lane).
const BROKEN = 'big news today, read more https:// soon';
const CLEAN = 'a quiet behind the scenes clip';

async function approvedPost(camp, id, fields) {
  const cc = await createCampaign({ id: camp, note: camp, timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, `createCampaign(${camp}): ${JSON.stringify(cc)}`);
  const cp = await createPost({
    campaign: camp,
    post: { id, scheduledAt: '2020-01-01T00:00:00Z', ...fields },
    actor: 'agent:claude',
  });
  assert.ok(cp.ok, `createPost(${camp}/${id}): ${JSON.stringify(cp)}`);
  const ap = await approvePost({ campaign: camp, postId: id, actor: 'owner' });
  assert.ok(ap.ok, `approvePost(${camp}/${id}): ${JSON.stringify(ap)}`);
}
const xPost = (extra) => ({ type: 'image', platforms: ['x'], path: 'data/media/pic.png', ...extra });
const mastodonPost = (extra) => ({ type: 'text', platforms: ['mastodon'], ...extra });

try {
  // ---- resolver sanity: effectiveLaneText mirrors the engines' resolution ----
  ok(effectiveLaneText({ caption: CLEAN, xCaption: OVER_280 }, 'x') === OVER_280, 'x: xCaption override wins over the shared caption (x-social.mjs tweetText)');
  ok(effectiveLaneText({ caption: CLEAN }, 'x') === CLEAN, 'x: without an override the caption is the effective text');
  ok(effectiveLaneText({ caption: BROKEN, mastodonCaption: CLEAN }, 'mastodon') === CLEAN, 'mastodon: mastodonCaption override wins (mastodon-social.mjs)');
  ok(effectiveLaneText({ caption: CLEAN, xCaption: OVER_280 }, 'instagram') === CLEAN, 'instagram: a foreign-lane override never leaks into another lane');
  // Every documented override field resolves for its lane (the engine truth).
  for (const [platform, field] of [['x', 'xCaption'], ['telegram', 'tgCaption'], ['discord', 'dcCaption'], ['tiktok', 'ttCaption'], ['mastodon', 'mastodonCaption'], ['nostr', 'nostrCaption'], ['reddit', 'redditText'], ['pinterest', 'pinDescription']]) {
    ok(effectiveLaneText({ caption: CLEAN, [field]: 'the lane text' }, platform) === 'the lane text', `${platform}: ${field} is the lane's effective text`);
  }

  // ---- brandLint sanity for the two error rules the gate cases below use -----
  ok(brandLint({ text: OVER_280, platform: 'x' }).clean === false, 'a 300-char text trips caption-hard-cap (error) on x');
  ok(brandLint({ text: BROKEN, platform: 'mastodon' }).clean === false, 'the broken-link text trips a severity:"error" rule on mastodon');
  ok(brandLint({ text: CLEAN, platform: 'x' }).clean !== false && brandLint({ text: CLEAN, platform: 'mastodon' }).clean !== false, 'the clean text is clean on both lanes');

  // ---- X, direction 1 (GATE LEAK): over-cap xCaption + clean caption BLOCKS --
  await approvedPost('xleak', 'p1', xPost({ caption: CLEAN, xCaption: OVER_280 }));
  await runDueExclusive('test', { campaign: 'xleak', postId: 'p1' });
  const xLeak = getPost('xleak', 'p1');
  ok(!xLeak.ids.xPostId && xLeak.status !== 'posted', 'x: an over-280 xCaption behind a clean shared caption does NOT publish');
  const xLeakRow = lintRow('xleak', 'p1');
  ok(Boolean(xLeakRow) && xLeakRow.ok === false, 'x: the over-cap override is lint-blocked VISIBLY (activity row, ok:false)');
  ok(xLeakRow && xLeakRow.platform === 'x', 'x: the lint-blocked row names the x lane');

  // ---- X, direction 2 (FALSE BLOCK): clean xCaption + over-cap caption PUBLISHES --
  await approvedPost('xfalse', 'p1', xPost({ caption: OVER_280, xCaption: 'short and sweet' }));
  await runDueExclusive('test', { campaign: 'xfalse', postId: 'p1' });
  const xFalse = getPost('xfalse', 'p1');
  ok(!lintRow('xfalse', 'p1'), 'x: a compliant xCaption is NOT lint-blocked by a long shared caption the engine never sends');
  ok(Boolean(xFalse.ids.xPostId), `x: the post publishes (xPostId minted, status=${xFalse.status})`);

  // ---- X, no override: the shared caption is still the linted text ----------
  await approvedPost('xplain', 'p1', xPost({ caption: OVER_280 }));
  await runDueExclusive('test', { campaign: 'xplain', postId: 'p1' });
  ok(Boolean(lintRow('xplain', 'p1')) && !getPost('xplain', 'p1').ids.xPostId, 'x: without an override an over-cap caption is still blocked (unchanged behavior)');

  // ---- Mastodon, direction 1 (GATE LEAK): error override + clean caption BLOCKS --
  await approvedPost('mleak', 'p1', mastodonPost({ caption: CLEAN, mastodonCaption: BROKEN }));
  await runDueExclusive('test', { campaign: 'mleak', postId: 'p1' });
  const mLeak = getPost('mleak', 'p1');
  ok(!mLeak.ids.mastodonStatusId && mLeak.status !== 'posted', 'mastodon: an error-tripping mastodonCaption behind a clean caption does NOT publish');
  const mLeakRow = lintRow('mleak', 'p1');
  ok(Boolean(mLeakRow) && mLeakRow.platform === 'mastodon', 'mastodon: the override is lint-blocked with the lane named');

  // ---- Mastodon, direction 2 (FALSE BLOCK): clean override + error caption PUBLISHES --
  await approvedPost('mfalse', 'p1', mastodonPost({ caption: BROKEN, mastodonCaption: CLEAN }));
  await runDueExclusive('test', { campaign: 'mfalse', postId: 'p1' });
  const mFalse = getPost('mfalse', 'p1');
  ok(!lintRow('mfalse', 'p1'), 'mastodon: a clean mastodonCaption is NOT lint-blocked by the dirty shared caption');
  ok(Boolean(mFalse.ids.mastodonStatusId), `mastodon: the post publishes (mastodonStatusId minted, status=${mFalse.status})`);

  // ---- Mastodon, no override: a clean caption still publishes ---------------
  await approvedPost('mplain', 'p1', mastodonPost({ caption: CLEAN }));
  await runDueExclusive('test', { campaign: 'mplain', postId: 'p1' });
  ok(Boolean(getPost('mplain', 'p1').ids.mastodonStatusId), 'mastodon: a clean caption without an override still publishes (no over-block)');

  console.log(`[lint-gate-effective-text] OK - B4: the lint gate judges the engine-effective per-lane text, both failure directions closed on x + mastodon, no-override behavior unchanged (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
