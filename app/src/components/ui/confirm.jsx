import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useT } from '../../lib/i18n.js';
import { Modal } from '../ui.jsx';
import { Checkbox } from './Checkbox.jsx';

// "Don't show this message again" persistence. A dialog opts in by passing a stable
// `rememberKey`; the checkbox then appears, and once the owner confirms with it ticked
// the dialog is suppressed on every future call carrying that key (confirm -> resolves
// true, prompt -> resolves its defaultValue). Keyed suppression, not global: only the
// exact recurring gate the owner silenced is skipped. Recoverable from Settings via
// resetDialogSkips(). localStorage is best-effort (private mode just never remembers).
const SKIP_PREFIX = 'pendpost-dialog-skip.';
const skipKey = (rememberKey) => `${SKIP_PREFIX}${rememberKey}`;
function isDialogSkipped(rememberKey) {
  if (!rememberKey) return false;
  try { return localStorage.getItem(skipKey(rememberKey)) === '1'; } catch { return false; }
}
function rememberDialogSkip(rememberKey) {
  if (!rememberKey) return;
  try { localStorage.setItem(skipKey(rememberKey), '1'); } catch { /* private mode - ignore */ }
}
// How many dialogs are currently silenced, for the Settings reset control's label.
export function dialogSkipCount() {
  try {
    let n = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      if ((localStorage.key(i) || '').startsWith(SKIP_PREFIX)) n += 1;
    }
    return n;
  } catch { return 0; }
}
// Clear every "don't show again" choice so the dialogs ask again. Returns how many were
// cleared. The recovery path for the owner-chosen ability to silence any dialog.
export function resetDialogSkips() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(SKIP_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
    return keys.length;
  } catch { return 0; }
}

// In-app glass confirm + prompt dialogs, replacing window.confirm/prompt/alert
// (which ignore dark mode, break the glass design, and are not styleable/a11y).
// One ConfirmProvider mounts near the App root; useConfirm()/usePrompt() return
// async functions that resolve when the owner answers:
//   const confirm = useConfirm();
//   if (await confirm({ title, body, confirmLabel, danger })) { ... }   // -> boolean
//   const prompt = usePrompt();
//   const note = await prompt({ title, body, multiline });               // -> string | null (null = cancelled)
const ConfirmContext = createContext(null);

const BTN = 'rounded-xl px-3 py-1.5 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';
const BTN_GHOST = `${BTN} text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-700/60`;
const BTN_BRAND = `${BTN} bg-brand text-white dark:bg-brand-light dark:text-zinc-900`;
const BTN_DANGER = `${BTN} bg-red-600 text-white hover:bg-red-700`;
const FIELD = 'w-full rounded-xl border-0 bg-white/70 px-3 py-2 text-sm ring-1 ring-zinc-900/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-zinc-800/60 dark:ring-white/10';

