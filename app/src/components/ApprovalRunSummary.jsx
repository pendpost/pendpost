// ApprovalRunSummary - the ONE quiet line a bulk approve leaves in the Freigaben toolbar when
// some posts did not go through (Freigaben error UX, 2026-11-06, owner pick B). It replaces the
// red paragraph that listed every post id with its full sentence:
//
//   (!) 4 nicht freigegeben   [fb/] 4   [li/] 15   [x] 1        [show] [agent] [dismiss]
//
// One chip per CAUSE (a platform glyph, struck through when the cause is a platform that is off
// or not connected, and its count), the cause's short words on hover. Never a post id. The count
// is the truth of THIS run: what was left out, and in the tooltip what went through.
// It stays until dismissed or until every post it names is resolved (the parent filters the
// entries live). "Show" narrows the list to these posts; the agent glyph runs the agent on every
// blocked post the agent can try (the parent's queue).
import { Bot, CircleAlert, Filter, X, XCircle } from 'lucide-react';
import { useT, tCount } from '../lib/i18n.js';
import { Tip } from './ui/Tooltip.jsx';
import { GlyphButton, PlatformGlyph } from './ApprovalBlockerLine.jsx';

export default function ApprovalRunSummary({
  ok = 0, total = 0, causes = [], showOnly = false, onToggleShow, fixable = 0, onFixAll = null, fixProgress = null, onDismiss,
}) {
  const t = useT();
  if (!total) return null;
  const head = t('approvals.result.notApproved', { n: total });
  const tip = t('approvals.result.summary', { ok, n: total });
  const running = Boolean(fixProgress);
  const fixLabel = running
    ? t('approvals.result.fixAllProgress', fixProgress)
    : fixable ? t('approvals.result.fixAllN', { n: fixable }) : t('approvals.result.fixAll');
  return (
    <div data-run-summary="" role="status" aria-live="polite" className="flex min-w-0 basis-full flex-wrap items-center gap-x-1.5 gap-y-1">
      <Tip label={tip}>
        <span tabIndex={0} aria-label={tip} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg text-xs font-semibold text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-200">
          <CircleAlert size={15} className="text-amber-700 dark:text-amber-400" aria-hidden="true" />
          {head}
        </span>
      </Tip>
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        {causes.map((c) => {
          const label = tCount(t, 'approvals.result.cause', c.count, { cause: c.label });
          return (
            <Tip key={c.key} label={label}>
              <span
                tabIndex={0}
                data-cause={c.key}
                aria-label={label}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg bg-zinc-900/5 px-2 text-[11px] font-bold tabular-nums text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-white/10 dark:text-zinc-300"
              >
                {c.kind === 'failed'
                  ? <XCircle size={13} className="text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
                  : <PlatformGlyph platform={c.platform} off={c.kind !== 'blocked'} />}
                {c.count}
              </span>
            </Tip>
          );
        })}
      </span>
      <span className="ml-auto flex shrink-0 items-center">
        <GlyphButton
          icon={Filter}
          label={showOnly ? t('approvals.result.showAll') : t('approvals.result.show')}
          onClick={onToggleShow}
          aria-pressed={showOnly}
          tone={showOnly ? 'brand' : 'neutral'}
        />
        {onFixAll && (fixable || running) ? (
          <GlyphButton icon={Bot} label={fixLabel} onClick={onFixAll} busy={running} />
        ) : null}
        {running ? <span className="pr-1 text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400" aria-hidden="true">{fixProgress.done}/{fixProgress.total}</span> : null}
        <GlyphButton icon={X} label={t('approvals.result.dismiss')} onClick={onDismiss} />
      </span>
    </div>
  );
}
