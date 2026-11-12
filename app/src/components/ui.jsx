import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertOctagon, AlertTriangle, Info, Wrench, Pencil, Maximize2, FileText, HelpCircle, Tag, Smartphone, LayoutGrid, CheckCircle, CalendarClock, Clock, OctagonX } from 'lucide-react';
import { STATE_META, TIME_CHIP_META, STATUS_PILL_META, ROW_STATUS_META, postStatusWord, mediaAspect, isImageMedia, carouselFrame, postNeedsMedia, gridCropInfo, nextActorOf, fmtStampShort } from '../lib/format.js';
import { StoryStickerLayer } from './ui/StoryStickerLayer.jsx';
import { MediaPlayer } from './ui/MediaPlayer.jsx';
import { MediaLightbox } from './ui/MediaLightbox.jsx';
import { CarouselPreview } from './ui/CarouselPreview.jsx';
import { Checkbox } from './ui/Checkbox.jsx';
import { INNER_SURFACE, FIELD_SURFACE, DISABLED_PRIMARY, EYEBROW, FIELD, FIELD_ERR, FIELD_MULTILINE } from './ui/tokens.js';
import { TAP_TARGET, PILL_TONES, STATUS_INK } from './ui/recipes.js';
import { Tip } from './ui/Tooltip.jsx';
import { useT } from '../lib/i18n.js';
import { BrandMark } from './ui/BrandMark.jsx';
import { validateRowText, recoveryFor } from '../lib/blockerText.js';
import { usePostSetup } from '../lib/setupByClient.js';

// Platform brand marks come from ui/BrandMark.jsx (lucide has no brand glyphs since 1.0).
const mark = (name) => function Mark(props) { return <BrandMark name={name} {...props} />; };

export const PLATFORM_META = {
  facebook: { Icon: mark('facebook'), color: 'text-[#1877F2]', label: 'Facebook' },
  instagram: { Icon: mark('instagram'), color: 'text-[#E4405F]', label: 'Instagram' },
  linkedin: { Icon: mark('linkedin'), color: 'text-[#0A66C2]', label: 'LinkedIn' },
  youtube: { Icon: mark('youtube'), color: 'text-[#FF0000]', label: 'YouTube' },
  x: { Icon: mark('x'), color: 'text-zinc-900 dark:text-zinc-100', label: 'X' },
  telegram: { Icon: mark('telegram'), color: 'text-[#229ED9]', label: 'Telegram' },
  discord: { Icon: mark('discord'), color: 'text-[#5865F2]', label: 'Discord' },
  reddit: { Icon: mark('reddit'), color: 'text-[#FF4500]', label: 'Reddit' },
  pinterest: { Icon: mark('pinterest'), color: 'text-[#E60023]', label: 'Pinterest' },
  tiktok: { Icon: mark('tiktok'), color: 'text-zinc-900 dark:text-zinc-100', label: 'TikTok' },
  mastodon: { Icon: mark('mastodon'), color: 'text-[#6364FF]', label: 'Mastodon' },
  wordpress: { Icon: mark('wordpress'), color: 'text-[#21759B]', label: 'WordPress' },
  ghost: { Icon: mark('ghost'), color: 'text-zinc-900 dark:text-zinc-100', label: 'Ghost' },
  nostr: { Icon: mark('nostr'), color: 'text-[#8E30EB]', label: 'Nostr' },
  gbp: { Icon: mark('gbp'), color: 'text-[#4285F4]', label: 'Google Business Profile' },
  // Radar (beta) SEARCH sources (spec 33) - listening only, never publish targets.
  bluesky: { Icon: mark('bluesky'), color: 'text-[#0085FF]', label: 'Bluesky' },
  hackernews: { Icon: mark('hackernews'), color: 'text-[#FF6600]', label: 'Hacker News' },
};

export function PlatformIcons({ platforms, size = 13 }) {
  return (
    <span className="flex items-center gap-1">
      {platforms.map((p) => {
        const meta = PLATFORM_META[p];
        if (!meta) return null;
        const { Icon } = meta;
        return <Icon key={p} size={size} className={meta.color} aria-label={meta.label} />;
      })}
    </span>
  );
}

