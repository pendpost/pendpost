import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Activity, BarChart3, CheckCircle2, Play, Square, RefreshCw, ClipboardCopy, Check, Plus, Settings, ChevronRight, FolderOpen, Users, Send, Wrench, LifeBuoy, Cloud, Monitor } from 'lucide-react';
import { setSchedulerRunning, refreshLinkedinToken, clearMetaBlock, recheckHealth } from '../lib/api.js';
import { useCloud, useCloudClients } from '../lib/cloud.js';
import { fmtTime, fmtDayShort, fmtFull, dateLocale } from '../lib/format.js';
import { useT } from '../lib/i18n.js';
import { EYEBROW, INNER_SURFACE, PLATFORM_META } from './ui.jsx';
import ClientSwitcher from './ClientSwitcher.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { useConfirm, usePrompt } from './ui/confirm.jsx';
import FeedbackDialog from './FeedbackDialog.jsx';

// Relative "checked X ago" for the live-probe sub line. Takes the translator so it
// stays a pure helper while returning localized prose.
function ago(iso, t) {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const min = Math.round(ms / 60000);
  if (min < 1) return t('sidebar.ago.justNow');
  if (min < 60) return t('sidebar.ago.minutes', { n: min });
  const h = Math.round(min / 60);
  if (h < 24) return t('sidebar.ago.hours', { n: h });
  return t('sidebar.ago.days', { n: Math.round(h / 24) });
}

// Health-tile sub-line from a lane's live probe (3b): presence flags say a
// credential EXISTS; live says it actually authenticates. `fallback` is the
// caller's already-localized "Page id" / "not configured" / "not connected" line,
// `connected` the caller's own credential flag. A failed probe on a lane with NO
// creds reads as the localized fallback - the engine's raw English detail
// ("not configured (Page token/Page ID missing)") is honest ONLY on a lane that
// HAS creds but failed a live probe (e.g. "introspect HTTP 401"), where it passes
// through verbatim. Module-level + t-injected so it stays a pure, testable helper.
export function liveSub(t, live, fallback, connected) {
  if (!live || live.skipped) return fallback;
  if (live.ok !== true && !connected) return fallback;
  const checkedAgo = ago(live.checkedAt, t);
  const base = live.ok ? t('setup.status.connected') : (live.detail || t('sidebar.probeFailed'));
  return checkedAgo ? t('sidebar.checkedAgo', { base, ago: checkedAgo }) : base;
}

// Live liveness re-check: probes every platform now and refreshes the tiles.
function RecheckButton() {
  const t = useT();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await recheckHealth();
    } catch {
      /* tiles keep showing the last probe result */
    } finally {
      setBusy(false);
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    }
  };
  return (
    <Tip label={t('sidebar.recheck')}>
      <button
        type="button"
        onClick={run}
        disabled={busy}
        aria-label={t('sidebar.recheck')}
        className="rounded-lg p-1 transition hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60 focus-visible:ring-2 focus-visible:ring-brand"
      >
        <RefreshCw size={12} className={busy ? 'animate-spin' : ''} aria-hidden="true" />
      </button>
    </Tip>
  );
}

