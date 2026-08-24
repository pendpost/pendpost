import { PLATFORM_META } from '../ui.jsx';
import { Tip } from './Tooltip.jsx';
import { Popover, PopoverTrigger, PopoverContent } from './Popover.jsx';
import { resolveLivePermalink } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';

// The ONE open-live-post link strip: quiet icon-only links, one per lane where
// resolveLivePermalink actually resolves - nothing renders for a lane with no
// provable link (never a dead or fabricated control, C2). Shared by Published's
// rows AND the Freigaben "Alle Beitraege" posted cards, which had grown two
// identical copies of this map - one component, one design language (S6).
//
// At-scale (S6, fresh-eyes finding 13): at most MAX_INLINE lane links render
// inline so a row stays one line and under the 7-choice cap; a post published
// to more lanes collapses the remainder into one quiet "+n" overflow.
const MAX_INLINE = 5;

function LaneLink({ p, href, t, menu = false }) {
  const meta = PLATFORM_META[p];
  const { Icon } = meta;
  const label = t('published.viewOn', { platform: meta.label });
  const link = (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={menu ? undefined : label}
      className={menu
        ? 'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-900/5 dark:text-zinc-200 dark:hover:bg-white/5'
        : 'rounded-lg p-1.5 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60'}
    >
      <Icon size={14} className={meta.color} aria-hidden="true" />
      {menu ? label : null}
    </a>
  );
  return menu ? link : <Tip label={label}>{link}</Tip>;
}

export default function LiveLaneLinks({ post }) {
  const t = useT();
  const links = (post.platforms || []).map((p) => ({ p, href: resolveLivePermalink(post, p) })).filter((x) => x.href && PLATFORM_META[x.p]);
  if (!links.length) return null;
  const inline = links.slice(0, MAX_INLINE);
  const rest = links.slice(MAX_INLINE);
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {inline.map(({ p, href }) => <LaneLink key={p} p={p} href={href} t={t} />)}
      {rest.length ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t(rest.length === 1 ? 'published.moreLinks.one' : 'published.moreLinks', { n: rest.length })}
              className="rounded-lg px-1.5 py-1 text-[11px] font-bold text-zinc-500 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:bg-zinc-700/60"
            >
              +{rest.length}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-48 p-1" aria-label={t(rest.length === 1 ? 'published.moreLinks.one' : 'published.moreLinks', { n: rest.length })}>
            {rest.map(({ p, href }) => <LaneLink key={p} p={p} href={href} t={t} menu />)}
          </PopoverContent>
        </Popover>
      ) : null}
    </span>
  );
}
