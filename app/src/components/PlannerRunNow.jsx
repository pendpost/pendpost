// B6 — Planner Run-now / Check-readiness, routed through the in-app review gate.
//
// The ONLY publish-triggering control on the planner header, as items of the header's one
// overflow menu (Nov 2026 header diet). It is gated by pendpost_health.blockers (the READ-ONLY
// Meta-368 surface, lib/writes.mjs pendpostHealth blockers push):
//   - A recorded Meta action block (368) DISABLES Run-now (the line is its reason) and offers
//     Check-readiness instead, so the blocked Meta lane is never poked. The 368 state is read
//     from pendpost_health.blockers, NEVER inferred from the run result (the 368 is applied
//     per-lane mid-run; runDueExclusive only returns in_flight when busy).
//   - Otherwise, the item opens the PlannerRunNowDialog review sheet: it lists the posts the
//     scheduler would fire now, pre-selected, and the owner picks a subset before any publish.
//     The dialog IS the confirmation; it owns the per-post publish loop, the needs_confirm
//     escalation, the in_flight handling, and the query refresh.
import { useState } from 'react';
import { Rocket, ListChecks } from 'lucide-react';
import { useT } from '../lib/i18n.js';
import PlannerRunNowDialog from './PlannerRunNowDialog.jsx';

// The 368 lives in pendpost_health.blockers[] as a free-form line (lib/writes.mjs pendpostHealth blockers push);
// the stable marker is the "Meta action block" phrase. We surface the line verbatim
// and never parse a clear time out of it (a 368 carries none).
const META_368_RE = /meta action block/i;
function find368Blocker(pendpostHealth) {
  const blockers = pendpostHealth?.blockers || [];
  return blockers.find((b) => META_368_RE.test(String(b))) || null;
}

// The same gate as menu items, for the header's one overflow menu (App.jsx): the run-now entry
// (disabled with the 368 line as its reason while Meta is blocked, plus Check readiness) and
// the review dialog it opens. The menu closes before an item runs, so the dialog is rendered
// by the caller, outside the menu.
export function usePlannerRunNow({ pendpostHealth, campaigns = [], onCheckReadiness, clientName }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const blocker368 = find368Blocker(pendpostHealth);
  const client = clientName || '';
  const items = blocker368
    ? [
      { key: 'run-now', label: t('planner.runNow.aria'), Icon: Rocket, disabled: true, reason: blocker368 },
      { key: 'check-readiness', label: t('planner.runNow.checkReadiness'), Icon: ListChecks, run: () => onCheckReadiness?.() },
    ]
    : [{ key: 'run-now', label: t('planner.runNow.aria'), Icon: Rocket, run: () => setOpen(true) }];
  const dialog = open && !blocker368 ? (
    <PlannerRunNowDialog campaigns={campaigns} clientName={client} onClose={() => setOpen(false)} onDone={() => setOpen(false)} />
  ) : null;
  return { items, dialog };
}
