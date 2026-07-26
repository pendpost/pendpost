// The one checkbox for multi-select set membership (publishing lanes, auto-approve platforms,
// dropdown option lists, select-all). Single-feature on/off jobs use ui/Switch.jsx instead - this is
// only for "which of these are in the set". It stays a real <input type="checkbox"> so assistive tech
// and every getByRole('checkbox') keep working, but it draws its own box via appearance-none: an
// OUTLINE when unchecked (the old bare `accent-brand` rendered a bright native fill that read as "on"
// against a near-black dark surface), a brand fill + check glyph when checked, and a dash when
// indeterminate. Fill + glyph are driven off props (not CSS pseudo-variants) so behaviour is
// deterministic and does not depend on the Tailwind `:indeterminate` variant being generated.
// forwardRef so callers can still reach the input (the select-all sets `.indeterminate` on it).
import { forwardRef, useEffect, useRef } from 'react';
import { Check, Minus } from 'lucide-react';

export const Checkbox = forwardRef(function Checkbox(
  { checked, onChange, disabled = false, indeterminate = false, className = '', ...rest },
  forwardedRef,
) {
  const innerRef = useRef(null);
  const setRef = (node) => {
    innerRef.current = node;
    if (typeof forwardedRef === 'function') forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  };
  // `indeterminate` is a DOM property, not an attribute - React does not set it, so mirror it here.
  useEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  // Drive the fill off `marked` with NO competing base `bg-*`: a base `bg-transparent` collides with
  // `bg-brand` and, in light mode, transparent won - so a CHECKED box rendered empty (indistinguishable
  // from unchecked). Only one background utility applies per state now.
  const marked = checked || indeterminate;
  const box = marked
    ? 'border-brand bg-brand dark:border-brand-light dark:bg-brand-light'
    : 'border-zinc-400 bg-transparent dark:border-zinc-500';

  return (
    <span className="relative inline-grid h-4 w-4 shrink-0 place-items-center">
      <input
        ref={setRef}
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className={`h-4 w-4 cursor-pointer appearance-none rounded border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 ${box} ${className}`}
        {...rest}
      />
      {indeterminate ? (
        <Minus size={11} strokeWidth={3} aria-hidden="true" className="pointer-events-none absolute text-white dark:text-zinc-900" />
      ) : checked ? (
        <Check size={11} strokeWidth={3} aria-hidden="true" className="pointer-events-none absolute text-white dark:text-zinc-900" />
      ) : null}
    </span>
  );
});
