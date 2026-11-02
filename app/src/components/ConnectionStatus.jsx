// ConnectionStatus - the merged delivery + always-on control. It replaces the
// dismissible SchedulerChip: a persistent, NON-dismissible symbol that sits flush
// with the language/theme toggles and folds two things into one click-popover:
//  1. the local "keep pendpost open" delivery status (off the real scheduler flag), and
//  2. the optional managed-cloud upsell (be online round-the-clock without keeping
//     your computer on).
// Anti-slop: a single brand accent, font-bold max, sentence case, lowercase
// "pendpost". The colour dot is never the only signal - the popover states the
// status in words, the button carries an aria-label and the dot is its accessible
// description. The dot follows the delivery indicator rule (owner decision 2026-11-01,
// q4 a, shared with the sidebar Delivery card through DeliveryGlyph): green = the cloud is
// delivering, amber = needs a look, red = disrupted, amber = this computer is paused;
// publishing from this computer with nothing wrong carries no dot.
// External links reuse the app's <a target="_blank"> pattern (Published/PostDetail);
// the in-app action routes to the Cloud page via onNavigate.
import { useId, useState } from 'react';
import { ExternalLink, ArrowRight } from 'lucide-react';
import { useCloud, useCloudClients, useCloudSubscription, useDeliveryState, cloudTone } from '../lib/cloud.js';
import { useT } from '../lib/i18n.js';
import { Tip } from './ui/Tooltip.jsx';
import { Popover, PopoverTrigger, PopoverContent } from './ui/Popover.jsx';
import { TAP_TARGET } from './ui/recipes.js';
import { CloudIssueRow, ReasonAction, CONNECTIVITY } from './CloudIssues.jsx';
import { deliveryDotClass, deliveryIcon } from './DeliveryGlyph.jsx';

// How many issue rows the popover lists before folding the rest into "n more" (which
// opens the Cloud page, where every project shows its own).
const MAX_ISSUES = 3;

// The managed-offering page (/services) is live. ?from=app flips its managed CTA to
// "enable always-on" (the visitor already has the app set up). External links open in the
// system browser via the launcher's WKWebView navigation policy (launcher/PendpostApp.swift).
const SERVICES_URL = 'https://pendpost.com/services?from=app';

// How loud each dot tone is, so the one header dot shows the worst thing in view.
const TONE_RANK = { disrupted: 3, attention: 2, paused: 1, ok: 0 };
const DOT_LABEL = {
  ok: 'delivery.dot.cloudOk',
  attention: 'delivery.dot.cloudAttention',
  disrupted: 'delivery.dot.cloudDisrupted',
  paused: 'delivery.dot.localPaused',
};

// The delivery state (useDeliveryState) -> the icon, the dot tone (null = no dot) and the
// status-line key. Two orthogonal signals: the GLYPH says where the projects in view publish
// from (a cloud as soon as ANY of them runs on the managed 24/7 runtime, else a monitor = this
// computer), the DOT says how that is going. The cloud health is the SAME derivation the Cloud
// page pill reads (cloudHealth), so the header and the page can never disagree: red = a post
// is at risk right now; amber = delivery degraded (cloud unreachable, sync stopped,
// subscription unreadable) while the local backstop covers it; yellow = a wait that resolves
// itself; green = all confirmed. Green and yellow both mean the cloud is delivering, so both
// carry the green dot. A paused scheduler with projects in view that this computer publishes
// adds an amber dot. `attention` covers the multi-project case: no project in view runs on
// the cloud, but another always-on project has a cloud problem; the dot still carries it,
// with the cloud glyph.
function deriveStatus({ delivery, attention = false }) {
  const { cloud, local } = delivery;
  const localPaused = local.count > 0 && local.running === false;
  if (cloud.count > 0 || attention) {
    const health = { state: cloud.health, reason: cloud.reason };
    const ct = cloudTone(health.state);
    const tone = localPaused && TONE_RANK.paused > (TONE_RANK[ct] ?? -1) ? 'paused' : ct;
    if (health.state === 'red') return { channel: 'cloud', tone, key: 'connection.sync.broken' };
    if (health.state === 'amber') return { channel: 'cloud', tone, key: 'connection.sync.degraded' };
    // yellow is a self-resolving wait. Only a push awaiting its ack is "syncing n posts";
    // the other wait (an on-flag drift being re-asserted) is limited delivery, said plainly.
    if (health.state === 'yellow') {
      const pushing = !health.reason || health.reason === 'push_pending';
      return { channel: 'cloud', tone, key: pushing ? 'connection.sync.pending' : 'connection.sync.degraded' };
    }
    return { channel: 'cloud', tone, key: 'connection.status.cloud' };
  }
  if (local.running === true) return { channel: 'local', tone: null, key: 'connection.status.local' };
  if (local.running === false) return { channel: 'local', tone: 'paused', key: 'connection.status.off' };
  return { channel: 'cloud', tone: null, key: 'connection.status.unknown' };
}

