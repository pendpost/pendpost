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
import { radarDigestLines } from './radar.mjs';
import { makeT, localeDate, localeDateTime } from './i18n.mjs';

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
const PLATFORM_LANE = { instagram: 'meta', facebook: 'meta', meta: 'meta', linkedin: 'linkedin', youtube: 'youtube', gbp: 'gbp', pinterest: 'pinterest', telegram: 'telegram', ghost: 'ghost', nostr: 'nostr' };
const LANES = ['meta', 'linkedin', 'youtube', 'gbp', 'pinterest', 'telegram', 'ghost', 'nostr'];

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

    for (const c of campaigns) {
      if (campaign && c.id !== campaign) continue;
      if (!campaign && !c.active) continue;
      const lanes = lanesWithEvidence(c.posts || []);
      if (!lanes.size) continue;
      const planAbs = path.resolve(activeRoot(), c.path);
      for (const lane of lanes) {
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
    state.insights.lastFetch = now;
    saveState();

    // Account rows join the returned envelope + tally AFTER the .data store loop
    // (postId:null keeps them out of .data): a failed account fetch is recorded
    // exactly like a failed per-post row so the Activity summary stays honest.
    for (const r of accountResults) results.push(r);
    const fetched = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    appendActivity({
      campaign: campaign || null, postId: null, platform: null, action: 'insights-fetch',
      ok: failed === 0 || fetched > 0,
      errorCode: failed && !fetched ? 'engine_failure' : null,
      errorMessage: failed ? `${failed} fetch(es) failed` : null,
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
  // keyed by lane, e.g. account.gbp.performance). lastFetch/items/metricLabels
  // are unchanged so the existing Insights.jsx consumer and tests still pass.
  return { ok: true, lastFetch: state.insights?.lastFetch || null, items, metricLabels: METRIC_LABELS, mode, account: state.insights?.account || {} };
}

// Scheduler hook: at most one sweep per 24h, piggybacked on the tick.
export async function dailyInsightsSweep() {
  const last = Date.parse(loadState().insights?.lastFetch || 0) || 0;
  if (Date.now() - last < 24 * 3600 * 1000) return null;
  return fetchInsights();
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
  IMPRESSION: 'metric.impression', PIN_CLICK: 'metric.pinClick', SAVE: 'metric.save', OUTBOUND_CLICK: 'metric.outboundClicks',
};
const PLATFORM_KEYS = { facebook: 'platform.facebook', instagram: 'platform.instagram', linkedin: 'platform.linkedin', youtube: 'platform.youtube', gbp: 'platform.gbp', pinterest: 'platform.pinterest', telegram: 'platform.telegram', ghost: 'platform.ghost', nostr: 'platform.nostr' };
const LANE_KEYS = { meta: 'lane.meta', linkedin: 'lane.linkedin', youtube: 'lane.youtube', gbp: 'lane.gbp', pinterest: 'lane.pinterest', telegram: 'lane.telegram', ghost: 'lane.ghost', nostr: 'lane.nostr' };
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

  const active = campaigns.filter((c) => c.active);
  const posts = active.flatMap((c) => c.posts || []);
  const posted = posts.filter((p) => p.derivedState === 'posted' || p.derivedState === 'fired-assumed');
  const recent = posted.filter((p) => p.postedAt && now - Date.parse(p.postedAt) < 7 * 24 * 3600 * 1000);

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
    for (const line of radarDigestLines(state.radar, t, { authorRepliedCount })) lines.push(line);
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
