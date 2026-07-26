import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, XCircle, Inbox, Archive, CalendarDays, Sparkles, LayoutGrid, List, Info, CornerUpLeft, PlugZap, ExternalLink, Wrench, ArrowDown, ArrowUp } from 'lucide-react';
import { approvePost, rejectPost, useAccounts, usePendpostHealth } from '../lib/api.js';
import { fmtFull, fmtStampShort, campaignBaseLabel, comparePostDate, matchesFilters, collectThread, redditPostReadiness, readinessAdvisoryText, unconnectedLanes, isActionable } from '../lib/format.js';
import { CoverThumb, LinkCardPreview, PlatformIcons, ApprovalPill, StatusPill, PLATFORM_META, INNER_SURFACE, Skeleton, SelectAllControl } from './ui.jsx';
import { Popover, PopoverTrigger, PopoverContent } from './ui/Popover.jsx';
import { GateMark } from './ui/GateMark.jsx';
import { IconBadge } from './ui/IconBadge.jsx';
import { Tip } from './ui/Tooltip.jsx';
import BrandLintBadge from './ui/BrandLintBadge.jsx';
import { Checkbox } from './ui/Checkbox.jsx';
import ActionButton from './ui/ActionButton.jsx';
import DestinationStrip from './ui/DestinationStrip.jsx';
import { usePrompt } from './ui/confirm.jsx';
import { useT } from '../lib/i18n.js';

const firstLine = (s) => (s || '').split('\n').find((l) => l.trim()) || '';
const keyOf = (post) => `${post.campaign}-${post.id}`;

// Sort direction is a per-TAB preference, because the two tabs are different objects:
// "Zu pruefen" is a work queue (act on the soonest due), "Alle Beitraege" is an archive
// (find the most recent). A single shared key would destroy that split the first time
// the operator changed it on one tab.
const SORT_PREF_KEY = (mode) => `pendpost-approvals-sort:${mode}`;
const SORT_DEFAULT = { pending: 'oldest', all: 'newest' };
function readSortPref(mode) {
  try {
    const v = localStorage.getItem(SORT_PREF_KEY(mode));
    return v === 'newest' || v === 'oldest' ? v : SORT_DEFAULT[mode];
  } catch {
    return SORT_DEFAULT[mode];
  }
}
// isActionable (the "still needs a decision" predicate that scopes this queue) is the
// SHARED one in lib/format.js, imported above - App's sidebar pending badge uses the same
// function so the badge and this list can never disagree.
// Skip the approve "clearing sweep" motion for users who asked for less of it.
const prefersReduced = () =>
  typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// One approval card, authored as a <li> of sibling interactive controls (no
