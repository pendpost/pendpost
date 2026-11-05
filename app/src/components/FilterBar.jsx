// FilterBar - the shared filter bar over the planner, Approvals, Activity, Published and
// Insights (planner bulk, 2026-11-01, package P; it lived inline in App.jsx).
//
// The owner's pick: two rows wherever a status filter applies (the planner, Approvals' "All
// posts" tab).
//   Row 1: the status tabs with live counts. Alle, Braucht dich, Entwürfe, Zur Freigabe,
//          Geplant, Veröffentlicht, then "Mehr" for the rarer three (Abgelehnt, Überfällig,
//          Pausiert). Single-select; "Alle" is no status filter. A count respects the platform
//          and type filters but never the status (it says what the tab WOULD show). It replaces
//          the Status dropdown, which hid both the choice and the numbers behind a click.
//   Row 2: the platforms as icon-only toggles (the name rides the tooltip and the accessible
//          name), the Type dropdown, Zurücksetzen and the "?" legend.
// A page without status (Activity, Published, Insights, Approvals' "To review") keeps one row.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, HelpCircle } from 'lucide-react';
import { useIsPhone } from '../lib/useIsPhone.js';
import { PLATFORM_META, StatusLegend } from './ui.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { Popover, PopoverTrigger, PopoverContent, PopoverClose } from './ui/Popover.jsx';
import { MultiSelectDropdown } from './ui/MultiSelectDropdown.jsx';
import { TAP_TARGET, TAP_TARGET_Y } from './ui/recipes.js';
import { STATUS_TABS, STATUS_MORE } from '../lib/format.js';
import { useT } from '../lib/i18n.js';

// A status tab: a selection pill (round-full = state or selection, ui/recipes.js), the word and
// its live count. The count is a separate span so the accessible name reads "Drafts 4".
const TAB = 'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';
const TAB_ON = 'bg-brand text-white dark:bg-brand-light dark:text-zinc-900';
const TAB_OFF = 'text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-700/60';

// The count wears the tab's own ink at full strength: an opacity-80 count on zinc-600 fell to
// about 4.4:1, under the 4.5:1 small text needs.
function Count({ n }) {
  return <span className="font-medium tabular-nums">{n ?? 0}</span>;
}

// The status-colour legend behind a quiet "?" (US-FR-05: never an always-on bar). It closes the
// first row, so a phone never shows it alone on a line of its own. `extra`: a page's own help
// (Approvals: its keyboard shortcuts), under a divider in the same popover.
function Legend({ extra = null }) {
  const t = useT();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={t('statusLegend.title')} data-filter-legend="" className={`${TAP_TARGET} shrink-0 rounded-full p-1.5 text-zinc-600 transition hover:bg-zinc-200/60 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:bg-zinc-700/60 dark:hover:text-zinc-200`}>
          <HelpCircle size={14} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-3">
        <StatusLegend />
        {extra ? <div className="mt-3 border-t border-zinc-900/10 pt-3 dark:border-white/10">{extra}</div> : null}
      </PopoverContent>
    </Popover>
  );
}

// How many of the main tabs fit on one line beside "All" and "More" (round 3, judge item 6: at
// 1024px the tabs wrapped to a third row). widths in px; `tabs` in their order. A width of 0 (not
// measured, a test DOM) keeps every tab.
export function tabsThatFit({ all = 0, more = 0, tabs = [], width = 0, gap = 0 }) {
  if (!width) return tabs.length;
  let used = all + more + gap;
  let k = 0;
  for (const w of tabs) {
    if (w == null || used + w + gap > width) break;
    used += w + gap;
    k += 1;
  }
  return k;
}

// The phone strip's edge fade: a mask that fades the edge hiding more tabs (both while scrolled
// to the middle), so the tabs off screen are discoverable. Null while everything shows.
const FADE = 28;
export function edgeFade({ scrollLeft = 0, scrollWidth = 0, clientWidth = 0 }) {
  const left = scrollLeft > 1;
  const right = scrollLeft + clientWidth < scrollWidth - 1;
  if (!left && !right) return null;
  if (left && right) return `linear-gradient(to right, transparent 0, #000 ${FADE}px, #000 calc(100% - ${FADE}px), transparent 100%)`;
  if (right) return `linear-gradient(to right, #000 0, #000 calc(100% - ${FADE}px), transparent 100%)`;
  return `linear-gradient(to right, transparent 0, #000 ${FADE}px, #000 100%)`;
}

