#!/usr/bin/env node
// test/evergreen-outliers.test.mjs - R8 FOLLOW-ON (ux-audit dim-3 M1 evergreen
// recycling + M3 breakout/slump alerts), built ON the landed performance-memory
// core. Three faces:
//   1. evergreenCandidates() - a PURE ranking that surfaces OLD high-performers
//      (aged past the recency window, scoring at or above the measured median)
//      so a stale winner can be recycled into a fresh draft. Reuses the SAME
//      engagementScore the performance summary ranks on - never a parallel
//      ranking - and stays honest below SUMMARY_MIN_MEASURED.
//   2. outliers() - a PURE detector of posts far ABOVE (breakout) or BELOW
//      (slump) their lane+format baseline median, skipping thin buckets so it
//      never cries wolf.
//   3. getInsights() carries both additively; generateDigest() names the
//      outliers in one localized section (en + de-CH).
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-evergreen-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { evergreenCandidates, outliers, getInsights, generateDigest } = await import('../lib/insights.mjs');

const NOW = Date.parse('2026-08-05T12:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const agoIso = (days) => new Date(NOW - days * DAY).toISOString();

try {
  // ================= evergreenCandidates: honesty gate =================
  const thin = evergreenCandidates([
    { campaign: 'c', postId: 'a', platform: 'x', postType: 'text', postedAt: agoIso(40), metrics: { likes: 100 } },
    { campaign: 'c', postId: 'b', platform: 'x', postType: 'text', postedAt: agoIso(40), metrics: { likes: 80 } },
  ], { now: NOW });
  ok(Array.isArray(thin) && thin.length === 0, 'below SUMMARY_MIN_MEASURED (2 measured) evergreen surfaces NOTHING');

  // ================= evergreenCandidates: age + median gate =================
  const items = [
    { campaign: 'c', postId: 'p1', platform: 'reddit', postType: 'text', postedAt: agoIso(40), caption: 'winner', metrics: { score: 60, num_comments: 40 } }, // 100, old -> candidate
    { campaign: 'c', postId: 'p2', platform: 'x', postType: 'text', postedAt: agoIso(45), caption: 'strong', metrics: { likes: 80 } }, // 80, old -> candidate (== median)
    { campaign: 'c', postId: 'p3', platform: 'x', postType: 'text', postedAt: agoIso(2), caption: 'fresh', metrics: { likes: 90 } }, // 90 but TOO FRESH -> excluded
    { campaign: 'c', postId: 'p4', platform: 'x', postType: 'text', postedAt: agoIso(50), caption: 'weak', metrics: { likes: 5 } }, // 5, old but BELOW median -> excluded
    { campaign: 'c', postId: 'p5', platform: 'x', postType: 'text', postedAt: agoIso(60), caption: 'mid', metrics: { likes: 70 } }, // 70, old but BELOW median (80) -> excluded
  ];
  const ever = evergreenCandidates(items, { now: NOW });
  ok(ever.length === 2, 'only the aged, at-or-above-median performers surface (2 of 5)');
  ok(ever[0].postId === 'p1' && ever[0].score === 100, 'candidates are ranked by engagement score desc');
  ok(ever[1].postId === 'p2', 'a post at exactly the measured median still qualifies');
  ok(!ever.some((e) => e.postId === 'p3'), 'a fresh high-scorer is NOT evergreen yet (still inside the recency window)');
  ok(!ever.some((e) => e.postId === 'p4' || e.postId === 'p5'), 'an aged but below-median post is not surfaced');
  ok(ever[0].caption === 'winner' && ever[0].ageDays >= 40, 'a candidate carries caption + age for the recycle affordance');
  // A custom recency window is honoured (7 days pulls p3 in).
  const wide = evergreenCandidates(items, { now: NOW, minAgeDays: 1 });
  ok(wide.some((e) => e.postId === 'p3'), 'a shorter minAgeDays widens the window');

  // ================= outliers: breakout + slump vs lane+format median =========
  const oItems = [
    // reddit/text bucket of 5: median 10, one 50 is a 5x breakout.
    { campaign: 'c', postId: 'r1', platform: 'reddit', postType: 'text', postedAt: agoIso(1), caption: 'viral', metrics: { score: 50 } },
    { campaign: 'c', postId: 'r2', platform: 'reddit', postType: 'text', postedAt: agoIso(2), metrics: { score: 10 } },
    { campaign: 'c', postId: 'r3', platform: 'reddit', postType: 'text', postedAt: agoIso(3), metrics: { score: 10 } },
    { campaign: 'c', postId: 'r4', platform: 'reddit', postType: 'text', postedAt: agoIso(4), metrics: { score: 10 } },
    { campaign: 'c', postId: 'r5', platform: 'reddit', postType: 'text', postedAt: agoIso(5), metrics: { score: 10 } },
    // x/text bucket of 5: median 30, one 5 is a slump (5/30 = 0.17).
    { campaign: 'c', postId: 'x1', platform: 'x', postType: 'text', postedAt: agoIso(1), caption: 'flopped', metrics: { likes: 5 } },
    { campaign: 'c', postId: 'x2', platform: 'x', postType: 'text', postedAt: agoIso(2), metrics: { likes: 30 } },
    { campaign: 'c', postId: 'x3', platform: 'x', postType: 'text', postedAt: agoIso(3), metrics: { likes: 30 } },
    { campaign: 'c', postId: 'x4', platform: 'x', postType: 'text', postedAt: agoIso(4), metrics: { likes: 30 } },
    { campaign: 'c', postId: 'x5', platform: 'x', postType: 'text', postedAt: agoIso(5), metrics: { likes: 30 } },
    // meta/reel bucket of only 3 (below OUTLIER_MIN_BUCKET): the 100 must NOT alarm.
    { campaign: 'c', postId: 'm1', platform: 'instagram', postType: 'reel', postedAt: agoIso(1), metrics: { likes: 100 } },
    { campaign: 'c', postId: 'm2', platform: 'instagram', postType: 'reel', postedAt: agoIso(2), metrics: { likes: 1 } },
    { campaign: 'c', postId: 'm3', platform: 'instagram', postType: 'reel', postedAt: agoIso(3), metrics: { likes: 1 } },
  ];
  const out = outliers(oItems, { now: NOW });
  ok(out.breakout.length === 1 && out.breakout[0].postId === 'r1', 'a post far above its lane+format median is a breakout');
  ok(out.breakout[0].baseline === 10 && out.breakout[0].ratio >= 5, 'the breakout carries its baseline + ratio');
  ok(out.slump.length === 1 && out.slump[0].postId === 'x1', 'a post far below its lane+format median is a slump');
  ok(!out.breakout.some((o) => o.postId === 'm1'), 'a thin bucket (below OUTLIER_MIN_BUCKET) never raises an alert');

  // ================= envelope: getInsights carries both additively ===========
  const stateNow = new Date(NOW).toISOString();
  const dataMap = {};
  for (const it of oItems) dataMap[`${it.campaign}/${it.postId}/${it.platform}`] = { campaign: it.campaign, postId: it.postId, platform: it.platform, metrics: it.metrics, fetchedAt: stateNow, history: [] };
  fs.writeFileSync(path.join(WS, 'state.json'), JSON.stringify({ insights: { lastFetch: stateNow, data: dataMap } }, null, 2));
  const env = getInsights();
  ok(env.ok && Array.isArray(env.evergreen), 'getInsights() carries an additive evergreen array');
  ok(env.outliers && Array.isArray(env.outliers.breakout) && Array.isArray(env.outliers.slump), 'getInsights() carries an additive outliers object');
  ok(env.outliers.breakout.some((o) => o.postId === 'r1'), 'the envelope outliers reflect the stored data');

  // ================= digest: the outlier line, en + de-CH ====================
  const enDigest = generateDigest({ locale: 'en' });
  ok(enDigest.ok && /breakout/i.test(enDigest.digest), 'the en digest names a breakout post');
  ok(!enDigest.digest.includes('digest.outliers'), 'no raw i18n key leaks into the digest');
  const deDigest = generateDigest({ locale: 'de-CH' });
  ok(deDigest.ok && deDigest.digest.includes('Ausreisser'), 'the de-CH digest uses ss (Ausreisser), never eszett');
  ok(!/—/.test(enDigest.digest) && !/—/.test(deDigest.digest), 'no em dashes anywhere in the digest');

  if (failures) { console.error(`[evergreen-outliers] ${failures} FAILED`); process.exit(1); }
  console.log(`[evergreen-outliers] OK - evergreen recycling + breakout/slump alerts, honest gates, envelope + digest (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
