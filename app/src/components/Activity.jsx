import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, XCircle, Clock, Activity as ActivityIcon, AlertTriangle, RefreshCw, ChevronRight, Wrench } from 'lucide-react';
import { useActivity } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { Skeleton, PLATFORM_META } from './ui.jsx';
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
  'set-thumbnail': 'activity.action.setThumbnail',
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
  { key: 'publish', label: 'activity.action.group.publish', actions: ['publish-reel', 'publish-story', 'publish', 'mark-posted', 'publish-due'] },
  { key: 'schedule', label: 'activity.action.group.schedule', actions: ['schedule-native', 'reschedule', 'unschedule'] },
  { key: 'approval', label: 'activity.action.group.approval', actions: ['approve', 'reject'] },
  { key: 'scheduler-run', label: 'activity.action.group.schedulerRun', actions: ['scheduler-start', 'scheduler-stop', 'run', 'engine-run', 'probe'] },
  // 'cadence-defer' (Meta lane throttle) belongs with the Meta blocks, not with
  // real publishes - so one chip isolates/hides the throttle noise.
  { key: 'meta-block', label: 'activity.action.group.metaBlock', actions: ['circuit-breaker', 'meta-block', 'meta-unblock', 'cadence-defer'] },
  { key: 'campaign', label: 'activity.action.group.campaign', actions: ['campaign-create', 'campaign-activate', 'campaign-deactivate'] },
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

function Row({ entry, onOpenPost, onNavigate }) {
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
        <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-500" aria-hidden="true" />
      ) : (
        <XCircle size={15} className="mt-0.5 shrink-0 text-red-500" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-bold">
          {ACTION_LABEL[entry.action] ? t(ACTION_LABEL[entry.action]) : entry.action}
          {entry.postId ? (
            <span className="ml-1.5 font-normal text-zinc-500 dark:text-zinc-400">{entry.campaign} / {entry.postId}</span>
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
      <p className="shrink-0 whitespace-nowrap text-[11px] text-zinc-400 dark:text-zinc-500">
        {count > 1 ? `${fmtTime(entry.tsFrom)}–${fmtTime(entry.tsTo)}` : fmtTime(entry.ts)}
        {meta ? ` · ${meta.label}` : ''}
        {entry.lateMin ? ` · ${t('activity.row.minLate', { n: entry.lateMin })}` : ''}
        {entry.actor ? ` · ${entry.actor}` : ''}
      </p>
      {openable ? (
        <ChevronRight size={14} className="mt-0.5 shrink-0 text-zinc-400 transition group-hover:translate-x-0.5" aria-hidden="true" />
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

export default function ActivityView({ active, platformFilter = [], failuresOnly = false, actionGroups = [], onOpenPost, onNavigate }) {
  const { data, isLoading, isError } = useActivity(active);
  const queryClient = useQueryClient();
  const t = useT();
  // Filter across three independent dimensions, ANDed together (C7). Each empty
  // selection is "no constraint", matching the platformFilter convention.
  // - Platform (3g): keep platform-agnostic events (campaign actions, scheduler
  //   start/stop, run) visible even when a platform is selected.
  // - Outcome (failures-only): keep only entry.ok === false.
  // - Action group: keep only entries whose action falls in a selected group.
  const activity = useMemo(
    () =>
      (data?.activity || []).filter(
        (e) =>
          (!platformFilter.length || e.platform == null || platformFilter.includes(e.platform)) &&
          (!failuresOnly || e.ok === false) &&
          (!actionGroups.length || actionGroups.includes(actionGroupOf(e.action))),
      ),
    [data, platformFilter, failuresOnly, actionGroups],
  );
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
    return <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>;
  }
  if (isError) {
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
    return (
      <div className="grid h-full min-h-48 place-items-center">
        <div className="max-w-sm space-y-2 text-center">
          <ActivityIcon className="mx-auto text-zinc-400" size={26} aria-hidden="true" />
          <p className="text-sm font-bold">{t(filtered ? 'activity.empty.filteredTitle' : 'activity.empty.title')}</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {t(filtered ? 'activity.empty.filteredBody' : 'activity.empty.body')}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      {/* #48: the platform chips above scope the feed to entries TOUCHING the
          selected platform; platform-agnostic events (campaigns, scheduler,
          token) always stay visible. */}
      {platformFilter.length ? (
        <p className="px-1 text-[11px] text-zinc-400 dark:text-zinc-500">
          {t('activity.filter.scoped')} · {t('activity.filter.note')}
        </p>
      ) : null}
      <div role="log" aria-live="polite" aria-relevant="additions" className="space-y-5">
        {groups.map((g) => (
          <section key={g.key}>
            <h3 className="mb-1.5 px-1 font-display text-sm font-bold text-zinc-500 dark:text-zinc-400">{g.header}</h3>
            <div className="space-y-1.5">
              {g.entries.map((entry, i) => <Row key={`${entry.ts}-${i}`} entry={entry} onOpenPost={onOpenPost} onNavigate={onNavigate} />)}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
