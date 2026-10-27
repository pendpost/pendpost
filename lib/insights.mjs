// insights.mjs - Phase E metrics + digest.
//
// The engines' read-only `insights` commands fetch platform metrics and
// report them ONLY through their --json envelope; this module spawns them,
// stores the results in state.json (state.insights), and renders the digest.
// Plan files never carry metrics - they are git-tracked content,
// metrics churn daily.
import path from 'node:path';
import crypto from 'node:crypto';
import { errorBody, readEnvRaw, offlineCauseCode } from './util.mjs';
import { activeRoot, boundClientId } from './context.mjs';
import { loadPlanStore } from './plans.mjs';
import { loadState, saveState } from './state.mjs';
import { execScript } from './writes.mjs';
import { appendActivity } from './scheduler.mjs';
import { accountStatus } from './accounts.mjs';
import { resolveEnginePath, resolveMode } from './mode.mjs';
import { getPosting } from './config.mjs';
import { AUTO_APPROVE_ACTOR } from './auto-approve.mjs';
import { radarDigestLines } from './radar.mjs';
// Spec 50 P3 §S8. A pure lines-producer, like radarDigestLines beside it: it reads nothing and
// writes nothing, so importing it here adds no cycle and no I/O to the digest path.
import { engageDigestLines } from './engage-digest.mjs';
import { makeT, localeDate, localeDateTime } from './i18n.mjs';

// ---- Performance memory (R8 / dim-3 M2): the measure -> iterate loop --------
// The count-type INTERACTION signals that answer "did the audience DO something"
// (like/comment/share/save/react/zap/reply/upvote/click), as opposed to mere
// EXPOSURE (views/reach/impressions/subscribers) or a 0-1 RATE (engagement,
// upvote_ratio) which is meaningless to sum across posts. performanceSummary()
// ranks buckets by the AVERAGE of this score per post, so a high-volume lane
// never wins on sheer post count - effectiveness, not activity, is what a next
// draft should be conditioned on. Curated, not derived, so an exposure metric
// can never quietly inflate the score; a new interaction metric is one line here.
const ENGAGEMENT_METRIC_KEYS = new Set([
  'likes', 'comments', 'shares', 'saved', 'total_interactions',
  'reactions', 'zaps', 'favourites', 'reblogs', 'replies',
  'score', 'num_comments', 'bookmarks',
  'clicks', 'ctaClicks', 'PIN_CLICK', 'SAVE', 'OUTBOUND_CLICK',
]);

// Below this many MEASURED-with-engagement posts the summary is not honest yet:
// a ranking over one or two posts is noise, not a finding. hasEnough:false then,
// and every face renders the honest "not enough history" empty state, never a
// fabricated top row.
const SUMMARY_MIN_MEASURED = 3;

// The engagement score of ONE metrics snapshot: the sum of its interaction-count
// keys (see ENGAGEMENT_METRIC_KEYS). Exposure/rate keys never contribute.
function engagementScore(metrics) {
  let sum = 0;
  for (const [k, v] of Object.entries(metrics || {})) {
    if (typeof v === 'number' && ENGAGEMENT_METRIC_KEYS.has(k)) sum += v;
  }
  return sum;
}

// The publish hour (0-23) of an ISO timestamp in a given IANA timezone, so "what
// hour earned engagement" reads in the OWNER's clock, not the server's. Pure +
// deterministic given the tz (tests pass 'UTC'); an unparseable input or tz
// yields null and the post simply does not join the by-hour ranking.
function hourInTz(iso, tz) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const part = new Intl.DateTimeFormat('en-US', { hour: '2-digit', hour12: false, timeZone: tz || 'UTC' })
      .formatToParts(d).find((p) => p.type === 'hour');
    if (!part) return null;
    const h = Number(part.value) % 24;
    return Number.isInteger(h) ? h : null;
  } catch { return null; }
}

// Rank the enriched insights items into average-engagement buckets along three
// dimensions - lane, post type, publish hour. PURE over its inputs (the daily
// tick's stored state, read back), so getInsights() can expose it with no new
// fetch and an agent can condition its next plan_create_post on it (mirroring how
// Radar conditions a reply draft). Honest by construction: a post with no
// engagement-count metric never joins a bucket, a bucket with no posts is
// dropped, and below SUMMARY_MIN_MEASURED measured posts hasEnough is false so no
// face invents a finding. Each bucket carries { key, avg, total, posts };
// buckets are sorted by avg desc, ties broken by post count then key for a stable
// order across reads.
export function performanceSummary(items, { timezone = 'UTC' } = {}) {
  const laneAgg = new Map();
  const typeAgg = new Map();
  const hourAgg = new Map();
  let measured = 0;
  const add = (map, key, score) => {
    if (key == null || key === '') return;
    const b = map.get(key) || { key, total: 0, posts: 0 };
    b.total += score; b.posts += 1;
    map.set(key, b);
  };
  for (const it of items || []) {
    const score = engagementScore(it?.metrics);
    if (!(score > 0)) continue;               // no interaction signal -> not a data point
    measured += 1;
    const lane = PLATFORM_LANE[it.platform] || it.platform || null;
    add(laneAgg, lane, score);
    if (it.postType) add(typeAgg, it.postType, score);
    const hour = hourInTz(it.postedAt, timezone);
    if (hour != null) add(hourAgg, hour, score);
  }
  const rank = (map) => [...map.values()]
    .map((b) => ({ key: b.key, avg: Math.round(b.total / b.posts), total: b.total, posts: b.posts }))
    .sort((a, b) => b.avg - a.avg || b.posts - a.posts || String(a.key).localeCompare(String(b.key)));
  return {
    hasEnough: measured >= SUMMARY_MIN_MEASURED,
    measured,
    minMeasured: SUMMARY_MIN_MEASURED,
    byLane: rank(laneAgg),
    byType: rank(typeAgg),
    byHour: rank(hourAgg),
  };
}

// ---- Evergreen recycling (R8 follow-on / dim-3 M1) --------------------------
// Below this age a post is still inside its measurement window - too fresh to be
// "evergreen" (recycling it would just clash with itself). 30 days is a full
// content cycle: long enough that a re-share reads as fresh, short enough that a
// still-relevant winner surfaces. A shorter minAgeDays widens the window (used by
// a caller that wants a tighter recency rule).
const EVERGREEN_MIN_AGE_DAYS = 30;
// Cap the surfaced set so the recycling filter stays a shortlist, not a second
// archive - the highest-scoring aged winners only.
const EVERGREEN_MAX = 8;

// The median of a numeric list (avg of the two middles for an even count); 0 for
// an empty list. Used by both evergreen (the "ranks high" threshold) and outliers
// (the lane+format baseline) so "typical engagement" means one thing here.
function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Surface OLD high-performers worth recycling into a fresh draft (dim-3 M1). A
// candidate is an item that (a) carries a real engagement-count signal (the SAME
// engagementScore the performance summary ranks on - never a parallel ranking),
// (b) is aged past minAgeDays so it is genuinely evergreen, and (c) scores at or
// above the MEDIAN of all measured posts, so an old dud is never dressed up as a
// winner. Honest by construction: below SUMMARY_MIN_MEASURED measured posts the
// set is empty (a ranking over one or two posts is noise), a bucketless post
// never appears, and the result is a shortlist (EVERGREEN_MAX) sorted by score
// desc. Each entry carries { campaign, postId, platform, score, postedAt,
// caption, postType, ageDays } - everything the Published recycling filter needs
// to seed a draft via the existing gated create path. PURE over its inputs (now
// injected for testability).
export function evergreenCandidates(items, { now = Date.now(), minAgeDays = EVERGREEN_MIN_AGE_DAYS } = {}) {
  const scored = [];
  for (const it of items || []) {
    const score = engagementScore(it?.metrics);
    if (!(score > 0)) continue;
    scored.push({ it, score });
  }
  if (scored.length < SUMMARY_MIN_MEASURED) return [];
  const cut = median(scored.map((s) => s.score));
  const minAgeMs = minAgeDays * 24 * 3600 * 1000;
  const out = [];
  for (const { it, score } of scored) {
    if (score < cut) continue;
    const posted = it.postedAt ? Date.parse(it.postedAt) : NaN;
    if (Number.isNaN(posted)) continue;
    const ageMs = now - posted;
    if (ageMs < minAgeMs) continue;
    out.push({
      campaign: it.campaign, postId: it.postId, platform: it.platform,
      score, postedAt: it.postedAt, caption: it.caption || '', postType: it.postType || null,
      ageDays: Math.floor(ageMs / (24 * 3600 * 1000)),
    });
  }
  return out.sort((a, b) => b.score - a.score || String(a.postId).localeCompare(String(b.postId))).slice(0, EVERGREEN_MAX);
}

// ---- Breakout / slump outlier alerts (R8 follow-on / dim-3 M3) --------------
// A post is only a breakout/slump against a HONEST baseline: the median
// engagement of OTHER posts in its own lane+format bucket. A cross-lane or
// cross-format comparison would be apples-to-oranges (a Reel and a text post do
// not share an engagement scale), so the bucket key is lane::postType.
const OUTLIER_MIN_BUCKET = 4;   // a baseline over fewer posts is noise, not a norm
const BREAKOUT_MULT = 3;        // >= 3x the bucket median reads as "far above"
const SLUMP_FRACTION = 1 / 3;   // <= 1/3 of the bucket median reads as "far below"
const OUTLIER_MAX = 5;          // cap each list so the digest/alert stays a headline

