// Field - the ONE labelled text-input primitive for the dashboard's block-label
// field pattern (the FIELD token is the app's dominant field style, 11 call
// sites; this gives it a component so the layout can't be hand-rolled wrong).
//
// Why it exists: the Setup connect panels each re-implemented "label above input"
// and some forgot two things - the label was left inline and the input dropped
// w-full - so the label and an intrinsic-width input flowed onto ONE line,
// overlapping. IdentifierRow got it right (block label row + w-full input); this
// primitive is that anatomy, extracted, so ConnectPanel / AgentTokenPanel /
// IdentifierRow share it and no fourth panel can regress it.
//
// Contract: the label is ALWAYS a block row above the input; the input is ALWAYS
// w-full (width is the parent grid's job, never the field's); an optional help
// tip sits beside the label, an optional right-inside adornment (a save-state
// glyph) reserves pr-9, and hint/error render below with the aria contract the
// hand-rolled fields used (aria-invalid, aria-describedby, role="alert").
import { useId } from 'react';
import { HelpCircle } from 'lucide-react';
import { FIELD, FIELD_ERR } from './tokens.js';
import { Tip } from './Tooltip.jsx';

// Label sits one shade darker than the old zinc-500: at 11px on a tinted inner
// surface (zinc-100) zinc-500 measures ~4.4:1, under AA - zinc-600 clears it, and
// on white it is fine either way (contrast is judged on the worst background).
const LABEL = 'text-[11px] text-zinc-600 dark:text-zinc-400';

export default function Field({
  label,
  help = null,          // tooltip string -> a reachable HelpCircle beside the label
  helpLabel = null,     // aria-label for the help button (defaults to "Help: <label>")
  hint = null,          // muted helper line below the field
  error = null,         // error line below the field (role=alert), also rings the input
  adornment = null,     // right-inside node (e.g. a save spinner/check) - reserves pr-9
  secret = false,       // type=password unless an explicit `type` is passed
  mono = false,         // monospace + 13px (ids, tokens)
  dimmed = false,       // soften a superseded row
  id: idProp,
  type,
  inputClassName = '',
  ...rest
}) {
  const autoId = useId();
  const id = idProp || autoId;
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-error` : undefined;
  const describedBy = errId || hintId;
  const resolvedType = type || (secret ? 'password' : 'text');
  return (
    <div className={`space-y-1 ${dimmed ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-1.5">
        <label htmlFor={id} className={LABEL}>{label}</label>
        {help ? (
          <Tip label={help}>
            <button
              type="button"
              aria-label={helpLabel || `Help: ${label}`}
              className="rounded text-zinc-500 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-300"
            >
              <HelpCircle size={12} aria-hidden="true" />
            </button>
          </Tip>
        ) : null}
      </div>
      <span className="relative block">
        <input
          id={id}
          type={resolvedType}
          className={`w-full ${adornment ? 'pr-9' : ''} ${mono ? 'font-mono text-[13px]' : ''} ${error ? FIELD_ERR : FIELD} ${inputClassName}`}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={describedBy}
          {...rest}
        />
        {adornment ? (
          <span className="absolute right-3 top-1/2 -translate-y-1/2" aria-hidden="true">{adornment}</span>
        ) : null}
      </span>
      {hint ? <p id={hintId} className={`text-[11px] ${LABEL}`}>{hint}</p> : null}
      {error ? <p id={errId} role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{error}</p> : null}
    </div>
  );
}
