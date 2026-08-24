#!/usr/bin/env node
// test/insights-window.test.mjs - the metered-read window for the daily insights
// sweep (lib/insights-window.mjs). Regression for the 2026-08 X credit drain:
// commit 36bdcb1 (Aug 4) added x/reddit/mastodon to dailyInsightsSweep, and the X
// engine's cmdInsights re-read public_metrics for EVERY tweet ever published on
// EVERY 24h sweep with no age window and no cap. On X's pay-per-call model that is
// ~1 metered GET /2/tweets/{id} per accumulated post per day (~50/day and growing),
// which quietly drained the credit balance to $0 - after which the next scheduled
// POST /tweets returned a genuine HTTP 402 "credits depleted". measurableInsightsPosts
// bounds the sweep to a recency window + a hard cap so old, stable-metric posts are
// no longer re-read daily. Pure - no network, no clock (now is injected).
//
// Zero-dep node:assert.
import assert from 'node:assert';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const { measurableInsightsPosts, INSIGHTS_MAX_AGE_DAYS, INSIGHTS_MAX_POSTS } = await import('../lib/insights-window.mjs');

const NOW = Date.parse('2026-08-23T12:00:00Z');
const DAY = 24 * 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const posted = (id, ageDays) => ({ id, postedAt: iso(NOW - ageDays * DAY) });