function StatusTab({ tab, value, counts, onPick }) {
  const t = useT();
  const on = tab === 'all' ? !value : value === tab;
  return (
    <button type="button" onClick={() => onPick(tab)} aria-pressed={on} data-status-tab={tab} className={`${TAB} ${TAP_TARGET_Y} shrink-0 ${on ? TAB_ON : TAB_OFF}`}>
      <span>{t(`filterBar.tab.${tab}`)}</span>{' '}
      <Count n={counts[tab]} />
    </button>
  );
}

// "Mehr": the tabs that do not fit (in their order), then the rarer three. While one of them is
// the filter, the trigger wears its word and count, so the active filter is never hidden.
function MoreTabs({ keys, value, counts, onPick }) {
  const t = useT();
  const moreActive = keys.includes(value);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-pressed={moreActive} data-status-tab="more" className={`${TAB} ${TAP_TARGET_Y} shrink-0 ${moreActive ? TAB_ON : TAB_OFF}`}>
          {moreActive ? (
            <>
              <span>{t(`filterBar.tab.${value}`)}</span>{' '}
              <Count n={counts[value]} />
            </>
          ) : <span>{t('filterBar.more')}</span>}
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" role="group" aria-label={t('filterBar.more')} className="w-48 space-y-0.5 p-1.5">
        {keys.map((key) => (
          <PopoverClose asChild key={key}>
            <button
              type="button"
              onClick={() => onPick(key)}
              aria-pressed={value === key}
              data-status-tab={key}
              className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${value === key ? 'bg-brand/10 text-brand dark:bg-brand-light/10 dark:text-brand-light' : 'hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60'}`}
            >
              <span>{t(`filterBar.tab.${key}`)}</span>{' '}
              <Count n={counts[key]} />
            </button>
          </PopoverClose>
        ))}
      </PopoverContent>
    </Popover>
  );
}

// From md up: ONE line, measured. The tabs that do not fit beside "All" and "More" move into
// "More" (round 3: at 1024px they wrapped to a third row). Each tab's width is remembered from
// the last time it showed, so a narrower panel can decide without showing it again.
function FitTabs({ value, counts, onPick }) {
  const t = useT();
  const ref = useRef(null);
  const widths = useRef(new Map());
  const [fit, setFit] = useState(STATUS_TABS.length);
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    for (const b of el.querySelectorAll('[data-status-tab]')) widths.current.set(b.dataset.statusTab, b.getBoundingClientRect().width);
    const w = widths.current;
    setFit(tabsThatFit({
      all: w.get('all') || 0,
      more: w.get('more') || 0,
      tabs: STATUS_TABS.map((k) => w.get(k)),
      width: el.clientWidth,
      gap: parseFloat(getComputedStyle(el).columnGap) || 0,
    }));
  }, []);
  useLayoutEffect(() => { measure(); }, [measure, counts, value, t]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  return (
    <div ref={ref} role="group" aria-label={t('app.filter.status')} className="flex min-w-0 flex-1 flex-nowrap items-center gap-1">
      <StatusTab tab="all" value={value} counts={counts} onPick={onPick} />
      {STATUS_TABS.slice(0, fit).map((key) => <StatusTab key={key} tab={key} value={value} counts={counts} onPick={onPick} />)}
      <MoreTabs keys={[...STATUS_TABS.slice(fit), ...STATUS_MORE]} value={value} counts={counts} onPick={onPick} />
    </div>
  );
}

// On a phone: every tab on ONE line that scrolls sideways (wrapped lines pushed the first post
// below the fold), fading at an edge that hides tabs. Sideways only: overflow-y stays hidden, so
// it is never a vertical scroller inside <main> (the shell rule). py-2 keeps each tab's 44px hit
// box inside it; the wrapper takes the row's width, the strip just fills it.
function PhoneTabs({ value, counts, onPick }) {
  const t = useT();
  const ref = useRef(null);
  const [mask, setMask] = useState(null);
  const update = useCallback(() => {
    const el = ref.current;
    if (el) setMask(edgeFade(el));
  }, []);
  useLayoutEffect(() => { update(); }, [update, counts, value, t]);
  useEffect(() => {
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [update]);
  return (
    <div className="min-w-0 flex-1">
      <div
        ref={ref}
        role="group"
        aria-label={t('app.filter.status')}
        onScroll={update}
        data-edge-fade={mask ? '' : undefined}
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
        className="-my-2 flex w-full flex-nowrap items-center gap-1 overflow-x-auto overflow-y-hidden py-2 [scrollbar-width:none]"
      >
        <StatusTab tab="all" value={value} counts={counts} onPick={onPick} />
        {STATUS_TABS.map((key) => <StatusTab key={key} tab={key} value={value} counts={counts} onPick={onPick} />)}
        <MoreTabs keys={STATUS_MORE} value={value} counts={counts} onPick={onPick} />
      </div>
    </div>
  );
}

function StatusRow({ value, counts = {}, onChange, helpExtra = null }) {
  const phone = useIsPhone();
  // "All" is no status; a pressed tab goes back to no status too.
  const pick = (key) => onChange(key === 'all' || value === key ? null : key);
  return (
    <div data-filter-row="status" className="flex items-center gap-2">
      {phone
        ? <PhoneTabs value={value} counts={counts} onPick={pick} />
        : <FitTabs value={value} counts={counts} onPick={pick} />}
      <Legend extra={helpExtra} />
    </div>
  );
}

// A platform as an icon-only toggle: the glyph in its own colour, filled with the accent when
// it is the filter. aria-pressed carries the state, the name rides aria-label and the tooltip.
function PlatformToggle({ platform, active, onToggle }) {
  const meta = PLATFORM_META[platform];
  if (!meta) return null;
  const Icon = meta.Icon;
  return (
    <Tip label={meta.label}>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={active}
        aria-label={meta.label}
        data-platform-toggle={platform}
        className={`${TAP_TARGET} inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
          active
            ? 'bg-brand text-white ring-brand dark:bg-brand-light dark:text-zinc-900'
            : 'bg-zinc-200/50 ring-zinc-900/5 hover:bg-zinc-200 dark:bg-zinc-800/50 dark:ring-white/10 dark:hover:bg-zinc-700/60'
        }`}
      >
        <Icon size={13} className={active ? '' : meta.color} aria-hidden="true" />
      </button>
    </Tip>
  );
}

export default function FilterBar({
  platforms = [], platformFilter = [], onTogglePlatform,
  types = [], typeFilter = [], onToggleType, showTypes = false,
  showStatus = false, status = null, onStatus, counts = {},
  extra = null, hasActive = false, onReset, helpExtra = null,
}) {
  const t = useT();
  return (
    <div className="glass-panel space-y-2 rounded-2xl px-4 py-2" role="group" aria-label={t('app.filter.label')} data-filter-bar="">
      {showStatus ? <StatusRow value={status} counts={counts} onChange={onStatus} helpExtra={helpExtra} /> : null}
      <div data-filter-row="facets" className="flex flex-wrap items-center gap-2">
        {platforms.map((p) => (
          <PlatformToggle key={p} platform={p} active={platformFilter.includes(p)} onToggle={() => onTogglePlatform(p)} />
        ))}
        {showTypes ? (
          <>
            {/* The divider only where the row stays one line; on a phone it wrapped to dangle at an edge. */}
            <span className="hidden h-4 w-px bg-zinc-300 sm:block dark:bg-zinc-700" aria-hidden="true" />
            <MultiSelectDropdown
              label={t('app.filter.type')}
              options={types.map((ty) => ({ key: ty, label: t(`type.${ty}`) }))}
              selected={typeFilter}
              onToggle={onToggleType}
            />
          </>
        ) : null}
        {extra}
        {hasActive ? (
          <button type="button" onClick={onReset} aria-label={t('app.filter.reset')} className={`${TAP_TARGET_Y} rounded-full px-2 py-1 text-[11px] font-bold text-zinc-600 transition hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-200`}>
            {t('app.filter.resetShort')}
          </button>
        ) : null}
        {/* Where there is no status row, the legend closes this one. */}
        {showStatus ? null : <div className="ml-auto"><Legend extra={helpExtra} /></div>}
      </div>
    </div>
  );
}
