#!/usr/bin/env node
// test/performance-summary.test.mjs - R8 / dim-3 M2 (performance memory, the
// measure -> iterate loop). Two faces:
//   1. performanceSummary() is a PURE ranking over enriched insights items -
//      average engagement per bucket along lane / post type / publish hour,
//      honest below SUMMARY_MIN_MEASURED measured posts.
//   2. getInsights() exposes that summary in its envelope (additive `summary`
//      field) with no new fetch, so the stored-read MCP tool + the "What is
//      working" strip read the same view.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib
// (util binds WORKSPACE_ROOT at import); no clients.json so activeRoot()===WS.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-perfsum-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;

// Empty active-plans manifest so getInsights()'s loadPlanStore() is happy (no
// posts -> items fall back to ids/nulls, which the pure-function tests seed
// around directly).
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { performanceSummary, getInsights } = await import('../lib/insights.mjs');

try {
  // ---- pure function: honesty gate below the minimum -------------------------
  const thin = performanceSummary([
    { platform: 'x', postType: 'text', postedAt: '2026-06-16T09:00:00Z', metrics: { likes: 5 } },
    { platform: 'x', postType: 'text', postedAt: '2026-06-16T10:00:00Z', metrics: { likes: 3 } },
  ], { timezone: 'UTC' });
  ok(thin.hasEnough === false, 'below SUMMARY_MIN_MEASURED (2 measured) hasEnough is false');
  ok(thin.measured === 2, 'measured counts only posts with an engagement-count signal');
  ok(thin.minMeasured === 3, 'the minimum is surfaced so a face can render an honest empty state');

  // ---- exposure-only and rate-only rows never count as engagement ------------
  const noEngage = performanceSummary([
    { platform: 'youtube', postType: 'video', postedAt: '2026-06-16T09:00:00Z', metrics: { views: 9999, impressions: 500 } },
    { platform: 'reddit', postType: 'text', postedAt: '2026-06-16T10:00:00Z', metrics: { upvote_ratio: 0.98 } },
  ], { timezone: 'UTC' });
  ok(noEngage.measured === 0, 'a views/impressions/upvote_ratio-only row carries no engagement signal');
  ok(noEngage.byLane.length === 0 && noEngage.byType.length === 0, 'no buckets form from pure-exposure rows');

  // ---- ranking by AVERAGE, not volume ---------------------------------------
  // reddit: one post scoring 100. x: three posts scoring 10 each (avg 10). By
  // average engagement reddit leads even though x has the higher TOTAL and more
  // posts - effectiveness, not activity.
  const items = [
    { platform: 'reddit', postType: 'text', postedAt: '2026-06-16T14:00:00Z', metrics: { score: 60, num_comments: 40 } },
    { platform: 'x', postType: 'image', postedAt: '2026-06-16T09:00:00Z', metrics: { likes: 6, shares: 4 } },
    { platform: 'x', postType: 'image', postedAt: '2026-06-16T09:30:00Z', metrics: { likes: 5, shares: 5 } },
    { platform: 'x', postType: 'text', postedAt: '2026-06-16T14:00:00Z', metrics: { likes: 8, shares: 2 } },
  ];
  const sum = performanceSummary(items, { timezone: 'UTC' });
  ok(sum.hasEnough === true, '4 measured posts clears the honesty gate');
  ok(sum.byLane[0].key === 'reddit' && sum.byLane[0].avg === 100, 'byLane ranks reddit first by average engagement (100)');
  ok(sum.byLane[1].key === 'x' && sum.byLane[1].posts === 3, 'the busier x lane comes second despite the higher post count');
  ok(sum.byType[0].key === 'text', 'byType ranks the highest-average post type first');
  // instagram/facebook both fold into the meta lane (PLATFORM_LANE), same as the rest of insights.
  const metaFold = performanceSummary([
    { platform: 'instagram', postType: 'reel', postedAt: '2026-06-16T09:00:00Z', metrics: { likes: 10 } },
    { platform: 'facebook', postType: 'reel', postedAt: '2026-06-16T09:00:00Z', metrics: { likes: 20 } },
    { platform: 'facebook', postType: 'reel', postedAt: '2026-06-16T09:00:00Z', metrics: { likes: 30 } },
  ], { timezone: 'UTC' });
  ok(metaFold.byLane.length === 1 && metaFold.byLane[0].key === 'meta' && metaFold.byLane[0].posts === 3,
    'instagram + facebook rows fold into ONE meta lane bucket');

  // ---- by-hour honours the passed timezone ----------------------------------
  const tzUTC = performanceSummary(items, { timezone: 'UTC' });
  ok(tzUTC.byHour.some((b) => b.key === 14), 'byHour buckets on the publish hour in the given tz (UTC 14:00)');
  const tzTokyo = performanceSummary(items, { timezone: 'Asia/Tokyo' });
  ok(tzTokyo.byHour.some((b) => b.key === 23), 'byHour re-buckets under a different tz (UTC 14:00 -> JST 23:00)');
  const tzBad = performanceSummary(
    [{ platform: 'x', postType: 'text', postedAt: 'not-a-date', metrics: { likes: 5 } },
     { platform: 'x', postType: 'text', postedAt: '2026-06-16T09:00:00Z', metrics: { likes: 5 } },
     { platform: 'x', postType: 'text', postedAt: '2026-06-16T10:00:00Z', metrics: { likes: 5 } }],
    { timezone: 'UTC' });
  ok(tzBad.byHour.reduce((n, b) => n + b.posts, 0) === 2, 'an unparseable postedAt drops out of by-hour but not measured');

  // ---- getInsights() exposes the summary in its envelope --------------------
  const now = '2026-06-16T14:00:00.000Z';
  fs.writeFileSync(path.join(WS, 'state.json'), JSON.stringify({
    insights: {
      lastFetch: now,
      data: {
        'acme/p1/x': { campaign: 'acme', postId: 'p1', platform: 'x', metrics: { likes: 8, shares: 2 }, fetchedAt: now, history: [] },
        'acme/p2/x': { campaign: 'acme', postId: 'p2', platform: 'x', metrics: { likes: 6, shares: 4 }, fetchedAt: now, history: [] },
        'acme/p3/reddit': { campaign: 'acme', postId: 'p3', platform: 'reddit', metrics: { score: 90, num_comments: 10 }, fetchedAt: now, history: [] },
      },
    },
  }, null, 2));
  const env = getInsights();
  ok(env.ok && env.summary && typeof env.summary === 'object', 'getInsights() carries an additive summary object');
  ok(env.summary.measured === 3 && env.summary.hasEnough === true, 'the envelope summary reflects the stored data (3 measured)');
  ok(env.summary.byLane[0].key === 'reddit', 'the envelope summary ranks lanes by average engagement');
  ok(Array.isArray(env.items) && env.items.length === 3, 'items envelope stays backward compatible');

  console.log(`[performance-summary] OK - pure ranking (avg not volume, tz-aware, honest gate) + getInsights envelope (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