function HealthDot({ tone }) {
  const cls = tone === 'ok' ? 'bg-emerald-500' : tone === 'warn' ? 'bg-amber-500' : tone === 'err' ? 'bg-red-500' : 'bg-zinc-400';
  return <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${cls}`} aria-hidden="true" />;
}

export function HealthTile({ tone, title, sub, action, onClick }) {
  const t = useT();
  const body = (
    <>
      <HealthDot tone={tone} />
      <div className="min-w-0 flex-1">
        <p className="min-w-0 truncate text-xs font-bold leading-tight">{title}</p>
        {sub ? <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">{sub}</p> : null}
      </div>
    </>
  );
  return (
    <div className={`flex items-start gap-2 rounded-xl px-3 py-2 ${INNER_SURFACE}`}>
      {/* US-CONN-14: the credential tiles deep-link to Setup so a non-technical
          owner has a path forward instead of a copy-CLI dead end. Any CLI action
          stays a sibling control, never nested inside this button (no
          nested-interactive a11y violation). */}
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          aria-label={t('sidebar.openSetupFor', { platform: title })}
          className="group flex min-w-0 flex-1 items-start gap-2 rounded-lg text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-2">{body}</div>
      )}
      {action}
    </div>
  );
}

// A compact account chip (item 10): the platform's brand glyph(s) + a status dot, with
// the full status carried in the tooltip AND the accessible name - logo + colour + hover
// are enough, no always-on status line. Clicking deep-links to Setup. A healthy lane is
// just the logo + an emerald dot; attention shows amber/red, with the detail one hover away.
function AccountChip({ icons, tone, title, status, onClick }) {
  const label = status ? `${title} · ${status}` : title;
  const dot = tone === 'ok' ? 'bg-emerald-500' : tone === 'warn' ? 'bg-amber-500' : tone === 'err' ? 'bg-red-500' : 'bg-zinc-400';
  return (
    <Tip label={label}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className="relative grid place-items-center rounded-xl p-2 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60"
      >
        <span className="flex items-center gap-0.5">
          {icons.map(({ Icon, color }, i) => <Icon key={i} size={15} className={color} aria-hidden="true" />)}
        </span>
        <span className={`absolute right-0.5 top-0.5 h-2 w-2 rounded-full ring-2 ring-white dark:ring-zinc-900 ${dot}`} aria-hidden="true" />
      </button>
    </Tip>
  );
}

export function NavItem({ icon: Icon, label, active, badge, badgeLabel, disabled, onClick }) {
  const cls = active
    ? 'bg-brand text-white shadow-lg shadow-brand/20 font-bold dark:bg-brand-light dark:text-zinc-900'
    : disabled
      ? 'text-zinc-400 dark:text-zinc-500'
      : 'text-zinc-600 transition hover:bg-zinc-200/50 dark:text-zinc-300 dark:hover:bg-zinc-800/50';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? 'page' : undefined}
      className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm focus-visible:ring-2 focus-visible:ring-brand ${cls}`}
    >
      <Icon size={16} aria-hidden="true" />
      <span className="flex-1">{label}</span>
      {badge ? (
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${active ? 'bg-white/25 text-white dark:bg-zinc-900/20 dark:text-zinc-900' : 'bg-zinc-200/80 text-zinc-500 dark:bg-zinc-700/80 dark:text-zinc-400'}`}>
          <span aria-hidden="true">{badge}</span>
          {badgeLabel ? <span className="sr-only">{badgeLabel}</span> : null}
        </span>
      ) : null}
    </button>
  );
}

// US-ONB-10: starting the scheduler is gated on pendpost readiness, mirroring the
// canonical ReadinessChecklist (disabled until ready, with a waiting tooltip).
// `setupReady === false` is the only blocking state; null/undefined (signal not
// yet loaded) does not lock the control. Stopping a running scheduler is always
// allowed.
export function SchedulerToggle({ running, setupReady }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const blockedNotReady = !running && setupReady === false;
  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await setSchedulerRunning(!running);
    } finally {
      setBusy(false);
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['plans'] });
    }
  };
  const label = running
    ? t('sidebar.scheduler.stop')
    : blockedNotReady
      ? t('readiness.scheduler.waiting')
      : t('sidebar.scheduler.startHelp');
  return (
    <Tip label={label}>
      <button
        type="button"
        onClick={toggle}
        disabled={busy || blockedNotReady}
        aria-label={blockedNotReady ? t('readiness.scheduler.waiting') : running ? t('sidebar.scheduler.stop') : t('sidebar.scheduler.start')}
        className="rounded-lg p-1.5 transition hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60 focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
      >
        {running ? <Square size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
      </button>
    </Tip>
  );
}

// LinkedIn is the only platform with a programmatic refresh; re-auth itself
// is an interactive browser ceremony, so the button next to an unauthorized
// account copies the exact CLI command instead of pretending the UI could.
function TokenAction({ authenticated, refreshable, authCommand }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [state, setState] = useState('idle');
  const prompt = usePrompt();
  if (authenticated && !refreshable) return null;

  const doRefresh = async () => {
    setState('busy');
    try {
      await refreshLinkedinToken();
      setState('idle');
    } catch {
      setState('failed');
      setTimeout(() => setState('idle'), 2500);
    } finally {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    }
  };
  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(authCommand);
      setState('copied');
    } catch {
      await prompt({ title: t('setup.secret.copyTitle'), body: t('sidebar.copyCommandBody'), defaultValue: authCommand, multiline: true });
    }
    setTimeout(() => setState('idle'), 1800);
  };

  if (!authenticated) {
    return (
      <Tip label={t('sidebar.reauthTip', { cmd: authCommand })}>
        <button
          type="button"
          onClick={doCopy}
          aria-label={t('sidebar.copyReauth')}
          className="rounded-lg p-1.5 transition hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60 focus-visible:ring-2 focus-visible:ring-brand"
        >
          {state === 'copied' ? <Check size={13} className="text-emerald-600 dark:text-emerald-300" aria-hidden="true" /> : <ClipboardCopy size={13} aria-hidden="true" />}
        </button>
      </Tip>
    );
  }
  return (
    <Tip label={t('sidebar.refreshToken')}>
      <button
        type="button"
        onClick={doRefresh}
        disabled={state === 'busy'}
        aria-label={t('sidebar.refreshLinkedinToken')}
        className={`rounded-lg p-1.5 transition hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60 focus-visible:ring-2 focus-visible:ring-brand ${state === 'failed' ? 'text-red-600 dark:text-red-300' : ''}`}
      >
        <RefreshCw size={13} className={state === 'busy' ? 'animate-spin' : ''} aria-hidden="true" />
      </button>
    </Tip>
  );
}

// A recorded Meta-368 block has no machine-readable clear time, so it stays
// active until the owner confirms (out of band, in the Meta Business Suite)
// that Meta lifted it and clears it here. No timestamp auto-expiry.
function MetaBlockAction() {
  const t = useT();
  const queryClient = useQueryClient();
  const [state, setState] = useState('idle');
  const confirm = useConfirm();
  const doClear = async () => {
    if (!(await confirm({ title: t('sidebar.clearBlock.title'), body: t('sidebar.clearBlock.body'), confirmLabel: t('sidebar.clearBlock.confirm'), danger: true }))) return;
    setState('busy');
    try {
      await clearMetaBlock();
      setState('idle');
    } catch {
      setState('failed');
      setTimeout(() => setState('idle'), 2500);
    } finally {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    }
  };
  return (
    <Tip label={t('sidebar.markCleared')}>
      <button
        type="button"
        onClick={doClear}
        disabled={state === 'busy'}
        aria-label={t('sidebar.markMetaCleared')}
        className={`rounded-lg p-1.5 transition hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60 focus-visible:ring-2 focus-visible:ring-brand ${state === 'failed' ? 'text-red-600 dark:text-red-300' : ''}`}
      >
        <Check size={13} aria-hidden="true" />
      </button>
    </Tip>
  );
}

export default function Sidebar({ accounts, pendingCount, nextPost, overdueCount, setupReady, setupIncomplete, activePage, onNavigate, onNew, onOpenPost, onShowOverdue }) {
  const t = useT();
  const [showFeedback, setShowFeedback] = useState(false);
  const meta = accounts?.meta;
  const li = accounts?.linkedin;
  const yt = accounts?.youtube;
  const x = accounts?.x;
  const block = meta?.block;
  const blocked = Boolean(block?.tracked && block.blockedUntil);
  const pastAnchor = blocked && Date.parse(block.blockedUntil) < Date.now();
  const blockSub = blocked
    ? (pastAnchor
        ? t('sidebar.block.likelyLifted')
        : block.userMsg
          ? t('sidebar.block.metaReports', { msg: block.userMsg })
          : t('sidebar.block.reported', { date: new Date(block.recordedAt).toLocaleString(dateLocale(), { dateStyle: 'short', timeStyle: 'short' }) }))
    : null;

  const metaLive = meta?.live;
  // The Meta lane can be deliberately PAUSED (kill switch) independent of a 368
  // action-block: a hard block (err) still wins, but an otherwise-healthy lane
  // that is paused reads amber with an explicit "Lane paused" sub-line.
  const metaPaused = Boolean(meta?.paused);
  const metaTone = !meta ? 'off' : blocked ? 'err' : !meta.configured ? 'err' : metaPaused ? 'warn' : metaLive?.ok === false ? 'err' : 'ok';
  const metaSub = !meta
    ? t('sidebar.noData')
    : blocked
      ? blockSub
      : metaPaused
        ? t('sidebar.lanePaused', { reason: meta.pauseReason || t('sidebar.stoppedManually') })
        : liveSub(t, metaLive, meta.configured ? t('sidebar.pageId', { id: meta.pageId }) : t('sidebar.notConfigured'), meta.configured);

  const liLive = li?.live;
  const liExpSoon = li?.authenticated && li.tokenExpiresAt && (Date.parse(li.tokenExpiresAt) - Date.now()) < 7 * 24 * 3600 * 1000;
  const liTone = !li ? 'off' : !li.authenticated ? 'warn' : liLive?.ok === false ? 'err' : liExpSoon ? 'warn' : 'ok';
  const liSub = !li
    ? t('sidebar.noData')
    : liExpSoon
      ? t('sidebar.tokenExpires', { date: new Date(li.tokenExpiresAt).toLocaleDateString(dateLocale()) })
      : liveSub(t, liLive, li.authenticated ? t('setup.status.connected') : t('sidebar.notConnected'), li.authenticated);

  const ytLive = yt?.live;
  const ytTone = !yt ? 'off' : !yt.authenticated ? 'warn' : ytLive?.ok === false ? 'err' : 'ok';
  const ytSub = !yt ? t('sidebar.noData') : liveSub(t, ytLive, yt.authenticated ? t('setup.status.connected') : t('sidebar.notConnected'), yt.authenticated);

  // X supports OAuth 2.0 (rotating token, may expire) and OAuth 1.0a (long-lived,
  // no expiry -> tokenExpiresAt null -> never "expires soon"); the linkedin-style
  // expiry tone covers both honestly.
  const xLive = x?.live;
  const xExpSoon = x?.authenticated && x.tokenExpiresAt && (Date.parse(x.tokenExpiresAt) - Date.now()) < 7 * 24 * 3600 * 1000;
  const xTone = !x ? 'off' : !x.authenticated ? 'warn' : xLive?.ok === false ? 'err' : xExpSoon ? 'warn' : 'ok';
  const xSub = !x
    ? t('sidebar.noData')
    : xExpSoon
      ? t('sidebar.tokenExpires', { date: new Date(x.tokenExpiresAt).toLocaleDateString(dateLocale()) })
      : liveSub(t, xLive, x.authenticated ? t('setup.status.connected') : t('sidebar.notConnected'), x.authenticated);

  const schedulerRunning = Boolean(accounts?.scheduler?.running);
  // Surface the last sweep so an EMPTY sweep (nothing was due) is still visible
  // proof the scheduler ran - otherwise an idle "Aktiv" looks indistinguishable
  // from a wedged loop. fmtTime keeps it readable in the narrow sidebar column.
  const schedulerLastRun = accounts?.scheduler?.lastRun;

  // Delivery (item 11): the row reflects how the ACTIVE client publishes, not the raw
  // local tick. When the active brand is cloud-managed, the local 60s loop is NOT firing
  // it (the cloud is), so "Aktiv (60s-Zyklus)" would misread as local publishing - we show
  // "Cloud · rund um die Uhr" instead. The local loop still runs for reconciliation + other
  // brands, so for a local active client we keep the scheduler label + start/stop control.
  const { data: cloud } = useCloud();
  const cloudConnected = Boolean(cloud?.workspaceId && cloud?.apiKey?.present);
  const { data: cloudClientsData } = useCloudClients(cloudConnected);
  const activeOnCloud = cloudConnected && Boolean(cloud?.enabled) && ((cloudClientsData?.clients) || []).find((c) => c.active)?.alwaysOn === true;
  const deliveryLocalState = schedulerRunning ? t('sidebar.delivery.localActive') : t('sidebar.delivery.localPaused');
  const deliveryLocalSub = schedulerLastRun
    ? `${deliveryLocalState} · ${t('settings.lastRun', { value: fmtTime(schedulerLastRun) })}`
    : deliveryLocalState;

  return (
    <aside className="glass-panel z-10 flex w-60 shrink-0 flex-col gap-5 rounded-2xl p-4">
      <div>
        <p className="font-display text-lg font-bold text-brand dark:text-brand-light">pendpost</p>
        <p className="font-display text-xs text-zinc-500 dark:text-zinc-400">{t('sidebar.tagline')}</p>
      </div>

      {/* Multi-client switcher: the first thing the eye lands on, so the active
          client is unmistakable (anti-goal: acting on the wrong client). */}
      <ClientSwitcher onManage={() => onNavigate('clients')} />

      {/* Primary action: always one click away. The tooltip surfaces the
          otherwise-undiscoverable Cmd-K palette; the kbd chip echoes it inline. */}
      <Tip label={t('sidebar.commandPalette')}>
        <button
          type="button"
          onClick={onNew}
          className="flex items-center justify-center gap-1.5 rounded-xl bg-brand px-3 py-2.5 text-sm font-bold text-white shadow-lg shadow-brand/20 transition hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-brand-light dark:text-zinc-900"
        >
          <Plus size={16} aria-hidden="true" />
          <span className="flex-1 text-center">{t('composer.newPost')}</span>
          <kbd className="rounded-md bg-white/20 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white/90 dark:bg-zinc-900/20 dark:text-zinc-900/90" aria-hidden="true">⌘K</kbd>
        </button>
      </Tip>

      {/* Nav order (item 9): the daily workflow on top - create -> approve -> see results ->
          monitor -> measure - then content + clients, then the system/config group (cloud,
          setup, settings) set off by a subtle gap rather than a divider line. */}
      <nav className="space-y-1" aria-label={t('sidebar.mainNav')}>
        <NavItem icon={CalendarDays} label={t('nav.planner')} active={activePage === 'planner'} onClick={() => onNavigate('planner')} />
        <NavItem
          icon={CheckCircle2}
          label={t('nav.approvals')}
          badge={pendingCount ? String(pendingCount) : undefined}
          badgeLabel={pendingCount ? t('sidebar.pendingBadge', { count: pendingCount }) : undefined}
          active={activePage === 'freigaben'}
          onClick={() => onNavigate('freigaben')}
        />
        <NavItem icon={Send} label={t('nav.published')} active={activePage === 'published'} onClick={() => onNavigate('published')} />
        <NavItem icon={Activity} label={t('nav.activity')} active={activePage === 'activity'} onClick={() => onNavigate('activity')} />
        <NavItem icon={BarChart3} label={t('nav.insights')} active={activePage === 'insights'} onClick={() => onNavigate('insights')} />
        <NavItem icon={FolderOpen} label={t('nav.assets')} active={activePage === 'assets'} onClick={() => onNavigate('assets')} />
        <NavItem icon={Users} label={t('nav.clients')} active={activePage === 'clients'} onClick={() => onNavigate('clients')} />
        <div className="pt-1" aria-hidden="true" />
        {/* Managed cloud: an OPTIONAL paid always-on runtime on top of the free
            self-host core. The nav item is always present; the page itself gates
            on the server's `enabled` flag (off by default). */}
        <NavItem icon={Cloud} label={t('nav.cloud')} active={activePage === 'cloud'} onClick={() => onNavigate('cloud')} />
        {/* Setup nav with a calm "incomplete (N)" reflection: only when the
            server's setup signal is explicitly NOT ready. Skipped platforms are
            already excluded from the count server-side, so an all-skipped pendpost
            reads ready and shows no badge. */}
        <NavItem
          icon={Wrench}
          label={t('nav.setup')}
          badge={setupReady === false && setupIncomplete > 0 ? String(setupIncomplete) : undefined}
          badgeLabel={setupReady === false && setupIncomplete > 0 ? t('sidebar.setupBadge', { count: setupIncomplete }) : undefined}
          active={activePage === 'setup'}
          onClick={() => onNavigate('setup')}
        />
        <NavItem icon={Settings} label={t('nav.settings')} active={activePage === 'settings'} onClick={() => onNavigate('settings')} />
      </nav>

      {/* Ops scent (UX-03): what happens next + what needs attention - both clickable. */}
      <div className="space-y-2">
        {nextPost ? (
          <button
            type="button"
            onClick={() => onOpenPost(nextPost)}
            aria-label={t('sidebar.nextPostAria', {
              when: fmtFull(nextPost.scheduledAt),
              type: t(`type.${nextPost.type}`),
              title: nextPost.title || nextPost.caption?.split('\n')[0] || t(`type.${nextPost.type}`),
            })}
            className={`group flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition hover:ring-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${INNER_SURFACE}`}
          >
            <div className="min-w-0 flex-1">
              <p className={EYEBROW}>{t('sidebar.nextPost')}</p>
              <p className="truncate text-xs font-bold">
                {fmtDayShort(new Date(nextPost.scheduledAt))} {fmtTime(nextPost.scheduledAt)} · {t(`type.${nextPost.type}`)}
              </p>
              <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                {nextPost.title || nextPost.caption?.split('\n')[0] || t(`type.${nextPost.type}`)}
              </p>
            </div>
            <ChevronRight size={14} className="shrink-0 text-zinc-400 transition group-hover:translate-x-0.5" aria-hidden="true" />
          </button>
        ) : null}
        {overdueCount > 0 ? (
          <button
            type="button"
            onClick={onShowOverdue}
            className="group flex w-full items-center gap-2 rounded-xl bg-red-500/10 px-3 py-2 text-left ring-1 ring-red-500/40 transition hover:bg-red-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
          >
            {/* Live "needs attention" ping so overdue posts are impossible to miss
                after the Mac was asleep/offline - the scheduler auto-catches up, but
                this makes the catch-up visible and one click from publishing. */}
            <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500/70" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-red-700 dark:text-red-300">{t('sidebar.overdue', { count: overdueCount })}</p>
              <p className="text-[11px] text-red-700/80 dark:text-red-300/80">{t('sidebar.overdueHint')}</p>
            </div>
            <ChevronRight size={14} className="shrink-0 text-red-500 transition group-hover:translate-x-0.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="mt-auto space-y-2">
        <div className="flex items-center justify-between px-1">
          <p className={EYEBROW}>{t('published.accounts')}</p>
          {accounts ? <RecheckButton /> : null}
        </div>
        {/* Accounts as compact brand chips (item 10): logo + status dot + hover detail,
            no always-on status line. Click a chip to open Setup, where any reconnect /
            clear-block action lives. Healthy = logo + emerald dot; attention = amber/red. */}
        <div className="flex flex-wrap items-center gap-0.5 px-1">
          <span className="flex items-center">
            <AccountChip icons={[PLATFORM_META.facebook, PLATFORM_META.instagram]} tone={metaTone} title="Facebook + Instagram" status={metaSub} onClick={() => onNavigate('setup')} />
            {blocked ? <MetaBlockAction /> : null}
          </span>
          <span className="flex items-center">
            <AccountChip icons={[PLATFORM_META.linkedin]} tone={liTone} title="LinkedIn" status={liSub} onClick={() => onNavigate('setup')} />
            {li && liTone !== 'ok' ? <TokenAction authenticated={li.authenticated} refreshable authCommand="node scripts/linkedin-social.mjs auth" /> : null}
          </span>
          <span className="flex items-center">
            <AccountChip icons={[PLATFORM_META.youtube]} tone={ytTone} title="YouTube" status={ytSub} onClick={() => onNavigate('setup')} />
            {yt && !yt.authenticated ? <TokenAction authenticated={false} authCommand="node scripts/yt-social.mjs auth" /> : null}
          </span>
          <span className="flex items-center">
            <AccountChip icons={[PLATFORM_META.x]} tone={xTone} title="X" status={xSub} onClick={() => onNavigate('setup')} />
            {x && !x.authenticated ? <TokenAction authenticated={false} authCommand="node scripts/x-social.mjs auth" /> : null}
          </span>
        </div>
        {/* Delivery (item 11): cloud-aware. A cloud-managed active client shows a calm 24/7
            row (no local toggle); otherwise the local scheduler label + start/stop control. */}
        {activeOnCloud ? (
          <div className={`flex items-center gap-2 rounded-xl px-3 py-2 ${INNER_SURFACE}`}>
            <Cloud size={15} className="shrink-0 text-brand dark:text-brand-light" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-bold leading-tight">{t('sidebar.delivery.title')}</p>
              <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">{t('sidebar.delivery.cloud')}</p>
            </div>
          </div>
        ) : (
          <div className={`flex items-center gap-2 rounded-xl px-3 py-2 ${INNER_SURFACE}`}>
            <Monitor size={15} className={`shrink-0 ${schedulerRunning ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400 dark:text-zinc-500'}`} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-bold leading-tight">{t('sidebar.delivery.title')}</p>
              <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">{deliveryLocalSub}</p>
            </div>
            {accounts ? <SchedulerToggle running={schedulerRunning} setupReady={setupReady} /> : null}
          </div>
        )}
        <NavItem icon={LifeBuoy} label={t('feedback.nav')} onClick={() => setShowFeedback(true)} />
      </div>

      {showFeedback ? <FeedbackDialog onClose={() => setShowFeedback(false)} /> : null}
    </aside>
  );
}
