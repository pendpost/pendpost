import { useState, useRef, useLayoutEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownLeft, ArrowUpRight, ExternalLink, Star, X, MoreHorizontal,
  Link2, Unlink, Trash2, AlertCircle,
} from 'lucide-react';
import { fmtRelative } from '../lib/format.js';
import { PLATFORM_META, INNER_SURFACE, DISABLED_PRIMARY } from './ui.jsx';
import { useT } from '../lib/i18n.js';
import { forgetEngager, unforgetEngager, linkEngagers, unlinkEngagers, dismissLinkGuess } from '../lib/api.js';

// HistoryPopover (spec 49 R12, §5.2): the accreted exchanges for one person, disclosed on
// demand behind the HistoryChip. It is a READING surface first - the exchanges lead; the
// muted cross-lane guess, the confirmed-link row, and the forget overflow sit below. Storage
// is UNBOUNDED (Q2), so the DISPLAY paginates ("load N earlier") - a bounded window over an
// unbounded store, never an infinite dump and never a page. A malformed record degrades to a
// muted "history unavailable" line, never a thrown render (S9e). All copy via t() in both
// locales; the code word "engager" never reaches a visible string.

const PAGE = 5; // the display window over unbounded storage (legibility, not a storage cap)
const EDGE_MARGIN = 8; // px kept between the popover and the clip container's edge

// R12 (BU-9 fix 2): the popover is `absolute` inside the chip's `position:relative` span, so
// with a static `right-0` anchor it opens LEFTWARD and, when the chip sits near the left of a
// narrow container (the PostDetail comments drawer, whose scroll body is `overflow-x-hidden`),
// it spills past that edge and is CLIPPED - the reading surface becomes illegible ("reat
// linkedin post!"). This measures the nearest horizontal clip container (falling back to the
// viewport) and pins the popover WITHIN it: it constrains the width to the available room and
// picks a left offset that keeps both edges inside, so the popover always opens inward and
// wraps rather than clipping. It runs in useLayoutEffect (before paint, no flicker) and re-runs
// on resize and whenever the content's size can change. Absolute + `top-full` means it still
// scrolls naturally with the drawer, so no scroll handler is needed. Purely positional - the
// calm muted treatment is untouched.
function useClampPopover(deps) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current;
      const anchor = el?.offsetParent; // the chip's position:relative span
      if (!el || !anchor) return;
      // Find the nearest ancestor that clips horizontally; else clamp to the viewport.
      let bounds = { left: EDGE_MARGIN, right: window.innerWidth - EDGE_MARGIN };
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === 'hidden' || ox === 'auto' || ox === 'scroll' || ox === 'clip') {
          const r = n.getBoundingClientRect();
          bounds = { left: r.left + EDGE_MARGIN, right: r.right - EDGE_MARGIN };
          break;
        }
      }
      const available = Math.max(0, bounds.right - bounds.left);
      // Measure the natural width capped to the available room, then choose an inward offset.
      el.style.maxWidth = `${available}px`;
      el.style.left = '';
      el.style.right = '';
      const anchorRect = anchor.getBoundingClientRect();
      const pw = Math.min(el.offsetWidth, available);
      // Prefer right-aligned to the chip (opens leftward), then clamp both edges inside bounds.
      let leftVp = anchorRect.right - pw;
      if (leftVp + pw > bounds.right) leftVp = bounds.right - pw;
      if (leftVp < bounds.left) leftVp = bounds.left;
      el.style.left = `${Math.round(leftVp - anchorRect.left)}px`;
      el.style.right = 'auto';
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

// One lane's glyph (PLATFORM_META), so a joined cross-lane history stays legible per row.
function LaneGlyph({ lane }) {
  const meta = lane ? PLATFORM_META[lane] : null;
  if (!meta) return null;
  const { Icon } = meta;
  return <Icon size={11} className={meta.color} aria-hidden="true" />;
}

// Resolve the "other party" of a suggestion/link entry to { lane, handle } for both the
// visible label and the write verb. The engine returns a resolved shape (otherLane/
// otherHandle); an otherKey ("lane:handleNorm") is parsed as a fallback for display.
function otherParty(entry) {
  if (!entry) return { lane: '', handle: '' };
  let lane = entry.otherLane || '';
  let handle = entry.otherHandle || '';
  if ((!lane || !handle) && entry.otherKey) {
    const i = String(entry.otherKey).indexOf(':');
    if (i >= 0) {
      lane = lane || entry.otherKey.slice(0, i);
      handle = handle || entry.otherKey.slice(i + 1);
    }
  }
  return { lane, handle };
}

