import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Facebook, Instagram, Linkedin, Youtube, X, AlertOctagon, AlertTriangle, Wrench, Maximize2 } from 'lucide-react';
import { STATE_META, APPROVAL_META, TIME_CHIP_META, STATUS_PILL_META, postDisplayStatusKey, mediaAspect } from '../lib/format.js';
import { StoryStickerLayer } from './ui/StoryStickerLayer.jsx';
import { MediaPlayer } from './ui/MediaPlayer.jsx';
import { MediaLightbox } from './ui/MediaLightbox.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { useT } from '../lib/i18n.js';

// The X (Twitter) brand glyph. lucide-react's `X` is the close/cross icon, and
// lucide dropped brand marks, so the wordmark is an inline SVG here. fill follows
// currentColor so the theme-aware PLATFORM_META color (near-black in light, near-
// white in dark) drives it, exactly like the other brand icons take their hex.
function XLogo({ size = 16, className = '', ...props }) {
  const labelled = props['aria-label'];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : true}
      {...props}
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

// Telegram + Discord brand marks (lucide dropped brand glyphs, same as X above).
// fill follows currentColor so the theme-aware PLATFORM_META color drives them.
function TelegramLogo({ size = 16, className = '', ...props }) {
  const labelled = props['aria-label'];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} role={labelled ? 'img' : undefined} aria-hidden={labelled ? undefined : true} {...props}>
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}
function DiscordLogo({ size = 16, className = '', ...props }) {
  const labelled = props['aria-label'];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} role={labelled ? 'img' : undefined} aria-hidden={labelled ? undefined : true} {...props}>
      <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  );
}
// Reddit + Pinterest + TikTok brand marks (same inline pattern; lucide has no brand glyphs).
function RedditLogo({ size = 16, className = '', ...props }) {
  const labelled = props['aria-label'];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} role={labelled ? 'img' : undefined} aria-hidden={labelled ? undefined : true} {...props}>
      <path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z" />
    </svg>
  );
}
function PinterestLogo({ size = 16, className = '', ...props }) {
  const labelled = props['aria-label'];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} role={labelled ? 'img' : undefined} aria-hidden={labelled ? undefined : true} {...props}>
      <path d="M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.663.967-2.911 2.168-2.911 1.024 0 1.518.769 1.518 1.688 0 1.029-.653 2.567-.992 3.992-.285 1.193.6 2.165 1.775 2.165 2.128 0 3.768-2.245 3.768-5.487 0-2.861-2.063-4.869-5.008-4.869-3.41 0-5.409 2.562-5.409 5.199 0 1.033.394 2.143.889 2.741.099.12.112.225.085.345-.09.375-.293 1.199-.334 1.363-.053.225-.172.271-.402.165-1.495-.69-2.433-2.878-2.433-4.646 0-3.776 2.748-7.252 7.92-7.252 4.158 0 7.392 2.967 7.392 6.923 0 4.135-2.607 7.462-6.233 7.462-1.214 0-2.354-.629-2.758-1.379l-.749 2.848c-.269 1.045-1.004 2.352-1.498 3.146 1.123.345 2.306.535 3.55.535 6.607 0 11.985-5.365 11.985-11.987C23.97 5.39 18.592.026 11.985.026L12.017 0z" />
    </svg>
  );
}
function TiktokLogo({ size = 16, className = '', ...props }) {
  const labelled = props['aria-label'];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} role={labelled ? 'img' : undefined} aria-hidden={labelled ? undefined : true} {...props}>
      <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" />
    </svg>
  );
}

