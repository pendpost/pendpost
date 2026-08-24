import { useMemo, useState } from 'react';
import { CalendarDays, ChevronUp, ChevronDown, Plus, CornerUpLeft } from 'lucide-react';
import { dayKey, localDayKey, comparePostDate, fmtTime, fmtDayShort, fmtDayNum, fmtDayAria, fmtMonthYear, addDays, postDot, campaignBaseLabel, TIME_CHIP_META, timeChipTone, gridDisplayAspect, needsAttention, postIsDimmed, getCardAccent, STATUS_PILL_META, postDisplayStatusKey, postDisplayTitle, deriveThread, collectThread } from '../lib/format.js';
import { useReschedule } from '../lib/useReschedule.js';
import { usePostActions } from '../lib/usePostActions.js';
import { useT } from '../lib/i18n.js';
import { PlatformIcons, PostStatusPill, CoverThumb, Skeleton } from './ui.jsx';
import { HdBadge } from './ui/HdBadge.jsx';
import { RowMenu } from './ui/RowMenu.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { DateTimePicker } from './ui/DateTimePicker.jsx';
import { ClientAvatar } from './ClientSwitcher.jsx';
import { PROJECT_CHIP } from './ui/recipes.js';

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
export function TimeChip({ post, lane, variant = 'overlay' }) {
  const t = useT();
  if (!post.scheduledAt) return null;
  const tone = timeChipTone(post, lane);
  const meta = TIME_CHIP_META[tone];
  const { Icon } = meta;
  const time = fmtTime(post.scheduledAt);
  const accessibleName = `${t(`timeChip.${tone}`)} - ${time}`;

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
  return (
    <Tip label={accessibleName}>
      <span role="img" aria-label={accessibleName} className={className}>
        <Icon size={11} aria-hidden="true" />
        {time}
      </span>
    </Tip>
  );
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
  return (
    // Wrapper (relative, NO overflow-hidden) so the ⋯ menu can escape the card's rounded
    // clip; the card button keeps overflow-hidden for the cover. The ⋯ is a SIBLING of the
    // open-detail button, never nested (interactive-nesting contract).
    <div className="group relative">
    <button
      type="button"
      onClick={() => onSelect(post)}
      draggable={draggable}
      onDragStart={onDragStart}
      // The card's visual content (cover, pill, meta, caption snippet) reads as a
      // stuttering pile of fragments to a SR; carry ONE clean accessible name
      // (post + type + time, like the Month/List views - the column header already
      // reads the day) so the control announces itself once.
      aria-label={`${postDisplayTitle(post, t('planner.list.untitled'))} - ${t(`type.${post.type}`)} - ${fmtTime(post.scheduledAt)}`}
      className={`relative w-full overflow-hidden rounded-xl text-left bg-white/80 dark:bg-zinc-900/70 ring-1 ring-zinc-900/[0.06] dark:ring-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.05)] transition hover:-translate-y-1 motion-reduce:hover:translate-y-0 hover:shadow-xl hover:bg-white/90 dark:hover:bg-zinc-800/80 focus-visible:ring-2 focus-visible:ring-brand ${dim ? 'opacity-60 hover:opacity-100' : ''}`}
    >
      {showBar ? <span aria-hidden="true" className={`pointer-events-none absolute left-0 top-0 bottom-0 z-10 w-1 ${meta.bar}`} /> : null}
      <div className="relative">
        <CoverThumb media={post.media} image={post.image} textPreview={post.caption} className={`${gridDisplayAspect(post)} w-full`} />
        <TimeChip post={post} lane={lane} variant="overlay" />
      </div>
      <div className="space-y-1.5 p-2">
        <div className={showStrip ? `-mx-2 -mt-2 mb-1.5 px-2 pb-1.5 pt-2 ${meta.strip}` : ''}>
          <PostStatusPill post={post} />
        </div>
        {/* Type + platforms collapse into one quiet meta line (was a separate type
            overlay badge + a standalone platform row competing at the same weight). */}
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] font-bold tracking-tight text-zinc-500 dark:text-zinc-400">
          <span className="truncate">{t(`type.${post.type}`)}</span>
          <span aria-hidden="true" className="h-1 w-1 shrink-0 rounded-full bg-current opacity-50" />
          <PlatformIcons platforms={post.platforms} size={12} />
          <HdBadge hdReady={post.media?.hdReady} bitrate={post.media?.bitrate} static />
          {/* Issue 6: the same client chip, so a Week card is legible even without
              opening it. */}
          {post.clientName ? (
            <span className={`${PROJECT_CHIP} max-w-[7rem]`}>
              <ClientAvatar client={{ displayName: post.clientName, accent: post.accent, logo: null }} size={14} />
              <span className="truncate">{post.clientName}</span>
            </span>
          ) : null}
        </div>
        <p className="line-clamp-2 text-[11px] leading-snug text-zinc-600 dark:text-zinc-300">
          {post.caption.split('\n')[0]}
        </p>
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
          triggerClassName="inline-flex items-center rounded-lg bg-black/45 p-1 text-white backdrop-blur transition hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
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
  const title = postDisplayTitle(post, t('planner.list.untitled'));
  // ONE clean accessible name (day? + post + type + time), matching the Week/List
  // cards; the inner dot/chip/type/platforms stay aria-hidden so a SR hears the
  // name once instead of a stuttering fragment pile.
  const name = `${dayLabel ? `${dayLabel} - ` : ''}${title} - ${t(`type.${post.type}`)} - ${fmtTime(post.scheduledAt)}${post.clientName ? ` - ${post.clientName}` : ''}`;
  return (
    <button
      type="button"
      onClick={() => onSelect(post)}
      draggable={draggable}
      onDragStart={draggable ? postDragStart(post) : undefined}
      aria-label={name}
      className="flex w-full items-center gap-1 rounded-md bg-white/70 px-1.5 py-0.5 text-left text-[10px] ring-1 ring-zinc-900/10 transition hover:bg-white dark:bg-zinc-800/70 dark:ring-white/10 dark:hover:bg-zinc-700 focus-visible:ring-2 focus-visible:ring-brand"
    >
      {/* Status dot so attention states read at compact zoom (UX-05); color is never
          the sole signal - the button's aria-label carries the post identity. */}
      <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${postDot(post)}`} />
      {/* FR1: color-coded time chip (visual only inside the labeled button) */}
      <span aria-hidden="true" className="contents">
        <TimeChip post={post} lane={lane} variant="inline" />
      </span>
      {/* Roomy Week column: the title carries identity, so it takes the free space
          and the type word is dropped (redundant next to the platform icon). The
          narrow Month cell has no title, so it keeps the type word instead. */}
      {showTitle ? (
        <span aria-hidden="true" className="min-w-0 flex-1 truncate font-bold text-zinc-700 dark:text-zinc-200">{title}</span>
      ) : (
        <span aria-hidden="true" className="truncate text-zinc-500 dark:text-zinc-400">{t(`type.${post.type}`)}</span>
      )}
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
  );
}

// One shared empty-period state for both Week and Month (the markup was identical
// in both). The body copy tells the owner to "create a post with New", so when the
// parent wires onNew we render the matching resolving control - the CTA the copy
// promises - instead of a dead state. The button is sentence-case, single solid
// color, weight <= 700, with a Plus icon so the color is never the only signal.
function EmptyPeriod({ onNew }) {
  const t = useT();
  return (
    <div className="col-span-7 grid place-items-center py-16">
      <div className="max-w-xs space-y-2 text-center">
        <CalendarDays size={26} className="mx-auto text-zinc-500" aria-hidden="true" />
        <p className="text-sm font-bold">{t('planner.empty.periodTitle')}</p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {t('planner.empty.periodBody')}
        </p>
        {onNew ? (
          <button
            type="button"
            onClick={() => onNew()}
            className="mx-auto mt-1 inline-flex items-center gap-1.5 rounded-xl bg-brand px-3 py-1.5 text-xs font-bold text-white transition hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <Plus size={14} aria-hidden="true" />
            {t('composer.newPost')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function WeekView({ posts, weekStart, onSelect, onEdit, onMoveToDay, loading, lane, onNew, density = 'comfortable' }) {
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
      {allEmpty ? <EmptyPeriod onNew={onNew} /> : null}
      {days.map((day) => {
        const key = localDayKey(day);
        const isToday = key === todayKey;
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
                <span className={`text-xs font-bold ${isToday ? 'text-brand dark:text-brand-light' : 'text-zinc-500 dark:text-zinc-400'}`}>
                  {fmtDayShort(day)}
                </span>
                <span className={`font-display text-sm font-bold ${isToday ? 'text-brand dark:text-brand-light' : ''}`}>
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

export function MonthView({ posts, monthAnchor, onSelect, onMoveToDay, loading, lane, onNew, onShowDay }) {
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
      {allEmpty ? <EmptyPeriod onNew={onNew} /> : null}
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
                  className="w-full rounded-md px-1 py-0.5 text-left text-[10px] text-zinc-500 dark:text-zinc-400 transition hover:bg-white/70 hover:text-zinc-600 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
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

// Chronological list view (the "see everything in order + filter on status"
// surface): day-grouped, dense full-width rows, primary title/time over muted
// meta. Two sibling affordances per row (no nested buttons): the time opens an
// inline reschedule picker (non-published posts only), the rest opens the detail.
function ListRow({ post, posts = [], onSelect, onEdit, lane }) {
  const t = useT();
  const reschedule = useReschedule();
  // The overview action set (Freigeben / Ablehnen / Parken / Prüfen / Löschen, + Editor
  // when onEdit is threaded), shared with the detail drawer via the same gate predicates.
  const { items } = usePostActions(post, { onEdit });
  const published = post.derivedState === 'posted' || post.derivedState === 'fired-assumed';
  // X thread folding: a reply whose parent is also visible is indented under it;
  // a parent shows how many replies thread beneath it. Same-campaign only.
  const { parent: threadParent, replies: threadReplies } = deriveThread(post, posts);
  const isReply = Boolean(post.xReplyTo && threadParent);
  return (
    <li className={`group flex items-center gap-3 rounded-xl p-2 ring-1 ring-transparent transition hover:bg-white/70 dark:hover:bg-zinc-800/50 ${isReply ? 'ml-5 border-l-2 border-zinc-200 pl-3 dark:border-zinc-700' : ''}`}>
      {published ? (
        <span className="w-11 shrink-0 text-center font-display text-sm font-bold">
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
              className="w-11 shrink-0 rounded-md py-1 text-center font-display text-sm font-bold transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60"
            >
              {post.scheduledAt ? fmtTime(post.scheduledAt) : EMPTY_TIME}
            </button>
          )}
        />
      )}
      {/* ZONE 1 (preview) + ZONE 2 (information) share the open-detail button: clicking
          anywhere here opens the full post. The standalone approval chip + inline Park
          button that used to sit on the LEFT are gone - approval now reads in the single
          status slot on the right (green when approved), and Park lives in the ⋯ menu. */}
      <button
        type="button"
        onClick={() => onSelect(post)}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        {/* A correct-ASPECT mini cover (a 9:16 Short reads as a mini Short, not a cropped
            square) for visual guidance, matching the Week card. A media-less text post has
            no thumbnail, so its placeholder yields on the narrow layout to protect the
            title width; real media shows at every width. */}
        <CoverThumb media={post.media} image={post.image} textPreview={post.caption} className={`h-12 ${gridDisplayAspect(post)} shrink-0 rounded-lg ${post.media?.exists || post.image ? '' : 'hidden sm:block'}`} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold">
            {postDisplayTitle(post, t('planner.list.untitled'))}
          </p>
          <p className="flex min-w-0 items-center gap-1.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
            <span className="min-w-0 truncate">{campaignBaseLabel(post.campaign)} · {post.id} · {t(`type.${post.type}`)}</span>
            {/* Issue 6: the same client chip Freigaben's cards carry, shown only
                when all-clients mode stamped one. */}
            {post.clientName ? (
              <span className={`${PROJECT_CHIP} max-w-[8rem]`}>
                <ClientAvatar client={{ displayName: post.clientName, accent: post.accent, logo: null }} size={14} />
                <span className="truncate">{post.clientName}</span>
              </span>
            ) : null}
          </p>
        </div>
        {/* X thread glyph (xReplyTo): marks a chained post so it is never
            mistaken for a standalone one; the detail panel names the parent. */}
        {post.xReplyTo ? (
          <span className="shrink-0 text-zinc-500 dark:text-zinc-400">
            <CornerUpLeft size={13} aria-hidden="true" />
            <span className="sr-only">{t('planner.list.replyChain', { id: post.xReplyTo })}</span>
          </span>
        ) : null}
        {/* Thread membership, shown ONCE on the opener only: a reply row (xReplyTo
            truthy) carries the reply glyph + indent instead, so a linear 6-post
            thread reads as one "Thread · 6 posts" head badge rather than five
            look-alike per-row badges. Count the whole transitive chain including
            the opener (collectThread.length = total posts in the thread). */}
        {threadReplies.length && !post.xReplyTo ? (
          <span className="shrink-0 rounded-full bg-zinc-500/10 px-1.5 py-0.5 text-[10px] font-bold text-zinc-500 dark:text-zinc-400">
            {t('planner.list.threadCount', { count: collectThread(post, posts).length })}
          </span>
        ) : null}
        {/* Information markers: platform glyphs + the HD/720p chip. Subordinate to the
            status slot on the right - they say WHAT the post is, not its state. */}
        <PlatformIcons platforms={post.platforms} />
        <HdBadge hdReady={post.media?.hdReady} bitrate={post.media?.bitrate} static />
      </button>
      {/* ZONE 3 (status + actions), siblings of the open-detail button so no interactive
          control nests inside another. The ONE status slot leads (green "Freigegeben" when
          approved and on track, an attention tone otherwise); the ⋯ menu carries every
          action. The pill stays desktop-only for settled posts to keep a phone row calm,
          but an attention state shows at every width (needsAttention, same predicate the
          card accent uses). */}
      <span className={`items-center ${needsAttention(post) ? 'flex' : 'hidden md:flex'}`}>
        <PostStatusPill post={post} />
      </span>
      <RowMenu items={items} label={t('postDetail.more')} />
    </li>
  );
}

export function ListView({ posts, onSelect, onEdit, loading, lane, showAllDays = false }) {
  const t = useT();
  const dated = useMemo(
    () => posts.filter((p) => p.scheduledAt).sort(comparePostDate),
    [posts],
  );
  const undated = useMemo(() => posts.filter((p) => !p.scheduledAt), [posts]);
  // The visible render order (dated groups first, then undated), threaded into
  // onSelect so the detail dialog can triage prev/next through this exact list.
  const ordered = useMemo(() => [...dated, ...undated], [dated, undated]);
  const selectInList = (post) => onSelect(post, ordered);
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

  const renderGroup = (g) => (
    <section key={g.key}>
      <h3 className="mb-1.5 px-1 font-display text-sm font-bold text-zinc-500 dark:text-zinc-400">{fmtDayAria(g.date)}</h3>
      <ul className="space-y-1">
        {g.posts.map((post) => <ListRow key={`${post.campaign}-${post.id}`} post={post} posts={posts} onSelect={selectInList} onEdit={onEdit} lane={lane} />)}
      </ul>
    </section>
  );

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      {canToggle ? (
        <button
          type="button"
          onClick={() => setShowPast((s) => !s)}
          aria-expanded={pastVisible}
          className="mx-auto flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold text-zinc-500 ring-1 ring-zinc-900/10 transition hover:bg-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:ring-white/10 dark:hover:bg-zinc-800/50"
        >
          {showPast
            ? <><ChevronDown size={13} aria-hidden="true" />{t('planner.list.hideEarlier')}</>
            : <><ChevronUp size={13} aria-hidden="true" />{t('planner.list.showEarlier', { count: pastCount })}</>}
        </button>
      ) : null}
      {pastVisible ? past.map(renderGroup) : null}
      {upcoming.map(renderGroup)}
      {undated.length ? (
        <section>
          <h3 className="mb-1.5 px-1 font-display text-sm font-bold text-zinc-500 dark:text-zinc-400">{t('planner.list.noSchedule')}</h3>
          <ul className="space-y-1">
            {undated.map((post) => <ListRow key={`${post.campaign}-${post.id}`} post={post} posts={posts} onSelect={selectInList} onEdit={onEdit} lane={lane} />)}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
