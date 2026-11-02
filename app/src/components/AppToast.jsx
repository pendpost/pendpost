import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, Loader2, X } from 'lucide-react';
import { useT } from '../lib/i18n.js';
import { TAP_TARGET } from './ui/recipes.js';
import InfoTip from './ui/InfoTip.jsx';

// The one generic transient notice for actions whose surface is already gone
// when the outcome arrives - born for the optimistic one-motion delete
// (PostDetail closes instantly, the server answer lands afterwards). Reuses
// UpdateToast/HumanizerReceipt's bottom-right glass pattern; those two stay
// separate on purpose (one is a stateful updater with its own poll + buttons,
// the other rides Composer save state), so absorbing them would grow this
// component instead of shrinking the app.
//
// Module-level emitter, not context: the caller (a dialog mid-close) must be
// able to fire a toast that outlives its own unmount, with no provider
// plumbing through every surface. showToast is a no-op until <AppToast /> is
// mounted (App shell) - callers never need to care.
// `duration` (ms) overrides how long a quiet toast stays: the planner's bulk delete keeps its
// Undo up for 10 s (planner bulk, package P).
// `action` ({ label, onClick }) is the ONE undo-shaped affordance a transient notice may
// carry - the resumable Pause (spec 50 row 12) needs its Resume where the pause happened,
// not only back in the ledger. Optional, so every existing caller stays a plain notice.
//
// `text` is a plain string, or the { text, raw } shape humanizeAction (lib/failureCopy.js)
// returns; `raw` may also ride as a top-level field (a spread humanizeAction result). The
// sentence is what the live region announces. The raw server/engine line, when present,
// is the shared InfoTip "?" rendered OUTSIDE the role=alert/status region, so its sr-only
// description is never read out as part of the alert. A toast carrying a raw line does
// not leave on its own: it stays until closed, so the "?" stays reachable.
let emit = null;
export function showToast({ kind = 'success', text, raw = null, action = null, duration = null }) {
  const shaped = text && typeof text === 'object' && 'text' in text;
  const sentence = shaped ? text.text : text;
  const detail = (shaped ? text.raw : raw) || null;
  if (emit) emit({ kind, text: sentence, raw: detail, action, duration, key: Date.now() });
}

export default function AppToast() {
  const t = useT();
  const [toast, setToast] = useState(null);
  useEffect(() => {
    emit = setToast;
    return () => { if (emit === setToast) emit = null; };
  }, []);
  // Quiet means it leaves on its own: success after a glance, an error after a
  // reading pause. A toast carrying a raw line (the "?") stays until closed. A 'progress' notice is the
  // exception - an in-flight action (a YouTube upload can run many seconds) keeps
  // its notice until the OUTCOME toast replaces it, so the click never reads as
  // dead air. It carries a spinner and never auto-dismisses.
  useEffect(() => {
    if (!toast || toast.kind === 'progress' || toast.raw) return undefined;
    const id = setTimeout(() => setToast(null), toast.duration || (toast.kind === 'error' ? 8000 : 4000));
    return () => clearTimeout(id);
  }, [toast]);
  // While a toast shows, its height rides --pp-toast-h on <html>, so a list can keep its last
  // row's ⋯ clear of it (planner bulk round 2). A floating phone bar lifts the toast above it
  // through --pp-toast-lift.
  const boxRef = useRef(null);
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!toast || !boxRef.current) { root.style.removeProperty('--pp-toast-h'); return undefined; }
    root.style.setProperty('--pp-toast-h', `${boxRef.current.offsetHeight + 24}px`);
    return () => root.style.removeProperty('--pp-toast-h');
  }, [toast]);
  if (!toast) return null;
  const isError = toast.kind === 'error';
  const isProgress = toast.kind === 'progress';
  return (
    <div ref={boxRef} data-app-toast="" style={{ bottom: 'calc(1rem + var(--pp-toast-lift, 0px))' }} className="glass-panel fixed right-4 z-50 flex max-w-sm items-center gap-2.5 rounded-2xl px-3.5 py-2.5 shadow-lg">
      <div
        role={isError ? 'alert' : 'status'}
        aria-live={isError ? 'assertive' : 'polite'}
        className="flex min-w-0 flex-1 items-center gap-2.5"
      >
        {isProgress
          ? <Loader2 size={15} className="shrink-0 animate-spin text-brand motion-reduce:animate-none dark:text-brand-light" aria-hidden="true" />
          : isError
            ? <AlertTriangle size={15} className="shrink-0 text-red-600 dark:text-red-300" aria-hidden="true" />
            : <CheckCircle2 size={15} className="shrink-0 text-brand dark:text-brand-light" aria-hidden="true" />}
        <span className="min-w-0 flex-1 text-xs font-bold">{toast.text}</span>
        {toast.action ? (
          <button
            type="button"
            onClick={() => { setToast(null); toast.action.onClick(); }}
            // The toast stays compact; TAP_TARGET gives the Undo its 44px hit area invisibly.
            className={`shrink-0 rounded-lg px-1.5 py-0.5 text-xs font-bold text-brand underline-offset-2 transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light ${TAP_TARGET}`}
          >
            {toast.action.label}
          </button>
        ) : null}
      </div>
      {/* Outside the live region on purpose. px-2 keeps the "?"'s 44px box (16px past each
          side of the glyph) clear of the action before it and the close button's box after it. */}
      {toast.raw ? (
        <span className="shrink-0 px-2">
          <InfoTip label={toast.raw} />
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => setToast(null)}
        aria-label={t('app.action.close')}
        className={`shrink-0 rounded-lg p-1 text-zinc-500 transition hover:bg-zinc-200/60 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:bg-zinc-700/60 dark:hover:text-zinc-200 ${TAP_TARGET}`}
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
