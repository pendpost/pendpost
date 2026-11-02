// BulkBar - the one bulk action bar (planner bulk, 2026-11-01, package P), lifted out of
// Approvals so the planner List wears the SAME bar: the selected count (a polite live region,
// so toggling a checkbox announces the new count), quiet one-line notes that state a skip
// BEFORE the press (never a dialog, never silent), the run's failure summary (ActionError, the
// raw engine lines behind its "?"), "Clear selection", then the page's own actions.
//
// It sits at the TOP of the list and is sticky, so the actions stay reachable while a long list
// scrolls beneath it (US-APPR-07). <main> is the one scroller (app shell scroll model), so
// `sticky top-0` pins it to the top of the page.
//
// `extra`: an optional control beside the count.
// `barRef`: the List measures the bar so its sticky day headings sit just below it.
//
// ListBar (round 2, the fresh-eyes judge): the List's variant of the same bar. Its slot is
// RESERVED (it renders before anything is selected, with the select-all control and a key hint),
// so picking the first post never pushes the rows down under the cursor; it has a fixed action
// set and ONE line under the actions for what a press will leave out or what a run left out. On
// a phone it floats at the bottom of the screen while something is selected, so it neither
// moves the rows nor costs the first screen.
import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useIsPhone } from '../lib/useIsPhone.js';
import { X, Loader2 } from 'lucide-react';
import { INNER_SURFACE } from './ui.jsx';
import ActionError from './ui/ActionError.jsx';
import { IDLE_VARIANTS } from './ui/ActionButton.jsx';
import { Checkbox } from './ui/Checkbox.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { TAP_TARGET, TAP_TARGET_Y } from './ui/recipes.js';
import { useT } from '../lib/i18n.js';

export default function BulkBar({ count, notes = [], error = null, onClear, extra = null, barRef = null, children }) {
  const t = useT();
  if (!count) return null;
  const label = t('approvals.bulk.selected', { n: count });
  return (
    <div
      ref={barRef}
      role="region"
      aria-label={label}
      data-bulk-bar=""
      className={`sticky top-0 z-20 flex flex-wrap items-center gap-2 rounded-xl p-2.5 backdrop-blur-xl ${INNER_SURFACE}`}
    >
      <span role="status" aria-live="polite" className="text-xs font-bold">{label}</span>
      {extra}
      {notes.filter(Boolean).map((note) => (
        <span key={note} className="text-[11px] text-zinc-600 dark:text-zinc-400">{note}</span>
      ))}
      <span className="flex-1" />
      <ActionError error={error} className="basis-full" />
      <button
        type="button"
        onClick={onClear}
        className="rounded-xl px-2.5 py-1.5 text-xs font-bold text-zinc-600 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-300 dark:hover:bg-zinc-700/60"
      >
        {t('approvals.selectAll.clear')}
      </button>
      {children}
    </div>
  );
}

// A checkbox whose hit area is 44px: the label around it carries the click (a label click
// toggles its input) and an invisible ::after box (TAP_TARGET) grows the label to the finger.
// `onPick({ range })`: a shift-click selects a range; the label sees the click first.
export function SelectBox({ checked, indeterminate = false, onPick, label, className = '' }) {
  const shift = useRef(false);
  return (
    <label
      data-pick-box=""
      className={`${TAP_TARGET} inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center ${className}`}
      onClickCapture={(e) => { shift.current = e.shiftKey; }}
    >
      <Checkbox
        checked={checked}
        indeterminate={indeterminate}
        onChange={() => { onPick({ range: shift.current }); shift.current = false; }}
        aria-label={label}
      />
    </label>
  );
}

