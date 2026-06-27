import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, XCircle, Inbox, Archive, CalendarDays, Sparkles, LayoutGrid, List, Info } from 'lucide-react';
import { approvePost, rejectPost } from '../lib/api.js';
import { fmtFull, fmtStampShort, campaignBaseLabel, matchesFilters } from '../lib/format.js';
import { CoverThumb, LinkCardPreview, PlatformIcons, ApprovalPill, StatusPill, INNER_SURFACE, Skeleton } from './ui.jsx';
import { Popover, PopoverTrigger, PopoverContent } from './ui/Popover.jsx';
import { GateMark } from './ui/GateMark.jsx';
import { IconBadge } from './ui/IconBadge.jsx';
import { Tip } from './ui/Tooltip.jsx';
import BrandLintBadge from './ui/BrandLintBadge.jsx';
import ActionButton from './ui/ActionButton.jsx';
import { usePrompt } from './ui/confirm.jsx';
import { useT } from '../lib/i18n.js';

const firstLine = (s) => (s || '').split('\n').find((l) => l.trim()) || '';
const keyOf = (post) => `${post.campaign}-${post.id}`;
const isActionable = (post) => post.approval !== 'approved' && post.derivedState !== 'posted';
// Skip the approve "clearing sweep" motion for users who asked for less of it.
const prefersReduced = () =>
  typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// One approval card, authored as a <li> of sibling interactive controls (no
// interactive-in-interactive nesting): a single "open detail" <button> covers
// the cover + headline + meta block; the selection checkbox and the Reject/
// Approve actions sit BESIDE that button, not inside it. Status (a state)
// reads as quiet ring-badges top-right; actions (things you do) read as a clear
// button group bottom-right - never interleaved.
function ApprovalCard({ post, onOpen, selected, onToggleSelect, archived, compact = false, focused = false, registerRef, onArrowNav, onActed }) {
  const queryClient = useQueryClient();
  const prompt = usePrompt();
  const t = useT();
  const [error, setError] = useState(null);
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
    </span>
  ) : null;

  // Selection checkbox - only on actionable cards. A sibling control, never
  // nested in the open-detail button. Aligns to the top of the comfortable card,
  // centred on the single-row compact card.
  const checkbox = actionable ? (
    <span className={compact ? 'flex shrink-0 items-center' : 'flex shrink-0 items-start pt-1'}>
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onToggleSelect(post)}
        aria-label={t('approvals.card.selectPost')}
        className="h-4 w-4 cursor-pointer rounded border-zinc-300 text-brand accent-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:border-zinc-600"
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
    </>
  );
  // Quiet ring-badges: status (a state) reads top-right, never interleaved with
  // the action group (things you do). Comfortable layout only.
  const statusBadges = (
    <span className="flex shrink-0 items-center gap-1">
      {contextBadges}
      <StatusPill state={post.derivedState} short />
      <ApprovalPill approval={post.approval} />
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
              <span className="font-bold text-zinc-600 dark:text-zinc-300">
                {post.scheduledAt ? fmtStampShort(post.scheduledAt) : t('approvals.card.noSchedule')}
              </span>
              <span className="hidden min-w-0 truncate text-zinc-400 sm:inline dark:text-zinc-500">
                {t('approvals.card.campaignMeta', { campaign: campaignBaseLabel(post.campaign), id: post.id, type: t(`type.${post.type}`) })}
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
              <span className="block text-xs font-bold text-zinc-600 dark:text-zinc-300">
                {t('approvals.card.scheduledFor', { when: post.scheduledAt ? fmtFull(post.scheduledAt) : t('approvals.card.noSchedule') })}
              </span>
              <span className="block truncate text-[11px] text-zinc-400 dark:text-zinc-500">
                {t('approvals.card.campaignMeta', { campaign: campaignBaseLabel(post.campaign), id: post.id, type: t(`type.${post.type}`) })}
              </span>
            </span>
          </button>
          {/* Caption body + inline preview: SIBLINGS of the open-detail button (not
              nested), so the reviewer sees the real post shape without nesting any
              content inside the interactive card affordance. */}
          {captionBody ? (
            <p className="line-clamp-3 whitespace-pre-wrap text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{captionBody}</p>
          ) : null}
          {isTextPost ? <LinkCardPreview image={post.image} title={post.title} link={post.link} /> : null}
          <div className="mt-auto flex items-center gap-1.5 pt-1.5">
            <PlatformIcons platforms={post.platforms} />
            {/* Advisory brand-lint badge: a SIBLING of the open-detail button (never
                nested in it), mirroring the per-platform publish gate. Silent unless
                a target platform would trip a severity:'error' rule; never gates. */}
            <BrandLintBadge caption={post.caption} platforms={post.platforms} />
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
          className="flex h-7 w-7 items-center justify-center rounded-xl text-zinc-400 transition hover:bg-zinc-200/60 hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60 dark:hover:text-zinc-200"
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
// not all actionable items selected) is cosmetic, set via a ref on the native box.
function SelectAllControl({ total, selectedCount, onToggle }) {
  const t = useT();
  const ref = useRef(null);
  const allSelected = total > 0 && selectedCount === total;
  const someSelected = selectedCount > 0 && selectedCount < total;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = someSelected;
  }, [someSelected]);
  if (total === 0) return null;
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-bold text-zinc-500 dark:text-zinc-400">
      <input
        ref={ref}
        type="checkbox"
        checked={allSelected}
        onChange={onToggle}
        aria-label={allSelected ? t('approvals.selectAll.clear') : t('approvals.selectAll.all')}
        className="h-4 w-4 cursor-pointer rounded border-zinc-300 text-brand accent-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:border-zinc-600"
      />
      {allSelected ? t('approvals.selectAll.clear') : t('approvals.selectAll.all')}
    </label>
  );
}

