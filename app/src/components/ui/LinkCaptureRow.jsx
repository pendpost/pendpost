import { useId } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { FIELD_SURFACE } from './tokens.js';

// The ONE link-capture row: paste the live post's URL, save the marker. Three
// surfaces close the same loop (Radar's copy path, the answered-without-proof
// repair, the approval card's copy-lane hand-off) and each had grown its own
// copy of this input+button pair - this collapses them to one. Props-only and
// controlled: the WRITE stays in the caller (radarMarkCopyPosted vs markPosted
// are different markers), this renders the capture.
//
// `inputLabel` renders as a VISIBLE quiet label, never placeholder-only or
// aria-only (canon Tier 2 forms rule; fresh-eyes finding 11 pinned the copy
// "Link zum veröffentlichten Beitrag"). The placeholder stays as the in-field
// hint; the label is the persistent name.
//
// `requireValue` mirrors the two honest shapes: recording "I posted it" with the
// link optional (the copy path), vs attaching a link where the mark already
// exists or must carry proof (the repair + the card).
const QUIET_BTN = 'inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold text-zinc-600 ring-1 ring-zinc-900/10 transition hover:bg-zinc-900/5 dark:text-zinc-300 dark:ring-white/10 dark:hover:bg-white/5';

export default function LinkCaptureRow({ value, onChange, onSave, saving = false, error = null, placeholder, label, inputLabel = null, requireValue = false }) {
  const inputId = useId();
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {inputLabel ? (
        <label htmlFor={inputId} className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">{inputLabel}</label>
      ) : null}
      <input
        id={inputId}
        type="url"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={inputLabel ? undefined : placeholder}
        className={`w-44 rounded-lg border-0 px-2 py-1 text-xs ${FIELD_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`}
      />
      <button
        type="button"
        onClick={onSave}
        disabled={saving || (requireValue && !String(value || '').trim())}
        className={QUIET_BTN}
      >
        {saving ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
        {label}
      </button>
      {error ? <span className="text-[11px] text-red-600 dark:text-red-400">{error}</span> : null}
    </span>
  );
}