// One exchange row: direction glyph (they -> me / me -> them), relative date, lane glyph,
// a one-line excerpt, and EITHER a live permalink OR a muted "no longer available" marker
// (S7 - the ledger entry survives its post's deletion; it is a soft reference, not a link).
function ExchangeRow({ ex, fallbackLane, t }) {
  const isMe = ex.direction === 'me';
  const DirIcon = isMe ? ArrowUpRight : ArrowDownLeft;
  const lane = ex.lane || fallbackLane;
  // "gone" is an explicit engine mark (target_gone/404); an exchange that simply never
  // carried a permalink shows no link and no gone-marker (honesty: absence is not deletion).
  const gone = ex.gone === true || ex.permalinkGone === true;
  return (
    <li className="flex items-start gap-2 text-xs">
      <DirIcon size={13} className="mt-0.5 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
      <span className="mt-0.5 shrink-0 text-zinc-500 dark:text-zinc-400">{ex.direction === 'me' ? t('engager.popover.direction.me') : t('engager.popover.direction.they')}</span>
      <LaneGlyph lane={lane} />
      <span className="min-w-0 flex-1">
        <span className="break-words">{ex.excerpt || ''}</span>
        {ex.rating != null ? (
          <span className="ml-1.5 inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-300" aria-label={t('engager.popover.rating', { n: ex.rating })}>
            <Star size={11} aria-hidden="true" /> {ex.rating}
          </span>
        ) : null}
      </span>
      <span className="mt-0.5 shrink-0 text-zinc-500 dark:text-zinc-400">{ex.ts ? fmtRelative(ex.ts) : ''}</span>
      {gone ? (
        <span className="mt-0.5 shrink-0 text-zinc-500 dark:text-zinc-400">{t('engager.popover.gone')}</span>
      ) : ex.permalink ? (
        <a
          href={ex.permalink}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-0.5 inline-flex shrink-0 items-center gap-0.5 text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light"
        >
          <ExternalLink size={11} aria-hidden="true" /> {t('engager.popover.viewThread')}
        </a>
      ) : null}
    </li>
  );
}

