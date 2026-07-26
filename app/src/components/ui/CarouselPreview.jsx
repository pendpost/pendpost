// Spec 05: the ONE place an album renders. A carousel has no single media file, so
// PostPreview's `post.media.url` branch could never match and every album fell through
// to the red "no media selected" error - even a complete, on-disk, publishable one.
//
// Shape: a frame showing the active slide, with the slide THUMBNAILS underneath as its
// navigation. Thumbnails rather than abstract dots for two reasons: ten interactive
// dots on a ten-slide album would blow the "at most seven choices per decision point"
// ceiling, and the thumbnail strip preserves the one property the old read-only strip
// in PostDetail genuinely had - every slide, in order, missing ones flagged, visible at
// a glance. That strip is folded in here, so there is ONE album render instead of two.
//
// Deliberately NO inline prev/next arrows: the strip already reaches every slide, and a
// second mechanism for one job is what the arrows would be. Sequential stepping lives in
// the full-screen viewer, where there is no strip. That also keeps the frame free to be
// the expand control (the same pattern as PostPreview's single-image branch) with nothing
// interactive nested inside it.
//
// The frame renders `item.url`, the LOCAL /media proxy - never a slide's public mirror
// URL (mediaItems[i].url), which exists only because Instagram image children need a
// public source. Reaching for that would make the review surface depend on a third-party
// CDN and break offline, against the local-first rule in brand/DESIGN.md.
import { useState } from 'react';
import { AlertTriangle, ImageOff, Maximize2 } from 'lucide-react';
import { useT } from '../../lib/i18n.js';
import { isImageMedia } from '../../lib/format.js';
import { INNER_SURFACE, EYEBROW } from './tokens.js';
import { MediaLightbox } from './MediaLightbox.jsx';
import { Button } from './Button.jsx';

const PLACEHOLDER = 'bg-zinc-200/70 dark:bg-zinc-800/60';

// One slide inside the frame. object-contain, not cover: a slide whose shape differs
// from the album's frame LETTERBOXES visibly instead of being silently cropped, which
// is the honest signal that the album is mixed. A video slide shows a real frame of its
// own content (the CoverThumb idiom) rather than a black box; playback is the viewer's
// job, which is what the expand control is for.
function Slide({ item, t }) {
  if (!item?.url) {
    return (
      <div className={`grid h-full w-full place-items-center gap-1 px-3 text-center ${PLACEHOLDER}`}>
        <ImageOff size={18} className="text-amber-600 dark:text-amber-300" aria-hidden="true" />
        <p role="status" className="text-[11px] text-amber-700 dark:text-amber-300">
          {t('ui.preview.mediaNotFound', { file: item?.file || t('postDetail.file.missing') })}
        </p>
      </div>
    );
  }
  if (isImageMedia({ url: item.url })) {
    return <img src={item.url} alt="" loading="lazy" className={`h-full w-full object-contain ${PLACEHOLDER}`} />;
  }
  return (
    <video
      src={item.url}
      muted
      playsInline
      preload="metadata"
      aria-hidden="true"
      tabIndex={-1}
      onLoadedMetadata={(e) => {
        if (e.currentTarget.currentTime !== 0) return;
        const d = e.currentTarget.duration;
        e.currentTarget.currentTime = Number.isFinite(d) && d > 0 ? d * 0.2 : 0.1;
      }}
      className="h-full w-full bg-black/80 object-contain"
    />
  );
}

// Mirrors CAROUSEL_MIN_ITEMS in lib/carousel.mjs (the browser bundle never imports a
// server-only module, the same small-local-copy pattern postNeedsMedia uses). The
// SERVER stays the gate: an under-count album still saves, so platform_validate can
// report it; this only decides what the reviewer is told.
const MIN_ITEMS = 2;

