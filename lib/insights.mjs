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
import { makeT, localeDate, localeDateTime } from './i18n.mjs';

const ENGINES = {
  meta: 'scripts/meta-social.mjs',
  youtube: 'scripts/yt-social.mjs',
  linkedin: 'scripts/linkedin-social.mjs',
};

// Stored insights items carry a platform value (instagram/facebook/youtube/
// linkedin), but resolveMode (lib/mode.mjs) reasons in LANES (meta/linkedin/
// youtube). instagram AND facebook BOTH map to the 'meta' lane - calling
// resolveMode with the raw platform would yield the wrong mock|live for IG/FB.
const PLATFORM_LANE = { instagram: 'meta', facebook: 'meta', meta: 'meta', linkedin: 'linkedin', youtube: 'youtube' };
const LANES = ['meta', 'linkedin', 'youtube'];

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
      }
    }

    const state = loadState();
    state.insights = state.insights || { data: {} };
    state.insights.data = state.insights.data || {};
    for (const r of results) {
      if (!r.ok || !r.postId) continue;
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
  // `mode` is an additive top-level per-lane map; lastFetch/items/metricLabels
  // are unchanged so the existing Insights.jsx consumer and tests still pass.
  return { ok: true, lastFetch: state.insights?.lastFetch || null, items, metricLabels: METRIC_LABELS, mode };
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
};
const PLATFORM_KEYS = { facebook: 'platform.facebook', instagram: 'platform.instagram', linkedin: 'platform.linkedin', youtube: 'platform.youtube' };
const LANE_KEYS = { meta: 'lane.meta', linkedin: 'lane.linkedin', youtube: 'lane.youtube' };
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

  const queue = posts.filter((p) => p.approval !== 'approved' && p.derivedState !== 'posted');
  const overdue = posts.filter((p) => p.derivedState === 'overdue');
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

  // `mode` is an additive per-lane map mirroring getInsights().mode; digest/
  // generatedAt are unchanged so the generate_digest twin stays compatible.
  return { ok: true, digest: lines.join('\n'), generatedAt: new Date(now).toISOString(), mode, locale: loc };
}
