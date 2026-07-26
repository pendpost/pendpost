import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, XCircle, Clock, Activity as ActivityIcon, AlertTriangle, RefreshCw, ChevronRight, Wrench, Star, Send, CornerDownRight, AlertCircle, ShieldAlert, Info } from 'lucide-react';
import { useActivity, useReviews, replyToReview } from '../lib/api.js';
import { useInboundEvents } from '../lib/cloud.js';
import { useT } from '../lib/i18n.js';
import { Skeleton, PLATFORM_META, INNER_SURFACE, FIELD_SURFACE, DISABLED_PRIMARY } from './ui.jsx';
import { Tip } from './ui/Tooltip.jsx';
import ActionButton from './ui/ActionButton.jsx';
import { dayKey, fmtTime, dateLocale } from '../lib/format.js';

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
  // Meta action-block / rate-limit -> the Meta lane cadence + pause controls.
  if (code === 'blocked_368' || /action block|\b368\b|rate.?limit/i.test(msg)) {
    return { kind: 'metaCadence', ctaKey: 'activity.fix.metaCadence' };
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
  'meta-block': 'activity.action.metaBlock',
  'meta-unblock': 'activity.action.metaUnblock',
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
  // GBP reviews (spec 03): a review received (logged on read) + an owner reply the
  // operator sent. Both file into the SAME inbox group as the comment actions.
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
};

// Maps an action id to the i18n key for its NOTE body (data, not UI text), so a
// structured code drives the localized message instead of leaking the raw
// English errorMessage into the de-CH UI. Mirrors ACTION_LABEL: resolved through
// t() at render. Unmapped actions fall back to the raw entry.errorMessage below.
const ACTION_NOTE = {
  'cloud-backstop': 'activity.note.cloudBackstop',
  'cadence-defer': 'activity.note.cadenceDefer',
};

