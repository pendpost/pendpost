import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, XCircle, Clock, Activity as ActivityIcon, AlertTriangle, RefreshCw, ChevronRight, Wrench, ShieldCheck, Info } from 'lucide-react';
import { useActivity } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { Skeleton, PLATFORM_META } from './ui.jsx';
import { Tip } from './ui/Tooltip.jsx';
import ActionButton from './ui/ActionButton.jsx';
import { PROJECT_CHIP, STATUS_INK } from './ui/recipes.js';
import { ClientAvatar } from './ClientSwitcher.jsx';
import { dayKey, fmtTime, dateLocale, X_PORTAL_URL, GCP_APIS_CONSOLE_URL, isAbsoluteHttpUrl, prettyCampaign } from '../lib/format.js';
import InfoTip from './ui/InfoTip.jsx';
import { humanizeCheck, humanizeFailure, laneLabel } from '../lib/failureCopy.js';

// Map a FAILED activity entry to a one-click fix (data, not UI - like ACTION_LABEL
// above). The source of truth for the setup-class strings is platformValidate()'s
// needsSetup problems (lib/writes.mjs): missing credentials/identifiers or a
// not-connected/not-authenticated lane. Returns null for a generic failure (the
// row already opens its post as before) so a wrench only appears where there IS a
// specific, actionable fix. Server error strings are English (LinkedIn's are the
// two German exceptions), so both are matched.
function resolveRemediation(entry) {
  if (entry.ok !== false) return null;
  const msg = entry.errorMessage || '';
  const code = entry.errorCode || '';
  // A per-lane insights row (lib/insights.mjs, one row per state change) carries its
  // reason class as errorCode. Only two of them have a fix the owner can do in one step:
  // turn the API on in Google Cloud, or reconnect an expired sign-in. A missing permission
  // (LinkedIn's Community Management product, Meta's insights access) and a plain fetch
  // error have none, so they get no button: a "Reconnect" there would change nothing.
  if (entry.action === 'insights-fetch' && entry.platform) {
    if (code === 'api_disabled') return { kind: 'apiDisabled', ctaKey: 'activity.fix.apiDisabled' };
    if (code === 'token') return { kind: 'setup', ctaKey: 'activity.fix.setup' };
    return null;
  }
  // A reconnect that landed locally but could not reach the cloud vault (lib/writes.mjs
  // resealAfterReconnect): no renewal will retry it, so the fix is Re-sync now on the cloud page.
  if (entry.action === 'token-refresh' && code === 'cloud_reseal_failed_reconnect') return { kind: 'cloud', ctaKey: 'activity.fix.cloudResync' };
  // A failed token renewal (the daily refresh in lib/writes.mjs dailyTokenRefresh): the
  // refresh token itself is gone, so the one fix is reconnecting the lane in Setup.
  if (entry.action === 'token-refresh' && code !== 'cloud_reseal_failed') return { kind: 'setup', ctaKey: 'activity.fix.setup' };
  // Meta action-block / rate-limit -> the Meta lane cadence + pause controls.
  if (code === 'blocked_368' || /action block|\b368\b|rate.?limit/i.test(msg)) {
    return { kind: 'metaCadence', ctaKey: 'activity.fix.metaCadence' };
  }
  // Credits depleted (X HTTP 402): the whole lane is halted and nothing auto-retries
  // until the operator tops up the account. The one actionable fix is the top-up portal.
  if (code === 'credits' || /HTTP 402/.test(msg)) {
    return { kind: 'credits', ctaKey: 'action.topUpCredits' };
  }
  // A disabled API in the GCP project (the YouTube Data / Analytics API not enabled -
  // Google 403 accessNotConfigured / SERVICE_DISABLED, carried as api_disabled by the
  // engine). This is NOT a missing scope or a dead token, so a reconnect fixes nothing:
  // the fix is to ENABLE the API in the Cloud console. Route there (the row carries the
  // exact activation URL in helpUrl when Google supplied one; the daily insights-fetch
  // summary "youtube api_disabled" carries only the class string -> generic fallback).
  // Checked BEFORE the needsSetup class below so its message never mis-routes to Setup.
  if (code === 'api_disabled' || entry.error === 'api_disabled' || /\bapi_disabled\b|accessNotConfigured|SERVICE_DISABLED|has not been used in project .* or it is disabled/i.test(msg)) {
    return { kind: 'apiDisabled', ctaKey: 'activity.fix.apiDisabled' };
  }
  // needsSetup class: a missing credential/identifier or an unconnected lane.
  if (/not connected|not authenticated|not configured|credentials not configured|is not set|not set \(|no signing key|nicht verbunden|nicht eingerichtet/i.test(msg)) {
    return { kind: 'setup', ctaKey: 'activity.fix.setup' };
  }
  // Brand-lint / invalid input on a concrete post -> open it to edit.
  if (code === 'invalid_input' && entry.campaign && entry.postId) {
    return { kind: 'edit', ctaKey: 'activity.fix.edit' };
  }
  return null;
}

// Maps an action id (data, not UI text) to its i18n key. The English values
// live in en.json under activity.action.*; resolved through t() at render time
// (this object is module-scope, so it cannot call the hook directly).
const ACTION_LABEL = {
  'publish-reel': 'activity.action.publishReel',
  'publish-story': 'activity.action.publishStory',
  publish: 'activity.action.publish',
  'schedule-native': 'activity.action.scheduleNative',
  'engine-run': 'activity.action.engineRun',
  'circuit-breaker': 'activity.action.circuitBreaker',
  'scheduler-start': 'activity.action.schedulerStart',
  'scheduler-stop': 'activity.action.schedulerStop',
  run: 'activity.action.run',
  approve: 'activity.action.approve',
  reject: 'activity.action.reject',
  'mark-posted': 'activity.action.markPosted',
  'post-create': 'activity.action.postCreate',
  'post-update': 'activity.action.postUpdate',
  'post-delete': 'activity.action.postDelete',
  // Planner-bulk package T: a deleted post put back from the campaign trash (Undo).
  'post-restore': 'activity.action.postRestore',
  'meta-block': 'activity.action.metaBlock',
  'meta-unblock': 'activity.action.metaUnblock',
  // The generic lane breaker's resume (lib/writes.mjs resumeLane): the owner
  // topped up and lifted a halted lane (e.g. X HTTP 402 credits), so parked
  // posts re-enter the fire loop. The visible counterpart to circuit-breaker.
  'lane-resumed': 'activity.action.laneResumed',
  // Spec 50 P3: the "Respond for me" circuit breaker cooled a lane down after a rate
  // limit or three failed actions (lib/engage.mjs), and resume_lane later ended that
  // cool-down (lib/writes.mjs). The same lane-halt lifecycle as lane-resumed, so both
  // file into the meta-block group. Their reason is dynamic (the halt class), so NO
  // ACTION_NOTE - the raw message renders underneath.
  'engage-lane-cooldown': 'activity.action.engageLaneCooldown',
  'engage-lane-resumed': 'activity.action.engageLaneResumed',
  'asset-upload': 'activity.action.assetUpload',
  reschedule: 'activity.action.reschedule',
  unschedule: 'activity.action.unschedule',
  'campaign-create': 'activity.action.campaignCreate',
  'campaign-activate': 'activity.action.campaignActivate',
  'campaign-deactivate': 'activity.action.campaignDeactivate',
  'token-refresh': 'activity.action.tokenRefresh',
  insights: 'activity.action.insights',
  'insights-fetch': 'activity.action.insightsFetch',
  // The inbound-engagement (inbox) seam (spec 02, Pattern P6): a reply the operator
  // sent, an inbound comment received (spec 23 webhook receiver, shipped), (spec 06) a
  // moderation action the operator applied (hide/delete/hold/approve/spam/remove), and
  // (spec 24) a reaction the operator applied (like/favourite/boost/emoji).
  'comment-reply': 'activity.action.commentReply',
  'comment-received': 'activity.action.commentReceived',
  'comment-moderate': 'activity.action.commentModerate',
  'comment-react': 'activity.action.commentReact',
  // Own-post comment monitor: the sweep found new comments on your own posts (logged once
  // per batch that found some). Audit only; the items live in Radar "Replies to you".
  'comments-new': 'activity.action.commentsNew',
  // GBP reviews (spec 03): a review received (logged on read) + an owner reply the
  // operator sent. Audit rows in the 'other' group, like the comment actions.
  'review-received': 'activity.action.reviewReceived',
  'review-reply': 'activity.action.reviewReply',
  // GBP location media + attributes (spec 19, account management): a gallery photo/
  // video added, a location attribute updated. Operator-triggered, on-demand writes -
  // not a scheduled publish, so they fall into the 'other' group (no group change).
  'gbp-media-add': 'activity.action.gbpMediaAdd',
  'gbp-attributes-set': 'activity.action.gbpAttributesSet',
  'set-thumbnail': 'activity.action.setThumbnail',
  // Post-publish companion rows that ride ALONGSIDE a publish (data, not UI):
  // 'post-comment' (LinkedIn spec 11 + YouTube first-comment), 'set-alt' (X /
  // WordPress / Pinterest spec 21 image alt-text), 'set-caption' (YouTube SRT),
  // 'set-seo' (WordPress spec 13: category-create soft-fail + feature-image-alt
  // follow-up failure - the SEO meta itself rides silently in the create body).
  'post-comment': 'activity.action.postComment',
  'set-alt': 'activity.action.setAlt',
  'set-caption': 'activity.action.setCaption',
  'set-seo': 'activity.action.setSeo',
  // Edit-after-publish (spec 12): the operator pushed an edit to an already-
  // published youtube/telegram/discord post - a companion row alongside publish.
  'post-edit': 'activity.action.postEdit',
  // Spec 26: the operator created a Discord guild scheduled event from a post's
  // dcEvent intent - a companion row alongside publish, like post-edit.
  'discord-event': 'activity.action.discordEvent',
  probe: 'activity.action.probe',
  'publish-due': 'activity.action.publishDue',
  'cadence-defer': 'activity.action.cadenceDefer',
  // G6: a due approved post held ONLY because its media/render is missing on disk
  // (the scheduler's media gate). A defer like cadence-defer - the post stays due
  // and fires the moment the file is back.
  'media-missing-defer': 'activity.action.mediaMissingDefer',
  // Fail-closed backstop (lib/scheduler.mjs claim gate): the cloud has this post
  // (it acknowledged the push) but cannot answer the publish claim, so local holds
  // instead of risking a duplicate. A defer like media-missing-defer: the post
  // stays due and the next tick asks the cloud again.
  'cloud-claim-wait': 'activity.action.cloudClaimWait',
  // G5 (B8): the two unattended Radar actions (lib/radar-sweep.mjs). The daily
  // agent research run spends the operator's money overnight; the author-reply
  // reconcile is the "someone answered you" morning glance. Both used to render
  // as raw machine ids. NO ACTION_NOTE for either: unlike the static defer notes,
  // their errorMessage is dynamic and load-bearing (the failed job's tail / the
  // "N threads answered (sources)" count) and a static note would override it.
  'radar-agent-scan': 'activity.action.radarAgentScan',
  'radar-author-replied': 'activity.action.radarAuthorReplied',
  // R6a gate refinements (ux-audit 2026-08-04, dim-1 proposals 3+5, both opt-in /
  // default OFF): the approval-expiry sweep aged an approval back to draft, and the
  // slot-slip sweep moved an unapproved post's slot forward. Both are fail-closed:
  // they only ask the human to re-decide or move the time, never publish. Their
  // errorMessage is dynamic and load-bearing (the window / the new slot time), so
  // like the radar rows they carry NO ACTION_NOTE - the raw message renders.
  'approval-expired': 'activity.action.approvalExpired',
  'slot-slip': 'activity.action.slotSlip',
  // R2 digest v2 autonomy report (ux-audit 2026-08-04, dim-5 AU3): the auto-approve
  // policy declined to auto-approve a post at a gate seam (brand-lint / foreign-link),
  // so it stays for manual review instead. A fail-closed row - autonomy stepped back,
  // it never published. errorMessage carries the dynamic reason class, so NO ACTION_NOTE.
  'auto-approve-refused': 'activity.action.autoApproveRefused',
  // R7 revocation-that-unwinds (ux-audit 2026-08-04, dim-5 AU4): the owner disabled a
  // policy and returned a not-yet-published auto-approval to review. A de-escalation
  // row - autonomy was withdrawn, nothing published - filed with the approval decisions.
  'auto-approve-revoke': 'activity.action.autoApproveRevoke',
  // Enforced pre-flight fence (scheduler.mjs): a due, approved post reached the
  // scheduler with a content-integrity blocker (A/V-desync, over-cap caption,
  // malformed poll/carousel). The lane is dropped, nothing published - the
  // operator must fix and re-approve. Like the radar/defer rows its errorMessage
  // is dynamic and load-bearing (the platform + the specific problem), so NO
  // ACTION_NOTE - the raw message renders.
  'preflight-blocked': 'activity.action.preflightBlocked',
  // A due post carried a mock publish id from a test run; the scheduler cleared
  // it so the post can really publish (lib/scheduler.mjs). A publish-lifecycle
  // correction on THIS post - the errorMessage carries the "press Try again"
  // guidance, so NO ACTION_NOTE (the raw message renders).
  'mock-id-cleared': 'activity.action.mockIdCleared',
  // Media cleanup + self-heal (docs/specs/media-cleanup.md): local videos every post was done
  // with were deleted, or a missing file an upcoming post needs came back from the cloud. Both
  // messages are dynamic (the files and sizes), so NO ACTION_NOTE - the raw message renders.
  'media-cleanup': 'activity.action.mediaCleanup',
  'media-restore': 'activity.action.mediaRestore',
};

// Maps an action id to the i18n key for its NOTE body (data, not UI text), so a
// structured code drives the localized message instead of leaking the raw
// English errorMessage into the de-CH UI. Mirrors ACTION_LABEL: resolved through
// t() at render. Unmapped actions fall back to the raw entry.errorMessage below.
const ACTION_NOTE = {
  'cloud-backstop': 'activity.note.cloudBackstop',
  'cadence-defer': 'activity.note.cadenceDefer',
  'media-missing-defer': 'activity.note.mediaMissingDefer',
  'cloud-claim-wait': 'activity.note.cloudClaimWait',
};

// Maps an entry's errorCode to the i18n key for its NOTE body (data, not UI
// text), like ACTION_NOTE above but keyed by the more specific errorCode - one
// action id can carry several distinct failure reasons, only some of which are
// a known, translatable class. 'publish-refused' (spec 51 split fence,
// lib/scheduler.mjs) is the case in point: a buildPublishJob refusal carries a
// dynamic, load-bearing errorMessage (kept raw, like the radar/defer rows
// above), but a TRUE approved-vs-disk mismatch always carries errorCode
// 'stale_content' with the SAME fixed message (lib/receipts.mjs) - so that one
// is worth a real translation instead of leaking English into the de-CH UI.
// Checked before ACTION_NOTE below (and before the raw errorMessage fallback)
// so a matched errorCode always wins over the raw message.
const ERROR_NOTE = {
  stale_content: 'activity.error.stale_content',
};

// A scheduled Radar scan a SPEND LIMIT stopped (the owner's daily agent budget, or the agent
// subscription's weekly/session limit) is a neutral note, not a failure: nothing to fix and
// the next scan runs by itself (lib/radar-sweep.mjs NEUTRAL_SCAN_CODES logs it ok:true).
// Rows written before that fix carry ok:false; neutralScanRow reads them neutral too. The
// raw line (the limit's reset time) rides the "?".
const NEUTRAL_SCAN_NOTE = {
  budget: 'activity.note.radarBudget',
  limit: 'activity.note.agentLimit',
};
const neutralScanRow = (e) => (e && e.ok === false && e.action === 'radar-agent-scan' && NEUTRAL_SCAN_NOTE[e.errorCode] ? { ...e, ok: true } : e);

// The old once-a-night insights row ("N fetch(es) failed: meta error, youtube api_disabled",
// no platform) predates the per-lane rows lib/insights.mjs writes now: each lane's standing
// problem is tracked and shown on its own row from then on. The aggregate is history, so it
// reads neutral with no fix button (a fix it pointed at may long be done); the raw line
// rides the "?".
const LEGACY_INSIGHTS_AGGREGATE = /^\d+ fetch\(es\) failed:/;
const legacyInsightsRow = (e) => (e && e.ok === false && e.action === 'insights-fetch' && !e.platform && LEGACY_INSIGHTS_AGGREGATE.test(e.errorMessage || '')
  ? { ...e, ok: true, errorCode: 'insights_legacy' } : e);
const neutralRow = (e) => legacyInsightsRow(neutralScanRow(e));

// A row's note as { text, raw }. A mapped errorCode (ERROR_NOTE) or action (ACTION_NOTE) is
// our own localized sentence. A note on a row that did NOT fail stays its message (the
// load-bearing counts, windows and slot times above). A FAILED row never shows the engine's
// English errorMessage inline: it reads the failureCopy sentence (humanizeFailure for a row
// about a post, humanizeCheck for one that is not, whose sentences read true for a
// connection), else the generic error.action, and `raw` carries the message for the "?".
// A per-lane insights row as one plain sentence, by lane + reason class (the server text
// is English and stays behind the "?"). LinkedIn's missing permission is its pending
// Community Management application, so it says that instead of the generic permission line.
// Meta's failures vary, so its sentence carries the sanitized real reason (entry.detail).
function insightsNote(entry, t) {
  const lane = laneLabel(entry.platform);
  const code = entry.errorCode || '';
  if (entry.ok !== false) return code === 'insights_recovered' ? t('activity.insights.back', { lane }) : null;
  if (entry.platform === 'linkedin' && code === 'needs_page_role') return t('activity.insights.linkedinPageRole');
  if (entry.platform === 'linkedin' && code === 'needs_scope') return t('activity.insights.linkedinScope');
  if (code === 'api_disabled') return t('activity.insights.apiDisabled', { lane });
  if (code === 'token') return t('activity.insights.token', { lane });
  if (entry.platform === 'meta' && entry.detail) return t('activity.insights.reason', { lane, reason: entry.detail });
  if (code === 'needs_scope') return t('activity.insights.scope', { lane });
  return t('activity.insights.failed', { lane });
}

// A token-refresh row's sentence by code: the renewal's own cloud copy failed (retried on the
// next renewal), the reconnect's cloud copy failed (Re-sync now), else the renewal failed.
const TOKEN_REFRESH_NOTE = {
  cloud_reseal_failed: 'activity.tokenRefresh.resealFailed',
  cloud_reseal_failed_reconnect: 'activity.tokenRefresh.resealReconnectFailed',
};

// The nightly insights summary row (no platform): a lane stale for more than 2 days, or an
// offline run, as our own sentence built from its structured lanes[] (the server text is
// English and rides the "?").
function insightsSummaryNote(entry, t) {
  const lanes = Array.isArray(entry.lanes) ? entry.lanes.filter((l) => l && l.lane) : [];
  if (!lanes.length) return null;
  if (entry.errorCode === 'insights_stale') {
    const list = lanes.map((l) => t('insights.stale.lane', { lane: laneLabel(l.lane), date: new Date(l.since).toLocaleDateString(dateLocale(), { dateStyle: 'medium' }) })).join(', ');
    return t('activity.insights.stale', { days: 2, lanes: list });
  }
  if (entry.errorCode === 'insights_offline') return t('activity.insights.offline', { lanes: lanes.map((l) => laneLabel(l.lane)).join(', ') });
  return null;
}

function rowNote(entry, t) {
  if (entry.action === 'insights-fetch' && !entry.platform) {
    const text = insightsSummaryNote(entry, t);
    if (text) return { text, raw: entry.errorMessage && entry.errorMessage !== text ? entry.errorMessage : null };
  }
  if (entry.action === 'insights-fetch' && entry.platform) {
    const text = insightsNote(entry, t);
    if (text) return { text, raw: entry.ok === false && entry.errorMessage && entry.errorMessage !== text ? entry.errorMessage : null };
  }
  if (entry.action === 'token-refresh' && entry.ok === false) {
    const key = TOKEN_REFRESH_NOTE[entry.errorCode] || 'activity.tokenRefresh.failed';
    return { text: t(key, { lane: laneLabel(entry.platform) }), raw: entry.errorMessage || null };
  }
  if (ERROR_NOTE[entry.errorCode]) return { text: t(ERROR_NOTE[entry.errorCode]), raw: null };
  if (entry.errorCode === 'insights_legacy') return { text: t('activity.note.insightsLegacy'), raw: entry.errorMessage || null };
  if (entry.action === 'radar-agent-scan' && NEUTRAL_SCAN_NOTE[entry.errorCode]) return { text: t(NEUTRAL_SCAN_NOTE[entry.errorCode]), raw: entry.errorMessage || null };
  if (ACTION_NOTE[entry.action]) return { text: t(ACTION_NOTE[entry.action]), raw: null };
  if (!entry.errorMessage) return null;
  const raw = `${entry.errorCode ? `${entry.errorCode}: ` : ''}${entry.errorMessage}`;
  if (entry.ok !== false) return { text: raw, raw: null };
  const failure = { message: entry.errorMessage, code: entry.errorCode, lane: entry.platform };
  const mapped = entry.postId ? humanizeFailure(failure, t) : humanizeCheck(failure, t);
  return { text: mapped.text || t('error.action'), raw };
}

// C7: a SMALL fixed set of action GROUPS (curated, like STATUS_FILTERS) that
// fold the ~30 ACTION_LABEL ids above into one chip each. Data, not UI - the
// labels resolve through t() at render via the activity.action.group.* keys.
// `actions` lists every ACTION_LABEL id that belongs to the group; anything not
// claimed by a named group falls into 'other'. Module-scope so the grouping
// stays data next to ACTION_LABEL rather than UI in App.jsx.
export const ACTION_GROUPS = [
  // 'media-missing-defer' files under publish (not meta-block): it is about THIS
  // post's publish lifecycle on any lane, and it must ride the default feed - the
  // whole point of G6 is that the operator SEES why the due post did not fire.
  // 'preflight-blocked' files under publish (like media-missing-defer): it is
  // about THIS post's publish lifecycle on a lane and must ride the default feed -
  // the operator has to SEE why the due post did not fire.
  // 'mock-id-cleared' files under publish (like preflight-blocked): it is about
  // THIS post's publish lifecycle and must ride the default feed so the operator
  // sees the id was cleared and the post needs a re-run.
  // 'cloud-claim-wait' files under publish (like media-missing-defer) for the same
  // reason: it is the one row that says why THIS due post did not fire (the cloud
  // has it and cannot answer the publish claim), and it is ok:true, so under
  // 'system' the default feed would hide it.
  { key: 'publish', label: 'activity.action.group.publish', actions: ['publish-reel', 'publish-story', 'publish', 'mark-posted', 'publish-due', 'media-missing-defer', 'cloud-claim-wait', 'preflight-blocked', 'mock-id-cleared', 'post-comment', 'set-alt', 'set-caption', 'set-seo', 'post-edit', 'discord-event'] },
  // 'slot-slip' (R6a) is a machine-initiated reschedule of an unapproved post, so
  // it files with the schedule moves and rides the default feed - the operator must
  // see that the slot moved (and can approve earlier to publish earlier).
  { key: 'schedule', label: 'activity.action.group.schedule', actions: ['schedule-native', 'reschedule', 'unschedule', 'slot-slip'] },
  // 'approval-expired' (R6a) sends an aged approval back to review, so it files with
  // the approval decisions - the same bucket as approve/reject.
  { key: 'approval', label: 'activity.action.group.approval', actions: ['approve', 'reject', 'approval-expired', 'auto-approve-revoke'] },
  // The SYSTEM group: bookkeeping the machine does for itself (scheduler ticks,
  // liveness probes, token refreshes, metrics sweeps, cloud reconciliation). These
  // are audit, not content events - the default feed HIDES their successes (a
  // failure always surfaces) behind the one reveal line at the feed foot, so
  // "what happened to my posts" leads and "what the daemon did" is one click away.
  { key: 'system', label: 'activity.action.group.system', actions: ['scheduler-start', 'scheduler-stop', 'run', 'engine-run', 'probe', 'token-refresh', 'insights', 'insights-fetch', 'cloud-reconcile', 'cloud-backstop', 'client-activate', 'client-create', 'client-update', 'client-archive', 'client-unarchive'] },
  // 'cadence-defer' (Meta lane throttle) belongs with the Meta blocks, not with
  // real publishes - so one chip isolates/hides the throttle noise.
  // 'lane-resumed' is the generic lane breaker's resume - it files with the
  // block/unblock actions (the same lane-halt lifecycle) and stays in the feed.
  { key: 'meta-block', label: 'activity.action.group.metaBlock', actions: ['circuit-breaker', 'meta-block', 'meta-unblock', 'lane-resumed', 'engage-lane-cooldown', 'engage-lane-resumed', 'cadence-defer'] },
  { key: 'campaign', label: 'activity.action.group.campaign', actions: ['campaign-create', 'campaign-activate', 'campaign-deactivate'] },
  // No inbox group: replies, reviews and X events live in ONE place now, Radar
  // "Replies to you" (planner-bulk contract, package U). Their audit rows (comment-reply,
  // comments-new, review-received, radar-author-replied, ...) fall into 'other' below.
  // 'radar-agent-scan' is DELIBERATELY claimed by 'other', not 'system': the
  // default feed hides system successes, and the paid overnight research run is
  // exactly the row the operator opens Activity to see (spend legibility, G5).
  { key: 'other', label: 'activity.action.group.other', actions: ['radar-agent-scan'] },
];

// action id -> group key (everything unclaimed by a named group => 'other').
const ACTION_TO_GROUP = (() => {
  const m = {};
  for (const g of ACTION_GROUPS) for (const a of g.actions) m[a] = g.key;
  return m;
})();

// The group key an entry's action falls into, defaulting to 'other' so the
// 'other' chip catches every action id not named by a group above.
export function actionGroupOf(action) {
  return ACTION_TO_GROUP[action] || 'other';
}

// Identity of an entry for run-collapsing: same action, post, outcome and
// message => the same standing event. Two adjacent matches fold into one row.
// clientId is part of the identity so two projects' identical actions never fold
// into one ×N row in the all-projects overview (undefined single-client, a no-op).
function collapseKey(e) {
  return `${e.clientId ?? ''}|${e.action}|${e.campaign ?? ''}|${e.postId ?? ''}|${e.ok ? 1 : 0}|${e.errorMessage ?? ''}`;
}

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function dayHeader(iso, t) {
  const now = Date.now();
  const today = dayKey(new Date(now).toISOString());
  // Yesterday's dayKey, anchored to "now minus 24h" so the midnight window is
  // correct regardless of the viewer's local clock.
  const yesterday = dayKey(new Date(now - 24 * 60 * 60 * 1000).toISOString());
  const k = dayKey(iso);
  if (k === today) return t('activity.day.today');
  if (k === yesterday) return t('activity.day.yesterday');
  return new Intl.DateTimeFormat(dateLocale(), { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
}

function Row({ entry, onOpenPost, onNavigate, postTitle = null }) {
  const t = useT();
  const meta = entry.platform ? PLATFORM_META[entry.platform] : null;
  // Note body (rowNote): a mapped errorCode wins first (ERROR_NOTE), then a mapped
  // action code (ACTION_NOTE), so the de-CH UI never leaks raw English; a failed row's
  // unmapped errorMessage becomes the failureCopy sentence with the raw line for the "?".
  const note = rowNote(entry, t);
  const noteText = note?.text || null;
  // A failed row with a specific, actionable fix shows a single amber wrench CTA
  // (jumps straight to the fix); the row is then a plain div - the wrench is the
  // only interactive control, so no nesting. Generic failures keep the
  // whole-row-opens-the-post behavior below (US-ACT-10, no dead ends).
  const remediation = resolveRemediation(entry);
  const doFix = () => {
    // clientId re-scopes a foreign-project row to its own client before opening it
    // (openPost re-scopes on post.clientId); undefined single-client, a no-op.
    if (remediation?.kind === 'edit') onOpenPost?.({ campaign: entry.campaign, id: entry.postId, clientId: entry.clientId });
    // Credits halt: open the X top-up portal (a new tab, same as the PostDetail link).
    // The lane resumes from the readiness strip / PostDetail once the balance is back.
    else if (remediation?.kind === 'credits') window.open(X_PORTAL_URL, '_blank', 'noopener,noreferrer');
    // api_disabled: open the Cloud console straight at the API to enable (the row's own
    // activation URL when it has one, else the APIs library). A reconnect in Setup would
    // be the wrong door, so this never routes there.
    else if (remediation?.kind === 'cloud') onNavigate?.('cloud');
    else if (remediation?.kind === 'apiDisabled') window.open(isAbsoluteHttpUrl(entry.helpUrl) ? entry.helpUrl : GCP_APIS_CONSOLE_URL, '_blank', 'noopener,noreferrer');
    else onNavigate?.('setup', remediation?.kind === 'metaCadence' ? 'facebook' : entry.platform);
  };
  // US-ACT-10: an entry that carries a post is a clickable row that opens it (no
  // dead ends). Its note is the plain sentence only, so there is no nested-interactive
  // control inside the row button: the post detail it opens carries the failure's "?".
  // A row that is not a button keeps the raw line behind the house "?" beside its note.
  const openable = Boolean(entry.campaign && entry.postId && onOpenPost) && !remediation;
  // The words a person recognises for the post: its title, or "a post in <campaign>".
  const postLabel = entry.postId ? (postTitle || t('activity.row.postIn', { campaign: prettyCampaign(entry.campaign || '') })) : null;
  // A defer (cadence throttle, missing media/render) is a deferral, not a success
  // or failure - render it with the design system's amber "waiting/held" token
  // (Clock), and tone its message amber rather than red (it is informational, the
  // post stays due).
  const isDefer = entry.action === 'cadence-defer' || entry.action === 'media-missing-defer' || entry.action === 'cloud-claim-wait';
  // Consecutive identical entries are folded into one row carrying a count + a
  // time range (set in the grouping step); show "×N" and "from–to" when n>1.
  const count = entry.count || 1;
  const cls = `flex w-full items-start gap-3 rounded-xl bg-white/45 px-3 py-2 text-left ring-1 ring-zinc-900/[0.06] dark:bg-zinc-800/40 dark:ring-white/10${openable ? ' group transition hover:ring-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand' : ''}`;
  const inner = (
    <>
      {isDefer ? (
        <Clock size={15} className="mt-0.5 shrink-0 text-amber-500" aria-hidden="true" />
      ) : entry.ok ? (
        // US-ACT-21: colour is spent only on attention. A routine success (post
        // created, published, deleted) carries a NEUTRAL check - when every row
        // glows green, a red one stops being findable at a glance. Failures keep
        // red, defers keep amber; the icon shape still says "succeeded".
        <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
      ) : (
        <XCircle size={15} className="mt-0.5 shrink-0 text-red-500" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-bold">
          {ACTION_LABEL[entry.action] ? t(ACTION_LABEL[entry.action]) : entry.action}
          {/* Spec 51 (D2): a signed-receipt glyph after the action label when this row
              carries attest.kid (stamped by lib/receipts.mjs onto the publish row).
              Icon + text tooltip, never colour-only. No new filter/group. */}
          {entry.attest ? (
            <span
              className={`ml-1.5 inline-flex align-middle ${STATUS_INK.ok}`}
              title={t('activity.attest.title', { kid: entry.attest.kid })}
              aria-label={t('activity.attest.title', { kid: entry.attest.kid })}
            >
              <ShieldCheck size={13} aria-hidden="true" />
            </span>
          ) : null}
          {/* All-projects overview: which project this row belongs to. Stamped by App
              only in that mode (single-client mode never sets clientName, so nothing
              renders - the row is byte-identical). The avatar carries the accent, the
              name carries the meaning - never colour-only - matching the Planner/
              Freigaben/Radar chip exactly. */}
          {entry.clientName ? (
            <span className={`${PROJECT_CHIP} ml-1.5 max-w-[8rem] align-middle`}>
              <ClientAvatar client={{ displayName: entry.clientName, accent: entry.accent, logo: null }} size={14} />
              <span className="truncate">{entry.clientName}</span>
            </span>
          ) : null}
          {entry.postId ? (
            // Humanize the reference: the post's own headline when the plan still carries it
            // (what the operator recognises), else a readable label naming its campaign (the
            // post is gone: deleted, other project). Raw ids never reach the screen.
            <span className="ml-1.5 font-normal text-zinc-600 dark:text-zinc-400">{postLabel}</span>
          ) : null}
          {count > 1 ? (
            <span className="ml-1.5 rounded-full bg-zinc-900/[0.06] px-1.5 align-middle text-[10px] font-bold tabular-nums text-zinc-500 dark:bg-white/10 dark:text-zinc-400">×{count}</span>
          ) : null}
        </p>
        {noteText ? (
          // Three fixed tones (DESIGN.md: colour never the sole signal - the row
          // icon carries severity too). Red only for a genuine failure
          // (entry.ok === false). Amber only for a real defer (the post stays due).
          // A note riding on a SUCCESS (e.g. a backstop/cloud-miss under a green
          // check) is neutral zinc - a local backstop publish is not degraded.
          <div className="flex min-w-0 max-w-full items-center gap-1">
            <p title={noteText} className={`min-w-0 truncate text-[11px] ${entry.ok === false ? 'text-red-600/90 dark:text-red-300/90' : isDefer ? 'text-amber-700/90 dark:text-amber-300/90' : 'text-zinc-500 dark:text-zinc-400'}`}>{noteText}</p>
            {openable ? null : <InfoTip label={note.raw} />}
          </div>
        ) : null}
      </div>
      <p className="shrink-0 whitespace-nowrap text-[11px] text-zinc-500 dark:text-zinc-400">
        {count > 1 ? `${fmtTime(entry.tsFrom)}–${fmtTime(entry.tsTo)}` : fmtTime(entry.ts)}
        {meta ? ` · ${meta.label}` : ''}
        {entry.lateMin ? ` · ${t('activity.row.minLate', { n: entry.lateMin })}` : ''}
        {entry.actor ? ` · ${entry.actor}` : ''}
      </p>
      {openable ? (
        <ChevronRight size={14} className="mt-0.5 shrink-0 text-zinc-500 transition group-hover:translate-x-0.5" aria-hidden="true" />
      ) : null}
    </>
  );
  if (remediation) {
    return (
      <div className={cls}>
        {inner}
        <Tip label={t(remediation.ctaKey)}>
          <button
            type="button"
            onClick={doFix}
            aria-label={t(remediation.ctaKey)}
            className="flex shrink-0 items-center gap-1 self-center rounded-lg px-2 py-1 text-[11px] font-bold text-amber-700 ring-1 ring-amber-500/30 transition hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-amber-300 dark:ring-amber-400/30"
          >
            <Wrench size={13} aria-hidden="true" />
            <span className="hidden sm:inline">{t(remediation.ctaKey)}</span>
          </button>
        </Tip>
      </div>
    );
  }
  if (openable) {
    return (
      <button
        type="button"
        aria-label={t('activity.row.open', { post: postLabel })}
        onClick={() => onOpenPost({ campaign: entry.campaign, id: entry.postId, clientId: entry.clientId })}
        className={cls}
      >
        {inner}
      </button>
    );
  }
  return <div className={cls}>{inner}</div>;
}

// The quiet one-click path to the hidden system bookkeeping: a text button, not a
// chip - it exists only while something IS hidden, and it drives the EXISTING
// group filter (selects the System group) rather than adding a second mechanism.
function SystemRevealLine({ count, onShowSystem, t, center = false }) {
  if (!count || !onShowSystem) return null;
  return (
    <p className={`px-1 text-[11px] text-zinc-500 dark:text-zinc-400 ${center ? 'text-center' : ''}`}>
      <button
        type="button"
        onClick={onShowSystem}
        className="rounded underline decoration-zinc-400/60 underline-offset-2 transition hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:text-zinc-200"
      >
        {t('activity.systemHidden', { count })}
      </button>
    </p>
  );
}

export default function ActivityView({ active, platformFilter = [], failuresOnly = false, actionGroups = [], campaigns = [], allClients = false, allRows = null, allFailed = [], allLoading = false, onOpenPost, onNavigate, onShowSystem, onClearFilters }) {
  const { data, isLoading: singleLoading, isError } = useActivity(active);
  const queryClient = useQueryClient();
  const t = useT();
  // All-projects overview: the merged, project-stamped rows from App replace the single
  // active client's log. Everything downstream (filters, day-grouping, run-collapse)
  // derives from `rows`, so the whole pipeline is reused unchanged; a per-client read
  // failure rides the inline notice below, never the page-level error (mirrors Radar).
  const rows = useMemo(
    () => (allClients && Array.isArray(allRows) ? allRows : (data?.activity || [])).map(neutralRow),
    [allClients, allRows, data],
  );
  const isLoading = allClients ? allLoading : singleLoading;
  // One quiet inline notice per project whose activity read failed - never blocks the
  // rest of the merged feed (mirrors Radar's allFailed notice markup).
  const failNotice = allClients && allFailed.length ? (
    <div className="glass-panel space-y-1 rounded-2xl px-4 py-2.5">
      {allFailed.map(({ q, client }) => (
        <p key={client.id} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
          <span>{t('clientSwitcher.loadFailed', { name: client.displayName })}</span>
          <button type="button" onClick={() => q.refetch()} className="font-bold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light">
            {t('clientSwitcher.retry')}
          </button>
        </p>
      ))}
    </div>
  ) : null;
  const withNotice = (body) => (failNotice ? <div className="space-y-4">{failNotice}{body}</div> : body);
  // Filter across three independent dimensions, ANDed together (C7). Each empty
  // selection is "no constraint", matching the platformFilter convention.
  // - Platform (3g): keep platform-agnostic events (campaign actions, scheduler
  //   start/stop, run) visible even when a platform is selected.
  // - Outcome (failures-only): keep only entry.ok === false.
  // - Action group: keep only entries whose action falls in a selected group.
  // The DEFAULT feed (no group chip selected) answers "what happened to my
  // content", so successful SYSTEM bookkeeping (scheduler ticks, probes, token
  // refreshes, metrics sweeps, cloud reconciliation) stays out of it - a system
  // FAILURE always surfaces. Selecting the System chip shows everything in it;
  // the reveal line at the feed foot is the one-click path there.
  const baseFiltered = useMemo(
    () =>
      rows.filter(
        (e) =>
          (!platformFilter.length || e.platform == null || platformFilter.includes(e.platform)) &&
          (!failuresOnly || e.ok === false),
      ),
    [rows, platformFilter, failuresOnly],
  );
  const activity = useMemo(
    () =>
      baseFiltered.filter((e) => (actionGroups.length
        ? actionGroups.includes(actionGroupOf(e.action))
        : actionGroupOf(e.action) !== 'system' || e.ok === false)),
    [baseFiltered, actionGroups],
  );
  const hiddenSystemCount = useMemo(
    () => (actionGroups.length ? 0 : baseFiltered.filter((e) => actionGroupOf(e.action) === 'system' && e.ok !== false).length),
    [baseFiltered, actionGroups],
  );
  // Post-headline lookup for humanized rows: what the operator recognises is the
  // caption's first line, not a campaign/post slug pair.
  const postTitles = useMemo(() => {
    const m = new Map();
    for (const c of campaigns || []) {
      for (const p of c.posts || []) {
        const line = (p.title || (p.caption || '').split('\n').find((l) => l.trim()) || '').trim();
        // A caption whose "first line" is a whole paragraph (Radar replies) must
        // not flood the row: a headline is at most one glance wide.
        if (line) m.set(`${c.id}|${p.id}`, line.length > 80 ? `${line.slice(0, 80).trimEnd()}…` : line);
      }
    }
    return m;
  }, [campaigns]);
  const groups = useMemo(() => {
    const out = [];
    let cur = null;
    for (const e of activity) {
      const k = dayKey(e.ts);
      if (!cur || cur.key !== k) {
        cur = { key: k, header: dayHeader(e.ts, t), entries: [] };
        out.push(cur);
      }
      // Collapse a run of adjacent identical entries (same action/post/outcome/
      // message) into ONE row carrying a count + time range, so a still-deferred
      // post logged every scheduler tick reads as a single line instead of
      // flooding the feed. The activity feed is newest-first, so each next match
      // is older -> it extends the range's "from" end. Collapsing happens inside
      // a day group (cur is per-day), so it never crosses a Heute/Gestern break.
      const prev = cur.entries[cur.entries.length - 1];
      if (prev && collapseKey(prev) === collapseKey(e)) {
        prev.count += 1;
        prev.tsFrom = e.ts;
      } else {
        cur.entries.push({ ...e, count: 1, tsFrom: e.ts, tsTo: e.ts });
      }
    }
    return out;
  }, [activity, t]);

  if (isLoading) {
    return withNotice(<div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>);
  }
  // A per-client read failure in the overview rides the inline notice above, never this
  // page-level error - one dead project never blanks the merged feed (mirrors App's
  // isError = allClients ? false : plansIsError).
  if (!allClients && isError) {
    return (
      <div className="grid h-full min-h-48 place-items-center">
        <div className="max-w-sm space-y-3 text-center">
          <AlertTriangle className="mx-auto text-amber-500" size={26} aria-hidden="true" />
          <p className="text-sm font-bold">{t('activity.error.title')}</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {t('activity.error.body')}
          </p>
          <ActionButton
            icon={RefreshCw}
            className="mx-auto"
            labels={{ idle: t('activity.reload.idle'), loading: t('activity.reload.loading'), success: t('activity.reload.success'), error: t('keys.refresh.error') }}
            onAction={() => queryClient.refetchQueries({ queryKey: ['activity'] })}
          />
        </div>
      </div>
    );
  }
  if (!activity.length) {
    // A filter that hides every row must not read as "the system logged nothing"
    // (the opposite of the truth) - mirror the sibling surfaces (planner, assets,
    // published) and point at the filter bar above when any filter is active.
    const filtered = Boolean(platformFilter.length || failuresOnly || actionGroups.length);
    return withNotice(
      <div className="grid h-full min-h-48 place-items-center">
        <div className="max-w-sm space-y-2 text-center">
          <ActivityIcon className="mx-auto text-zinc-500" size={26} aria-hidden="true" />
          <p className="text-sm font-bold">{t(filtered ? 'activity.empty.filteredTitle' : 'activity.empty.title')}</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {t(filtered ? 'activity.empty.filteredBody' : 'activity.empty.body')}
          </p>
          {/* US-ACT-20: the one-click way out of a filter that hides everything -
              the empty state carries the clear action itself instead of only
              pointing at the toolbar. */}
          {filtered && typeof onClearFilters === 'function' ? (
            <button type="button" onClick={onClearFilters} className="mx-auto rounded-full px-3 py-1 text-[11px] font-bold text-brand transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light">
              {t('activity.empty.clearFilters')}
            </button>
          ) : null}
          <SystemRevealLine count={hiddenSystemCount} onShowSystem={onShowSystem} t={t} center />
        </div>
      </div>,
    );
  }
  return withNotice(
    <div className="space-y-5">
      {/* #48: the platform chips above scope the feed to entries TOUCHING the
          selected platform. The short scoped cue stays inline; the fuller
          "platform-agnostic events (campaigns, scheduler, token) always stay
          visible" explanation moves into a tooltip on demand rather than standing
          as a permanent sentence over the feed (progressive disclosure). */}
      {platformFilter.length ? (
        <p className="flex items-center gap-1 px-1 text-[11px] text-zinc-500 dark:text-zinc-400">
          {t('activity.filter.scoped')}
          <Tip label={t('activity.filter.note')}>
            <button
              type="button"
              aria-label={t('activity.filter.note')}
              className="rounded text-zinc-500 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-300"
            >
              <Info size={12} aria-hidden="true" />
            </button>
          </Tip>
        </p>
      ) : null}
      <div role="log" aria-live="polite" aria-relevant="additions" className="space-y-5">
        {groups.map((g) => (
          <section key={g.key}>
            <h3 className="mb-1.5 px-1 font-display text-sm font-bold text-zinc-500 dark:text-zinc-400">{g.header}</h3>
            <div className="space-y-1.5">
              {g.entries.map((entry, i) => <Row key={`${entry.ts}-${i}`} entry={entry} onOpenPost={onOpenPost} onNavigate={onNavigate} postTitle={entry.postId ? postTitles.get(`${entry.campaign}|${entry.postId}`) || null : null} />)}
            </div>
          </section>
        ))}
      </div>
      <SystemRevealLine count={hiddenSystemCount} onShowSystem={onShowSystem} t={t} />
    </div>,
  );
}