export const PLATFORM_META = {
  facebook: { Icon: Facebook, color: 'text-[#1877F2]', label: 'Facebook' },
  instagram: { Icon: Instagram, color: 'text-[#E4405F]', label: 'Instagram' },
  linkedin: { Icon: Linkedin, color: 'text-[#0A66C2]', label: 'LinkedIn' },
  youtube: { Icon: Youtube, color: 'text-[#FF0000]', label: 'YouTube' },
  x: { Icon: XLogo, color: 'text-zinc-900 dark:text-zinc-100', label: 'X' },
  telegram: { Icon: TelegramLogo, color: 'text-[#229ED9]', label: 'Telegram' },
  discord: { Icon: DiscordLogo, color: 'text-[#5865F2]', label: 'Discord' },
  reddit: { Icon: RedditLogo, color: 'text-[#FF4500]', label: 'Reddit' },
  pinterest: { Icon: PinterestLogo, color: 'text-[#E60023]', label: 'Pinterest' },
  tiktok: { Icon: TiktokLogo, color: 'text-zinc-900 dark:text-zinc-100', label: 'TikTok' },
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
  const cls = meta?.cls || 'bg-zinc-500/15 text-zinc-500 ring-zinc-500/30';
  const Icon = meta?.Icon;
  // Known states resolve their (short/long) label from the pack; an unknown state
  // falls back to its raw key rather than a stray "state.x" id.
  const label = meta ? t(short ? `state.short.${state}` : `state.${state}`) : state;
  // Power-off legibility (W1): the schedule states that carry a one-line tip
  // (scheduled-native, waiting-due, overdue) get it as a native hover title;
  // states with no `state.tip.<x>` key resolve t() back to the raw key, so we
  // detect that and set no title rather than showing a stray id.
  const tipKey = `state.tip.${state}`;
  const tip = t(tipKey);
  const title = tip === tipKey ? undefined : tip;
  // The icon is decorative (aria-hidden, shrink-0) and only the label truncates, so
  // the compact `short` pill keeps both glyph and word without crowding (WCAG 1.4.1).
  return (
    <span title={title} className={`inline-flex min-w-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${cls}`}>
      {Icon ? <Icon size={11} className="shrink-0" aria-hidden="true" /> : null}
      <span className="truncate">{label}</span>
    </span>
  );
}

