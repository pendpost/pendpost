// Shared optimistic action button - ONE state machine for every network action
// (idle -> loading -> success [1.7s dwell] -> idle, or error [1.7s] -> idle).
// Extracted from the near-identical RunNowButton / FetchButton machines so each
// network-action button gives the same immediate idle->loading->success feedback.
// A thrown value with `.canceled === true` is a user-cancel sentinel: snap back
// to idle silently, no error flash.
import { forwardRef, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from './cn.js';

const DWELL_MS = 1700;

// status: 'idle' | 'loading' | 'success' | 'error'
export function useActionState() {
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const timerRef = useRef(null);

  // A late dwell timer must never setState after unmount.
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const run = async (fn) => {
    if (status === 'loading') return;
    setStatus('loading');
    setError(null);
    try {
      await fn();
      setStatus('success');
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setStatus('idle'), DWELL_MS);
    } catch (err) {
      if (err?.canceled === true) {
        // User cancelled (declined a prompt/confirm): no error flash.
        setStatus('idle');
        return;
      }
      setError(err?.message || 'Error');
      setStatus('error');
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setStatus('idle'), DWELL_MS);
    }
  };

  return { status, error, run };
}

// The idle look per variant; success/error chips are shared across all variants.
const IDLE_VARIANTS = {
  subtle: 'bg-zinc-200/60 text-zinc-700 hover:bg-zinc-300/60 dark:bg-zinc-800/60 dark:text-zinc-200 dark:hover:bg-zinc-700/60',
  success: 'bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-300',
  danger: 'bg-red-500/10 text-red-700 hover:bg-red-500/20 dark:text-red-300',
};
const SIZES = {
  sm: 'px-2.5 py-1.5 text-xs',
  md: 'px-3.5 py-2 text-sm',
};

// forwardRef so the button composes with a Radix Slot trigger (e.g. <Tip>), which
// needs to attach a ref to its single child to anchor + reveal on hover AND focus.
const ActionButton = forwardRef(function ActionButton({
  onAction,
  labels = {},
  icon: Icon,
  variant = 'subtle',
  size = 'sm',
  className,
  disabled,
  onError,
  ariaLabel,
  ...rest
}, ref) {
  const { status, error, run } = useActionState();

  // Surface a real (non-canceled) error to the caller for a persistent message.
  useEffect(() => {
    if (status === 'error' && error) onError?.(error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const label = labels[status] ?? labels.idle;
  const loading = status === 'loading';

  return (
    <button
      ref={ref}
      {...rest}
      type="button"
      onClick={() => run(onAction)}
      disabled={disabled || loading}
      aria-label={ariaLabel}
      className={cn(
        'flex items-center gap-1.5 rounded-xl font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50',
        SIZES[size] || SIZES.sm,
        status === 'success'
          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
          : status === 'error'
            ? 'bg-red-500/15 text-red-700 dark:text-red-300'
            : IDLE_VARIANTS[variant] || IDLE_VARIANTS.subtle,
        className,
      )}
    >
      {loading ? (
        <Loader2 size={13} className="animate-spin" aria-hidden="true" />
      ) : Icon ? (
        <Icon size={13} aria-hidden="true" />
      ) : null}
      {label}
    </button>
  );
});

export default ActionButton;
