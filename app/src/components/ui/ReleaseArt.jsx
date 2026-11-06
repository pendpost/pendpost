import {
  ArrowUp, BellOff, Plus, Calendar, Check, CircleAlert, Image, Images, Inbox, KeyRound, Languages, Layers,
  ListChecks, MessageCircleReply, MessageSquare, MousePointerClick, PenLine, Radar, RefreshCw,
  ShieldAlert, ShieldCheck, Sparkles, Trash2, Undo2, Wrench, Youtube,
} from 'lucide-react';

// The art tile of one What's new item (docs/specs/whats-new.md): the item's glyph in the
// accent on a soft accent squircle, with a small neutral corner badge for its kind. Built
// from icons only, so it needs no raster asset and is right in both themes. Decorative: the
// row names the kind in words (sr-only). ICON_MAP covers every name in ICONS of
// lib/whats-new.mjs (a test guards it); an unknown name falls back to Sparkles.
export const ICON_MAP = {
  'bell-off': BellOff, calendar: Calendar, 'circle-alert': CircleAlert, image: Image, images: Images,
  inbox: Inbox, 'key-round': KeyRound, languages: Languages, layers: Layers, 'list-checks': ListChecks,
  'message-circle-reply': MessageCircleReply, 'message-square': MessageSquare,
  'mouse-pointer-click': MousePointerClick, 'pen-line': PenLine, radar: Radar, 'refresh-cw': RefreshCw,
  'shield-alert': ShieldAlert, 'shield-check': ShieldCheck, sparkles: Sparkles, 'trash-2': Trash2,
  'undo-2': Undo2, wrench: Wrench, youtube: Youtube,
};
export const KIND_GLYPH = { new: Plus, improved: ArrowUp, fixed: Check };

// `brand` is a CSS variable (the per-client accent), so the tints mix it with color-mix.
const TILE = 'relative grid h-12 w-12 shrink-0 place-items-center rounded-[14px] text-brand dark:text-brand-light'
  + ' bg-[linear-gradient(145deg,color-mix(in_srgb,var(--accent,#0f766e)_16%,#fff),color-mix(in_srgb,var(--accent,#0f766e)_6%,#fff))]'
  + ' shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent,#0f766e)_18%,transparent)]'
  + ' dark:bg-[linear-gradient(145deg,color-mix(in_srgb,var(--accent-light,#5eead4)_20%,#18181b),color-mix(in_srgb,var(--accent-light,#5eead4)_7%,#18181b))]'
  + ' dark:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent-light,#5eead4)_22%,transparent)]';
const BADGE = 'absolute -bottom-[5px] -right-[5px] grid h-5 w-5 place-items-center rounded-full bg-white text-zinc-600 shadow-[0_0_0_1px_#e4e4e7,0_1px_2px_rgba(0,0,0,0.08)] dark:bg-zinc-800 dark:text-zinc-300 dark:shadow-[0_0_0_1px_#3f3f46]';

export default function ReleaseArt({ icon, kind }) {
  const Glyph = ICON_MAP[icon] || Sparkles;
  const Kind = KIND_GLYPH[kind];
  return (
    <span aria-hidden="true" data-icon={ICON_MAP[icon] ? icon : 'sparkles'} className={TILE}>
      <Glyph size={22} strokeWidth={1.9} />
      {Kind ? <span className={BADGE}><Kind size={11} strokeWidth={2.4} /></span> : null}
    </span>
  );
}