// Detect the posts a busy owner should act on: far ABOVE (breakout) or BELOW
// (slump) their lane+format baseline. Skips a thin bucket (< OUTLIER_MIN_BUCKET
// measured posts) and a zero baseline rather than crying wolf on a lane with no
// established norm. Returns { breakout, slump }, each { campaign, postId,
// platform, lane, postType, score, baseline, ratio, caption } - breakout sorted
// by ratio desc, slump by ratio asc, capped OUTLIER_MAX. PURE (now injected).
export function outliers(items, { now: _now = Date.now() } = {}) {
  const buckets = new Map();
  for (const it of items || []) {
    const score = engagementScore(it?.metrics);
    if (!(score > 0)) continue;
    const lane = PLATFORM_LANE[it.platform] || it.platform || null;
    if (!lane) continue;
    const key = `${lane}::${it.postType || '-'}`;
    const b = buckets.get(key) || { lane, postType: it.postType || null, rows: [] };
    b.rows.push({ it, score });
    buckets.set(key, b);
  }
  const breakout = [];
  const slump = [];
  for (const { lane, postType, rows } of buckets.values()) {
    if (rows.length < OUTLIER_MIN_BUCKET) continue;
    const base = median(rows.map((r) => r.score));
    if (!(base > 0)) continue;
    for (const { it, score } of rows) {
      const ratio = score / base;
      const entry = {
        campaign: it.campaign, postId: it.postId, platform: it.platform, lane, postType,
        score, baseline: base, ratio: Math.round(ratio * 100) / 100, caption: it.caption || '',
      };
      if (ratio >= BREAKOUT_MULT) breakout.push(entry);
      else if (ratio <= SLUMP_FRACTION) slump.push(entry);
    }
  }
  return {
    breakout: breakout.sort((a, b) => b.ratio - a.ratio || String(a.postId).localeCompare(String(b.postId))).slice(0, OUTLIER_MAX),
    slump: slump.sort((a, b) => a.ratio - b.ratio || String(a.postId).localeCompare(String(b.postId))).slice(0, OUTLIER_MAX),
  };
}

const ENGINES = {
  meta: 'scripts/meta-social.mjs',
  youtube: 'scripts/yt-social.mjs',
  linkedin: 'scripts/linkedin-social.mjs',
  gbp: 'scripts/gbp-social.mjs',
  // Pinterest ships an `insights` verb but was never in the sweep (spec 07):
  // adding it here (+ LANES/PLATFORM_LANE/lanesWithEvidence below) is the ONLY
  // change needed to fold it in - the sweep loop itself is generic per-lane.
  pinterest: 'scripts/pinterest-social.mjs',
  // Spec 08 (richer analytics, Pattern P5): telegram/ghost/nostr each had an
  // `insights` verb that was a documented no-op (the platform genuinely exposed
  // nothing) - all three now do real reads (telegram: subscriber count via an
  // account-scoped row below; ghost: email opens/sends/clicks; nostr: reaction/
  // zap-receipt counts), so folding them into the generic sweep is the same
  // one-line-per-map change pinterest got.
  telegram: 'scripts/telegram-social.mjs',
  ghost: 'scripts/ghost-social.mjs',
  nostr: 'scripts/nostr-social.mjs',
  // ux-audit 2026-08-04 R3 ("every lane that measures, measures"): x/reddit/
  // mastodon shipped complete, envelope-conformant `insights` verbs the sweep
  // never spawned - the busiest lanes were the only unmeasurable ones, and
  // digest.metrics.none read identically to "the platform has no metrics API".
  // Same one-line-per-map fold-in as pinterest/telegram/ghost/nostr above. The
  // sweep is already fail-soft per lane (engine_failure rows), so a tier-blocked
  // X read degrades honestly - no special-casing.
  x: 'scripts/x-social.mjs',
  reddit: 'scripts/reddit-social.mjs',
  mastodon: 'scripts/mastodon-social.mjs',
};

// The account-scoped insights pass (spec 04, Pattern P5) - the SEAM specs 07
// (demographics) and 08 (richer analytics) extend. A lane -> the engine verb
// that returns ONE location/account-wide payload (NOT per post). After the
// per-post `insights` pass, the sweep runs each mapped verb once per evidence
// lane and MERGES its payload into state.insights.account[lane]. Adding a lane
// later is ONE entry here (gbp -> performance is the first), never a rewrite; a
// lane with no entry is simply skipped (generic - no gbp special-casing).
// Spec 07 (demographics, Pattern P5): meta/youtube/linkedin/pinterest each get
// ONE `demographics` account verb - gbp keeps its own `performance` verb; a
// lane can map to only one verb here, so gbp is untouched.
const ACCOUNT_PASS = {
  gbp: 'performance',
  meta: 'demographics',
  youtube: 'demographics',
  linkedin: 'demographics',
  pinterest: 'demographics',
};

// Stored insights items carry a platform value (instagram/facebook/youtube/
// linkedin/gbp/pinterest), but resolveMode (lib/mode.mjs) reasons in LANES
// (meta/linkedin/youtube/gbp/pinterest). instagram AND facebook BOTH map to the
// 'meta' lane - calling resolveMode with the raw platform would yield the wrong
// mock|live for IG/FB.
const PLATFORM_LANE = { instagram: 'meta', facebook: 'meta', meta: 'meta', linkedin: 'linkedin', youtube: 'youtube', gbp: 'gbp', pinterest: 'pinterest', telegram: 'telegram', ghost: 'ghost', nostr: 'nostr', x: 'x', reddit: 'reddit', mastodon: 'mastodon' };
const LANES = ['meta', 'linkedin', 'youtube', 'gbp', 'pinterest', 'telegram', 'ghost', 'nostr', 'x', 'reddit', 'mastodon'];

// Metered-read lanes: platforms that BILL per metric read. X moved to a pay-per-call
// API, so a background sweep that re-reads every tweet's public_metrics daily quietly
// drains the X credit balance (the 2026-08 incident: reads emptied the wallet, then a
// scheduled POST /tweets returned a genuine HTTP 402). Free lanes cost nothing, so they
// auto-refresh; metered lanes are read ONLY when the owner opts in (posting.insights.
// meteredAuto for the daily sweep, or an explicit "everything" / scope:'all' manual call).
// A Set so a future paid lane is one entry, not a new code path.
export const METERED_READ_LANES = new Set(['x']);
export const isMeteredLane = (lane) => METERED_READ_LANES.has(lane);

// The single gate deciding which evidence lanes a sweep actually reads: every free lane,
// plus only the metered lanes in `includeMetered`. A skipped metered lane is never
// iterated, so it is never spawned AND never enters `sweptLanes` (the availability-honesty
// record) - it was simply not part of this sweep, not a lane that failed.
export function sweepableLanes(evidenceLanes, includeMetered = []) {
  const inc = new Set(includeMetered);
  return [...evidenceLanes].filter((lane) => !METERED_READ_LANES.has(lane) || inc.has(lane));
}

// Map a manual/agent refresh SCOPE to the metered lanes it may read. 'all' = every metered
// lane (the cost-confirmed "everything" refresh); anything else (default 'free') = none, so
// the default refresh and the agent's default fetch_insights never surprise-spend credits.
export function includeMeteredForScope(scope) {
  return scope === 'all' ? [...METERED_READ_LANES] : [];
}

// The resolved mock|live for every lane, under the active client root. The SAME
// derivation the engines and account_status use (resolveMode); a plain string
// per lane, never a secret. Shared by getInsights() and generateDigest().
function laneModes() {
  const mode = {};
  for (const lane of LANES) mode[lane] = resolveMode(lane);
  return mode;
}
const INSIGHTS_TIMEOUT_MS = 120_000;

// One sweep is allowed at a time - engine spawns are not cheap.
let busy = false;

function lanesWithEvidence(posts) {
  const lanes = new Set();
  for (const p of posts) {
    // fbPostId: a Facebook photo / multi-photo Page post (issue #7).
    if (p.ids.igMediaId || p.ids.fbReelId || p.ids.fbPostId) lanes.add('meta');
    if (p.ids.ytVideoId) lanes.add('youtube');
    if (p.ids.liPostId) lanes.add('linkedin');
    if (p.ids.gbpPostId) lanes.add('gbp');
    if (p.ids.pinId) lanes.add('pinterest');
    // Spec 08 - the three newly-real lanes, keyed on each lane's own minted id.
    if (p.ids.tgMessageId) lanes.add('telegram');
    if (p.ids.ghostPostId) lanes.add('ghost');
    if (p.ids.nostrEventId) lanes.add('nostr');
    // R3 - the three previously-unswept lanes, keyed on each lane's own minted id.
    if (p.ids.xPostId) lanes.add('x');
    if (p.ids.redditPostId) lanes.add('reddit');
    if (p.ids.mastodonStatusId) lanes.add('mastodon');
  }
  return lanes;
}

// ---- Insights error noise (owner principle: a message reaches the owner only when
// pendpost cannot fix it itself AND it names the exact one-step fix) ----------------
//
// Three mechanisms keep the nightly sweep from crying wolf:
//   1. A lane whose stored liveness probe says it is not set up (state.health[lane]
//      ok:false, detail "not configured (...)" / "not connected (...)") is never spawned:
//      there is nothing to measure, and Setup already shows the lane as incomplete.
//   2. A lane CIRCUIT: needs_scope / api_disabled / token cannot heal by retrying, so the
//      reason is remembered in state.insights.unavailable[lane] and the AUTOMATIC sweep
//      skips that lane until (a) 7 days passed since the last probe (`at`), or (b) the
//      lane's credentials changed. The credential signal is a short sha256 fingerprint of
//      the lane's credential values in its .env (the refresh token when the lane has one,
//      else every *TOKEN/SECRET/KEY/PASSWORD var of that lane): a reconnect always mints a
//      new credential, so the fingerprint moves and the next sweep probes again. Only the
//      12-char hash is stored, never a value. A MANUAL fetch (fetch_insights / POST
//      /api/insights/fetch) always probes every lane.
//   3. Activity rows only on a STATE CHANGE, one per lane: a new reason, or a recovery
//      ("LinkedIn statistics are back"). The same reason on the next night logs nothing,
//      the same idea as the scheduler's sameStandingSkip de-dupe for a standing skip.
const CIRCUIT_REASONS = new Set(['needs_scope', 'api_disabled', 'token', 'needs_page_role']);
const CIRCUIT_MS = 7 * 24 * 3600 * 1000;

