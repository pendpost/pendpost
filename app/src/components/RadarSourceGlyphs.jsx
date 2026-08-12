import { Globe, Radio, Check, Plus, Copy } from 'lucide-react';
import { radarSourceState } from '../lib/format.js';
import { PLATFORM_META } from './ui.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { useT } from '../lib/i18n.js';

// ONE source-status strip for Radar, shared by the Radar page header and the Settings
// searches card (it REPLACES both prior renderings: the header's bare glyph row and the
// "wird durchsucht · verbinden, um zu antworten" text run-on). Per source: the platform
// glyph plus a small dot - emerald = replies post from pendpost (reply-capable AND
// connected), amber = scanned only (connect to reply, or copy-paste by nature). The dot is
// never the only carrier (WCAG 1.4.1): the full sentence lives in the tooltip AND in each
// glyph's accessible name. A glyph is a button ONLY where a Studio connect path exists;
// everything else is inert - no fake affordances.
const GLYPH_META = {
  reddit: PLATFORM_META.reddit,
  hackernews: PLATFORM_META.hackernews,
  bluesky: PLATFORM_META.bluesky,
  mastodon: PLATFORM_META.mastodon,
  x: PLATFORM_META.x,
  youtube: PLATFORM_META.youtube,
  nostr: PLATFORM_META.nostr,
  web: { Icon: Globe, color: 'text-sky-500' },
};
// Sources with an in-Studio Setup card to deep-link to. Bluesky creds are .env-only and HN
// is keyless - a "connect" affordance there would be a dead end.
const SETUP_CONNECTABLE = new Set(['reddit', 'mastodon', 'x', 'youtube', 'nostr']);

// The per-glyph state. `capabilities` is the server's own table (feed.capabilities) so the
// client can never drift from lib/radar.mjs; while it has not arrived yet the dot is
// omitted rather than guessed (an honest blank beats a flashed wrong colour).
//   ready   - reply:true and the lane is connected: replies post from pendpost.
//   connect - reply:true but not connected yet: scanned, connect to reply.
//   copy    - copyDraft (hackernews): scanned, answers arrive as copy-paste drafts.
//   scan    - everything else (web): scanned only.
function glyphState(id, { capabilities, accounts, sourceStatus }) {
  const cap = capabilities?.[id];
  if (!cap) return null;
  if (cap.reply === true) {
    // Bluesky's only connect evidence is a persisted ok scan (creds are .env-only);
    // radarSourceState already folds both signals for the engine lanes.
    const scanState = radarSourceState(id, accounts, sourceStatus);
    const connected = scanState === 'scanning' || (id !== 'bluesky' && id !== 'reddit' && id !== 'mastodon' && Boolean(accounts?.[id]?.authenticated));
    return connected ? 'ready' : 'connect';
  }
  if (cap.copyDraft === true) return 'copy';
  return 'scan';
}

// The state badge is never colour-only (WCAG 1.4.1; canon "status is never colour-only"),
// mirroring Setup.jsx StatusChip: a distinct GLYPH per state carries the meaning and the
// colour only reinforces it. `scan` is the neutral baseline (nothing to connect, nothing to
// act on) so it stays a plain muted dot rather than a glyph that would read as a signal.
const STATE_ICON = { ready: Check, connect: Plus, copy: Copy };
const STATE_FG = {
  ready: 'text-emerald-600 dark:text-emerald-400',
  connect: 'text-amber-600 dark:text-amber-500',
  copy: 'text-amber-600 dark:text-amber-500',
};

export default function RadarSourceGlyphs({ sources = [], capabilities, accounts, sourceStatus, onNavigate, size = 15, className = '' }) {
  const t = useT();
  const ids = sources.filter((id) => GLYPH_META[id]);
  if (!ids.length) return null;
  return (
    <ul aria-label={t('radar.source.coverage')} className={`flex flex-wrap items-center gap-2 ${className}`}>
      {ids.map((id) => {
        const { Icon, color } = GLYPH_META[id] || { Icon: Radio, color: '' };
        const state = glyphState(id, { capabilities, accounts, sourceStatus });
        const label = state
          ? t(`radar.source.state.${state}`, { platform: t(`radar.source.${id}`) })
          : t(`radar.source.${id}`);
        const StateIcon = STATE_ICON[state];
        const glyph = (
          <span className="relative inline-flex">
            <Icon size={size} className={color} aria-hidden="true" />
            {StateIcon ? (
              <span className="absolute -right-1.5 -top-1.5 inline-flex items-center justify-center rounded-full bg-white p-px ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-700" aria-hidden="true">
                <StateIcon size={9} strokeWidth={3.5} className={STATE_FG[state]} />
              </span>
            ) : state === 'scan' ? (
              <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-zinc-400 ring-2 ring-white dark:bg-zinc-500 dark:ring-zinc-900" aria-hidden="true" />
            ) : null}
          </span>
        );
        return (
          <li key={id} className="inline-flex">
            <Tip label={label}>
              {state === 'connect' && SETUP_CONNECTABLE.has(id) && onNavigate ? (
                <button
                  type="button"
                  onClick={() => onNavigate('setup', id)}
                  aria-label={label}
                  className="rounded p-0.5 transition hover:bg-zinc-900/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-white/5"
                >
                  {glyph}
                </button>
              ) : (
                <span className="cursor-help p-0.5" role="img" aria-label={label}>{glyph}</span>
              )}
            </Tip>
          </li>
        );
      })}
    </ul>
  );
}