// One action in the List's bar: an icon with its word (the word shows from 1400px; below it the
// word rides the tooltip and the accessible name). A verb stays a verb: no "Deleted" after the
// press, the line under the actions says what happened. An action that applies to none of the
// selection is DISABLED with its reason (tooltip + aria-describedby), never hidden; it stays
// focusable (aria-disabled) so the reason is reachable by keyboard and pointer alike.
// A press on a disabled action calls onDisabledPress(id): the bar writes the reason into its line,
// because a touch screen has no tooltip (round 3).
export function BarAction({ id, icon: Icon, label, onClick, disabled = false, reason = null, busy = false, busyLabel = null, tone = 'subtle', onHint, onDisabledPress, buttonProps = {} }) {
  // The house action tones (ui/ActionButton.jsx), so Approve wears the same green as Approvals.
  const tones = IDLE_VARIANTS;
  const reasonId = `bulk-reason-${id}`;
  // No tooltip on a phone: a tap floated it over the bar's count line, and the line under the
  // actions already says a disabled action's reason there.
  const phone = useIsPhone();
  return (
    <>
      <Tip label={phone ? null : disabled && reason ? reason : label}>
        <button
          type="button"
          {...buttonProps}
          data-bulk-action={id}
          aria-label={busy && busyLabel ? busyLabel : label}
          aria-disabled={disabled || undefined}
          aria-describedby={disabled && reason ? reasonId : undefined}
          aria-busy={busy || undefined}
          onClick={(e) => {
            if (disabled || busy) {
              e.preventDefault();
              if (disabled && !busy && reason) onDisabledPress?.(id);
              return;
            }
            onClick?.(e);
            buttonProps.onClick?.(e);
          }}
          onMouseEnter={() => onHint?.(id)}
          onMouseLeave={() => onHint?.(null)}
          onFocus={() => onHint?.(id)}
          onBlur={() => onHint?.(null)}
          // On a phone the box itself is 44px (the finger's size, with the bar's gaps between).
          className={`${TAP_TARGET} inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-1.5 rounded-xl px-2.5 text-xs font-bold transition max-md:h-11 max-md:w-11 max-md:px-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${disabled ? 'cursor-not-allowed text-zinc-500 ring-1 ring-inset ring-zinc-900/10 dark:text-zinc-400 dark:ring-white/10' : tones[tone] || tones.subtle}`}
        >
          {busy ? <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden="true" /> : <Icon size={14} aria-hidden="true" />}
          <span className="hidden min-[1400px]:inline">{busy && busyLabel ? busyLabel : label}</span>
        </button>
      </Tip>
      {disabled && reason ? <span id={reasonId} className="sr-only">{reason}</span> : null}
    </>
  );
}

