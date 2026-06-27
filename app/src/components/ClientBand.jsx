import { useT } from '../lib/i18n.js';
import { clientAccent, parseHex, bestContrastOn, DEFAULT_ACCENT } from '../lib/theme.js';
import { EYEBROW } from './ui.jsx';
import { ClientAvatar } from './ClientSwitcher.jsx';

// B4 — always-on per-client signage. A small, READ-ONLY band that names the
// active client (logo/monogram + displayName) on its accent tint, present in the
// main page header and inside the Composer / PostDetail overlay headers (overlays
// cover the sidebar, so the sidebar ClientSwitcher is contextually distant there).
//
// This is signage, NOT a control: switching the active client stays in the sidebar
// ClientSwitcher and the Cmd-K palette. The band must never imply a wrong client -
// with no active client (or an unreadable registry) it degrades to a neutral
// "no client selected" pill and renders no name at all.
//
// Text on the accent uses the contrast-safe foreground (bestContrastOn), so a
// low-luminance accent still passes AA / jest-axe (anti-slop: single color,
// font-bold max, no all-caps prose; the eyebrow micro-label is a tiny
// sentence-case label, matching the sidebar switcher sublabel).
export default function ClientBand({ client, className = '' }) {
  const t = useT();

  // No active client / registry-error: neutral state. Never tints, never names a
  // client - a wrong-client implication is the one thing this band must not do.
  if (!client) {
    return (
      <span
        role="group"
        aria-label={t('clientBand.noClient')}
        className={`inline-flex h-8 shrink-0 items-center gap-2 rounded-xl bg-zinc-200/60 px-2.5 dark:bg-zinc-800/60 ${className}`}
      >
        <span aria-hidden="true" className={EYEBROW}>
          {t('clientBand.label')}
        </span>
        <span aria-hidden="true" className="text-sm font-bold text-zinc-500 dark:text-zinc-400">{t('clientBand.noClient')}</span>
      </span>
    );
  }

  const accent = clientAccent(client) || DEFAULT_ACCENT;
  const fg = bestContrastOn(parseHex(accent) || parseHex(DEFAULT_ACCENT)).fg;

  return (
    <span
      role="group"
      aria-label={t('clientBand.aria', { name: client.displayName })}
      className={`inline-flex h-8 shrink-0 items-center gap-2 rounded-xl px-2.5 ${className}`}
      style={{ backgroundColor: accent, color: fg }}
    >
      <ClientAvatar client={client} size={20} />
      <span aria-hidden="true" className="flex items-center gap-1.5 leading-none">
        {/* The "active client" micro-label drops below lg so the header stays on
            one line on narrow widths; the avatar + name still identify the client. */}
        <span className="hidden text-[11px] font-bold tracking-tight lg:inline">{t('clientBand.label')}</span>
        <span className="max-w-[14ch] truncate text-sm font-bold" title={client.displayName}>{client.displayName}</span>
      </span>
    </span>
  );
}