// interactive-in-interactive nesting): a single "open detail" <button> covers
// the cover + headline + meta block; the selection checkbox and the Reject/
// Approve actions sit BESIDE that button, not inside it. Status (a state)
// reads as quiet ring-badges top-right; actions (things you do) read as a clear
// button group bottom-right - never interleaved.
//
// What may sit INSIDE the open-detail button is decided by ONE question: is it
// interactive? StatusPill/ApprovalPill are plain <span>s, so they read top-right
// inside it. An IconBadge WITH a label is NOT: Tip wraps it in RT.Trigger asChild,
// so it renders a real <button>. Every one of those (archived / auto-approved /
// warmth advisory) therefore lives in the badge row at the bottom, beside
// BrandLintBadge - which is itself a non-interactive <span> for the same reason.
// Nesting one inside the open-detail button is invalid HTML, breaks keyboard
// traversal and screen-reader semantics, and makes the badge's click ambiguous
// (it would also fire open-detail). freigaben-approval-card.test.jsx pins this with
// a reddit-advisory fixture; an instagram/pending fixture renders no badges and
// would let the regression back in unnoticed.
function ApprovalCard({ post, posts = [], onOpen, selected, onToggleSelect, onSelectThread, archived, compact = false, focused = false, registerRef, onArrowNav, onActed, setup = null, onNavigate = null }) {
  const queryClient = useQueryClient();
  const prompt = usePrompt();
  const t = useT();
  const [error, setError] = useState(null);
  // X thread membership: the whole chain this post belongs to. When it is part of
  // a thread, the card offers "select whole thread" so every tweet can be approved
  // together (each is still an independent, individually-audited approval).
  const thread = useMemo(() => (onSelectThread ? collectThread(post, posts) : [post]), [onSelectThread, post, posts]);
  const inThread = thread.length > 1;
  // Mirror ActionButton's in-flight guard for the KEYBOARD path: keys bypass the
  // button machine, so a second 'a'/'r' while one is still resolving would
  // double-submit. A ref (not state) is the guard ActionButton uses in spirit.
  const keyBusyRef = useRef(false);
  // The signature "gate release" motion: on a successful approve the card lifts
  // (the post clearing the gate). One-shot, ~750ms; skipped entirely under
  // reduced-motion. The amber->emerald pill morph from the motion kit is realised
  // here as the card clearing the queue (an approved post is non-actionable and
  // APPROVAL_META.approved is hidden), so the lift reads as the post moving on
  // without a contradicting pill.
  const [cleared, setCleared] = useState(false);
  const clearTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(clearTimerRef.current), []);
  const playClear = () => {
    if (prefersReduced()) return;
    setCleared(true);
    clearTimeout(clearTimerRef.current);
    clearTimerRef.current = setTimeout(() => setCleared(false), 750);
  };

  const actionable = isActionable(post);

  // Spec 37 (reversed 2026-07-13): every approved reddit post auto-publishes. The account-warmth
  // screening is a display-only ADVISORY (promotional / cold account / subreddit requirements),
  // shown as a passive amber badge so the operator sees the concerns before approving. Approval
  // always leads to auto-publish; a distinct human still approves every reddit post (the fence).
  const readiness = useMemo(() => redditPostReadiness(post, setup, true), [post, setup]);
  const hasAdvisory = readiness.advisories.length > 0;
  const advisoryText = hasAdvisory ? readinessAdvisoryText(t, readiness.advisories) : '';

  // The approve write. Approval is always a single, dialog-free action (button,
  // keyboard and bulk paths all approve immediately - no note). Routes through the
  // EXISTING approvePost helper (no new approve path); on success it invalidates
  // the plans query exactly like the reject path.
  const doApprove = async () => {
    setError(null);
    await approvePost(post.campaign, post.id);
    queryClient.invalidateQueries({ queryKey: ['plans'] });
  };
  // The reject write always opens the multiline note prompt; cancel (null) is a
  // user-cancel sentinel (no write, no error flash).
  const doReject = async () => {
    setError(null);
    const note = await prompt({
      title: t('approvals.rejectPrompt.title'),
      body: t('approvals.rejectPrompt.body'),
      multiline: true,
      rememberKey: 'approvals.reject',
    });
    if (note === null) throw { canceled: true };
    await rejectPost(post.campaign, post.id, note || undefined);
    queryClient.invalidateQueries({ queryKey: ['plans'] });
  };

  // Per-card key handler on the focusable <li>. ArrowUp/Down move focus between
  // cards (roving focus is owned by the parent via onArrowNav). a=approve,
  // r=reject act on THIS focused, actionable card. Everything is gated behind the
  // child-guard: keystrokes that bubble up from a child control (open-detail,
  // Reject/Approve buttons, the checkbox) belong to that control, not the card -
  // ignore them so 'a'/'r' on the Reject button never silently approves/rejects
  // the whole card. a/r are additionally ignored when: the card is non-actionable;
  // focus is inside a text field; or a key action is already in flight. 'a'
  // approves IMMEDIATELY (approval never opens a dialog; only reject prompts for a
  // note). On success the parent is notified (onActed) so focus
  // auto-advances to the next item, letting a reviewer clear the queue by keyboard.
  const onCardKeyDown = (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      onArrowNav?.(e.key === 'ArrowDown' ? 1 : -1, post);
      return;
    }
    if (!actionable) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const key = e.key.toLowerCase();
    if (key !== 'a' && key !== 'r') return;
    const el = e.target;
    const tag = (el?.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
    if (keyBusyRef.current) return;
    e.preventDefault();
    keyBusyRef.current = true;
    const isApprove = key === 'a';
    const action = isApprove ? doApprove() : doReject();
    Promise.resolve(action)
      .then(() => {
        if (isApprove) playClear();
        onActed?.(post);
      })
      .catch((err) => {
        if (err?.canceled !== true) setError(err?.message || t('approvals.action.error'));
      })
      .finally(() => {
        keyBusyRef.current = false;
      });
  };
  const headline = (post.title && post.title.trim()) || firstLine(post.caption) || t('approvals.card.untitled');
  // The caption BODY reviewers read before approving. When the headline already
  // is the first caption line (no title), show the rest of the caption beyond it
  // so the body is never just a duplicate of the headline; when a title supplies
  // the headline, the whole caption is the body. Empty => no body block.
  const captionBody = (() => {
    const cap = (post.caption || '').trim();
    if (!cap) return '';
    if (post.title && post.title.trim()) return cap;
    const first = firstLine(post.caption);
    const rest = cap.slice(cap.indexOf(first) + first.length).trim();
    return rest;
  })();
  // text/article posts carry no media; reuse the LinkCardPreview so the reviewer
  // sees the real card shape inline. Media-backed posts keep the lightweight
  // CoverThumb poster path (reserve the heavy <video> for PostDetail) to avoid N
  // video elements on a long queue.
  const isTextPost = post.type === 'text';

  // The Reject/Approve action group - shared by BOTH the comfortable and compact
  // layouts. On success each routes through onActed so the parent advances focus
  // to the next item. Approve is always immediate (button, keyboard and bulk);
  // only reject opens the note dialog.
  // The lanes pendpost cannot publish to. The card ALREADY receives `setup` (it reads warmth
  // from it) and simply never asked this question, so the queue offered a green Freigeben on
  // a post it could not send - on the very surface the operator works from.
  const offlineLanes = unconnectedLanes(post, setup);

  // The Freigeben (approve) button. Same label, variant, icon and position always: approval is a
  // single distinct-human action that always leads to auto-publish. The warmth advisory badge
  // below is informational only - it never changes the approve path.
  //
  // The ONE exception is connectivity, and it is not a variation on approval, it is the absence
  // of it: with the lane unconnected, approving publishes nothing, so the card offers the action
  // that works - open the post and take it from there. Same slot, same size, one button.
  const approveButton = offlineLanes.length ? (
    <>
      <Tip label={t('approvals.card.notConnectedTip', { platforms: offlineLanes.map((p) => PLATFORM_META[p]?.label || p).join(', ') })}>
        <button
          type="button"
          onClick={() => onOpen?.(post)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-sky-500/15 px-2.5 py-1.5 text-xs font-bold text-sky-700 transition hover:bg-sky-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-sky-300"
        >
          <PlugZap size={14} aria-hidden="true" />
          {t('approvals.card.postYourself')}
        </button>
      </Tip>
      {/* The no-dead-end escape hatch beside the hand-off: a quiet wrench (the same
          "set up this lane" glyph PlatformBlockers uses) deep-linking to the lane's
          Setup card, so "not connected" always carries its own fix. */}
      {typeof onNavigate === 'function' ? (
        <Tip label={t('approvals.card.connectTip', { platforms: offlineLanes.map((p) => PLATFORM_META[p]?.label || p).join(', ') })}>
          <button
            type="button"
            onClick={() => onNavigate('setup', offlineLanes[0])}
            aria-label={t('approvals.card.connectTip', { platforms: offlineLanes.map((p) => PLATFORM_META[p]?.label || p).join(', ') })}
            className="shrink-0 rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:bg-zinc-700/60"
          >
            <Wrench size={14} aria-hidden="true" />
          </button>
        </Tip>
      ) : null}
    </>
  ) : (
    <ActionButton
      variant="success"
      icon={CheckCircle2}
      labels={{ idle: t('approvals.action.approve'), loading: t('approvals.action.approving'), success: t('approvals.action.approved'), error: t('approvals.action.error') }}
      onError={setError}
      onAction={async () => {
        await doApprove();
        playClear();
        onActed?.(post);
      }}
    />
  );
  const actions = actionable ? (
    <span className="flex shrink-0 items-center gap-1.5">
      <ActionButton
        variant="danger"
        icon={XCircle}
        labels={{ idle: t('approvals.action.reject'), loading: t('approvals.action.rejecting'), success: t('approvals.action.rejected'), error: t('approvals.action.error') }}
        onError={setError}
        onAction={async () => {
          await doReject();
          onActed?.(post);
        }}
      />
      {approveButton}
    </span>
  ) : null;

  // Selection checkbox - only on actionable cards. A sibling control, never
  // nested in the open-detail button. Aligns to the top of the comfortable card,
  // centred on the single-row compact card.
  const checkbox = actionable ? (
    <span className={compact ? 'flex shrink-0 items-center' : 'flex shrink-0 items-start pt-1'}>
      <Checkbox
        checked={selected}
        onChange={() => onToggleSelect(post)}
        aria-label={t('approvals.card.selectPost')}
      />
    </span>
  ) : null;

  // Contextual icon-badges (archived / auto-approved) - rare signals worth
  // keeping in BOTH layouts. The schedule/approval STATE pills below are extra in
  // comfortable but redundant in compact (the "To review" tab already implies an
  // unapproved post), so compact shows only these.
  const contextBadges = (
    <>
      {archived ? <IconBadge icon={Archive} tone="neutral" text={t('approvals.card.archived')} label={t('approvals.card.archivedLabel')} /> : null}
      {post.approval === 'approved' && post.approvalBy === 'policy:auto-approve'
        ? <IconBadge icon={Sparkles} tone="ok" text={t('approvals.card.autoApproved')} label={t('approvals.card.autoApprovedLabel')} />
        : null}
      {/* Spec 37 (reversed): a display-only account-warmth advisory on a reddit post. Approving
          still auto-publishes; the tooltip carries the concerns (promotional / cold account /
          subreddit requirements). */}
      {hasAdvisory ? <IconBadge icon={Info} tone="warn" text={t('readiness.advisoryBadge')} label={advisoryText} /> : null}
    </>
  );
  // Quiet ring-badges: status (a state) reads top-right, never interleaved with
  // the action group (things you do). Comfortable layout only. STATE PILLS ONLY -
  // these are plain <span>s, which is what lets them live INSIDE the open-detail
  // button. contextBadges are deliberately NOT here: an IconBadge with a label is a
  // real <button> (Tip -> RT.Trigger asChild), so it renders in the badge row below,
  // beside BrandLintBadge, as a sibling of the button.
  const statusBadges = (
    <span className="flex shrink-0 items-center gap-1">
      <StatusPill state={post.derivedState} short />
      <ApprovalPill approval={post.approval} editedSinceApproval={post.editedSinceApproval} handOff={offlineLanes.length > 0} />
    </span>
  );

  return (
    <li
      ref={registerRef}
      // Roving tabindex: the parent-chosen focused card owns the tab stop (0);
      // every other card is -1 (still .focus()-able for arrow nav / auto-advance,
      // but out of the natural Tab order). a/r stay gated by `actionable`.
      tabIndex={focused ? 0 : -1}
      onKeyDown={onCardKeyDown}
      aria-keyshortcuts={actionable ? 'a r' : undefined}
      style={{ transform: cleared ? 'translateY(-6px) scale(.99)' : 'none', transition: 'transform .6s cubic-bezier(.32,.72,0,1)' }}
      className={`group flex transition focus-within:ring-2 focus-within:ring-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand hover:ring-brand/40 ${INNER_SURFACE} ${compact ? 'items-center gap-2.5 rounded-lg p-2' : 'gap-3 rounded-xl p-3'}`}
    >
      {checkbox}
      {compact ? (
        // Compact two-line row. The cover fills the row height and keeps its own
        // aspect ratio (h-12 w-auto). The text column starts after it, so the
        // headline (line 1) and the platform icon + stamp (line 2) share one left
        // edge. Schedule reads as a single bold DD.MM.YY · HH:MM stamp (no
        // "scheduled for" prefix); the redundant Geplant/Entwurf pills are dropped.
        <>
          <button
            type="button"
            onClick={() => onOpen(post)}
            aria-label={headline}
            className="shrink-0 overflow-hidden rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <CoverThumb media={post.media} image={post.image} className="block h-12 w-auto max-w-[4rem] rounded-md" />
          </button>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={() => onOpen(post)}
                className="min-w-0 flex-1 cursor-pointer truncate rounded text-left text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                {headline}
              </button>
              {contextBadges}
              {actions}
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
              <PlatformIcons platforms={post.platforms} />
              {/* When + what, together and bold: the two facts a reviewer triages on.
                  The type moved up here OUT of the muted campaign meta below, so it is
                  not buried behind a truncating campaign name on a narrow row. */}
              <span className="font-bold text-zinc-600 dark:text-zinc-300">
                {post.scheduledAt ? fmtStampShort(post.scheduledAt) : t('approvals.card.noSchedule')}
                {' · '}
                {t(`type.${post.type}`)}
              </span>
              <span className="hidden min-w-0 truncate text-zinc-500 sm:inline dark:text-zinc-400">
                {t('approvals.card.campaignMeta', { campaign: campaignBaseLabel(post.campaign), id: post.id })}
              </span>
            </div>
            {error ? <p role="alert" className="text-[11px] text-red-600 dark:text-red-300">{error}</p> : null}
          </div>
        </>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {/* The open-detail affordance: cover + headline + meta as ONE button. */}
          <button
            type="button"
            onClick={() => onOpen(post)}
            className="flex w-full min-w-0 cursor-pointer gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <CoverThumb media={post.media} image={post.image} className="h-24 w-16 shrink-0 rounded-lg" />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex items-start justify-between gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-bold">{headline}</span>
                {statusBadges}
              </span>
              {/* Same when-plus-what pairing as the compact row above, so the two
                  views read identically. */}
              <span className="block text-xs font-bold text-zinc-600 dark:text-zinc-300">
                {t('approvals.card.scheduledFor', { when: post.scheduledAt ? fmtFull(post.scheduledAt) : t('approvals.card.noSchedule') })}
                {' · '}
                {t(`type.${post.type}`)}
              </span>
              <span className="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                {t('approvals.card.campaignMeta', { campaign: campaignBaseLabel(post.campaign), id: post.id })}
              </span>
            </span>
          </button>
          {/* Caption body + inline preview: SIBLINGS of the open-detail button (not
              nested), so the reviewer sees the real post shape without nesting any
              content inside the interactive card affordance. */}
          {/* The thread this reply ANSWERS, above the answer. Without it the card's headline is
              pendpost's own reply truncated, so the queue asks the operator to approve an
              answer with the question nowhere on the surface they work from. A sibling of the
              open-detail button, never nested: the link is interactive. */}
          {post.radarReplyTo ? (
            <div className={`rounded-lg px-2 py-1.5 ${INNER_SURFACE}`}>
              <div className="flex items-center gap-1.5 text-[11px]">
                {PLATFORM_META[post.radarReplyTo.source] ? (
                  (() => { const M = PLATFORM_META[post.radarReplyTo.source]; return <M.Icon size={11} className={M.color} aria-hidden="true" />; })()
                ) : null}
                <span className="truncate font-bold text-zinc-600 dark:text-zinc-300">
                  {post.radarReplyTo.author || post.radarReplyTo.url.replace(/^https?:\/\/(www\.)?/, '')}
                </span>
                {post.radarReplyTo.community ? (
                  <span className="shrink-0 text-zinc-500 dark:text-zinc-400">{post.radarReplyTo.community}</span>
                ) : null}
                <a
                  href={post.radarReplyTo.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="ml-auto inline-flex shrink-0 items-center gap-1 font-semibold text-brand hover:underline dark:text-brand-light"
                >
                  {t('approvals.card.openThread')}
                  <ExternalLink size={10} aria-hidden="true" />
                </a>
              </div>
              {post.radarReplyTo.excerpt ? (
                <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{post.radarReplyTo.excerpt}</p>
              ) : null}
            </div>
          ) : null}
          {captionBody ? (
            <p className="line-clamp-3 whitespace-pre-wrap text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{captionBody}</p>
          ) : null}
          {/* A link-card preview is what a LINK post looks like on a feed lane. A Radar reply is
              a comment on someone else's thread and carries no link, so the preview rendered an
              empty "no image" box captioned as a LinkedIn card on a Reddit-only reply - the
              biggest block of space on the card spent saying nothing is there. */}
          {isTextPost && !post.radarReplyTo ? <LinkCardPreview image={post.image} title={post.title} link={post.link} /> : null}
          <div className="mt-auto flex items-center gap-1.5 pt-1.5">
            <PlatformIcons platforms={post.platforms} />
            {/* The interactive badges (archived / auto-approved / warmth advisory): each is an
                IconBadge WITH a label, so each is a real <button> and belongs HERE, beside the
                brand-lint badge, as a SIBLING of the open-detail button - never inside it.
                Rendered here rather than in statusBadges so the compact layout, which already
                renders contextBadges outside its own headline button, is not double-fed. */}
            {contextBadges}
            {/* Advisory brand-lint badge: a SIBLING of the open-detail button (never
                nested in it), mirroring the per-platform publish gate. Silent unless
                a target platform would trip a severity:'error' rule; never gates. */}
            <BrandLintBadge caption={post.caption} platforms={post.platforms} />
            {/* Thread marker + "select whole thread": approving one tweet is not
                approving the thread, so this both signals membership and seeds the
                bulk selection with every tweet in the chain. */}
            {inThread ? (
              <Tip label={t('approvals.thread.selectThread')}>
                <button
                  type="button"
                  onClick={() => onSelectThread(post)}
                  className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold text-zinc-500 ring-1 ring-zinc-900/10 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:ring-white/10 dark:hover:bg-zinc-700/60"
                >
                  <CornerUpLeft size={11} aria-hidden="true" /> {t('approvals.thread.partOf', { count: thread.length })}
                </button>
              </Tip>
            ) : null}
            <span className="flex-1" />
            {actions}
          </div>
          {error ? <p role="alert" className="text-[11px] text-red-600 dark:text-red-300">{error}</p> : null}
        </div>
      )}
    </li>
  );
}

// Keyboard-shortcut help. A quiet "i" trigger opens a popover that explains the
// shortcuts with the keys rendered as real <kbd> chips (a / r / arrows) followed
// by what they do - clearer than a run-on "a freigeben · r ablehnen" line.
const KBD = 'inline-flex min-w-[1.25rem] items-center justify-center rounded-md bg-zinc-200/70 px-1.5 py-0.5 text-[11px] font-bold text-zinc-600 dark:bg-zinc-700/70 dark:text-zinc-200';
function KeyboardHelp() {
  const t = useT();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('approvals.keys.title')}
          className="flex h-7 w-7 items-center justify-center rounded-xl text-zinc-500 transition hover:bg-zinc-200/60 hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60 dark:hover:text-zinc-200"
        >
          <Info size={15} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-3" aria-label={t('approvals.keys.title')}>
        <p className="mb-2 text-xs font-bold">{t('approvals.keys.title')}</p>
        <ul className="space-y-1.5 text-[11px] text-zinc-600 dark:text-zinc-300">
          <li className="flex items-center gap-2">
            <kbd className={KBD}>a</kbd>
            <span>{t('approvals.keys.approve')}</span>
          </li>
          <li className="flex items-center gap-2">
            <kbd className={KBD}>r</kbd>
            <span>{t('approvals.keys.reject')}</span>
          </li>
          <li className="flex items-center gap-2">
            <span className="flex shrink-0 gap-1">
              <kbd className={KBD} aria-hidden="true">↑</kbd>
              <kbd className={KBD} aria-hidden="true">↓</kbd>
            </span>
            <span>{t('approvals.keys.navigate')}</span>
          </li>
        </ul>
      </PopoverContent>
    </Popover>
  );
}

