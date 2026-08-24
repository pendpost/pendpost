// UX issue 10 (2026-08-18): the ONE status/action design system, replacing 6+ status-pill
// implementations and 4 button dialects scattered across Radar/Autonomy (see
// docs/plans/ux-simplification-2026-08-18/spec.md, "Design system: one status/action
// language"). Every status or action element on screen is exactly one of five classes;
// shape alone tells the operator whether it does something:
//   round-full = state or selection - it never mutates anything by itself.
//   round-xl   = performs an action.
// This file only holds the recipes; callers plug in their own icon + label + tone.
// Landing note: recipes.js + the RadarFeed/Radar/AutonomyLedger migration ship first (UX
// issue 10); Freigaben/Planner/Settings + the shared ui.jsx primitives (StatusPill,
// ApprovalPill, PostStatusPill, NextActorChip) re-base on these same tokens in a follow-up.

import { DISABLED_PRIMARY } from './tokens.js';

// The house focus-visible ring, appended to every INTERACTIVE recipe below (PILL_BASE and
// CHIP stay non-interactive by contract, so they carry no ring of their own).
const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';

// a. STATUS - non-interactive, icon + word, tone from the semantic palette.
export const PILL_BASE = 'inline-flex min-w-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ring-1';
export const PILL_TONES = {
  ok: 'bg-emerald-500/15 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300',
  attention: 'bg-amber-500/15 text-amber-700 ring-amber-500/30 dark:text-amber-300',
  danger: 'bg-red-500/15 text-red-700 ring-red-500/30 dark:text-red-300',
  info: 'bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300',
  neutral: 'bg-zinc-500/10 text-zinc-600 ring-zinc-500/20 dark:text-zinc-300',
  accent: 'bg-brand/10 text-brand ring-brand/20 dark:text-brand-light',
};

// b. INFO CHIP - a count or tag; no ring, no tone, never bolder than semibold.
export const CHIP = 'inline-flex items-center gap-1 rounded-full bg-zinc-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-600 dark:text-zinc-300';

// b'. PROJECT CHIP - the cross-client identity badge (all-projects mode, UX issue 6).
// A ringed, filled chip so the project reads as a real badge, not grey meta text -
// the owner's "very clear badges with their project names". Non-interactive; the
// avatar carries the accent, the name carries the meaning (never colour-only). The
// caller supplies the ClientAvatar + name inside.
export const PROJECT_CHIP = 'inline-flex shrink-0 items-center gap-1 rounded-full bg-zinc-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-zinc-700 ring-1 ring-zinc-500/20 dark:text-zinc-200';

// d. BUTTONS - one size ladder (default h-8 text-xs; md h-9 text-sm for page primaries).
export const BTN_PRIMARY = `inline-flex items-center gap-1.5 rounded-xl bg-brand px-3 py-1.5 text-xs font-bold text-white transition hover:brightness-95 dark:bg-brand-light dark:text-zinc-900 ${DISABLED_PRIMARY} ${FOCUS_RING}`;
export const BTN_QUIET = `inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold text-zinc-600 ring-1 ring-zinc-900/10 transition hover:bg-zinc-900/5 disabled:opacity-50 dark:text-zinc-300 dark:ring-white/10 dark:hover:bg-white/5 ${FOCUS_RING}`;
export const BTN_GHOST = `inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-zinc-500 transition hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 ${FOCUS_RING}`;

// Tier usage rules (enforced by review, one line each):
// - One BTN_PRIMARY per card/surface (canon #4).
// - BTN_QUIET for every named secondary action ("Erledigt", "Bearbeiten", "Stoppen", Open pill).
// - BTN_GHOST only for tertiary/utility affordances that navigate or reveal (overflow
//   trigger, transcript disclosure, "add a link"), never for an action with a consequence.
// - Destructive: a red menu item inside RowMenu/overflow, or a two-step inline confirm;
//   never a red standalone button on a card.
