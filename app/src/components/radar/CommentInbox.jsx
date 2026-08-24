import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  MessageSquare, RefreshCw, Settings as SettingsIcon, CornerDownRight, ExternalLink,
  AlertCircle, ShieldAlert, Check, Inbox, Heart, HelpCircle, Loader2,
} from 'lucide-react';
import { useConfig, useCommentInbox, refreshCommentInbox, resolveInboxComment, saveConfig, reactToPost } from '../../lib/api.js';
import { fmtRelative } from '../../lib/format.js';
import { INNER_SURFACE, EYEBROW, DISABLED_PRIMARY, PLATFORM_META, Skeleton } from '../ui.jsx';
import { PROJECT_CHIP } from '../ui/recipes.js';
import { ClientAvatar } from '../ClientSwitcher.jsx';
import { Tip } from '../ui/Tooltip.jsx';
import CommentsPanel from '../CommentsPanel.jsx';
import { useT } from '../../lib/i18n.js';

// The Radar "On your posts" segment: the own-post comment inbox. It reuses the exact
// listComments/replyToComment seam (via CommentsPanel) for each post's thread; this component
// only adds the AGGREGATION - one list of the posts with unanswered comments the sweep found,
// newest comment first, each expandable to its live thread. Distinct data path from the
// Discovered feed (state.comments, GET /api/comments/inbox), co-located here in one engagement
// surface. All states covered: monitoring-off / loading / empty / per-lane degrade / populated.

// A muted per-lane label for the "can't read here" degrade rows.
const LANE_LABEL = {
  meta: 'Meta', youtube: 'YouTube', linkedin: 'LinkedIn', wordpress: 'WordPress',
  reddit: 'Reddit', tiktok: 'TikTok', telegram: 'Telegram', mastodon: 'Mastodon',
  nostr: 'Nostr', discord: 'Discord',
};