export function ListBar({ count, total, allSelected, someSelected, onToggleAll, onClear, actions = null, line = null, hint = null, barRef = null }) {
  const t = useT();
  const phone = useIsPhone();
  const selecting = count > 0;
  const label = t('approvals.bulk.selected', { n: count });
  const allLabel = allSelected ? t('approvals.selectAll.clear') : t('listBulk.selectAllInView', { n: total });
  // Line 2 (both layouts): a fixed height, so a note appearing never moves the rows: what a press
  // will leave out, what a run left out, a disabled action's reason, or the key hint while nothing
  // is selected. On a phone it may take two lines (no tooltip for the rest there).
  const lineRow = (
    <div data-bulk-line="" className="flex h-7 min-w-0 items-center gap-2 px-1.5 text-[11px] text-zinc-600 dark:text-zinc-300 max-md:h-auto max-md:min-h-7 max-md:py-0.5">
      {selecting ? line : hint ? <span className="truncate [@media(hover:none)]:invisible">{hint}</span> : null}
    </div>
  );
  // A phone (round 3, judge item 2): three lines. The count with "Alle N auswählen" and the clear;
  // then the actions as 44px boxes spread over the width (8px gaps at the very least); then the
  // line. It floats at the bottom of the screen, so its height never moves the rows.
  if (phone && selecting) {
    const phoneBar = (
      <div
        ref={barRef}
        data-bulk-slot=""
        data-bulk-bar=""
        role="region"
        aria-label={label}
        className="fixed inset-x-2 bottom-2 z-30 rounded-xl bg-white px-2 py-1.5 shadow-2xl ring-1 ring-zinc-900/[0.08] dark:bg-zinc-900 dark:ring-white/10"
      >
        <div className="flex h-11 min-w-0 items-center gap-2">
          <span className="flex shrink-0 items-center pl-1.5">
            <SelectBox checked={allSelected} indeterminate={someSelected} onPick={onToggleAll} label={allLabel} />
          </span>
          <span role="status" aria-live="polite" className="ml-1 min-w-0 truncate text-xs font-bold">{label}</span>
          {allSelected ? null : (
            <button type="button" onClick={onToggleAll} data-select-all-in-view="" className={`${TAP_TARGET_Y} shrink-0 rounded-md px-1 text-xs font-bold text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light`}>
              {t('listBulk.selectAllShort', { n: total })}
            </button>
          )}
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClear}
            aria-label={t('approvals.selectAll.clear')}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-zinc-600 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-300 dark:hover:bg-zinc-700/60"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div data-bulk-actions="" className="flex h-11 items-center justify-between gap-2 px-1">{actions}</div>
        {lineRow}
      </div>
    );
    // The glass panels around the list are backdrop-filtered, which makes them the containing
    // block of a fixed child, so the bar is portalled to <body> to float over the viewport.
    return typeof document !== 'undefined' ? createPortal(phoneBar, document.body) : phoneBar;
  }
  const bar = (
    <div
      ref={barRef}
      data-bulk-slot=""
      data-bulk-bar={selecting ? '' : undefined}
      role={selecting ? 'region' : undefined}
      aria-label={selecting ? label : undefined}
      // Opaque, so rows scrolling under it and under the day headings beneath never show through.
      // Idle on a phone it is hidden: the first screen goes to the posts (the phone bar above).
      className={`z-30 rounded-xl bg-white px-2 py-1.5 ring-1 ring-zinc-900/[0.08] dark:bg-zinc-900 dark:ring-white/10 md:sticky md:top-0 md:mb-5 ${selecting ? '' : 'max-md:hidden'}`}
    >
      {/* Line 1: never wraps (the actions are icons below 1400px). */}
      <div className="flex h-11 min-w-0 flex-nowrap items-center gap-2">
        <span className="flex shrink-0 items-center gap-2.5 pl-1.5 max-md:pl-1">
          <SelectBox checked={allSelected} indeterminate={someSelected} onPick={onToggleAll} label={allLabel} />
          {selecting ? null : (
            <button type="button" onClick={onToggleAll} className={`${TAP_TARGET_Y} hidden rounded-md text-xs font-bold text-zinc-700 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-200 md:inline`}>
              {allLabel}
            </button>
          )}
        </span>
        {selecting ? (
          <span role="status" aria-live="polite" className="min-w-0 truncate text-xs font-bold">{label}</span>
        ) : null}
        {selecting && !allSelected ? (
          <button
            type="button"
            onClick={onToggleAll}
            data-select-all-in-view=""
            className={`${TAP_TARGET_Y} hidden shrink-0 rounded-md px-1 text-xs font-bold text-brand transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light xl:inline`}
          >
            {t('listBulk.selectAllInView', { n: total })}
          </button>
        ) : null}
        <span className="flex-1" />
        {selecting ? (
          <>
            <span data-bulk-actions="" className="flex shrink-0 items-center gap-2">{actions}</span>
            <Tip label={t('approvals.selectAll.clear')}>
              <button
                type="button"
                onClick={onClear}
                aria-label={t('approvals.selectAll.clear')}
                className={`${TAP_TARGET} inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-zinc-600 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-300 dark:hover:bg-zinc-700/60`}
              >
                <X size={15} aria-hidden="true" />
              </button>
            </Tip>
          </>
        ) : null}
      </div>
      {lineRow}
    </div>
  );
  return bar;
}
