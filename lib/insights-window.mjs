// insights-window.mjs - bounds the daily insights sweep to a recency window so it
// stops re-reading every post ever published on every run.
//
// The 2026-08 X credit drain: commit 36bdcb1 (Aug 4) added x/reddit/mastodon to
// dailyInsightsSweep (lib/insights.mjs). The X engine's cmdInsights then issued one
// GET /2/tweets/{id}?tweet.fields=public_metrics for EVERY tweet with an xPostId on
// EVERY 24h sweep - unbounded, growing by ~1/day. On X's pay-per-call model each of
// those reads is metered; ~50 reads/day quietly drained the credit balance to $0, and
// the next scheduled POST /tweets then returned a GENUINE HTTP 402 "credits depleted"
// (scripts/x-social.mjs surfaces X's own words verbatim - the error was never a false
// alarm, the credits were really being spent on background reads).
//
// A post's public metrics move fast for a few days, then settle; re-reading a stable
// three-week-old tweet daily buys nothing and costs a credit. So the daily sweep only
// re-measures posts inside a recency window, with a hard cap as a backstop against a
// large backfill. Older posts keep their LAST-measured metrics in state.insights (the
// read view still shows them) - the sweep just stops refreshing them. A single-post
// request (--only / an explicit fetch_insights on one post) bypasses this entirely;
// only the unbounded bulk sweep is bounded. Pure - the caller injects `now`.

// Re-measure a post daily only for its first N days after publishing. X metrics are
// ~stable by two weeks; beyond that the daily read is pure credit waste.
export const INSIGHTS_MAX_AGE_DAYS = 14;

// Backstop against a large backfill (an import, a bulk campaign) all landing inside
// the window at once - never spend more than this many metered reads in one sweep.
export const INSIGHTS_MAX_POSTS = 30;

const DAY_MS = 24 * 3600 * 1000;
const postTs = (p) => Date.parse(p?.postedAt || p?.scheduledAt || '') || null;

// Given a lane's already-id-filtered posts (the caller keeps only posts that carry
// this lane's published id), return the subset the daily sweep should re-measure:
// those posted within `maxAgeDays`, most-recent first, capped at `maxPosts`. A post
// with no usable timestamp is measured (fail-open; rare) but still counts to the cap.
export function measurableInsightsPosts(posts, { now = Date.now(), maxAgeDays = INSIGHTS_MAX_AGE_DAYS, maxPosts = INSIGHTS_MAX_POSTS } = {}) {
  const cutoff = now - maxAgeDays * DAY_MS;
  const within = (posts || []).filter((p) => {
    const t = postTs(p);
    return t === null ? true : t >= cutoff;
  });
  within.sort((a, b) => (postTs(b) || 0) - (postTs(a) || 0));
  return (maxPosts && maxPosts > 0) ? within.slice(0, maxPosts) : within;
}
