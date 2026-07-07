import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Facebook, Instagram, Linkedin, Youtube, X, AlertOctagon, AlertTriangle, Wrench, Maximize2, FileText } from 'lucide-react';
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
// Wave-2 brand marks (same inline pattern). Mastodon + WordPress are the official
// simple-icons glyphs; Ghost has no fill-friendly brand mark (its logo is a wordmark),
// so a plain ghost silhouette stands in; Nostr has no canonical logo at all, so a
// minimal asterisk-node emblem (the protocol's relay-fanout shape) stands in; GBP
// uses a storefront (Material `storefront`, Apache-2.0) - the product's own icon.
function MastodonLogo({ size = 16, className = '', ...props }) {
  const labelled = props['aria-label'];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} role={labelled ? 'img' : undefined} aria-hidden={labelled ? undefined : true} {...props}>
      <path d="M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.004C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.309C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.661 9.143c.074 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 0 0 .023-.043v-1.809a.052.052 0 0 0-.02-.041.053.053 0 0 0-.046-.01 20.282 20.282 0 0 1-4.709.545c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 0 1-.319-1.433.053.053 0 0 1 .066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.224-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.668-1.67 1.977v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.5 2.962 1.498l.638 1.06.638-1.06c.66-.999 1.65-1.498 2.96-1.498 1.13 0 2.043.395 2.74 1.164.675.77 1.012 1.81 1.012 3.12z" />
    </svg>
  );
}
function WordPressLogo({ size = 16, className = '', ...props }) {
  const labelled = props['aria-label'];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} role={labelled ? 'img' : undefined} aria-hidden={labelled ? undefined : true} {...props}>
      <path d="M21.469 6.825c.84 1.537 1.318 3.3 1.318 5.175 0 3.979-2.156 7.456-5.363 9.325l3.295-9.527c.615-1.54.82-2.771.82-3.864 0-.405-.026-.78-.07-1.11m-7.981.105c.647-.03 1.232-.105 1.232-.105.582-.075.514-.93-.067-.899 0 0-1.755.135-2.88.135-1.064 0-2.85-.15-2.85-.15-.585-.03-.661.855-.075.885 0 0 .54.061 1.125.09l1.68 4.605-2.37 7.08L5.354 6.9c.649-.03 1.234-.1 1.234-.1.585-.075.516-.93-.065-.896 0 0-1.746.138-2.874.138-.2 0-.438-.008-.69-.015C4.911 3.15 8.235 1.215 12 1.215c2.809 0 5.365 1.072 7.286 2.833-.046-.003-.091-.009-.141-.009-1.06 0-1.812.923-1.812 1.914 0 .89.513 1.643 1.06 2.531.411.72.89 1.643.89 2.977 0 .915-.354 1.994-.821 3.479l-1.075 3.585-3.9-11.61.001.014zM12 22.784c-1.059 0-2.081-.153-3.048-.437l3.237-9.406 3.315 9.087c.024.053.05.101.078.149-1.12.393-2.325.609-3.582.609M1.211 12c0-1.564.336-3.05.935-4.39L7.29 21.709C3.694 19.96 1.212 16.271 1.211 12M12 0C5.385 0 0 5.385 0 12s5.385 12 12 12 12-5.385 12-12S18.615 0 12 0" />
    </svg>
  );
}
function GhostLogo({ size = 16, className = '', ...props }) {
  const labelled = props['aria-label'];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} role={labelled ? 'img' : undefined} aria-hidden={labelled ? undefined : true} {...props}>
      <path fillRule="evenodd" d="M12 2a9 9 0 0 1 9 9v9.5a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0V11a9 9 0 0 1 9-9Zm-3 7.2a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Zm6 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z" />
    </svg>
  );
}
function NostrLogo({ size = 16, className = '', ...props }) {
  const labelled = props['aria-label'];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} role={labelled ? 'img' : undefined} aria-hidden={labelled ? undefined : true} {...props}>
      {[0, 60, 120, 180, 240, 300].map((a) => (
        <g key={a} transform={`rotate(${a} 12 12)`}>
          <rect x="11.25" y="3.9" width="1.5" height="6.4" rx="0.75" />
          <circle cx="12" cy="3.4" r="1.6" />
        </g>
      ))}
      <circle cx="12" cy="12" r="2.3" />
    </svg>
  );
}
function GbpLogo({ size = 16, className = '', ...props }) {
  const labelled = props['aria-label'];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} role={labelled ? 'img' : undefined} aria-hidden={labelled ? undefined : true} {...props}>
      <path d="m21.9 8.89-1.05-4.37c-.22-.9-1-1.52-1.91-1.52H5.05c-.9 0-1.69.63-1.9 1.52L2.1 8.89c-.24 1.02-.02 2.06.62 2.88.08.11.19.19.28.29V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-6.94c.09-.09.2-.18.28-.28.64-.82.87-1.87.62-2.89zm-2.99-3.9 1.05 4.37c.1.42.01.84-.25 1.17-.14.18-.44.47-.94.47-.61 0-1.14-.49-1.21-1.14L16.98 5l1.93-.01zM13 5h1.96l.54 4.52c.05.39-.07.78-.33 1.07-.22.26-.54.41-.95.41-.67 0-1.22-.59-1.22-1.31V5zM8.49 9.52 9.04 5H11v4.69c0 .72-.55 1.31-1.29 1.31-.34 0-.65-.15-.89-.41a1.42 1.42 0 0 1-.33-1.07zm-4.45-.16L5.05 5h1.97l-.58 4.86c-.08.65-.6 1.14-1.21 1.14-.49 0-.8-.29-.93-.47-.27-.32-.36-.75-.26-1.17zM5 19v-6.03c.08.01.15.03.23.03.87 0 1.66-.36 2.24-.95.6.6 1.4.95 2.31.95.87 0 1.65-.36 2.23-.93.59.57 1.39.93 2.29.93.84 0 1.64-.35 2.24-.95.58.59 1.37.95 2.24.95.08 0 .15-.02.23-.03V19H5z" />
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
  mastodon: { Icon: MastodonLogo, color: 'text-[#6364FF]', label: 'Mastodon' },
  wordpress: { Icon: WordPressLogo, color: 'text-[#21759B]', label: 'WordPress' },
  ghost: { Icon: GhostLogo, color: 'text-zinc-900 dark:text-zinc-100', label: 'Ghost' },
  nostr: { Icon: NostrLogo, color: 'text-[#8E30EB]', label: 'Nostr' },
  gbp: { Icon: GbpLogo, color: 'text-[#4285F4]', label: 'Google Business Profile' },
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