export default function HistoryPopover({ record, lane, handle, suggestions = [], links = [], onClose }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [shown, setShown] = useState(PAGE);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [confirming, setConfirming] = useState(false); // the inline ForgetConfirm state (S6)
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Keep the popover inside its (possibly overflow-clipped) container in every state (BU-9 fix 2).
  const popoverRef = useClampPopover([shown, overflowOpen, confirming, suggestions.length, links.length, record]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['engager'] });

  // A malformed / unavailable record degrades to a muted line + close (never a thrown row, S9e).
  const exchanges = record && Array.isArray(record.exchanges) ? record.exchanges : null;
  if (!record || record.forgotten === true || !exchanges) {
    return (
      <div ref={popoverRef} role="dialog" aria-label={t('engager.popover.title')} className={`absolute right-0 top-full z-50 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-xl p-3 text-xs shadow-xl ring-1 ring-zinc-900/10 dark:ring-white/10 ${INNER_SURFACE}`}>
        <div className="flex items-center justify-between">
          <span className="text-zinc-500 dark:text-zinc-400">{t('engager.popover.unavailable')}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('engager.popover.close')}
            className="rounded-lg p-1 text-zinc-500 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  // Newest-first display over the unbounded store; the window is bounded by `shown`.
  const ordered = [...exchanges].sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  const visible = ordered.slice(0, shown);
  const remaining = ordered.length - visible.length;

  const runForget = async () => {
    setBusy(true);
    setError(null);
    try {
      await forgetEngager(lane, handle);
      invalidate();
      onClose?.();
    } catch (err) {
      setError(err?.message || t('engager.forget.failed'));
    } finally {
      setBusy(false);
    }
  };

  const runLinkAction = async (fn, entry) => {
    const { lane: oLane, handle: oHandle } = otherParty(entry);
    setBusy(true);
    setError(null);
    try {
      await fn({ lane, handle }, { lane: oLane, handle: oHandle });
      invalidate();
    } catch (err) {
      setError(err?.message || t('engager.forget.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={popoverRef} role="dialog" aria-label={t('engager.popover.title')} className={`absolute right-0 top-full z-50 mt-1 w-80 max-w-[calc(100vw-2rem)] space-y-2 rounded-xl p-3 shadow-xl ring-1 ring-zinc-900/10 dark:ring-white/10 ${INNER_SURFACE}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-bold">
          <LaneGlyph lane={lane} />
          <span className="truncate">{record.handle || handle}</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('engager.popover.close')}
          className="shrink-0 rounded-lg p-1 text-zinc-500 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>

      {/* The exchanges lead (the history is the content). */}
      <ul className="space-y-1.5">
        {visible.map((ex, i) => (
          <ExchangeRow key={`${ex.kind || ''}-${ex.ref || ''}-${ex.ts || ''}-${i}`} ex={ex} fallbackLane={lane} t={t} />
        ))}
      </ul>
      {remaining > 0 ? (
        <button
          type="button"
          onClick={() => setShown((n) => n + PAGE)}
          className="text-[11px] font-bold text-zinc-500 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          {t('engager.popover.loadMore', { n: Math.min(PAGE, remaining) })}
        </button>
      ) : null}

      {/* Confirmed cross-lane links (S4j): a stored association shown IN ADDITION to any guess,
          never a merge. Each carries its own un-link (S4u, lossless). */}
      {links.length > 0 ? (
        <ul className="space-y-1 border-t border-zinc-900/5 pt-2 dark:border-white/10">
          {links.map((l, i) => {
            const { lane: oLane, handle: oHandle } = otherParty(l);
            return (
              <li key={`link-${oLane}-${oHandle}-${i}`} className="flex items-center gap-2 text-[11px]">
                <Link2 size={12} className="shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-zinc-500 dark:text-zinc-400">
                  {t('engager.popover.linked', { handle: oHandle, lane: PLATFORM_META[oLane]?.label || oLane })}
                </span>
                <button
                  type="button"
                  onClick={() => runLinkAction(unlinkEngagers, l)}
                  disabled={busy}
                  className="inline-flex shrink-0 items-center gap-1 font-bold text-zinc-500 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 dark:text-zinc-400 dark:hover:text-zinc-100"
                >
                  <Unlink size={11} aria-hidden="true" /> {t('engager.popover.unlink')}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* Cross-lane GUESS (S4): muted, below the exchanges, labelled as a guess. Dismiss with
          "ignore" OR confirm with "yes, same person" - a confirm stores a durable association,
          never a merge (both records stay separate). */}
      {suggestions.length > 0 ? (
        <ul className="space-y-1.5 border-t border-zinc-900/5 pt-2 dark:border-white/10">
          {suggestions.map((s, i) => {
            const { lane: oLane, handle: oHandle } = otherParty(s);
            return (
              <li key={`sug-${oLane}-${oHandle}-${i}`} className="space-y-1">
                <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                  {t('engager.popover.maybeLinked', { handle: oHandle, lane: PLATFORM_META[oLane]?.label || oLane })}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => runLinkAction(linkEngagers, s)}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 dark:text-brand-light"
                  >
                    <Link2 size={11} aria-hidden="true" /> {t('engager.popover.linkConfirm')}
                  </button>
                  <button
                    type="button"
                    onClick={() => runLinkAction(dismissLinkGuess, s)}
                    disabled={busy}
                    className="text-[11px] font-bold text-zinc-500 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 dark:text-zinc-400 dark:hover:text-zinc-100"
                  >
                    {t('engager.popover.linkIgnore')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* Overflow -> forget (destructive-ish, behind an inline confirm; S6). */}
      <div className="border-t border-zinc-900/5 pt-2 dark:border-white/10">
        {confirming ? (
          <div className="space-y-1.5">
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('engager.forget.explain')}</p>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('engager.forget.noUndo')}</p>
            {error ? (
              <p role="alert" className="flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-300">
                <AlertCircle size={11} aria-hidden="true" /> {error}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-1.5">
              <button
                type="button"
                onClick={() => { setConfirming(false); setError(null); }}
                className="rounded-lg px-2 py-1 text-[11px] font-bold text-zinc-500 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                {t('engager.forget.cancel')}
              </button>
              <button
                type="button"
                onClick={runForget}
                disabled={busy}
                className={`inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-2 py-1 text-[11px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${DISABLED_PRIMARY}`}
              >
                <Trash2 size={11} aria-hidden="true" /> {t('engager.forget.confirm')}
              </button>
            </div>
          </div>
        ) : overflowOpen ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="inline-flex items-center gap-1.5 text-[11px] font-bold text-red-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-red-300"
          >
            <Trash2 size={11} aria-hidden="true" /> {t('engager.forget.action')}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setOverflowOpen(true)}
            aria-label={t('engager.popover.more')}
            className="inline-flex items-center gap-1.5 text-[11px] font-bold text-zinc-500 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            <MoreHorizontal size={13} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

export { otherParty };
