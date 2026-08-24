import { useState } from 'react';
import { ChevronDown, ExternalLink, Wrench } from 'lucide-react';
import { PLATFORM_META, INNER_SURFACE, EYEBROW, Skeleton } from '../ui.jsx';
import { Tip } from './Tooltip.jsx';
import { useT } from '../../lib/i18n.js';

// DestinationStrip - "posts from this project publish to THESE accounts", stated once
// per surface.
//
// WHY THIS EXISTS. On 2026-07-25 a bondigoo post published onto the pendpost Instagram
// account. The owner approved it with no way to see where it would land: the approval
// cards show a platform GLYPH, which says instagram, not WHICH instagram. Nothing in the
// UI answered "which account is this going to".
//
// WHY IT IS ONE ROW AND NOT A PER-CARD CHIP. The destination is a property of the
// PROJECT, not of the post: every card on a client-scoped surface shares it. A chip
// would repeat one bit of information 114 times on a row that already drops its campaign
// label below sm. So this is a single statement above the list, in the shape Published's
// account strip already established.
//
// DATA HONESTY. A lane whose account has no human-readable handle still HAS a
// destination, so it renders the id short with the full value a hover away (never a
// blank, never a 17-digit number presented as if it were a name), plus a quiet route to
// Setup to give it a name. A lane with no identifier at all is the only "not connected"
// state. Loading is a skeleton matching this row, and a failed read says so: a strip that
// silently vanishes would read as "no constraint", which for a destination is a lie.

/** Long machine ids render short, with the full value in the tooltip. */
export function shortId(value) {
  const s = String(value || '');
  return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

/** Hostname of a site URL, or '' when it cannot be parsed. */
function hostOf(url) {
  try {
    return url ? new URL(url).hostname : '';
  } catch {
    return '';
  }
}

/**
 * One lane's destination, derived from the accounts payload (lib/accounts.mjs).
 * Returns { handle } when the account has a human name, { id } when it only has a
 * machine id, { connected: true } when the lane holds a credential but no identifier
 * (a true statement that must never read as "not connected"), or null when the lane
 * has nothing on file at all.
 */
export function destinationFor(platform, accounts) {
  if (!accounts) return null;
  // A credentialed lane without an identifier is CONNECTED, just nameless. Falling
  // through to null here would render amber "no account" over a working lane - the
  // false statement this function exists to prevent.
  const connectedFallback = () => (accounts[platform]?.authenticated ? { connected: true } : null);
  const pick = (handle, id) => {
    if (handle) return { handle: `@${String(handle).replace(/^@/, '')}`, id: id || null };
    if (id) return { handle: null, id: String(id) };
    return connectedFallback();
  };
  // Human-readable names that are NOT @handles (a subreddit, a hostname).
  const plain = (name) => (name ? { handle: String(name), id: null } : connectedFallback());
  switch (platform) {
    case 'instagram':
      return pick(accounts.meta?.igHandle, accounts.meta?.igUserId);
    case 'facebook':
      return pick(null, accounts.meta?.pageId);
    case 'linkedin':
      return pick(null, (accounts.linkedin?.orgUrn || '').replace(/^urn:li:organization:/, ''));
    case 'youtube':
      return pick(accounts.youtube?.handle, accounts.youtube?.channelId);
    case 'x':
      return pick(accounts.x?.handle, null);
    case 'mastodon':
      return pick(accounts.mastodon?.handle, null);
    case 'telegram':
      return pick(null, accounts.telegram?.channelId);
    case 'reddit':
      return plain(accounts.reddit?.subreddit ? `r/${String(accounts.reddit.subreddit).replace(/^\/?r\//, '')}` : '');
    case 'pinterest':
      return pick(null, accounts.pinterest?.boardId);
    case 'wordpress':
      return plain(hostOf(accounts.wordpress?.siteUrl));
    case 'ghost':
      return plain(hostOf(accounts.ghost?.siteUrl));
    case 'nostr':
      return pick(null, accounts.nostr?.npub);
    case 'gbp':
      return pick(null, accounts.gbp?.locationId);
    default:
      // Credentialed-no-identifier lanes (discord webhook, tiktok token) and any
      // future lane: connected reads quiet, absent reads missing - never amber
      // over a lane that merely lacks a display name.
      return connectedFallback();
  }
}

// The collapsed/expanded preference outlives the session: the strip is config context,
// not content, so it stays out of the way (collapsed) unless the operator opened it.
const COLLAPSE_KEY = 'pendpost-destination-collapsed';

function readCollapsed() {
  // Default COLLAPSED: config never stacks on the content it configures.
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) !== '0';
  } catch {
    return true;
  }
}

