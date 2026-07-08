// ConnectionStatus - the merged delivery + always-on control. It replaces the
// dismissible SchedulerChip: a persistent, NON-dismissible symbol that sits flush
// with the language/theme toggles and folds two things into one click-popover:
//  1. the local "keep pendpost open" delivery status (off the real scheduler flag), and
//  2. the optional managed-cloud upsell (be online round-the-clock without keeping
//     your computer on).
// Anti-slop: a single brand accent, font-bold max, sentence case, lowercase
// "pendpost". The colour dot is never the only signal - the popover states the
// status in words and the button carries an aria-label. External links reuse the
// app's <a target="_blank"> pattern (Published/PostDetail); the in-app action routes
// to the Cloud page via onNavigate.
import { useState } from 'react';
import { Cloud as CloudIcon, Monitor, MonitorOff, ExternalLink, ArrowRight } from 'lucide-react';
import { useCloud, useCloudClients, useCloudSubscription } from '../lib/cloud.js';
import { LanesHonestyNote } from './CloudLanesNote.jsx';
import { useT } from '../lib/i18n.js';
import { Tip } from './ui/Tooltip.jsx';
import { Popover, PopoverTrigger, PopoverContent } from './ui/Popover.jsx';

// The managed-offering page (/services) is live. ?from=app flips its managed CTA to
// "enable always-on" (the visitor already has the app set up). External links open in the
// system browser via the launcher's WKWebView navigation policy (launcher/PendpostApp.swift).
const SERVICES_URL = 'https://pendpost.com/services?from=app';

// The merged state -> the icon, the status-dot colour (null = neutral / not
// highlighted), and the status-line key. Two orthogonal signals, no redundancy:
// the GLYPH encodes the delivery channel (a cloud = managed 24/7 runtime; a
// monitor = your own computer), the DOT encodes activity. Cloud-on carries the
// GUARANTEE roll-up (GET /api/cloud `sync`): emerald = every approved cloud-lane
// post is confirmed on the cloud and will fire; amber = approved posts still
// syncing; red = the guarantee is broken (unreachable / overdue / failed / sync
// stopped) - the engine's local backstop is already covering, but the owner
// should look. A missing roll-up (older engine, loading) stays emerald as before.
// Cloud-on wins over the local scheduler; an unknown scheduler flag stays neutral
// (no dot) so there is no false "off" on first paint.
// The `sync` roll-up is now a THREE-severity signal so a real miss never looks like a
// mere hiccup: red = a post is at risk RIGHT NOW (overdue-unpublished / failed fire /
// unreadable plan); amber ('degraded') = delivery is degraded (cloud unreachable / its
// worker wedged / sync stopped / on-flag drift) but the local backstop covers it while
// the Mac is awake - attention, not failure; amber ('pending') = approved posts still
// syncing (normal for <=1 tick); emerald = all cloud-lane posts confirmed.
function deriveStatus({ running, cloudOn, sync }) {
  if (cloudOn) {
    if (sync?.state === 'red') return { Icon: CloudIcon, dot: 'bg-red-500', key: 'connection.sync.broken' };
    if (sync?.state === 'amber') return { Icon: CloudIcon, dot: 'bg-amber-500', key: 'connection.sync.degraded' };
    if (sync?.state === 'yellow') return { Icon: CloudIcon, dot: 'bg-amber-500', key: 'connection.sync.pending' };
    return { Icon: CloudIcon, dot: 'bg-emerald-500', key: 'connection.status.cloud' };
  }
  if (running === true) return { Icon: Monitor, dot: 'bg-emerald-500', key: 'connection.status.local' };
  if (running === false) return { Icon: MonitorOff, dot: 'bg-amber-500', key: 'connection.status.off' };
  return { Icon: CloudIcon, dot: null, key: 'connection.status.unknown' };
}

