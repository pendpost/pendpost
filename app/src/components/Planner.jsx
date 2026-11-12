import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, CalendarClock, CalendarDays, CheckCircle2, ChevronUp, ChevronDown, Plus, CornerUpLeft, ExternalLink, PauseCircle, PlayCircle, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { dayKey, localDayKey, comparePostDate, fmtTime, fmtDayShort, fmtDayNum, fmtDayAria, fmtMonthYear, addDays, TIME_CHIP_META, timeChipTone, gridDisplayAspect, hasVisual, needsAttention, postIsDimmed, getCardAccent, STATUS_PILL_META, postDisplayStatusKey, postDisplayTitle, postPublishedTitle, postCaptionRun, deriveThread, collectThread, postStatusWord, approvalWord, ROW_STATUS_META, failedDisplayKey, liveFailure, blockedLanes as blockedLanesOf, resolveLivePermalink, STAIR, timeColumn, PLATFORMS, unconnectedLanes, rowTypeLabel } from '../lib/format.js';
import { useReschedule } from '../lib/useReschedule.js';
import { usePostActions } from '../lib/usePostActions.js';
import { useT } from '../lib/i18n.js';
import { humanizeFailure, laneLabel } from '../lib/failureCopy.js';
import { PlatformIcons, PostStatusPill, CoverThumb, LaneTile, Skeleton, useCachedSetup, PLATFORM_META } from './ui.jsx';
import { HdBadge } from './ui/HdBadge.jsx';
import { RowMenu } from './ui/RowMenu.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { DateTimePicker } from './ui/DateTimePicker.jsx';
import { ClientAvatar } from './ClientSwitcher.jsx';
import { PROJECT_CHIP, SELECTED_TINT, TAP_TARGET_Y } from './ui/recipes.js';
import IssueFixButton, { fixLabel, agentAvailable } from './IssueFixButton.jsx';
import { postIssue } from '../lib/postIssue.js';
import { Popover, PopoverAnchor, PopoverContent } from './ui/Popover.jsx';
import { useConfirm } from './ui/confirm.jsx';
import { showToast } from './AppToast.jsx';
import { ListBar, BarAction, SelectBox } from './BulkBar.jsx';
import { ShortcutList } from './ui/ShortcutList.jsx';
import { useIsPhone } from '../lib/useIsPhone.js';
import { useStuck } from '../lib/useStuck.js';
import { useSelection, selectionKey, SKIP } from '../lib/useSelection.js';
import { useSetupByClient } from '../lib/setupByClient.js';
import { bulkPlan, moveTarget, nameList, shortName, deleteToastText, doneToastText, willNotLine, notDoneLine, retimedOnApprove, restoreAll, restoreToast, runAgentFixQueued, localDateValue } from '../lib/bulkPlan.js';
import { approvePost, deletePost, restorePost, reschedulePost, unschedulePost, updatePost, agentFixPost, getAgentFixes } from '../lib/api.js';
import { fixFor } from '../lib/agentFix.js';
import { approveNoticeText } from '../lib/approveNotice.js';

// Single source for the "no time set" placeholder, defined once so the three List
// readouts (published readout, picker placeholder, picker trigger fallback) and
// any later tweak stay in lockstep instead of three hand-typed literals.
const EMPTY_TIME = '--:--';

// FR1: the scheduled-time chip, color-coded to the post's approval/breaker state
// and paired with an icon + accessible name so meaning is never color-only
// (WCAG 1.4.1). Three variants:
//  - overlay: the absolutely-positioned pill over a Week card cover image;
//  - inline: a compact icon+time chip for the dense Month cell (lives inside the
//    cell button, so it is a labeled non-interactive span, not a nested button);
//  - standalone: a compact icon chip for the List row. It is a non-interactive
//    labeled span (role=img + aria-label, like the other two variants), a sibling
//    of the row's open-detail button - so it never nests an interactive control
//    and the tone meaning is read by SR/AT directly, not gated behind a
//    pointer-only hover tooltip.
// The Tip reveals the same accessible name on pointer hover; the aria-label
// carries it for screen readers regardless of hover or focus.
export function TimeChip({ post, lane, variant = 'overlay', tip = true }) {
  const t = useT();
  if (!post.scheduledAt) return null;
  const tone = timeChipTone(post, lane);
  const meta = TIME_CHIP_META[tone];
  const { Icon } = meta;
  const time = fmtTime(post.scheduledAt);
  const accessibleName = `${t(`timeChip.${tone}`)}, ${time}`;

  if (variant === 'standalone') {
    return (
      <Tip label={accessibleName}>
        <span
          role="img"
          aria-label={accessibleName}
          className={`inline-flex shrink-0 items-center rounded-full p-1 text-[10px] font-bold ring-1 ${meta.cls}`}
        >
          {/* List rows already render the editable time beside this chip; the chip
              is the color/approval signal only, so it drops the redundant clock
              read-out and stays a compact icon (name still carries the time for SR). */}
          <Icon size={11} aria-hidden="true" />
        </span>
      </Tip>
    );
  }

  const className = variant === 'inline'
    ? `inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold ring-1 ${meta.cls}`
    : `absolute right-1.5 top-1.5 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold ring-1 backdrop-blur ${meta.cls}`;
  // Inline (the dense chip): the calm approved tone drops its check, because the chip's own
  // status glyph already says it; a second check beside it read as "approved" even on a
  // published post. Amber and red keep their icon (a Meta lane halt is only said here).
  const showIcon = !(variant === 'inline' && tone === 'approved');
  const chip = (
    <span role="img" aria-label={accessibleName} className={className}>
      {showIcon ? <Icon size={11} aria-hidden="true" /> : null}
      {time}
    </span>
  );
  // `tip={false}`: the chip sits inside a trigger that already carries the post's one
  // status-word tooltip (CompactPostCard), so a second bubble would stack on it.
  return tip ? <Tip label={accessibleName}>{chip}</Tip> : chip;
}

// The plain "why" for a Blockiert post, shared by the Week card and the List row: the
// lanes that make the pill read Blockiert (format.js blockedLanes, unconnected and not a
// manual paste lane), named in one neutral sentence.
function blockedReason(lanes, t) {
  return t(lanes.length > 1 ? 'freigaben.blocked.reasonMany' : 'freigaben.blocked.reason', {
    platforms: lanes.map((p) => PLATFORM_META[p]?.label || p).join(', '),
  });
}

// The plain "why" for a live failure, shared by the Week card and the List row so both
// read ONE predicate: any live failure, with or without a message. humanizeFailure names
// a code-only failure from its code (failureCopy.js CODE_KEYS) and falls back to the
// generic sentence, never the raw platform line.
function failureReason(post, t) {
  return liveFailure(post) ? humanizeFailure(post.lastFailure, t).text : null;
}

