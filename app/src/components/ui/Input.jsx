// Input.jsx - the shared floating-label text input (bondigoo's peer +
// placeholder-shown pattern, adapted to pendpost's ring-hairline fields).
//
// The label lives INSIDE the field: full-size in the middle while the field is
// empty, shrunk into the top padding once focused or filled. So the field never
// needs an example placeholder ("Acme Retail") and never loses its name while
// filled. The float is CSS-only: `placeholder=" "` is load-bearing, because
// :placeholder-shown is true exactly while the field is empty - no JS state.
// Unlike bondigoo's border-punching pill, the label floats INSIDE the fill, so
// it works over any surface and needs no background masking.
//
// Error/hint render below the field with the same aria contract the hand-rolled
// fields used: aria-invalid, aria-describedby onto the error/hint node, and
// role="alert" on the error.
import { forwardRef, useId } from 'react';
import { FIELD_SURFACE } from './tokens.js';

const Input = forwardRef(function Input({ label, error = null, hint = null, className = '', id: idProp, ...props }, ref) {
  const autoId = useId();
  const id = idProp || autoId;
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1">
      <div className="relative">
        <input
          ref={ref}
          id={id}
          placeholder=" "
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={describedBy}
          className={`peer w-full rounded-xl border-0 px-3 pb-1.5 pt-5 text-sm ${FIELD_SURFACE} focus-visible:outline-none focus-visible:ring-2 ${error ? 'ring-1 ring-red-500/60 focus-visible:ring-red-500' : 'focus-visible:ring-brand'} disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
          {...props}
        />
        <label
          htmlFor={id}
          className="pointer-events-none absolute left-3 top-1.5 origin-left scale-75 text-sm font-bold text-zinc-500 transition-all duration-150 peer-placeholder-shown:top-1/2 peer-placeholder-shown:-translate-y-1/2 peer-placeholder-shown:scale-100 peer-placeholder-shown:font-normal peer-focus:top-1.5 peer-focus:translate-y-0 peer-focus:scale-75 peer-focus:font-bold dark:text-zinc-400"
        >
          {label}
        </label>
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[11px] text-zinc-500 dark:text-zinc-400">{hint}</p>
      ) : null}
    </div>
  );
});

export default Input;
