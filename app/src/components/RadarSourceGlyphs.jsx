import { Globe, Radio, MessageCircleQuestion, Rss, CircleDot } from 'lucide-react';
import { PLATFORM_META } from './ui.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { useT } from '../lib/i18n.js';

// ONE source-coverage strip for Radar, shared by the Radar page header and the Settings
// searches card: one platform glyph per source the scans cover, the sentence ("Reddit: wird
// durchsucht.") in the tooltip AND in each glyph's accessible name.
//
// It speaks about SCANNING (listening) only. It used to add a reply verdict per glyph
// ("Antworten gehen direkt aus pendpost raus" / "Verbinden, um zu antworten") decided from scan
// coverage, while the Auto-Antwort lane list and the Settings ledger name the same lane with the
// ONE reply judge (lib/format.js replyLaneState), so one platform could read ready here and
// "Nicht verbunden" one card below. The sources passed in are the EFFECTIVE scan set
// (effectiveRadarSourcesClient), which is exactly what the scans cover, so every glyph reads
// "wird durchsucht"; connecting a reply lane lives with the reply judge.
const GLYPH_META = {
  reddit: PLATFORM_META.reddit,
  hackernews: PLATFORM_META.hackernews,
  bluesky: PLATFORM_META.bluesky,
  mastodon: PLATFORM_META.mastodon,
  x: PLATFORM_META.x,
  youtube: PLATFORM_META.youtube,
  nostr: PLATFORM_META.nostr,
  linkedin: PLATFORM_META.linkedin,
  instagram: PLATFORM_META.instagram,
  // Quora has no pendpost publish lane and no brand mark - a question glyph, mirroring the
  // signal-row glyph in radar/RadarFeed.jsx so the two renderings can never disagree.
  quora: { Icon: MessageCircleQuestion, color: 'text-rose-600' },
  web: { Icon: Globe, color: 'text-sky-500' },
  // Radar 2.0 step 3: the opt-in engine sources (same glyphs as radar/RadarFeed.jsx SOURCE_META).
  feed: { Icon: Rss, color: 'text-orange-600' },
  github: { Icon: CircleDot, color: 'text-zinc-700 dark:text-zinc-200' },
};

export default function RadarSourceGlyphs({ sources = [], size = 15, className = '' }) {
  const t = useT();
  const ids = sources.filter((id) => GLYPH_META[id]);
  if (!ids.length) return null;
  return (
    <ul aria-label={t('radar.source.coverage')} className={`flex flex-wrap items-center gap-2 ${className}`}>
      {ids.map((id) => {
        const { Icon, color } = GLYPH_META[id] || { Icon: Radio, color: '' };
        const label = t('radar.source.scanned', { platform: t(`radar.source.${id}`) });
        return (
          <li key={id} className="inline-flex">
            <Tip label={label}>
              <span className="inline-flex cursor-help p-0.5" role="img" aria-label={label}>
                <Icon size={size} className={color} aria-hidden="true" />
              </span>
            </Tip>
          </li>
        );
      })}
    </ul>
  );
}
