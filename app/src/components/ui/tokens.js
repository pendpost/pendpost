// The shared surface/typography tokens, extracted so a ui/ primitive can reach them
// without importing back from ui.jsx. ui.jsx re-exports all four, so every existing
// `import { INNER_SURFACE } from '../ui.jsx'` keeps working untouched - this file only
// changes WHERE they are defined, never their values.
//
// Why it exists: ui.jsx imports several ui/ primitives (MediaPlayer, MediaLightbox,
// StoryStickerLayer, CarouselPreview), so any of those importing a token from ui.jsx
// would form an import cycle. Button.jsx already reached back for DISABLED_PRIMARY and
// got away with it only because ui.jsx does not import Button. Rather than rely on that
// staying true, the tokens live at the leaf where both sides can depend on them.

// Light-mode hairline + dark ring for inner surfaces sitting on glass panels
// (UX-01: white-on-white alpha alone loses every edge in light mode).
export const INNER_SURFACE = 'bg-zinc-100 ring-1 ring-zinc-900/5 dark:bg-zinc-800 dark:ring-white/10';

// WP10: the FIELD surface, a sibling of INNER_SURFACE for INPUTS/SELECTS/TEXTAREAS only.
// INNER_SURFACE's zinc-100 fill on the white-tinted glass panels made every entry field
// read as DISABLED in light mode (the owner's exact complaint); white with a firmer
// hairline reads active. Dark mode keeps the recessed look. Do NOT put containers on
// this - INNER_SURFACE stays the container token.
export const FIELD_SURFACE = 'bg-white ring-1 ring-zinc-900/10 dark:bg-zinc-800/60 dark:ring-white/10';

// The ONE disabled state for filled primary buttons (bg-brand text-white and kin).
// `disabled:opacity-*` on a brand-filled primary measures ~2:1 white-on-pale-teal in light
// mode - a Tier 1 AA failure. Explicit disabled colors instead: zinc-600 on zinc-200 (5.9:1)
// and zinc-300 on zinc-700 (7.4:1). contrast.test.js refuses the opacity form on primaries.
export const DISABLED_PRIMARY = 'disabled:bg-zinc-200 disabled:text-zinc-600 disabled:shadow-none dark:disabled:bg-zinc-700 dark:disabled:text-zinc-300';

// DS-1: the single eyebrow micro-label token. Sentence case (never all-caps),
// tiny, bold, tight tracking - the anti-slop replacement for the retired
// all-caps eyebrow class (roadmap.md DS-1; brand-guide.md "No all-caps
// labels"). Every eyebrow across the dashboard resolves to this.
export const EYEBROW = 'text-[11px] font-bold tracking-tight text-zinc-500 dark:text-zinc-400';
