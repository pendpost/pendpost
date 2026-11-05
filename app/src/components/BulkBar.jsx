// The planner List's bulk header and its parts (planner bulk, 2026-11-01, package P; slimmed to
// one line on 2026-11-05 after the Approvals toolbar, PR #182). Approvals carries its bulk
// actions in its own toolbar (Freigaben.jsx).
//
// ListBar: ONE slim line at the top of the list, the header of the rows' checkbox column. Idle
// it is the select-all checkbox and "Alle auswählen", no box, and it scrolls away with the list.
// While something is selected the label turns into the count (a polite live region; just the
// number on a phone) and the actions follow it as glyphs; the line then sticks to the top of
// <main> (the one scroller, app shell scroll model), so the actions stay in reach while a long
// list scrolls beneath it. It wears the panel's opaque surface only while actually pinned
// (lib/useStuck.js): unpinned, an opaque fill reads as a band on the translucent glass panel. The checkbox clears any selection,
// partial or full; there is no separate clear. What a press will leave out rides each action's
// tooltip; what a run did rides the app toast (with Undo where a run can be taken back).
// `barRef`: the List measures the line so its sticky day headings sit just below it.
import { useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { useIsPhone } from '../lib/useIsPhone.js';
import { useStuck } from '../lib/useStuck.js';
import { IDLE_VARIANTS } from './ui/ActionButton.jsx';
import { Checkbox } from './ui/Checkbox.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { TAP_TARGET } from './ui/recipes.js';
import { useT } from '../lib/i18n.js';

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

// One action in the List's header: a glyph only, at every width (Approvals' icon button: a 28px
// square, a 15px glyph, a 44px hit area). `label` is its accessible name and tooltip ("3
// freigeben"); `note` (what a press will leave out) rides the tooltip's second line and the
// description. An action that applies to none of the selection is DISABLED with its reason
// (tooltip + aria-describedby), never hidden; it stays focusable (aria-disabled) so the reason is
// reachable by keyboard and pointer alike. A press on a disabled action calls
// onDisabledPress(id), so a touch screen (no tooltip) still hears why.
export function BarAction({ id, icon: Icon, label, onClick, disabled = false, reason = null, note = null, busy = false, busyLabel = null, tone = 'subtle', onDisabledPress, buttonProps = {} }) {
  const descId = `bulk-desc-${id}`;
  const name = busy && busyLabel ? busyLabel : label;
  const desc = disabled ? reason : busy ? null : note;
  // No tooltip on a phone: a tap would float it over the rows; a disabled press says its reason
  // in the toast there instead.
  const phone = useIsPhone();
  return (
    <>
      <Tip label={phone ? null : desc ? <>{name}<br />{desc}</> : name}>
        <button
          type="button"
          {...buttonProps}
          data-bulk-action={id}
          aria-label={name}
          aria-disabled={disabled || undefined}
          aria-describedby={desc ? descId : undefined}
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
          className={`${TAP_TARGET} inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-xl transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${IDLE_VARIANTS[tone] || IDLE_VARIANTS.subtle} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
        >
          {busy ? <Loader2 size={15} className="motion-safe:animate-spin" aria-hidden="true" /> : <Icon size={15} aria-hidden="true" />}
        </button>
      </Tip>
      {desc ? <span id={descId} className="sr-only">{desc}</span> : null}
    </>
  );
}

export function ListBar({ count, allSelected, someSelected, onToggleAll, onClear, actions = null, barRef = null }) {
  const t = useT();
  const selecting = count > 0;
  const label = t('approvals.bulk.selected', { n: count });
  const ownRef = useRef(null);
  const ref = barRef || ownRef;
  const stuck = useStuck(ref, { enabled: selecting });
  return (
    <div
      ref={ref}
      data-bulk-bar=""
      data-stuck={stuck ? '' : undefined}
      role={selecting ? 'group' : undefined}
      aria-label={selecting ? label : undefined}
      // -mx-4 reaches over the panel's padding (px-6 = that padding plus the rows' own px-2), so
      // the checkbox sits in the rows' checkbox column and a stuck line reads as the panel's own
      // top while pinned: the glass panel composited over the page, opaque, Approvals' surface.
      className={`-mx-4 mb-1 flex h-9 min-w-0 items-center gap-3 px-6 ${selecting ? 'sticky top-0 z-30 rounded-2xl data-[stuck]:bg-[#fdfefe] dark:data-[stuck]:bg-[#121215]' : ''}`}
    >
      <label className="flex min-w-0 cursor-pointer items-center gap-3 text-[11px] font-bold text-zinc-500 dark:text-zinc-400">
        <span className={`${TAP_TARGET} flex h-7 w-4 shrink-0 items-center justify-center`}>
          <Checkbox
            checked={allSelected}
            indeterminate={someSelected}
            onChange={selecting ? onClear : onToggleAll}
            aria-label={selecting ? t('approvals.selectAll.clear') : t('approvals.selectAll.all')}
          />
        </span>
        {selecting ? (
          <span role="status" aria-live="polite" className="whitespace-nowrap">
            {/* A phone shows the number alone so the line keeps one row at 375px. */}
            <span aria-hidden="true" className="md:hidden">{count}</span>
            <span className="max-md:sr-only">{label}</span>
          </span>
        ) : (
          <span className="whitespace-nowrap">{t('approvals.selectAll.all')}</span>
        )}
      </label>
      {selecting ? <span data-bulk-actions="" className="flex shrink-0 items-center gap-2">{actions}</span> : null}
    </div>
  );
}
