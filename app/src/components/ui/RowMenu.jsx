import { useState, useRef, useEffect } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { BTN_GHOST, TAP_TARGET, MENU_ITEM, MENU_ITEM_HEIGHT, MENU_ITEM_TONES } from './recipes.js';
import { Tip } from './Tooltip.jsx';

// The ONE overflow (three-dots) menu for a card or row - the generic, items-driven shell
// proven on the Radar feed (radar/RadarFeed.jsx RowMenu), lifted to ui/ so every post
// surface (Planner list row, Week card, Freigaben card) shows the SAME affordance and
// the SAME open/close behavior. It carries no post logic: the caller passes a flat item
// list and this renders it. Design-system contract (ui/recipes.js): the trigger is a
// BTN_GHOST utility glyph (a menu reveals, it does not itself mutate), a destructive item
// (`danger`) is a red menu item (never a red standalone button on the card), and a gated
// item renders disabled with its reason a hover away rather than vanishing silently.
//
// Accessibility: aria-haspopup/aria-expanded on the trigger, role=menu / role=menuitem on
// the list, an aria-label on the icon-only trigger, closes on outside-click or Escape, and
// each item is a real >=44px-tall button (recipes.js MENU_ITEM, `min-h-11`) with its own
// focus-visible ring. The 16px glyph trigger looks the same size it always
// did and carries a 44x44 hit area (recipes.js TAP_TARGET), so the canon's tap-target floor is
// met without the row growing. It is a sibling of any open-detail control, never
// nested inside it (the interactive-nesting contract the cards already honour).
//
// items: [{ key, label, Icon, danger?, disabled?, reason?, run }]. `run` fires on click
// (the menu closes first). A falsy entry is skipped, so callers can inline `cond && {...}`.

// The popover's own furniture around the item stack: `p-1` top and bottom (8px) plus the
// `mt-1`/`mb-1` offset from the trigger (4px), rounded up so the estimate never lands short.
const MENU_CHROME = 16;

export function RowMenu({ items = [], label = 'Weitere Aktionen', align = 'right', stopPropagation = true, triggerClassName }) {
  const [open, setOpen] = useState(false);
  // Open upward when the trigger sits low in the viewport (e.g. the ⋯ at the bottom of a
  // tall Freigaben card), so the menu is never cut off below the fold.
  const [dropUp, setDropUp] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const visible = items.filter(Boolean);
  if (!visible.length) return null;
  // A card is often itself a click target (opens the detail); swallow the pointer so
  // opening the menu, or picking an item, never also triggers the row's own onClick.
  const swallow = (e) => { if (stopPropagation) e.stopPropagation(); };
  return (
    <div ref={ref} className="relative shrink-0" onClick={swallow}>
      <Tip label={label}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={label}
          onClick={(e) => {
            swallow(e);
            setOpen((v) => {
              const next = !v;
              // Decide the drop direction from the room below the trigger at open time.
              if (next && ref.current && typeof window !== 'undefined') {
                const r = ref.current.getBoundingClientRect();
                // MENU_ITEM_HEIGHT is the SAME 44 the items are painted at (recipes.js
                // MENU_ITEM, `min-h-11`), plus the popover's own p-1 and the mt-1 offset.
                const estimate = visible.length * MENU_ITEM_HEIGHT + MENU_CHROME;
                const below = window.innerHeight - r.bottom;
                // Flip up only when the menu does not fit below AND there is more room above:
                // a 6-item menu opened near the fold flips, one opened near the top does not
                // trade a clipped bottom for a clipped top.
                setDropUp(below < estimate && r.top > below);
              }
              return next;
            });
          }}
          // Default: a quiet ghost glyph on a solid surface. `triggerClassName` overrides it
          // for an over-cover overlay (a light glyph on a dark scrim) where BTN_GHOST's zinc
          // would vanish against arbitrary cover art.
          className={`${triggerClassName || `${BTN_GHOST} px-1.5 py-1.5`} ${TAP_TARGET}`}
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </button>
      </Tip>
      {open ? (
        <div
          role="menu"
          className={`absolute ${align === 'left' ? 'left-0' : 'right-0'} z-30 ${dropUp ? 'bottom-full mb-1' : 'top-full mt-1'} min-w-[11rem] rounded-xl bg-white p-1 shadow-lg ring-1 ring-zinc-900/10 dark:bg-zinc-800 dark:ring-white/10`}
        >
          {visible.map(({ key, label: itemLabel, Icon, danger, disabled, reason, run }) => (
            <Tip key={key} label={disabled && reason ? reason : undefined}>
              <button
                type="button"
                role="menuitem"
                disabled={disabled}
                onClick={(e) => { swallow(e); setOpen(false); run?.(); }}
                className={`${MENU_ITEM} ${danger ? MENU_ITEM_TONES.danger : MENU_ITEM_TONES.default}`}
              >
                {Icon ? <Icon size={14} className="shrink-0" aria-hidden="true" /> : null}
                <span className="min-w-0 flex-1 truncate">{itemLabel}</span>
              </button>
            </Tip>
          ))}
        </div>
      ) : null}
    </div>
  );
}
