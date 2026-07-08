// DateTimePicker - house-native port of the client calendar.jsx DateTimePicker
// UX (popover month grid + looped-feel hour/minute columns), rebuilt on the
// pendpost's own Popover + format.js helpers so it matches the glass house style
// with no react-day-picker version risk. ISO string in, ISO string out; operates
// in the machine's local time (= the user's machine, the plan TZ).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from './Popover.jsx';
import { cn } from './cn.js';
import { fmtMonthYear, fmtFull, fmtDayAria, addDays, localDayKey } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';

// Monday-led; localized through the same planner.weekday.* keys the Planner uses,
// so the date popovers and the planner header share one source (no English leak).
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function monthGrid(anchor) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const gridStart = addDays(first, -((first.getDay() + 6) % 7)); // Monday-led
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
}

function ScrollColumn({ items, sel, onPick, selRef, label }) {
  return (
    <div className="h-[252px] w-11 overflow-y-auto" role="listbox" aria-label={label}>
      <div className="space-y-0.5 pr-1">
        {items.map((v) => {
          const active = v === sel;
          return (
            <button
              key={v}
              type="button"
              role="option"
              aria-selected={active}
              ref={active ? selRef : null}
              onClick={() => onPick(v)}
              className={cn(
                'w-full rounded-md py-1 text-center text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                active
                  ? 'bg-brand font-bold text-white dark:bg-brand-light dark:text-zinc-900'
                  : 'hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60',
              )}
            >
              {String(v).padStart(2, '0')}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function DateTimePicker({ value, onChange, placeholder, renderTrigger, triggerClassName, disablePast = false }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const date = value ? new Date(value) : null;
  const valid = Boolean(date && !Number.isNaN(date.getTime()));
  const [anchor, setAnchor] = useState(() => (valid ? new Date(date.getFullYear(), date.getMonth(), 1) : new Date()));

  // Re-centre the calendar on the selected month each time the popover opens.
  useEffect(() => {
    if (open && valid) setAnchor(new Date(date.getFullYear(), date.getMonth(), 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const cells = useMemo(() => monthGrid(anchor), [anchor]);
  const month = anchor.getMonth();
  const todayKey = localDayKey(new Date());
  const selKey = valid ? localDayKey(date) : null;

  const hours = useMemo(() => Array.from({ length: 24 }, (_, i) => i), []);
  const minutes = useMemo(() => Array.from({ length: 12 }, (_, i) => i * 5), []);
  const hourRef = useRef(null);
  const minRef = useRef(null);
  useEffect(() => {
    if (open && valid) {
      const t = setTimeout(() => {
        hourRef.current?.scrollIntoView({ block: 'center' });
        minRef.current?.scrollIntoView({ block: 'center' });
      }, 60);
      return () => clearTimeout(t);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const emit = (d) => onChange(d ? d.toISOString() : null);
  const pickDay = (day) => {
    const next = new Date(day);
    if (valid) next.setHours(date.getHours(), date.getMinutes(), 0, 0);
    else next.setHours(23, 59, 0, 0); // plan default time when first picking a day
    emit(next);
  };
  const setPart = (part, v) => {
    const base = valid ? new Date(date) : (() => { const d = new Date(); d.setHours(23, 59, 0, 0); return d; })();
    base.setSeconds(0, 0);
    if (part === 'h') base.setHours(v);
    else base.setMinutes(v);
    emit(base);
  };
  const selH = valid ? date.getHours() : -1;
  const selM = valid ? Math.floor(date.getMinutes() / 5) * 5 : -1;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {renderTrigger ? (
          renderTrigger({ valid })
        ) : (
          <button
            type="button"
            // `triggerClassName` lets a caller align the trigger with its sibling
            // form fields (e.g. the Composer's FIELD_CLS select surface); the
            // translucent default stays for every existing call site.
            className={cn(
              'flex w-full items-center gap-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
              triggerClassName || 'rounded-xl border-0 bg-white/60 px-3 py-2 ring-1 ring-zinc-900/5 transition hover:bg-white/80 dark:bg-zinc-800/40 dark:ring-white/10 dark:hover:bg-zinc-800/60',
              !valid && 'text-zinc-400 dark:text-zinc-500',
            )}
          >
            <CalendarIcon size={15} aria-hidden="true" />
            <span className="flex-1 text-left">{valid ? fmtFull(date.toISOString()) : (placeholder ?? t('ui.datePicker.placeholder'))}</span>
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-auto gap-2 p-3">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <button type="button" aria-label={t('ui.datePicker.prevMonth')} onClick={() => setAnchor((a) => new Date(a.getFullYear(), a.getMonth() - 1, 1))} className="rounded-lg p-1 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60">
              <ChevronLeft size={15} aria-hidden="true" />
            </button>
            <span className="font-display text-sm font-bold">{fmtMonthYear(anchor)}</span>
            <button type="button" aria-label={t('ui.datePicker.nextMonth')} onClick={() => setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + 1, 1))} className="rounded-lg p-1 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60">
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {WEEKDAYS.map((d) => (
              <div key={d} className="grid h-7 w-8 place-items-center text-[10px] font-bold text-zinc-400 dark:text-zinc-500">{t(`planner.weekday.${d}`)}</div>
            ))}
            {cells.map((day) => {
              const key = localDayKey(day);
              const inMonth = day.getMonth() === month;
              const isToday = key === todayKey;
              const isSel = key === selKey;
              // Opt-in (reschedule pickers): a past day cannot be a valid schedule.
              const isPast = disablePast && key < todayKey;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={isPast}
                  aria-label={fmtDayAria(day)}
                  aria-pressed={isSel}
                  aria-current={isToday ? 'date' : undefined}
                  onClick={() => pickDay(day)}
                  className={cn(
                    'grid h-8 w-8 place-items-center rounded-lg text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
                    isSel
                      ? 'bg-brand font-bold text-white dark:bg-brand-light dark:text-zinc-900'
                      : isToday
                        ? 'font-bold text-brand ring-1 ring-brand/40 dark:text-brand-light'
                        : inMonth
                          ? 'hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60'
                          : 'text-zinc-300 hover:bg-zinc-200/40 dark:text-zinc-600 dark:hover:bg-zinc-800/40',
                  )}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex gap-1 border-l border-zinc-200/70 pl-2 dark:border-zinc-700/70">
          <Clock size={13} className="mt-1 shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
          <ScrollColumn items={hours} sel={selH} onPick={(h) => setPart('h', h)} selRef={hourRef} label={t('ui.datePicker.hours')} />
          <ScrollColumn items={minutes} sel={selM} onPick={(m) => setPart('m', m)} selRef={minRef} label={t('ui.datePicker.minutes')} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
