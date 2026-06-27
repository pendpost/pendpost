import { useState } from 'react';
import { ChevronsUpDown, Check, Settings2, Archive, Ban, Loader2, AlertTriangle } from 'lucide-react';
import { useActiveClient, useSetActiveClient } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { clientAccent, monogram, DEFAULT_ACCENT } from '../lib/theme.js';
import { Popover, PopoverTrigger, PopoverContent } from './ui/Popover.jsx';
import { Skeleton, INNER_SURFACE, EYEBROW } from './ui.jsx';

// Client logo, or a monogram tile on the client accent when logo is null.
// Logos are served client-scoped via /media (traversal-rejected server-side).
function ClientAvatar({ client, size = 28 }) {
  const accent = clientAccent(client) || DEFAULT_ACCENT;
  const url = client?.logo?.url || (client?.logo?.path ? `/media/${client.logo.path}` : null);
  const style = { width: size, height: size };
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return <img src={url} alt="" onError={() => setFailed(true)} className="shrink-0 rounded-lg object-cover" style={style} />;
  }
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-lg text-[11px] font-bold text-white"
      style={{ ...style, backgroundColor: accent }}
    >
      {monogram(client?.displayName)}
    </span>
  );
}

// B5 health signal: a non-color action-blocked indicator (icon + sr-only text),
// shown only when a client's Meta-368 breaker is armed. Icon carries meaning, not
// color alone (anti-slop / a11y). Booleans-only roll-up - no blockedUntil/reason.
function ClientHealthDot({ client, t }) {
  if (!client?.actionBlocked) return null;
  return (
    <span className="inline-flex shrink-0 items-center text-zinc-600 dark:text-zinc-300" title={t('clientSwitcher.health.blocked')}>
      <Ban size={13} aria-hidden="true" />
      <span className="sr-only">{t('clientSwitcher.health.blocked')}</span>
    </span>
  );
}