export function StatusPill({ state, short = false }) {
  const t = useT();
  const meta = STATE_META[state];
  const cls = meta?.cls || 'bg-zinc-500/15 text-zinc-500 dark:text-zinc-400 ring-zinc-500/30';
  const Icon = meta?.Icon;
  // Known states resolve their (short/long) label from the pack; an unknown state
  // falls back to its raw key rather than a stray "state.x" id.
  const label = meta ? t(short ? `state.short.${state}` : `state.${state}`) : state;
  // Canon: no hover-only reveals, so the pill carries no native title (the PostStatusPill
  // precedent). The approval card and the Published row open the post detail, which says
  // the rest as visible text: the power-off truth in the delivery row, a failure's reason
  // in the banner, Re-check on an unverified post, Publish now on an overdue one. The
  // run-due dialog IS the publish-now action for every post it lists.
  // The icon is decorative (aria-hidden, shrink-0) and only the label truncates, so
  // the compact `short` pill keeps both glyph and word without crowding (WCAG 1.4.1).
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${cls}`}>
      {Icon ? <Icon size={11} className="shrink-0" aria-hidden="true" /> : null}
      <span className="truncate">{label}</span>
    </span>
  );
}

// ONE truthful next-actor chip per approval card (nextActorOf, lib/format.js).
// Replaces the old ApprovalPill + schedule-side StatusPill + "Automatisch
// freigegeben" IconBadge stack, whose three independent conditions could
// contradict each other on one card. A plain <span> with no title (canon: no
// hover-only reveals), so it may live INSIDE the card's open-detail button (the
// same contract StatusPill/ApprovalPill honoured).
//
// Keys that render NOTHING here are carried by a sibling: overdue/publish-failed
// keep today's red StatusPill (the alarm treatment must not change), and
// clientSignoff yields to ReviewStatusChip (which names who and for how long).
const NEXT_ACTOR_CHIP = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ring-1';
export function NextActorChip({ post, setup = null }) {
  const t = useT();
  const next = nextActorOf(post, setup);
  const chip = (cls, Icon, label) => (
    <span className={`${NEXT_ACTOR_CHIP} ${cls}`}>
      <Icon size={11} className="shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
  switch (next.key) {
    case 'done':
      return chip(PILL_TONES.ok, CheckCircle, t('state.short.posted'));
    // The lane states ARE the post's one status word (nextActorOf derives them from
    // postStatusWord), so the queue renders the very pill the planner card, List row and
    // detail header wear: "Blockiert" (amber, the lane named in the card text) or, on the
    // manual paste lane, "Du postest selbst" (sky).
    case 'blocked':
    case 'handOff':
      return <PostStatusPill post={post} setup={setup} />;
    case 'reApprove':
      // The edit invalidated the approval, however it was given, so the chip says only
      // what is next: approve again. (Its auto-approve note was a hover-only title.)
      return chip('bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/30', AlertTriangle, t('approval.editedSinceApproval'));
    case 'approve':
      return chip('bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/30', Clock, t('approval.pending'));
    case 'rejected':
      return chip('bg-red-500/15 text-red-700 dark:text-red-300 ring-red-500/30', OctagonX, t('approval.rejected'));
    case 'scheduled':
      // The state is "goes out at {date · time}" however it was approved; the label
      // already carries the date and time (fmtStampShort), so there is no hover-only
      // title. The auto-approve provenance stays in Activity (the approve row names the
      // policy actor) and in Settings, where the owner revokes the auto-approved backlog.
      return chip('bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-sky-500/30', CalendarClock, t('nextActor.scheduled', { time: fmtStampShort(next.at) }));
    case 'awaitingSlot':
      return chip('bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-sky-500/30', Clock, t('nextActor.awaitingSlot'));
    default:
      return null;
  }
}

// The ONE status pill a post wears: the Week card, the List row and the post detail
// header all render it, keyed by postStatusWord, so one post reads one word everywhere
// (the approval + schedule axes collapse into a single word; a lane that is not
// connected reads "Blockiert", the same word as the detail's delivery row). Attention
// words are saturated, settled words render quiet/ghost (ROW_STATUS_META). The label
// resolves from status.<key>; the lead icon is decorative (the label always carries the
// meaning, WCAG 1.4.1).
//
// `setup` defaults to the pendpost-health payload already in the query cache, read for the
// POST'S OWN project (lib/setupByClient.js): a post another project owns (All-projects mode
// stamps post.clientId) is judged by that project's connections, never the active one's. A
// cache-only read never starts a fetch of its own (App keeps the active project's health
// live, and fetches every project's in All-projects mode). Without a post it is the active
// project's setup. The Month chip glyph reads the same payload through the same hook, so
// chip and pill key one word.
export function useCachedSetup(setup, post = null) {
  return usePostSetup(post, { override: setup });
}

// `word`: a status key the caller already decided (the List row's approval pill beside its red
// reason line, format.js approvalWord); otherwise postStatusWord decides.
// `fit` (the Week card only): in a narrow card (its container under 7.5rem, ~75px cards in a
// 7-column week) the pill shows only its glyph as a small circle; the word stays its accessible
// name and rides a tooltip, so a long single word ("Veröffentlicht") never splits. The card sets
// container-type:inline-size.
export function PostStatusPill({ post, setup, word = null, fit = false }) {
  const t = useT();
  const lanes = useCachedSetup(setup, post);
  const key = word || postStatusWord(post, lanes);
  const meta = ROW_STATUS_META[key] || STATUS_PILL_META.scheduled;
  const Icon = meta.Icon;
  // Canon: no hover-only reveals, so the pill carries no native title. Each surface that
  // wears it says what matters as visible text: the Blockiert reason (queue card, planner
  // card + List row, detail delivery row), a failure's plain sentence (planner card + List
  // row, detail banner), the paste lane (detail delivery row "Du postest selbst") and the
  // per-platform power-off truth (detail). It never carries the raw failure line either.
  const label = t(`status.${key}`);
  const pill = (
    // max-w-full + a wrapping word: in a narrow container (a Week card at 375px) the pill
    // never runs past the card edge and never cuts its word ("Du postest selbs"); it wraps
    // to a second line instead. Where it has room it stays one line (shrink-0). A `fit` pill
    // (Week card) never wraps: a two-line pill reads as broken, so its word stays on one line,
    // ends in an ellipsis in a mid-width card (the Tip says it whole) and folds to the glyph
    // alone in a narrow one.
    <span className={`inline-flex min-w-0 max-w-full shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold leading-tight ring-1 ${fit ? '[@container(max-width:7.5rem)]:p-1' : ''} ${meta.cls}`}>
      {Icon ? <Icon size={11} className="shrink-0" aria-hidden="true" /> : null}
      <span data-pill-label="" className={`min-w-0 ${fit ? 'truncate [@container(max-width:7.5rem)]:sr-only' : ''}`}>{label}</span>
    </span>
  );
  return fit ? <Tip label={label}>{pill}</Tip> : pill;
}

// A neutral placeholder background sits behind every media element so a thumb
// reads as a calm loading tile (never a stark empty box) until the pixels paint;
// the opaque object-cover media covers it once loaded. A post with no media (or
// a media LOAD ERROR) resolves to an honest document-glyph tile - so a thumb NEVER
// shows the ambiguous bare grey square that read as broken/loading (US media fix).
// A text post's row shows a LaneTile instead of calling this at all.
export function CoverThumb({ media, image, className = '' }) {
  const [errored, setErrored] = useState(false);
  // One step above the card surface in both themes (INNER_SURFACE is zinc-100 / zinc-800), so
  // the tile never vanishes into a dark card.
  const PLACEHOLDER = 'bg-zinc-200/70 dark:bg-zinc-700/60';
  // media.cover = the render's local cover JPEG; image = a remote thumbnail
  // (e.g. a LinkedIn type:text article hero) for media-less posts.
  const src = media?.cover || image;
  if (src && !errored) {
    // Center crop: curated 9:16 covers carry info at top AND bottom; the old
    // object-top crop deterministically discarded the bottom quarter (UX-12).
    return <img src={src} alt="" loading="lazy" onError={() => setErrored(true)} className={`${PLACEHOLDER} object-cover ${className}`} />;
  }
  // Spec 05: a carousel has no single file (media.url/cover are BOTH null on the DTO),
  // so every branch below fell through to the "text post" tile and an album read as a
  // text post in the Planner, the Freigaben cards, the Published list and the run-now
  // dialog. Slide 1 IS the album's cover, so substitute it and let the existing
  // image/video branches do their normal job (a video album still gets a real frame).
  //
  // Keyed on the MEDIA (items[]), never on post.type - CoverThumb never sees the post.
  // That is what keeps the other call sites safe: every non-carousel DTO ships
  // items: [] (lib/plans.mjs) and an asset object has no items key at all. `find` on a
  // present url rather than items[0], so a missing slide 1 still shows a real picture
  // instead of a broken tile; the album-level "a slide is missing" fact is carried by
  // the preview and by platform_validate, not by a thumbnail.
  const slide = Array.isArray(media?.items) ? media.items.find((it) => it?.url) : null;
  const shown = slide ? { ...media, url: slide.url } : media;
  // A4: a still-image asset IS its own preview - render its bytes as an <img>, never
  // a <video> (a <video> pointed at a JPEG/PNG shows a broken/black box). This branch
  // sits BEFORE the video fallback so kind:'image' (or an image URL) always wins.
  const isImage = isImageMedia(shown);
  if (isImage && shown?.url && !errored) {
    return (
      <img
        src={shown.url}
        alt=""
        loading="lazy"
        onError={() => setErrored(true)}
        className={`${PLACEHOLDER} object-cover ${className}`}
      />
    );
  }
  // US-ASSET-13: no cover JPEG - paint a frame of the video's OWN content so a
  // media item always shows a real preview, never a bare icon. preload=metadata
  // keeps it light (metadata, not the whole file); we seek to 20% of the clip -
  // past blank intros/title cards, where there's real content - falling back to a
  // 0.1s nudge when the duration is unknown.
  if (shown?.url && !errored) {
    return (
      <video
        src={shown.url}
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
        onError={() => setErrored(true)}
        className={`bg-black/80 object-cover ${className}`}
      />
    );
  }
  // No media (or a media load failure): an intentional tile, not a broken/empty
  // square. Decorative - the row's title/caption carries the text.
  return (
    <div className={`grid place-items-center ${PLACEHOLDER} text-zinc-500 dark:text-zinc-400 ${className}`} aria-hidden="true">
      <FileText size={18} aria-hidden="true" />
    </div>
  );
}

// The media column's stand-in for a post with nothing to look at (a text post, a Radar
// reply): a quiet square in the thumbnail's own placeholder fill with the lane's glyph,
// muted. It keeps the media column, so every caption in a list starts on the same x.
// Decorative: the row's meta line names the lane to a screen reader.
export function LaneTile({ platform, size = 22, className = '' }) {
  const meta = PLATFORM_META[platform];
  const Icon = meta?.Icon || FileText;
  return (
    <span className={`grid aspect-square place-items-center rounded-lg bg-zinc-200/70 text-zinc-500 dark:bg-zinc-700/60 dark:text-zinc-400 ${className}`} aria-hidden="true" data-lane-tile={platform || ''}>
      <Icon size={size} aria-hidden="true" />
    </span>
  );
}

// The hero image shared by the link/article cards. Kept at the real 1.91:1 card
// ratio and object-cover so it always FILLS the frame - no letterbox bars, in
// either theme. The card's own max-width (below) bounds the height, so the hero
// never grows tall enough to force the dialog to scroll. Click to open the full
// image in the shared full-screen viewer (the same affordance the media preview
// uses). No image -> no hero at all: the card collapses to its title strip, which is
// how the platform renders an image-less card too (a ~150px grey box that only said
// "no preview image" was the biggest block on the card saying nothing).
function CardHero({ image }) {
  const t = useT();
  const [zoom, setZoom] = useState(false);
  if (!image) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setZoom(true)}
        aria-label={t('ui.player.expand')}
        className="group relative block w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <img src={image} alt="" className="aspect-[1.91/1] w-full object-cover" />
        <span className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur transition group-hover:opacity-100">
          <Maximize2 size={14} aria-hidden="true" />
        </span>
      </button>
      {zoom ? <MediaLightbox kind="image" src={image} onClose={() => setZoom(false)} /> : null}
    </>
  );
}

// A text post aimed at LinkedIn: the one shape the LinkedIn article card belongs to.
// Hoisted from Composer so every preview asks the same question.
export const isLinkedinArticle = ({ platforms, type }) => !!platforms?.includes('linkedin') && type === 'text';
// LinkedIn builds the card only when that post carries a link (the engine's article
// branch in scripts/linkedin-social.mjs); without one the image is dropped and the
// post goes out as plain text. Composer, PostPreview and the Freigaben card share it.
export const showsLinkedinCard = (post) => isLinkedinArticle(post) && Boolean(post.link);

// Read-only LinkedIn article-card preview (image + title + source host) so the
// owner can verify the card before approving. Mirrors the 1.91:1 ratio LinkedIn
// renders. Capped to a real card width (max-w-md) so the hero stays a modest,
// contained thumbnail - never a full-width banner that scrolls. Hoisted here (from
// Composer) so PostDetail reuses it too.
export function LinkCardPreview({ image, title, link }) {
  const t = useT();
  let host = '';
  try {
    host = link ? new URL(link).host.replace(/^www\./, '') : '';
  } catch {
    host = ''; // invalid/partial URL - skip the host chip, still render the card
  }
  return (
    <div className="w-full max-w-md space-y-1.5">
      <p className={EYEBROW}>{t('ui.linkCard.title')}</p>
      <div className={`overflow-hidden rounded-xl ring-1 ring-zinc-900/10 dark:ring-white/10 ${INNER_SURFACE}`}>
        <CardHero image={image} />
        <div className="space-y-0.5 p-3">
          <p className="break-words text-sm font-bold leading-snug text-zinc-800 dark:text-zinc-100">{title || 'pendpost'}</p>
          {host ? <p className="break-words text-[11px] tracking-tight text-zinc-600 dark:text-zinc-400">{host}</p> : null}
        </div>
      </div>
    </div>
  );
}

// Read-only article-card preview for the wordpress/ghost lanes: hero image +
// title + excerpt, mirroring LinkCardPreview's chrome. Deliberately NO markdown
// body rendering (v1): the card previews the listing shape, not the article.
export function ArticleCardPreview({ image, title, excerpt }) {
  const t = useT();
  return (
    <div className="w-full max-w-md space-y-1.5">
      <p className={EYEBROW}>{t('ui.articleCard.title')}</p>
      <div className={`overflow-hidden rounded-xl ring-1 ring-zinc-900/10 dark:ring-white/10 ${INNER_SURFACE}`}>
        <CardHero image={image} />
        <div className="space-y-0.5 p-3">
          <p className="break-words text-sm font-bold leading-snug text-zinc-800 dark:text-zinc-100">{title || t('ui.articleCard.noTitle')}</p>
          {excerpt ? <p className="break-words text-xs leading-snug text-zinc-600 dark:text-zinc-400">{excerpt}</p> : null}
        </div>
      </div>
    </div>
  );
}

function YoutubeMeta({ title, description, tags }) {
  const t = useT();
  return (
    <div className={`space-y-1.5 rounded-xl p-3 ${INNER_SURFACE}`}>
      <p className={EYEBROW}>YouTube</p>
      <p className="break-words text-sm font-bold leading-snug">{title || t('ui.youtube.noTitle')}</p>
      {/* break-words: a long unbroken token (e.g. a tracking URL in the description)
          must wrap, not force the whole two-column body to scroll sideways. */}
      {description ? <p className="whitespace-pre-wrap break-words text-xs text-zinc-600 dark:text-zinc-300">{description}</p> : null}
      {tags ? <p className="break-words text-[11px] text-zinc-600 dark:text-zinc-400">{tags}</p> : null}
    </div>
  );
}

// Per-type preview, the single place every post type renders its real shape.
// text -> blog article card, or the LinkedIn card for a LinkedIn post with a link,
// else nothing (never the old red "media missing" error);
// reel/story/youtube-short -> 9:16 video; video (FB/IG/LinkedIn feed) -> 4:5;
// youtube-longform -> 16:9 + a title/description/tags panel. object-contain so a
// source whose aspect does not match its type letterboxes instead of cropping.
// videoRef is threaded through for PostDetail's cover-frame scrubber.
export function PostPreview({ post, videoRef, onEdit }) {
  const t = useT();
  // The fullscreen viewer ({ kind, startAt }) and a fallback ref so the inline ->
  // fullscreen handoff works even where the parent passes no videoRef (Composer).
  const [lightbox, setLightbox] = useState(null);
  // Reel vs Grid: the reel plays full 9:16, but the profile grid center-crops the
  // cover. This lets the operator flip the preview to what the grid will actually
  // show. Only surfaced when gridCropInfo says a target platform crops (below).
  const [gridView, setGridView] = useState('reel');
  const localRef = useRef(null);
  const vRef = videoRef || localRef;
  if (post.type === 'text') {
    // A text post targeting a blog lane previews as its article card (hero +
    // title + excerpt).
    if (post.platforms?.includes('wordpress') || post.platforms?.includes('ghost')) {
      return <ArticleCardPreview image={post.image} title={post.title} excerpt={post.excerpt} />;
    }
    // The LinkedIn card only where LinkedIn builds one. Every other text post (an X or
    // Telegram post with a link, a LinkedIn post without one) publishes as plain text,
    // so there is no card to preview: render nothing, never a card captioned LinkedIn.
    return showsLinkedinCard(post) ? <LinkCardPreview image={post.image} title={post.title} link={post.link} /> : null;
  }
  // Flywheel: a MEDIA-LESS type has nothing to preview and must never reach the red
  // alert below. A poll and a nostr-longform carry a media object with a null url (the
  // DTO always emits one), so both fell straight through to "no media selected" in the
  // review dialog - the SAME type-blind fallthrough as text and then carousel, found by
  // the TYPES-iterating guard the moment it was written. Render nothing, exactly as a
  // pure text post already does: an empty column is honest, a red error is not.
  // (A richer article card for nostr-longform is a separate, additive question.)
  if (!postNeedsMedia(post)) return null;
  // Spec 05: an album has NO single media.url (both it and media.file derive from the
  // one file/path a carousel never has, see lib/plans.mjs), so it could never match the
  // branch below and fell through to the red "no media selected" alert - the exact bug
  // this fixes, and the SECOND time a per-type render stranded on a type-blind error
  // state (see the text-post note above). Guarded on the type and placed before the
  // media.url branch, so no other format's path is reordered.
  if (post.type === 'carousel') {
    const { aspect, ratio, mixed } = carouselFrame(post.media?.items);
    return <CarouselPreview items={post.media?.items} aspect={aspect} ratio={ratio} mixed={mixed} onEdit={onEdit} />;
  }
  if (post.media?.url) {
    const aspect = mediaAspect(post);
    const isYt = post.type === 'youtube-short' || post.type === 'youtube-longform';
    // A4: a still-image asset is its own preview - show it as an <img>, never a
    // <video> (which would paint a broken/black box at a JPEG). Same helper as
    // CoverThumb and the PostDetail cover gate, so the three cannot disagree.
    const isImage = isImageMedia(post.media);
    // FR4: the interactive-story sticker overlay rides on the 9:16 story/reel path
    // only; the relative wrapper anchors the absolutely-positioned layer.
    const showStickers = post.type === 'story' && Boolean(post.interactiveStory?.stickers?.length);
    // Hand the inline playhead to the viewer and pause the inline element so the
    // two <video>s never play (or sound) at once; the viewer resumes in place.
    const onExpandVideo = () => {
      const v = vRef.current;
      const at = v?.currentTime || 0;
      try {
        v?.pause();
      } catch {
        /* environments without real media playback */
      }
      setLightbox({ kind: 'video', startAt: at });
    };
    const onCloseLightbox = (at) => {
      if (lightbox?.kind === 'video' && typeof at === 'number' && vRef.current) {
        try {
          vRef.current.currentTime = at;
        } catch {
          /* element gone - nothing to resume */
        }
      }
      setLightbox(null);
    };
    // Grid-crop preview: the profile grid center-crops a tall cover to its tile
    // ratio (format.js gridCropInfo). Offer a Reel/Grid toggle ONLY when a target
    // platform actually crops, so a non-cropping post adds nothing.
    const grid = gridCropInfo(post);
    const showGrid = grid.cropped && gridView === 'grid';
    const cropLabels = grid.platforms.map((p) => PLATFORM_META[p.platform]?.label || p.platform).join(', ');
    const trimPct = Math.round((1 - grid.keptFraction) * 100);
    return (
      <div className="space-y-3">
        {grid.cropped ? (
          <div className="flex items-center justify-end">
            <Segmented
              label={t('ui.gridCrop.toggleAria')}
              value={gridView}
              onChange={setGridView}
              options={[
                { key: 'reel', label: t('ui.gridCrop.reel'), Icon: Smartphone },
                { key: 'grid', label: t('ui.gridCrop.grid'), Icon: LayoutGrid },
              ]}
            />
          </div>
        ) : null}
        <div className="relative">
          {showGrid ? (
            <CoverThumb media={post.media} className={`w-full ${grid.tightest.aspect} rounded-xl bg-black/80 ring-1 ring-zinc-900/10 dark:ring-white/10`} />
          ) : isImage ? (
            <button type="button" onClick={() => setLightbox({ kind: 'image' })} aria-label={t('ui.player.expand')} className="group relative block w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
              <img src={post.media.url} alt="" loading="lazy" className={`w-full ${aspect} rounded-xl bg-black/80 object-contain ring-1 ring-zinc-900/10 dark:ring-white/10`} />
              <span className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur transition group-hover:opacity-100">
                <Maximize2 size={15} aria-hidden="true" />
              </span>
            </button>
          ) : (
            <MediaPlayer src={post.media.url} poster={post.media.cover || null} aspect={aspect} videoRef={vRef} onExpand={onExpandVideo} />
          )}
          {showStickers && !showGrid ? <StoryStickerLayer interactiveStory={post.interactiveStory} /> : null}
        </div>
        {showGrid ? (
          <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
            {t('ui.gridCrop.caption', { platforms: cropLabels, percent: trimPct })}
            {grid.approximate ? <span>{' '}{t('ui.gridCrop.approx')}</span> : null}
          </p>
        ) : null}
        {isYt ? <YoutubeMeta title={post.title} description={post.description} tags={post.tags} /> : null}
        {lightbox ? (
          <MediaLightbox kind={lightbox.kind} src={post.media.url} poster={post.media.cover || null} startAt={lightbox.startAt || 0} onClose={onCloseLightbox} />
        ) : null}
      </div>
    );
  }
  // FR3: create-mode story/reel before an asset is chosen (post.media == null) is
  // an empty state, not an error - a neutral 9:16 placeholder at the same framing
  // as a loaded reel. The red error is reserved for a media-backed post whose
  // local file genuinely cannot resolve (post.media exists but its url is missing).
  if (post.media == null) {
    return (
      <div className="grid aspect-[9/16] w-full place-items-center rounded-xl bg-black/80 px-4 text-center ring-1 ring-zinc-900/10 dark:ring-white/10">
        <p className="text-xs font-medium text-zinc-300">{t('ui.preview.chooseVideo')}</p>
      </div>
    );
  }
  // A media-backed type with no resolvable local file genuinely cannot publish -
  // keep this as a real warning, and never render "undefined": if the file name is
  // itself absent, say so plainly instead of leaking a missing value.
  return (
    <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300">
      {post.media.file ? t('ui.preview.mediaNotFound', { file: post.media.file }) : t('ui.preview.noMedia')}
    </p>
  );
}

// U: the select-all control, lifted out of Freigaben so the approval queue and the media
// library share ONE control rather than growing a second selection idiom. The label keys
// are props because the two surfaces name their nouns differently; everything else about
// the behaviour (indeterminate middle state, hidden when there is nothing to select) is
// identical and now lives in one place.
// countKey: while a selection exists the label names the count in its place ("3 selected"), a
// polite live region, and the caller's onToggle clears.
export function SelectAllControl({ total, selectedCount, onToggle, allKey, clearKey, countKey }) {
  const t = useT();
  const allSelected = total > 0 && selectedCount === total;
  const someSelected = selectedCount > 0 && selectedCount < total;
  if (total === 0) return null;
  const label = countKey && selectedCount ? t(countKey, { n: selectedCount }) : allSelected ? t(clearKey) : t(allKey);
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-bold text-zinc-500 dark:text-zinc-400">
      <Checkbox checked={allSelected} indeterminate={someSelected} onChange={onToggle} aria-label={label} />
      {countKey && selectedCount ? <span role="status" aria-live="polite">{label}</span> : label}
    </label>
  );
}

// Read-only advisory blocker rows (B2). Surfaces platform_validate problems[]/
// warnings[] (and validate_media spec-check failures) as quiet rows so the owner
// learns of a bad post BEFORE publish - never at publish. Pure presentation: it
// NEVER calls a write, NEVER auto-retries, NEVER pokes a lane. A `problem` reads
// as a blocker (red), a `warning` / media spec-check reads as advisory (amber);
// each row carries an icon + sr-only severity word so it is not color-alone.
// Raw server problem strings (already English) pass through honestly; only the
// surrounding chrome/labels are localized. Clean (every platform ready, no
// problems/warnings, no failing checks) renders NOTHING - no false alarms.
//
// The component is non-interactive (no buttons/links), so it can sit inside the
// Composer's edit form or the PostDetail Platforms section without nesting a
// control inside another control (no interactive-in-interactive).
function BlockerRow({ severity, children, action = null }) {
  const t = useT();
  // Blocking vs advisory must read apart at a glance (brand/DESIGN.md: status is colour PLUS
  // icon, never colour alone). 'action' (a blocker: this cannot publish as it is) and
  // 'problem' carry the error ink with the octagon; 'warning' (an advisory hint that never
  // blocks) is neutral ink with the info glyph. The sr-only word says the same for a
  // screen reader. `action` is the row's own recovery (Edit / Setup), inside the row.
  const isBlocking = severity === 'problem' || severity === 'action';
  const Icon = isBlocking ? AlertOctagon : Info;
  const cls = isBlocking ? STATUS_INK.err : STATUS_INK.ok;
  const word = severity === 'problem' ? t('blockers.problemLabel') : severity === 'action' ? t('blockers.actionLabel') : t('blockers.warningLabel');
  return (
    <li className={`flex items-start gap-2 text-[11px] ${cls}`}>
      <Icon size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">{word}: </span>
      <span className="min-w-0 flex-1">
        {children}
        {action ? <>{' '}{action}</> : null}
      </span>
    </li>
  );
}

// Derive advisory rows from a validate_media result's spec checks. Only the
// FAILING checks surface (wrong resolution / bad codec / no faststart); a clean
// probe yields nothing. checks === null (no probe) yields nothing too.
// H1: an album folds N slides into this same shape and additionally carries `slides`
// (how many were judgeable) plus per-check `failing` counts. When they are present the
// count-bearing copy is used, because the single-media wording ("Resolution isn't a
// standard size") would imply ONE file and send the owner looking for the wrong thing.
// A single-media post has neither field and renders byte-identically to before.
function mediaCheckRows(checks, t) {
  if (!checks) return [];
  const n = checks.slides;
  const failing = checks.failing;
  const perSlide = typeof n === 'number' && failing;
  const row = (key, single, params) => (perSlide
    ? { key, text: t(`blockers.media.slides.${key}`, { count: failing[key === 'codec' ? 'codecOk' : key], n }) }
    : { key, text: t(single, params) });
  const rows = [];
  if (checks.resolution === 'other') rows.push(row('resolution', 'blockers.media.resolution', { resolution: checks.resolution }));
  if (checks.codecOk === false) rows.push(row('codec', 'blockers.media.codec'));
  if (checks.faststart === false) rows.push(row('faststart', 'blockers.media.faststart'));
  return rows;
}

// Pre-submit rows (spec 09) carry { code, text } instead of a plain string -
// platformValidate's engine-authored strings pass straight through (already
// English, see the file-header note above), but presubmit rows are genuinely
// LOCALIZED: `code` resolves to a `blockers.presubmit.<code>` string in both
// locale packs, with `text` (the platform-specific detail: a rule fragment, a
// subreddit-type word, a privacy enum value) as the {text} interpolation var
// for the codes that use one. A code with no matching key falls back to the
// raw code id (i18n's own missing-key convention), never a blank row.
//
// Some codes carry a RAW reddit enum as {text} (submissionType -> self/link,
// restricted -> the subreddit_type restricted/private); interpolating it verbatim
// would leak an English API token into the de-CH sentence, so each is mapped to a
// localized noun FIRST via its own locale sub-namespace, then passed as {text}. An
// unknown enum falls back to the raw value (never blank).
const PRESUBMIT_ENUM_NS = { submissionType: 'type', restricted: 'subredditType' };
function presubmitRowText(t, row) {
  let text = row.text || '';
  const ns = PRESUBMIT_ENUM_NS[row.code];
  if (ns && text) {
    const noun = t(`blockers.presubmit.${ns}.${text}`);
    if (noun && noun !== `blockers.presubmit.${ns}.${text}`) text = noun;
  }
  return t(`blockers.presubmit.${row.code}`, { text });
}

// Spec 39 §4j: platformValidate's problems[] stays the stable English engine face
// (REST/MCP bytes untouched); the PARALLEL problemCodes[i] localizes a coded row
// via the blockers.validate.* locale namespace with its params - presubmitRowText's exact
// idiom, one row at a time. Only the four spec-39-owned strings carry codes
// today; every uncoded row (problemCodes[i] === null) and every code missing
// from a locale pack falls back to the raw English problem, never a blank row.

// Does the blockers panel already carry a "Set up <lane>" link for this lane?
//
// ONE predicate, exported, because the answer is needed in two places: the panel that
// renders the link, and the delivery line above it that carries the same escape hatch as a
// glyph. Two controls for one job, ~120px apart, is the duplication - but the glyph cannot
// simply go: it is the FALLBACK for when platform-validate has no data (loading, offline,
// error), and dropping it then leaves the "not connected" fact with no way out at all.
// So the glyph yields only when the labelled link is genuinely there. Deriving that from
// the same source both components already read beats mirroring the panel's internals.
// PlatformBlockers keys its lane row AND its own render-nothing check off this predicate,
// so a needsSetup lane with no problems still draws the link: the answer is exactly
// "the panel renders the link", never a yes over an empty panel.
export function setupLinkOffered(platformValidate, platform, onNavigate) {
  if (typeof onNavigate !== 'function') return false;
  const rows = platformValidate?.ok ? platformValidate.platforms || {} : {};
  return Boolean(rows[platform]?.needsSetup);
}

// A blocker row's inline recovery: a small text action inside the row, with the shared
// 44px hit box (TAP_TARGET) so it stays easy to hit without painting a bigger control.
const ROW_ACTION = `${TAP_TARGET} inline-flex items-center gap-1 rounded font-bold text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light`;

// `onEdit` (optional) opens the editor on this post: every blocker row whose fix is content the
// owner can change (a caption over the cap, a missing image link, a subreddit rule) carries Edit
// inside the row, so no blocker is a dead end. A not-connected lane gets its Setup link
// instead; the Reddit flair row keeps its own control (onFix). Surfaces that ARE the editor
// (the Composer) pass no onEdit.
export function PlatformBlockers({ platformValidate, presubmit, validateMedia, approval, editedSinceApproval = false, showApproval = true, onNavigate, onFix, onEdit, className = '' }) {
  const t = useT();
  const platforms = platformValidate?.ok ? platformValidate.platforms || {} : {};
  // Spec 09: an optional second source, keyed the SAME way (platform -> {ready,
  // problems, warnings}) - merged into the identical per-platform rows below so
  // the panel stays ONE surface, two sources. Only reddit/tiktok ever populate it.
  const presubmitPlatforms = presubmit?.ok ? presubmit.platforms || {} : {};
  const platformKeys = [...new Set([...Object.keys(platforms), ...Object.keys(presubmitPlatforms)])];
  const entries = platformKeys.map((k) => [k, platforms[k] || { problems: [], warnings: [], needsSetup: false }]);
  const hasPlatformRows = entries.some(([k, v]) => {
    const pre = presubmitPlatforms[k];
    if (setupLinkOffered(platformValidate, k, onNavigate)) return true;
    return (v.problems?.length || 0) + (v.warnings?.length || 0) + (pre?.problems?.length || 0) + (pre?.warnings?.length || 0) > 0;
  });
  const mediaRows = mediaCheckRows(validateMedia?.ok ? validateMedia.checks : null, t);
  // A draft/pending/rejected post isn't a fault - it's just waiting for the owner's
  // approval. Surface it as ONE neutral line - but ONLY where the approval state isn't
  // already shown elsewhere (`showApproval`). PostDetail passes false: its header
  // PostStatusPill already carries the draft/rejected AND the "re-approve" states, so
  // repeating them here would just say the same thing twice.
  const waitingApproval = showApproval && Boolean(approval) && approval !== 'approved';
  // Approved but content changed after approval: the gate refuses it until re-approval.
  // A distinct one-line reason (not the plain "awaiting approval").
  const needsReApproval = showApproval && approval === 'approved' && editedSinceApproval === true;

  // Clean across the board AND already approved: render nothing (no false alarms).
  if (!hasPlatformRows && mediaRows.length === 0 && !waitingApproval && !needsReApproval) return null;

  return (
    <div className={`space-y-2 rounded-xl p-2.5 ${INNER_SURFACE} ${className}`}>
      <p className={EYEBROW}>{t('blockers.title')}</p>
      {waitingApproval ? (
        <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{t('blockers.awaitingApproval')}</p>
      ) : null}
      {needsReApproval ? (
        <p className="text-[11px] font-bold text-amber-700 dark:text-amber-300">{t('blockers.editedSinceApproval')}</p>
      ) : null}
      {entries.map(([platform, v]) => {
        const problems = v.problems || [];
        const warnings = v.warnings || [];
        // Spec 09: presubmit's own problems/warnings for this SAME platform,
        // localized (raw {code,text} -> a translated sentence). Always rendered
        // regardless of the setup-link collapse below - a subreddit/creator rule
        // is a distinct concern from "is this lane connected."
        const pre = presubmitPlatforms[platform];
        // A closed set of valid values gets a control, not advice (canon: prevent at the
        // control). The flair picker already exists - it is the Composer's, spec 16, with
        // its own loading / unavailable / empty / populated states - so this row OPENS it
        // rather than growing a second picker in a second place for the same job.
        const flairRow = (pre?.problems || []).find((r) => r.code === 'flairRequired');
        const showFlairFix = Boolean(flairRow) && typeof onFix === 'function';
        const presubmitProblems = (pre?.problems || [])
          .filter((r) => !(showFlairFix && r.code === 'flairRequired'))
          .map((r) => presubmitRowText(t, r));
        const presubmitWarnings = (pre?.warnings || []).map((r) => presubmitRowText(t, r));
        // The lane isn't connected: collapse the raw auth string to ONE amber
        // "{platform} verbinden" link that opens Setup (where the connect action lives),
        // instead of platform jargon the owner can't act on inline.
        const showSetupLink = setupLinkOffered(platformValidate, platform, onNavigate);
        // showFlairFix counts: the flair row is REMOVED from presubmitProblems (it renders
        // as the action below instead), so a lane whose only finding is the missing flair
        // would otherwise fall through this guard and drop the very control it needs. The
        // setup link counts the same way: a needsSetup lane with no problems keeps its link.
        if (!problems.length && !warnings.length && !presubmitProblems.length && !presubmitWarnings.length && !showFlairFix && !showSetupLink) return null;
        const meta = PLATFORM_META[platform];
        const Icon = meta?.Icon;
        const label = meta?.label || platform;
        // Each blocker row carries its OWN recovery inside the row, from that problem's `fix`
        // (recoveryFor): Edit, Setup, or none for a problem the owner waits out. Presubmit rows
        // (subreddit / creator rules) are content the editor fixes. A not-connected lane
        // already carries its Setup link, so its rows get no second action.
        const rowAction = (rec) => {
          if (rec === 'edit' && typeof onEdit === 'function') {
            return (
              <button type="button" onClick={onEdit} className={ROW_ACTION}>
                <Pencil size={11} aria-hidden="true" />
                {t('action.edit')}
              </button>
            );
          }
          if (rec === 'setup' && typeof onNavigate === 'function') {
            return (
              <button type="button" onClick={() => onNavigate('setup', platform)} className={ROW_ACTION}>
                <Wrench size={11} aria-hidden="true" />
                {t('nav.setup')}
              </button>
            );
          }
          return null;
        };
        return (
          <div key={platform} className="space-y-1">
            <p className="flex items-center gap-1.5 text-[11px] font-bold text-zinc-600 dark:text-zinc-300">
              {Icon ? <Icon size={12} className={meta.color} aria-hidden="true" /> : null}
              {label}
            </p>
            <ul className="space-y-1 pl-0.5">
              {/* PS-2: the presubmit rows (reddit/tiktok rules - "is this post
                  allowed", a concern distinct from "is this lane connected", per
                  the comment above) precede the connection-status row within each
                  severity tier, rather than the setup link jumping the queue. */}
              {showFlairFix ? (
                <li>
                  <button
                    type="button"
                    onClick={onFix}
                    className="inline-flex items-center gap-1.5 text-[11px] font-bold text-amber-700 transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-amber-300"
                  >
                    <Tag size={12} aria-hidden="true" />
                    {t('blockers.flairFix')}
                  </button>
                </li>
              ) : null}
              {presubmitProblems.map((p, i) => (
                <BlockerRow key={`pp-${i}`} severity="action" action={rowAction('edit')}>{p}</BlockerRow>
              ))}
              {showSetupLink ? (
                <li>
                  <button
                    type="button"
                    onClick={() => onNavigate('setup', platform)}
                    className="inline-flex items-center gap-1.5 text-[11px] font-bold text-amber-700 transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-amber-300"
                  >
                    <Wrench size={12} aria-hidden="true" />
                    {t('blockers.setupLink', { platform: label })}
                  </button>
                </li>
              ) : (
                // Remaining problems (media, caption, policy) are blockers: this cannot publish
                // as it is. Each carries its own recovery inline.
                problems.map((p, i) => (
                  <BlockerRow key={`p-${i}`} severity="action" action={rowAction(recoveryFor([p], [v.problemCodes?.[i]]))}>{validateRowText(t, p, v.problemCodes?.[i])}</BlockerRow>
                ))
              )}
              {presubmitWarnings.map((w, i) => (
                <BlockerRow key={`pw-${i}`} severity="warning">{w}</BlockerRow>
              ))}
              {warnings.map((w, i) => (
                <BlockerRow key={`w-${i}`} severity="warning">{validateRowText(t, w, v.warningCodes?.[i])}</BlockerRow>
              ))}
            </ul>
          </div>
        );
      })}
      {mediaRows.length ? (
        <ul className="space-y-1 pl-0.5">
          {mediaRows.map((r) => (
            <BlockerRow key={r.key} severity="warning">{r.text}</BlockerRow>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// Multi-select filter toggle chip (3g). active = in the selection; click toggles.
export function FilterChip({ active, onClick, icon: Icon, color, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 transition focus-visible:ring-2 focus-visible:ring-brand ${
        active
          ? 'bg-brand text-white ring-brand dark:bg-brand-light dark:text-zinc-900'
          : 'bg-zinc-200/50 text-zinc-600 ring-zinc-900/5 hover:bg-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-300 dark:ring-white/10 dark:hover:bg-zinc-700/60'
      }`}
    >
      {Icon ? <Icon size={12} className={active ? '' : color} aria-hidden="true" /> : null}
      {label}
    </button>
  );
}

