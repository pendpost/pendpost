import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, Loader2, X } from 'lucide-react';
import { useT } from '../lib/i18n.js';

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
// `action` ({ label, onClick }) is the ONE undo-shaped affordance a transient notice may
// carry - the resumable Pause (spec 50 row 12) needs its Resume where the pause happened,
// not only back in the ledger. Optional, so every existing caller stays a plain notice.
let emit = null;
export function showToast({ kind = 'success', text, action = null }) {
  if (emit) emit({ kind, text, action, key: Date.now() });
}

export default function AppToast() {
  const t = useT();
  const [toast, setToast] = useState(null);
  useEffect(() => {
    emit = setToast;
    return () => { if (emit === setToast) emit = null; };
  }, []);
  // Quiet means it leaves on its own: success after a glance, an error after a
  // reading pause (it carries the server's message). A 'progress' notice is the
  // exception - an in-flight action (a YouTube upload can run many seconds) keeps
  // its notice until the OUTCOME toast replaces it, so the click never reads as
  // dead air. It carries a spinner and never auto-dismisses.
  useEffect(() => {
    if (!toast || toast.kind === 'progress') return undefined;
    const id = setTimeout(() => setToast(null), toast.kind === 'error' ? 8000 : 4000);
    return () => clearTimeout(id);
  }, [toast]);
  if (!toast) return null;
  const isError = toast.kind === 'error';
  const isProgress = toast.kind === 'progress';
  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      className="glass-panel fixed bottom-4 right-4 z-50 flex max-w-sm items-center gap-2.5 rounded-2xl px-3.5 py-2.5 shadow-lg"
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
          className="shrink-0 rounded-lg px-1.5 py-0.5 text-xs font-bold text-brand underline-offset-2 transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light"
        >
          {toast.action.label}
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => setToast(null)}
        aria-label={t('app.action.close')}
        className="shrink-0 rounded-lg p-1 text-zinc-500 transition hover:bg-zinc-200/60 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:bg-zinc-700/60 dark:hover:text-zinc-200"
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