// The most safety-critical control: the active client must be unmistakable so
// the operator never acts on the wrong client. Three redundant non-color signals
// (name + logo, "active client" sublabel, browser title set in App.jsx) plus a
// supplementary 4px accent rail.
export default function ClientSwitcher({ onManage }) {
  const t = useT();
  const { activeClient, data, isLoading, isError, error } = useActiveClient();
  const setActive = useSetActiveClient();
  const [open, setOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [switching, setSwitching] = useState(null); // id being switched to
  const [status, setStatus] = useState(null); // { tone: 'ok' | 'error', msg } announced via live region

  if (isLoading) {
    return (
      <div className={`flex items-center gap-2.5 rounded-xl p-2 ${INNER_SURFACE}`}>
        <Skeleton className="h-7 w-7 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-1">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-2 w-16" />
        </div>
      </div>
    );
  }

  // The registry is corrupt (manifest_error): surface a blocking banner, never
  // silently pick a client. Mirrors the campaign-manifest error contract.
  if (isError || data?.error) {
    return (
      <div role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-[11px] font-bold text-red-700 ring-1 ring-red-500/30 dark:text-red-300">
        {t('clientSwitcher.registryUnreadable')}
        <span className="block font-medium text-red-700/80 dark:text-red-300/80">
          {data?.error?.message || error?.message || t('clientSwitcher.registryFallback')}
        </span>
      </div>
    );
  }

  const clients = data?.clients || [];
  const active = activeClient || clients[0] || null;
  const activeAccent = clientAccent(active) || DEFAULT_ACCENT;
  // Mandate H: once a real project exists, an EMPTY "default" workspace is dormant
  // (server-derived isDormantDefault). Tuck it out of the primary picker - but
  // never the one currently active, and keep it switchable under the reveal so no
  // data is ever stranded. The registry is untouched; this is presentation only.
  const isHiddenDefault = (c) => Boolean(c.isDormantDefault) && c.id !== data?.activeClientId;
  const listed = clients.filter((c) => (c.status || 'active') === 'active' && !isHiddenDefault(c));
  const tucked = clients.filter((c) => c.status === 'archived' || isHiddenDefault(c));

  const pick = async (id) => {
    if (id === data?.activeClientId) {
      setOpen(false);
      return;
    }
    const target = clients.find((c) => c.id === id);
    setSwitching(id);
    setStatus(null);
    try {
      await setActive(id);
      setStatus({ tone: 'ok', msg: t('clientSwitcher.switched', { name: target?.displayName || t('clientSwitcher.noClient') }) });
      setOpen(false);
    } catch {
      // The switch failed: the operator is still on the prior client. Keep the
      // popover open and surface the failure (role=alert) so they never believe
      // they re-scoped when they did not - the most safety-critical control.
      setStatus({ tone: 'error', msg: t('clientSwitcher.switchFailed', { name: target?.displayName || t('clientSwitcher.noClient') }) });
    } finally {
      setSwitching(null);
    }
  };

  const goManage = () => {
    setOpen(false);
    if (onManage) onManage();
    else window.location.hash = '#clients';
  };

  return (
    <Popover open={open} onOpenChange={(o) => { if (o) setStatus(null); setOpen(o); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('clientSwitcher.aria.switch', { name: active?.displayName || t('clientSwitcher.noClient') })}
          className={`relative flex w-full items-center gap-2.5 overflow-hidden rounded-xl py-2 pl-3 pr-2 text-left transition hover:bg-zinc-200/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-800/50 ${INNER_SURFACE}`}
        >
          {/* 4px accent rail: the supplementary, color-only signal. */}
          <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: activeAccent }} />
          <ClientAvatar client={active} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm font-bold leading-tight">{active?.displayName || t('clientSwitcher.noClient')}</span>
              <ClientHealthDot client={active} t={t} />
            </span>
            <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{t('clientSwitcher.activeSublabel')}</span>
          </span>
          <ChevronsUpDown size={15} className="shrink-0 text-zinc-400" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60" aria-labelledby="clients-switcher-heading">
        <p id="clients-switcher-heading" className={`px-2 pb-1 pt-0.5 ${EYEBROW}`}>{t('clientSwitcher.heading')}</p>
        {status?.tone === 'error' ? (
          <p className="mb-1 flex items-start gap-1.5 rounded-lg bg-red-500/10 px-2 py-1.5 text-[11px] font-bold text-red-700 dark:text-red-300">
            <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden="true" />
            <span>{status.msg}</span>
          </p>
        ) : null}
        <ul className="space-y-0.5" role="list">
          {listed.map((c) => {
            const isActive = c.id === data?.activeClientId;
            const isBusy = c.id === switching;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => pick(c.id)}
                  disabled={Boolean(switching)}
                  aria-busy={isBusy || undefined}
                  aria-current={isActive ? 'true' : undefined}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60 dark:hover:bg-zinc-700/60"
                >
                  <ClientAvatar client={c} size={22} />
                  <span className="min-w-0 flex-1 truncate text-sm font-bold">{c.displayName}</span>
                  <ClientHealthDot client={c} t={t} />
                  {isBusy ? (
                    <Loader2 size={15} className="shrink-0 animate-spin text-zinc-400" aria-label={t('clientSwitcher.switching')} />
                  ) : isActive ? (
                    <Check size={15} className="shrink-0 text-brand dark:text-brand-light" aria-label={t('clientSwitcher.active')} />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>

        {tucked.length ? (
          <>
            <button
              type="button"
              onClick={() => setShowArchived((s) => !s)}
              aria-expanded={showArchived}
              aria-controls="client-switcher-archived"
              className="mt-1 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11px] font-bold text-zinc-500 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:bg-zinc-700/60"
            >
              <Archive size={12} aria-hidden="true" />
              {showArchived ? t('clientSwitcher.hideArchived') : t('clientSwitcher.showArchived', { count: tucked.length })}
            </button>
            {showArchived ? (
              <ul id="client-switcher-archived" className="space-y-0.5" role="list">
                {tucked.map((c) => {
                  const dormant = c.status !== 'archived';
                  const isBusy = c.id === switching;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => pick(c.id)}
                        disabled={Boolean(switching)}
                        aria-busy={isBusy || undefined}
                        title={dormant ? t('clientSwitcher.defaultTip') : undefined}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60 dark:hover:bg-zinc-700/60"
                      >
                        <ClientAvatar client={c} size={22} />
                        <span className="min-w-0 flex-1 truncate text-sm">{c.displayName}</span>
                        <ClientHealthDot client={c} t={t} />
                        {isBusy ? (
                          <Loader2 size={15} className="shrink-0 animate-spin text-zinc-400" aria-label={t('clientSwitcher.switching')} />
                        ) : (
                          <span className="shrink-0 text-[10px] font-bold tracking-tight text-zinc-400">
                            {dormant ? t('clientSwitcher.defaultHint') : t('clientSwitcher.archived')}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </>
        ) : null}

        <div className="my-1 h-px bg-zinc-200/70 dark:bg-zinc-700/70" aria-hidden="true" />
        <button
          type="button"
          onClick={goManage}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-bold text-zinc-600 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-300 dark:hover:bg-zinc-700/60"
        >
          <Settings2 size={15} aria-hidden="true" />
          {t('clientSwitcher.manage')}
        </button>
      </PopoverContent>
      {/* Live regions live outside PopoverContent so a success announcement
          survives the popover closing on a switch. Success is polite (role=status);
          a failed switch is assertive (role=alert) - the operator must learn the
          re-scope did NOT happen before acting on the prior client. */}
      <span className="sr-only" role="status" aria-live="polite">{status?.tone === 'ok' ? status.msg : ''}</span>
      <span className="sr-only" role="alert">{status?.tone === 'error' ? status.msg : ''}</span>
    </Popover>
  );
}

export { ClientAvatar };
