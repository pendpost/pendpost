// US-FR-06: a multi-select dropdown for filter dimensions with many options
// (type, status), keeping the filter bar compact. The rule: few/visual options
// (platforms) stay inline chips; longer lists collapse here. Reuses the Popover
// primitive + native checkboxes so keyboard + a11y come for free.
import { ChevronDown } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from './Popover.jsx';

export function MultiSelectDropdown({ label, options, selected, onToggle }) {
  const count = selected.length;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={count ? `${label} (${count})` : label}
          className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
            count
              ? 'bg-brand/10 text-brand ring-brand/30 dark:bg-brand-light/10 dark:text-brand-light dark:ring-brand-light/30'
              : 'text-zinc-500 ring-zinc-900/10 hover:bg-zinc-200/40 dark:text-zinc-400 dark:ring-white/10 dark:hover:bg-zinc-800/40'
          }`}
        >
          {label}
          {count ? <span className="rounded-full bg-brand/20 px-1 text-[10px] tabular-nums dark:bg-brand-light/20">{count}</span> : null}
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" role="group" aria-label={label} className="max-h-72 w-44 space-y-0.5 overflow-y-auto p-1.5">
        {options.map((o) => (
          <label key={o.key} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-bold transition hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60">
            <input
              type="checkbox"
              checked={selected.includes(o.key)}
              onChange={() => onToggle(o.key)}
              className="h-4 w-4 rounded border-zinc-300 text-brand accent-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:border-zinc-600"
            />
            {o.label}
          </label>
        ))}
      </PopoverContent>
    </Popover>
  );
}
