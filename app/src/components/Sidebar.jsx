import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Activity, BarChart3, CheckCircle2, Play, Square, Plus, Settings, ChevronRight, ChevronDown, Clock, FolderOpen, Users, Send, Wrench, LifeBuoy, Cloud, Monitor, CornerUpLeft } from 'lucide-react';
import { setSchedulerRunning } from '../lib/api.js';
import { useCloud, useCloudClients } from '../lib/cloud.js';
import { fmtTime, fmtDayShort, fmtFull, visiblePlatforms } from '../lib/format.js';
import { useT } from '../lib/i18n.js';
import { INNER_SURFACE, PLATFORM_META } from './ui.jsx';
import ClientSwitcher from './ClientSwitcher.jsx';
import { Popover, PopoverTrigger, PopoverContent, PopoverClose } from './ui/Popover.jsx';
import { Tip } from './ui/Tooltip.jsx';
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

function HealthDot({ tone, className = 'mt-1' }) {
  const cls = tone === 'ok' ? 'bg-emerald-500' : tone === 'warn' ? 'bg-amber-500' : tone === 'err' ? 'bg-red-500' : 'bg-zinc-400';
  return <span className={`${className} h-2 w-2 shrink-0 rounded-full ${cls}`} aria-hidden="true" />;
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
      className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-1.5 text-left text-sm focus-visible:ring-2 focus-visible:ring-brand ${cls}`}
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

export default function Sidebar({ accounts, posting, pendingCount, nextPost, overdueCount, setupReady, setupIncomplete, activePage, open, onNavigate, onNew, onNewThread, onOpenPost, onShowOverdue }) {
  const t = useT();
  const [showFeedback, setShowFeedback] = useState(false);
  // Show only the relevant logos: the same connected+enabled+not-skipped rule the
  // dashboard uses (lib/format.js). The set holds DISPLAY ids (facebook/instagram
  // separately), so a chip renders only when its id is in `visible`.
  const visible = new Set(visiblePlatforms(accounts, posting));
  const meta = accounts?.meta;
  const li = accounts?.linkedin;
  const yt = accounts?.youtube;
  const x = accounts?.x;
  const tg = accounts?.telegram;
  const dc = accounts?.discord;
  const rd = accounts?.reddit;
  const pin = accounts?.pinterest;
  const tk = accounts?.tiktok;
  const ma = accounts?.mastodon;
  const wp = accounts?.wordpress;
  const gh = accounts?.ghost;
  const no = accounts?.nostr;
  const gb = accounts?.gbp;
  const block = meta?.block;
  const blocked = Boolean(block?.tracked && block.blockedUntil);

  const metaLive = meta?.live;
  // The Meta lane can be deliberately PAUSED (kill switch) independent of a 368
  // action-block: a hard block (err) still wins, but an otherwise-healthy lane
  // that is paused reads amber.
  const metaPaused = Boolean(meta?.paused);
  const metaTone = !meta ? 'off' : blocked ? 'err' : !meta.configured ? 'err' : metaPaused ? 'warn' : metaLive?.ok === false ? 'err' : 'ok';

  const liExpSoon = li?.authenticated && li.tokenExpiresAt && (Date.parse(li.tokenExpiresAt) - Date.now()) < 7 * 24 * 3600 * 1000;
  const liTone = !li ? 'off' : !li.authenticated ? 'warn' : li.live?.ok === false ? 'err' : liExpSoon ? 'warn' : 'ok';

  const ytTone = !yt ? 'off' : !yt.authenticated ? 'warn' : yt.live?.ok === false ? 'err' : 'ok';

  // X supports OAuth 2.0 (rotating token, may expire) and OAuth 1.0a (long-lived,
  // no expiry -> tokenExpiresAt null -> never "expires soon"); the linkedin-style
  // expiry tone covers both honestly.
  const xExpSoon = x?.authenticated && x.tokenExpiresAt && (Date.parse(x.tokenExpiresAt) - Date.now()) < 7 * 24 * 3600 * 1000;
  const xTone = !x ? 'off' : !x.authenticated ? 'warn' : x.live?.ok === false ? 'err' : xExpSoon ? 'warn' : 'ok';

  // Telegram + Discord + the wave-2 static lanes + OAuth GBP: the tone is simply
  // off / not-connected / live-failed / ok. Reddit accepts script-app creds, so
  // its connection flag reads authenticated OR configured.
  const tgTone = !tg ? 'off' : !tg.authenticated ? 'warn' : tg.live?.ok === false ? 'err' : 'ok';
  const dcTone = !dc ? 'off' : !dc.authenticated ? 'warn' : dc.live?.ok === false ? 'err' : 'ok';
  const rdConnected = Boolean(rd?.authenticated || rd?.configured);
  const rdTone = !rd ? 'off' : !rdConnected ? 'warn' : rd.live?.ok === false ? 'err' : 'ok';
  const pinTone = !pin ? 'off' : !pin.authenticated ? 'warn' : pin.live?.ok === false ? 'err' : 'ok';
  const tkTone = !tk ? 'off' : !tk.authenticated ? 'warn' : tk.live?.ok === false ? 'err' : 'ok';
  const maTone = !ma ? 'off' : !ma.authenticated ? 'warn' : ma.live?.ok === false ? 'err' : 'ok';
  const wpTone = !wp ? 'off' : !wp.authenticated ? 'warn' : wp.live?.ok === false ? 'err' : 'ok';
  const ghTone = !gh ? 'off' : !gh.authenticated ? 'warn' : gh.live?.ok === false ? 'err' : 'ok';
  const noTone = !no ? 'off' : !no.authenticated ? 'warn' : no.live?.ok === false ? 'err' : 'ok';
  const gbTone = !gb ? 'off' : !gb.authenticated ? 'warn' : gb.live?.ok === false ? 'err' : 'ok';

  // Connected lanes as data: one connected lane == one entry, so Meta folds fb+ig
  // into a single entry (primary glyph = the first visible of the two). The rail
  // shows the roll-up dot + glyph cluster; every per-lane detail and reconnect
  // affordance lives on the Setup page the row links to.
  const metaGlyphs = [];
  if (visible.has('facebook')) metaGlyphs.push(PLATFORM_META.facebook);
  if (visible.has('instagram')) metaGlyphs.push(PLATFORM_META.instagram);
  const lanes = [
    metaGlyphs.length ? { id: 'meta', icon: metaGlyphs[0], tone: metaTone } : null,
    visible.has('linkedin') ? { id: 'linkedin', icon: PLATFORM_META.linkedin, tone: liTone } : null,
    visible.has('youtube') ? { id: 'youtube', icon: PLATFORM_META.youtube, tone: ytTone } : null,
    visible.has('x') ? { id: 'x', icon: PLATFORM_META.x, tone: xTone } : null,
    visible.has('telegram') ? { id: 'telegram', icon: PLATFORM_META.telegram, tone: tgTone } : null,
    visible.has('discord') ? { id: 'discord', icon: PLATFORM_META.discord, tone: dcTone } : null,
    visible.has('reddit') ? { id: 'reddit', icon: PLATFORM_META.reddit, tone: rdTone } : null,
    visible.has('pinterest') ? { id: 'pinterest', icon: PLATFORM_META.pinterest, tone: pinTone } : null,
    visible.has('tiktok') ? { id: 'tiktok', icon: PLATFORM_META.tiktok, tone: tkTone } : null,
    visible.has('mastodon') ? { id: 'mastodon', icon: PLATFORM_META.mastodon, tone: maTone } : null,
    visible.has('wordpress') ? { id: 'wordpress', icon: PLATFORM_META.wordpress, tone: wpTone } : null,
    visible.has('ghost') ? { id: 'ghost', icon: PLATFORM_META.ghost, tone: ghTone } : null,
    visible.has('nostr') ? { id: 'nostr', icon: PLATFORM_META.nostr, tone: noTone } : null,
    visible.has('gbp') ? { id: 'gbp', icon: PLATFORM_META.gbp, tone: gbTone } : null,
  ].filter(Boolean);
  const accountCount = lanes.length;
  const accountsRollup = lanes.some((l) => l.tone === 'err') ? 'err' : lanes.some((l) => l.tone === 'warn') ? 'warn' : lanes.some((l) => l.tone === 'ok') ? 'ok' : 'off';

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
    // Below lg this is an off-canvas drawer: fixed, hidden (translated + invisible
    // so it stays out of the tab order) until `open`, then slid in with a scrim.
    // At lg+ every narrow utility is reset to the original permanent rail — no
    // visual change on desktop. `open` is only ever true on narrow, so the dialog
    // semantics never attach to the desktop rail.
    <aside
      id="app-sidebar"
      role={open ? 'dialog' : undefined}
      aria-modal={open ? 'true' : undefined}
      aria-label={open ? t('sidebar.mainNav') : undefined}
      className={`glass-panel fixed inset-y-4 left-4 z-50 flex w-60 shrink-0 flex-col gap-3 overflow-y-auto rounded-2xl p-4 transition-transform duration-200 motion-reduce:transition-none lg:static lg:inset-auto lg:left-auto lg:z-10 lg:translate-x-0 lg:overflow-visible lg:transition-none ${open ? 'translate-x-0' : 'invisible -translate-x-[calc(100%+1.5rem)] lg:visible'}`}
    >
      <div>
        <p className="font-display text-lg font-bold text-brand dark:text-brand-light">pendpost</p>
        <p className="font-display text-xs text-zinc-500 dark:text-zinc-400">{t('sidebar.tagline')}</p>
      </div>

      {/* Multi-client switcher: the first thing the eye lands on, so the active
          client is unmistakable (anti-goal: acting on the wrong client). */}
      <ClientSwitcher onManage={() => onNavigate('clients')} />

      {/* Primary action: always one click away. The tooltip surfaces the
          otherwise-undiscoverable ⌘K palette (no inline kbd chip - it cost the
          width that wrapped the German label onto two lines). */}
      {/* Split primary action: the main click stays "New post" (one click away);
          the caret opens a small menu to start a New post or a New X thread. */}
      <div className="flex items-stretch gap-1">
        <Tip label={t('sidebar.commandPalette')}>
          <button
            type="button"
            onClick={onNew}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-l-xl rounded-r-md bg-brand px-3 py-2.5 text-sm font-bold text-white shadow-lg shadow-brand/20 transition hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-brand-light dark:text-zinc-900"
          >
            <Plus size={16} aria-hidden="true" />
            <span className="flex-1 whitespace-nowrap text-center">{t('composer.newPost')}</span>
          </button>
        </Tip>
        <Popover>
          <Tip label={t('sidebar.newMenu')}>
            <PopoverTrigger
              className="grid place-items-center rounded-l-md rounded-r-xl bg-brand px-2 text-white shadow-lg shadow-brand/20 transition hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-brand-light dark:text-zinc-900"
              aria-label={t('sidebar.newMenu')}
            >
              <ChevronDown size={16} aria-hidden="true" />
            </PopoverTrigger>
          </Tip>
          <PopoverContent align="end" className="w-48">
            <PopoverClose asChild>
              <button type="button" onClick={onNew} className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm font-semibold transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60">
                <Plus size={15} aria-hidden="true" /> {t('composer.newPost')}
              </button>
            </PopoverClose>
            <PopoverClose asChild>
              <button type="button" onClick={() => onNewThread?.()} className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm font-semibold transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60">
                <CornerUpLeft size={15} aria-hidden="true" /> {t('threadComposer.new')}
              </button>
            </PopoverClose>
          </PopoverContent>
        </Popover>
      </div>

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
        {nextPost ? (() => {
          // Platform glyph + a one-line content preview (title, else the caption's
          // first line, else the type) - the same computation the aria-label uses.
          const nextMeta = PLATFORM_META[nextPost.platforms?.[0]];
          const preview = nextPost.title || nextPost.caption?.split('\n')[0] || t(`type.${nextPost.type}`);
          return (
            <button
              type="button"
              onClick={() => onOpenPost(nextPost)}
              aria-label={t('sidebar.nextPostAria', {
                when: fmtFull(nextPost.scheduledAt),
                type: t(`type.${nextPost.type}`),
                title: preview,
              })}
              className={`group flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition hover:ring-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${INNER_SURFACE}`}
            >
              {nextMeta ? (
                <nextMeta.Icon size={14} className={`shrink-0 ${nextMeta.color}`} aria-hidden="true" />
              ) : (
                <Clock size={15} className="shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
              )}
              <p className="min-w-0 flex-1 truncate text-xs">
                <span className="font-bold">{fmtDayShort(new Date(nextPost.scheduledAt))} {fmtTime(nextPost.scheduledAt)}</span>
                <span className="text-zinc-500 dark:text-zinc-400"> · {preview}</span>
              </p>
              <ChevronRight size={14} className="shrink-0 text-zinc-400 transition group-hover:translate-x-0.5" aria-hidden="true" />
            </button>
          );
        })() : null}
        {overdueCount > 0 ? (
          <Tip label={t('sidebar.overdueHint')}>
            <button
              type="button"
              onClick={onShowOverdue}
              aria-label={`${t('sidebar.overdue', { count: overdueCount })} - ${t('sidebar.overdueHint')}`}
              className="group flex w-full items-center gap-2 rounded-xl bg-red-500/10 px-3 py-2 text-left ring-1 ring-red-500/40 transition hover:bg-red-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
            >
              {/* Live "needs attention" ping so overdue posts are impossible to miss
                  after the Mac was asleep/offline - the scheduler auto-catches up, but
                  this makes the catch-up visible and one click from publishing. The
                  "review and publish" hint lives in the tooltip + aria-label. */}
              <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500/70" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
              </span>
              <p className="min-w-0 flex-1 truncate text-xs font-bold text-red-700 dark:text-red-300">{t('sidebar.overdue', { count: overdueCount })}</p>
              <ChevronRight size={14} className="shrink-0 text-red-500 transition group-hover:translate-x-0.5" aria-hidden="true" />
            </button>
          </Tip>
        ) : null}
      </div>

      <div className="mt-auto space-y-2">
        {/* Accounts: a calm roll-up dot + a cluster of the connected platform
            glyphs, capped with +N so 15-20 platforms stay tidy. One click opens
            Setup - the single home of per-lane status + reconnect - instead of a
            second in-sidebar copy of that list. */}
        {accounts && accountCount > 0 ? (
          <Tip label={t('sidebar.accounts.openSetup')}>
            <button
              type="button"
              onClick={() => onNavigate('setup')}
              aria-label={t('sidebar.accounts.openSetup')}
              className={`group flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition hover:ring-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${INNER_SURFACE}`}
            >
              <HealthDot tone={accountsRollup} className="" />
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {lanes.slice(0, 5).map((l) => {
                  const Glyph = l.icon.Icon;
                  return <Glyph key={l.id} size={15} className={`shrink-0 ${l.icon.color}`} aria-hidden="true" />;
                })}
                {accountCount > 5 ? <span className="text-[11px] font-bold tabular-nums text-zinc-400 dark:text-zinc-500">+{accountCount - 5}</span> : null}
              </span>
              <ChevronRight size={14} className="shrink-0 text-zinc-400 transition group-hover:translate-x-0.5" aria-hidden="true" />
            </button>
          </Tip>
        ) : null}
        {/* Delivery (item 11): the sidebar row exists only for LOCAL delivery,
            where it carries the scheduler start/stop control. A cloud-managed
            client's round-the-clock status is already asserted by the header
            ConnectionStatus glyph, so the sidebar no longer restates it here. */}
        {activeOnCloud ? null : (
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