export default function ConnectionStatus({ running, onNavigate, onShowAtRisk }) {
  const t = useT();
  const { data: cloud } = useCloud();
  // OPERATIONAL requires a workspace AND the api key - identical to Cloud.jsx's `connected`
  // gate. A configured-but-keyless connection (workspaceId set, PENDPOST_CLOUD_API_KEY
  // missing) cannot publish, so it must NOT read as cloud-on here; the page routes it to
  // the "finish setup" view and the local scheduler is the real firer. Without the key
  // check the header showed a green "publishing via cloud" while the cloud page said the
  // connection was unfinished - the two faces disagreed.
  const cloudConnected = Boolean(cloud?.workspaceId && cloud?.apiKey?.present);
  // The glyph follows the SELECTED client, not the install: the cloud only fires a brand
  // that is itself always-on, so a connected install whose active client is NOT always-on
  // still publishes that client locally and must read as local here. `active` is the
  // selected client (the server resolves it from the active-client registry). Undefined
  // while the list loads -> falls back to the local-scheduler signal, no false "cloud".
  const { data: clientsData } = useCloudClients(cloudConnected);
  const activeAlwaysOn = ((clientsData?.clients) || []).find((c) => c.active)?.alwaysOn === true;
  const cloudOn = cloudConnected && Boolean(cloud?.enabled) && activeAlwaysOn;
  const { data: sub } = useCloudSubscription(cloudConnected);

  const sync = cloud?.sync || null;
  const { Icon, dot, key } = deriveStatus({ running, cloudOn, sync });
  const status = t(key, key === 'connection.sync.pending' ? { n: sync?.pendingCount ?? 0 } : undefined);
  // Amber (degraded) and red (broken) both carry a one-line WHY (the machine reason from
  // the guarantee roll-up); red additionally names how many posts are at risk right now.
  const degraded = cloudOn && (sync?.state === 'red' || sync?.state === 'amber');
  const isBroken = cloudOn && sync?.state === 'red';
  const syncReason = degraded ? t(`connection.sync.reason.${sync.reason}`) : null;
  const missedCount = (sync?.overdueCount ?? 0) + (sync?.failedCount ?? 0);

  // Controlled so the in-app "manage cloud" button can navigate AND close the popover.
  // (Wrapping that button in Radix <PopoverClose> swallowed its onClick, so the nav
  // never fired - the popover just closed. Close it explicitly via setOpen instead.)
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip label={status}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('connection.aria')}
            className="relative flex h-8 w-8 items-center justify-center rounded-xl bg-zinc-200/60 transition hover:bg-zinc-300/60 dark:bg-zinc-800/60 dark:hover:bg-zinc-700/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <Icon size={14} aria-hidden="true" />
            {dot ? (
              <span
                className={`absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-white dark:ring-zinc-900 ${dot}`}
                aria-hidden="true"
              />
            ) : null}
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="w-72 space-y-3 p-3" aria-label={t('connection.title')}>
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 text-sm font-bold">
            <Icon size={14} className="shrink-0 text-brand dark:text-brand-light" aria-hidden="true" />
            {t('connection.title')}
          </p>
          <p className="text-[11px] font-bold text-zinc-500 dark:text-zinc-400">{status}</p>
          {syncReason ? (
            <p className={`text-[11px] leading-relaxed ${isBroken ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}`}>{syncReason}</p>
          ) : null}
          {isBroken && missedCount > 0 ? (
            <p className="text-[11px] font-bold text-red-600 dark:text-red-400">{t('connection.sync.missedCount', { n: missedCount })}</p>
          ) : null}
          {sub && sub.postsIncluded > 0 ? (
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
              <span className="font-bold text-zinc-600 dark:text-zinc-300">{sub.tier ? t(`cloud.tier.${sub.tier}`) : t('cloud.tier.trial')}</span>
              {' · '}
              {t('connection.usage', { used: sub.postsUsed, included: sub.postsIncluded })}
              {sub.checkoutEligible ? <span className="ml-1.5 font-bold text-amber-600 dark:text-amber-400">{t('connection.needsPayment')}</span> : null}
            </p>
          ) : null}
          {/* Coverage, once on: the ONE short honest-limit line (which lanes still
              need this machine), from the same capability map as the /cloud page.
              Hidden while the guarantee is broken - the miss line + CTA own that
              state and the popover stays minimal. */}
          {cloudOn && !isBroken ? <LanesHonestyNote short className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400" /> : null}
        </div>
        {!cloudConnected ? (
          <div className="space-y-0.5 rounded-xl bg-zinc-100/70 px-3 py-2 dark:bg-zinc-800/50">
            <p className="text-[11px] text-zinc-600 dark:text-zinc-300">{t('connection.price.selfHost')}</p>
            <p className="text-[11px] text-zinc-600 dark:text-zinc-300">{t('connection.price.cloud')}</p>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5 pt-0.5">
          {isBroken && missedCount > 0 && onShowAtRisk ? (
            <button
              type="button"
              onClick={() => { onShowAtRisk(); setOpen(false); }}
              className="flex items-center justify-between gap-2 rounded-xl bg-brand px-3 py-2 text-xs font-bold text-white transition hover:opacity-90 dark:bg-brand-light dark:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              {t('connection.viewAtRisk')}
              <ArrowRight size={13} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => { onNavigate?.('cloud'); setOpen(false); }}
            className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${isBroken && missedCount > 0 && onShowAtRisk ? 'bg-zinc-200/60 text-zinc-700 hover:bg-zinc-300/60 dark:bg-zinc-800/60 dark:text-zinc-200 dark:hover:bg-zinc-700/60' : 'bg-brand text-white hover:opacity-90 dark:bg-brand-light dark:text-zinc-900'}`}
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
              className="flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs font-bold text-zinc-600 transition hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-700/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
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