// Week cards are draggable onto another day column = reschedule, keeping the
// post's time of day (Phase D drag-drop; the owner's machine runs in the
// plan timezone, so local wall-clock == the viewer's timezone here).
export function PostCard({ post, onSelect, onEdit, draggable, onDragStart, lane }) {
  const t = useT();
  const { items } = usePostActions(post, { onEdit });
  // Triage-first: ONE collapsed status drives the card. The only cards that recede
  // (dimmed) are the "set aside" ones - parked + rejected (postIsDimmed); every other
  // card renders at full, regular strength. An active card that needs action (draft /
  // pending / overdue) carries a thin left accent bar ('bar', default) or a tinted
  // status band ('strip', a display preference) - the dimmed set-aside cards get no
  // accent, they simply fade back.
  const accent = getCardAccent();
  const meta = STATUS_PILL_META[postDisplayStatusKey(post)] || STATUS_PILL_META.scheduled;
  const dim = postIsDimmed(post);
  const flag = needsAttention(post) && !dim; // active attention -> show the accent
  const showBar = flag && accent === 'bar' && meta.bar;
  const showStrip = flag && accent === 'strip' && meta.strip;
  // A "Blockiert" card says WHY in the caption slot, the way a "Wartet auf dich" card
  // shows its failure reason: the lanes that make the pill read Blockiert (postStatusWord's
  // own predicate: unconnected and not a manual paste lane).
  const setup = useCachedSetup(undefined, post);
  const blockedLanes = postStatusWord(post, setup) === 'blocked' ? blockedLanesOf(post, setup) : [];
  // Why a live failure did not go out, as the one plain sentence (never the raw line).
  const failureLine = failureReason(post, t);
  // The words follow the title rule (format.js): a bold title only where a lane publishes one,
  // and the caption as ONE run (line breaks joined), never just its first line. A text post has
  // no picture, so its card is all text (no fake image of its own words) and the time rides
  // inline beside the status pill.
  const visual = hasVisual(post);
  const shownTitle = postPublishedTitle(post);
  const captionRun = postCaptionRun(post);
  return (
    // Wrapper (relative, NO overflow-hidden) so the ⋯ menu can escape the card's rounded
    // clip; the card button keeps overflow-hidden for the cover. The ⋯ is a SIBLING of the
    // open-detail button, never nested (interactive-nesting contract).
    // container-type: the status pill measures this card (PostStatusPill fit) and folds to its
    // glyph in a narrow week column.
    <div className="group relative [container-type:inline-size]">
    <button
      type="button"
      onClick={() => onSelect(post)}
      draggable={draggable}
      onDragStart={onDragStart}
      // The card's visual content (cover, pill, meta, caption snippet) reads as a
      // stuttering pile of fragments to a SR; carry ONE clean accessible name
      // (post + type + time, like the Month/List views - the column header already
      // reads the day) so the control announces itself once.
      aria-label={`${postDisplayTitle(post, t('planner.list.untitled'))}, ${t(`type.${post.type}`)}, ${fmtTime(post.scheduledAt)}`}
      className={`relative w-full overflow-hidden rounded-xl text-left bg-white/80 dark:bg-zinc-900/70 ring-1 ring-zinc-900/[0.06] dark:ring-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.05)] transition hover:-translate-y-1 motion-reduce:hover:translate-y-0 hover:shadow-xl hover:bg-white/90 dark:hover:bg-zinc-800/80 focus-visible:ring-2 focus-visible:ring-brand ${dim ? 'opacity-60 hover:opacity-100' : ''}`}
    >
      {showBar ? <span aria-hidden="true" className={`pointer-events-none absolute left-0 top-0 bottom-0 z-10 w-1 ${meta.bar}`} /> : null}
      {visual ? (
        <div className="relative">
          <CoverThumb media={post.media} image={post.image} className={`${gridDisplayAspect(post)} w-full`} />
          <TimeChip post={post} lane={lane} variant="overlay" />
        </div>
      ) : null}
      <div className="space-y-1.5 p-2">
        <div className={showStrip ? `-mx-2 -mt-2 mb-1.5 px-2 pb-1.5 pt-2 ${meta.strip}` : ''}>
          {visual ? (
            <PostStatusPill post={post} fit />
          ) : (
            // The text card: the time (inline chip) on the top line after the ⋯ in the card's
            // top-left corner (h-5 holds that line clear of the ⋯ when there is no time), then
            // the status pill on its own line at the card's full width, the way a media card
            // shows it under its cover. Beside the time a 7-column week cut it off.
            <div data-text-card="" className="space-y-1.5">
              <div data-text-card-time="" className="flex h-5 min-w-0 items-center pl-7">
                <TimeChip post={post} lane={lane} variant="inline" />
              </div>
              <PostStatusPill post={post} fit />
            </div>
          )}
        </div>
        {/* Type + platforms collapse into one quiet meta line (was a separate type
            overlay badge + a standalone platform row competing at the same weight). */}
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] font-bold tracking-tight text-zinc-500 dark:text-zinc-400">
          <span className="truncate">{rowTypeLabel(t, post.type)}</span>
          <span aria-hidden="true" className="h-1 w-1 shrink-0 rounded-full bg-current opacity-50" />
          <PlatformIcons platforms={post.platforms} size={12} />
          <HdBadge hdReady={post.media?.hdReady} bitrate={post.media?.bitrate} static warnOnly />
          {/* Issue 6: the same client chip, so a Week card is legible even without
              opening it. */}
          {post.clientName ? (
            <span className={`${PROJECT_CHIP} max-w-[7rem]`}>
              <ClientAvatar client={{ displayName: post.clientName, accent: post.accent, logo: null }} size={14} />
              <span className="truncate">{post.clientName}</span>
            </span>
          ) : null}
        </div>
        {blockedLanes.length ? (
          // Neutral ink: a blocked post waits on setup, nothing is failing.
          <p className="line-clamp-2 text-[11px] font-medium leading-snug text-zinc-600 dark:text-zinc-300">
            {blockedReason(blockedLanes, t)}
          </p>
        ) : failureLine ? (
          // A failed/skipped post shows WHY right on the card. The reason was previously
          // only a hover title on the pill and a banner in the drawer - invisible on the
          // overview and on touch. It reuses the caption-snippet slot (no extra height):
          // for a post that did not go out, knowing why matters more than the caption.
          // D1: red only when the owner must act; a failure pendpost is still retrying
          // (failedDisplayKey, the one judge) reads in neutral ink. The card is a button,
          // so it holds no "?": the raw platform line lives behind the post detail's "?",
          // and the hover title repeats the sentence (line-clamp may cut it), never the raw.
          <p className={`line-clamp-2 text-[11px] font-medium leading-snug ${failedDisplayKey(post.lastFailure) === 'publish-retrying' ? 'text-zinc-600 dark:text-zinc-300' : 'text-red-700 dark:text-red-300'}`} title={failureLine}>
            {failureLine}
          </p>
        ) : (
          <>
            {shownTitle ? (
              <p data-row-title="" className="truncate text-[11px] font-bold leading-snug">{shownTitle}</p>
            ) : null}
            {captionRun ? (
              <p data-row-caption="" className={`${visual ? 'line-clamp-2' : 'line-clamp-6'} text-[11px] leading-snug ${shownTitle ? 'text-zinc-600 dark:text-zinc-300' : ''}`}>
                {captionRun}
              </p>
            ) : null}
          </>
        )}
      </div>
    </button>
      {/* ⋯ overlay: a light glyph on a dark scrim so it reads over any cover; top-left so it
          never collides with the top-right time chip. Its menu escapes the card's clip via
          the non-overflow wrapper. */}
      <div className="absolute left-1.5 top-1.5 z-30">
        <RowMenu
          items={items}
          align="left"
          label={t('postDetail.more')}
          // Over a cover: a light glyph on a dark scrim. On a text card: a quiet glyph.
          triggerClassName={visual
            ? 'inline-flex items-center rounded-lg bg-black/45 p-1 text-white backdrop-blur transition hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70'
            : 'inline-flex items-center rounded-lg p-1 text-zinc-600 transition hover:bg-zinc-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-300'}
        />
      </div>
    </div>
  );
}

// The drag payload every planner card writes: campaign + id + current time, read
// back by the day-column drop handler to reschedule. Defined once so the Week card,
// the compact card, and (via them) both boards serialize an identical shape.
function postDragStart(post) {
  return (e) => {
    e.dataTransfer.setData(
      'application/json',
      // clientId rides along (issue 6): a drag-drop reschedule in all-clients mode
      // must reach the card's own client, not whatever is active. Undefined in
      // single-client mode, so JSON.stringify simply omits the key there.
      JSON.stringify({ campaign: post.campaign, id: post.id, scheduledAt: post.scheduledAt, clientId: post.clientId }),
    );
    e.dataTransfer.effectAllowed = 'move';
  };
}

// Shared day-column drop target (Week columns + Month cells). Returns the current
// drag-over key (for the highlight ring) and a props factory to spread onto each
// day surface, so the drop-to-reschedule wiring lives in one place for both boards.
function useDayDropTarget(onMoveToDay) {
  const [dragOverKey, setDragOverKey] = useState(null);
  const dropProps = (day, key) => ({
    onDragOver: (e) => { e.preventDefault(); setDragOverKey(key); },
    onDragLeave: () => setDragOverKey((prev) => (prev === key ? null : prev)),
    onDrop: (e) => {
      e.preventDefault();
      setDragOverKey(null);
      try {
        onMoveToDay?.(JSON.parse(e.dataTransfer.getData('application/json')), day);
      } catch { /* not one of our cards */ }
    },
  });
  return { dragOverKey, dropProps };
}