export function ApprovalPill({ approval, editedSinceApproval = false }) {
  const t = useT();
  // Trust gate: an approved post whose content changed after approval reads as a
  // distinct amber "re-approve" pill, NOT the settled green (which is hidden). The
  // publish gate refuses it until re-approval, so it belongs in the attention tone.
  if (approval === 'approved' && editedSinceApproval) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/30">
        <AlertTriangle size={11} className="shrink-0" aria-hidden="true" />
        {t('approval.editedSinceApproval')}
      </span>
    );
  }
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

// A neutral placeholder background sits behind every media element so a thumb
// reads as a calm loading tile (never a stark empty box) until the pixels paint;
// the opaque object-cover media covers it once loaded. A load error anywhere in
// the chain, OR a genuine text post (no media at all), resolves to an honest
// "text post" tile (muted surface + document glyph) - so a row NEVER shows the
// ambiguous bare grey square that read as broken/loading (US media fix).
export function CoverThumb({ media, image, className = '' }) {
  const [errored, setErrored] = useState(false);
  const PLACEHOLDER = 'bg-zinc-200/70 dark:bg-zinc-800/60';
  // media.cover = the render's local cover JPEG; image = a remote thumbnail
  // (e.g. a LinkedIn type:text article hero) for media-less posts.
  const src = media?.cover || image;
  if (src && !errored) {
    // Center crop: curated 9:16 covers carry info at top AND bottom; the old
    // object-top crop deterministically discarded the bottom quarter (UX-12).
    return <img src={src} alt="" loading="lazy" onError={() => setErrored(true)} className={`${PLACEHOLDER} object-cover ${className}`} />;
  }
  // A4: a still-image asset IS its own preview - render its bytes as an <img>, never
  // a <video> (a <video> pointed at a JPEG/PNG shows a broken/black box). This branch
  // sits BEFORE the video fallback so kind:'image' (or an image URL) always wins.
  const isImage = media?.kind === 'image' || /\.(jpe?g|png)$/i.test(media?.url || '');
  if (isImage && media?.url && !errored) {
    return (
      <img
        src={media.url}
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
  if (media?.url && !errored) {
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
        onError={() => setErrored(true)}
        className={`bg-black/80 object-cover ${className}`}
      />
    );
  }
  // Genuine text post (no media) or a media load failure: an intentional tile,
  // not a broken/empty square. Decorative - the row's title/caption carries the text.
  return (
    <div className={`grid place-items-center ${PLACEHOLDER} text-zinc-400 dark:text-zinc-500 ${className}`} aria-hidden="true">
      <FileText size={18} aria-hidden="true" />
    </div>
  );
}

// The hero image shared by the link/article cards. Kept at the real 1.91:1 card
// ratio and object-cover so it always FILLS the frame - no letterbox bars, in
// either theme. The card's own max-width (below) bounds the height, so the hero
// never grows tall enough to force the dialog to scroll. Click to open the full
// image in the shared full-screen viewer (the same affordance the media preview
// uses); no image -> a calm, theme-aware placeholder tile.
function CardHero({ image, noImageLabel }) {
  const t = useT();
  const [zoom, setZoom] = useState(false);
  if (!image) {
    return (
      <div className="flex aspect-[1.91/1] w-full items-center justify-center border-b border-dashed border-zinc-300 bg-zinc-200/40 px-3 text-center text-[11px] text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800/40 dark:text-zinc-400">
        {noImageLabel}
      </div>
    );
  }
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
        <CardHero image={image} noImageLabel={t('ui.linkCard.noImage')} />
        <div className="space-y-0.5 p-3">
          <p className="break-words text-sm font-bold leading-snug text-zinc-800 dark:text-zinc-100">{title || 'pendpost'}</p>
          {host ? <p className="break-words text-[11px] tracking-tight text-zinc-400 dark:text-zinc-500">{host}</p> : null}
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
        <CardHero image={image} noImageLabel={t('ui.articleCard.noImage')} />
        <div className="space-y-0.5 p-3">
          <p className="break-words text-sm font-bold leading-snug text-zinc-800 dark:text-zinc-100">{title || t('ui.articleCard.noTitle')}</p>
          {excerpt ? <p className="break-words text-xs leading-snug text-zinc-500 dark:text-zinc-400">{excerpt}</p> : null}
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
      {tags ? <p className="break-words text-[11px] text-zinc-400 dark:text-zinc-500">{tags}</p> : null}
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
    // A text post targeting a blog lane previews as its article card (hero +
    // title + excerpt); every other text post keeps the LinkedIn link card.
    if (post.platforms?.includes('wordpress') || post.platforms?.includes('ghost')) {
      return <ArticleCardPreview image={post.image} title={post.title} excerpt={post.excerpt} />;
    }
    // A pure text post (no link, no image) has NOTHING to preview - render nothing
    // rather than an empty "no image" link card that just eats width. The card only
    // earns its space when there is a real link or image to show.
    if (!post.link && !post.image) return null;
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

export function PlatformBlockers({ platformValidate, validateMedia, approval, editedSinceApproval = false, showApproval = true, onNavigate, className = '' }) {
  const t = useT();
  const platforms = platformValidate?.ok ? platformValidate.platforms || {} : {};
  const entries = Object.entries(platforms);
  const hasPlatformRows = entries.some(([, v]) => (v.problems?.length || 0) + (v.warnings?.length || 0) > 0);
  const mediaRows = mediaCheckRows(validateMedia?.ok ? validateMedia.checks : null, t);
  // A draft/pending/rejected post isn't a fault - it's just waiting for the owner's
  // approval. Surface it as ONE neutral line - but ONLY where the approval state isn't
  // already shown elsewhere (`showApproval`). PostDetail passes false: its header
  // ApprovalPill already carries the draft/rejected AND the "re-approve" states, so
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
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('blockers.awaitingApproval')}</p>
      ) : null}
      {needsReApproval ? (
        <p className="text-[11px] font-bold text-amber-600 dark:text-amber-300">{t('blockers.editedSinceApproval')}</p>
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
export const INNER_SURFACE = 'bg-zinc-100 ring-1 ring-zinc-900/5 dark:bg-zinc-800 dark:ring-white/10';

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
