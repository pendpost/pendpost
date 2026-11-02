import { useState } from 'react';
import { ChevronDown, TriangleAlert } from 'lucide-react';
import { PLATFORM_META, INNER_SURFACE, EYEBROW, Skeleton } from '../ui.jsx';
import { Tip } from './Tooltip.jsx';
import IssueFixButton from '../IssueFixButton.jsx';
import { setupIdOf, STAIR } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';

// DestinationStrip - "posts from this project publish to THESE accounts", stated once
// per surface.
//
// WHY THIS EXISTS. On 2026-07-25 a second client's post published onto the pendpost Instagram
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
//
// ONE PROJECT ONLY. The accounts belong to one project, so the Approvals page hides the strip
// in All-projects mode (a single row cannot be true for several projects). And "not connected"
// is the SAME fact the post rows judge Blocked by (the project's pendpost-health setup, passed
// as `setup`): the strip says "X not connected" with the same Connect fix the rows offer
// (IssueFixButton), never a vaguer "no account on file" beside rows that say something else.

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

// The project's setup row for a lane (lib/setup.mjs), or null when the setup is unknown.
function setupRowFor(platform, setup) {
  const rows = setup?.platforms;
  if (!Array.isArray(rows)) return null;
  return rows.find((r) => r.platform === platform || r.platform === setupIdOf(platform)) || null;
}

// A lane is not connected when the project's setup says so (status 'incomplete', the rows'
// Blocked rule, format.js unconnectedLanes). Without a setup, the accounts payload decides:
// nothing on file at all.
function laneState(platform, accounts, setup) {
  const dest = destinationFor(platform, accounts);
  const row = setupRowFor(platform, setup);
  if (row?.status === 'incomplete') return { dest, missing: true };
  if (row?.status === 'skipped') return { dest, skipped: true };
  if (row) return { dest: dest || { connected: true }, missing: false };
  return { dest, missing: !dest };
}

export default function DestinationStrip({ platforms = [], accounts = null, setup = null, isLoading = false, isError = false, onNavigate = null }) {
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
  const states = lanes.map((p) => laneState(p, accounts, setup));
  const missingCount = states.filter((s) => s.missing).length;
  const labels = states.filter((s) => !s.missing && (s.dest?.handle || s.dest?.id)).map((s) => s.dest.handle || shortId(s.dest.id));
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
        {/* The same fact the rows below state ("X is not connected"), so the same halted rose
            ink and alert glyph as their status line, never a second (amber) tone for it. */}
        {missingCount > 0 ? (
          <span data-tone="halted" className={`inline-flex shrink-0 items-center gap-1 text-[11px] font-medium ${STAIR.halted.ink}`}>
            <TriangleAlert size={11} className="shrink-0" aria-hidden="true" />
            {t('destination.missingCount', { n: missingCount })}
          </span>
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
        {lanes.map((p, i) => {
          const meta = PLATFORM_META[p];
          const { Icon } = meta;
          const { dest, missing, skipped } = states[i];
          const cls = `inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-bold ${INNER_SURFACE}`;
          // Not connected: the one actionable state, so it carries the lane's Connect fix (the
          // same IssueFixButton the post rows use: a key lane connects right here, an OAuth
          // lane opens its Setup card with the sign-in started).
          if (missing) {
            const lane = setupIdOf(p);
            const issue = { kind: 'blocked', lane, lanes: [p], clientId: null, cause: `connect:${lane}`, code: null, fix: { type: 'connect', lane, agent: false } };
            const tip = t('destination.notConnectedTip', { platform: meta.label });
            return (
              <span key={p} className={`${cls} py-0.5 pr-0.5`}>
                <Tip label={tip}>
                  <span className="inline-flex items-center gap-1.5" aria-label={tip}>
                    <Icon size={13} className={meta.color} aria-hidden="true" />
                    <span>{t('destination.notConnected', { platform: meta.label })}</span>
                  </span>
                </Tip>
                <IssueFixButton issue={issue} post={null} onNavigate={onNavigate} size="sm" variant="ghost" />
              </span>
            );
          }
          // Connected-but-nameless (or a lane the owner marked as not in use): quiet zinc,
          // never amber - nothing is wrong.
          const connectedOnly = !skipped && !!dest?.connected && !dest?.handle && !dest?.id;
          const label = skipped ? t('destination.skipped')
            : dest?.handle || (dest?.id ? shortId(dest.id) : t('destination.connected'));
          // The tooltip carries the full, unabbreviated truth in every case.
          const tip = skipped
            ? t('destination.skippedTip', { platform: meta.label })
            : connectedOnly || (!dest?.handle && !dest?.id)
              ? t('destination.connectedTip', { platform: meta.label })
              : t('destination.tip', { platform: meta.label, account: dest.handle ? `${dest.handle}${dest.id ? ` (${dest.id})` : ''}` : dest.id });
          return (
            <Tip key={p} label={tip}>
              <span className={cls} aria-label={tip}>
                <Icon size={13} className={meta.color} aria-hidden="true" />
                <span className={connectedOnly || skipped ? 'text-zinc-500 dark:text-zinc-400' : ''}>{label}</span>
              </span>
            </Tip>
          );
        })}
      </div>
    </section>
  );
}