// A dense, clickable, draggable post chip. Shared by the Month cells and the
// compact Week view, so there is ONE small-card markup + drag source. `dayLabel`
// (Month) prepends the day to the accessible name; the compact Week column header
// already reads the day, so it omits it. `showTitle` gives the roomier Week column
// a truncated title; Month stays title-less to fit the narrow cell.
export function CompactPostCard({ post, onSelect, lane, draggable, dayLabel, showTitle = false }) {
  const t = useT();
  // The chip wears the SAME word as the Week/List/detail pill (postStatusWord over the
  // cached setup): the pill's own glyph in the pill's tone, and the word in the name.
  const setup = useCachedSetup(undefined, post);
  const word = postStatusWord(post, setup);
  const status = ROW_STATUS_META[word] || STATUS_PILL_META.scheduled;
  // A published post wears the SOLID glyph (filled disk = done, the approved ring = waiting)
  // and its chip settles back, so the eye lands on what is still ahead and on any failure.
  const glyph = status.solid || status;
  const settled = Boolean(status.solid);
  const StatusGlyph = glyph.Icon;
  // A published chip's tip also carries the way to the live post (owner pick 2026-11-04):
  // one "Live ansehen" link, or one link per lane named by platform when several went out.
  // Only provable links (resolveLivePermalink), never a guessed one; the post detail keeps
  // the same links for keyboard and touch, so the hover shortcut hides nothing.
  const liveLinks = settled
    ? (post.platforms || []).map((p) => ({ p, href: resolveLivePermalink(post, p) })).filter((l) => l.href)
    : [];
  const statusLabel = t(`status.${word}`);
  const tipLabel = liveLinks.length ? (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span>{statusLabel}</span>
      {liveLinks.map(({ p, href }) => (
        <a
          key={p}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          data-live-link={p}
          className="inline-flex items-center gap-0.5 font-bold text-brand-light hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand"
        >
          {liveLinks.length > 1 ? (PLATFORM_META[p]?.label || p) : t('planner.chip.viewLive')}
          <ExternalLink size={10} aria-hidden="true" />
        </a>
      ))}
    </span>
  ) : statusLabel;
  const title = postDisplayTitle(post, t('planner.list.untitled'));
  // ONE clean accessible name (day? + post + status + type + time), matching the Week/List
  // cards; the inner glyph/chip/type/platforms stay aria-hidden so a SR hears the
  // name once instead of a stuttering fragment pile.
  const name = `${dayLabel ? `${dayLabel}, ` : ''}${title}, ${t(`status.${word}`)}, ${t(`type.${post.type}`)}, ${fmtTime(post.scheduledAt)}${post.clientName ? `, ${post.clientName}` : ''}`;
  // D4: the chip shows only a glyph, so its status word appears on hover and keyboard
  // focus through the shared Tip. Not PinTip: that one preventDefaults the click to pin
  // its bubble, and a click here must open the post. Touch loses nothing: a tap opens the
  // post, which shows the same word.
  return (
    <Tip label={tipLabel}>
    <button
      type="button"
      onClick={() => onSelect(post)}
      draggable={draggable}
      onDragStart={draggable ? postDragStart(post) : undefined}
      aria-label={name}
      // Tap target: at least 24px tall on a fine pointer (WCAG 2.5.8 AA; it measured 23px) and
      // the house 44px on a coarse one (touch). Tailwind 3.4 has no pointer-coarse variant,
      // hence the arbitrary media variant. The Month cell has only a min-height and shows at
      // most three chips plus "+n more", so taller chips grow the row, never clip it.
      className={`flex min-h-6 w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-[10px] ring-1 ring-zinc-900/10 transition hover:bg-white dark:ring-white/10 dark:hover:bg-zinc-700 focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:min-h-11 ${settled ? 'bg-transparent' : 'bg-white/70 dark:bg-zinc-800/70'}`}
    >
      {/* The status word's glyph in the pill's tone (never colour alone: the shape is the
          pill's icon, and the button's name speaks the word). */}
      <span aria-hidden="true" data-status-glyph={word} className={`inline-flex shrink-0 rounded-full p-0.5 ring-1 ${glyph.cls}`}>
        <StatusGlyph size={10} />
      </span>
      {/* FR1: color-coded time chip (visual only inside the labeled button) */}
      <span aria-hidden="true" className="contents">
        <TimeChip post={post} lane={lane} variant="inline" tip={false} />
      </span>
      {/* Roomy Week column: the title carries identity, so it takes the free space. The
          type word is dropped everywhere (redundant next to the platform icon): in the
          narrow Month cell it only ever showed as a truncated sliver ("T."). The button's
          name keeps the type for a screen reader. */}
      {showTitle ? (
        <span aria-hidden="true" className={`min-w-0 flex-1 truncate font-bold ${settled ? 'text-zinc-500 dark:text-zinc-400' : 'text-zinc-700 dark:text-zinc-200'}`}>{title}</span>
      ) : null}
      <span aria-hidden="true" className="contents">
        <PlatformIcons platforms={post.platforms} size={10} />
      </span>
      {/* Issue 6: in all-clients mode even the dense Month/compact cell carries the
          project - a small monogram (accent + initials, never colour-only; the
          button's aria-label names the project too). */}
      {post.clientName ? (
        <span aria-hidden="true" className="ml-auto shrink-0">
          <ClientAvatar client={{ displayName: post.clientName, accent: post.accent, logo: null }} size={12} />
        </span>
      ) : null}
    </button>
    </Tip>
  );
}

// The date of the post nearest to an empty period: the first one after it, else the
// latest one before it. First run (2026-11-11): the shipped demo campaign lives in other
// weeks, so the planner opened on an empty week with only "check the filters" as advice.
export function nearestPostDate(posts, from, to) {
  let next = null;
  let prev = null;
  for (const post of posts || []) {
    if (!post?.scheduledAt) continue;
    const d = new Date(post.scheduledAt);
    if (Number.isNaN(d.getTime())) continue;
    if (d > to) { if (!next || d < next) next = d; }
    else if (d < from) { if (!prev || d > prev) prev = d; }
  }
  return next || prev;
}

