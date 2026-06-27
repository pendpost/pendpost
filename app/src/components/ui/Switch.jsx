// A minimal, accessible two-state switch for the cloud delivery choice: OFF = left
// (local, neutral track), ON = right (cloud, brand track). The flanking glyphs name
// each side (a monitor = your own computer, a cloud = the 24/7 runtime) so the slider
// is self-explanatory without a label. role="switch" + aria-checked keep it a real
// switch for assistive tech; the CALLER owns any confirmation before it flips (the
// onChange fires with the requested next value, it does not pre-toggle). An optional
// tipLabel wraps the focusable control in the app's <Tip> so the single trigger stays
// keyboard-reachable. Mirrors the app's tokens (rounded-full, brand, ring-brand).
import { Loader2 } from 'lucide-react';
import { Tip } from './Tooltip.jsx';

export function Switch({
  checked,
  onChange,
  disabled = false,
  busy = false,
  offIcon: OffIcon,
  onIcon: OnIcon,
  ariaLabel,
  tipLabel,
}) {
  const button = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 disabled:opacity-50 ${
        checked ? 'bg-brand dark:bg-brand-light' : 'bg-zinc-300 dark:bg-zinc-600'
      }`}
    >
      <span
        className={`grid h-4 w-4 place-items-center rounded-full bg-white shadow-sm transition-transform dark:bg-zinc-100 ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      >
        {busy ? <Loader2 size={10} className="animate-spin text-zinc-500" aria-hidden="true" /> : null}
      </span>
    </button>
  );
  return (
    <span className="inline-flex items-center gap-2">
      {OffIcon ? (
        <OffIcon
          size={13}
          aria-hidden="true"
          className={checked ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-600 dark:text-zinc-300'}
        />
      ) : null}
      {tipLabel ? <Tip label={tipLabel}>{button}</Tip> : button}
      {OnIcon ? (
        <OnIcon
          size={13}
          aria-hidden="true"
          className={checked ? 'text-brand dark:text-brand-light' : 'text-zinc-400 dark:text-zinc-500'}
        />
      ) : null}
    </span>
  );
}
