// B6 — Planner Run-now / Check-readiness, routed through the in-app review gate.
//
// This is the ONLY publish-triggering control on the planner header. It is gated
// by pendpost_health.blockers (the READ-ONLY Meta-368 surface, lib/writes.mjs pendpostHealth blockers push):
//   - A recorded Meta action block (368) DISABLES Run-now and offers Check-readiness
//     instead, so the blocked Meta lane is never poked. The 368 state is read from
//     pendpost_health.blockers, NEVER inferred from the run result (the 368 is applied
//     per-lane mid-run; runDueExclusive only returns in_flight when busy).
//   - Otherwise, a click opens the PlannerRunNowDialog review sheet: it lists the
//     posts the scheduler would fire now, pre-selected, and the owner picks a
//     subset before any publish. The dialog IS the confirmation (a reviewed,
//     deliberate red run button); it owns the per-post publish loop, the
//     needs_confirm escalation, the in_flight handling, and the query refresh.
//
// Anti-slop: single accent tone, font-bold max, no all-caps prose; the disabled
// blocker line uses icon + text (not color alone). Passes jest-axe.
import { useState } from 'react';
import { Rocket, AlertCircle, ListChecks } from 'lucide-react';
import { useT } from '../lib/i18n.js';
import PlannerRunNowDialog from './PlannerRunNowDialog.jsx';
import { Tip } from './ui/Tooltip.jsx';

const HEADER_BTN =
  'flex h-8 shrink-0 items-center gap-1.5 rounded-xl bg-zinc-200/60 px-2.5 text-xs font-bold transition hover:bg-zinc-300/60 dark:bg-zinc-800/60 dark:hover:bg-zinc-700/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50';

// The 368 lives in pendpost_health.blockers[] as a free-form line (lib/writes.mjs pendpostHealth blockers push);
// the stable marker is the "Meta action block" phrase. We surface the line verbatim
// and never parse a clear time out of it (a 368 carries none).
const META_368_RE = /meta action block/i;
function find368Blocker(pendpostHealth) {
  const blockers = pendpostHealth?.blockers || [];
  return blockers.find((b) => META_368_RE.test(String(b))) || null;
}

export default function PlannerRunNow({ pendpostHealth, campaigns = [], onCheckReadiness, clientName }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  const blocker368 = find368Blocker(pendpostHealth);

  // Mandate E: scope + count for the tooltip and confirm. A post is publishable now
  // when it has neither an approval nor a media blocker; the informational
  // "overdue - due time already passed" blocker does NOT exclude it (an approved,
  // overdue post still publishes). nextDue is horizon-clamped to <= 20 (lib/writes.mjs
  // pendpostHealth), so render "N+" at the cap rather than a false exact total.
  const nextDue = pendpostHealth?.nextDue || [];
  const dueCount = nextDue.filter(
    (p) => !(p.blockers || []).some((b) => b.startsWith('approval:') || b === 'media missing'),
  ).length;
  const dueLabel = nextDue.length >= 20 ? `${dueCount}+` : String(dueCount);
  const client = clientName || '';

  // BLOCKED: never poke the lane. Show the verbatim blocker line and a
  // Check-readiness affordance instead of a (disabled) Run-now.
  if (blocker368) {
    return (
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300">
          <AlertCircle size={13} className="shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          <span className="sr-only">{t('planner.runNow.blockedAria')}</span>
          <span>{blocker368}</span>
        </span>
        {/* Run-now is disabled while a 368 is recorded; clicking never publishes. */}
        <button
          type="button"
          disabled
          aria-label={t('planner.runNow.aria')}
          className={HEADER_BTN}
        >
          <Rocket size={13} aria-hidden="true" />
          {/* Label collapses to icon-only below xl so the toolbar stays one line
              (the sidebar eats ~256px, so the header is much narrower than the viewport). */}
          <span className="hidden xl:inline">{t('planner.runNow.idle')}</span>
        </button>
        <Tip label={t('planner.runNow.tip.checkReadiness')}>
          <button
            type="button"
            onClick={() => onCheckReadiness?.()}
            aria-label={t('planner.runNow.checkReadiness')}
            className={HEADER_BTN}
          >
            <ListChecks size={13} aria-hidden="true" />
            <span className="hidden xl:inline">{t('planner.runNow.checkReadiness')}</span>
          </button>
        </Tip>
      </div>
    );
  }

  // The header button now OPENS the review dialog rather than publishing on
  // click - the dialog owns the post list, the multiselect, and the real publish
  // loop. It carries the live due-count badge so the owner sees the scope before
  // opening (nextDue-derived, clamped to N+ at the horizon cap).
  return (
    <div className="flex items-center gap-2">
      <Tip label={t('planner.runNow.tip.run', { client, count: dueLabel })}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t('planner.runNow.aria')}
          aria-haspopup="dialog"
          className={HEADER_BTN}
        >
          <Rocket size={13} aria-hidden="true" />
          {/* Label collapses to icon-only below xl so the toolbar stays one line
              (the sidebar eats ~256px, so the header is much narrower than the viewport). */}
          <span className="hidden xl:inline">{t('planner.runNow.idle')}</span>
        </button>
      </Tip>
      {open ? (
        <PlannerRunNowDialog
          campaigns={campaigns}
          clientName={client}
          onClose={() => setOpen(false)}
          onDone={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