// ---- Offline is not a lane failure ------------------------------------------------------
// The Mac sleeps on battery and wakes for DarkWake windows with no network. A sweep that lands
// in one sees every fetch fail, and used to stamp every lane unavailable ("fetch failed") night
// after night while the summary row read ok. A lane whose failure names a local-network cause
// code (lib/util.mjs OFFLINE_CAUSE_CODES), or a run where EVERY swept lane failed with a bare
// "fetch failed", is OFFLINE: its availability record is left exactly as it was, and
// state.insights.offline { since, at, lanes } asks dailyInsightsSweep to run the sweep again on
// the first tick where the network answers (a HEAD to a lane host), instead of waiting 24h. A
// rerun after a successful probe classifies nothing as offline: the network was proven up, so
// whatever fails then is the lane's own failure. A probe that never answers falls back to the
// plain daily cadence after OFFLINE_RETRY_FALLBACK_MS, so a blocked probe host cannot stop the
// sweep for good.
const OFFLINE_RETRY_FALLBACK_MS = 24 * 3600 * 1000;
const OFFLINE_PROBE_TIMEOUT_MS = 5000;
const LANE_PROBE_URL = {
  meta: 'https://graph.facebook.com/', linkedin: 'https://api.linkedin.com/', youtube: 'https://www.googleapis.com/',
  gbp: 'https://mybusiness.googleapis.com/', pinterest: 'https://api.pinterest.com/', telegram: 'https://api.telegram.org/',
  x: 'https://api.x.com/', reddit: 'https://oauth.reddit.com/',
};

// A lane whose statistics have been unavailable, or offline, for longer than this is STALE:
// the nightly summary row turns ok:false and names it with the date it stopped refreshing, the
// digest says it every morning it lasts, and the Studio Insights page shows it. The per-lane
// activity rows stay once-per-change; this is the one place a standing outage keeps showing.
export const STALE_AFTER_DAYS = 2;
const STALE_AFTER_MS = STALE_AFTER_DAYS * 24 * 3600 * 1000;

// The stale lanes of a state.insights, oldest first: { lane, reason, since } where `since` is
// when the lane stopped refreshing (its unavailable reason's `since`, or the start of the
// offline streak) and reason is the unavailable reason class or 'offline'. Pure.
export function staleLanes(insights, nowMs = Date.now()) {
  const out = new Map();
  for (const [lane, u] of Object.entries(insights?.unavailable || {})) {
    if (!u || u.reason === 'not_configured') continue;
    const since = Date.parse(u.since || u.at || '');
    if (Number.isFinite(since) && nowMs - since > STALE_AFTER_MS) out.set(lane, { lane, reason: u.reason, since: new Date(since).toISOString() });
  }
  const off = insights?.offline;
  const offSince = Date.parse(off?.since || '');
  if (Number.isFinite(offSince) && nowMs - offSince > STALE_AFTER_MS) {
    for (const lane of off.lanes || []) {
      if (!out.has(lane)) out.set(lane, { lane, reason: 'offline', since: new Date(offSince).toISOString() });
    }
  }
  return [...out.values()].sort((a, b) => a.since.localeCompare(b.since) || a.lane.localeCompare(b.lane));
}

// The stale sentence in a locale ("Statistics have not refreshed for more than 2 days:
// LinkedIn since 10 Oct 2026, ...").
function staleSentence(stale, t, loc) {
  const lanes = stale.map((s) => t('digest.stale.lane', { lane: t(LANE_KEYS[s.lane] || s.lane), date: localeDate(s.since, loc) })).join(', ');
  return t('digest.stale', { days: STALE_AFTER_DAYS, lanes });
}

// The lanes of this run that failed because the network was down, not because the lane is
// broken. `failuresByLane` holds each lane's winning { reason, detail }.
function offlineLanes(failuresByLane, sweptLanes, { networkConfirmed = false } = {}) {
  const out = new Set();
  if (networkConfirmed) return out;
  const networkError = (lane) => { const f = failuresByLane.get(lane); return f && f.reason === 'error' ? f : null; };
  for (const lane of sweptLanes) {
    if (offlineCauseCode(networkError(lane)?.detail)) out.add(lane);
  }
  const lanes = [...sweptLanes];
  if (lanes.length && lanes.every((lane) => /\bfetch failed\b/i.test(networkError(lane)?.detail || ''))) {
    for (const lane of lanes) out.add(lane);
  }
  return out;
}

// Does the network answer? Any HTTP response from a host the offline lanes need counts (a 404
// is an answer); a transport failure or the timeout does not. Mock mode never touches the
// network, so it always answers.
async function networkAnswers(lanes = []) {
  if (resolveMode() === 'mock') return true;
  const url = lanes.map((lane) => LANE_PROBE_URL[lane]).find(Boolean) || LANE_PROBE_URL.youtube;
  try {
    await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(OFFLINE_PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}
const LANE_ENV_PREFIX = {
  meta: 'META_', linkedin: 'LINKEDIN_', youtube: 'YT_', gbp: 'GBP_', pinterest: 'PINTEREST_',
  telegram: 'TELEGRAM_', ghost: 'GHOST_', nostr: 'NOSTR_', x: 'X_', reddit: 'REDDIT_', mastodon: 'MASTODON_',
};

// The stored probe says this lane was never set up (no credential at all). Same strings the
// engines' `probe` verbs emit ("not configured (META_PAGE_TOKEN missing)", "not connected
// (credentials missing)"). A failed probe for any other reason (expired, revoked) is NOT
// this: that lane is set up and broken, which is worth one row.
export function laneNotConfigured(health) {
  return Boolean(health) && health.ok === false && /^not (?:configured|connected)\b/i.test(String(health.detail || ''));
}

// Short, one-way fingerprint of a lane's credentials. Identity only, never a value.
function credentialFingerprint(lane) {
  const prefix = LANE_ENV_PREFIX[lane];
  if (!prefix) return null;
  const vars = {};
  for (const line of readEnvRaw().split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1].startsWith(prefix)) vars[m[1]] = m[2].trim();
  }
  const names = vars[`${prefix}REFRESH_TOKEN`]
    ? [`${prefix}REFRESH_TOKEN`]
    : Object.keys(vars).filter((k) => /TOKEN|SECRET|KEY|PASSWORD/.test(k) && !/EXPIRES/.test(k)).sort();
  if (!names.length) return null;
  return crypto.createHash('sha256').update(names.map((k) => `${k}=${vars[k]}`).join('\n')).digest('hex').slice(0, 12);
}

// True while a remembered circuit should keep the AUTOMATIC sweep away from this lane.
function circuitOpen(entry, lane, now) {
  if (!entry || !CIRCUIT_REASONS.has(entry.reason)) return false;
  const at = Date.parse(entry.at || 0) || 0;
  if (now - at >= CIRCUIT_MS) return false;
  return (entry.fp || null) === credentialFingerprint(lane);
}

