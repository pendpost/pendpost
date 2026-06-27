// ReadinessChecklist - renders pendpost_health (US-ONB-05/US-ONB-09) as calm,
// actionable steps: each global blocker is a clickable row that deep-links to
// Setup (no dead ends, US-ONB-09), and the scheduler state carries a one-click
// start affordance. Read-only data; the only write is starting the scheduler
// (setScheduler), which never publishes. The redundant "next due" overview was
// removed (the calendar already carries that information). On the Planner the
// panel is collapsible so the calendar below dominates. Anti-slop: single-tone
// copy, font-bold max, eyebrow micro-labels use the shared EYEBROW token.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, AlertCircle, Play, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { usePendpostHealth, setSchedulerRunning } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { INNER_SURFACE, EYEBROW } from './ui.jsx';

// A pendpost_health blocker arrives as { code, params } (the locale-INDEPENDENT face
// of the English blockers[]); render it via t() so the readiness panel localizes.
// The only nested case is the approval state, resolved through the existing
// approval.* keys; every other code interpolates its params directly.
function renderBlocker(t, b) {
  if (!b || !b.code) return '';
  if (b.code === 'blocker.approval') return t(b.code, { state: t(`approval.${b.params?.state}`) });
  return t(b.code, b.params);
}

export default function ReadinessChecklist({ hideWhenReady = false, collapsible = false, onNavigate = () => {} }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data, isLoading } = usePendpostHealth(true);
  const [busy, setBusy] = useState(false);
  // On the Planner the panel starts collapsed so the calendar below dominates
  // (owner: "minimize the bereitschaft overview"); first-run renders it open.
  const [open, setOpen] = useState(!collapsible);

  if (isLoading || !data) {
    // On the always-on planner placement, stay silent until we know the state;
    // the first-run panel (hideWhenReady=false) shows the loading line.
    return hideWhenReady ? null : <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('readiness.loading')}</p>;
  }

  const { ready, schedulerRunning, blockers = [], blockerCodes = [] } = data;

  // Planner placement: stay quiet when everything is ready, so the happy path is
  // uncluttered. The first-run panel always renders (it confirms readiness too).
  if (hideWhenReady && ready) return null;

  // Build calm, actionable blocker rows from the machine codes (localized via
  // t()), falling back to the English blockers[] for older servers. The
  // scheduler-off blocker is NOT a Setup link - it is covered by the dedicated
  // Start button below - so it renders as a calm note rather than a dead-end.
  const usingCodes = blockerCodes.length > 0;
  // Keep the locale-INDEPENDENT code on each item so the list can key on it
  // rather than the rendered (localized) text - two distinct blockers can
  // localize to identical strings (e.g. duplicate "not connected" lanes),
  // which would collide as React keys and break list reconciliation.
  const items = (usingCodes ? blockerCodes : blockers).map((b) => {
    const isScheduler = usingCodes ? b.code === 'blocker.schedulerOff' : /scheduler is off/i.test(b);
    return { text: usingCodes ? renderBlocker(t, b) : b, code: usingCodes ? b.code : undefined, toSetup: !isScheduler };
  });
  const blockerCount = ready ? 0 : items.length;

  const startScheduler = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await setSchedulerRunning(true);
    } finally {
      setBusy(false);
      queryClient.invalidateQueries({ queryKey: ['pendpost-health'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['plans'] });
    }
  };

  return (
    <section aria-label={t('readiness.title')} className="space-y-2.5">
      <div className="flex items-center gap-2">
        <h3 className={`flex-1 ${EYEBROW}`}>{t('readiness.title')}</h3>
        {collapsible ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={open ? 'readiness-content' : undefined}
            aria-label={!open && blockerCount ? t('readiness.expandCount', { count: blockerCount }) : (open ? t('readiness.collapse') : t('readiness.expand'))}
            className="flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-[11px] font-bold text-zinc-500 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:bg-zinc-700/60"
          >
            {!open && blockerCount ? (
              <span aria-hidden="true" className="rounded-full bg-zinc-300/70 px-1.5 text-[10px] font-bold text-zinc-600 dark:bg-zinc-600/70 dark:text-zinc-200">{blockerCount}</span>
            ) : null}
            <ChevronDown size={14} aria-hidden="true" className={`transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        ) : null}
      </div>

      {open ? (
        <>
          {/* Live region: usePendpostHealth polls in the background, so blockers
              clearing and the flip to the ready state happen without user input.
              aria-live announces those transitions (e.g. a credential fixed in
              another tab) instead of leaving an AT user to re-poll the panel. */}
          <div id="readiness-content" aria-live="polite">
          {ready ? (
            <div className={`flex items-start gap-2 rounded-xl px-3 py-2 ${INNER_SURFACE}`}>
              <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-xs font-bold">{t('readiness.ready')}</p>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('readiness.readySub')}</p>
              </div>
            </div>
          ) : (
            <ul className="space-y-1.5">
              {items.map((item, i) => (
                <li key={`${i}-${item.code ?? item.text}`}>
                  {item.toSetup ? (
                    // Calm + clickable: zinc (not amber-alarm), deep-links to Setup
                    // so a "not connected" lane reads as a setup step, not an error.
                    <button
                      type="button"
                      onClick={() => onNavigate('setup')}
                      className={`group flex w-full items-start gap-2 rounded-xl px-3 py-2 text-left transition hover:ring-1 hover:ring-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${INNER_SURFACE}`}
                    >
                      <AlertCircle size={15} className="mt-0.5 shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
                      <span className="min-w-0 flex-1 text-xs">{item.text}</span>
                      <ChevronRight size={14} className="mt-0.5 shrink-0 text-zinc-400 transition group-hover:translate-x-0.5" aria-hidden="true" />
                    </button>
                  ) : (
                    <div className={`flex items-start gap-2 rounded-xl px-3 py-2 ${INNER_SURFACE}`}>
                      <AlertCircle size={15} className="mt-0.5 shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
                      <span className="min-w-0 text-xs">{item.text}</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          </div>

          {!schedulerRunning ? (
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={startScheduler}
                disabled={busy || !ready}
                aria-label={!ready ? t('readiness.scheduler.waiting') : t('readiness.startScheduler')}
                title={!ready ? t('readiness.scheduler.waiting') : undefined}
                className="flex items-center gap-1.5 rounded-xl bg-brand px-3 py-2 text-xs font-bold text-white transition hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 dark:bg-brand-light dark:text-zinc-900"
              >
                {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
                {t('readiness.startScheduler')}
              </button>
              {/* US-ONB-10: explain the scheduler inline so it never reads as a
                  button that "does nothing" - it starts a background daemon and
                  never publishes on this click. Gated until pendpost is ready. */}
              <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{t('readiness.scheduler.explain')}</p>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