// The approval surface. Default mode "To review" = everything not yet approved
// (drafts + pending + rejected), unpublished, soonest due first. The "All"
// toggle shows every post chronologically (the owner asked to also see the
// full plan here, not just the queue). Approval always acts as the owner; the
// no-self-approval rule binds agents on the MCP face.
export default function Freigaben({ campaigns, onOpen, clientName = '', onNavigate = () => {}, platformFilter = [], typeFilter = [], statusFilter = [], isLoading = false }) {
  const [mode, setMode] = useState('pending'); // 'pending' | 'all'
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState(() => new Set()); // Set of `${campaign}-${id}`
  const [bulkError, setBulkError] = useState(null);
  // Card density. Persisted grid<->compact preference, mirroring the Assets
  // grid/list idiom (read once from localStorage, persisted in an effect below);
  // a failed read in private mode just falls back to the comfortable default.
  const [density, setDensity] = useState(() => {
    try { return localStorage.getItem('pendpost-approvals-density') === 'compact' ? 'compact' : 'comfortable'; } catch { return 'comfortable'; }
  });
  const queryClient = useQueryClient();
  const prompt = usePrompt();
  const t = useT();

  useEffect(() => {
    try { localStorage.setItem('pendpost-approvals-density', density); } catch { /* private mode - ignore */ }
  }, [density]);

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

  // Active campaigns are the live pipeline; archived (active:false) campaigns are
  // hidden by default so their fail-closed drafts never pollute the queue (A4).
  // The "Show archived" toggle widens the set; any shown archived post is badged.
  const activeIds = useMemo(() => new Set(campaigns.filter((c) => c.active).map((c) => c.id)), [campaigns]);
  const all = useMemo(
    () => campaigns.filter((c) => showArchived || c.active).flatMap((c) => c.posts || []),
    [campaigns, showArchived],
  );
  const pendingTotal = useMemo(() => all.filter(isActionable).length, [all]);

  const items = useMemo(() => {
    const base = mode === 'pending' ? all.filter(isActionable) : all;
    return base
      .filter((p) => matchesFilters(p, platformFilter, typeFilter, statusFilter))
      .sort((a, b) => Date.parse(a.scheduledAt || '9999') - Date.parse(b.scheduledAt || '9999'));
  }, [all, mode, platformFilter, typeFilter, statusFilter]);

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
  const runBulk = async (action, label) => {
    setBulkError(null);
    const sel = effectiveSelection;
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
      <div className="flex items-center gap-3">
        <div className="flex items-center rounded-xl bg-zinc-200/60 p-0.5 dark:bg-zinc-800/60" role="group" aria-label={t('approvals.view.label')}>
          {[
            ['pending', pendingTotal ? t('approvals.view.toReviewCount', { n: pendingTotal }) : t('approvals.view.toReview')],
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
        <SelectAllControl total={actionableItems.length} selectedCount={selCount} onToggle={onToggleSelectAll} />
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500">{t('approvals.postCount', { n: items.length })}</span>
        <div className="ml-auto flex items-center gap-3">
          {/* ONE global keyboard help (replaces the per-card eyebrow + the run-on
              legend text): a quiet "i" that opens a popover explaining the
              shortcuts, with the keys rendered as real kbd chips. Shown only when
              there are cards to act on. */}
          {items.length ? <KeyboardHelp /> : null}
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-bold text-zinc-500 dark:text-zinc-400">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="h-4 w-4 cursor-pointer rounded border-zinc-300 text-brand accent-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:border-zinc-600"
            />
            {t('approvals.showArchived')}
          </label>
        </div>
      </div>

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
              await runBulk((p) => approvePost(p.campaign, p.id), t('approvals.bulk.labelApproved'));
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
              onOpen={onOpen}
              selected={selected.has(keyOf(post))}
              onToggleSelect={toggleSelect}
              archived={!activeIds.has(post.campaign)}
              compact={density === 'compact'}
              focused={focusKey === keyOf(post)}
              registerRef={registerCard(keyOf(post))}
              onArrowNav={onArrowNav}
              onActed={onActed}
            />
          ))}
        </ul>
      ) : (
        <div className="grid flex-1 place-items-center py-16">
          <div className="max-w-xs space-y-2 text-center">
            {/* Cleared queue = the reward state: the gate at rest, quietly
                satisfied (motion kit's EmptyGate). The "all" view keeps the
                quiet Inbox glyph. Both honour reduced-motion via index.css. */}
            {mode === 'pending' ? (
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
              <Inbox size={26} className="mx-auto text-zinc-400" aria-hidden="true" />
            )}
            <p className="text-sm font-bold">{mode === 'pending' ? t('approvals.empty.pendingTitle') : t('approvals.empty.allTitle')}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {mode === 'pending'
                ? clientName
                  ? t('approvals.empty.pendingBodyForClient', { client: clientName })
                  : t('approvals.empty.pendingBody')
                : t('approvals.empty.allBody')}
            </p>
            {/* US-APPR-05: a clear empty queue offers the next step. The pending
                empty state deep-links to Planner so the operator who just cleared
                this client has somewhere to go. */}
            {mode === 'pending' ? (
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
