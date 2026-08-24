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
import { usePendpostHealth, setSchedulerRunning, resumeLane } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { INNER_SURFACE, EYEBROW, DISABLED_PRIMARY, PLATFORM_META } from './ui.jsx';

// A pendpost_health blocker arrives as { code, params } (the locale-INDEPENDENT face
// of the English blockers[]); render it via t() so the readiness panel localizes.
// The only nested case is the approval state, resolved through the existing
// approval.* keys; every other code interpolates its params directly.
function renderBlocker(t, b) {
  if (!b || !b.code) return '';
  if (b.code === 'blocker.approval') return t(b.code, { state: t(`approval.${b.params?.state}`) });
  if (b.code === 'blocker.laneBlocked') {
    // Show the platform under its display name, and fall back to the reason-less
    // variant when the server recorded no message (never interpolate a null).
    const platform = PLATFORM_META[b.params?.platform]?.label || b.params?.platform || '';
    if (!b.params?.reason) return t('blocker.laneBlocked.noReason', { platform });
    return t(b.code, { platform, reason: b.params.reason });
  }
  return t(b.code, b.params);
}

export default function ReadinessChecklist({ hideWhenReady = false, collapsible = false, onNavigate = () => {}, onOpenPost = null }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data, isLoading } = usePendpostHealth(true);
  const [busy, setBusy] = useState(false);
  const [busyLane, setBusyLane] = useState(null);
  // On the Planner the panel starts collapsed so the calendar below dominates
  // (owner: "minimize the bereitschaft overview"); first-run renders it open.
  const [open, setOpen] = useState(!collapsible);

  if (isLoading || !data) {
    // On the always-on planner placement, stay silent until we know the state;
    // the first-run panel (hideWhenReady=false) shows the loading line.
    return hideWhenReady ? null : <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('readiness.loading')}</p>;
  }

  const { ready: serverReady, schedulerRunning, blockers = [], blockerCodes = [] } = data;

  // Build calm, actionable blocker rows from the machine codes (localized via
  // t()), falling back to the English blockers[] for older servers. The
  // scheduler-off blocker is NOT a Setup link - it is covered by the dedicated
  // Start button below - so it renders as a calm note rather than a dead-end.
  const usingCodes = blockerCodes.length > 0;
  // Keep the locale-INDEPENDENT code on each item so the list can key on it
  // rather than the rendered (localized) text - two distinct blockers can
  // localize to identical strings (e.g. duplicate "not connected" lanes),
  // which would collide as React keys and break list reconciliation.
  // blocker.overdueUnpublished is the PER-POST blocker (an approved, past-due post the
  // publisher could not land, params {campaign, postId, reason}) - the one bridge
  // between a stuck post and the operator. It renders with its reason and deep-links
  // to the POST (onOpenPost), not to Setup, which cannot fix a platform rejection.
  const items = (usingCodes ? blockerCodes : blockers).map((b) => {
    const isScheduler = usingCodes ? b.code === 'blocker.schedulerOff' : /scheduler is off/i.test(b);
    const post = usingCodes && b.code === 'blocker.overdueUnpublished' && b.params?.campaign && b.params?.postId
      ? { campaign: b.params.campaign, id: b.params.postId }
      : null;
    // blocker.laneBlocked is a halted lane (e.g. X credits depleted): its recovery is
    // the inline Resume button, not a Setup link - Setup cannot top up an API plan.
    const lane = usingCodes && b.code === 'blocker.laneBlocked' ? (b.params?.platform || null) : null;
    return { text: usingCodes ? renderBlocker(t, b) : b, code: usingCodes ? b.code : undefined, toSetup: !isScheduler && !post && !lane, post, lane };
  });
  // Ready FOR THIS PANEL derives from the rows that actually render, so the badge
  // count, the list and the "all set" line can never contradict each other.
  const ready = serverReady || items.length === 0;
  // US-ONB-12: a fresh workspace repeats the same "not connected" sentence once
  // per lane - eight identical rows of homework. Identical not-connected rows
  // collapse into ONE aggregate row ("N of M connected - open Setup") naming the
  // lanes on a muted second line; lanes with DISTINCT states (failed, blocked,
  // unproven) keep their own rows, because those are different problems.
  const notConnected = usingCodes ? items.filter((it) => it.code === 'blocker.lane.notConnected') : [];
  const collapseLanes = notConnected.length >= 2;
  const rows = collapseLanes ? items.filter((it) => it.code !== 'blocker.lane.notConnected') : items;
  const setupPlatforms = Array.isArray(data.setup?.platforms) ? data.setup.platforms.filter((pp) => pp.status !== 'skipped') : null;
  const aggregate = collapseLanes ? {
    text: setupPlatforms
      ? t('readiness.aggregate.connected', { connected: setupPlatforms.length - notConnected.length, total: setupPlatforms.length })
      : t('readiness.aggregate.notConnected', { count: notConnected.length }),
    lanes: (usingCodes ? blockerCodes : []).filter((b) => b.code === 'blocker.lane.notConnected').map((b) => b.params?.label).filter(Boolean).join(' · '),
  } : null;
  // Planner placement: stay quiet when everything is ready, so the happy path is
  // uncluttered. The first-run panel always renders (it confirms readiness too).
  if (hideWhenReady && ready) return null;
  const blockerCount = ready ? 0 : rows.length + (aggregate ? 1 : 0);

  const onResumeLane = async (lane) => {
    if (busyLane) return;
    setBusyLane(lane);
    try {
      await resumeLane(lane);
    } finally {
      setBusyLane(null);
      queryClient.invalidateQueries({ queryKey: ['pendpost-health'] });
      queryClient.invalidateQueries({ queryKey: ['plans'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    }
  };

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
            className="flex min-h-[24px] items-center gap-1 rounded-lg px-1.5 py-0.5 text-[11px] font-bold text-zinc-500 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:bg-zinc-700/60"
          >
            {!open && blockerCount ? (
              // Pair the count with an AlertCircle glyph so the collapsed badge
              // reads as "attention needed" - a naked number can be misread as a
              // positive/ready count. Calm zinc (not amber-alarm), matching the
              // panel's blocker rows; the button aria-label carries the meaning.
              <>
                <AlertCircle size={12} aria-hidden="true" className="text-zinc-500 dark:text-zinc-400" />
                <span aria-hidden="true" className="rounded-full bg-zinc-300/70 px-1.5 text-[10px] font-bold text-zinc-600 dark:bg-zinc-600/70 dark:text-zinc-200">{blockerCount}</span>
              </>
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
              {aggregate ? (
                <li key="aggregate-not-connected">
                  <button
                    type="button"
                    onClick={() => onNavigate('setup')}
                    className={`group flex w-full items-start gap-2 rounded-xl px-3 py-2 text-left transition hover:ring-1 hover:ring-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${INNER_SURFACE}`}
                  >
                    <AlertCircle size={15} className="mt-0.5 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs">{aggregate.text}</span>
                      {aggregate.lanes ? <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{aggregate.lanes}</span> : null}
                    </span>
                    <ChevronRight size={14} className="mt-0.5 shrink-0 text-zinc-500 transition group-hover:translate-x-0.5" aria-hidden="true" />
                  </button>
                </li>
              ) : null}
              {rows.map((item, i) => (
                <li key={`${i}-${item.code ?? item.text}`}>
                  {item.post && onOpenPost ? (
                    // Per-post failure: deep-link to the affected POST itself (the
                    // detail drawer carries the recovery verbs), not to Setup.
                    <button
                      type="button"
                      onClick={() => onOpenPost(item.post)}
                      className={`group flex w-full items-start gap-2 rounded-xl px-3 py-2 text-left transition hover:ring-1 hover:ring-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${INNER_SURFACE}`}
                    >
                      <AlertCircle size={15} className="mt-0.5 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs">{item.text}</span>
                        <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{item.post.campaign}</span>
                      </span>
                      <ChevronRight size={14} className="mt-0.5 shrink-0 text-zinc-500 transition group-hover:translate-x-0.5" aria-hidden="true" />
                    </button>
                  ) : item.lane ? (
                    // Halted lane: the recovery action lives IN the error row (resume
                    // re-arms publishing and releases the holds the halt parked).
                    <div className={`flex items-start gap-2 rounded-xl px-3 py-2 ${INNER_SURFACE}`}>
                      <AlertCircle size={15} className="mt-0.5 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
                      <span className="min-w-0 flex-1 text-xs">{item.text}</span>
                      <button
                        type="button"
                        onClick={() => onResumeLane(item.lane)}
                        disabled={busyLane != null}
                        className="flex shrink-0 items-center gap-1 rounded-lg border border-zinc-300 px-2 py-1 text-[11px] font-bold transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-700/60"
                      >
                        {busyLane === item.lane ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : null}
                        {t('readiness.resumeLane')}
                      </button>
                    </div>
                  ) : item.toSetup ? (
                    // Calm + clickable: zinc (not amber-alarm), deep-links to Setup
                    // so a "not connected" lane reads as a setup step, not an error.
                    <button
                      type="button"
                      onClick={() => onNavigate('setup')}
                      className={`group flex w-full items-start gap-2 rounded-xl px-3 py-2 text-left transition hover:ring-1 hover:ring-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${INNER_SURFACE}`}
                    >
                      <AlertCircle size={15} className="mt-0.5 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
                      <span className="min-w-0 flex-1 text-xs">{item.text}</span>
                      <ChevronRight size={14} className="mt-0.5 shrink-0 text-zinc-500 transition group-hover:translate-x-0.5" aria-hidden="true" />
                    </button>
                  ) : (
                    <div className={`flex items-start gap-2 rounded-xl px-3 py-2 ${INNER_SURFACE}`}>
                      <AlertCircle size={15} className="mt-0.5 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
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
                className={`flex items-center gap-1.5 rounded-xl bg-brand px-3 py-2 text-xs font-bold text-white transition hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-brand-light dark:text-zinc-900 ${DISABLED_PRIMARY}`}
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
