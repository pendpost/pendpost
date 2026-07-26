// WP10: the ONE dropdown treatment. Still a NATIVE <select> (platform-correct popup,
// free keyboard/a11y - the custom-listbox route was deliberately rejected), but styled
// like every other field: appearance-none kills the engine's flat default arrow and the
// wrapper positions the house chevron, so the control reads as tall and active as the
// text inputs beside it. Pass the same field classes you would pass a text input.
import { ChevronDown } from 'lucide-react';

export function Select({ className = '', wrapClassName = 'w-full', children, ...props }) {
  // The wrapper takes the width (default full, pass 'w-auto' for compact selects) and the
  // chevron anchors to IT - so it must never be wider than the select, or the glyph floats
  // outside the field box (hence no hardcoded w-full fighting a caller's w-auto).
  return (
    <span className={`relative inline-flex ${wrapClassName}`}>
      <select {...props} className={`${className} appearance-none pr-8`}>
        {children}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
    </span>
  );
}
