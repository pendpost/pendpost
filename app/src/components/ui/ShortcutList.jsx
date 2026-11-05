// A surface's keyboard shortcuts, the keys as real <kbd> chips followed by what they do. They
// ride the filter bar's "?" popover under the status legend (App.jsx passes them to FilterBar as
// `helpExtra`), so no toolbar spends a control on them. Approvals (Freigaben.jsx) and the Planer
// List (Planner.jsx) each hand their own rows.
// rows: [{ keys: ['j', 'k'], label, glyphs }]; `glyphs` marks keys drawn as symbols (arrows),
// hidden from assistive tech because the label already says what they do.
import { useT } from '../../lib/i18n.js';
import { EYEBROW } from './tokens.js';

const KBD = 'inline-flex min-w-[1.25rem] items-center justify-center rounded-md bg-zinc-200/70 px-1.5 py-0.5 text-[11px] font-bold text-zinc-600 dark:bg-zinc-700/70 dark:text-zinc-200';

export function ShortcutList({ rows }) {
  const t = useT();
  return (
    <div className="space-y-1.5" data-keyboard-shortcuts="">
      <p className={EYEBROW}>{t('approvals.keys.title')}</p>
      <ul className="space-y-1.5 text-[11px] text-zinc-600 dark:text-zinc-300">
        {rows.map(({ keys, label, glyphs = false }) => (
          <li key={label} className="flex items-center gap-2">
            {keys.length === 1 ? (
              <kbd className={KBD} aria-hidden={glyphs || undefined}>{keys[0]}</kbd>
            ) : (
              <span className="flex shrink-0 gap-1">
                {keys.map((k) => <kbd key={k} className={KBD} aria-hidden={glyphs || undefined}>{k}</kbd>)}
              </span>
            )}
            <span>{label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