export default function DestinationStrip({ platforms = [], accounts = null, isLoading = false, isError = false, onNavigate = null }) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const lanes = [...platforms].filter((p) => PLATFORM_META[p]);
  if (!lanes.length) return null;

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
    } catch {
      // Preference-only write; losing it costs one extra click, never data.
    }
  };

  const heading = <h3 className={`px-1 ${EYEBROW}`}>{t('destination.title')}</h3>;

  if (isLoading) {
    return (
      <section className="space-y-1.5" aria-busy="true">
        {heading}
        <div className="flex flex-wrap gap-1.5">
          {lanes.map((p) => <Skeleton key={p} className="h-[30px] w-28 rounded-xl" />)}
        </div>
      </section>
    );
  }

  if (isError || !accounts) {
    // Explicit, never silent. The operator must not read a missing strip as "fine".
    return (
      <section className="space-y-1.5">
        {heading}
        <p className="px-1 text-[11px] text-amber-700 dark:text-amber-300">{t('destination.unknown')}</p>
      </section>
    );
  }

  // The one-line summary the collapsed state shows: the first three resolvable
  // account names, how many more lanes are fine, and - only when true - how many
  // lanes have no account at all.
  const dests = lanes.map((p) => destinationFor(p, accounts));
  const missingCount = dests.filter((d) => !d).length;
  const labels = dests.filter((d) => d?.handle || d?.id).map((d) => d.handle || shortId(d.id));
  const shown = labels.slice(0, 3);
  const moreCount = lanes.length - missingCount - shown.length;

  const trigger = (
    <Tip label={t('destination.toggle')}>
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={toggle}
        className="flex w-full items-center gap-2 rounded-lg px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <span className={EYEBROW}>{t('destination.title')}</span>
        {shown.length ? (
          <span className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">{shown.join(' · ')}</span>
        ) : null}
        {moreCount > 0 ? <span className="text-[11px] text-zinc-500 dark:text-zinc-400">+{moreCount}</span> : null}
        {missingCount > 0 ? (
          <span className="text-[11px] text-amber-700 dark:text-amber-300">{t('destination.missingCount', { n: missingCount })}</span>
        ) : null}
        <ChevronDown size={13} className={`shrink-0 text-zinc-500 dark:text-zinc-400 transition-transform ${collapsed ? '-rotate-90' : ''}`} aria-hidden="true" />
      </button>
    </Tip>
  );

  if (collapsed) {
    return <section className="space-y-1.5">{trigger}</section>;
  }

  return (
    <section className="space-y-1.5">
      {trigger}
      <div className="flex flex-wrap gap-1.5">
        {lanes.map((p) => {
          const meta = PLATFORM_META[p];
          const { Icon } = meta;
          const dest = destinationFor(p, accounts);
          const missing = !dest;
          // Connected-but-nameless: a credential exists, no identifier to show. Quiet
          // zinc, never amber - the lane works.
          const connectedOnly = !!dest?.connected && !dest?.handle && !dest?.id;
          const label = dest?.handle || (dest?.id ? shortId(dest.id) : connectedOnly ? t('destination.connected') : t('destination.notConnected'));
          // The tooltip carries the full, unabbreviated truth in every case.
          const tip = missing
            ? t('destination.notConnectedTip', { platform: meta.label })
            : connectedOnly
              ? t('destination.connectedTip', { platform: meta.label })
              : t('destination.tip', { platform: meta.label, account: dest.handle ? `${dest.handle}${dest.id ? ` (${dest.id})` : ''}` : dest.id });
          const body = (
            <>
              <Icon size={13} className={missing ? 'text-zinc-500 dark:text-zinc-400' : meta.color} aria-hidden="true" />
              <span className={missing ? 'text-amber-700 dark:text-amber-300' : connectedOnly ? 'text-zinc-500 dark:text-zinc-400' : ''}>{label}</span>
              {missing ? <Wrench size={11} aria-hidden="true" /> : null}
            </>
          );
          const cls = `inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-bold ${INNER_SURFACE}`;
          // A missing destination is the one actionable state, so it is the one that is
          // a control: it routes to Setup rather than dead-ending on a warning.
          return missing && onNavigate ? (
            <Tip key={p} label={tip}>
              <button
                type="button"
                onClick={() => onNavigate('setup')}
                aria-label={tip}
                className={`${cls} transition hover:ring-1 hover:ring-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`}
              >
                {body}
                <ExternalLink size={11} className="text-zinc-500" aria-hidden="true" />
              </button>
            </Tip>
          ) : (
            <Tip key={p} label={tip}>
              <span className={cls} aria-label={tip}>{body}</span>
            </Tip>
          );
        })}
      </div>
    </section>
  );
}