export function Skeleton({ className = '' }) {
  return <div className={`animate-pulse rounded-xl bg-zinc-300/40 dark:bg-zinc-700/40 ${className}`} />;
}

// A segmented toggle: single-tone, the active segment carries the accent. Lifted from
// Published.jsx (it used it for the view + range controls) so Radar's Discovered / On your
// posts toggle reuses the SAME control rather than a second visual answer to one job. Each
// option is { key, label, Icon? }; aria-pressed marks the active segment on the button itself.
// `disabled` (spec 50 row 1e): the whole control is inert while the system behind it
// cannot act (Radar off). aria-disabled marks the group for assistive tech and each
// segment is really disabled, so the choice is never offered where it would do nothing.
export function Segmented({ label, value, options, onChange, disabled = false }) {
  return (
    <div className={`flex items-center rounded-xl bg-zinc-200/60 p-0.5 dark:bg-zinc-800/60 ${disabled ? 'opacity-50' : ''}`} role="group" aria-label={label} aria-disabled={disabled || undefined}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          disabled={disabled}
          aria-pressed={value === o.key}
          className={`flex items-center gap-1 rounded-[10px] px-2.5 py-1 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${TAP_TARGET} ${
            value === o.key ? 'bg-white text-brand shadow dark:bg-zinc-700 dark:text-brand-light' : 'text-zinc-600 dark:text-zinc-400'
          }`}
        >
          {o.Icon ? <o.Icon size={13} aria-hidden="true" /> : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// The four shared tokens now live at ui/tokens.js (a leaf both ui.jsx and the ui/
// primitives can depend on, so a primitive needing one cannot form an import cycle).
// Imported at the top and re-exported here, so every existing `from '../ui.jsx'` import
// keeps working unchanged. It has to be an import + export pair, not a bare
// `export ... from`: a re-export creates no local binding, so this file's own uses of
// EYEBROW/INNER_SURFACE would throw at render time.
export { INNER_SURFACE, FIELD_SURFACE, DISABLED_PRIMARY, EYEBROW, FIELD, FIELD_ERR, FIELD_MULTILINE };

// The single section-header shape shared across Settings and its Radar sub-sections:
// a title, an optional discoverable "?" explainer (the house Tip, keyboard/SR
// reachable - never native title=), and an optional right-aligned action slot (an
// "Add" button, a status chip). It replaces the old title + permanently-stacked
// subtitle paragraph so every section reads as one design language and the why-text
// stays a hover away instead of crowding the surface.
export function SectionHeading({ title, tip, action }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <h3 className="text-sm font-bold">{title}</h3>
        {tip ? (
          <Tip label={tip}>
            <button type="button" aria-label={t('settings.fieldHelp', { field: title })} className="rounded text-zinc-500 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-300">
              <HelpCircle size={13} aria-hidden="true" />
            </button>
          </Tip>
        ) : null}
      </div>
      {action ? <div className="ml-auto shrink-0">{action}</div> : null}
    </div>
  );
}

// US-FR-05: the time-chip colour legend. Driven by the canonical TIME_CHIP_META so
// the three tones (green/amber/red) and their icons can NEVER drift from the
// Planner time-chips; colour is always paired with an icon + an accessible name
// (WCAG 1.4.1). Surfaced from a "?" popover, never an always-on bar. The title
// (statusLegend.title) is scoped explicitly to the time-chip overlay so it does
// not imply it also decodes the StatusPill tones or the Status filter labels.
// approved now reads NEUTRAL (the chip dropped its green - color is spent only on
// attention), so its legend swatch is a quiet zinc; amber/red stay saturated.
const LEGEND_TONE_CLS = {
  approved: 'text-zinc-500 dark:text-zinc-400',
  'needs-approval': 'text-amber-700 dark:text-amber-400',
  halted: 'text-red-600 dark:text-red-400',
};
const LEGEND_KEY = { approved: 'statusLegend.approved', 'needs-approval': 'statusLegend.needsApproval', halted: 'statusLegend.halted' };
export function StatusLegend() {
  const t = useT();
  return (
    <div className="space-y-1.5">
      <p className={EYEBROW}>{t('statusLegend.title')}</p>
      <ul className="space-y-1">
        {Object.entries(TIME_CHIP_META).map(([tone, meta]) => {
          const Icon = meta.Icon;
          return (
            <li key={tone} className="flex items-center gap-2 text-[11px] text-zinc-600 dark:text-zinc-300">
              <Icon size={13} className={`shrink-0 ${LEGEND_TONE_CLS[tone] || 'text-zinc-500'}`} aria-hidden="true" />
              <span>{t(LEGEND_KEY[tone] || `timeChip.${tone}`)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Shared focus trap (A1, WCAG 2.2 AA): while `active`, cycle Tab/Shift+Tab among
// the focusable descendants of `containerRef` so keyboard focus cannot leave an
// open aria-modal panel. It BAILS whenever an in-panel Radix popover trigger reports
// data-state="open": that popover portals its content to document.body and owns its
// own Tab handling, so trapping would fight it. The listener lives on the container,
// so Tab events originating inside the portaled popover never reach it anyway - the
// bail only covers focus resting on the in-panel trigger.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableWithin(el) {
  // jsdom-safe: attribute filtering only, no offsetParent / layout reads.
  return Array.from(el.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    (n) => n.getAttribute('aria-hidden') !== 'true' && n.tabIndex !== -1,
  );
}

export function useFocusTrap(containerRef, active = true) {
  useEffect(() => {
    const el = containerRef.current;
    if (!active || !el) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Tab') return;
      // A nested Radix popover is open - let it own Tab within its portaled content.
      if (el.querySelector('[data-state="open"]')) return;
      const items = focusableWithin(el);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const a = document.activeElement;
      if (e.shiftKey) {
        if (a === first || !el.contains(a)) {
          e.preventDefault();
          last.focus();
        }
      } else if (a === last || !el.contains(a)) {
        e.preventDefault();
        first.focus();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [containerRef, active]);
}

// Shared slide-over behavior (UX-04): focus the panel on open, close on Escape,
// restore focus to the trigger on close, and trap Tab within the panel (A1).
// Spread the returned props onto the panel element.
export function useSlideOver(onClose) {
  const panelRef = useRef(null);
  const restoreRef = useRef(null);
  useFocusTrap(panelRef, true);
  useEffect(() => {
    restoreRef.current = document.activeElement;
    panelRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      restoreRef.current?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { ref: panelRef, tabIndex: -1 };
}

// The shared right slide-over chrome: backdrop + focusable animated panel.
export function SlideOver({ onClose, label, width = 'w-[440px]', children }) {
  const t = useT();
  const panelProps = useSlideOver(onClose);
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={label}>
      <button type="button" aria-label={t('ui.action.close')} onClick={onClose} className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        {...panelProps}
        className={`glass-panel absolute right-0 top-0 flex h-full ${width} max-w-full flex-col gap-5 overflow-y-auto rounded-l-2xl p-5 outline-none animate-slide-in motion-reduce:animate-none`}
      >
        {children}
      </div>
    </div>
  );
}

// Centered modal popup chrome: full-page backdrop + focusable animated panel,
// portaled to <body> so a `position: fixed` panel always resolves against the
// viewport — never against an ancestor that establishes a containing block via
// transform/filter/backdrop-filter (e.g. the glass-panel header). Reuses
// useSlideOver for focus trap / Escape / restore. Children flex in a column; a
// scrollable child should carry `min-h-0 flex-1 overflow-y-auto`.
export function Modal({ onClose, label, width = 'max-w-lg', children }) {
  const t = useT();
  const panelProps = useSlideOver(onClose);
  return createPortal(
    <div className="fixed inset-0 z-[60] grid place-items-center p-4" role="dialog" aria-modal="true" aria-label={label}>
      <button type="button" aria-label={t('ui.action.close')} onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      {/* Solid, opaque dialog surface - no translucency, for maximum clarity. */}
      <div
        {...panelProps}
        data-dialog-panel="true"
        className={`relative flex max-h-[85vh] w-full ${width} flex-col gap-5 overflow-hidden rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl outline-none animate-slide-in motion-reduce:animate-none dark:border-white/10 dark:bg-zinc-900`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function CloseButton({ onClose, label }) {
  return (
    <Tip label={label}>
      <button
        type="button"
        onClick={onClose}
        aria-label={label}
        // TAP_TARGET: the 30px glyph keeps its look, the finger gets 44px (canon Tier 2).
        className={`rounded-full p-1.5 text-zinc-500 transition hover:bg-zinc-200/60 focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:bg-zinc-700/60 ${TAP_TARGET}`}
      >
        <X size={18} aria-hidden="true" />
      </button>
    </Tip>
  );
}

// Subtle SVG grain to avoid the flat "plastic" look (DESIGN.md texture rule).
export function NoiseOverlay() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 opacity-[0.03] mix-blend-overlay"
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E\")",
      }}
    />
  );
}

export function AuroraBackground() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div className="absolute -top-32 -left-32 h-96 w-96 rounded-full bg-cyan-400/20 dark:bg-cyan-500/10 blur-3xl animate-blob motion-reduce:animate-none" />
      <div className="absolute top-1/3 -right-24 h-80 w-80 rounded-full bg-blue-400/15 dark:bg-blue-500/10 blur-3xl animate-blob-slow motion-reduce:animate-none" />
      <div className="absolute -bottom-24 left-1/3 h-72 w-72 rounded-full bg-teal-400/15 dark:bg-teal-500/10 blur-3xl animate-blob motion-reduce:animate-none" />
    </div>
  );
}