export function CarouselPreview({ items = [], aspect, ratio, mixed, onEdit }) {
  const t = useT();
  const [index, setIndex] = useState(0);
  const [zoom, setZoom] = useState(false);
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  // Clamped DURING render, so removing a slide (or switching post via the `key` the
  // caller already passes) can never leave the index pointing past the end.
  const i = Math.min(index, Math.max(0, list.length - 1));
  const active = list[i];
  const missing = list.filter((it) => !it?.url).length;

  // ONE status slot, never two stacked blocks. Each state answers what happened and,
  // through the recovery control beside it, what to do about it. The openEditor label
  // is reused verbatim from the overflow menu so the operator sees the same words for
  // the same action, rather than a second string for one job.
  const status = !list.length
    ? t('ui.carousel.empty', { min: MIN_ITEMS })
    : list.length < MIN_ITEMS
      ? t('ui.carousel.needsMore', { min: MIN_ITEMS })
      : missing
        ? t('ui.carousel.missing', { missing, n: list.length })
        : null;

  return (
    <div className="space-y-1.5">
      <p className={EYEBROW}>
        {t('ui.carousel.heading')}
        {/* A one-slide album read "1 slides" in the live review dialog. Caught by looking
            at the screenshot rather than by any assertion, which is the point of the
            fresh-eyes pass. */}
        {list.length ? ` · ${list.length === 1 ? t('ui.carousel.countOne') : t('ui.carousel.count', { n: list.length })}` : ''}
        {mixed ? ` · ${t('ui.carousel.mixed')}` : ratio ? ` · ${ratio}` : ''}
      </p>

      {list.length ? (
        <>
          {/* The frame is the expand control, exactly as the single-image branch is, so
              the affordance is learned once. The Maximize2 hint is visible on touch and
              hover-revealed only from md up - a hover-only reveal is silent on a phone. */}
          <button
            type="button"
            onClick={() => setZoom(true)}
            aria-label={t('ui.player.expand')}
            className={`group relative block w-full overflow-hidden rounded-xl ring-1 ring-zinc-900/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:ring-white/10 ${aspect}`}
          >
            {/* A fixed-height frame with only the track moving: the layout holds still
                between slides, so the sticky media column never reflows. */}
            <span
              className="flex h-full w-full transition-transform duration-[350ms] ease-out motion-reduce:transition-none"
              style={{ transform: `translateX(-${i * 100}%)` }}
            >
              {list.map((item, n) => (
                <span key={`${item.path || item.file || 'slide'}-${n}`} className="h-full w-full shrink-0 grow-0 basis-full">
                  <Slide item={item} t={t} />
                </span>
              ))}
            </span>
            <span className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/55 text-white opacity-100 backdrop-blur transition md:opacity-0 md:group-hover:opacity-100">
              <Maximize2 size={15} aria-hidden="true" />
            </span>
            <span className="sr-only" aria-live="polite">{t('ui.carousel.position', { i: i + 1, n: list.length })}</span>
          </button>

          {/* The strip IS the navigation. It wraps rather than scrolling, so no surface
              scrolls sideways in either the two-column dialog or the stacked phone
              layout. Order and per-slide health read at a glance, which is what the
              folded-in PostDetail strip was for. */}
          {/* The strip is CAPPED and scrolls vertically past three rows. Wrapping alone
              was not containment: the media column is sticky inside the dialog's single
              scroll child, so at 20 slides rows past the fourth were clipped by the
              dialog edge and slides 19 and 20 could not be reached at all. Caught by a
              fresh-eyes pass on the screenshot, not by the browser gate, which asserted
              only that nothing scrolled SIDEWAYS - the wrong axis. */}
          <ul className="flex max-h-36 flex-wrap gap-1.5 overflow-y-auto">
            {list.map((item, n) => (
              <li key={`thumb-${item.path || item.file || 'slide'}-${n}`}>
                <button
                  type="button"
                  onClick={() => setIndex(n)}
                  aria-label={t('ui.carousel.goTo', { n: n + 1 })}
                  aria-current={n === i ? 'true' : undefined}
                  className={`relative grid h-11 w-11 place-items-center overflow-hidden rounded-lg ring-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                    n === i ? 'ring-brand' : item?.url ? 'ring-zinc-900/10 dark:ring-white/10' : 'ring-amber-500/50'
                  }`}
                >
                  {item?.url && isImageMedia({ url: item.url }) ? (
                    <img src={item.url} alt="" loading="lazy" className={`h-full w-full object-cover ${PLACEHOLDER}`} />
                  ) : (
                    <span className={`grid h-full w-full place-items-center ${PLACEHOLDER}`}>
                      <ImageOff size={13} className={item?.url ? 'text-zinc-500 dark:text-zinc-400' : 'text-amber-600 dark:text-amber-300'} aria-hidden="true" />
                    </span>
                  )}
                  <span className="absolute left-0.5 top-0.5 rounded bg-black/60 px-1 text-[9px] font-bold tabular-nums text-white">{n + 1}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {/* Zero slides renders NO frame and NO strip: there is no shape to convey and no
          slide to show, so the status row below is the whole state. One message, one
          slot - a placeholder tile plus a sentence would say the same thing twice. */}
      {status ? (
        <div className={`flex flex-wrap items-center gap-2 rounded-xl p-2 ${INNER_SURFACE}`}>
          <p role="status" className="flex min-w-0 flex-1 items-start gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-300">
            <AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
            <span>{status}</span>
          </p>
          {onEdit ? (
            <Button variant="subtle" size="sm" onClick={onEdit}>{t('postDetail.action.openEditor')}</Button>
          ) : null}
        </div>
      ) : null}

      {zoom && active?.url ? (
        <MediaLightbox
          kind={isImageMedia({ url: active.url }) ? 'image' : 'video'}
          src={active.url}
          count={list.length}
          index={i}
          onIndex={setIndex}
          onClose={() => setZoom(false)}
        />
      ) : null}
    </div>
  );
}