// C7: a SMALL fixed set of action GROUPS (curated, like STATUS_FILTERS) that
// fold the ~30 ACTION_LABEL ids above into one chip each. Data, not UI - the
// labels resolve through t() at render via the activity.action.group.* keys.
// `actions` lists every ACTION_LABEL id that belongs to the group; anything not
// claimed by a named group falls into 'other'. Module-scope so the grouping
// stays data next to ACTION_LABEL rather than UI in App.jsx.
export const ACTION_GROUPS = [
  { key: 'publish', label: 'activity.action.group.publish', actions: ['publish-reel', 'publish-story', 'publish', 'mark-posted', 'publish-due', 'post-comment', 'set-alt', 'set-caption', 'set-seo', 'post-edit', 'discord-event'] },
  { key: 'schedule', label: 'activity.action.group.schedule', actions: ['schedule-native', 'reschedule', 'unschedule'] },
  { key: 'approval', label: 'activity.action.group.approval', actions: ['approve', 'reject'] },
  // The SYSTEM group: bookkeeping the machine does for itself (scheduler ticks,
  // liveness probes, token refreshes, metrics sweeps, cloud reconciliation). These
  // are audit, not content events - the default feed HIDES their successes (a
  // failure always surfaces) behind the one reveal line at the feed foot, so
  // "what happened to my posts" leads and "what the daemon did" is one click away.
  { key: 'system', label: 'activity.action.group.system', actions: ['scheduler-start', 'scheduler-stop', 'run', 'engine-run', 'probe', 'token-refresh', 'insights', 'insights-fetch', 'cloud-reconcile', 'cloud-backstop', 'client-activate', 'client-create', 'client-update', 'client-archive', 'client-unarchive'] },
  // 'cadence-defer' (Meta lane throttle) belongs with the Meta blocks, not with
  // real publishes - so one chip isolates/hides the throttle noise.
  { key: 'meta-block', label: 'activity.action.group.metaBlock', actions: ['circuit-breaker', 'meta-block', 'meta-unblock', 'cadence-defer'] },
  { key: 'campaign', label: 'activity.action.group.campaign', actions: ['campaign-create', 'campaign-activate', 'campaign-deactivate'] },
  // The inbound-engagement (inbox) bucket (spec 02, Pattern P6): the cross-post reply
  // feed. Specs 06 (moderation) + 24 (reactions) file their actions into THIS group;
  // spec 03 (GBP reviews) adds review-received/review-reply to the SAME one chip.
  { key: 'inbox', label: 'activity.action.group.inbox', actions: ['comment-reply', 'comment-received', 'comment-moderate', 'comment-react', 'review-received', 'review-reply'] },
  { key: 'other', label: 'activity.action.group.other', actions: [] },
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
function collapseKey(e) {
  return `${e.action}|${e.campaign ?? ''}|${e.postId ?? ''}|${e.ok ? 1 : 0}|${e.errorMessage ?? ''}`;
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
  // Note body: a mapped action code resolves to a localized note (so the de-CH UI
  // never leaks raw English); otherwise fall back to the raw errorMessage (with its
  // code prefix) so unmapped/error notes still show rather than going blank.
  const noteText = ACTION_NOTE[entry.action]
    ? t(ACTION_NOTE[entry.action])
    : entry.errorMessage
      ? `${entry.errorCode ? `${entry.errorCode}: ` : ''}${entry.errorMessage}`
      : null;
  // A failed row with a specific, actionable fix shows a single amber wrench CTA
  // (jumps straight to the fix); the row is then a plain div - the wrench is the
  // only interactive control, so no nesting. Generic failures keep the
  // whole-row-opens-the-post behavior below (US-ACT-10, no dead ends).
  const remediation = resolveRemediation(entry);
  const doFix = () => {
    if (remediation?.kind === 'edit') onOpenPost?.({ campaign: entry.campaign, id: entry.postId });
    else onNavigate?.('setup', remediation?.kind === 'metaCadence' ? 'facebook' : entry.platform);
  };
  // US-ACT-10: an entry that carries a post is a clickable row that opens it (no
  // dead ends). The error rides as plain text with a native title for the full
  // string, so there is no nested-interactive control inside the row button.
  const openable = Boolean(entry.campaign && entry.postId && onOpenPost) && !remediation;
  // A cadence-defer is a deferral, not a success or failure - render it with the
  // design system's amber "waiting/held" token (Clock), and tone its message
  // amber rather than red (it is informational, the post stays due).
  const isDefer = entry.action === 'cadence-defer';
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
          {entry.postId ? (
            // Humanize the reference: the post's own headline when the plan still
            // carries it (what the operator recognises), the raw campaign/post ids
            // as the hover fallback - and as the visible fallback when the post is
            // gone from the plan (deleted, other client).
            <span title={`${entry.campaign} / ${entry.postId}`} className="ml-1.5 font-normal text-zinc-500 dark:text-zinc-400">
              {postTitle || `${entry.campaign} / ${entry.postId}`}
            </span>
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
          <p title={noteText} className={`max-w-full truncate text-[11px] ${entry.ok === false ? 'text-red-600/90 dark:text-red-300/90' : isDefer ? 'text-amber-600/90 dark:text-amber-300/90' : 'text-zinc-500 dark:text-zinc-400'}`}>{noteText}</p>
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
        aria-label={t('activity.row.open', { campaign: entry.campaign, postId: entry.postId })}
        onClick={() => onOpenPost({ campaign: entry.campaign, id: entry.postId })}
        className={cls}
      >
        {inner}
      </button>
    );
  }
  return <div className={cls}>{inner}</div>;
}

// A single GBP review row (spec 03, Pattern P6). A review is about the LOCATION, not
// any pendpost post, so it has no PostDetail to open - the reply affordance lives on the
// row itself (the new inbound-reply control this spec adds). Star rating + author +
// one-tone text; a review that already carries an owner reply - or one just replied to -
// renders a neutral "replied" note with an Edit affordance instead of the box. The reply
// upserts idempotently (PUT), so editing re-sends and an empty send removes.
const REPLY_FIELD_CLS = `w-full resize-y rounded-xl border-0 px-3 py-2 text-sm ${FIELD_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`;

function ReviewRow({ review, onReply, t }) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(null);
  const [sentReply, setSentReply] = useState(undefined); // undefined = untouched; string|null = local override
  const [busy, setBusy] = useState(false);
  const meta = PLATFORM_META.gbp;
  const rating = Number(review.rating) || 0;
  // The effective reply: a locally-sent one overrides the server value (append-only feed
  // means the server row won't refresh until the next fetch); null = locally removed.
  const currentReply = sentReply === undefined ? (review.reply || null) : sentReply;
  const submit = async (removing) => {
    const text = removing ? '' : draft.trim();
    if (!removing && !text) return;
    setError(null);
    setBusy(true);
    try {
      await onReply(review.commentId, text);
      setSentReply(removing ? null : text);
      setDraft('');
      setOpen(false);
    } catch (err) {
      setError(err?.message || t('reviews.reply.error'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={`space-y-2 rounded-xl px-3 py-2.5 ${INNER_SURFACE}`}>
      <div className="flex flex-wrap items-center gap-2">
        {meta?.Icon ? <meta.Icon size={13} className={meta.color} aria-hidden="true" /> : null}
        <span className="text-sm font-bold">{review.author || t('reviews.unknownAuthor')}</span>
        {rating ? (
          <span className="inline-flex items-center gap-0.5" role="img" aria-label={t('reviews.rating.aria', { n: rating })}>
            {[1, 2, 3, 4, 5].map((i) => (
              <Star key={i} size={12} className={i <= rating ? 'fill-amber-400 text-amber-400' : 'text-zinc-300 dark:text-zinc-600'} aria-hidden="true" />
            ))}
            <span className="ml-0.5 text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">{rating}/5</span>
          </span>
        ) : null}
      </div>
      {review.text ? <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{review.text}</p> : null}
      {open ? (
        <div className="space-y-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={t('reviews.reply.placeholder')}
            placeholder={t('reviews.reply.placeholder')}
            rows={2}
            className={REPLY_FIELD_CLS}
          />
          {error ? (
            <p role="alert" className="flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-300">
              <AlertCircle size={11} aria-hidden="true" /> {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => submit(false)}
              disabled={busy || !draft.trim()}
              className={`inline-flex items-center gap-1.5 rounded-xl bg-brand px-2.5 py-1.5 text-xs font-bold text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${DISABLED_PRIMARY}`}
            >
              <Send size={13} aria-hidden="true" /> {t('reviews.reply.submit')}
            </button>
            {currentReply ? (
              <button
                type="button"
                onClick={() => submit(true)}
                disabled={busy}
                className="rounded-xl px-2.5 py-1.5 text-xs font-bold text-red-600 transition hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 dark:text-red-300"
              >
                {t('reviews.reply.remove')}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => { setOpen(false); setDraft(''); setError(null); }}
              className="rounded-xl px-2.5 py-1.5 text-xs font-bold text-zinc-500 transition hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              {t('reviews.reply.cancel')}
            </button>
          </div>
        </div>
      ) : currentReply ? (
        <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
          <p className="flex min-w-0 items-start gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-300">
            <CornerDownRight size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span className="break-words">{currentReply}</span>
          </p>
          <button
            type="button"
            onClick={() => { setDraft(currentReply); setOpen(true); }}
            className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-zinc-500 transition hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            <CornerDownRight size={11} aria-hidden="true" /> {t('reviews.reply.edit')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 text-xs font-bold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light"
        >
          <CornerDownRight size={12} aria-hidden="true" /> {t('reviews.reply.open')}
        </button>
      )}
    </li>
  );
}

// The webhook/realtime ingestion seam (spec 23, Pattern P8 -> feeds P6): one row per
// normalized inbound event (comment/mention/message/reaction). Display/attribution
// only - no reply affordance here (that is specs 02/06/24's PostDetail thread panel,
// unchanged by this item); it just shows WHAT arrived, per platform, newest first.
const EVENT_TYPE_KEY = { comment: 'inbox.event.comment', mention: 'inbox.event.mention', message: 'inbox.event.message', reaction: 'inbox.event.reaction' };
function InboundEventRow({ event, t }) {
  const meta = event.platform ? PLATFORM_META[event.platform] : null;
  const author = event.author?.displayName || event.author?.handle || t('reviews.unknownAuthor');
  return (
    <li className={`flex items-start gap-3 rounded-xl px-3 py-2.5 ${INNER_SURFACE}`}>
      {meta?.Icon ? <meta.Icon size={13} className={`mt-0.5 shrink-0 ${meta.color}`} aria-hidden="true" /> : null}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-bold">
          {EVENT_TYPE_KEY[event.type] ? t(EVENT_TYPE_KEY[event.type]) : event.type}
          <span className="ml-1.5 font-normal text-zinc-500 dark:text-zinc-400">{author}</span>
        </p>
        {event.text ? <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{event.text}</p> : null}
        {/* NIT-6 (spec 23 review): the reaction glyph must carry its own accessible
            value - aria-hidden left a screen reader announcing "Reaction · author ·
            time" with no indication of WHICH reaction. Not aria-hidden, so the emoji's
            own accessible name (e.g. "thumbs up") is read exactly like the reaction
            row it mirrors in postDetail's comment thread. */}
        {event.reaction ? <p className="text-sm">{event.reaction}</p> : null}
      </div>
      <p className="shrink-0 whitespace-nowrap text-[11px] text-zinc-500 dark:text-zinc-400">
        {fmtTime(event.ts)}
        {meta ? ` · ${meta.label}` : ''}
      </p>
    </li>
  );
}

// The inbound-event feed block (spec 23): rides the SAME inbox chip as the GBP reviews
// block above (no new page, no competing chip) - it just answers "what arrived" instead
// of "what needs a reply". The feed is READ-ONLY here (pull-on-demand, refetches while
// the Activity page is open); it is EMPTY until the pendpost-cloud webhook receiver
// ships (§4c, a separate-repo companion), so the honest, expected state today is the
// neutral empty note below - never a fake feed. A background-fetch failure keeps
// react-query's last-known `data` (fails open server-side, so there is no distinct error
// state to render - the header cloud dot already reflects a degraded connection).
function InboundEventsInbox({ active, platformFilter, t }) {
  const { data, isLoading } = useInboundEvents(active);
  const items = Array.isArray(data?.events) ? data.events : [];
  const filtered = items.filter((e) => !platformFilter.length || platformFilter.includes(e.platform));
  if (isLoading && !data) {
    return <div className="space-y-1.5">{[0, 1].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>;
  }
  if (filtered.length === 0) {
    return <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400">{t('inbox.empty')}</p>;
  }
  return <ul className="space-y-1.5">{filtered.map((e) => <InboundEventRow key={e.eventId} event={e} t={t} />)}</ul>;
}

// The GBP reviews inbox (spec 03): reviews ride the SAME Activity inbox chip as comments
// (no new page, no competing chip), but - unlike comments - have NO PostDetail, so this
// is the ONE interactive surface. Reading also logs new reviews as review-received
// Activity entries server-side (audit); those are filtered out of the day feed below so
// the review is not shown twice. Every state is icon+text: loading -> skeleton; a project
// pending Google approval -> an amber "authorize in Setup" affordance (the same setup
// wrench pattern the feed's resolveRemediation uses); empty -> the shared empty copy;
// error -> an inline red row; success -> the review rows with their reply boxes.
function ReviewsInbox({ active, onNavigate }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useReviews(active);
  const onReply = async (reviewId, text) => {
    await replyToReview(reviewId, text);
    queryClient.invalidateQueries({ queryKey: ['reviews'] });
    queryClient.invalidateQueries({ queryKey: ['activity'] });
  };
  const items = Array.isArray(data?.items) ? data.items : [];
  // A not-connected GBP lane (the account/location ids are unset) is NOT an error - the
  // engine returns code:'not_configured', which the operator sees as SILENCE: render the
  // WHOLE section as nothing, so there is no red alert AND no lingering "Reviews" header
  // that would misread as "zero reviews" (spec-06 paused-lane honesty). The error block
  // below stays reserved for a genuine read failure (engine_failure / network).
  if (data && data.ok === false && data.code === 'not_configured') return null;
  let body;
  if (isLoading) {
    body = <div className="space-y-1.5">{[0, 1].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>;
  } else if (isError || (data && data.ok === false)) {
    body = (
      <p role="alert" className={`flex flex-wrap items-center gap-1.5 rounded-xl px-3 py-2.5 text-xs text-red-600 dark:text-red-300 ${INNER_SURFACE}`}>
        <AlertCircle size={13} aria-hidden="true" /> {t('reviews.error')}
        {(data?.message || data?.error) ? <span className="text-zinc-500 dark:text-zinc-400">{data.message || data.error}</span> : null}
      </p>
    );
  } else if (data?.needsScope) {
    body = (
      <div className={`flex flex-wrap items-center gap-2 rounded-xl px-3 py-2.5 text-xs ${INNER_SURFACE}`}>
        <span className="flex items-center gap-1.5 font-bold text-amber-600 dark:text-amber-300">
          <ShieldAlert size={13} aria-hidden="true" /> {t('reviews.scope.pending')}
        </span>
        <button
          type="button"
          onClick={() => onNavigate?.('setup', 'gbp')}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold text-amber-700 ring-1 ring-amber-500/30 transition hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-amber-300 dark:ring-amber-400/30"
        >
          <Wrench size={12} aria-hidden="true" /> {t('reviews.scope.authorize')}
        </button>
      </div>
    );
  } else if (items.length === 0) {
    body = (
      <div className="grid min-h-24 place-items-center">
        <div className="max-w-sm space-y-1 text-center">
          <p className="text-sm font-bold">{t('reviews.empty.title')}</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('reviews.empty.body')}</p>
        </div>
      </div>
    );
  } else {
    body = <ul className="space-y-1.5">{items.map((r) => <ReviewRow key={r.commentId} review={r} onReply={onReply} t={t} />)}</ul>;
  }
  return (
    <section className="space-y-1.5" aria-label={t('reviews.title')}>
      <h3 className="mb-1.5 px-1 font-display text-sm font-bold text-zinc-500 dark:text-zinc-400">{t('reviews.title')}</h3>
      {body}
    </section>
  );
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

export default function ActivityView({ active, platformFilter = [], failuresOnly = false, actionGroups = [], campaigns = [], onOpenPost, onNavigate, onShowSystem, onClearFilters }) {
  const { data, isLoading, isError } = useActivity(active);
  const queryClient = useQueryClient();
  const t = useT();
  // Filter across three independent dimensions, ANDed together (C7). Each empty
  // selection is "no constraint", matching the platformFilter convention.
  // - Platform (3g): keep platform-agnostic events (campaign actions, scheduler
  //   start/stop, run) visible even when a platform is selected.
  // - Outcome (failures-only): keep only entry.ok === false.
  // - Action group: keep only entries whose action falls in a selected group.
  // Reviews (spec 03) ride the inbox chip; the interactive rows render in ReviewsInbox
  // below. The block respects the SAME filters as the day feed (MINOR-5): it only shows
  // when the inbox group is selected AND gbp is not excluded by the platform filter AND
  // failures-only is off (a review is inbound engagement, never a failure - nothing to
  // show under failures-only). When the block IS showing, its audit 'review-received'
  // entries are filtered OUT of the day feed (never shown twice); when it is NOT showing,
  // those entries STAY in the day feed as plain audit rows so they are never permanently
  // invisible (NIT-7). The operator-action 'review-reply' entries always stay in the feed
  // as audit, exactly like 'comment-reply'.
  const gbpInFilter = !platformFilter.length || platformFilter.includes('gbp');
  const showReviews = actionGroups.includes('inbox') && gbpInFilter && !failuresOnly;
  // The inbound-event feed (spec 23) rides the SAME inbox chip - it spans several
  // platforms (not one lane like GBP reviews), so it is not gated by gbpInFilter; its
  // own platformFilter narrowing happens inside InboundEventsInbox. A review is inbound
  // engagement, never a failure, and neither is a raw inbound event - so it is likewise
  // hidden under failures-only (mirrors showReviews).
  const showInbound = actionGroups.includes('inbox') && !failuresOnly;
  // The DEFAULT feed (no group chip selected) answers "what happened to my
  // content", so successful SYSTEM bookkeeping (scheduler ticks, probes, token
  // refreshes, metrics sweeps, cloud reconciliation) stays out of it - a system
  // FAILURE always surfaces. Selecting the System chip shows everything in it;
  // the reveal line at the feed foot is the one-click path there.
  const baseFiltered = useMemo(
    () =>
      (data?.activity || []).filter(
        (e) =>
          (!showReviews || e.action !== 'review-received') &&
          (!platformFilter.length || e.platform == null || platformFilter.includes(e.platform)) &&
          (!failuresOnly || e.ok === false),
      ),
    [data, platformFilter, failuresOnly, showReviews],
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
  // Prepend the inbound-event feed + the GBP reviews inbox when the inbox chip is
  // selected. When neither shows, the feed renders byte-identically to before (no
  // wrapper), so no other view is touched.
  const withInboxExtras = (feed) => ((showInbound || showReviews)
    ? (
      <div className="space-y-5">
        {showInbound ? <InboundEventsInbox active={active} platformFilter={platformFilter} t={t} /> : null}
        {showReviews ? <ReviewsInbox active={active} onNavigate={onNavigate} /> : null}
        {feed}
      </div>
    )
    : feed);
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
    return withInboxExtras(<div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>);
  }
  if (isError) {
    return withInboxExtras(
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
    return withInboxExtras(
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
  return withInboxExtras(
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
