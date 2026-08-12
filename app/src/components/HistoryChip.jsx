import { useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { History, RotateCcw } from 'lucide-react';
import { useEngager, unforgetEngager } from '../lib/api.js';
import { useT, useLocale } from '../lib/i18n.js';
import HistoryPopover from './HistoryPopover.jsx';

// HistoryChip (spec 49 R12, §5.1): the quiet "Nth exchange" marker beside an author, at the
// reply moment. It renders ONLY at exchangeCount >= 2 (a single interaction is a stranger,
// and a chip at count 1 would be a lie about "history", S1b). For a forgotten key it shows a
// muted "vergessen" indicator carrying the "Wieder zulassen" un-forget (S6u) - same slot, no
// new surface, since a forgotten person has no popover to open. A corrupt ledger yields no
// chip, never a broken node (S9e). One muted tone, order-carried priority, never a loud badge.

// One-popover-at-a-time (S1c): a tiny module-level singleton holds the id of the single open
// popover. Any chip opening sets it; a chip is open iff it equals its own id. No provider
// needed, so the chip drops onto any reply surface unchanged.
let openId = null;
const listeners = new Set();
function setOpenId(id) {
  openId = id;
  listeners.forEach((l) => l());
}
function subscribeOpen(l) {
  listeners.add(l);
  return () => listeners.delete(l);
}
function useIsOpen(id) {
  const current = useSyncExternalStore(subscribeOpen, () => openId, () => openId);
  return current === id;
}

// English ordinal ("2nd", "3rd", "21st"); German uses a plain number + the "." in the copy
// value ("3. Austausch"), so this is only ever asked for the English pack.
function enOrdinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

export default function HistoryChip({ lane, handle, slot = 'author' }) {
  const t = useT();
  const locale = useLocale();
  const queryClient = useQueryClient();
  // The id is stable per (lane, handle, slot) so two chips for the SAME person on different
  // surfaces (SignalRow author vs its author-replied badge) stay independent, while the single
  // openId still guarantees one popover across the whole page.
  const id = `${lane}|${handle}|${slot}`;
  const open = useIsOpen(id);
  const { data } = useEngager(lane, handle);
  const record = data?.engager || null;

  // No key, no data, or a corrupt read -> render nothing (S9e / S2b). The row looks like today.
  if (!lane || !handle || !record) return null;

  // Forgotten key (tombstone): the slot shows a muted "vergessen" indicator + un-forget. No
  // count, no history, no popover (S6u) - clearing the tombstone lets the key re-accrete from
  // scratch; the erased history does NOT return.
  if (record.forgotten === true) {
    const unforget = async () => {
      try {
        await unforgetEngager(lane, handle);
        queryClient.invalidateQueries({ queryKey: ['engager'] });
      } catch { /* a failed un-forget leaves the tombstone; the row simply stays as-is */ }
    };
    return (
      <span className="inline-flex items-center gap-1">
        <span className="inline-flex items-center gap-1 rounded-full bg-zinc-200/70 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-600 dark:bg-zinc-700/70 dark:text-zinc-300">
          {t('engager.forgotten.badge')}
        </span>
        <button
          type="button"
          onClick={unforget}
          className="inline-flex items-center gap-0.5 text-[10px] font-bold text-zinc-500 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          <RotateCcw size={10} aria-hidden="true" /> {t('engager.forgotten.unforget')}
        </button>
      </span>
    );
  }

  // The chip appears iff exchangeCount >= 2 (S1a/S1b). Below that, nothing renders.
  const count = Number(record.exchangeCount) || 0;
  if (count < 2) return null;

  const nLabel = String(locale || '').startsWith('de') ? String(count) : enOrdinal(count);

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpenId(open ? null : id)}
        aria-expanded={open}
        aria-label={t('engager.chip.open')}
        className="inline-flex items-center gap-1 rounded-full bg-zinc-200/70 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-600 transition hover:bg-zinc-300/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-zinc-700/70 dark:text-zinc-300 dark:hover:bg-zinc-600/70"
      >
        <History size={11} aria-hidden="true" /> {t('engager.chip.nth', { n: nLabel })}
      </button>
      {open ? (
        <HistoryPopover
          record={record}
          lane={lane}
          handle={handle}
          suggestions={Array.isArray(data?.suggestions) ? data.suggestions : []}
          links={Array.isArray(data?.links) ? data.links : []}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </span>
  );
}