export function ConfirmProvider({ children }) {
  const t = useT();
  const [req, setReq] = useState(null); // { kind:'confirm'|'prompt', opts, resolve }
  const [value, setValue] = useState('');
  const [remember, setRemember] = useState(false);
  const resolveRef = useRef(null);
  const firstFieldRef = useRef(null);

  const settle = useCallback((result, { persist = false } = {}) => {
    // Only a CONFIRM with the box ticked persists the skip; cancelling never does.
    if (persist && req?.opts?.rememberKey) rememberDialogSkip(req.opts.rememberKey);
    const r = resolveRef.current;
    resolveRef.current = null;
    setReq(null);
    setValue('');
    setRemember(false);
    if (r) r(result);
  }, [req]);

  const open = useCallback((kind, opts) => new Promise((resolve) => {
    // Previously silenced (rememberKey set + skip stored): resolve straight through with
    // the "proceed" answer and never mount the modal. confirm -> true, prompt -> default.
    if (isDialogSkipped(opts.rememberKey)) {
      resolve(kind === 'prompt' ? (opts.defaultValue || '') : true);
      return;
    }
    resolveRef.current = resolve;
    setValue(kind === 'prompt' ? (opts.defaultValue || '') : '');
    setRemember(false);
    setReq({ kind, opts });
  }), []);

  const confirm = useCallback((opts = {}) => open('confirm', opts), [open]);
  const prompt = useCallback((opts = {}) => open('prompt', opts), [open]);

  // Default-focus the right control (input for prompt, primary/cancel button for
  // confirm) once the dialog mounts. Modal's useSlideOver focuses the panel on its
  // own mount; under StrictMode that child effect re-runs AFTER this parent effect
  // and would steal focus. Defer to a microtask so the focus lands once the whole
  // effect flush (StrictMode re-mount included) has settled — and, unlike rAF, it
  // still fires in a backgrounded/non-painting tab. A `cancelled` guard drops a
  // late microtask if the dialog closed first. Escape, focus-trap, and focus-
  // restore are owned by Modal/useSlideOver now.
  useEffect(() => {
    if (!req) return undefined;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) firstFieldRef.current?.focus(); });
    return () => { cancelled = true; };
  }, [req]);

  const cancelResult = req?.kind === 'prompt' ? null : false;
  const confirmResult = req?.kind === 'prompt' ? value : true;
  const opts = req?.opts || {};
  const danger = Boolean(opts.danger);

  return (
    <ConfirmContext.Provider value={{ confirm, prompt }}>
      {children}
      {req ? (
        <Modal onClose={() => settle(cancelResult)} label={opts.title || t('ui.confirm.title')} width={opts.wide ? 'max-w-2xl' : 'max-w-sm'}>
          <div>
            {opts.title ? <h2 className="font-display text-lg font-bold leading-tight">{opts.title}</h2> : null}
            {opts.body ? <p className="mt-1.5 whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-300">{opts.body}</p> : null}
            {req.kind === 'prompt' ? (
              opts.multiline ? (
                <textarea
                  ref={firstFieldRef}
                  rows={opts.rows || (opts.wide ? 12 : 3)}
                  value={value}
                  placeholder={opts.placeholder || ''}
                  onChange={(e) => setValue(e.target.value)}
                  className={`mt-3 resize-y leading-relaxed scrollbar-soft ${opts.wide ? 'font-mono' : ''} ${FIELD}`}
                />
              ) : (
                <input
                  ref={firstFieldRef}
                  value={value}
                  placeholder={opts.placeholder || ''}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); settle(confirmResult, { persist: remember }); } }}
                  className={`mt-3 ${FIELD}`}
                />
              )
            ) : null}
            {/* Opt-in "don't show this message again": rendered only when the caller
                passes a rememberKey. Ticking it and confirming suppresses this exact
                dialog on future calls; it is recoverable from Settings. */}
            {opts.rememberKey ? (
              <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
                <Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                {opts.rememberLabel || t('ui.confirm.dontShowAgain')}
              </label>
            ) : null}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                ref={req.kind === 'confirm' && danger ? firstFieldRef : null}
                onClick={() => settle(cancelResult)}
                className={BTN_GHOST}
              >
                {opts.cancelLabel || t('ui.confirm.cancel')}
              </button>
              <button
                type="button"
                ref={req.kind === 'confirm' && !danger ? firstFieldRef : null}
                onClick={() => settle(confirmResult, { persist: remember })}
                className={danger ? BTN_DANGER : BTN_BRAND}
              >
                {opts.confirmLabel || t('ui.confirm.confirm')}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </ConfirmContext.Provider>
  );
}

// Returns an async confirm({ title, body, confirmLabel, cancelLabel, danger }) -> boolean.
export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within a ConfirmProvider');
  return ctx.confirm;
}

// Returns an async prompt({ title, body, placeholder, defaultValue, multiline,
// wide, rows, confirmLabel, cancelLabel }) -> string | null (null = cancelled).
// `wide` widens the dialog (max-w-2xl) and gives the textarea a roomy mono
// editor look - use it for long, copy-paste payloads like the AI setup prompt.
export function usePrompt() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('usePrompt must be used within a ConfirmProvider');
  return ctx.prompt;
}