export default function ConnectionStatus({ allClients = false, onNavigate, onShowAtRisk, onIssueAction }) {
  const t = useT();
  const dotId = useId();
  const { data: cloud } = useCloud();
  // Where the projects in view publish from, in All-projects mode across every project
  // (lib/cloud.js useDeliveryState, the same answer the sidebar Delivery card reads). A
  // keyless or paused connection never reads as cloud; while the lists load it falls back to
  // the local-scheduler signal, no false "cloud".
  const delivery = useDeliveryState({ allClients });
  const cloudConnected = delivery.connected;
  const { data: clientsData } = useCloudClients(cloudConnected);
  const cloudOn = delivery.cloud.count > 0;
  const { data: sub, refetch: refetchSub } = useCloudSubscription(cloudConnected);

  const sync = cloudConnected ? (cloud?.sync || null) : null;
  const health = { state: delivery.cloud.health, reason: delivery.cloud.reason };
  const attention = !cloudOn && (health.state === 'red' || health.state === 'amber');
  const { channel, tone, key } = deriveStatus({ delivery, attention });
  const Icon = deliveryIcon(channel, tone);
  const dot = deliveryDotClass(tone);
  // r5: a failed read of the plan info is not a limited cloud; the title says what failed.
  const statusKey = key === 'connection.sync.degraded' && health.reason === 'subscription_failed' ? 'connection.sync.subscriptionFailed' : key;
  const status = t(statusKey, statusKey === 'connection.sync.pending' ? { n: sync?.pendingCount ?? 0 } : undefined);
  const cloudSide = cloudOn || attention;
  const isBroken = cloudSide && health.state === 'red';
  // The detail behind the dot: one row per post / lane / connectivity problem, across every
  // always-on project (older engines send no issues[] -> the reason line below stands in).
  const issues = cloudSide && Array.isArray(sync?.issues) ? sync.issues : [];
  const shownIssues = issues.slice(0, MAX_ISSUES);
  const moreIssues = issues.length - shownIssues.length;
  // The project name only earns its place when more than one project runs in the cloud.
  const multiProject = ((clientsData?.clients) || []).filter((c) => c.alwaysOn).length > 1;
  // A reason sentence only where no issue row explains a non-green state (push pending,
  // subscription unreadable, sync stopped, on-flag drift, an unreadable plan): the rows are
  // the explanation otherwise. Every non-green state gets one.
  const reasonKey = cloudSide && issues.length === 0 && health.state && health.state !== 'green' && health.reason
    ? `connection.sync.reason.${health.reason}` : null;
  const reason = reasonKey && t(reasonKey) !== reasonKey ? t(reasonKey) : null;
  const allDelivered = cloudOn && health.state === 'green';
  // ONE state line replaces the old title + subtitle pair ("Stay online around the clock" /
  // "Publishing through the cloud"): it says what is true right now. With issues it counts
  // them - and names how many projects they span, which is why it can differ from the
  // header triangle and the sidebar "Overdue" count (both count THIS project only).
  const issueProjects = new Set(issues.filter((i) => !CONNECTIVITY.has(i.kind)).map((i) => i.clientId)).size;
  const headline = issues.length === 1 ? t('connection.state.issue')
    : issues.length > 1 ? (multiProject && issueProjects > 1
      ? t('connection.state.issuesProjects', { n: issues.length, p: issueProjects })
      : t('connection.state.issues', { n: issues.length }))
      : allDelivered ? t('connection.issue.allDelivered')
        : status;
  // The planner filter only remains for a red state no row explains: an unreadable plan
  // (manifest_error, zero counts by construction) or an older engine without issues[].
  const showPlanner = isBroken && issues.length === 0 && Boolean(onShowAtRisk);
  // A failed plan read is fixed once the read succeeds again (the recheck probes delivery;
  // the subscription is its own read).
  const subscriptionGone = async () => { const r = await refetchSub?.(); return r ? !r.isError : true; };

  // Controlled so the in-app "manage cloud" button can navigate AND close the popover.
  // (Wrapping that button in Radix <PopoverClose> swallowed its onClick, so the nav
  // never fired - the popover just closed. Close it explicitly via setOpen instead.)
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip label={headline}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('connection.aria')}
            aria-describedby={dot ? dotId : undefined}
            className={`${TAP_TARGET} flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-zinc-200/60 transition hover:bg-zinc-300/60 dark:bg-zinc-800/60 dark:hover:bg-zinc-700/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`}
          >
            <Icon size={14} aria-hidden="true" />
            {dot ? (
              <>
                {/* A button's children are presentational, so the dot is named through the
                    button's accessible description (aria-describedby) instead. */}
                <span
                  data-tone={tone}
                  className={`absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-white dark:ring-zinc-900 ${dot}`}
                  aria-hidden="true"
                />
                <span id={dotId} className="sr-only">{t(DOT_LABEL[tone])}</span>
              </>
            ) : null}
          </button>
        </PopoverTrigger>
      </Tip>
      {/* Full width on a phone (the old fixed 320px left a dead strip at 375px), the
          familiar 320px from sm up. collisionPadding (8px) keeps the gutter. */}
      <PopoverContent align="end" className="w-[calc(100vw-1rem)] space-y-3 p-3 sm:w-80" aria-label={t('connection.title')}>
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 text-sm font-bold">
            <Icon size={14} className="shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
            {headline}
          </p>
          {reason ? (
            <div className="space-y-1.5">
              <p className="text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-300">{reason}</p>
              <ReasonAction
                reason={health.reason}
                gone={health.reason === 'subscription_failed' ? subscriptionGone : undefined}
                onRaiseCap={() => { onNavigate?.('cloud'); setOpen(false); }}
              />
            </div>
          ) : null}
          {/* Money truth stays visible: a used-up trial stops publishing. Everything else
              about the plan lives on the Cloud page, not in this status popover. */}
          {sub?.checkoutEligible ? (
            <p className="text-[11px] font-bold text-amber-700 dark:text-amber-400">{t('connection.needsPayment')}</p>
          ) : null}
        </div>
        {shownIssues.length ? (
          <ul className="space-y-1.5" aria-label={t('connection.issue.listAria')}>
            {shownIssues.map((issue, i) => (
              <CloudIssueRow
                key={`${issue.clientId}:${issue.kind}:${issue.campaign || ''}:${issue.postId || i}`}
                issue={issue}
                showProject={multiProject}
                onAction={onIssueAction ? (it, action) => { setOpen(false); onIssueAction(it, action); } : undefined}
              />
            ))}
            {moreIssues > 0 ? (
              <li>
                <button
                  type="button"
                  onClick={() => { onNavigate?.('cloud'); setOpen(false); }}
                  className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-1.5 text-[11px] font-bold text-zinc-600 transition hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-700/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${TAP_TARGET}`}
                >
                  {t('connection.issue.more', { n: moreIssues })}
                  <ArrowRight size={12} aria-hidden="true" />
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}
        {!cloudConnected ? (
          <div className="space-y-0.5 rounded-xl bg-zinc-100/70 px-3 py-2 dark:bg-zinc-800/50">
            <p className="text-[11px] text-zinc-600 dark:text-zinc-300">{t('connection.price.selfHost')}</p>
            <p className="text-[11px] text-zinc-600 dark:text-zinc-300">{t('connection.price.cloud')}</p>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5 pt-0.5">
          {/* Every red (broken) state names the planner as where the fix lives, so the
              planner CTA is gated on isBroken alone (manifest_error carries zero counts). */}
          {showPlanner ? (
            <button
              type="button"
              onClick={() => { onShowAtRisk(); setOpen(false); }}
              className={`flex items-center justify-between gap-2 rounded-xl bg-brand px-3 py-2 text-xs font-bold text-white transition hover:opacity-90 dark:bg-brand-light dark:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${TAP_TARGET}`}
            >
              {t('connection.viewAtRisk')}
              <ArrowRight size={13} aria-hidden="true" />
            </button>
          ) : null}
          {/* One style in every state: "Manage cloud" is a quiet secondary whether the
              cloud is fine or not (it used to flip to a filled primary on green). The
              not-yet-connected upsell keeps its one primary "Set up" CTA. */}
          <button
            type="button"
            onClick={() => { onNavigate?.('cloud'); setOpen(false); }}
            className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${TAP_TARGET} ${cloudConnected ? 'bg-zinc-200/60 text-zinc-700 hover:bg-zinc-300/60 dark:bg-zinc-800/60 dark:text-zinc-200 dark:hover:bg-zinc-700/60' : 'bg-brand text-white hover:opacity-90 dark:bg-brand-light dark:text-zinc-900'}`}
          >
            {cloudConnected ? t('connection.manage') : t('connection.setup')}
            <ArrowRight size={13} aria-hidden="true" />
          </button>
          {/* The plans link belongs to the not-yet-connected upsell only; a
              connected workspace manages everything via "Manage cloud". */}
          {!cloudConnected ? (
            <a
              href={SERVICES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs font-bold text-zinc-600 transition hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-700/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${TAP_TARGET}`}
            >
              {t('connection.viewPlans')}
              <ExternalLink size={13} aria-hidden="true" />
            </a>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
