// Secondary-label primitive: a technical/secondary flag rendered as an icon in a
// colored ring with a tooltip explanation, plus optional inline text where there
// is room. The owner rule: compact icon+color+tooltip, full text only where
// space and clarity warrant it. Focusable so the tooltip is keyboard-reachable.
import { Tip } from './Tooltip.jsx';
import { cn } from './cn.js';

const TONES = {
  ok: 'bg-emerald-500/15 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300',
  warn: 'bg-amber-500/15 text-amber-700 ring-amber-500/30 dark:text-amber-300',
  err: 'bg-red-500/15 text-red-700 ring-red-500/30 dark:text-red-300',
  info: 'bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300',
  neutral: 'bg-zinc-500/15 text-zinc-600 ring-zinc-500/30 dark:text-zinc-300',
};

export function IconBadge({ icon: Icon, tone = 'neutral', label, text, side = 'top' }) {
  const chip = (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold ring-1', TONES[tone] || TONES.neutral)}>
      {Icon ? <Icon size={11} aria-hidden="true" /> : null}
      {text ? <span>{text}</span> : null}
    </span>
  );
  if (!label) return chip;
  return (
    <Tip label={label} side={side}>
      <button type="button" aria-label={label} className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
        {chip}
      </button>
    </Tip>
  );
}