// One post row: the post's platform glyph + caption, an unanswered/new count, the latest
// comment preview, a primary Reply (expands the thread) and a quiet "Mark handled" overflow.
function PostRow({ group, isNew, onResolveAll, onReplied, t }) {
  const [open, setOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [liked, setLiked] = useState(false);
  const [liking, setLiking] = useState(false);
  const [likeError, setLikeError] = useState(null);
  const meta = PLATFORM_META[group.platform] || null;
  const Glyph = meta?.Icon || MessageSquare;
  const latest = group.comments[0];
  const newCount = group.comments.filter(isNew).length;
  // The name opens the comment on the platform: the exact comment where the lane gives
  // a per-comment link (Mastodon/Reddit), else the post (fills Instagram via verify).
  const authorHref = latest ? (latest.permalink || group.permalink || null) : null;
  // A one-click like on the latest comment, only where the lane's capability allows it
  // (Mastodon favourite / LinkedIn/Nostr like). Meta/YouTube/Reddit expose none. Mirrors
  // CommentsPanel runReact: optimistic local state, passes author as the nostr pubkey arg.
  const likeVerb = group.reactActions?.includes('favourite') ? 'favourite'
    : group.reactActions?.includes('like') ? 'like' : null;
  const toggleLike = async () => {
    if (liking || !latest || !likeVerb) return;
    const next = !liked;
    setLiked(next);
    setLiking(true);
    setLikeError(null);
    try {
      // group.clientId is stamped only in the all-projects overview - it scopes the
      // like to the comment's own project; undefined single-client, a no-op.
      await reactToPost(group.campaign, group.postId, latest.commentId, likeVerb, group.platform, undefined, !next, latest.author, group.clientId);
    } catch (e) {
      setLiked(!next);
      setLikeError(e?.message || t('comments.inbox.error'));
    } finally {
      setLiking(false);
    }
  };
  // A post with unseen comments carries the same quiet brand wash + accent ring as an unseen
  // Discovered row (one design language), so new arrivals are scannable without a colour-only cue.
  const hasNew = newCount > 0;
  return (
    <li className={`space-y-2 rounded-xl p-3 ring-1 transition ${open ? 'bg-zinc-900/[0.02] ring-zinc-900/5 dark:bg-white/[0.03] dark:ring-white/10' : hasNew ? 'bg-brand/[0.04] ring-brand/20' : 'ring-zinc-900/5 dark:ring-white/10'}`}>
      <div className="flex items-start gap-2">
        <Glyph size={15} className={`mt-0.5 shrink-0 ${meta?.color || 'text-zinc-500'}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="truncate text-sm font-bold">{group.caption || t('comments.inbox.untitledPost')}</span>
            {/* All-projects overview: which project this post belongs to. Stamped by App
                only in that mode (single-client never stamps, so nothing renders) -
                matches the Planner/Freigaben/Radar chip exactly. */}
            {group.clientName ? (
              <span className={`${PROJECT_CHIP} max-w-[8rem]`}>
                <ClientAvatar client={{ displayName: group.clientName, accent: group.accent, logo: null }} size={14} />
                <span className="truncate">{group.clientName}</span>
              </span>
            ) : null}
            {newCount > 0 ? (
              <span className="rounded-full bg-brand/10 px-1.5 py-0.5 text-[11px] font-bold text-brand dark:text-brand-light">{t('comments.inbox.newCount', { n: newCount })}</span>
            ) : (
              <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('comments.inbox.waitingCount', { n: group.unanswered })}</span>
            )}
            {group.lastCommentTs ? <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{fmtRelative(group.lastCommentTs)}</span> : null}
          </div>
          {/* Latest comment preview, so the row is legible without expanding. The author name
              opens the comment on the platform (exact comment where available, else the post). */}
          {latest ? (
            <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
              {authorHref ? (
                <a href={authorHref} target="_blank" rel="noopener noreferrer" className="font-semibold text-zinc-600 transition hover:text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-300 dark:hover:text-brand-light" aria-label={t('comments.inbox.openAuthorComment', { author: latest.author })}>{latest.author}</a>
              ) : (
                <span className="font-semibold text-zinc-600 dark:text-zinc-300">{latest.author}</span>
              )}{' '}{latest.text}
            </p>
          ) : null}
        </div>
        {group.permalink ? (
          <a href={group.permalink} target="_blank" rel="noopener noreferrer" className="mt-0.5 shrink-0 text-zinc-500 transition hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-brand-light" aria-label={t('comments.inbox.openPost')}>
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        ) : null}
      </div>
      <div className="flex items-center gap-x-3">
        {/* Quiet secondary (left of the primary, canon): mark the post's remaining comments
            handled. Owner-requested ONE-CLICK - a single tap resolves and the row leaves the
            view immediately (the mutation invalidates the inbox); no confirm step in the way.
            Guarded against double-fire: disabled + spinner while the resolve is in flight, so a
            fast second click cannot dispatch a second write. On success the row unmounts. */}
        <button
          type="button"
          disabled={resolving}
          onClick={async () => {
            if (resolving) return;
            setResolving(true);
            try { await onResolveAll(group); } finally { setResolving(false); }
          }}
          className="inline-flex items-center gap-1 text-xs font-bold text-zinc-500 transition hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          {resolving ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Check size={12} aria-hidden="true" />} {t('comments.inbox.markHandled')}
        </button>
        {/* One-click like on the latest comment, glyph-only (like the open-post link above),
            only where the lane supports it. Meta/YouTube/Reddit show nothing (honest absence). */}
        {likeVerb ? (
          <button
            type="button"
            onClick={toggleLike}
            disabled={liking}
            aria-pressed={liked}
            aria-label={liked ? t('comments.inbox.unlike') : t('comments.inbox.like')}
            className={`inline-flex items-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 ${liked ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100'}`}
          >
            <Heart size={13} className={liked ? 'fill-current' : ''} aria-hidden="true" />
          </button>
        ) : null}
        {/* Primary: open the thread to reply/react/moderate (reuses CommentsPanel). */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="ml-auto inline-flex items-center gap-1.5 rounded-xl bg-brand px-2.5 py-1.5 text-xs font-bold text-white transition hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-brand-light dark:text-zinc-900"
        >
          <CornerDownRight size={13} aria-hidden="true" /> {open ? t('comments.inbox.close') : t('comments.inbox.reply')}
        </button>
      </div>
      {likeError ? (
        <p role="alert" className="flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-300">
          <AlertCircle size={11} aria-hidden="true" /> {likeError}
        </p>
      ) : null}
      {open ? (
        <div className="border-t border-zinc-900/5 pt-2 dark:border-white/10">
          <CommentsPanel campaign={group.campaign} postId={group.postId} clientId={group.clientId} onReplied={onReplied(group)} />
        </div>
      ) : null}
    </li>
  );
}

export default function CommentInbox({ onNavigate, allClients = false, allPosts = null, allFailed = [], allLoading = false }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: config } = useConfig(true);
  const cw = config?.posting?.commentWatch || { enabled: false, intervalHours: 4, windowDays: 14 };
  const enabled = cw.enabled === true;
  // In the all-projects overview the merged inbox comes from App (useCommentInboxAll),
  // so the single-client read is off; the enable/settings/refresh chrome (per-client)
  // is skipped and only the merged post list renders (mirrors how Radar hides its
  // per-client control strips). commentWatch's per-client on/off no longer gates the
  // overview - it aggregates whatever inbox every project already has.
  const { data, isLoading, refetch } = useCommentInbox(enabled && !allClients);
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState(null);

  // "New since your last visit" - the same localStorage clock the Discovered feed uses, its
  // own key, so what one pair of eyes has seen is a UI fact, not a workspace fact.
  const [newSince] = useState(() => { try { return localStorage.getItem('pendpost.comments.lastSeen'); } catch { return null; } });
  useEffect(() => { try { localStorage.setItem('pendpost.comments.lastSeen', new Date().toISOString()); } catch { /* storage off - the chip just stays quiet */ } }, []);
  const isNew = (c) => Boolean(newSince && c.foundAt && c.foundAt > newSince);

  const writeCw = async (patch) => {
    if (!config?.rev) return;
    await saveConfig(config.rev, { posting: { commentWatch: { ...patch } } });
    qc.invalidateQueries({ queryKey: ['config'] });
  };
  // The enable CTA: one click turns monitoring on AND kicks off the first sweep, so the inbox
  // fills in without waiting for the scheduler tick. Mirrors onRefresh's try/catch/finally +
  // busy + setError; no retry loop (nothing in the app has one), but the catch invalidates
  // config so a stale rev self-corrects for the next click. The sweep reads live comment
  // threads across every recent post (can take a while), so it is fired best-effort and NOT
  // awaited: the enabled view renders at once, and the sweep lands the inbox when it finishes
  // (the scheduler also sweeps within a tick, so a failed kick is self-healing, not a dead end).
  const enableWatch = async () => {
    if (!config?.rev || writing) return;
    setWriting(true);
    setError(null);
    try {
      await saveConfig(config.rev, { posting: { commentWatch: { enabled: true } } });
      qc.invalidateQueries({ queryKey: ['config'] });
      refreshCommentInbox()
        .then(() => qc.invalidateQueries({ queryKey: ['commentInbox'] }))
        .catch(() => { /* the scheduler sweep will still populate the inbox */ });
    } catch (e) {
      qc.invalidateQueries({ queryKey: ['config'] });
      setError(e?.message || t('comments.inbox.error'));
    } finally {
      setWriting(false);
    }
  };
  const onRefresh = async () => {
    setBusy(true);
    setError(null);
    try { await refreshCommentInbox(); await refetch?.(); qc.invalidateQueries({ queryKey: ['commentInbox'] }); }
    catch (e) { setError(e?.message || t('comments.inbox.error')); }
    finally { setBusy(false); }
  };
  const invalidateInbox = () => qc.invalidateQueries({ queryKey: ['commentInbox'] });
  const surfaceError = (e) => setError(e?.message || t('comments.inbox.error'));
  // A reply handled the comment: mark it resolved by its cached key (looked up by commentId so
  // the right lane's key is used even on a multi-lane post), then refresh the inbox count.
  const onReplied = (group) => (commentId) => {
    const it = group.comments.find((c) => c.commentId === commentId);
    // group.clientId is stamped only in the all-projects overview - it scopes the
    // resolve to the comment's own project; undefined single-client, a no-op.
    if (it?.key) resolveInboxComment(it.key, 'replied', group.clientId).then(invalidateInbox).catch(surfaceError);
  };
  const onResolveAll = (group) => Promise.all(group.comments.map((c) => resolveInboxComment(c.key, 'dismissed', group.clientId))).then(invalidateInbox).catch(surfaceError);

  // All-projects overview: render the merged, project-stamped inbox App fans out. The
  // per-client enable/settings/refresh chrome and the degraded/blocked strips are
  // per-client, so they are skipped here (like Radar's hidden control strips); only the
  // failure notice, loading skeletons, the post list and the empty state remain.
  if (allClients) {
    const merged = allPosts || [];
    return (
      <div className="space-y-3">
        {/* One quiet inline notice per project whose inbox read failed - never blocks the
            rest of the merged feed (mirrors Radar's signal-feed notice). */}
        {allFailed.length ? (
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
        ) : null}
        {error ? (
          <p role="alert" className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs text-red-600 dark:text-red-300">
            <AlertCircle size={13} aria-hidden="true" /> {error}
          </p>
        ) : null}
        {allLoading ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
        ) : merged.length ? (
          <ul className="space-y-2">
            {merged.map((g) => (
              <PostRow key={`${g.clientId || ''}:${g.campaign}:${g.postId}`} group={g} isNew={isNew} onResolveAll={onResolveAll} onReplied={onReplied} t={t} />
            ))}
          </ul>
        ) : (
          <div className={`grid place-items-center rounded-xl p-8 text-center ${INNER_SURFACE}`}>
            <div className="max-w-sm space-y-1.5">
              <MessageSquare size={26} className="mx-auto text-zinc-500" aria-hidden="true" />
              <p className="text-sm font-bold">{t('comments.inbox.empty.title')}</p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('comments.inbox.empty.body')}</p>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Monitoring OFF: the honest opt-in empty state with the enable CTA. Own-post comments are
  // still readable per-post in the post detail; this segment is the aggregated WATCH layer.
  if (!enabled) {
    return (
      <div className={`grid place-items-center rounded-xl p-8 text-center ${INNER_SURFACE}`}>
        <div className="max-w-sm space-y-2">
          <Inbox size={28} className="mx-auto text-zinc-500" aria-hidden="true" />
          <p className="text-sm font-bold">{t('comments.inbox.off.title')}</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('comments.inbox.off.body')}</p>
          <button
            type="button"
            onClick={enableWatch}
            disabled={!config?.rev || writing}
            className={`mt-1 inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-3 text-sm font-bold text-white transition hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-brand-light dark:text-zinc-900 ${DISABLED_PRIMARY}`}
          >
            {writing ? <RefreshCw size={14} className="animate-spin" aria-hidden="true" /> : null}
            {t('comments.inbox.off.enable')}
          </button>
          {/* A failed enable answers what happened with a retryable message, never a silent
              no-op (canon: no dead ends). The off-state returns early, so it needs its own. */}
          {error ? (
            <p role="alert" className="flex items-center justify-center gap-1.5 text-xs text-red-600 dark:text-red-300">
              <AlertCircle size={13} aria-hidden="true" /> {error}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  const posts = data?.posts || [];
  const degraded = Object.entries(data?.sources || {}).filter(([, s]) => s && s.ok === false);
  // Lanes whose comment read cannot run yet (e.g. LinkedIn: CMA product pending). These are NOT
  // monitored and never nag in the feed; the settings list shows them greyed with the reason so
  // the owner knows the platform is off the sweep on purpose, not silently broken.
  const blockedLanes = Object.entries(data?.capabilities || {}).filter(([, c]) => c && c.readAvailable === false);
  const blockedReason = (code) => t(code ? `comments.inbox.blocked.${code}` : 'comments.inbox.blocked.generic');

  return (
    <div className="space-y-3">
      {/* Feed-first: a quiet status line + a small right cluster (check-now + settings). Config
          lives behind the gear, never stacked above the feed (canon: config never leads content). */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {data?.lastSweep ? t('comments.inbox.lastSweep', { time: fmtRelative(data.lastSweep) }) : t('comments.inbox.neverSwept')}
        </p>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={onRefresh} disabled={busy} className="inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-bold text-zinc-600 ring-1 ring-zinc-900/10 transition hover:bg-zinc-900/5 disabled:opacity-50 dark:text-zinc-300 dark:ring-white/10 dark:hover:bg-white/5">
            <RefreshCw size={13} className={busy ? 'animate-spin' : ''} aria-hidden="true" /> {t('comments.inbox.checkNow')}
          </button>
          <button type="button" onClick={() => setSettingsOpen((v) => !v)} aria-expanded={settingsOpen} aria-label={t('comments.inbox.settings')} className="inline-flex items-center justify-center rounded-xl p-1.5 text-zinc-600 ring-1 ring-zinc-900/10 transition hover:bg-zinc-900/5 dark:text-zinc-300 dark:ring-white/10 dark:hover:bg-white/5">
            <SettingsIcon size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* A failed refresh/resolve answers what went wrong with a retry-in-place, never a silent
          swallow (canon: no dead ends). */}
      {error ? (
        <p role="alert" className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs text-red-600 dark:text-red-300">
          <AlertCircle size={13} aria-hidden="true" /> {error}
        </p>
      ) : null}

      {/* Settings disclosure: cadence + rolling window + the off switch. Prefilled defaults. */}
      {settingsOpen ? (
        <div className={`space-y-3 rounded-xl p-3 ${INNER_SURFACE}`}>
          <div className="flex flex-wrap items-end gap-4">
            <label className="space-y-1">
              <span className={EYEBROW}>{t('comments.inbox.setting.interval')}</span>
              {/* key = the stored value: on blur we clamp + save, and the remount makes the field
                  show the ACTUAL saved value rather than the out-of-range text the user typed. */}
              <input key={`iv-${cw.intervalHours}`} type="number" min={1} max={168} defaultValue={cw.intervalHours}
                onBlur={(e) => { const v = Math.max(1, Math.min(168, Number(e.target.value) || 4)); if (v !== cw.intervalHours) writeCw({ intervalHours: v }); }}
                className={`w-20 rounded-lg border-0 px-2 py-1 text-sm ${INNER_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`} />
            </label>
            <label className="space-y-1">
              <span className={EYEBROW}>{t('comments.inbox.setting.window')}</span>
              <input key={`wd-${cw.windowDays}`} type="number" min={1} max={90} defaultValue={cw.windowDays}
                onBlur={(e) => { const v = Math.max(1, Math.min(90, Number(e.target.value) || 14)); if (v !== cw.windowDays) writeCw({ windowDays: v }); }}
                className={`w-20 rounded-lg border-0 px-2 py-1 text-sm ${INNER_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`} />
            </label>
            <button type="button" onClick={() => writeCw({ enabled: false })} className="ml-auto text-xs font-bold text-zinc-500 transition hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-red-300">
              {t('comments.inbox.setting.turnOff')}
            </button>
          </div>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('comments.inbox.setting.hint')}</p>
          {/* Platforms whose comment read cannot run yet: greyed, non-actionable, with the reason
              on a focus-reachable tooltip - honest instead of a broken feed banner (owner: KISS). */}
          {blockedLanes.length ? (
            <div className="space-y-1.5">
              <span className={EYEBROW}>{t('comments.inbox.setting.unavailable')}</span>
              <div className="flex flex-wrap gap-1.5">
                {blockedLanes.map(([lane, c]) => {
                  const lmeta = PLATFORM_META[lane] || null;
                  const LGlyph = lmeta?.Icon || MessageSquare;
                  const why = blockedReason(c.readBlocked);
                  return (
                    <span key={lane} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold text-zinc-500 opacity-70 ring-1 ring-zinc-900/10 dark:text-zinc-400 dark:ring-white/10">
                      <LGlyph size={12} aria-hidden="true" /> {LANE_LABEL[lane] || lane}
                      <Tip label={why}>
                        <button type="button" aria-label={why} className="text-zinc-500 transition hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-200">
                          <HelpCircle size={12} aria-hidden="true" />
                        </button>
                      </Tip>
                    </span>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Per-lane degrade for GENUINE, fixable failures only (structurally-unavailable lanes like
          LinkedIn are skipped by the sweep and greyed in settings instead - never nagged here).
          The message + recovery are keyed to the reason (canon: errors say what happened, why, and
          the one action that recovers), with the "why" on a real focus-reachable tooltip. */}
      {degraded.map(([lane, s]) => {
        const label = LANE_LABEL[lane] || lane;
        const isScope = s.error === 'needs_scope';
        const msg = isScope ? t('comments.inbox.degrade.scope', { lane: label }) : t('comments.inbox.degrade.transient', { lane: label });
        const why = isScope ? t('comments.inbox.degrade.scope.why', { lane: label }) : t('comments.inbox.degrade.transient.why', { lane: label });
        return (
          <div key={lane} className={`flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-xs ${INNER_SURFACE}`}>
            <ShieldAlert size={13} className="text-amber-700 dark:text-amber-300" aria-hidden="true" />
            <span className="font-bold">{msg}</span>
            <Tip label={why}>
              <button type="button" aria-label={why} className="text-zinc-500 transition hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-200">
                <HelpCircle size={13} aria-hidden="true" />
              </button>
            </Tip>
            {isScope ? (
              <button type="button" onClick={() => onNavigate?.('setup', lane)} className="ml-auto font-bold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light">
                {t('comments.inbox.reconnect')}
              </button>
            ) : (
              <button type="button" onClick={onRefresh} disabled={busy} className="ml-auto inline-flex items-center gap-1 font-bold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 dark:text-brand-light">
                <RefreshCw size={12} className={busy ? 'animate-spin' : ''} aria-hidden="true" /> {t('comments.inbox.checkNow')}
              </button>
            )}
          </div>
        );
      })}

      {/* The feed: loading / empty / populated. */}
      {isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
      ) : posts.length ? (
        <ul className="space-y-2">
          {posts.map((g) => (
            <PostRow key={`${g.campaign}:${g.postId}`} group={g} isNew={isNew} onResolveAll={onResolveAll} onReplied={onReplied} t={t} />
          ))}
        </ul>
      ) : !data?.lastSweep ? (
        // Monitoring is on but the first sweep has not run yet - NOT a celebratory "all caught
        // up" (that would be a lie before anything was checked). Offer the check-now instead.
        <div className={`grid place-items-center rounded-xl p-8 text-center ${INNER_SURFACE}`}>
          <div className="max-w-sm space-y-2">
            <RefreshCw size={26} className="mx-auto text-zinc-500" aria-hidden="true" />
            <p className="text-sm font-bold">{t('comments.inbox.firstCheck.title')}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('comments.inbox.firstCheck.body')}</p>
            <button type="button" onClick={onRefresh} disabled={busy} className={`mt-1 inline-flex items-center gap-1.5 rounded-xl bg-brand px-3 py-1.5 text-xs font-bold text-white dark:bg-brand-light dark:text-zinc-900 ${DISABLED_PRIMARY}`}>
              <RefreshCw size={13} className={busy ? 'animate-spin' : ''} aria-hidden="true" /> {t('comments.inbox.checkNow')}
            </button>
          </div>
        </div>
      ) : (
        <div className={`grid place-items-center rounded-xl p-8 text-center ${INNER_SURFACE}`}>
          <div className="max-w-sm space-y-1.5">
            <MessageSquare size={26} className="mx-auto text-zinc-500" aria-hidden="true" />
            <p className="text-sm font-bold">{t('comments.inbox.empty.title')}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('comments.inbox.empty.body')}</p>
          </div>
        </div>
      )}
    </div>
  );
}
