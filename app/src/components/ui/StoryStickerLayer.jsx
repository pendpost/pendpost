// FR4: a preview-only overlay of interactive-story stickers on the 9:16 video,
// visually echoing Instagram story stickers. The authoritative sticker content is
// the Composer form (labeled, keyboard-operable); THIS layer is decoration, so it
// is aria-hidden and a screen-reader user never depends on it. Honest by design:
// every sticker except mention is preview-only on the API, so the layer carries a
// visible "add stickers manually in Instagram" caption to keep that limit visible.
import { MapPin, Link2, AtSign, Music, Hash, HelpCircle, BarChart3 } from 'lucide-react';
import { useT } from '../../lib/i18n.js';

const CHIP = 'pointer-events-none inline-flex max-w-[80%] items-center gap-1 rounded-xl bg-white/95 px-2 py-1 text-[10px] font-bold text-zinc-900 shadow-lg ring-1 ring-black/10';

// Each sticker kind renders a small chip. Layout {x,y} (0..1) positions it over
// the frame; absent coordinates fall back to a readable default stack near the
// vertical center so a freshly-added sticker is always visible.
function StickerChip({ sticker }) {
  const t = useT();
  switch (sticker.kind) {
    case 'poll':
      return (
        <span className={CHIP}>
          <BarChart3 size={11} aria-hidden="true" />
          <span className="flex flex-col">
            <span>{sticker.question || t('ui.story.sticker.poll')}</span>
            <span className="font-medium text-zinc-500">
              {(sticker.options?.[0] || t('ui.story.sticker.pollYes'))} | {(sticker.options?.[1] || t('ui.story.sticker.pollNo'))}
            </span>
          </span>
        </span>
      );
    case 'question':
      return (
        <span className={CHIP}>
          <HelpCircle size={11} aria-hidden="true" />
          {sticker.prompt || t('ui.story.sticker.question')}
        </span>
      );
    case 'link':
      return (
        <span className={CHIP}>
          <Link2 size={11} aria-hidden="true" />
          {sticker.label || sticker.url || t('ui.story.sticker.link')}
        </span>
      );
    case 'mention':
      return (
        <span className={CHIP}>
          <AtSign size={11} aria-hidden="true" />
          {sticker.handle ? sticker.handle.replace(/^@?/, '@') : t('ui.story.sticker.mention')}
        </span>
      );
    case 'location':
      return (
        <span className={CHIP}>
          <MapPin size={11} aria-hidden="true" />
          {sticker.name || t('ui.story.sticker.location')}
        </span>
      );
    case 'hashtag':
      return (
        <span className={CHIP}>
          <Hash size={11} aria-hidden="true" />
          {sticker.tag ? sticker.tag.replace(/^#?/, '#') : t('ui.story.sticker.hashtag')}
        </span>
      );
    case 'music':
      return (
        <span className={CHIP}>
          <Music size={11} aria-hidden="true" />
          {[sticker.title, sticker.artist].filter(Boolean).join(' - ') || t('ui.story.sticker.music')}
        </span>
      );
    default:
      return null;
  }
}

export function StoryStickerLayer({ interactiveStory }) {
  const t = useT();
  const stickers = interactiveStory?.stickers || [];
  if (!stickers.length) return null;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {stickers.map((sticker, i) => {
        const x = typeof sticker.layout?.x === 'number' ? sticker.layout.x : 0.5;
        const y = typeof sticker.layout?.y === 'number' ? sticker.layout.y : 0.32 + (i % 4) * 0.14;
        return (
          <div
            key={`${sticker.kind}-${i}`}
            className="absolute flex -translate-x-1/2 -translate-y-1/2 justify-center"
            style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
          >
            <StickerChip sticker={sticker} />
          </div>
        );
      })}
      <p className="absolute inset-x-0 bottom-1.5 px-2 text-center text-[9px] font-medium text-white/90 drop-shadow">
        {t('ui.story.stickerHint')}
      </p>
    </div>
  );
}