// Header "Select all" / "Clear selection" checkbox. Indeterminate (some but
// not all actionable items selected) is cosmetic, handled by the shared Checkbox.
// The approval surface. Default mode "To review" = everything not yet approved
// (drafts + pending + rejected), unpublished, soonest due first. The "All"
// toggle shows every post chronologically (the owner asked to also see the
// full plan here, not just the queue). Approval always acts as the owner; the
// no-self-approval rule binds agents on the MCP face.
export default function Freigaben({ campaigns, onOpen, clientName = '', onNavigate = () => {}, platformFilter = [], typeFilter = [], statusFilter = [], isLoading = false, onModeChange }) {
  const [mode, setMode] = useState('pending'); // 'pending' | 'all'
  // Mirror the tab up so App can gate the shared Status filter to the "All posts" tab
  // (the Status dropdown is dead on the pending tab, which forces statusFilter to []).
  useEffect(() => { onModeChange?.(mode); }, [mode, onModeChange]);
  const [selected, setSelected] = useState(() => new Set()); // Set of `${campaign}-${id}`
  const [bulkError, setBulkError] = useState(null);
  // Card density. Persisted grid<->compact preference, mirroring the Assets
  // grid/list idiom (read once from localStorage, persisted in an effect below);
  // a failed read in private mode just falls back to the comfortable default.
  const [density, setDensity] = useState(() => {
    try { return localStorage.getItem('pendpost-approvals-density') === 'compact' ? 'compact' : 'comfortable'; } catch { return 'comfortable'; }
  });
  // Sort direction, held and persisted PER TAB. One shared key would let a choice made
  // on the archive silently reorder the work queue on the next visit, which would undo
  // the whole point of the two defaults. Same lazy-read + effect-write idiom as density
  // three lines up, so this component has one preference pattern, not two.
  const [sortByMode, setSortByMode] = useState(() => ({
    pending: readSortPref('pending'),
    all: readSortPref('all'),
  }));
  const sortOrder = sortByMode[mode];
  const setSortOrder = useCallback(
    (next) => setSortByMode((prev) => ({ ...prev, [mode]: next })),
    [mode],
  );
  const queryClient = useQueryClient();
  const prompt = usePrompt();
  const t = useT();
  // Spec 37: the setup signal carries reddit.warmth (per client), the input the per-card
  // tier cue reads. One cached read shared by every card (no per-card fetch).
  const { data: pendpostHealth } = usePendpostHealth(true);
  const setup = pendpostHealth?.setup || null;
  // Read ONCE at the parent, exactly like the health signal above. 114 cards each
  // calling useAccounts would be 114 subscriptions re-rendering on every 60s refetch.
  const { data: accounts, isLoading: accountsLoading, isError: accountsError } = useAccounts();

  useEffect(() => {
    try { localStorage.setItem('pendpost-approvals-density', density); } catch { /* private mode - ignore */ }
  }, [density]);

  useEffect(() => {
    try {
      for (const m of ['pending', 'all']) localStorage.setItem(SORT_PREF_KEY(m), sortByMode[m]);
    } catch { /* private mode - ignore */ }
  }, [sortByMode]);

  // Roving-focus controller. `focusKey` (a keyOf, not an index - an index would be
  // meaningless across the items useMemo re-sorting on every refetch) owns the tab
  // stop; `cardRefs` maps keyOf -> <li>; `didInitialFocusRef` makes first-card
  // focus a one-shot per empty->populated transition so a background react-query
  // refetch never steals focus; `pendingAdvanceRef` records the acted index so
  // focus can auto-advance to the next item after the post-refetch re-render.
  const cardRefs = useRef(new Map());
  const [focusKey, setFocusKey] = useState(null);
  const didInitialFocusRef = useRef(false);
  const pendingAdvanceRef = useRef(null);

  // EVERY campaign is in scope, archived (active:false) included: the active flag
  // is organizational only and never gates publishing (lib/scheduler.mjs), so an
  // archived campaign's draft is real decision work and its approved post still
  // fires. Owner invariant (2026-07-21): nothing awaiting a decision can hide.
  // Archived posts are badged on the card and sort after active ones in the queue.
  const activeIds = useMemo(() => new Set(campaigns.filter((c) => c.active).map((c) => c.id)), [campaigns]);
  const all = useMemo(() => campaigns.flatMap((c) => c.posts || []), [campaigns]);
  const actionable = useMemo(() => all.filter(isActionable), [all]);
  // Every post still awaiting a decision, filters ignored. This is the GLOBAL truth
  // ("is there open work at all?"), so it - not the visible count - keeps the
  // cleared-queue reward state honest.
  const pendingTotal = useMemo(() => actionable.length, [actionable]);
  // What the pending list ACTUALLY shows: the same actionable set through the same
  // platform/type predicate the list applies (status is already ignored in pending
  // mode, see items below). The tab chip counts THIS, so the badge and the list it
  // labels cannot disagree - a platform chip used to leave "To review (3)" sitting
  // over an empty list, which teaches the operator to distrust the badge.
  const pendingVisible = useMemo(
    () => actionable.filter((p) => matchesFilters(p, platformFilter, typeFilter, [])).length,
    [actionable, platformFilter, typeFilter],
  );

  const items = useMemo(() => {
    const base = mode === 'pending' ? actionable : all;
    const newestFirst = sortOrder === 'newest';
    // "To review" IS a status bucket, so filtering it BY status contradicts the tab
    // (and the count on it): a leftover global statusFilter - e.g. ['overdue'], which
    // the planner's Ueberfaellig chip sets and which persists across pages/clients -
    // would empty the queue while the tab still counts the posts. Status filters the
    // 'all' view only; platform/type stay (they are orthogonal to the decision).
    // Queue order: active-campaign work first, archived after (labelled, still
    // reachable, never blocking the live pipeline); within each group by date.
    // The 'all' view is purely chronological.
    //
    // The DIRECTION is the operator's, and it defaults differently per tab because the
    // two tabs are different objects: "Zu pruefen" is a work queue, so the soonest-due
    // item is the one to act on, while "Alle Beitraege" is an archive, where the most
    // recent post is the one being looked for. That default is why this list opened on
    // 11.06.26.
    const byDate = (a, b) => comparePostDate(a, b, newestFirst ? -1 : 1);
    return base
      .filter((p) => matchesFilters(p, platformFilter, typeFilter, mode === 'pending' ? [] : statusFilter))
      .sort(mode === 'pending'
        ? (a, b) => (activeIds.has(b.campaign) - activeIds.has(a.campaign)) || byDate(a, b)
        : byDate);
  }, [all, actionable, mode, platformFilter, typeFilter, statusFilter, activeIds, sortOrder]);

  // The lanes actually present in what the operator is looking at. Naming a lane the
  // list does not contain would be noise; naming one it does is the whole point.
  const visiblePlatforms = useMemo(() => {
    const seen = new Set();
    for (const p of items) for (const plat of p.platforms || []) seen.add(plat);
    return [...seen];
  }, [items]);

  // The cleared-queue reward state must MEAN it: nothing awaits review AT ALL. A
  // queue emptied merely by a platform/type filter is not an achievement, so it
  // falls through to the neutral "Keine Beitraege / Passe die Filter an" state
  // rather than claiming everything is approved while the tab still counts open work.
  const clearedQueue = mode === 'pending' && pendingTotal === 0;

  // Callback ref each card registers with - auto-cleans on unmount.
  const registerCard = useCallback((key) => (el) => {
    if (el) cardRefs.current.set(key, el);
    else cardRefs.current.delete(key);
  }, []);

  // Move the roving tab stop to a card and pull DOM focus to it. preventScroll +
  // a separate scrollIntoView({block:'nearest'}) is the anti-jank pattern: focus
  // never yanks the scroll container, and we only scroll when the card is off-view.
  const focusCardByKey = useCallback((key) => {
    if (!key) return;
    setFocusKey(key);
    const el = cardRefs.current.get(key);
    if (el) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest' });
    }
  }, []);
  const focusCardAtIndex = useCallback((index) => {
    const post = items[index];
    if (post) focusCardByKey(keyOf(post));
  }, [items, focusCardByKey]);

  // ArrowUp/Down from the focused card: move focus to the clamped neighbour.
  const onArrowNav = useCallback((dir, post) => {
    const idx = items.findIndex((p) => keyOf(p) === keyOf(post));
    if (idx === -1) return;
    focusCardAtIndex(Math.min(items.length - 1, Math.max(0, idx + dir)));
  }, [items, focusCardAtIndex]);

  // A card fires this on a SUCCESSFUL approve/reject. Record the acted index; the
  // effect below consumes it once the items list has re-rendered post-refetch.
  const onActed = useCallback((post) => {
    pendingAdvanceRef.current = { actedKey: keyOf(post), index: items.findIndex((p) => keyOf(p) === keyOf(post)) };
  }, [items]);

  // The single focus-orchestration effect. Runs whenever `items` changes (the
  // identity change a refetch/filter/mode flip produces) and handles, in order:
  // (1) empty queue -> reset; (2) a pending auto-advance after an action;
  // (3) first-populate -> focus the first card once; (4) steady state -> only
  // repair a dangling focusKey WITHOUT moving DOM focus (so a background refetch
  // never yanks focus from where the reviewer is).
  useEffect(() => {
    if (!items.length) {
      didInitialFocusRef.current = false;
      pendingAdvanceRef.current = null;
      if (focusKey !== null) setFocusKey(null);
      return;
    }
    const pending = pendingAdvanceRef.current;
    if (pending) {
      pendingAdvanceRef.current = null;
      // pending mode: the acted card unmounted, so the item now AT its index is
      // the next one -> focus `index`. all mode: the acted card stays (now
      // non-actionable) -> advance to index+1. Both clamped to the last card.
      const stillThere = items.some((p) => keyOf(p) === pending.actedKey);
      const target = stillThere ? Math.min(pending.index + 1, items.length - 1) : Math.min(pending.index, items.length - 1);
      const raf = requestAnimationFrame(() => focusCardAtIndex(Math.max(0, target)));
      return () => cancelAnimationFrame(raf);
    }
    if (!didInitialFocusRef.current) {
      didInitialFocusRef.current = true;
      // Pull focus to the first card so a/r work immediately on open - but only
      // if the reviewer hasn't already focused something (never yank focus away
      // from a deliberate interaction). Auto-advance below is exempt (it IS the
      // deliberate interaction).
      const raf = requestAnimationFrame(() => {
        const ae = typeof document !== 'undefined' ? document.activeElement : null;
        if (!ae || ae === document.body) focusCardAtIndex(0);
      });
      return () => cancelAnimationFrame(raf);
    }
    if (focusKey && !items.some((p) => keyOf(p) === focusKey)) {
      setFocusKey(keyOf(items[0]));
    }
  }, [items, focusKey, focusCardAtIndex]);

  // The actionable posts currently visible - the only things a bulk action can
  // touch. We never trust the raw `selected` Set for counts or the bulk loop:
  // filters/mode can hide a once-selected post, so we always intersect against
  // this list. That keeps the count honest and the loop scoped to visible posts.
  const actionableItems = useMemo(() => items.filter(isActionable), [items]);
  const effectiveSelection = useMemo(
    () => actionableItems.filter((p) => selected.has(keyOf(p))),
    [actionableItems, selected],
  );
  const selCount = effectiveSelection.length;

  const toggleSelect = (post) => {
    const k = keyOf(post);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };
  // Seed the selection with every tweet in the post's thread, so a reviewer can
  // approve the whole chain in one bulk action (the bulk loop still intersects
  // against the visible actionable items, so already-approved tweets are no-ops).
  const selectThread = (post) => {
    const keys = collectThread(post, all).map(keyOf);
    setSelected((prev) => new Set([...prev, ...keys]));
  };
  const clearSelection = () => setSelected(new Set());
  const selectAllVisible = () => setSelected(new Set(actionableItems.map(keyOf)));
  const allVisibleSelected = actionableItems.length > 0 && selCount === actionableItems.length;
  const onToggleSelectAll = () => (allVisibleSelected ? clearSelection() : selectAllVisible());

  // Shared bulk runner: loop the effective selection sequentially over the
  // single-post helper, tally per-item ok/fail, refresh, then THROW a summary
  // on any failure so the ActionButton flashes error and the bulkError
  // line shows which posts failed. Only the SUCCEEDED posts are deselected -
  // failures stay selected so the bar (and its error summary) stays visible and
  // the failed posts are retryable. (A clear-all here would unmount the bar and
  // swallow the summary; a rejected post also stays actionable, so it would
  // otherwise linger selected after a clean reject.)
  // A post pendpost cannot publish (its target lane is not connected). The single-row
  // approve already swaps to "post yourself" for these; bulk approve must skip them for
  // the same reason (approving publishes nothing), not silently approve into a void.
  const isOffline = useCallback((post) => unconnectedLanes(post, setup).length > 0, [setup]);

  const runBulk = async (action, label, list = effectiveSelection) => {
    setBulkError(null);
    const sel = list;
    let ok = 0;
    const fails = [];
    const done = [];
    for (const p of sel) {
      try {
        await action(p);
        ok++;
        done.push(keyOf(p));
      } catch (e) {
        fails.push({ id: p.id, msg: e?.message || 'Error' });
      }
    }
    queryClient.invalidateQueries({ queryKey: ['plans'] });
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of done) next.delete(k);
      return next;
    });
    if (fails.length) {
      throw new Error(t('approvals.bulk.summary', { ok, label, failed: fails.length, ids: fails.map((f) => f.id).join(', ') }));
    }
  };

  return (
    <div className="flex h-full flex-col gap-3">
      {/* flex-wrap, and gap-y so a wrapped row does not collide. Measured against the
          real de-CH strings this row is already ~530px in a 375px viewport BEFORE the
          sort toggle, so it was overflowing horizontally on mobile already. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center rounded-xl bg-zinc-200/60 p-0.5 dark:bg-zinc-800/60" role="group" aria-label={t('approvals.view.label')}>
          {[
            ['pending', pendingVisible ? t('approvals.view.toReviewCount', { n: pendingVisible }) : t('approvals.view.toReview')],
            ['all', t('approvals.view.all')],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setMode(key)}
              aria-pressed={mode === key}
              className={`rounded-[10px] px-3 py-1 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                mode === key ? 'bg-white text-brand shadow dark:bg-zinc-700 dark:text-brand-light' : 'text-zinc-500 dark:text-zinc-400'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {/* Card density toggle: comfortable cards <-> compact rows. Icon-only
            (label via aria-label/title) to keep the header lean, mirroring the
            Assets grid/list metaphor. */}
        <div className="flex items-center rounded-xl bg-zinc-200/60 p-0.5 dark:bg-zinc-800/60" role="group" aria-label={t('approvals.density.label')}>
          {[
            ['comfortable', LayoutGrid, t('approvals.density.comfortable')],
            ['compact', List, t('approvals.density.compact')],
          ].map(([key, Icon, label]) => (
            <Tip key={key} label={label}>
              <button
                type="button"
                onClick={() => setDensity(key)}
                aria-pressed={density === key}
                aria-label={label}
                className={`flex items-center rounded-[10px] px-2.5 py-1.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                  density === key ? 'bg-white text-brand shadow dark:bg-zinc-700 dark:text-brand-light' : 'text-zinc-500 dark:text-zinc-400'
                }`}
              >
                <Icon size={14} aria-hidden="true" />
              </button>
            </Tip>
          ))}
        </div>
        {/* Sort direction. A two-value choice, so it is a toggle and not a Select:
            "a Select for a two-value choice would be ceremony" (Radar's own rule), and
            a dropdown would also add ~190px to a row that already has to wrap at 375px.
            Rendered on BOTH tabs - the order was previously unstated on both - with the
            default and the stored preference kept per tab. */}
        <Tip label={t(sortOrder === 'newest' ? 'approvals.sort.newest' : 'approvals.sort.oldest')}>
          <button
            type="button"
            onClick={() => setSortOrder(sortOrder === 'newest' ? 'oldest' : 'newest')}
            aria-label={t(sortOrder === 'newest' ? 'approvals.sort.newest' : 'approvals.sort.oldest')}
            className="flex items-center gap-1.5 rounded-xl bg-zinc-200/60 px-2.5 py-1.5 text-[11px] font-bold text-zinc-600 transition hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-zinc-800/60 dark:text-zinc-300 dark:hover:text-brand-light"
          >
            {sortOrder === 'newest' ? <ArrowDown size={13} aria-hidden="true" /> : <ArrowUp size={13} aria-hidden="true" />}
            <span>{t(sortOrder === 'newest' ? 'approvals.sort.newestShort' : 'approvals.sort.oldestShort')}</span>
          </button>
        </Tip>
        {/* Stays in the toolbar. Moving it into the sticky bulk bar was considered and
            rejected: that bar renders only when something is already selected, so
            select-all-from-zero would become unreachable. */}
        <SelectAllControl total={actionableItems.length} selectedCount={selCount} onToggle={onToggleSelectAll} allKey="approvals.selectAll.all" clearKey="approvals.selectAll.clear" />
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('approvals.postCount', { n: items.length })}</span>
        <div className="ml-auto flex items-center gap-3">
          {/* ONE global keyboard help (replaces the per-card eyebrow + the run-on
              legend text): a quiet "i" that opens a popover explaining the
              shortcuts, with the keys rendered as real kbd chips. Shown only when
              there are cards to act on. */}
          {items.length ? <KeyboardHelp /> : null}
        </div>
      </div>

      {/* WHERE these posts land, stated ONCE for the whole client-scoped list. The
          approval cards show a platform glyph, which says instagram but not WHICH
          instagram - so on 2026-07-25 a bondigoo post was approved and published onto
          the pendpost account with nothing on screen that could have caught it. The
          destination belongs to the project, not the post, so it is one row here rather
          than a chip repeated on every card. Only the lanes this list actually contains
          are named, so the strip stays a fact about the work in front of the operator. */}
      <DestinationStrip
        platforms={visiblePlatforms}
        accounts={accounts}
        isLoading={accountsLoading}
        isError={accountsError}
        onNavigate={onNavigate}
      />

      {/* US-APPR-07: the bulk action bar sits at the TOP of the queue so the
          primary approve/reject action is reachable without scrolling past a
          long list. Sticky so it stays in view while the list scrolls beneath. */}
      {selCount ? (
        <div
          role="region"
          aria-label={t('approvals.bulk.selected', { n: selCount })}
          className={`sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-xl p-2.5 backdrop-blur-xl ${INNER_SURFACE}`}
        >
          {/* role='status' aria-live='polite' so toggling per-card checkboxes
              announces the new in-scope count when the bulk bar (with its
              destructive Reject/Approve actions) appears/changes - mirroring the
              status patterns in Assets.jsx / Activity.jsx. */}
          <span role="status" aria-live="polite" className="text-xs font-bold">{t('approvals.bulk.selected', { n: selCount })}</span>
          <span className="flex-1" />
          {bulkError ? (
            <p role="alert" className="basis-full text-[11px] text-red-600 dark:text-red-300">{bulkError}</p>
          ) : null}
          <button
            type="button"
            onClick={clearSelection}
            className="rounded-xl px-2.5 py-1.5 text-xs font-bold text-zinc-600 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-300 dark:hover:bg-zinc-700/60"
          >
            {t('approvals.selectAll.clear')}
          </button>
          <ActionButton
            variant="danger"
            icon={XCircle}
            labels={{ idle: t('approvals.action.reject'), loading: t('approvals.action.rejecting'), success: t('approvals.action.rejected'), error: t('approvals.action.error') }}
            onError={setBulkError}
            onAction={async () => {
              const note = await prompt({
                title: t('approvals.bulkRejectPrompt.title'),
                body: t('approvals.rejectPrompt.body'),
                multiline: true,
                rememberKey: 'approvals.reject',
              });
              if (note === null) throw { canceled: true };
              await runBulk((p) => rejectPost(p.campaign, p.id, note || undefined), t('approvals.bulk.labelRejected'));
            }}
          />
          <ActionButton
            variant="success"
            icon={CheckCircle2}
            labels={{ idle: t('approvals.action.approve'), loading: t('approvals.action.approving'), success: t('approvals.action.approved'), error: t('approvals.action.error') }}
            onError={setBulkError}
            onAction={async () => {
              // Approve only the publishable posts; a post whose lane is offline cannot be
              // published, so it is skipped and surfaced (parity with the single-row swap).
              const connected = effectiveSelection.filter((p) => !isOffline(p));
              const offlineCount = effectiveSelection.length - connected.length;
              if (!connected.length) {
                setBulkError(t('approvals.bulk.offlineOnly', { n: offlineCount }));
                throw { canceled: true };
              }
              await runBulk((p) => approvePost(p.campaign, p.id), t('approvals.bulk.labelApproved'), connected);
              if (offlineCount) setBulkError(t('approvals.bulk.offlineSkipped', { n: offlineCount }));
            }}
          />
        </div>
      ) : null}

      {isLoading && !items.length ? (
        // Skeleton placeholders while the first plan fetch is in flight, so the
        // empty-state copy never flashes before any data has arrived (A16).
        <div className="grid min-h-0 flex-1 content-start gap-2.5 overflow-y-auto scrollbar-soft p-1 pr-2 xl:grid-cols-2 2xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : items.length ? (
        // p-1 pr-2 gives the focus ring (ring-2) room so it is never clipped by
        // this scroll container; scrollbar-soft keeps the right gutter slim.
        <ul
          role="list"
          className={
            density === 'compact'
              ? 'flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto scrollbar-soft p-1 pr-2'
              : 'grid min-h-0 flex-1 content-start gap-2.5 overflow-y-auto scrollbar-soft p-1 pr-2 xl:grid-cols-2 2xl:grid-cols-3'
          }
        >
          {items.map((post) => (
            <ApprovalCard
              key={keyOf(post)}
              post={post}
              posts={all}
              onOpen={(p) => onOpen(p, items)}
              selected={selected.has(keyOf(post))}
              onToggleSelect={toggleSelect}
              onSelectThread={selectThread}
              archived={!activeIds.has(post.campaign)}
              compact={density === 'compact'}
              focused={focusKey === keyOf(post)}
              registerRef={registerCard(keyOf(post))}
              onArrowNav={onArrowNav}
              onActed={onActed}
              setup={setup}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      ) : (
        <div className="grid flex-1 place-items-center py-16">
          <div className="max-w-xs space-y-2 text-center">
            {/* Cleared queue = the reward state: the gate at rest, quietly
                satisfied (motion kit's EmptyGate). The "all" view keeps the
                quiet Inbox glyph. Both honour reduced-motion via index.css. */}
            {clearedQueue ? (
              <div className="relative mx-auto mb-3 h-[72px] w-[72px]">
                <div
                  aria-hidden="true"
                  className="absolute -inset-5 rounded-full"
                  style={{ background: 'radial-gradient(circle, rgba(94,234,212,.14), transparent 70%)', animation: 'pp-glow-pulse 3s ease-in-out infinite' }}
                />
                <div className="relative text-brand dark:text-brand-light" style={{ animation: 'pp-rest 3.4s ease-in-out infinite' }}>
                  <GateMark size={72} />
                </div>
              </div>
            ) : (
              <Inbox size={26} className="mx-auto text-zinc-500" aria-hidden="true" />
            )}
            <p className="text-sm font-bold">{clearedQueue ? t('approvals.empty.pendingTitle') : t('approvals.empty.allTitle')}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {clearedQueue
                ? clientName
                  ? t('approvals.empty.pendingBodyForClient', { client: clientName })
                  : t('approvals.empty.pendingBody')
                : t('approvals.empty.allBody')}
            </p>
            {/* US-APPR-05: a clear empty queue offers the next step. The pending
                empty state deep-links to Planner so the operator who just cleared
                this client has somewhere to go. */}
            {clearedQueue ? (
              <button
                type="button"
                onClick={() => onNavigate('planner')}
                className="inline-flex items-center gap-1 rounded text-xs font-bold text-brand transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light"
              >
                <CalendarDays size={13} aria-hidden="true" />
                {t('approvals.empty.openPlanner')}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
