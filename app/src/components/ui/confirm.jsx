import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useT } from '../../lib/i18n.js';
import { Modal } from '../ui.jsx';

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
  const resolveRef = useRef(null);
  const firstFieldRef = useRef(null);

  const settle = useCallback((result) => {
    const r = resolveRef.current;
    resolveRef.current = null;
    setReq(null);
    setValue('');
    if (r) r(result);
  }, []);

  const open = useCallback((kind, opts) => new Promise((resolve) => {
    resolveRef.current = resolve;
    setValue(kind === 'prompt' ? (opts.defaultValue || '') : '');
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
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); settle(confirmResult); } }}
                  className={`mt-3 ${FIELD}`}
                />
              )
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
                onClick={() => settle(confirmResult)}
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
