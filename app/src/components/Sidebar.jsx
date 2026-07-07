import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Activity, BarChart3, CheckCircle2, Play, Square, RefreshCw, ClipboardCopy, Check, Plus, Settings, ChevronRight, ChevronDown, Clock, FolderOpen, Users, Send, Wrench, LifeBuoy, Cloud, Monitor, CornerUpLeft } from 'lucide-react';
import { setSchedulerRunning, refreshLinkedinToken, clearMetaBlock, recheckHealth } from '../lib/api.js';
import { useCloud, useCloudClients } from '../lib/cloud.js';
import { fmtTime, fmtDayShort, fmtFull, dateLocale, visiblePlatforms } from '../lib/format.js';
import { useT } from '../lib/i18n.js';
import { EYEBROW, INNER_SURFACE, PLATFORM_META } from './ui.jsx';
import ClientSwitcher from './ClientSwitcher.jsx';
import { Popover, PopoverTrigger, PopoverContent, PopoverClose } from './ui/Popover.jsx';
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

export default function Sidebar({ accounts, posting, pendingCount, nextPost, overdueCount, setupReady, setupIncomplete, activePage, onNavigate, onNew, onNewThread, onOpenPost, onShowOverdue }) {
  const t = useT();
  const [showFeedback, setShowFeedback] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
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

  // Telegram + Discord: static-credential lanes (no token expiry), so the tone is
  // simply off / not-connected / live-failed / ok - the YouTube-style derivation.
  const tgLive = tg?.live;
  const tgTone = !tg ? 'off' : !tg.authenticated ? 'warn' : tgLive?.ok === false ? 'err' : 'ok';
  const tgSub = !tg ? t('sidebar.noData') : liveSub(t, tgLive, tg.authenticated ? t('setup.status.connected') : t('sidebar.notConnected'), tg.authenticated);
  const dcLive = dc?.live;
  const dcTone = !dc ? 'off' : !dc.authenticated ? 'warn' : dcLive?.ok === false ? 'err' : 'ok';
  const dcSub = !dc ? t('sidebar.noData') : liveSub(t, dcLive, dc.authenticated ? t('setup.status.connected') : t('sidebar.notConnected'), dc.authenticated);

  // Reddit / Pinterest / TikTok: the same static-lane derivation as Telegram +
  // Discord (off / not-connected / live-failed / ok). Reddit accepts script-app
  // creds, so its connection flag reads authenticated OR configured.
  const rdConnected = Boolean(rd?.authenticated || rd?.configured);
  const rdLive = rd?.live;
  const rdTone = !rd ? 'off' : !rdConnected ? 'warn' : rdLive?.ok === false ? 'err' : 'ok';
  const rdSub = !rd ? t('sidebar.noData') : liveSub(t, rdLive, rdConnected ? t('setup.status.connected') : t('sidebar.notConnected'), rdConnected);
  const pinLive = pin?.live;
  const pinTone = !pin ? 'off' : !pin.authenticated ? 'warn' : pinLive?.ok === false ? 'err' : 'ok';
  const pinSub = !pin ? t('sidebar.noData') : liveSub(t, pinLive, pin.authenticated ? t('setup.status.connected') : t('sidebar.notConnected'), pin.authenticated);
  const tkLive = tk?.live;
  const tkTone = !tk ? 'off' : !tk.authenticated ? 'warn' : tkLive?.ok === false ? 'err' : 'ok';
  const tkSub = !tk ? t('sidebar.noData') : liveSub(t, tkLive, tk.authenticated ? t('setup.status.connected') : t('sidebar.notConnected'), tk.authenticated);

  // Wave 2: Mastodon / WordPress / Ghost / Nostr are static-credential lanes and GBP
  // is an OAuth lane - all report `authenticated`, so the same off / not-connected /
  // live-failed / ok derivation as Telegram + Discord covers all five.
  const maLive = ma?.live;
  const maTone = !ma ? 'off' : !ma.authenticated ? 'warn' : maLive?.ok === false ? 'err' : 'ok';
  const maSub = !ma ? t('sidebar.noData') : liveSub(t, maLive, ma.authenticated ? t('setup.status.connected') : t('sidebar.notConnected'), ma.authenticated);
  const wpLive = wp?.live;
  const wpTone = !wp ? 'off' : !wp.authenticated ? 'warn' : wpLive?.ok === false ? 'err' : 'ok';
  const wpSub = !wp ? t('sidebar.noData') : liveSub(t, wpLive, wp.authenticated ? t('setup.status.connected') : t('sidebar.notConnected'), wp.authenticated);
  const ghLive = gh?.live;
  const ghTone = !gh ? 'off' : !gh.authenticated ? 'warn' : ghLive?.ok === false ? 'err' : 'ok';
  const ghSub = !gh ? t('sidebar.noData') : liveSub(t, ghLive, gh.authenticated ? t('setup.status.connected') : t('sidebar.notConnected'), gh.authenticated);
  const noLive = no?.live;
  const noTone = !no ? 'off' : !no.authenticated ? 'warn' : noLive?.ok === false ? 'err' : 'ok';
  const noSub = !no ? t('sidebar.noData') : liveSub(t, noLive, no.authenticated ? t('setup.status.connected') : t('sidebar.notConnected'), no.authenticated);
  const gbLive = gb?.live;
  const gbTone = !gb ? 'off' : !gb.authenticated ? 'warn' : gbLive?.ok === false ? 'err' : 'ok';
  const gbSub = !gb ? t('sidebar.noData') : liveSub(t, gbLive, gb.authenticated ? t('setup.status.connected') : t('sidebar.notConnected'), gb.authenticated);

  // Connected lanes as data (item 10): one connected lane == one row, so Meta folds
  // fb+ig into a single entry (primary glyph = the first visible of the two). Built
  // once so the rail summary (logo cluster + roll-up dot) and the detail list stay in
  // sync and scale cleanly to 15-20 platforms without per-platform JSX. Each lane's
  // `action` is the reconnect affordance, shown only in the open list when needed.
  const metaGlyphs = [];
  if (visible.has('facebook')) metaGlyphs.push(PLATFORM_META.facebook);
  if (visible.has('instagram')) metaGlyphs.push(PLATFORM_META.instagram);
  const lanes = [
    metaGlyphs.length ? { id: 'meta', icon: metaGlyphs[0], label: metaGlyphs.map((g) => g.label).join(' + '), tone: metaTone, sub: metaSub, action: blocked ? <MetaBlockAction /> : null } : null,
    visible.has('linkedin') ? { id: 'linkedin', icon: PLATFORM_META.linkedin, label: PLATFORM_META.linkedin.label, tone: liTone, sub: liSub, action: li && liTone !== 'ok' ? <TokenAction authenticated={li.authenticated} refreshable authCommand="node scripts/linkedin-social.mjs auth" /> : null } : null,
    visible.has('youtube') ? { id: 'youtube', icon: PLATFORM_META.youtube, label: PLATFORM_META.youtube.label, tone: ytTone, sub: ytSub, action: yt && !yt.authenticated ? <TokenAction authenticated={false} authCommand="node scripts/yt-social.mjs auth" /> : null } : null,
    visible.has('x') ? { id: 'x', icon: PLATFORM_META.x, label: PLATFORM_META.x.label, tone: xTone, sub: xSub, action: x && !x.authenticated ? <TokenAction authenticated={false} authCommand="node scripts/x-social.mjs auth" /> : null } : null,
    visible.has('telegram') ? { id: 'telegram', icon: PLATFORM_META.telegram, label: PLATFORM_META.telegram.label, tone: tgTone, sub: tgSub, action: tg && !tg.authenticated ? <TokenAction authenticated={false} authCommand="node scripts/telegram-social.mjs auth" /> : null } : null,
    visible.has('discord') ? { id: 'discord', icon: PLATFORM_META.discord, label: PLATFORM_META.discord.label, tone: dcTone, sub: dcSub, action: dc && !dc.authenticated ? <TokenAction authenticated={false} authCommand="node scripts/discord-social.mjs auth" /> : null } : null,
    visible.has('reddit') ? { id: 'reddit', icon: PLATFORM_META.reddit, label: PLATFORM_META.reddit.label, tone: rdTone, sub: rdSub, action: rd && !rdConnected ? <TokenAction authenticated={false} authCommand="node scripts/reddit-social.mjs auth" /> : null } : null,
    visible.has('pinterest') ? { id: 'pinterest', icon: PLATFORM_META.pinterest, label: PLATFORM_META.pinterest.label, tone: pinTone, sub: pinSub, action: pin && !pin.authenticated ? <TokenAction authenticated={false} authCommand="node scripts/pinterest-social.mjs auth" /> : null } : null,
    visible.has('tiktok') ? { id: 'tiktok', icon: PLATFORM_META.tiktok, label: PLATFORM_META.tiktok.label, tone: tkTone, sub: tkSub, action: tk && !tk.authenticated ? <TokenAction authenticated={false} authCommand="node scripts/tiktok-social.mjs auth" /> : null } : null,
    visible.has('mastodon') ? { id: 'mastodon', icon: PLATFORM_META.mastodon, label: PLATFORM_META.mastodon.label, tone: maTone, sub: maSub, action: ma && !ma.authenticated ? <TokenAction authenticated={false} authCommand="node scripts/mastodon-social.mjs auth" /> : null } : null,
    visible.has('wordpress') ? { id: 'wordpress', icon: PLATFORM_META.wordpress, label: PLATFORM_META.wordpress.label, tone: wpTone, sub: wpSub, action: wp && !wp.authenticated ? <TokenAction authenticated={false} authCommand="node scripts/wordpress-social.mjs auth" /> : null } : null,
    visible.has('ghost') ? { id: 'ghost', icon: PLATFORM_META.ghost, label: PLATFORM_META.ghost.label, tone: ghTone, sub: ghSub, action: gh && !gh.authenticated ? <TokenAction authenticated={false} authCommand="node scripts/ghost-social.mjs auth" /> : null } : null,
    visible.has('nostr') ? { id: 'nostr', icon: PLATFORM_META.nostr, label: PLATFORM_META.nostr.label, tone: noTone, sub: noSub, action: no && !no.authenticated ? <TokenAction authenticated={false} authCommand="node scripts/nostr-social.mjs auth" /> : null } : null,
    visible.has('gbp') ? { id: 'gbp', icon: PLATFORM_META.gbp, label: PLATFORM_META.gbp.label, tone: gbTone, sub: gbSub, action: gb && !gb.authenticated ? <TokenAction authenticated={false} authCommand="node scripts/gbp-social.mjs auth" /> : null } : null,
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
    <aside className="glass-panel z-10 flex w-60 shrink-0 flex-col gap-3 rounded-2xl p-4">
      <div>
        <p className="font-display text-lg font-bold text-brand dark:text-brand-light">pendpost</p>
        <p className="font-display text-xs text-zinc-500 dark:text-zinc-400">{t('sidebar.tagline')}</p>
      </div>

      {/* Multi-client switcher: the first thing the eye lands on, so the active
          client is unmistakable (anti-goal: acting on the wrong client). */}
      <ClientSwitcher onManage={() => onNavigate('clients')} />

      {/* Primary action: always one click away. The tooltip surfaces the
          otherwise-undiscoverable Cmd-K palette; the kbd chip echoes it inline. */}
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
            <span className="flex-1 text-center">{t('composer.newPost')}</span>
            <kbd className="rounded-md bg-white/20 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white/90 dark:bg-zinc-900/20 dark:text-zinc-900/90" aria-hidden="true">⌘K</kbd>
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
            <Clock size={15} className="shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
            <p className="min-w-0 flex-1 truncate text-xs font-bold">
              {fmtDayShort(new Date(nextPost.scheduledAt))} {fmtTime(nextPost.scheduledAt)} · {t(`type.${nextPost.type}`)}
            </p>
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
        {/* Accounts (item 10): the resting rail shows a calm roll-up dot + a cluster of
            the connected platform glyphs (the "collected icon"), capped with +N so 15-20
            platforms stay tidy. The full per-lane status + reconnect lives in a popover
            that floats up over the content, so opening never disturbs the rail height. */}
        {accounts && accountCount > 0 ? (
          <Popover open={accountsOpen} onOpenChange={setAccountsOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={accountsOpen ? t('sidebar.accounts.collapseAria') : t('sidebar.accounts.expandAria')}
                className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition hover:ring-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${INNER_SURFACE}`}
              >
                <HealthDot tone={accountsRollup} className="" />
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  {lanes.slice(0, 5).map((l) => {
                    const Glyph = l.icon.Icon;
                    return <Glyph key={l.id} size={15} className={`shrink-0 ${l.icon.color}`} aria-hidden="true" />;
                  })}
                  {accountCount > 5 ? <span className="text-[11px] font-bold tabular-nums text-zinc-400 dark:text-zinc-500">+{accountCount - 5}</span> : null}
                </span>
                <ChevronDown size={14} className={`shrink-0 text-zinc-400 transition ${accountsOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" sideOffset={8} className="w-[15.5rem] p-1.5" aria-label={t('sidebar.accounts.expandAria')}>
              <div className="mb-0.5 flex items-center justify-between gap-2 px-1.5">
                <p className={EYEBROW}>{t('sidebar.accounts.summary', { count: accountCount })}</p>
                {accounts ? <RecheckButton /> : null}
              </div>
              <ul className="max-h-[min(50vh,20rem)] space-y-px overflow-y-auto scrollbar-soft" role="list">
                {lanes.map((l) => {
                  const Glyph = l.icon.Icon;
                  return (
                    <li key={l.id} className="flex items-center">
                      <button
                        type="button"
                        onClick={() => { setAccountsOpen(false); onNavigate('setup'); }}
                        title={l.sub}
                        className="group flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60"
                      >
                        <Glyph size={16} className={`shrink-0 ${l.icon.color}`} aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{l.label}</span>
                        <HealthDot tone={l.tone} className="" />
                      </button>
                      {l.action}
                    </li>
                  );
                })}
              </ul>
            </PopoverContent>
          </Popover>
        ) : null}
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