// A failure's raw text, made safe to persist and show: no bearer tokens, no
// access_token=/key=/secret= values, no long opaque runs (page tokens, JWTs), one line,
// at most 200 chars.
export function sanitizeInsightsDetail(text) {
  return String(text || '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(access_token|refresh_token|client_secret|token|key|secret|password|signature|sig|code)=([^&\s]+)/gi, '$1=[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// The detail a failed row carries: its own message, else the structured degrade.
function rowDetail(r) {
  if (r.errorMessage) return sanitizeInsightsDetail(r.errorMessage);
  if (r.error) return sanitizeInsightsDetail(`${r.error}${r.scope ? ` (${r.scope})` : ''}`);
  return '';
}

// English lane name for the server-side row text (the Studio localizes by lane + code).
const LANE_NAMES = { meta: 'Meta', linkedin: 'LinkedIn', youtube: 'YouTube', gbp: 'Google Business Profile', pinterest: 'Pinterest', telegram: 'Telegram', ghost: 'Ghost', nostr: 'Nostr', x: 'X', reddit: 'Reddit', mastodon: 'Mastodon' };
const laneName = (lane) => LANE_NAMES[lane] || lane;

// The English row text per reason. The token phrasing keeps "not authenticated" so the
// Activity wrench still routes it to Setup; the Studio replaces every one of these with a
// localized sentence (rowNote) and keeps this text for the "?" only.
function laneFailureMessage(lane, reason, detail) {
  const name = laneName(lane);
  const tail = detail ? `: ${detail}` : '';
  if (reason === 'token') return `${name} statistics stopped, not authenticated${tail}`;
  if (reason === 'needs_scope') return `${name} statistics need a permission the app does not have yet${tail}`;
  if (reason === 'api_disabled') return `${name} statistics are off because the API is turned off in Google Cloud${tail}`;
  return `${name} statistics could not refresh${tail}`;
}

// `auto` is true only for the daily sweep: it honors the lane circuits. Every other caller
// (MCP fetch_insights, POST /api/insights/fetch) is the owner asking, so it probes every lane.
// `networkConfirmed` is true only for dailyInsightsSweep's rerun after a successful network
// probe: no failure of that run is read as offline (see "Offline is not a lane failure").
export async function fetchInsights({ campaign = null, includeMetered = [], auto = false, networkConfirmed = false } = {}) {
  if (busy) return errorBody('in_flight', 'an insights sweep is already running', { retryAfter: 60 });
  busy = true;
  try {
    const { campaigns, manifestError } = loadPlanStore();
    if (manifestError) return errorBody('manifest_error', manifestError);
    const now = new Date().toISOString();
    const nowMs = Date.parse(now);
    const results = [];
    // Account-scoped rows (spec 04) collected separately from the per-post rows:
    // they carry scope:'account' and no postId, so the per-post `if (!r.postId)
    // continue` store guard would otherwise drop them. Deduped per lane - an
    // account payload is location-wide, so one spawn covers every campaign.
    const accountResults = [];
    const accountSwept = new Set();
    // Every lane this sweep actually attempted - the honesty record below only
    // touches attempted lanes (a campaign-filtered sweep must not clear or set
    // availability for lanes it never spawned).
    const sweptLanes = new Set();
    // Lanes deliberately not spawned this run, and why ('not_configured' | 'circuit').
    const skipped = new Map();
    const pre = loadState();
    const health = pre.health || {};
    const remembered = pre.insights?.unavailable || {};

    for (const c of campaigns) {
      if (campaign && c.id !== campaign) continue;
      if (!campaign && !c.active) continue;
      const lanes = lanesWithEvidence(c.posts || []);
      if (!lanes.size) continue;
      const planAbs = path.resolve(activeRoot(), c.path);
      // Metered lanes (X) are read only when opted in; a skipped one never spawns and
      // never enters sweptLanes below (so the availability record does not false-alarm).
      for (const lane of sweepableLanes(lanes, includeMetered)) {
        if (laneNotConfigured(health[lane])) { skipped.set(lane, 'not_configured'); continue; }
        if (auto && circuitOpen(remembered[lane], lane, nowMs)) { skipped.set(lane, 'circuit'); continue; }
        sweptLanes.add(lane);
        // Posts a previous sweep found deleted on the platform are not read again.
        const gone = goneKeysFor(pre.insights?.data, c.id, lane);
        const argv = ['insights', '--plan', planAbs, '--json', '--actor', 'pendpost', ...(gone.length ? ['--skip-gone', gone.join(',')] : [])];
        const { err, envelope, stderrTail } = await execScript(resolveEnginePath(lane, ENGINES[lane]), argv, INSIGHTS_TIMEOUT_MS);
        const laneResults = envelope?.results || [];
        for (const r of laneResults) results.push({ campaign: c.id, ...r });
        if (!laneResults.length && (err || envelope?.ok === false)) {
          results.push({
            campaign: c.id, postId: null, platform: lane, action: 'insights', ok: false,
            errorCode: 'engine_failure',
            errorMessage: String(envelope?.error || stderrTail || err?.message || 'engine produced no envelope').slice(0, 300),
          });
        }

        // Generic account pass: a lane that maps an account verb (ACCOUNT_PASS)
        // gets ONE extra spawn per sweep whose payload is stored account-wide. A
        // lane with no mapping falls through untouched (07/08 add entries here).
        const verb = ACCOUNT_PASS[lane];
        if (verb && !accountSwept.has(lane)) {
          accountSwept.add(lane);
          const acc = await execScript(resolveEnginePath(lane, ENGINES[lane]), [verb, '--plan', planAbs, '--json', '--actor', 'pendpost'], INSIGHTS_TIMEOUT_MS);
          const accRows = acc.envelope?.results || [];
          for (const r of accRows) accountResults.push({ lane, ...r });
          if (!accRows.length && (acc.err || acc.envelope?.ok === false)) {
            // needs_scope / engine failure: keep the ok:false row so storage can
            // filter it out (the digest omits, no false alarm). error carries the
            // structured degrade (needs_scope) verbatim when the engine emitted it.
            accountResults.push({
              lane, postId: null, platform: lane, action: verb, ok: false, scope: acc.envelope?.scope || null,
              error: acc.envelope?.error || null,
              errorCode: acc.envelope?.error ? null : 'engine_failure',
              errorMessage: String(acc.envelope?.error || acc.stderrTail || acc.err?.message || 'engine produced no envelope').slice(0, 300),
            });
          }
        }
      }
    }

    // Honesty classification (dim-3 gap 4 + spec 04 SS2): fold every failed row
    // (per-post AND account pass) into ONE reason class per lane, most actionable
    // class first (token > api_disabled > needs_scope > error > not_configured), keeping
    // the winning row's sanitized detail (and Google's activation URL, when it sent one).
    const isGone = postGoneFilter(results);
    const failuresByLane = new Map();
    for (const r of [...results, ...accountResults]) {
      if (r.ok || isGone(r)) continue;
      const lane = r.lane || PLATFORM_LANE[r.platform] || r.platform || 'unknown';
      // A row that names a local-network cause code is a network failure, whatever else its
      // text happens to contain (a host name is not a token problem).
      const cls = offlineCauseCode(`${r.error || ''} ${r.errorMessage || ''}`) ? 'error' : failureClass(r);
      const prev = failuresByLane.get(lane);
      if (!prev || FAILURE_RANK[cls] < FAILURE_RANK[prev.reason]) {
        failuresByLane.set(lane, { reason: cls, detail: rowDetail(r), helpUrl: typeof r.helpUrl === 'string' ? r.helpUrl : null });
      }
    }

    const offline = offlineLanes(failuresByLane, sweptLanes, { networkConfirmed });

    const state = loadState();
    state.insights = state.insights || { data: {} };
    state.insights.data = state.insights.data || {};
    // Account-scoped store (spec 04): a MAP keyed by lane, sibling of .data. Each
    // ok account row's payload (everything past the envelope fields) is MERGED in,
    // so a lane that later gains a SECOND account verb (07 demographics, 08
    // analytics) accumulates rather than clobbers. ok:false rows (needs_scope /
    // failure) are filtered out - the digest/panel then omit, no false alarm.
    state.insights.account = state.insights.account || {};
    for (const r of accountResults) {
      if (!r.ok) continue;
      const { lane, campaign: _c, action: _a, platform: _p, postId: _id, ok: _ok, scope: _s, error: _e, errorCode: _ec, errorMessage: _em, ...payload } = r;
      state.insights.account[lane] = { ...(state.insights.account[lane] || {}), ...payload, fetchedAt: now };
    }
    for (const r of results) {
      // A post deleted on the platform: marked on its own entry (kept metrics, if any, stay
      // as history), skipped by the next sweep, never a lane failure. The plan is untouched.
      if (isGone(r) && r.postId) {
        const key = `${r.campaign}/${r.postId}/${r.platform}`;
        const prev = state.insights.data[key];
        state.insights.data[key] = prev
          ? { ...prev, gone: { at: prev.gone?.at || now } }
          : { campaign: r.campaign, postId: r.postId, platform: r.platform, metrics: {}, fetchedAt: null, history: [], gone: { at: now } };
        continue;
      }
      if (!r.ok) continue;
      // Spec 08: a lane's MAIN per-post `insights` verb can ALSO emit a single
      // account-scoped row instead of (or alongside) per-post ones - telegram's
      // `subscribers` is the one honest number the Bot API has, with no per-post
      // breakdown to report. Route it to the SAME account store the separate
      // ACCOUNT_PASS spawn feeds (spec 04/07), merged so a lane later gaining a
      // second account fact accumulates rather than clobbers. Generic over any
      // lane - not telegram-specific - so a future account-only lane rides this
      // for free with no second mechanism.
      if (r.scope === 'account' && !r.postId) {
        const lane = PLATFORM_LANE[r.platform] || r.platform;
        const { campaign: _c2, action: _a2, platform: _p2, postId: _id2, ok: _ok2, scope: _s2, error: _e2, errorCode: _ec2, errorMessage: _em2, ...payload } = r;
        state.insights.account[lane] = { ...(state.insights.account[lane] || {}), ...payload, fetchedAt: now };
        continue;
      }
      if (!r.postId) continue;
      const key = `${r.campaign}/${r.postId}/${r.platform}`;
      const prev = state.insights.data[key];
      const metrics = r.metrics || {};
      const history = Array.isArray(prev?.history) ? prev.history.slice() : [];
      const last = history[history.length - 1];
      if (!last || !metricsEqual(last.metrics, metrics)) {
        history.push({ fetchedAt: now, metrics });
      }
      state.insights.data[key] = {
        campaign: r.campaign,
        postId: r.postId,
        platform: r.platform,
        metrics,                       // LATEST snapshot - unchanged contract
        fetchedAt: now,                // LATEST timestamp - updates every sweep
        history: history.slice(-HISTORY_CAP),
      };
    }
    // Per-lane availability record (spec 04 SS2): an attempted lane either clears its
    // entry (every row ok) or records WHY its metrics are unavailable ({ reason, at, since,
    // detail, fp }). `since` is when THIS reason first appeared (kept across re-probes), so
    // the digest names a lane once, on change. A lane that is simply not set up carries no
    // record at all (a stale one from before is cleared). Lanes this sweep skipped for a
    // circuit keep their prior record.
    state.insights.unavailable = state.insights.unavailable || {};
    const unavailable = state.insights.unavailable;
    const changes = [];
    for (const [lane, why] of skipped) {
      if (why === 'not_configured' && !sweptLanes.has(lane)) delete unavailable[lane];
    }
    for (const lane of sweptLanes) {
      // Offline: the lane was never reached, so its record says nothing new either way.
      if (offline.has(lane)) continue;
      const prev = unavailable[lane] || null;
      const fail = failuresByLane.get(lane);
      if (!fail || fail.reason === 'not_configured') {
        delete unavailable[lane];
        if (!fail && prev && prev.reason !== 'not_configured') changes.push({ lane, ok: true });
        continue;
      }
      const changed = !prev || prev.reason !== fail.reason;
      unavailable[lane] = {
        reason: fail.reason,
        at: now,
        since: changed ? now : (prev.since || prev.at || now),
        detail: fail.detail || null,
        fp: credentialFingerprint(lane),
        ...(fail.helpUrl ? { helpUrl: fail.helpUrl } : {}),
      };
      if (changed) changes.push({ lane, ok: false, ...fail });
    }
    // The offline record asks the next tick with a working network to sweep again. `since` is
    // the first offline run of an unbroken offline streak.
    if (offline.size) {
      state.insights.offline = { since: state.insights.offline?.since || now, at: now, lanes: [...offline].sort() };
    } else {
      delete state.insights.offline;
    }
    // A run that reached no lane at all measured nothing: "last fetched" keeps its real date.
    const allOffline = sweptLanes.size > 0 && offline.size === sweptLanes.size;
    if (!allOffline) state.insights.lastFetch = now;
    saveState();

    // One row per lane, only when the lane's state CHANGED (see the header above).
    for (const ch of changes) {
      if (ch.ok) {
        appendActivity({
          campaign: campaign || null, postId: null, platform: ch.lane, action: 'insights-fetch', ok: true,
          errorCode: 'insights_recovered', errorMessage: `${laneName(ch.lane)} statistics are back`,
          lateMin: null, actor: 'pendpost',
        });
      } else {
        appendActivity({
          campaign: campaign || null, postId: null, platform: ch.lane, action: 'insights-fetch', ok: false,
          errorCode: ch.reason, errorMessage: laneFailureMessage(ch.lane, ch.reason, ch.detail),
          detail: ch.detail || null, ...(ch.helpUrl ? { helpUrl: ch.helpUrl } : {}),
          lateMin: null, actor: 'pendpost',
        });
      }
    }

    // Account rows join the returned envelope + tally AFTER the .data store loop
    // (postId:null keeps them out of .data): a failed account fetch is counted exactly
    // like a failed per-post row so the caller's tally stays honest.
    for (const r of accountResults) results.push(r);
    const fetched = results.filter((r) => r.ok).length;
    const goneCount = results.filter(isGone).length;
    const failed = results.filter((r) => !r.ok && !isGone(r)).length;
    // The lanes that could not refresh THIS run, one entry each (the Insights page names
    // them instead of flashing "Refreshed"). not_configured never counts as a failure.
    const failedLanes = [...failuresByLane.entries()]
      .filter(([, f]) => f.reason !== 'not_configured')
      .map(([lane, f]) => ({ lane, reason: offline.has(lane) ? 'offline' : f.reason, detail: f.detail || null }));
    // The sweep itself is one summary row. Neutral when every lane is fine (the Activity
    // system group folds successes) or only offline (nothing to fix, the sweep runs again once
    // the network is back). FAILED while a lane has been stale for more than STALE_AFTER_DAYS:
    // a nightly "ok" over a lane that has not refreshed for days is the dishonesty this row
    // must not repeat. Its text is English (digest keys); the Studio localizes it from `lanes`.
    // Lane failures stay their own rows above, logged once per change.
    const offlineList = [...offline].sort();
    const stale = staleLanes(state.insights, nowMs);
    const summary = stale.length
      ? { ok: false, errorCode: 'insights_stale', errorMessage: staleSentence(stale, _enT, 'en'), lanes: stale }
      : offlineList.length
        ? { ok: true, errorCode: 'insights_offline', errorMessage: _enT('digest.offline', { lanes: offlineList.map(laneName).join(', ') }), lanes: offlineList.map((lane) => ({ lane })) }
        : { ok: true, errorCode: null, errorMessage: null };
    appendActivity({
      campaign: campaign || null, postId: null, platform: null, action: 'insights-fetch',
      ...summary, lateMin: null, actor: 'pendpost',
    });
    return {
      ok: true, fetched, failed, gone: goneCount, results, failedLanes, offlineLanes: offlineList, staleLanes: stale,
      skippedLanes: [...skipped.entries()].map(([lane, reason]) => ({ lane, reason })),
      changes: changes.map(({ lane, ok: up, reason }) => ({ lane, ok: up, reason: reason || null })),
    };
  } finally {
    busy = false;
  }
}

export function getInsights() {
  const state = loadState();
  // Enrich each stored metric row with the post's caption snippet + type so the
  // UI can show "Reel - <caption>" instead of a bare plan id (r3). Read-time so
  // existing data is covered with no re-fetch; falls back to ids if the plan
  // store is unreadable. metricLabels travels in the envelope (single source of
  // truth - the client no longer keeps its own duplicate map).
  const postMeta = {};
  try {
    const { campaigns } = loadPlanStore();
    for (const c of campaigns) {
      for (const p of c.posts || []) {
        postMeta[`${c.id}/${p.id}`] = {
          caption: (p.caption || '').split('\n').find((l) => l.trim()) || '',
          postType: p.type || null,
          // postedAt drives the performance-memory by-hour ranking (below); a
          // not-yet-posted row simply carries null and never joins that bucket.
          postedAt: p.postedAt || null,
        };
      }
    }
  } catch { /* plan store unreadable - ids only */ }
  const mode = laneModes();
  const items = Object.values(state.insights?.data || {})
    // A post found deleted before it was ever measured has no numbers to show; listing it
    // would read as a zero-engagement post. A measured-then-deleted one keeps its row.
    .filter((it) => !(it.gone && !(Array.isArray(it.history) && it.history.length)))
    // Each item carries its own resolved mode mapped from its platform via the
    // shared lane map (instagram/facebook -> meta) so a mock row is markable;
    // additive field, existing consumers ignore it.
    .map((it) => ({ ...it, ...(postMeta[`${it.campaign}/${it.postId}`] || {}), mode: mode[PLATFORM_LANE[it.platform]] || null }))
    .sort((a, b) =>
      a.campaign === b.campaign ? String(a.postId).localeCompare(String(b.postId)) : a.campaign.localeCompare(b.campaign),
    );
  // `mode` is an additive top-level per-lane map; `account` is the additive
  // account-scoped store (spec 04) the "Audience & local" panel reads (a map
  // keyed by lane, e.g. account.gbp.performance). `summary` is the additive
  // performance-memory ranking (R8 / dim-3 M2) computed PURELY over the items
  // just enriched - no new fetch - so the "What is working" strip and an MCP
  // agent read the same what-earned-engagement view. lastFetch/items/metricLabels
  // are unchanged so the existing Insights.jsx consumer and tests still pass.
  const summary = performanceSummary(items, { timezone: getPosting().defaultTimezone });
  // `evergreen` (R8 follow-on M1) is the shortlist of aged high-performers worth
  // recycling; `outliers` (M3) is the breakout/slump alert set. Both PURE over
  // the same enriched items - no new fetch - so the Published recycling filter,
  // the digest outlier line, and an MCP agent read one honest view.
  const evergreen = evergreenCandidates(items);
  // `stale` (additive): the lanes that have not refreshed for more than STALE_AFTER_DAYS, so
  // the page names them instead of showing an old figure as current.
  const stale = staleLanes(state.insights);
  return { ok: true, lastFetch: state.insights?.lastFetch || null, items, metricLabels: METRIC_LABELS, mode, account: state.insights?.account || {}, summary, evergreen, outliers: outliers(items), stale };
}

// Scheduler hook: at most one sweep per 24h, piggybacked on the tick.
// `digestBatch` (optional array, the scheduler tick passes one shared by every client):
// the day's digest notification is QUEUED there instead of popped per client, so the
// tick shows ONE notification for all clients (lib/notify.mjs flushDigestBatch).
// `netProbe` (lanes -> Promise<boolean>) answers "does the network work"; tests inject one.
export async function dailyInsightsSweep({ digestBatch = null, netProbe = networkAnswers } = {}) {
  const ins = loadState().insights || {};
  const last = Date.parse(ins.lastFetch || 0) || 0;
  const off = ins.offline || null;
  let networkConfirmed = false;
  if (off && Date.now() - (Date.parse(off.at || 0) || 0) < OFFLINE_RETRY_FALLBACK_MS) {
    // The last sweep ran offline: sweep again on the first tick where the network answers.
    if (!(await netProbe(Array.isArray(off.lanes) ? off.lanes : []))) return null;
    networkConfirmed = true;
  } else if (!off && Date.now() - last < 24 * 3600 * 1000) {
    return null;
  }
  // Free lanes always refresh; a metered lane (X) is included in the AUTOMATIC sweep
  // only when the owner opted it in (posting.insights.meteredAuto, default []). So a
  // fresh install never spends X credits in the background - the owner turns it on
  // deliberately, cost-warned, in the Auswertung settings.
  const meteredAuto = Array.isArray(getPosting().insights?.meteredAuto) ? getPosting().insights.meteredAuto : [];
  const res = await fetchInsights({ includeMetered: meteredAuto, auto: true, networkConfirmed });
  // Offline: no fresh metrics to announce. The rerun, once the network answers, sends the digest.
  if (res?.offlineLanes?.length) return res;
  // Delivery (R2, dim-3 gap 8): the digest used to be pull-only. NOW that the day's
  // metrics have just landed, push ONE notification so the owner knows the fresh digest
  // is ready to read. Gated by posting.digest.notify (default ON) inside notifyDailyDigest,
  // which also stamps the autonomy-report window anchor. Never throws - a notification is
  // a bonus, never a risk to the sweep. Only fires when a real sweep ran (the 24h guard
  // above already returned null otherwise), so the owner is told at most once a day.
  // R8 follow-on (dim-3 M3): the fresh sweep may have produced breakout/slump
  // outliers - pass their counts so the notification names them ("1 breaking out")
  // rather than a generic "digest ready", the day performance moved. getInsights()
  // is a cheap state read (no engine spawn) and already carries the outliers view.
  let outlierSummary = null;
  try { outlierSummary = getInsights().outliers; } catch { /* a bonus, never a risk to the sweep */ }
  // "Nothing new to say" skips the popup (the window anchor still advances): a digest is
  // worth a notification only when a post went out, a policy acted alone, or a post broke
  // out / slumped since the last one. A lane failure is never the notification's job: its
  // Activity row already names the one-step fix.
  let news = true;
  try { news = digestHasNews({ outliers: outlierSummary }); } catch { /* fail open: say it */ }
  const { notifyDailyDigest } = await import('./notify.mjs');
  await notifyDailyDigest({ outliers: outlierSummary, news, collect: digestBatch });
  return res;
}

// Is there anything NEW for the daily digest notification since the last digest went out
// (state.notify.lastDigestAt)? Outliers, a post published, or an autonomous policy action
// (auto-approval / refusal). A pure read of state + plans; never spawns anything.
export function digestHasNews({ outliers = null } = {}) {
  if ((outliers?.breakout?.length || 0) + (outliers?.slump?.length || 0) > 0) return true;
  const state = loadState();
  const since = state.notify?.lastDigestAt ? Date.parse(state.notify.lastDigestAt) : -Infinity;
  const after = (iso) => { const ms = Date.parse(iso || ''); return Number.isFinite(ms) && ms > since; };
  const { campaigns } = loadPlanStore();
  for (const c of campaigns || []) {
    if (!c.active) continue;
    for (const p of c.posts || []) {
      if (after(p.postedAt)) return true;
      if (p.approvalBy === AUTO_APPROVE_ACTOR && after(p.approvalAt)) return true;
    }
  }
  return (state.activity || []).some((a) => a && a.action === 'auto-approve-refused' && after(a.ts));
}

// Reason class for a failed sweep row (dim-3 gap 4): 'needs_scope' is the
// structured P9 degrade (grant still pending), 'api_disabled' is the GCP-project
// class (the API is DISABLED / not configured - the fix is to ENABLE it in the
// Cloud console, NOT to reconnect the account; the YouTube Analytics API being off
// in the project was the live 60s-news case, 2026-09-19), 'token' is the auth class
// (the lane needs a reconnect in Setup - expired/revoked token, missing
// credential), 'error' is everything else (network, 5xx, engine crash). Matched
// over the structured error field AND the message tail, since per-post failure rows
// carry the engine's raw text. api_disabled is checked BEFORE token so its message
// (which can mention the API host) never mis-routes to a pointless reconnect.
// 'not_configured' is a lane that was never set up (a credential var missing from .env, a
// probe's "not configured (...)"): there is nothing to fix inside pendpost's reach, Setup
// already shows the lane as incomplete, so the sweep skips it silently. It is checked
// BEFORE token, because "META_PAGE_TOKEN missing" contains the word token and used to read
// "not authenticated" every night on a project that simply has no Meta lane.
const FAILURE_RANK = { token: 0, api_disabled: 1, needs_scope: 2, needs_page_role: 2.5, error: 3, not_configured: 4 };

// `post_gone` rows (an engine read a post the platform no longer has, e.g. Meta #100 "does
// not exist") are per-post facts, not lane failures. Except when EVERY row a lane returned
// for a campaign is post_gone (two or more, none ok): Meta words a missing permission with
// the same #100 text, and reading that as "everything was deleted" would skip every post
// forever. Such rows stay ordinary failures (reason 'error'). Returns a row predicate.
function postGoneFilter(results) {
  const groups = new Map();
  for (const r of results) {
    if (!r.postId) continue;
    const k = `${r.campaign}|${PLATFORM_LANE[r.platform] || r.platform}`;
    const g = groups.get(k) || { ok: 0, gone: 0 };
    if (r.ok) g.ok += 1; else if (r.error === 'post_gone') g.gone += 1;
    groups.set(k, g);
  }
  return (r) => {
    if (!r || r.ok || r.error !== 'post_gone' || !r.postId) return false;
    const g = groups.get(`${r.campaign}|${PLATFORM_LANE[r.platform] || r.platform}`);
    return !(g && g.ok === 0 && g.gone >= 2);
  };
}

// `postId/platform` for every post of this campaign + lane a previous sweep marked gone.
function goneKeysFor(data, campaignId, lane) {
  const out = [];
  for (const d of Object.values(data || {})) {
    if (!d || !d.gone || d.campaign !== campaignId) continue;
    if ((PLATFORM_LANE[d.platform] || d.platform) !== lane) continue;
    out.push(`${d.postId}/${d.platform}`);
  }
  return out;
}
function failureClass(r) {
  const msg = `${r.error || ''} ${r.errorMessage || ''}`;
  if (/api_disabled|accessNotConfigured|SERVICE_DISABLED|has not been used in project|it is disabled/i.test(msg)) return 'api_disabled';
  if (/needs_page_role/.test(msg)) return 'needs_page_role';
  if (/needs_scope/i.test(msg)) return 'needs_scope';
  if (r.errorCode === 'not_configured' || /not[_ ]configured|missing in \.env|\b[A-Z][A-Z0-9_]{2,} (?:is |are )?missing\b|\bare not set\b|credentials missing/.test(msg)) return 'not_configured';
  if (/token|not authenticated|not authorized|unauthorized|\b401\b|invalid_grant|expired|not connected|credential/i.test(msg)) return 'token';
  return 'error';
}
// Test-only export (spec-15 follow-on): the pure reason classifier, so a unit test
// can prove an api_disabled row reads 'api_disabled' (e.g. "youtube api_disabled"
// in the activity_log summary), not 'needs_scope'.
export { failureClass };

const HISTORY_CAP = 30;
function metricsEqual(a, b) {
  const ka = Object.keys(a || {});
  const kb = Object.keys(b || {});
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

// Raw metric/platform/lane keys -> locale-pack key (lib/i18n.mjs). The label
// itself is resolved per-locale via t(); an unknown raw key falls back to t(key)
// which returns the key verbatim (makeT's raw-key fallback), preserving the old
// `LABEL[k] || k` behavior. Platform/lane names are brand identity (same bytes
// in every locale) but still flow through t() so there is one resolution path.
const METRIC_KEYS = {
  views: 'metric.views', plays: 'metric.plays', reach: 'metric.reach', impressions: 'metric.impressions',
  likes: 'metric.likes', comments: 'metric.comments', shares: 'metric.shares', saved: 'metric.saved',
  clicks: 'metric.clicks', total_interactions: 'metric.total_interactions', blue_reels_play_count: 'metric.blue_reels_play_count',
  post_impressions_unique: 'metric.post_impressions_unique', total_video_views: 'metric.total_video_views',
  // IL-1: gbp's per-post `insights` verb returns { views, ctaClicks } alongside the
  // generic views above - the CTA-button click count on that local-post's publish
  // row (mock-driver.mjs metricsFor('gbp', ...)). Was previously unregistered, so
  // it rendered as the raw camelCase key next to a localized "Views".
  ctaClicks: 'metric.ctaClicks',
  // GBP local-intent scalars (spec 04, account-scoped performance).
  calls: 'metric.calls', websiteClicks: 'metric.websiteClicks', directions: 'metric.directions',
  bookings: 'metric.bookings', conversations: 'metric.conversations',
  // Richer analytics (spec 08, Pattern P5): new scalar keys on already-swept
  // lanes (linkedin reach/engagement - reach/clicks already existed above) +
  // the newly-real lanes' metrics (telegram account-scoped subscribers, ghost
  // email opens/sends + link clicks, nostr reaction/zap-receipt counts, and
  // youtube's supplementary watch-time time-series). Pinterest's per-pin
  // analytics verb (spec 07) requests these exact metric_types - registering
  // them here is the only thing missing for its chips to render.
  engagement: 'metric.engagement', subscribers: 'metric.subscribers',
  opened: 'metric.opened', sent: 'metric.sent',
  // Spec 20 (nostr zaps): zaps/reactions were registered by spec 08; zapSats (the
  // summed value in sats from NIP-57 receipts) is the value-for-value revenue scalar.
  reactions: 'metric.reactions', zaps: 'metric.zaps', zapSats: 'metric.zapSats',
  watchTimeMin: 'metric.watchTimeMin', avgViewSec: 'metric.avgViewSec',
  // R3 (ux-audit 2026-08-04): the newly-swept lanes' metric keys. X's
  // impressions/likes/comments/shares were already registered above; bookmarks
  // is its one new key. Reddit's upvote_ratio is a RATE (0-1 decimal, like
  // linkedin engagement) - meaningful per-post, never summed across posts.
  bookmarks: 'metric.bookmarks',
  score: 'metric.score', num_comments: 'metric.num_comments', upvote_ratio: 'metric.upvote_ratio',
  favourites: 'metric.favourites', reblogs: 'metric.reblogs', replies: 'metric.replies',
  IMPRESSION: 'metric.impression', PIN_CLICK: 'metric.pinClick', SAVE: 'metric.save', OUTBOUND_CLICK: 'metric.outboundClicks',
};
const PLATFORM_KEYS = { facebook: 'platform.facebook', instagram: 'platform.instagram', linkedin: 'platform.linkedin', youtube: 'platform.youtube', gbp: 'platform.gbp', pinterest: 'platform.pinterest', telegram: 'platform.telegram', ghost: 'platform.ghost', nostr: 'platform.nostr', x: 'platform.x', reddit: 'platform.reddit', mastodon: 'platform.mastodon' };
const LANE_KEYS = { meta: 'lane.meta', linkedin: 'lane.linkedin', youtube: 'lane.youtube', gbp: 'lane.gbp', pinterest: 'lane.pinterest', telegram: 'lane.telegram', ghost: 'lane.ghost', nostr: 'lane.nostr', x: 'lane.x', reddit: 'lane.reddit', mastodon: 'lane.mastodon' };
// Unavailability reason class -> its digest words (anything else reads "fetch failed").
const UNAVAILABLE_REASON_KEYS = {
  needs_scope: 'digest.unavailable.needsScope',
  api_disabled: 'digest.unavailable.apiDisabled',
  token: 'digest.unavailable.token',
  not_configured: 'digest.unavailable.notConfigured',
};
// Demographics sub-map (spec 07) -> its digest/panel category label. city/country/
// region are all geographic breakdowns, so they share one label (demographics.geo) -
// the raw bucket key (a city/country name or a urn tail) is the thing that varies.
const DEMOGRAPHIC_CATEGORY_KEYS = {
  age: 'demographics.age', gender: 'demographics.gender',
  country: 'demographics.geo', city: 'demographics.geo', region: 'demographics.geo',
  seniority: 'demographics.seniority', function: 'demographics.function', industry: 'demographics.industry',
};
// Because country/city/region share one label, the digest groups them under a
// single "Top locations" line instead of repeating it (AU-1); GEO_RANK orders the
// buckets country -> city -> region within it, mirroring the demographics panel.
const GEO_RANK = { country: 0, city: 1, region: 2 };
// Display-only humanizer for a demographics bucket key (AU-2): an all-lowercase
// token or hyphen/underscore slug becomes Title Case words (female -> Female,
// north-america -> North America). Tokens carrying a digit or any uppercase (age
// ranges like 25-34, ISO country codes like US) are returned untouched so they are
// never corrupted. Purely cosmetic - the underlying data key is never mutated.
function humanizeBucket(key) {
  if (typeof key !== 'string' || !/^[a-z][a-z_-]*$/.test(key)) return key;
  return key.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
// English label map kept in the getInsights() envelope for backward compatibility
// (a stable, LOCALE-INDEPENDENT reference so the REST/MCP face stays byte-stable -
// the SPA localizes display via t('metric.<k>')). Derived from the en pack so the
// locale pack remains the single source of truth.
const _enT = makeT('en');
const METRIC_LABELS = Object.fromEntries(Object.entries(METRIC_KEYS).map(([k, key]) => [k, _enT(key)]));

function fmtMetrics(metrics, t) {
  const parts = [];
  for (const [k, v] of Object.entries(metrics || {})) {
    if (typeof v !== 'number') continue;
    parts.push(`${t(METRIC_KEYS[k] || k)} ${v}`);
  }
  return parts.length ? parts.join(' · ') : t('digest.metrics.noMetrics');
}

// English markdown digest: published performance + queue health + next due.
// Honest by construction - only stored metrics appear, gaps are named.
export function generateDigest({ locale } = {}) {
  const { campaigns, manifestError } = loadPlanStore();
  if (manifestError) return errorBody('manifest_error', manifestError);
  const state = loadState();
  // Same rule as getInsights: a post found deleted before it was ever measured has no
  // numbers (and no fetchedAt), so it is left out rather than shown as an empty row.
  const insights = Object.fromEntries(Object.entries(state.insights?.data || {})
    .filter(([, e]) => !(e && e.gone && !(Array.isArray(e.history) && e.history.length))));
  const now = Date.now();
  const lines = [];

  // Locale: the explicit arg (tests/API) else the active client's config.locale,
  // default en. makeT falls back to English for any key a partial pack omits, and
  // dates are formatted with the same tag (de-CH -> Swiss formatting).
  const loc = locale || getPosting().locale || 'en';
  const t = makeT(loc);

  lines.push(`# ${t('digest.title')} · ${localeDate(now, loc, { dateStyle: 'medium' })}`);
  lines.push('');

  // Honesty line (A6): name any lane running in mock so the numbers below read
  // as fabricated by the mock driver, not real platform data. Same resolveMode
  // derivation as getInsights() / account_status; a plain mock|live string.
  const mode = laneModes();
  const mockLanes = LANES.filter((lane) => mode[lane] === 'mock').map((lane) => t(LANE_KEYS[lane]));
  if (mockLanes.length) {
    lines.push(t(mockLanes.length === 1 ? 'digest.mock.one' : 'digest.mock.many', { lanes: mockLanes.join(', ') }));
    lines.push('');
  }

  // Unavailability line (spec 04 SS2): ONE line naming every lane whose metrics
  // the last sweep could not fetch and why - needs_scope reads as a pending
  // grant, every other class (token/error) as a failed fetch. Reads the per-lane
  // record fetchInsights() maintains; no record, no line (never a false alarm).
  // Each reason keeps its own words (a disabled Google API is not a "fetch failed"), and a
  // lane is named once, on change: only when its reason appeared after the previous digest
  // went out (state.notify.prevDigestAt, stamped by notifyDailyDigest). A lane that stays
  // unavailable for weeks is not repeated every morning; its Activity row carries the fix.
  // A STALE lane (more than STALE_AFTER_DAYS) is the exception: it is named every morning, with
  // the date it stopped refreshing, on its own line (and so left out of the once line).
  const unavailable = state.insights?.unavailable || {};
  const prevDigest = state.notify?.prevDigestAt ? Date.parse(state.notify.prevDigestAt) : -Infinity;
  const stale = staleLanes(state.insights, now);
  const staleSet = new Set(stale.map((s) => s.lane));
  const unavailableLanes = LANES.filter((lane) => {
    const u = unavailable[lane];
    if (!u || u.reason === 'not_configured' || staleSet.has(lane)) return false;
    const since = Date.parse(u.since || u.at || '');
    return !(Number.isFinite(since) && since <= prevDigest);
  });
  if (unavailableLanes.length) {
    const parts = unavailableLanes.map((lane) =>
      `${t(LANE_KEYS[lane] || lane)} (${t(UNAVAILABLE_REASON_KEYS[unavailable[lane].reason] || 'digest.unavailable.failed')})`);
    lines.push(t('digest.unavailable', { lanes: parts.join(', ') }));
    lines.push('');
  }
  if (stale.length) {
    lines.push(`> ${staleSentence(stale, t, loc)}`);
    lines.push('');
  }

  const active = campaigns.filter((c) => c.active);
  const posts = active.flatMap((c) => c.posts || []);
  const posted = posts.filter((p) => p.derivedState === 'posted' || p.derivedState === 'fired-assumed');
  const recent = posted.filter((p) => p.postedAt && now - Date.parse(p.postedAt) < 7 * 24 * 3600 * 1000);

  // ===== Autonomy report (R2, dim-5 AU3): what the policies did ALONE since the last
  // digest. LEADS the published/pipeline detail (review by exception). Windowed by
  // state.notify.lastDigestAt (the delivery anchor notifyDailyDigest stamps); no anchor
  // means "everything so far". Skipped WHOLESALE when nothing autonomous happened, so a
  // hands-on project's digest is byte-unchanged.
  const windowStart = state.notify?.lastDigestAt ? Date.parse(state.notify.lastDigestAt) : -Infinity;
  const inWindow = (ms) => Number.isFinite(ms) && ms > windowStart;
  // Auto-approved posts: blessed by the owner's policy actor (never the drafting agent).
  // A Radar reply is the distinct act of posting into a STRANGER's thread and is counted
  // on its own line below, so it is excluded here to avoid double-counting. Windowed by
  // the approval moment - the policy acting is the reportable event.
  const autoApprovedPosts = posts.filter((p) => !p.radarReplyTo && p.approvalBy === AUTO_APPROVE_ACTOR && inWindow(Date.parse(p.approvalAt)));
  // Auto-posted Radar replies: a policy-approved reply that actually went out. Windowed by
  // the POST moment - a reply landing on the external thread is what the owner needs told.
  const autoPostedReplies = posts.filter((p) => p.radarReplyTo && p.approvalBy === AUTO_APPROVE_ACTOR && p.postedAt && inWindow(Date.parse(p.postedAt)));
  // Refusals: rows the auto-approve seams append when the policy WOULD have fired but a
  // content gate held the post back (createPost brand-lint, queueRadarReply foreign-link/
  // lint). Grouped by reason class so the parenthetical teaches, not just counts.
  const refusals = (state.activity || []).filter((a) => a && a.action === 'auto-approve-refused' && inWindow(Date.parse(a.ts)));
  if (autoApprovedPosts.length || autoPostedReplies.length || refusals.length) {
    lines.push(t('digest.autonomy.header'));
    if (autoApprovedPosts.length) {
      lines.push(t(autoApprovedPosts.length === 1 ? 'digest.autonomy.approved.one' : 'digest.autonomy.approved.many', { n: autoApprovedPosts.length }));
    }
    if (autoPostedReplies.length) lines.push(t('digest.autonomy.replies', { n: autoPostedReplies.length }));
    if (refusals.length) {
      // Stable class order so the line reads identically each run; unknown reasons fold
      // into 'other' rather than leaking a raw internal token into the digest.
      const REASON_ORDER = ['foreign_link', 'lint'];
      const counts = new Map();
      for (const r of refusals) {
        const cls = REASON_ORDER.includes(r.reason) ? r.reason : 'other';
        counts.set(cls, (counts.get(cls) || 0) + 1);
      }
      const classes = [...REASON_ORDER, 'other']
        .filter((c) => counts.has(c))
        .map((c) => `${counts.get(c)} ${t(`digest.autonomy.reason.${c}`)}`)
        .join(', ');
      lines.push(t('digest.autonomy.held', { n: refusals.length, classes }));
    }
    lines.push('');
  }

  lines.push(t('digest.published.header'));
  if (!recent.length) {
    lines.push(t('digest.published.none'));
  } else {
    for (const p of recent) {
      lines.push(`- ${p.id} (${p.campaign}) · ${localeDate(Date.parse(p.postedAt), loc)}`);
      for (const platform of p.platforms) {
        const entry = insights[`${p.campaign}/${p.id}/${platform}`];
        lines.push(`  - ${t(PLATFORM_KEYS[platform] || platform)}: ${entry ? fmtMetrics(entry.metrics, t) : t('digest.metrics.none')}`);
      }
    }
  }
  lines.push('');

  const withMetrics = Object.values(insights);
  if (withMetrics.length) {
    lines.push(t('digest.measured.header'));
    for (const e of withMetrics) {
      lines.push(`- ${e.postId} (${e.campaign}) · ${t(PLATFORM_KEYS[e.platform] || e.platform)}: ${fmtMetrics(e.metrics, t)} _(${t('digest.measured.asOf', { date: localeDate(e.fetchedAt, loc) })})_`);
    }
    lines.push('');
  }

  // Breakout / slump outliers (R8 follow-on, dim-3 M3): name the posts that beat
  // or badly missed their lane+format baseline, so a busy owner acts on
  // performance the day the digest lands. Reuses the SAME outliers() detector the
  // envelope + notification ride; enriched here with each post's type + caption
  // snippet from the plan store (the raw stored metric rows carry neither).
  // Conditional - a run with no clear outlier adds nothing (never cries wolf).
  const outlierMeta = {};
  for (const c of campaigns) {
    for (const p of c.posts || []) {
      outlierMeta[`${c.id}/${p.id}`] = {
        postType: p.type || null,
        caption: (p.caption || '').split('\n').find((l) => l.trim()) || '',
      };
    }
  }
  const enrichedForOutliers = Object.values(insights).map((it) => ({ ...it, ...(outlierMeta[`${it.campaign}/${it.postId}`] || {}) }));
  const { breakout, slump } = outliers(enrichedForOutliers, { now });
  if (breakout.length || slump.length) {
    lines.push(t('digest.outliers.header'));
    const label = (o) => (o.caption ? `${o.postId} - ${o.caption}` : o.postId);
    for (const o of breakout) {
      lines.push(t('digest.outliers.breakout', { post: label(o), lane: t(LANE_KEYS[o.lane] || o.lane), mult: o.ratio, baseline: o.baseline }));
    }
    for (const o of slump) {
      lines.push(t('digest.outliers.slump', { post: label(o), lane: t(LANE_KEYS[o.lane] || o.lane), baseline: o.baseline }));
    }
    lines.push('');
  }

  // Local performance (spec 04): the account-scoped GBP metrics, rendered from the
  // stored account payload only (honest by construction). Empty window -> zeros
  // shown (never hidden); an error/needs_scope row was filtered out of the store,
  // so the section simply omits (no false alarm). Generic over lane keys -> the
  // metric label resolves via the same METRIC_KEYS map the per-post rows use.
  const gbpPerf = state.insights?.account?.gbp?.performance;
  if (gbpPerf) {
    lines.push(t('digest.local.header'));
    for (const k of ['calls', 'websiteClicks', 'directions', 'bookings', 'conversations', 'impressions']) {
      lines.push(`- ${t(METRIC_KEYS[k] || k)}: ${Number(gbpPerf[k] || 0)}`);
    }
    const kws = Array.isArray(gbpPerf.searchKeywords) ? gbpPerf.searchKeywords : [];
    if (kws.length) {
      lines.push(`- ${t('digest.local.searchKeywords')}: ${kws.map((w) => `${w.keyword} (${Number(w.count || 0)})`).join(', ')}`);
    }
    lines.push('');
  }

  // Audience demographics (spec 07, Pattern P5 structured set): one lane row per
  // account.<lane>.demographics, top-3 buckets per category (age/gender/geo/
  // seniority/...). Honest by construction - an empty demographics:{} (below the
  // platform's follower threshold) or a filtered-out needs_scope/error row simply
  // omits that lane, never a fabricated zero bar.
  const audienceLanes = LANES.filter((lane) => {
    const demo = state.insights?.account?.[lane]?.demographics;
    return demo && Object.values(demo).some((buckets) => buckets && Object.keys(buckets).length);
  });
  if (audienceLanes.length) {
    lines.push(t('digest.audience.header'));
    for (const lane of audienceLanes) {
      lines.push(`- ${t(LANE_KEYS[lane] || lane)}`);
      const demo = state.insights.account[lane].demographics;
      // Group the sub-maps by their resolved category label so the geographic
      // buckets (country/city/region) collapse under ONE "Top locations:" line
      // (AU-1) instead of repeating it - the SAME dedupe the demographics panel
      // applies. First-seen label order preserved; country -> city -> region within.
      const groups = [];
      const byLabel = new Map();
      for (const [category, buckets] of Object.entries(demo)) {
        const labelKey = DEMOGRAPHIC_CATEGORY_KEYS[category] || category;
        let group = byLabel.get(labelKey);
        if (!group) { group = { labelKey, cats: [] }; byLabel.set(labelKey, group); groups.push(group); }
        group.cats.push([category, buckets]);
      }
      for (const { labelKey, cats } of groups) {
        const top = [...cats]
          .sort((a, b) => (GEO_RANK[a[0]] ?? 0) - (GEO_RANK[b[0]] ?? 0))
          .flatMap(([, buckets]) => Object.entries(buckets || {}).sort((a, b) => b[1] - a[1]).slice(0, 3));
        if (!top.length) continue;
        lines.push(`  - ${t(labelKey)}: ${top.map(([k, v]) => `${humanizeBucket(k)} (${Number(v)})`).join(', ')}`);
      }
    }
    lines.push('');
  }

  // Radar (beta) section (spec 35): the top-N new high-intent signals + the comparison-
  // page backlog, rendered through THIS digest (no parallel artifact). GUARDED by
  // posting.radar.enabled - an off project pushes NOTHING, so its digest is byte-unchanged
  // (radarDigestLines also returns [] when the feed/backlog are empty). getPosting() is
  // cached-cheap; reading it again here keeps the guard local to the section.
  if (getPosting().radar?.enabled === true) {
    // Spec 44: the count of posted replies whose thread author replied back - read off the
    // reply posts' radarReplyState (the single source of truth), computed from the campaigns
    // already loaded above. Passed IN so radarDigestLines stays a pure function of its inputs.
    let authorRepliedCount = 0;
    for (const c of campaigns || []) for (const p of c.posts || []) if (p && p.radarReplyState === 'author_replied') authorRepliedCount += 1;
    for (const line of radarDigestLines(state.radar, t, { authorRepliedCount, now, queries: getPosting().radar?.queries || [] })) lines.push(line);
  }

  // ---- SPEC 50 P3 BLOCK: the "Respond for me" block (§S8) -----------------------------------
  // Guarded by the mode, not by posting.radar.enabled: engage has its own switch, and an off
  // client's digest stays byte-unchanged because engageDigestLines returns [] for mode 'off'.
  // Every figure it prints comes from state.engage.counters, the open asks, the cooling-down
  // lanes and the SAME authorRepliedCount computed above - there is no follower or reach number
  // in the block, by construction (see the module header).
  try {
    const posting = getPosting();
    const enginePolicyForDigest = (posting.radar && posting.radar.engage) || {};
    if (enginePolicyForDigest.mode && enginePolicyForDigest.mode !== 'off') {
      // Spec 44 again, this time windowed to 7 days to match the block's own "Last 7 days" line
      // (the radar section above counts the lifetime figure).
      const weekAgo = now - 7 * 24 * 3600 * 1000;
      let answered7 = 0;
      for (const c of campaigns || []) {
        for (const p of c.posts || []) {
          if (!p || p.radarReplyState !== 'author_replied') continue;
          const at = Date.parse((p.radarFollowup && p.radarFollowup.ts) || p.postedAt || '') || 0;
          if (at >= weekAgo) answered7 += 1;
        }
      }
      const engage = state.engage && typeof state.engage === 'object' ? state.engage : {};
      for (const line of engageDigestLines(engage, enginePolicyForDigest, t, {
        now,
        // posting.defaultTimezone, not radarTimezone(): that resolver lives in lib/radar-sweep.mjs
        // and reads the client registry, and generateDigest is SYNCHRONOUS, so it cannot be
        // imported here without pulling the sweep's whole graph into the digest path. The
        // registry entry and defaultTimezone agree for every single-client workspace, and a
        // disagreement can only shift the day boundary of the "Today" line by hours, never
        // invent a number.
        tz: (posting.defaultTimezone && String(posting.defaultTimezone)) || 'UTC',
        authorRepliedCount: answered7,
        clientName: boundClientId() || '',
        telegramChatId: (posting.notify && posting.notify.telegramChatId) || '',
      })) lines.push(line);
    }
  } catch { /* the engage block is additive - a failure here never breaks the digest */ }
  // ---- end SPEC 50 P3 BLOCK -----------------------------------------------------------------

  // Queue = still needs an approval decision. An edited-since-approval post is
  // approval:'approved' but the scheduler refuses it until re-approval, so it is
  // open work - same definition the approvals queue uses (app Freigaben isActionable).
  const queue = posts.filter((p) => (p.approval !== 'approved' || p.editedSinceApproval) && p.derivedState !== 'posted');
  // Late = due time passed, still not published, whatever the approval state (a post
  // nobody approved in time HAS missed its slot). Mirrors the app's at-risk alarm
  // (App.jsx overdueCount / format.js isLate); radar replies are exempt upstream in
  // deriveState, so a pending reply never inflates this.
  // 'publish-failed' is late too, just with a recorded reason (lib/plans.mjs) - counting
  // only 'overdue' would quietly shrink this the moment a failure gets its own state.
  const overdue = posts.filter((p) => p.derivedState === 'overdue' || p.derivedState === 'publish-failed');
  const upcoming = posts
    .filter((p) => p.scheduledAt && Date.parse(p.scheduledAt) > now && p.derivedState !== 'posted' && p.derivedState !== 'parked')
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))
    .slice(0, 5);

  lines.push(t('digest.pipeline.header'));
  lines.push(t(queue.length === 1 ? 'digest.pipeline.queue.one' : 'digest.pipeline.queue.many', { n: queue.length }));
  lines.push(t('digest.pipeline.overdue', { n: overdue.length }));
  lines.push(t('digest.pipeline.scheduler', { state: t(state.scheduler?.enabled ? 'digest.scheduler.active' : 'digest.scheduler.inactive') }));
  const accounts = accountStatus();
  const accountIssues = [];
  if (!accounts.meta?.configured) accountIssues.push(t('digest.account.metaNotConfigured'));
  if (!accounts.linkedin?.authenticated) accountIssues.push(t('digest.account.linkedinNotConnected'));
  if (!accounts.youtube?.authenticated) accountIssues.push(t('digest.account.youtubeNotConnected'));
  if (accountIssues.length) lines.push(t('digest.pipeline.accounts', { issues: accountIssues.join(', ') }));
  // Calendar gap (R2, dim-3): a lane that PUBLISHED in the last 30 days but has NO approved
  // post scheduled in the next 7 - a channel silently lapsing. An edited-since-approval post
  // does NOT cover the lane (the scheduler refuses it until re-approval, same rule the queue
  // uses), and a lane that never published recently is never named (no false alarm). Ordered
  // by the platform-label map so the line reads the same each run.
  const DAY_MS = 24 * 3600 * 1000;
  const publishedRecently = new Set();
  const coveredNext7 = new Set();
  for (const p of posts) {
    if (p.postedAt && now - Date.parse(p.postedAt) <= 30 * DAY_MS) {
      for (const l of (p.platforms || [])) publishedRecently.add(l);
    }
    if (p.approval === 'approved' && !p.editedSinceApproval && p.scheduledAt) {
      const at = Date.parse(p.scheduledAt);
      if (at > now && at <= now + 7 * DAY_MS) for (const l of (p.platforms || [])) coveredNext7.add(l);
    }
  }
  const gapLanes = Object.keys(PLATFORM_KEYS).filter((l) => publishedRecently.has(l) && !coveredNext7.has(l));
  if (gapLanes.length) {
    lines.push(t('digest.calendar.gap', { lanes: gapLanes.map((l) => t(PLATFORM_KEYS[l] || l)).join(', ') }));
  }
  if (upcoming.length) {
    lines.push('');
    lines.push(t('digest.upcoming.header'));
    for (const p of upcoming) {
      lines.push(`- ${localeDateTime(Date.parse(p.scheduledAt), loc)} · ${p.id} (${p.campaign}) · ${p.platforms.join(', ')}${p.approval !== 'approved' ? t('digest.upcoming.notApproved') : ''}`);
    }
  }
  lines.push('');
  lines.push(t('digest.lastFetched', { when: state.insights?.lastFetch ? localeDateTime(state.insights.lastFetch, loc) : t('digest.never') }));

  // `mode` is an additive per-lane map mirroring getInsights().mode; `account` is
  // the additive account-scoped store (spec 04) mirroring getInsights().account;
  // digest/generatedAt are unchanged so the generate_digest twin stays compatible.
  return { ok: true, digest: lines.join('\n'), generatedAt: new Date(now).toISOString(), mode, account: state.insights?.account || {}, locale: loc };
}