export function ApprovalPill({ approval }) {
  const t = useT();
  const meta = APPROVAL_META[approval];
  if (!meta || approval === 'approved') return null;
  const Icon = meta.Icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${meta.cls}`}>
      {Icon ? <Icon size={11} className="shrink-0" aria-hidden="true" /> : null}
      {t(`approval.${approval}`)}
    </span>
  );
}

// Triage-first: the ONE status pill the Planner cards render, collapsing the
// approval + schedule axes into a single bucket (postStatusKey) so a card no longer
// shows a StatusPill AND an ApprovalPill saying the same thing. Attention buckets are
// saturated, settled buckets render quiet/ghost (STATUS_PILL_META). The label
// resolves from the pack under the status.<bucket> keys (already present for the
// Status filter); the lead icon is decorative (the label always carries the meaning,
// WCAG 1.4.1). The richer two-axis StatusPill/ApprovalPill
// stay in use on the detail/approval surfaces (PostDetail, Freigaben), where both
// axes legitimately matter.
export function PostStatusPill({ post }) {
  const t = useT();
  const key = postDisplayStatusKey(post);
  const meta = STATUS_PILL_META[key] || STATUS_PILL_META.scheduled;
  const Icon = meta.Icon;
  // Power-off legibility (W1): the planner card collapses scheduled-native and
  // waiting-due into one 'scheduled' bucket, so its pill cannot show whether a
  // post fires with the computer off. A one-line tip on the 'scheduled' bucket
  // points the owner to the post for the per-platform truth. Other buckets have
  // no `status.tip.<x>` key, so t() returns the raw key and we set no title.
  const tipKey = `status.tip.${key}`;
  const tip = t(tipKey);
  const title = tip === tipKey ? undefined : tip;
  return (
    <span title={title} className={`inline-flex min-w-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${meta.cls}`}>
      {Icon ? <Icon size={11} className="shrink-0" aria-hidden="true" /> : null}
      <span className="truncate">{t(`status.${key}`)}</span>
    </span>
  );
}

export function CoverThumb({ media, image, className = '' }) {
  // media.cover = the render's local cover JPEG; image = a remote thumbnail
  // (e.g. a LinkedIn type:text article hero) for media-less posts.
  const src = media?.cover || image;
  if (src) {
    // Center crop: curated 9:16 covers carry info at top AND bottom; the old
    // object-top crop deterministically discarded the bottom quarter (UX-12).
    return <img src={src} alt="" loading="lazy" className={`object-cover ${className}`} />;
  }
  // A4: a still-image asset IS its own preview - render its bytes as an <img>, never
  // a <video> (a <video> pointed at a JPEG/PNG shows a broken/black box). This branch
  // sits BEFORE the video fallback so kind:'image' (or an image URL) always wins.
  const isImage = media?.kind === 'image' || /\.(jpe?g|png)$/i.test(media?.url || '');
  if (isImage && media?.url) {
    return (
      <img
        src={media.url}
        alt=""
        loading="lazy"
        onError={(e) => { e.currentTarget.style.display = 'none'; }}
        className={`object-cover ${className}`}
      />
    );
  }
  // US-ASSET-13: no cover JPEG - paint a frame of the video's OWN content so a
  // media item always shows a real preview, never a bare icon. preload=metadata
  // keeps it light (metadata, not the whole file); we seek to 20% of the clip -
  // past blank intros/title cards, where there's real content - falling back to a
  // 0.1s nudge when the duration is unknown. Falls back to a calm neutral tile
  // only when there is no media at all (e.g. a text post).
  if (media?.url) {
    return (
      <video
        src={media.url}
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
        className={`bg-black/80 object-cover ${className}`}
      />
    );
  }
  return <div className={`bg-zinc-200/70 dark:bg-zinc-800/60 ${className}`} aria-hidden="true" />;
}

// Read-only LinkedIn article-card preview (image + title + source host) so the
// owner can verify the card before approving. Mirrors the 1.91:1 ratio
// LinkedIn renders. Hoisted here (from Composer) so PostDetail reuses it too.
export function LinkCardPreview({ image, title, link }) {
  const t = useT();
  let host = '';
  try {
    host = link ? new URL(link).host.replace(/^www\./, '') : '';
  } catch {
    host = ''; // invalid/partial URL - skip the host chip, still render the card
  }
  return (
    <div className="space-y-1.5">
      <p className={EYEBROW}>{t('ui.linkCard.title')}</p>
      <div className={`overflow-hidden rounded-xl ring-1 ring-zinc-900/10 dark:ring-white/10 ${INNER_SURFACE}`}>
        {image ? (
          <img src={image} alt="" className="aspect-[1.91/1] w-full object-cover" />
        ) : (
          <div className="flex aspect-[1.91/1] w-full items-center justify-center border-b border-dashed border-zinc-300 bg-zinc-200/40 px-3 text-center text-[11px] text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800/40 dark:text-zinc-400">
            {t('ui.linkCard.noImage')}
          </div>
        )}
        <div className="space-y-0.5 p-3">
          <p className="text-sm font-bold leading-snug text-zinc-800 dark:text-zinc-100">{title || 'pendpost'}</p>
          {host ? <p className="text-[11px] tracking-tight text-zinc-400 dark:text-zinc-500">{host}</p> : null}
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
      <p className="text-sm font-bold leading-snug">{title || t('ui.youtube.noTitle')}</p>
      {description ? <p className="whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-300">{description}</p> : null}
      {tags ? <p className="text-[11px] text-zinc-400 dark:text-zinc-500">{tags}</p> : null}
    </div>
  );
}

// Per-type preview, the single place every post type renders its real shape.
// text -> LinkedIn article card (never the old red "media missing" error);
// reel/story/youtube-short -> 9:16 video; video (FB/IG/LinkedIn feed) -> 4:5;
// youtube-longform -> 16:9 + a title/description/tags panel. object-contain so a
// source whose aspect does not match its type letterboxes instead of cropping.
// videoRef is threaded through for PostDetail's cover-frame scrubber.
export function PostPreview({ post, videoRef }) {
  const t = useT();
  // The fullscreen viewer ({ kind, startAt }) and a fallback ref so the inline ->
  // fullscreen handoff works even where the parent passes no videoRef (Composer).
  const [lightbox, setLightbox] = useState(null);
  const localRef = useRef(null);
  const vRef = videoRef || localRef;
  if (post.type === 'text') {
    return <LinkCardPreview image={post.image} title={post.title} link={post.link} />;
  }
  if (post.media?.url) {
    const aspect = mediaAspect(post);
    const isYt = post.type === 'youtube-short' || post.type === 'youtube-longform';
    // A4: a still-image asset is its own preview - show it as an <img>, never a
    // <video> (which would paint a broken/black box at a JPEG). Mirrors CoverThumb.
    const isImage = post.media.kind === 'image' || /\.(jpe?g|png)$/i.test(post.media.url || '');
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
    return (
      <div className="space-y-3">
        <div className="relative">
          {isImage ? (
            <button type="button" onClick={() => setLightbox({ kind: 'image' })} aria-label={t('ui.player.expand')} className="group relative block w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
              <img src={post.media.url} alt="" loading="lazy" className={`w-full ${aspect} rounded-xl bg-black/80 object-contain ring-1 ring-zinc-900/10 dark:ring-white/10`} />
              <span className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur transition group-hover:opacity-100">
                <Maximize2 size={15} aria-hidden="true" />
              </span>
            </button>
          ) : (
            <MediaPlayer src={post.media.url} poster={post.media.cover || null} aspect={aspect} videoRef={vRef} onExpand={onExpandVideo} />
          )}
          {showStickers ? <StoryStickerLayer interactiveStory={post.interactiveStory} /> : null}
        </div>
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
function BlockerRow({ severity, children }) {
  const t = useT();
  // 'problem' = hard red (kept for callers that still need it); 'action' = amber
  // "needs action" (the owner has a fix); 'warning' = amber advisory. The publish
  // panel uses action/warning only - a draft is shown by its badge, never as red.
  const isProblem = severity === 'problem';
  const isAction = severity === 'action';
  const Icon = isProblem ? AlertOctagon : AlertTriangle;
  const cls = isProblem
    ? 'text-red-600 dark:text-red-300'
    : 'text-amber-600 dark:text-amber-300';
  const word = isProblem ? t('blockers.problemLabel') : isAction ? t('blockers.actionLabel') : t('blockers.warningLabel');
  return (
    <li className={`flex items-start gap-2 text-[11px] ${cls}`}>
      <Icon size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">{word}: </span>
      <span className="min-w-0 flex-1">{children}</span>
    </li>
  );
}

// Derive advisory rows from a validate_media result's spec checks. Only the
// FAILING checks surface (wrong resolution / bad codec / no faststart); a clean
// probe yields nothing. checks === null (no probe) yields nothing too.
function mediaCheckRows(checks, t) {
  if (!checks) return [];
  const rows = [];
  if (checks.resolution === 'other') rows.push({ key: 'resolution', text: t('blockers.media.resolution', { resolution: checks.resolution }) });
  if (checks.codecOk === false) rows.push({ key: 'codec', text: t('blockers.media.codec') });
  if (checks.faststart === false) rows.push({ key: 'faststart', text: t('blockers.media.faststart') });
  return rows;
}

export function PlatformBlockers({ platformValidate, validateMedia, approval, onNavigate, className = '' }) {
  const t = useT();
  const platforms = platformValidate?.ok ? platformValidate.platforms || {} : {};
  const entries = Object.entries(platforms);
  const hasPlatformRows = entries.some(([, v]) => (v.problems?.length || 0) + (v.warnings?.length || 0) > 0);
  const mediaRows = mediaCheckRows(validateMedia?.ok ? validateMedia.checks : null, t);
  // A draft/pending/rejected post isn't a fault - it's just waiting for the owner's
  // approval (the status badge already names that state). Surface it as ONE neutral
  // line, never a red per-lane blocker.
  const waitingApproval = Boolean(approval) && approval !== 'approved';

  // Clean across the board AND already approved: render nothing (no false alarms).
  if (!hasPlatformRows && mediaRows.length === 0 && !waitingApproval) return null;

  return (
    <div className={`space-y-2 rounded-xl p-2.5 ${INNER_SURFACE} ${className}`}>
      <p className={EYEBROW}>{t('blockers.title')}</p>
      {waitingApproval ? (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('blockers.awaitingApproval')}</p>
      ) : null}
      {entries.map(([platform, v]) => {
        const problems = v.problems || [];
        const warnings = v.warnings || [];
        if (!problems.length && !warnings.length) return null;
        const meta = PLATFORM_META[platform];
        const Icon = meta?.Icon;
        const label = meta?.label || platform;
        // The lane isn't connected: collapse the raw auth string to ONE amber
        // "Set up <lane>" link that opens Setup (where the connect action lives),
        // instead of platform jargon the owner can't act on inline.
        const showSetupLink = v.needsSetup && typeof onNavigate === 'function';
        return (
          <div key={platform} className="space-y-1">
            <p className="flex items-center gap-1.5 text-[11px] font-bold text-zinc-600 dark:text-zinc-300">
              {Icon ? <Icon size={12} className={meta.color} aria-hidden="true" /> : null}
              {label}
            </p>
            <ul className="space-y-1 pl-0.5">
              {showSetupLink ? (
                <li>
                  <button
                    type="button"
                    onClick={() => onNavigate('setup')}
                    className="inline-flex items-center gap-1.5 text-[11px] font-bold text-amber-600 transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-amber-300"
                  >
                    <Wrench size={12} aria-hidden="true" />
                    {t('blockers.setupLink', { platform: label })}
                  </button>
                </li>
              ) : (
                // Remaining problems (media, caption, policy) are amber "needs action"
                // rows the owner can fix - never a generic red error.
                problems.map((p, i) => (
                  <BlockerRow key={`p-${i}`} severity="action">{p}</BlockerRow>
                ))
              )}
              {warnings.map((w, i) => (
                <BlockerRow key={`w-${i}`} severity="warning">{w}</BlockerRow>
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

// Light-mode hairline + dark ring for inner surfaces sitting on glass panels
// (UX-01: white-on-white alpha alone loses every edge in light mode).
export const INNER_SURFACE = 'bg-white/60 ring-1 ring-zinc-900/5 dark:bg-zinc-800/40 dark:ring-white/10';

// DS-1: the single eyebrow micro-label token. Sentence case (never all-caps),
// tiny, bold, tight tracking - the anti-slop replacement for the retired
// all-caps eyebrow class (roadmap.md DS-1; brand-guide.md "No all-caps
// labels"). Every eyebrow across the dashboard resolves to this.
export const EYEBROW = 'text-[11px] font-bold tracking-tight text-zinc-400 dark:text-zinc-500';

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
  'needs-approval': 'text-amber-600 dark:text-amber-400',
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
      <button type="button" aria-label={t('ui.action.close')} onClick={onClose} className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        {...panelProps}
        className={`glass-panel relative flex max-h-[85vh] w-full ${width} flex-col gap-5 overflow-hidden rounded-2xl p-5 outline-none animate-slide-in motion-reduce:animate-none`}
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
        className="rounded-full p-1.5 text-zinc-500 transition hover:bg-zinc-200/60 focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:bg-zinc-700/60"
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
