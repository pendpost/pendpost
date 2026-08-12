// insights.mjs - Phase E metrics + digest.
//
// The engines' read-only `insights` commands fetch platform metrics and
// report them ONLY through their --json envelope; this module spawns them,
// stores the results in state.json (state.insights), and renders the digest.
// Plan files never carry metrics - they are git-tracked content,
// metrics churn daily.
import path from 'node:path';
import { errorBody } from './util.mjs';
import { activeRoot } from './context.mjs';
import { loadPlanStore } from './plans.mjs';
import { loadState, saveState } from './state.mjs';
import { execScript } from './writes.mjs';
import { appendActivity } from './scheduler.mjs';
import { accountStatus } from './accounts.mjs';
import { resolveEnginePath, resolveMode } from './mode.mjs';
import { getPosting } from './config.mjs';
import { AUTO_APPROVE_ACTOR } from './auto-approve.mjs';
import { radarDigestLines } from './radar.mjs';
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
    if (p.ids.igMediaId || p.ids.fbReelId) lanes.add('meta');
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

export async function fetchInsights({ campaign = null } = {}) {
  if (busy) return errorBody('in_flight', 'an insights sweep is already running', { retryAfter: 60 });
  busy = true;
  try {
    const { campaigns, manifestError } = loadPlanStore();
    if (manifestError) return errorBody('manifest_error', manifestError);
    const now = new Date().toISOString();
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

    for (const c of campaigns) {
      if (campaign && c.id !== campaign) continue;
      if (!campaign && !c.active) continue;
      const lanes = lanesWithEvidence(c.posts || []);
      if (!lanes.size) continue;
      const planAbs = path.resolve(activeRoot(), c.path);
      for (const lane of lanes) {
        sweptLanes.add(lane);
        const { err, envelope, stderrTail } = await execScript(resolveEnginePath(lane, ENGINES[lane]), ['insights', '--plan', planAbs, '--json', '--actor', 'pendpost'], INSIGHTS_TIMEOUT_MS);
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
    // class first (token > needs_scope > error). Drives the activity summary and
    // the persisted per-lane availability record the digest names lanes from.
    const failuresByLane = new Map();
    for (const r of [...results, ...accountResults]) {
      if (r.ok) continue;
      const lane = r.lane || PLATFORM_LANE[r.platform] || r.platform || 'unknown';
      const cls = failureClass(r);
      const prev = failuresByLane.get(lane);
      if (!prev || FAILURE_RANK[cls] < FAILURE_RANK[prev]) failuresByLane.set(lane, cls);
    }

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
    // Per-lane availability record (spec 04 SS2): an attempted lane either clears
    // its entry (every row ok) or records WHY its metrics are unavailable
    // ({ reason: token|needs_scope|error, at }). Lanes this sweep never attempted
    // keep their prior record. generateDigest() names these lanes in one line.
    state.insights.unavailable = state.insights.unavailable || {};
    for (const lane of sweptLanes) delete state.insights.unavailable[lane];
    for (const [lane, reason] of failuresByLane) state.insights.unavailable[lane] = { reason, at: now };
    state.insights.lastFetch = now;
    saveState();

    // Account rows join the returned envelope + tally AFTER the .data store loop
    // (postId:null keeps them out of .data): a failed account fetch is recorded
    // exactly like a failed per-post row so the Activity summary stays honest.
    for (const r of accountResults) results.push(r);
    const fetched = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    // ok:false whenever ANY lane failed (dim-3 gap 4): a partial failure must
    // surface outside the Activity System success fold, and the summary names
    // each failed lane + its reason class. The token phrasing deliberately says
    // "not authenticated" so the existing Activity wrench (resolveRemediation)
    // routes it to Setup. A fully-successful sweep stays green and folded.
    const failedLanes = [...failuresByLane.entries()]
      .map(([lane, cls]) => (cls === 'token' ? `${lane} not authenticated (token)` : `${lane} ${cls}`));
    appendActivity({
      campaign: campaign || null, postId: null, platform: null, action: 'insights-fetch',
      ok: failed === 0,
      errorCode: failed ? 'engine_failure' : null,
      errorMessage: failed ? `${failed} fetch(es) failed: ${failedLanes.join(', ')}` : null,
      lateMin: null, actor: 'pendpost',
    });
    return { ok: true, fetched, failed, results };
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
  return { ok: true, lastFetch: state.insights?.lastFetch || null, items, metricLabels: METRIC_LABELS, mode, account: state.insights?.account || {}, summary, evergreen, outliers: outliers(items) };
}

// Scheduler hook: at most one sweep per 24h, piggybacked on the tick.
export async function dailyInsightsSweep() {
  const last = Date.parse(loadState().insights?.lastFetch || 0) || 0;
  if (Date.now() - last < 24 * 3600 * 1000) return null;
  const res = await fetchInsights();
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
  const { notifyDailyDigest } = await import('./notify.mjs');
  await notifyDailyDigest({ outliers: outlierSummary });
  return res;
}

// Reason class for a failed sweep row (dim-3 gap 4): 'needs_scope' is the
// structured P9 degrade (grant still pending), 'token' is the auth class (the
// lane needs a reconnect in Setup - expired/revoked token, missing credential),
// 'error' is everything else (network, 5xx, engine crash). Matched over the
// structured error field AND the message tail, since per-post failure rows carry
// the engine's raw text.
const FAILURE_RANK = { token: 0, needs_scope: 1, error: 2 };
function failureClass(r) {
  const msg = `${r.error || ''} ${r.errorMessage || ''}`;
  if (/needs_scope/i.test(msg)) return 'needs_scope';
  if (/token|not authenticated|not authorized|unauthorized|\b401\b|invalid_grant|expired|not connected|credential/i.test(msg)) return 'token';
  return 'error';
}

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
  const insights = state.insights?.data || {};
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
  const unavailable = state.insights?.unavailable || {};
  const unavailableLanes = LANES.filter((lane) => unavailable[lane]);
  if (unavailableLanes.length) {
    const parts = unavailableLanes.map((lane) =>
      `${t(LANE_KEYS[lane] || lane)} (${t(unavailable[lane].reason === 'needs_scope' ? 'digest.unavailable.needsScope' : 'digest.unavailable.failed')})`);
    lines.push(t('digest.unavailable', { lanes: parts.join(', ') }));
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
