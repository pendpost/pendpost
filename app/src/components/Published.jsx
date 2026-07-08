import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, ExternalLink, Send, CalendarDays, List as ListIcon, ChevronLeft, ChevronRight } from 'lucide-react';
import { useAccounts, verifyPost } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { StatusPill, CoverThumb, EYEBROW, PLATFORM_META, INNER_SURFACE, Skeleton } from './ui.jsx';
import { Tip } from './ui/Tooltip.jsx';
import ActionButton from './ui/ActionButton.jsx';
import { MonthView } from './Planner.jsx';
import { dayKey, fmtTime, fmtMonthYear, dateLocale, PLATFORMS, postDisplayTitle } from '../lib/format.js';

// Date-only day-group header: weekday/day/month/year, no time. Built directly
// rather than regex-stripping the clock off fmtFull, because locales that join
// date and time with a word (de-CH "… um 09:27") otherwise leave a dangling
// preposition ("… 2026 um") once the time is removed.
function fmtDayHeader(iso) {
  return new Intl.DateTimeFormat(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
}

// The handed-off / live states a published archive surfaces: actually posted,
// believed live (fired-assumed), and the two verify outcomes.
const PUBLISHED_STATES = new Set(['posted', 'fired-assumed', 'verified-live', 'verify-failed']);

// Date-range presets (US-PUB-11): an owner browsing the archive narrows to a
// recent window. 'all' applies no constraint; the others cut off N days back.
const RANGES = [
  { key: 'all', days: null },
  { key: '7d', days: 7 },
  { key: '30d', days: 30 },
];

// Best public link for one platform: the verify read-back permalink (most
// authoritative) > the id-derived permalink > a manual externalUrl (IG has no
// derivable public slug). null = no public link.
function viewLink(post, platform) {
  const v = post.verify?.platforms?.[platform];
  if (v?.permalink) return v.permalink;
  if (post.permalinks?.[platform]) return post.permalinks[platform];
  if (platform === 'instagram' && post.externalUrl) return post.externalUrl;
  return null;
}

// Top strip: one "Open <platform>" link per account that exposes a public
// profile URL (accounts.publicUrls, env-derived; absent platforms are skipped).
// Facebook is deactivated - it is dropped from the strip even if a URL is set;
// Instagram and YouTube surface as soon as their handle (IG_HANDLE / YT_CHANNEL_ID)
// is configured.
function AccountStrip({ publicUrls, platforms, t }) {
  // Only real live profiles: a public URL is configured AND this workspace has
  // actually published to that platform. Facebook stays dropped by design.
  const entries = PLATFORMS.filter((p) => p !== 'facebook' && publicUrls?.[p] && platforms?.has(p));
  if (!entries.length) return null;
  return (
    <section className="space-y-1.5">
      <h3 className={`px-1 ${EYEBROW}`}>{t('published.accounts')}</h3>
      <div className="flex flex-wrap gap-1.5">
        {entries.map((p) => {
          const meta = PLATFORM_META[p];
          const { Icon } = meta;
          return (
            <a
              key={p}
              href={publicUrls[p]}
              target="_blank"
              rel="noopener noreferrer"
              className={`inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-bold transition hover:ring-1 hover:ring-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${INNER_SURFACE}`}
            >
              <Icon size={13} className={meta.color} aria-hidden="true" />
              {t('published.openAccount', { platform: meta.label })}
              <ExternalLink size={11} className="text-zinc-400" aria-hidden="true" />
            </a>
          );
        })}
      </div>
    </section>
  );
}

function Row({ post, onOpen, t }) {
  const queryClient = useQueryClient();
  const canVerify = post.derivedState === 'fired-assumed' || Boolean(post.verify);
  const onVerify = async () => {
    await verifyPost(post.campaign, post.id);
    queryClient.invalidateQueries({ queryKey: ['plans'] });
  };
  // US-PUB-11: only show a platform link where we actually have a public link to
  // open - never a greyed-out placeholder for a platform with no link, which read
  // as "links to platforms we did not post to".
  const links = (post.platforms || []).map((p) => ({ p, href: viewLink(post, p) })).filter((x) => x.href && PLATFORM_META[x.p]);
  return (
    <div className={`flex items-center gap-3 rounded-xl px-3 py-2 ${INNER_SURFACE}`}>
      <button
        type="button"
        onClick={() => onOpen(post)}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <CoverThumb media={post.media} image={post.image} className="h-12 w-12 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold">{postDisplayTitle(post)}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            {(post.derivedState === 'fired-assumed' || post.derivedState === 'verify-failed') ? (
              <StatusPill state={post.derivedState} short />
            ) : null}
            <span>{t(`type.${post.type}`)}</span>
            {post.scheduledAt ? <span>· {fmtTime(post.scheduledAt)}</span> : null}
          </p>
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-1.5">
        {links.map(({ p, href }) => {
          const meta = PLATFORM_META[p];
          const { Icon } = meta;
          return (
            <Tip key={p} label={t('published.viewOn', { platform: meta.label })}>
              <a href={href} target="_blank" rel="noopener noreferrer" aria-label={t('published.viewOn', { platform: meta.label })} className="rounded-lg p-1.5 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60">
                <Icon size={14} className={meta.color} aria-hidden="true" />
              </a>
            </Tip>
          );
        })}
        {canVerify ? (
          <Tip label={t('published.verify.idle')}>
            <ActionButton
              icon={ShieldCheck}
              ariaLabel={t('published.verify.idle')}
              labels={{ idle: '', loading: t('published.verify.loading'), success: t('published.verify.success'), error: t('published.verify.error') }}
              onAction={onVerify}
            />
          </Tip>
        ) : null}
      </div>
    </div>
  );
}

// A segmented toggle (reused for the view + range controls). Single-tone, the
// active segment carries the accent; mirrors the Approvals view toggle.
function Segmented({ label, value, options, onChange }) {
  return (
    <div className="flex items-center rounded-xl bg-zinc-200/60 p-0.5 dark:bg-zinc-800/60" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          aria-pressed={value === o.key}
          className={`flex items-center gap-1 rounded-[10px] px-2.5 py-1 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
            value === o.key ? 'bg-white text-brand shadow dark:bg-zinc-700 dark:text-brand-light' : 'text-zinc-500 dark:text-zinc-400'
          }`}
        >
          {o.Icon ? <o.Icon size={13} aria-hidden="true" /> : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function Published({ campaigns = [], onOpen, platformFilter = [], isLoading = false }) {
  const { data: accounts } = useAccounts();
  const t = useT();
  const [view, setView] = useState('list'); // 'list' | 'month'
  const [range, setRange] = useState('all');
  // The month the calendar view is anchored to (first of month); list view
  // ignores it. Lazily seeded to the current month.
  const [monthAnchor, setMonthAnchor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const { posts, unfilteredCount, rangeCounts, publishedPlatforms } = useMemo(() => {
    const now = Date.now();
    const inRange = (p, days) => {
      if (days == null) return true;
      const ts = Date.parse(p.postedAt || p.scheduledAt || '') || 0;
      return ts >= now - days * 86400000;
    };
    // The published set BEFORE the date range is applied, so an empty range can
    // tell "no posts at all" apart from "posts exist, just outside this window".
    const published = campaigns
      .flatMap((c) => c.posts || [])
      .filter((p) => PUBLISHED_STATES.has(p.derivedState))
      .filter((p) => !platformFilter.length || (p.platforms || []).some((x) => platformFilter.includes(x)));
    // Per-preset counts so each range segment can show how many posts it holds,
    // letting an owner tell an actively-filtering window apart from an empty one.
    const counts = Object.fromEntries(
      RANGES.map((r) => [r.key, published.filter((p) => inRange(p, r.days)).length]),
    );
    const days = RANGES.find((x) => x.key === range)?.days ?? null;
    const flat = published.filter((p) => inRange(p, days));
    flat.sort((a, b) => {
      const ta = Date.parse(a.postedAt || a.scheduledAt || '') || 0;
      const tb = Date.parse(b.postedAt || b.scheduledAt || '') || 0;
      return tb - ta;
    });
    // The platforms actually published to (across the archive, before the date
    // range) - so the accounts strip links only real live profiles, never a
    // platform this workspace never posted to.
    const platformsSet = new Set(published.flatMap((p) => p.platforms || []));
    return { posts: flat, unfilteredCount: published.length, rangeCounts: counts, publishedPlatforms: platformsSet };
  }, [campaigns, platformFilter, range]);

  const groups = useMemo(() => {
    const out = [];
    let cur = null;
    for (const p of posts) {
      const iso = p.postedAt || p.scheduledAt;
      const k = iso ? dayKey(iso) : 'undated';
      if (!cur || cur.key !== k) {
        cur = { key: k, header: iso ? fmtDayHeader(iso) : t('published.undated'), entries: [] };
        out.push(cur);
      }
      cur.entries.push(p);
    }
    return out;
  }, [posts, t]);

  // The calendar view keys posts off their posted/scheduled time so MonthView -
  // which reads scheduledAt - lands each post on the day it went live.
  const calendarPosts = useMemo(
    () => posts.map((p) => ({ ...p, scheduledAt: p.postedAt || p.scheduledAt })),
    [posts],
  );

  if (isLoading) {
    return <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>;
  }

  const viewOptions = [
    { key: 'list', label: t('published.view.list'), Icon: ListIcon },
    { key: 'month', label: t('published.view.calendar'), Icon: CalendarDays },
  ];
  // Each preset carries its in-window count (mirroring approvals.view.toReviewCount)
  // so an empty list reads as "no posts in this window" rather than "no posts ever".
  // The "all" segment is the baseline and stays uncounted to avoid redundant noise.
  const rangeOptions = RANGES.map((r) => ({
    key: r.key,
    label: r.key === 'all' ? t('published.range.all') : t(`published.range.${r.key}Count`, { n: rangeCounts[r.key] }),
  }));
  const stepMonth = (n) => setMonthAnchor((a) => new Date(a.getFullYear(), a.getMonth() + n, 1));

  return (
    <div className="space-y-5">
      <AccountStrip publicUrls={accounts?.publicUrls} platforms={publishedPlatforms} t={t} />

      <div className="flex flex-wrap items-center gap-2">
        <Segmented label={t('published.view.aria')} value={view} options={viewOptions} onChange={setView} />
        {/* The relative-days range is meaningful only for the reverse-chron list;
            against the calendar's month navigation it silently empties whatever
            month falls outside the window, so it is hidden in calendar mode. */}
        {view === 'list' ? (
          <Segmented label={t('published.range.aria')} value={range} options={rangeOptions} onChange={setRange} />
        ) : null}
      </div>

      {!posts.length ? (
        // A range that filters out otherwise-existing posts gets its own copy so
        // the empty state never lies "nothing published yet" (US-PUB-11).
        range !== 'all' && unfilteredCount > 0 ? (
          <div className="grid h-full min-h-48 place-items-center">
            <div className="max-w-sm space-y-3 text-center">
              <Send className="mx-auto text-zinc-400" size={26} aria-hidden="true" />
              <div className="space-y-2">
                <p className="text-sm font-bold">{t('published.empty.rangeTitle')}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('published.empty.rangeBody')}</p>
              </div>
              <button
                type="button"
                onClick={() => setRange('all')}
                className="inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-bold text-brand transition hover:ring-1 hover:ring-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light"
              >
                {t('published.empty.showAll')}
              </button>
            </div>
          </div>
        ) : (
          <div className="grid h-full min-h-48 place-items-center">
            <div className="max-w-sm space-y-2 text-center">
              <Send className="mx-auto text-zinc-400" size={26} aria-hidden="true" />
              <p className="text-sm font-bold">{t('published.empty.title')}</p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('published.empty.body')}</p>
            </div>
          </div>
        )
      ) : view === 'month' ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Tip label={t('published.prevMonth')}>
              <button type="button" onClick={() => stepMonth(-1)} aria-label={t('published.prevMonth')} className="rounded-lg p-1.5 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60">
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
            </Tip>
            <h3 className="font-display text-sm font-bold">{fmtMonthYear(monthAnchor)}</h3>
            <Tip label={t('published.nextMonth')}>
              <button type="button" onClick={() => stepMonth(1)} aria-label={t('published.nextMonth')} className="rounded-lg p-1.5 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60">
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </Tip>
          </div>
          <MonthView posts={calendarPosts} monthAnchor={monthAnchor} onSelect={onOpen} loading={false} />
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <section key={g.key}>
              <h3 className="mb-1.5 px-1 font-display text-sm font-bold text-zinc-500 dark:text-zinc-400">{g.header}</h3>
              <div className="space-y-1.5">
                {g.entries.map((post) => (
                  <Row key={`${post.campaign}/${post.id}`} post={post} onOpen={(p) => onOpen(p, posts)} t={t} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
