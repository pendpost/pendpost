// Button primitive - the house variants in one place so actions read
// consistently (primary CTA, destructive, success, quiet). Layout-only className
// stays the caller's; visual variant + size live here.
import { cn } from './cn.js';
import { DISABLED_PRIMARY } from './tokens.js';

// primary gets explicit disabled colors (DISABLED_PRIMARY): opacity over a brand fill
// drops white-on-teal to ~2:1 in light mode. The unfilled variants keep opacity - their
// text tokens still clear AA at 50% against the app surfaces they sit on.
const VARIANTS = {
  primary: `bg-brand text-white shadow-lg shadow-brand/20 hover:bg-brand/90 dark:bg-brand-light dark:text-zinc-900 ${DISABLED_PRIMARY}`,
  subtle: 'bg-zinc-200/60 text-zinc-700 hover:bg-zinc-300/60 dark:bg-zinc-800/60 dark:text-zinc-200 dark:hover:bg-zinc-700/60 disabled:opacity-50',
  ghost: 'text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-700/60 disabled:opacity-50',
  outline: 'text-zinc-700 ring-1 ring-zinc-900/10 hover:bg-zinc-200/40 dark:text-zinc-200 dark:ring-white/10 dark:hover:bg-zinc-800/40 disabled:opacity-50',
  success: 'bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-300 disabled:opacity-50',
  danger: 'bg-red-500/10 text-red-700 hover:bg-red-500/20 dark:text-red-300 disabled:opacity-50',
};
const SIZES = {
  sm: 'px-2.5 py-1.5 text-xs',
  md: 'px-3.5 py-2 text-sm',
  icon: 'p-1.5',
};

export function Button({ variant = 'subtle', size = 'md', className, type = 'button', ...props }) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-xl font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
        VARIANTS[variant] || VARIANTS.subtle,
        SIZES[size] || SIZES.md,
        className,
      )}
      {...props}
    />
  );
}