// One shared empty-period state for both Week and Month. It always ends in one action:
// when posts exist outside this period, go to the nearest one (the real cause of the
// empty view); otherwise New post, the action the copy promises. Sentence-case, single
// solid color, weight <= 700, an icon beside the words so color is never the only signal.
function EmptyPeriod({ onNew, jumpTo, onJump }) {
  const t = useT();
  const jump = jumpTo && onJump;
  return (
    <div className="col-span-7 grid place-items-center py-16">
      <div className="max-w-xs space-y-2 text-center">
        <CalendarDays size={26} className="mx-auto text-zinc-500" aria-hidden="true" />
        <p className="text-sm font-bold">{t('planner.empty.periodTitle')}</p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {t(jump ? 'planner.empty.periodElsewhere' : 'planner.empty.periodBody')}
        </p>
        {jump || onNew ? (
          <button
            type="button"
            onClick={() => (jump ? onJump(jumpTo) : onNew())}
            className="mx-auto mt-1 inline-flex items-center gap-1.5 rounded-xl bg-brand px-3 py-1.5 text-xs font-bold text-white transition hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            {jump ? <CalendarClock size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
            {jump ? t('planner.empty.goTo', { date: fmtDayAria(jumpTo) }) : t('composer.newPost')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function WeekView({ posts, weekStart, onSelect, onEdit, onMoveToDay, loading, lane, onNew, onJump, density = 'comfortable' }) {
  const { dragOverKey, dropProps } = useDayDropTarget(onMoveToDay);
  const compact = density === 'compact';
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const byDay = useMemo(() => {
    const map = new Map();
    for (const post of posts) {
      if (!post.scheduledAt) continue;
      const key = dayKey(post.scheduledAt);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(post);
    }
    for (const list of map.values()) list.sort(comparePostDate);
    return map;
  }, [posts]);
  const todayKey = localDayKey(new Date());
  const allEmpty = !loading && days.every((day) => !(byDay.get(localDayKey(day)) || []).length);

  return (
    <div className="grid min-w-[840px] grid-cols-7 gap-3">
      {allEmpty ? <EmptyPeriod onNew={onNew} onJump={onJump} jumpTo={nearestPostDate(posts, days[0], addDays(days[6], 1))} /> : null}
      {days.map((day) => {
        const key = localDayKey(day);
        const isToday = key === todayKey;
        // Days before today step back (owner pick 2026-11-04): a grey, lighter label, so the
        // week reads from today forward. localDayKey is YYYY-MM-DD, so strings compare.
        const isPast = key < todayKey;
        const dayPosts = byDay.get(key) || [];
        return (
          <section
            key={key}
            aria-label={fmtDayAria(day)}
            className={`min-w-0 rounded-xl transition ${dragOverKey === key ? 'bg-brand/5 ring-1 ring-brand/30' : ''} ${allEmpty ? 'hidden' : ''}`}
            {...dropProps(day, key)}
          >
            <header
              className={`mb-2 rounded-xl px-2 py-1.5 ${
                isToday ? 'bg-brand/10 dark:bg-brand-light/10' : ''
              }`}
            >
              <div className="flex items-baseline gap-1.5">
                <span data-past-day={isPast ? '' : undefined} className={`text-xs ${isPast ? 'font-medium' : 'font-bold'} ${isToday ? 'text-brand dark:text-brand-light' : 'text-zinc-500 dark:text-zinc-400'}`}>
                  {fmtDayShort(day)}
                </span>
                <span className={`font-display text-sm ${isPast ? 'font-medium text-zinc-500 dark:text-zinc-400' : 'font-bold'} ${isToday ? 'text-brand dark:text-brand-light' : ''}`}>
                  {fmtDayNum(day)}
                </span>
              </div>
              {isToday ? <div aria-hidden="true" className="mt-1 h-[3px] w-4 rounded-full bg-brand dark:bg-brand-light" /> : null}
            </header>
            <div className={compact ? 'space-y-1' : 'space-y-2'}>
              {loading ? (
                <>
                  <Skeleton className={compact ? 'h-6 w-full' : 'h-16 w-full'} />
                  <Skeleton className={compact ? 'h-6 w-full' : 'h-16 w-full'} />
                </>
              ) : dayPosts.length ? (
                dayPosts.map((post) =>
                  compact ? (
                    <CompactPostCard
                      key={`${post.campaign}-${post.id}-${post.scheduledAt}`}
                      post={post}
                      onSelect={onSelect}
                      lane={lane}
                      showTitle
                      draggable={post.derivedState !== 'posted'}
                    />
                  ) : (
                    <PostCard
                      key={`${post.campaign}-${post.id}-${post.scheduledAt}`}
                      post={post}
                      onSelect={onSelect}
                      onEdit={onEdit}
                      lane={lane}
                      draggable={post.derivedState !== 'posted'}
                      onDragStart={postDragStart(post)}
                    />
                  ),
                )
              ) : (
                // Faint dashed slot: the column reads as a droppable surface.
                <div aria-hidden="true" className={`${compact ? 'h-10' : 'h-24'} rounded-xl border border-dashed border-zinc-300/60 dark:border-zinc-700/60`} />
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function MonthView({ posts, monthAnchor, onSelect, onMoveToDay, loading, lane, onNew, onJump, onShowDay }) {
  const t = useT();
  const { dragOverKey, dropProps } = useDayDropTarget(onMoveToDay);
  const cells = useMemo(() => {
    const first = new Date(monthAnchor.getFullYear(), monthAnchor.getMonth(), 1);
    const gridStart = addDays(first, -((first.getDay() + 6) % 7));
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  }, [monthAnchor]);
  const byDay = useMemo(() => {
    const map = new Map();
    for (const post of posts) {
      if (!post.scheduledAt) continue;
      const key = dayKey(post.scheduledAt);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(post);
    }
    for (const list of map.values()) list.sort(comparePostDate);
    return map;
  }, [posts]);
  const todayKey = localDayKey(new Date());
  const month = monthAnchor.getMonth();
  const allEmpty = !loading && cells.every((day) => !(byDay.get(localDayKey(day)) || []).length);

  if (loading) {
    return (
      <div className="grid min-w-[840px] grid-cols-7 gap-1.5">
        {Array.from({ length: 14 }, (_, i) => (
          <Skeleton key={i} className="min-h-[92px]" />
        ))}
      </div>
    );
  }

  return (
    <div role="grid" aria-label={fmtMonthYear(monthAnchor)} className="grid min-w-[840px] grid-cols-7 gap-1.5">
      {['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => (
        <p key={d} className="px-2 pb-1 text-xs font-bold text-zinc-500 dark:text-zinc-400">
          {t(`planner.weekday.${d}`)}
        </p>
      ))}
      {allEmpty ? <EmptyPeriod onNew={onNew} onJump={onJump} jumpTo={nearestPostDate(posts, cells[0], addDays(cells[cells.length - 1], 1))} /> : null}
      {cells.map((day) => {
        const key = localDayKey(day);
        const dayPosts = byDay.get(key) || [];
        const inMonth = day.getMonth() === month;
        const isToday = key === todayKey;
        return (
          <div
            key={key}
            role="group"
            aria-label={fmtDayAria(day)}
            className={`min-h-[92px] rounded-xl p-1.5 transition ${
              dragOverKey === key
                ? 'bg-brand/5 ring-1 ring-brand/30'
                : isToday
                ? 'bg-brand/10 ring-1 ring-zinc-900/5 dark:bg-brand-light/10 dark:ring-white/5'
                : 'bg-white/50 ring-1 ring-zinc-900/5 dark:bg-zinc-900/35 dark:ring-white/5'
            } ${inMonth ? '' : 'opacity-40'} ${allEmpty ? 'hidden' : ''}`}
            {...dropProps(day, key)}
          >
            <p className={`mb-0.5 text-[11px] font-bold ${isToday ? 'text-brand dark:text-brand-light' : 'text-zinc-500 dark:text-zinc-400'}`}>
              {fmtDayNum(day)}
            </p>
            {isToday ? <div aria-hidden="true" className="mb-1 h-[3px] w-4 rounded-full bg-brand dark:bg-brand-light" /> : null}
            <div className="space-y-1">
              {/* Month cells share the Week's compact card, so a post is one drag
                  source and one markup across both boards. dayLabel carries the day
                  into the accessible name (the month cell has no column header). */}
              {dayPosts.slice(0, 3).map((post) => (
                <CompactPostCard
                  key={`${post.campaign}-${post.id}-${post.scheduledAt}`}
                  post={post}
                  onSelect={onSelect}
                  lane={lane}
                  dayLabel={fmtDayAria(day)}
                  draggable={post.derivedState !== 'posted'}
                />
              ))}
              {dayPosts.length > 3 ? (
                <button
                  type="button"
                  // The label promises "N more posts", so the action must reveal the
                  // whole day, not just the 4th post. When the parent wires
                  // onShowDay we route to it; otherwise we fall back to opening the
                  // first hidden post (index 3) so the control is never inert.
                  onClick={() => (onShowDay ? onShowDay(day) : onSelect(dayPosts[3]))}
                  aria-label={t('planner.month.moreAria', { count: dayPosts.length - 3 })}
                  // Tap target: the Month chips' own decision, at least 24px on a fine pointer
                  // (WCAG 2.5.8 AA; it measured about 16px) and 44px on a coarse one (touch).
                  className="min-h-6 w-full rounded-md px-1 py-0.5 text-left text-[10px] text-zinc-500 dark:text-zinc-400 transition hover:bg-white/70 hover:text-zinc-600 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:min-h-11"
                >
                  {t('planner.month.more', { count: dayPosts.length - 3 })}
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// The selection checkbox's visibility (planner bulk, package P, the owner's pick): it appears on
// hover or keyboard focus of its row (or day heading), and on every row once anything is
// selected. Its slot is ALWAYS reserved, so a title never jumps sideways when it shows. A touch
// screen has no hover, so there it always shows, and so does a phone-width screen (round 3: the
// judge could not start a selection by touch).
const PICK_HIDDEN = 'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 max-md:opacity-100';

// The row checkbox, with a 44px hit area (BulkBar.jsx SelectBox). A shift-click selects the range
// from the last toggled row.
function PickBox({ checked, indeterminate = false, onPick, label, shown }) {
  return (
    <span data-pick="" className={`flex h-7 w-4 shrink-0 items-center justify-center ${shown ? '' : PICK_HIDDEN}`}>
      <SelectBox checked={checked} indeterminate={indeterminate} onPick={onPick} label={label} />
    </span>
  );
}

// Chronological list view (the "see everything in order + filter on status" surface):
// day-grouped wide rows. Studio fix flow (2026-11-01, package C, polished the same day after
// a fresh-eyes review), the owner's picks: a text post shows its title plus two caption lines
// and no fake thumbnail, a media post keeps its real thumbnail, and a post that needs the owner
// says so in ONE status line under its title: the halted (rose) alert glyph, the plain reason
// in the same ink, and the post's one fix button on that same line. One status signal per row,
// never pill + reason + button competing.
// Media first (2026-11-05, mockup A): after the time column the post's real thumbnail (40px,
// its real aspect) or a quiet 40px lane tile for a text post, so every row's words start at the
// same x. The words: a meta line (glyph + type + badges), a bold title only where a lane
// publishes one (format.js postPublishedTitle), then the caption as one paragraph.
// Planner bulk (package P): the row spans the panel (no max-width), its words fill the row up
// to the pill and the ⋯ at the trailing edge, and the selection checkbox leads the row.
// Sibling affordances per row (no nested buttons): the checkbox selects, the time opens an
// inline reschedule picker (non-published posts only), the body opens the detail, the fix runs
// the fix, the ⋯ opens the menu (which no longer repeats the fix: the button is right there).
// Round 3 (the judge on the phone): a row that needs the owner keeps its APPROVAL pill beside the
// red line (format.js approvalWord), and below md (`phone`) the row is [checkbox] [media] [meta,
// title, then time + status in words, then caption] [⋯]: the checkbox always shows (touch has no
// hover), the status is never hidden, and the time leaves its own column so the caption keeps
// the width next to the thumbnail. The time changes from the detail there.
function ListRow({ post, posts = [], onSelect, onEdit, onNavigate, selected = false, picking = false, onPick, rowRef, rowKey, onFocusRow, phone = false }) {
  const t = useT();
  const reschedule = useReschedule();
  const setup = useCachedSetup(undefined, post);
  // The row's one fix (lib/postIssue.js): the same judge as the post detail card and the
  // "Needs you" tray, so the three can never disagree on what this post needs.
  const issue = postIssue(post, setup);
  const hasFix = Boolean(issue?.fix?.type);
  // The overview action set (Freigeben / Ablehnen / Parken / Prüfen / Löschen, + Editor
  // when onEdit is threaded), shared with the detail drawer via the same gate predicates.
  // The fix rides along only so the menu drops an item that would repeat it.
  // The editor only for a post the composer can edit (a Bluesky Radar reply would open empty).
  const editIn = canCompose(post) ? onEdit : undefined;
  const { items } = usePostActions(post, {
    onEdit: editIn,
    fix: hasFix ? { type: issue.fix.type, label: fixLabel(issue, t, { agent: agentAvailable(setup) }) } : null,
    setup,
  });
  const published = post.derivedState === 'posted' || post.derivedState === 'fired-assumed';
  // X thread folding: a reply whose parent is also visible is indented under it;
  // a parent shows how many replies thread beneath it. Same-campaign only.
  const { parent: threadParent, replies: threadReplies } = deriveThread(post, posts);
  const isReply = Boolean(post.xReplyTo && threadParent);
  const word = postStatusWord(post, setup);
  // Why the post needs something, as one plain sentence (never the raw platform line): the
  // lanes that make it Blocked, why a live failure did not go out, or, for a fix with no
  // failure on record, the tray's own words for that cause.
  const blockedLanes = word === 'blocked' ? blockedLanesOf(post, setup) : [];
  const reason = (blockedLanes.length ? blockedReason(blockedLanes, t) : failureReason(post, t))
    || (hasFix ? t(`tray.cause.${issue.fix.type}`, { lane: laneLabel(issue.lane) }) : null);
  // The status line's stop on the staircase (brand/DESIGN.md section 3): halted (rose) with
  // the alert glyph whenever the owner must act or the post is stuck; a failure pendpost is
  // still retrying on its own reads in the calm pending grey with the retry glyph.
  const retrying = !hasFix && failedDisplayKey(post.lastFailure) === 'publish-retrying';
  const stop = retrying ? STAIR.pending : STAIR.halted;
  const StatusIcon = retrying ? RefreshCw : TriangleAlert;
  // Every row wears a pill: its status word, or, beside a red reason line, its approval word
  // (the red line already says what blocks it).
  const pillWord = hasFix ? approvalWord(post) : word;
  const timeText = post.scheduledAt ? fmtTime(post.scheduledAt) : EMPTY_TIME;
  // The NAME of the post (the checkbox label) stays postDisplayTitle; the VISIBLE words follow
  // the title rule: a bold title only when a lane publishes one, and the caption as one
  // paragraph that never loses its first line without a title (format.js).
  const title = postDisplayTitle(post, t('planner.list.untitled'));
  const shownTitle = postPublishedTitle(post);
  const caption = postCaptionRun(post) || (shownTitle ? '' : t('planner.list.untitled'));
  // The time column fits the clock in use ("01:25 PM" never wraps to two lines).
  const tc = timeColumn();
  const visual = hasVisual(post);
  return (
    <li
      ref={rowRef}
      data-row-key={rowKey}
      data-selected={selected ? '' : undefined}
      // A roving keyboard target (j/k move here, Enter opens, x selects): focusable by script,
      // never a Tab stop of its own, so Tab still walks the row's real controls.
      tabIndex={-1}
      onFocus={(e) => { if (e.target === e.currentTarget) onFocusRow?.(rowKey); }}
      className={`group flex flex-wrap items-start gap-x-3 gap-y-1.5 rounded-xl px-2 py-2.5 ring-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ring-transparent ${selected ? SELECTED_TINT : 'hover:bg-zinc-500/[0.08] dark:hover:bg-white/[0.06]'} ${isReply ? 'ml-5 border-l-2 border-zinc-200 pl-3 dark:border-zinc-700' : ''}`}
    >
      <PickBox checked={selected} onPick={(opts) => onPick?.(post, opts)} label={t('listBulk.selectRow', { title })} shown={phone || picking || selected} />
      {phone ? null : published ? (
        <span className={`${tc.col} shrink-0 whitespace-nowrap py-0.5 text-center font-display text-sm font-bold tabular-nums`}>
          {post.scheduledAt ? fmtTime(post.scheduledAt) : EMPTY_TIME}
        </span>
      ) : (
        <DateTimePicker
          value={post.scheduledAt || undefined}
          onChange={(iso) => reschedule(post, iso)}
          placeholder={EMPTY_TIME}
          disablePast
          renderTrigger={() => (
            <button
              type="button"
              aria-label={post.scheduledAt ? t('planner.list.changeTimeAt', { time: fmtTime(post.scheduledAt) }) : t('planner.list.changeTime')}
              className={`${TAP_TARGET_Y} -my-0.5 ${tc.col} shrink-0 whitespace-nowrap rounded-md py-1 text-center font-display text-sm font-bold tabular-nums transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60`}
            >
              {post.scheduledAt ? fmtTime(post.scheduledAt) : EMPTY_TIME}
            </button>
          )}
        />
      )}
      {/* Preview + information share the open-detail button: clicking anywhere here opens
          the full post. Media first (mockup A, 2026-11-05): after the time, the post's real
          picture at its real aspect, 40px wide, or a quiet 40px lane tile for a post with
          nothing to look at, so every row's words start at the same x. The words fill the row
          up to the pill and the ⋯ at its trailing edge. */}
      <button
        type="button"
        onClick={() => onSelect(post)}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <span data-row-media="" className="block w-10 shrink-0">
          {visual ? (
            <CoverThumb media={post.media} image={post.image} className={`block w-full ${gridDisplayAspect(post)} rounded-md`} />
          ) : (
            <LaneTile platform={post.radarReplyTo?.source || post.platforms?.[0]} size={16} className="w-full" />
          )}
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          {/* The meta line: what the post IS (reply glyph, platforms, type), then the badges
              (thread, HD, project). On a phone the badges wrap under it when it needs the room;
              from md up the line stays one row. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 md:flex-nowrap">
            <span data-row-lead="" className="flex shrink-0 items-center gap-1 py-[3px]">
              {post.xReplyTo ? (
                <span className="text-zinc-600 dark:text-zinc-400">
                  <CornerUpLeft size={13} aria-hidden="true" />
                  <span className="sr-only">{t('planner.list.replyChain', { id: post.xReplyTo })}</span>
                </span>
              ) : null}
              <PlatformIcons platforms={post.platforms || []} />
            </span>
            <span className="min-w-0 truncate text-xs text-zinc-600 dark:text-zinc-400">{rowTypeLabel(t, post.type)}</span>
            {/* Thread membership, shown ONCE on the opener only: a reply row carries the reply
                glyph + indent instead, so a 6-post thread reads as one "Thread · 6 posts". */}
            {threadReplies.length && !post.xReplyTo ? (
              <span className="shrink-0 rounded-full bg-zinc-500/10 px-1.5 py-0.5 text-[10px] font-bold text-zinc-600 dark:text-zinc-300">
                {t('planner.list.threadCount', { count: collectThread(post, posts).length })}
              </span>
            ) : null}
            <span className="shrink-0 empty:hidden">
              <HdBadge hdReady={post.media?.hdReady} bitrate={post.media?.bitrate} static warnOnly />
            </span>
            {/* Issue 6: the same client chip Freigaben's cards carry, shown only
                when all-clients mode stamped one. */}
            {post.clientName ? (
              <span className={`${PROJECT_CHIP} max-w-[8rem] shrink-0`}>
                <ClientAvatar client={{ displayName: post.clientName, accent: post.accent, logo: null }} size={14} />
                <span className="truncate">{post.clientName}</span>
              </span>
            ) : null}
          </div>
          {/* A title only where a lane publishes one (YouTube, Reddit, Pinterest, blogs). One line
              on a wide screen; on a phone it may take two, so it is read, not cut. */}
          {shownTitle ? (
            <p data-row-title="" className="min-w-0 break-words text-sm font-bold line-clamp-2 md:line-clamp-1">{shownTitle}</p>
          ) : null}
          {/* The phone's status line, under the words that name the post: the time, then the
              status in words with its glyph (the pill), so nobody ticks a published post blind. */}
          {phone ? (
            <span data-row-meta="" className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-0.5">
              <span className="font-display text-xs font-bold tabular-nums text-zinc-700 dark:text-zinc-300">{timeText}</span>
              <PostStatusPill post={post} word={pillWord} />
            </span>
          ) : null}
          {/* The caption as one paragraph, two lines: full text strength when it carries the post,
              quiet under a title (the title carries it there). */}
          {caption ? (
            <p data-row-caption="" className={`line-clamp-2 text-[13px] leading-relaxed ${shownTitle || !postCaptionRun(post) ? 'text-zinc-600 dark:text-zinc-400' : ''}`}>{caption}</p>
          ) : null}
        </div>
      </button>
      {/* The pill, a sibling of the open-detail button: the status word, or beside a red reason
          line the approval word. On a phone it rides the status line under the title instead. */}
      {phone ? null : (
        <div data-row-pill="" className="contents">
          <PostStatusPill post={post} word={pillWord} />
        </div>
      )}
      <RowMenu items={items} label={t('postDetail.more')} />
      {/* The ONE status line, a sibling of the open-detail button (no nested controls): its own
          full-width line under the words (tc.indent = the checkbox + time columns and their
          gaps, so it starts on the media edge), glyph + reason in the staircase ink, and the
          post's fix on the same line, pushed to the row's trailing edge under the ⋯ (on a phone
          too, where the reason may take two lines but is never cut to a few letters). The full
          sentence also rides a real tooltip. */}
      {reason ? (
        <div data-row-status="" data-tone={retrying ? 'pending' : 'halted'} className={`order-last flex min-w-0 basis-full items-center gap-2 ${tc.indent}`}>
          <StatusIcon size={13} className={`shrink-0 ${stop.ink}`} aria-hidden="true" />
          <Tip label={reason}>
            <p className={`min-w-0 flex-1 break-words text-xs font-medium line-clamp-2 md:line-clamp-1 ${stop.ink}`}>{reason}</p>
          </Tip>
          {hasFix ? (
            <div className="-my-1 ml-auto shrink-0">
              {/* An all-projects row names its project to the navigation (App re-scopes
                  first), so Setup opens for THIS post's project. */}
              <IssueFixButton issue={issue} post={post} onNavigate={post.clientId ? (p, platform, opts) => onNavigate?.(p, platform, opts, post.clientId) : onNavigate} onEdit={editIn} size="sm" />
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

// How long the bulk delete's and the bulk move's Undo stays up (the owner's pick: no dialog,
// Undo for 10 s).
const UNDO_MS = 10_000;

// The composer edits the planner's own platforms; a Radar reply lane it has no target for
// (Bluesky) would open an empty editor, so such a post opens its detail instead.
function canCompose(post) {
  const lanes = post?.platforms || [];
  return lanes.length > 0 && lanes.every((p) => PLATFORMS.includes(p));
}

// The List's bulk header (planner bulk, package P; one slim line since 2026-11-05). The shared
// selection (lib/useSelection.js) with the List's layout (BulkBar.jsx ListBar): a FIXED action
// set as glyphs (an action that applies to none of the selection is disabled with its reason,
// never hidden). Before the press, what it will leave out rides the action's tooltip ("3 werden
// nicht freigegeben: LinkedIn nicht verbunden"); after a run ONE toast says what it did and what
// it left out and why ("4 Beiträge gelöscht. 1 nicht gelöscht: Bluesky-Ankündigung ist
// veröffentlicht"), with Rückgängig for a delete and a move. The rows that went through leave the
// selection. In All projects every call carries the post's own clientId (lib/bulkPlan.js decides
// what each action may touch).
function ListBulkBar({ sel, setupFor, barRef }) {
  const t = useT();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const { effectiveSelection, count, allSelected, toggleAll, clear, runBulk, bulkProgress } = sel;
  const [active, setActive] = useState(null); // the running action, for its progress
  const [moveOpen, setMoveOpen] = useState(false);
  const nameOf = useCallback((p) => shortName(postDisplayTitle(p, t('planner.list.untitled'))), [t]);
  // The agent fixes content problems only, and only while the post's project has it connected
  // (IssueFixButton's own rule: fix type 'edit' + agentAvailable).
  const canAgentFix = useCallback((p) => {
    const s = setupFor(p);
    const issue = postIssue(p, s);
    return issue?.fix?.type === 'edit' && Boolean(issue.fix.agent) && agentAvailable(s);
  }, [setupFor]);
  const plan = useMemo(() => bulkPlan(effectiveSelection, { setupFor, canAgentFix }), [effectiveSelection, setupFor, canAgentFix]);
  const agentConnected = useMemo(() => effectiveSelection.some((p) => agentAvailable(setupFor(p))), [effectiveSelection, setupFor]);
  const label = {
    delete: t('listBulk.label.deleted'),
    approve: t('approvals.bulk.labelApproved'),
    move: t('listBulk.label.moved'),
    park: t('listBulk.label.parked'),
    resume: t('listBulk.label.resumed'),
    agent: t('listBulk.label.agent'),
  };
  // Everything Freigeben leaves out, so every row it leaves selected is named (round 3, item 5):
  // a lane not connected, already approved, published.
  const approveSkips = [
    ...plan.offline.map((post) => ({ post, reason: 'offline', lanes: unconnectedLanes(post, setupFor(post)) })),
    ...plan.approveSkipped,
  ];
  const parkMode = plan.parkable.length || !plan.resumable.length ? 'park' : 'resume';

  // What a press would leave out, said only for an action that applies (an action that applies to
  // none of the selection is disabled and says why instead).
  const notes = {
    delete: plan.deletable.length ? willNotLine(label.delete, plan.keptPublished.map((post) => ({ post, reason: 'published' })), t) : null,
    approve: plan.approvable.length ? willNotLine(label.approve, approveSkips, t) : null,
    move: plan.movable.length ? willNotLine(label.move, plan.unmovable, t) : null,
    agent: plan.agentFixable.length ? willNotLine(label.agent, plan.agentSkipped.map((post) => ({ post, reason: 'notFixable' })), t) : null,
  };
  const reasons = {
    delete: plan.deletable.length ? null : t('listBulk.disabled.delete'),
    approve: plan.approvable.length ? null : plan.offline.length
      ? t('listBulk.reason.offline', { lanes: plan.offlineLanes.map(laneLabel).join(', ') })
      : t('listBulk.disabled.approve'),
    move: plan.movable.length ? null : t('listBulk.disabled.move'),
    park: plan.parkable.length || plan.resumable.length ? null : t('listBulk.disabled.park'),
    agent: plan.agentFixable.length ? null : agentConnected ? t('listBulk.disabled.agent') : t('listBulk.disabled.noAgent'),
  };
  // A press on a disabled action says why where a finger can read it (touch has no tooltip).
  const onDisabledPress = (id) => {
    if (reasons[id]) showToast({ kind: 'error', text: reasons[id] });
  };

  // One run: progress on its own glyph, then ONE toast: what went through (`head(done)`, with
  // the run's Undo where it has one) and what it left out and why. The rows that went through
  // have left the selection, so the rows still ticked are the ones the toast names.
  const run = async (key, action, list, { skips = [], verb, head = null } = {}) => {
    setActive(key);
    let settled = { done: [], skipped: [], fails: [] };
    try {
      await runBulk(action, verb, list, { onSettled: (r) => { settled = r; } });
    } catch { /* the failures are in `settled`; the toast below names them */ }
    setActive(null);
    const doneKeys = new Set(settled.done.map(selectionKey));
    const items = [
      ...skips.filter((it) => !doneKeys.has(selectionKey(it.post))),
      ...settled.fails.map((f) => ({ post: f.post, reason: 'failed', text: f.text })),
    ];
    const left = notDoneLine(verb, items, nameOf, t);
    const done = settled.done.length && head ? head(settled.done) : null;
    const raw = settled.fails.filter((f) => f.raw).map((f) => `${nameOf(f.post)}: ${f.raw}`).join('\n') || null;
    if (done || left) {
      showToast({
        kind: settled.fails.length || !done ? 'error' : 'success',
        text: [done?.text, left].filter(Boolean).join('. '),
        raw,
        action: done?.action || null,
        duration: done?.action ? UNDO_MS : null,
      });
    }
    return settled;
  };

  const undoDelete = async (posts) => {
    const outcome = await restoreAll(posts, (p) => restorePost(p.campaign, p.id, p.clientId));
    queryClient.invalidateQueries({ queryKey: ['plans'] });
    showToast(restoreToast(outcome, nameOf, t));
  };

  const runDelete = async () => {
    // No dialog: the post goes to its campaign's trash for 30 days, and the toast carries the
    // Undo for 10 s. Never forced, so a published post is never touched here. A delete the
    // engine could not trash (trashed:false) went through for good: no Undo for that post.
    const permanent = [];
    await run('delete', async (p) => {
      const r = await deletePost(p.campaign, p.id, false, p.clientId);
      if (r?.trashed === false) permanent.push(p);
    }, plan.deletable, {
      verb: label.delete,
      skips: plan.keptPublished.map((post) => ({ post, reason: 'published' })),
      head: (done) => {
        const undoable = done.filter((p) => !permanent.includes(p));
        return {
          text: deleteToastText({ deleted: done, permanent }, nameOf, t),
          action: undoable.length ? { label: t('listBulk.toast.undo'), onClick: () => { undoDelete(undoable); } } : null,
        };
      },
    });
  };

  const runApprove = async () => {
    // Approvals' rule: a post whose lane is not connected is left out (approving publishes nothing
    // there). A Radar reply past its draft time goes out 5 minutes after the approval (the
    // engine's contract): the toast says so, a time never moves silently. The engine's own notes
    // (an image not online yet, brand-rule hints) ride the same toast.
    const now = Date.now();
    const retimed = plan.approvable.filter((p) => retimedOnApprove(p, now));
    const results = [];
    await run('approve', async (p) => { results.push(await approvePost(p.campaign, p.id, undefined, p.clientId)); }, plan.approvable, {
      verb: label.approve,
      skips: approveSkips,
      head: (done) => {
        const moved = retimed.filter((p) => done.includes(p));
        const notice = approveNoticeText(results, t);
        const base = notice || doneToastText(done.length, label.approve, t);
        if (!moved.length) return { text: base };
        const line = t('approve.notice.retimed', { names: nameList(moved, nameOf, t) });
        return { text: notice ? `${base} ${line}` : `${base}. ${line}` };
      },
    });
  };

  const undoMove = async (moves) => {
    let ok = 0;
    const fails = [];
    for (const { post, from } of moves) {
      try {
        try {
          await reschedulePost(post.campaign, post.id, from, false, post.clientId); // eslint-disable-line no-await-in-loop
        } catch (err) {
          if (err?.code !== 'needs_confirm') throw err;
          // eslint-disable-next-line no-await-in-loop
          const yes = await confirm({ title: t('postDetail.confirm.title'), body: t('reschedule.confirm.body'), confirmLabel: t('postDetail.confirm.continue'), danger: true });
          if (!yes) continue; // eslint-disable-line no-continue
          await reschedulePost(post.campaign, post.id, from, true, post.clientId); // eslint-disable-line no-await-in-loop
        }
        ok += 1;
      } catch (err) {
        fails.push({ post, err });
      }
    }
    queryClient.invalidateQueries({ queryKey: ['plans'] });
    showToast(fails.length
      ? { kind: 'error', text: { text: t('listBulk.toast.moveBackFailed', { names: nameList(fails.map((f) => f.post), nameOf, t) }), raw: fails.map((f) => f.err?.message).filter(Boolean).join('\n') || null } }
      : { kind: 'success', text: doneToastText(ok, t('listBulk.label.movedBack'), t) });
  };

  const runMove = async (spec) => {
    const now = Date.now();
    const skips = [...plan.unmovable];
    const moves = [];
    await run('move', async (p) => {
      const target = moveTarget(p.scheduledAt, spec, now);
      if (target.skip) {
        if (target.skip !== 'same') skips.push({ post: p, reason: target.skip });
        return SKIP;
      }
      try {
        await reschedulePost(p.campaign, p.id, target.iso, false, p.clientId);
      } catch (err) {
        if (err?.code !== 'needs_confirm') throw err;
        // A native schedule (Facebook, YouTube) or an unconfirmed Facebook publish: the owner
        // confirms per post, with the Studio's own sentence.
        const ok = await confirm({
          title: t('postDetail.confirm.title'),
          body: t(err?.error === 'publish_unconfirmed' ? 'reschedule.confirm.unconfirmedBody' : 'reschedule.confirm.body'),
          confirmLabel: t('postDetail.confirm.continue'),
          danger: true,
        });
        if (!ok) { skips.push({ post: p, reason: 'declined' }); return SKIP; }
        await reschedulePost(p.campaign, p.id, target.iso, true, p.clientId);
      }
      moves.push({ post: p, from: p.scheduledAt });
      return undefined;
    }, plan.movable, {
      verb: label.move,
      skips,
      head: (done) => {
        const back = moves.filter((m) => done.includes(m.post));
        return {
          text: doneToastText(done.length, label.move, t),
          action: back.length ? { label: t('listBulk.toast.undo'), onClick: () => { undoMove(back); } } : null,
        };
      },
    });
  };

  const runPark = async () => {
    const skips = [];
    await run('park', async (p) => {
      try {
        await unschedulePost(p.campaign, p.id, false, p.clientId);
      } catch (err) {
        if (err?.code !== 'needs_confirm') throw err;
        const ok = await confirm({ title: t('postDetail.confirm.title'), body: t('postDetail.park.confirmBody'), confirmLabel: t('postDetail.confirm.continue'), danger: true });
        if (!ok) { skips.push({ post: p, reason: 'declined' }); return SKIP; }
        await unschedulePost(p.campaign, p.id, true, p.clientId);
      }
      return undefined;
    }, plan.parkable, { verb: label.park, skips, head: (done) => ({ text: doneToastText(done.length, label.park, t) }) });
  };

  // Resume re-arms the post: unschedule set executionMode 'parked', and the scheduler skips any
  // post that is not 'fully-scheduled'. A reschedule never resets it, so this writes it back.
  const runResume = async () => {
    await run('resume', (p) => updatePost(p.campaign, p.id, p.rev, { executionMode: 'fully-scheduled' }, p.clientId), plan.resumable, {
      verb: label.resume,
      head: (done) => ({ text: doneToastText(done.length, label.resume, t) }),
    });
  };

  // The engine runs one fix at a time, so this is a queue: each post starts once the agent is
  // free and the next waits for its job to settle. Each row says "Agent working" meanwhile.
  const runAgent = async () => {
    await run('agent', async (p) => {
      const job = await runAgentFixQueued(p, {
        start: async (x) => {
          await agentFixPost(x.campaign, x.id, x.clientId);
          queryClient.invalidateQueries({ queryKey: ['agentFix'] });
        },
        list: (x) => getAgentFixes(x.clientId),
        jobFor: (data, x) => fixFor(data, x.campaign, x.id, x.clientId),
      });
      // A job that failed is a failed post in the toast (its row says why).
      if (job?.state === 'failed') throw new Error(job.summary || 'agent fix failed');
    }, plan.agentFixable, {
      verb: label.agent,
      skips: plan.agentSkipped.map((post) => ({ post, reason: 'notFixable' })),
      head: (done) => ({ text: doneToastText(done.length, label.agent, t) }),
    });
    queryClient.invalidateQueries({ queryKey: ['agentFix'] });
  };

  // ---- the glyphs ----------------------------------------------------------------------------
  const busy = active !== null;
  const progressOf = (key, verbKey) => (active === key && bulkProgress ? t('listBulk.progress', { verb: t(verbKey), ...bulkProgress }) : null);
  // Each glyph's name carries how many posts it will act on ("3 freigeben"); a disabled one is
  // named by its verb alone and says why.
  const nameFor = (n, countKey, verbKey) => (n ? t(countKey, { n }) : t(verbKey));
  const names = {
    approve: nameFor(plan.approvable.length, 'approvals.bulk.approveN', 'approvals.action.approve'),
    move: nameFor(plan.movable.length, 'listBulk.action.moveN', 'listBulk.action.move'),
    park: nameFor(plan.parkable.length, 'listBulk.action.parkN', 'listBulk.action.park'),
    resume: nameFor(plan.resumable.length, 'listBulk.action.resumeN', 'listBulk.action.resume'),
    agent: nameFor(plan.agentFixable.length, 'listBulk.action.agentN', 'issue.fix.agent'),
    delete: nameFor(plan.deletable.length, 'listBulk.action.deleteN', 'listBulk.action.delete'),
  };
  const common = (id) => ({
    id,
    disabled: Boolean(reasons[id]) || (busy && active !== id),
    reason: reasons[id] || null,
    note: notes[id] || null,
    busy: active === id,
    onDisabledPress,
  });

  const actions = (
    <>
      <BarAction {...common('approve')} icon={CheckCircle2} tone="success" label={names.approve} busyLabel={progressOf('approve', 'approvals.action.approve')} onClick={runApprove} />
      <MoveControl
        count={plan.movable.length}
        open={moveOpen}
        onOpenChange={setMoveOpen}
        onMove={(spec) => { runMove(spec); }}
        trigger={(
          <BarAction {...common('move')} icon={CalendarClock} label={names.move} busyLabel={progressOf('move', 'listBulk.action.move')} onClick={() => setMoveOpen(true)} />
        )}
      />
      {parkMode === 'park' ? (
        <BarAction {...common('park')} icon={PauseCircle} label={names.park} busyLabel={progressOf('park', 'listBulk.action.park')} onClick={runPark} />
      ) : (
        <BarAction {...common('resume')} icon={PlayCircle} label={names.resume} busyLabel={progressOf('resume', 'listBulk.action.resume')} onClick={runResume} />
      )}
      <BarAction {...common('agent')} icon={Bot} label={names.agent} busyLabel={progressOf('agent', 'issue.fix.agent')} onClick={runAgent} />
      {/* The one destructive glyph comes last, a step apart from the rest. */}
      <span className="ml-2 inline-flex">
        <BarAction {...common('delete')} icon={Trash2} tone="danger" label={names.delete} busyLabel={progressOf('delete', 'listBulk.action.delete')} onClick={runDelete} />
      </span>
    </>
  );

  return (
    <ListBar
      barRef={barRef}
      count={count}
      allSelected={allSelected}
      someSelected={count > 0 && !allSelected}
      onToggleAll={toggleAll}
      spot="bulk-select"
      onClear={clear}
      actions={actions}
    />
  );
}

// "Verschieben": by N days, or onto one date keeping each post's own time. A small form in a
// popover anchored on the header's Move glyph; the run reports in the toast like every other.
function MoveControl({ count, open, onOpenChange, onMove, trigger }) {
  const t = useT();
  const [mode, setMode] = useState('days');
  const [days, setDays] = useState(1);
  const [date, setDate] = useState(() => localDateValue(addDays(new Date(), 1)));
  const submit = (e) => {
    e.preventDefault();
    onOpenChange(false);
    onMove(mode === 'days' ? { days: Number(days) || 0 } : { date });
  };
  const field = 'w-full rounded-lg bg-white/80 px-2 py-1.5 text-xs font-medium ring-1 ring-zinc-900/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 dark:bg-zinc-800/80 dark:ring-white/10';
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <span className="inline-flex">{trigger}</span>
      </PopoverAnchor>
      <PopoverContent align="start" className="w-64 p-3" aria-label={t('listBulk.action.move')}>
        <form onSubmit={submit} className="space-y-3">
          <fieldset className="space-y-2">
            <legend className="sr-only">{t('listBulk.action.move')}</legend>
            <label className="flex items-center gap-2 text-xs font-bold">
              <input type="radio" name="move-mode" value="days" checked={mode === 'days'} onChange={() => setMode('days')} className="accent-brand" />
              {t('listBulk.move.byDays')}
            </label>
            <input
              type="number"
              inputMode="numeric"
              step="1"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              disabled={mode !== 'days'}
              aria-label={t('listBulk.move.days')}
              className={field}
            />
            <label className="flex items-center gap-2 text-xs font-bold">
              <input type="radio" name="move-mode" value="date" checked={mode === 'date'} onChange={() => setMode('date')} className="accent-brand" />
              {t('listBulk.move.toDate')}
            </label>
            <input
              type="date"
              value={date}
              min={localDateValue()}
              onChange={(e) => setDate(e.target.value)}
              disabled={mode !== 'date'}
              aria-label={t('listBulk.move.date')}
              className={field}
            />
          </fieldset>
          <button type="submit" className="w-full rounded-xl bg-brand px-3 py-1.5 text-xs font-bold text-white transition hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-brand-light dark:text-zinc-900">
            {t(count === 1 ? 'listBulk.move.apply.one' : 'listBulk.move.apply', { n: count })}
          </button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

// The List's keyboard shortcuts, for the filter bar's "?" popover (App.jsx passes them while the
// Planer shows the List): the keys ListView takes below, no hint line on the page itself.
export function ListKeyboardShortcuts() {
  const t = useT();
  return (
    <ShortcutList
      rows={[
        { keys: ['j', 'k'], label: t('approvals.keys.navigate') },
        { keys: ['x'], label: t('listBulk.keys.select') },
        { keys: ['Enter'], label: t('listBulk.keys.open') },
        { keys: ['e'], label: t('listBulk.keys.edit') },
        { keys: ['Esc'], label: t('approvals.selectAll.clear') },
      ]}
    />
  );
}

// A day heading of the List: sticky under the bulk line (`top`, its height in px while it sticks).
// It wears the panel's opaque surface only while actually pinned (lib/useStuck.js), the same as
// the stuck bulk line, so the stuck pair reads as one strip; in the flow it stays transparent,
// since any opaque fill reads as a band on the translucent glass panel.
function DayHeading({ top, children }) {
  const ref = useRef(null);
  const stuck = useStuck(ref, { top, bounded: true });
  return (
    <div
      ref={ref}
      data-day-heading=""
      data-stuck={stuck ? '' : undefined}
      className="group sticky z-10 mb-1.5 flex items-center gap-3 rounded-xl px-2 py-1 data-[stuck]:bg-[#fdfefe] dark:data-[stuck]:bg-[#121215]"
      style={{ top: 'var(--pp-bulk-h, 0px)' }}
    >
      {children}
    </div>
  );
}

// Keys the List takes for itself, never while the owner types, a menu or picker owns the keys,
// or a dialog (the post detail, a confirm) is open.
function listKeysAllowed(e) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return false;
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  const tag = el?.tagName;
  if ((tag === 'INPUT' && el.type !== 'checkbox') || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return false;
  if (document.querySelector('[aria-modal="true"]')) return false;
  if (document.querySelector('[data-state="open"]')) return false;
  return true;
}

export function ListView({ posts, onSelect, onEdit, onNavigate, loading, showAllDays = false, setupFor: setupForProp = null, threadPool = null }) {
  const t = useT();
  const dated = useMemo(
    () => posts.filter((p) => p.scheduledAt).sort(comparePostDate),
    [posts],
  );
  const undated = useMemo(() => posts.filter((p) => !p.scheduledAt), [posts]);
  const groups = useMemo(() => {
    const out = [];
    let cur = null;
    for (const p of dated) {
      const k = dayKey(p.scheduledAt);
      if (!cur || cur.key !== k) {
        cur = { key: k, date: new Date(p.scheduledAt), posts: [] };
        out.push(cur);
      }
      cur.posts.push(p);
    }
    return out;
  }, [dated]);

  // Mandate G: default the List to TODAY-onwards so the owner lands where the work
  // is, with past days collapsed behind a "Show earlier" reveal. Exception: when
  // nothing is upcoming (e.g. the sidebar Overdue jump filters to past-dated rows),
  // the past stays visible so the jump is never empty.
  const todayKey = localDayKey(new Date());
  const past = useMemo(() => groups.filter((g) => g.key < todayKey), [groups, todayKey]);
  const upcoming = useMemo(() => groups.filter((g) => g.key >= todayKey), [groups, todayKey]);
  const pastCount = useMemo(() => past.reduce((n, g) => n + g.posts.length, 0), [past]);
  const [showPast, setShowPast] = useState(false);
  // showAllDays: with an active status filter the list is an ANSWER, not an
  // agenda - every match must be visible. Collapsing an overdue post from an
  // earlier day behind "Show earlier" while the chip says 2 is how "the count
  // says two, the list shows one" happened.
  const pastVisible = showAllDays || showPast || upcoming.length === 0;
  const canToggle = !showAllDays && past.length > 0 && upcoming.length > 0;

  // The rows as rendered, in order: the triage order for the detail's prev/next, the keyboard's
  // j/k order, and the only posts a selection counts (intersect-visible: a row collapsed behind
  // "Show earlier" or filtered away is never in a bulk run).
  const ordered = useMemo(
    () => [...(pastVisible ? past.flatMap((g) => g.posts) : []), ...upcoming.flatMap((g) => g.posts), ...undated],
    [pastVisible, past, upcoming, undated],
  );
  const selectInList = (post) => onSelect(post, ordered);

  // Each post is judged by its own project's setup (App hands its setupFor down; a bare render
  // reads the active project's cached setup).
  const { setupFor: cachedSetupFor } = useSetupByClient([], { enabled: false });
  const setupFor = setupForProp || cachedSetupFor;
  // Planner bulk (package P): the SAME selection as Approvals (lib/useSelection.js). Every row
  // is selectable; an X thread is one unit (selecting one tweet selects the chain).
  const nameOf = useCallback((p) => shortName(postDisplayTitle(p, t('planner.list.untitled'))), [t]);
  const sel = useSelection({ items: ordered, threadPool: threadPool || posts, chain: true, nameOf });
  const picking = sel.count > 0;
  // Below md the rows wear the phone layout (checkbox always shown, status under the title).
  const phone = useIsPhone();

  // --pp-bulk-h: the sticky day headings sit EXACTLY under the bulk line while it sticks (it does
  // only while something is selected; idle it scrolls away and the headings stick at 0). Measured
  // rather than guessed. `bulkH` is the same height in px, for the headings' stuck check.
  const rootRef = useRef(null);
  const barRef = useRef(null);
  const [bulkH, setBulkH] = useState(0);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const bar = barRef.current;
    if (!root) return undefined;
    const set = () => {
      const sticky = bar ? getComputedStyle(bar).position === 'sticky' : false;
      const h = sticky ? bar.offsetHeight : 0;
      root.style.setProperty('--pp-bulk-h', `${h}px`);
      setBulkH(h);
    };
    set();
    window.addEventListener('resize', set);
    const ro = bar && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(set) : null;
    if (ro) ro.observe(bar);
    return () => {
      window.removeEventListener('resize', set);
      if (ro) ro.disconnect();
    };
  }, [picking]);

  // Keyboard (the owner's pick): j / k move between rows, x selects the row, Enter opens it,
  // e opens it in the editor (a post the composer cannot edit opens its detail), Esc clears.
  const rowRefs = useRef(new Map());
  const focusKeyRef = useRef(null);
  const registerRow = useCallback((key) => (el) => {
    if (el) rowRefs.current.set(key, el);
    else rowRefs.current.delete(key);
  }, []);
  const latest = useRef({});
  latest.current = { ordered, sel, onEdit, selectInList };
  useEffect(() => {
    const onKey = (e) => {
      if (!['j', 'k', 'x', 'e', 'Enter', 'Escape'].includes(e.key)) return;
      if (!listKeysAllowed(e)) return;
      const { ordered: rows, sel: s, onEdit: edit, selectInList: open } = latest.current;
      if (!rows.length) return;
      const active = document.activeElement;
      const rowEl = active?.closest?.('li[data-row-key]');
      const currentKey = (rowEl && rowRefs.current.get(rowEl.dataset.rowKey) === rowEl) ? rowEl.dataset.rowKey : focusKeyRef.current;
      const idx = rows.findIndex((p) => selectionKey(p) === currentKey);
      const focusAt = (i) => {
        const post = rows[Math.max(0, Math.min(rows.length - 1, i))];
        const key = selectionKey(post);
        focusKeyRef.current = key;
        const el = rowRefs.current.get(key);
        if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); }
      };
      if (e.key === 'j') { e.preventDefault(); focusAt(idx === -1 ? 0 : idx + 1); return; }
      if (e.key === 'k') { e.preventDefault(); focusAt(idx === -1 ? 0 : idx - 1); return; }
      if (e.key === 'Escape') { if (s.count) { e.preventDefault(); s.clear(); } return; }
      const post = idx === -1 ? null : rows[idx];
      if (!post) return;
      if (e.key === 'x') { e.preventDefault(); s.toggle(post); return; }
      // Enter on the row itself opens it; on a control inside the row, the control keeps it.
      if (e.key === 'Enter') { if (active === rowEl) { e.preventDefault(); open(post); } return; }
      if (e.key === 'e' && post.derivedState !== 'posted' && post.derivedState !== 'fired-assumed') {
        e.preventDefault();
        if (edit && canCompose(post)) edit(post);
        else open(post);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-16 w-full" />)}
      </div>
    );
  }
  if (!dated.length && !undated.length) {
    return (
      <div className="grid h-full place-items-center py-16">
        <div className="max-w-xs space-y-2 text-center">
          <CalendarDays size={26} className="mx-auto text-zinc-500" aria-hidden="true" />
          <p className="text-sm font-bold">{t('planner.empty.title')}</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('planner.empty.body')}</p>
        </div>
      </div>
    );
  }

  const renderRows = (list) => (
    <ul className="space-y-0.5">
      {list.map((post) => {
        const key = selectionKey(post);
        return (
          <ListRow
            key={key}
            rowKey={key}
            rowRef={registerRow(key)}
            onFocusRow={(k) => { focusKeyRef.current = k; }}
            post={post}
            posts={posts}
            onSelect={selectInList}
            onEdit={onEdit}
            onNavigate={onNavigate}
            selected={sel.isSelected(post)}
            picking={picking}
            phone={phone}
            onPick={sel.toggle}
          />
        );
      })}
    </ul>
  );

  // A day: its heading sticks to the top of the page (under the bulk line while that sticks) and
  // carries the day's checkbox, which selects (or clears) every post of the day.
  const renderSection = (key, label, list) => {
    const n = list.filter((p) => sel.isSelected(p)).length;
    return (
      <section key={key}>
        <DayHeading top={bulkH}>
          <PickBox
            checked={n > 0 && n === list.length}
            indeterminate={n > 0 && n < list.length}
            onPick={() => sel.toggleGroup(list)}
            label={t('listBulk.selectDay', { day: label })}
            shown={phone || picking}
          />
          <h3 className="font-display text-sm font-bold text-zinc-600 dark:text-zinc-300">{label}</h3>
        </DayHeading>
        {renderRows(list)}
      </section>
    );
  };

  // w-full: inside the shell's flex-column panel the box must stretch, or it would size to its
  // min-content (the longest nowrap title) and the list would scroll sideways at 375px. No
  // max-width any more (planner bulk, the owner's pick): the rows span the panel like Approvals.
  return (
    <div ref={rootRef} className="w-full min-w-0" style={{ paddingBottom: 'var(--pp-toast-h, 0px)' }}>
      {/* The bulk line is a direct child of the list root so it sticks for the whole list. */}
      <ListBulkBar sel={sel} setupFor={setupFor} barRef={barRef} />
      <div className="space-y-5">
      {canToggle ? (
        <button
          type="button"
          onClick={() => setShowPast((s) => !s)}
          aria-expanded={pastVisible}
          className="mx-auto flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold text-zinc-600 ring-1 ring-zinc-900/10 transition hover:bg-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-300 dark:ring-white/10 dark:hover:bg-zinc-800/50"
        >
          {showPast
            ? <><ChevronDown size={13} aria-hidden="true" />{t('planner.list.hideEarlier')}</>
            : <><ChevronUp size={13} aria-hidden="true" />{t('planner.list.showEarlier', { count: pastCount })}</>}
        </button>
      ) : null}
      {pastVisible ? past.map((g) => renderSection(g.key, fmtDayAria(g.date), g.posts)) : null}
      {upcoming.map((g) => renderSection(g.key, fmtDayAria(g.date), g.posts))}
      {undated.length ? renderSection('undated', t('planner.list.noSchedule'), undated) : null}
      </div>
    </div>
  );
}
