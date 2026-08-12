import { useEffect } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useT } from '../lib/i18n.js';

// R6b humanizer receipt (ux-audit dim-6 P4/C2): the always-on humanizer gate
// rewrites prose fields at save (lib/humanize.mjs via lib/writes.mjs), and the
// create/update response now carries the gate's own change report. This is its
// ONE visible face for the operator: a quiet, dismissable line naming what was
// auto-fixed ("2 em dashes, 3 quotes straightened") - fix kinds + counts only,
// no diffs, no per-post receipt store (net-simplify ruling). Renders NOTHING
// when the save was clean. Mounted by the App shell next to UpdateToast, whose
// bottom-right glass-panel pattern it reuses.
const KIND_KEYS = {
  'em-dash': { one: 'composer.receipt.emDash.one', other: 'composer.receipt.emDash.other' },
  'curly-quote': { one: 'composer.receipt.curlyQuote.one', other: 'composer.receipt.curlyQuote.other' },
  eszett: { one: 'composer.receipt.eszett.one', other: 'composer.receipt.eszett.other' },
};

export default function HumanizerReceipt({ fixes, onDismiss }) {
  const t = useT();
  const active = Array.isArray(fixes) && fixes.length > 0;

  // Quiet means it also leaves on its own: auto-dismiss after a reading pause,
  // so an ignored receipt never accumulates as UI debt.
  useEffect(() => {
    if (!active) return undefined;
    const id = setTimeout(() => onDismiss?.(), 12_000);
    return () => clearTimeout(id);
  }, [active, fixes, onDismiss]);

  if (!active) return null;

  const parts = fixes.map(({ kind, count }) => {
    const keys = KIND_KEYS[kind];
    // A fix kind this bundle predates stays visible rather than silently hidden.
    if (!keys) return `${kind}: ${count}`;
    return t(count === 1 ? keys.one : keys.other, { count });
  });

  return (
    <div
      role="status"
      aria-live="polite"
      className="glass-panel fixed bottom-4 right-4 z-50 flex max-w-sm items-center gap-2.5 rounded-2xl px-3.5 py-2.5 shadow-lg"
    >
      <Sparkles size={15} className="shrink-0 text-brand dark:text-brand-light" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-xs text-zinc-600 dark:text-zinc-300">
        {t('composer.receipt.prefix')} {parts.join(', ')}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('composer.receipt.dismiss')}
        className="shrink-0 rounded-lg p-1 text-zinc-500 transition hover:bg-zinc-200/60 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:bg-zinc-700/60 dark:hover:text-zinc-200"
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
