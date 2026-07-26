import { ExternalLink, Wrench } from 'lucide-react';
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

/**
 * One lane's destination, derived from the accounts payload (lib/accounts.mjs).
 * Returns { handle } when the account has a human name, { id } when it only has a
 * machine id, or null when the lane has no identifier at all.
 */
export function destinationFor(platform, accounts) {
  if (!accounts) return null;
  const pick = (handle, id) => {
    if (handle) return { handle: `@${String(handle).replace(/^@/, '')}`, id: id || null };
    if (id) return { handle: null, id: String(id) };
    return null;
  };
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
    default:
      return null;
  }
}

export default function DestinationStrip({ platforms = [], accounts = null, isLoading = false, isError = false, onNavigate = null }) {
  const t = useT();
  const lanes = [...platforms].filter((p) => PLATFORM_META[p]);
  if (!lanes.length) return null;

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
        <p className="px-1 text-[11px] text-amber-600 dark:text-amber-300">{t('destination.unknown')}</p>
      </section>
    );
  }

  return (
    <section className="space-y-1.5">
      {heading}
      <div className="flex flex-wrap gap-1.5">
        {lanes.map((p) => {
          const meta = PLATFORM_META[p];
          const { Icon } = meta;
          const dest = destinationFor(p, accounts);
          const missing = !dest;
          const label = dest?.handle || (dest?.id ? shortId(dest.id) : t('destination.notConnected'));
          // The tooltip carries the full, unabbreviated truth in every case.
          const tip = missing
            ? t('destination.notConnectedTip', { platform: meta.label })
            : t('destination.tip', { platform: meta.label, account: dest.handle ? `${dest.handle}${dest.id ? ` (${dest.id})` : ''}` : dest.id });
          const body = (
            <>
              <Icon size={13} className={missing ? 'text-zinc-500 dark:text-zinc-400' : meta.color} aria-hidden="true" />
              <span className={missing ? 'text-amber-600 dark:text-amber-300' : ''}>{label}</span>
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