try {
  ok(INSIGHTS_MAX_AGE_DAYS > 0 && INSIGHTS_MAX_AGE_DAYS <= 30, `the age window is a sane small number of days (${INSIGHTS_MAX_AGE_DAYS})`);
  ok(INSIGHTS_MAX_POSTS > 0, `there is a hard post cap backstop (${INSIGHTS_MAX_POSTS})`);

  // ===== recency window ======================================================
  const recent = measurableInsightsPosts([posted('young', 1), posted('old', INSIGHTS_MAX_AGE_DAYS + 5)], { now: NOW });
  ok(recent.some((p) => p.id === 'young'), 'a fresh post (1 day old) is measured');
  ok(!recent.some((p) => p.id === 'old'), 'a post older than the window is NOT re-measured (stops the daily drain)');

  // boundary: exactly at the window edge is still measured (>= cutoff)
  const edge = measurableInsightsPosts([posted('edge', INSIGHTS_MAX_AGE_DAYS)], { now: NOW });
  ok(edge.length === 1 && edge[0].id === 'edge', 'a post exactly at the window edge is still measured (inclusive cutoff)');

  // ===== fail-open on a missing timestamp ====================================
  const noTs = measurableInsightsPosts([{ id: 'nots' }, { id: 'sched', scheduledAt: iso(NOW - 2 * DAY) }], { now: NOW });
  ok(noTs.some((p) => p.id === 'nots'), 'a post with no postedAt/scheduledAt is measured (fail-open, rare)');
  ok(noTs.some((p) => p.id === 'sched'), 'scheduledAt is the fallback timestamp when postedAt is absent');

  // ===== hard cap, most-recent first =========================================
  const many = [];
  for (let i = 0; i < INSIGHTS_MAX_POSTS + 20; i++) many.push(posted(`p${i}`, i * 0.1)); // all within the window, staggered
  const capped = measurableInsightsPosts(many, { now: NOW });
  ok(capped.length === INSIGHTS_MAX_POSTS, `a large in-window backlog is capped at ${INSIGHTS_MAX_POSTS} (${capped.length})`);
  ok(capped[0].id === 'p0', 'the cap keeps the MOST RECENT posts first (p0 is newest)');
  ok(!capped.some((p) => p.id === `p${INSIGHTS_MAX_POSTS + 19}`), 'the oldest posts are dropped when the cap bites');

  // ===== overridable knobs + empty input =====================================
  const tight = measurableInsightsPosts([posted('a', 3), posted('b', 10)], { now: NOW, maxAgeDays: 7 });
  ok(tight.length === 1 && tight[0].id === 'a', 'maxAgeDays is overridable (7-day window drops the 10-day post)');
  ok(measurableInsightsPosts([], { now: NOW }).length === 0, 'empty input yields empty output');
  ok(measurableInsightsPosts(undefined, { now: NOW }).length === 0, 'undefined input is handled (no throw)');

  // ===== lane pre-filter composition (reddit / mastodon) =====================
  // commit 36bdcb1 added reddit + mastodon to the same daily sweep. Their APIs are
  // free (no per-call credit like X), so the bound is request-volume / rate-limit
  // hygiene, not a cost fix - but each cmdInsights composes measurableInsightsPosts
  // identically: pre-filter to the posts carrying THAT lane's published id, then
  // window+cap for the bulk sweep, honoring an explicit --only in full. Model that
  // exact composition here (pure - no engine import, no network) so the id-field +
  // --only contract is locked alongside the window itself.
  const REDDIT_SENTINEL = '__pendpost_reddit_submitted__'; // stands in for REDDIT_SUBMITTED_SENTINEL (no real id yet)
  const redditEligible = (posts) => posts.filter((p) => p.platforms?.includes('reddit') && p.redditPostId && p.redditPostId !== REDDIT_SENTINEL);
  const mastoEligible = (posts) => posts.filter((p) => p.platforms?.includes('mastodon') && p.mastodonStatusId);

  const redditPlan = [
    { ...posted('r-young', 1), platforms: ['reddit'], redditPostId: 't3_young' },
    { ...posted('r-old', INSIGHTS_MAX_AGE_DAYS + 5), platforms: ['reddit'], redditPostId: 't3_old' },
    { ...posted('r-noid', 1), platforms: ['reddit'] },                                    // no id -> never measured
    { ...posted('r-sentinel', 1), platforms: ['reddit'], redditPostId: REDDIT_SENTINEL }, // sentinel -> no real id yet
  ];
  const redditSweep = measurableInsightsPosts(redditEligible(redditPlan), { now: NOW });
  ok(redditSweep.some((p) => p.id === 'r-young'), 'reddit bulk sweep measures a fresh submission carrying a real redditPostId');
  ok(!redditSweep.some((p) => p.id === 'r-old'), 'reddit bulk sweep drops a stale-metric submission past the window');
  ok(!redditSweep.some((p) => p.id === 'r-noid'), 'reddit pre-filter excludes a post with no redditPostId');
  ok(!redditSweep.some((p) => p.id === 'r-sentinel'), 'reddit pre-filter excludes the not-yet-resolved submitted sentinel');
  // --only bypasses the window: an explicit single-post fetch on the OLD post is honored in full.
  const redditOnly = redditEligible(redditPlan).filter((p) => p.id === 'r-old');
  ok(redditOnly.length === 1 && redditOnly[0].id === 'r-old', 'reddit --only honors an out-of-window post in full (bypasses the sweep bound)');

  const mastoPlan = [
    { ...posted('m-young', 1), platforms: ['mastodon'], mastodonStatusId: '111' },
    { ...posted('m-old', INSIGHTS_MAX_AGE_DAYS + 5), platforms: ['mastodon'], mastodonStatusId: '222' },
    { ...posted('m-noid', 1), platforms: ['mastodon'] },                                  // native-scheduled, not yet published
  ];
  const mastoSweep = measurableInsightsPosts(mastoEligible(mastoPlan), { now: NOW });
  ok(mastoSweep.some((p) => p.id === 'm-young'), 'mastodon bulk sweep measures a fresh status carrying a mastodonStatusId');
  ok(!mastoSweep.some((p) => p.id === 'm-old'), 'mastodon bulk sweep drops a stale-metric status past the window');
  ok(!mastoSweep.some((p) => p.id === 'm-noid'), 'mastodon pre-filter excludes a post with no mastodonStatusId');
  const mastoOnly = mastoEligible(mastoPlan).filter((p) => p.id === 'm-old');
  ok(mastoOnly.length === 1 && mastoOnly[0].id === 'm-old', 'mastodon --only honors an out-of-window post in full (bypasses the sweep bound)');

  console.log(`[insights-window] OK - the daily sweep is bounded to a recency window + hard cap, x/reddit/mastodon compose it identically (${pass} assertions).`);
} catch (err) {
  console.error(`[insights-window] FAIL - ${err.message}`);
  process.exit(1);
}
