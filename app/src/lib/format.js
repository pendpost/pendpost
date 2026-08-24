import { AlertTriangle, BadgeCheck, CalendarClock, CheckCircle, Clock, OctagonX, PauseCircle, Pencil, RefreshCw, Send } from 'lucide-react';
import { getActiveLocale } from './i18n.js';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// A3: resolve the DISPLAY locale for date/time formatting. English keeps 'en-US'
// (the established app format) so existing output is byte-stable; any other active
// locale (e.g. de-CH) drives Intl directly, which yields Swiss 24-hour time and
// dd.MM dates with no per-formatter flags. dayKey/localDayKey deliberately stay
// 'sv-SE' (stable ISO day-keys for internal logic), never localized.
export function dateLocale() {
  const l = getActiveLocale();
  return l && l !== 'en' ? l : 'en-US';
}

// YYYY-MM-DD of an ISO timestamp, rendered in the configured time zone.
export function dayKey(iso) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date(iso));
}

// A5: time-format preference. `auto` keeps each locale's own default (en-US 12-hour,
// de-CH 24-hour); `24h`/`12h` override it - but ONLY for en-US, because the owner
// rule makes German (any non-en-US locale) ALWAYS 24-hour. Module-synced (read by
// these plain formatters) and persisted, mirroring the active-locale pattern.
const TIME_FORMAT_KEY = 'pendpost-time-format';
let _timeFormat = 'auto';
try {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(TIME_FORMAT_KEY) : null;
  if (stored === '24h' || stored === '12h') _timeFormat = stored;
} catch { /* localStorage unavailable (private mode) */ }

export function getTimeFormat() { return _timeFormat; }
export function setTimeFormat(value) {
  _timeFormat = value === '24h' || value === '12h' ? value : 'auto';
  try {
    if (_timeFormat === 'auto') localStorage.removeItem(TIME_FORMAT_KEY);
    else localStorage.setItem(TIME_FORMAT_KEY, _timeFormat);
  } catch { /* ignore */ }
}

// Planner card accent style: how a card that needs action is flagged - a thin
// colored bar down the left edge ('bar', the default) or a soft tinted band behind
// the status row ('strip'). A client-side display preference (localStorage), synced
// in-module and persisted, mirroring the time-format pattern. Settled cards are
// unaffected either way - the accent only ever decorates an attention card.
const CARD_ACCENT_KEY = 'pendpost-card-accent';
let _cardAccent = 'bar';
try {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(CARD_ACCENT_KEY) : null;
  if (stored === 'bar' || stored === 'strip') _cardAccent = stored;
} catch { /* localStorage unavailable (private mode) */ }

export function getCardAccent() { return _cardAccent; }
export function setCardAccent(value) {
  _cardAccent = value === 'strip' ? 'strip' : 'bar';
  try {
    if (_cardAccent === 'bar') localStorage.removeItem(CARD_ACCENT_KEY);
    else localStorage.setItem(CARD_ACCENT_KEY, _cardAccent);
  } catch { /* ignore */ }
}

// Planner Week-view density: 'comfortable' (the default big PostCard with cover +
// caption) or 'compact' (the small chip, so a busy day stays scannable). A client-side
// display preference (localStorage), synced in-module and persisted, mirroring the
// card-accent pattern above. Only the Week view reads it; Month is always compact.
const PLANNER_DENSITY_KEY = 'pendpost-planner-density';
let _plannerDensity = 'comfortable';
try {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(PLANNER_DENSITY_KEY) : null;
  if (stored === 'comfortable' || stored === 'compact') _plannerDensity = stored;
} catch { /* localStorage unavailable (private mode) */ }

export function getPlannerDensity() { return _plannerDensity; }
export function setPlannerDensity(value) {
  _plannerDensity = value === 'compact' ? 'compact' : 'comfortable';
  try {
    if (_plannerDensity === 'comfortable') localStorage.removeItem(PLANNER_DENSITY_KEY);
    else localStorage.setItem(PLANNER_DENSITY_KEY, _plannerDensity);
  } catch { /* ignore */ }
}

// Sidebar rail width in px: a client-side display preference (localStorage), synced
// in-module and persisted, mirroring the card-accent pattern above. The rail is a
// fixed 240px drawer below lg, so this only ever applies to the desktop rail; the
// resizer that writes it is hidden there. Bounds are static on purpose: the rail
// only exists at >= 1024px, so SIDEBAR_WIDTH_MAX can never squeeze the main column.
const SIDEBAR_WIDTH_KEY = 'pendpost-sidebar-width';
export const SIDEBAR_WIDTH_DEFAULT = 240;
export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 400;

// Clamp to the valid range, rejecting anything non-numeric. A hand-edited or stale
// key falls back to the default rather than laying out the app from garbage.
export function clampSidebarWidth(value) {
  // Number(null) is 0 and Number('') is 0 - both finite, both would silently clamp to
  // the minimum instead of falling back. Only a real number or a numeric string counts.
  const numeric = typeof value === 'number'
    || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)));
  if (!numeric) return SIDEBAR_WIDTH_DEFAULT;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, n));
}

let _sidebarWidth = SIDEBAR_WIDTH_DEFAULT;
try {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(SIDEBAR_WIDTH_KEY) : null;
  if (stored !== null && stored !== '' && Number.isFinite(Number(stored))) _sidebarWidth = clampSidebarWidth(stored);
} catch { /* localStorage unavailable (private mode) */ }

export function getSidebarWidth() { return _sidebarWidth; }
export function setSidebarWidth(value) {
  _sidebarWidth = clampSidebarWidth(value);
  try {
    if (_sidebarWidth === SIDEBAR_WIDTH_DEFAULT) localStorage.removeItem(SIDEBAR_WIDTH_KEY);
    else localStorage.setItem(SIDEBAR_WIDTH_KEY, String(_sidebarWidth));
  } catch { /* ignore */ }
}

// Push the current width onto documentElement as --sidebar-w, which Tailwind's
// `w-sidebar` utility reads. Kept here so the drag path can write the var straight
// from a pointermove without a React render.
export function applySidebarWidth(value) {
  const px = clampSidebarWidth(value);
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--sidebar-w', `${px}px`);
  }
  return px;
}

// The hour12 override for a resolved display locale: de-CH (any non-en-US) is always
// 24-hour; en-US follows the preference (auto = no override, i.e. its 12-hour default).
function hour12For(loc) {
  if (loc !== 'en-US') return { hour12: false };
  if (_timeFormat === '24h') return { hour12: false };
  if (_timeFormat === '12h') return { hour12: true };
  return {};
}

// The ONE post-date comparator. Four copies of
// `Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt)` were inline across Planner
// and Freigaben, and adding a direction to one of them would have made a fifth.
//
// Sorts on scheduledAt, the date the cards actually SHOW, so a reader can re-derive the
// order from the screen. `dir` is 1 for oldest-first, -1 for newest-first.
//
// An undated post sorts LAST in BOTH directions: it is not "the newest", and flipping
// the direction must not float it to the top. That is why the missing check sits outside
// the direction multiplier rather than relying on a '9999' sentinel string.
export function comparePostDate(a, b, dir = 1) {
  const ta = Date.parse(a?.scheduledAt || '');
  const tb = Date.parse(b?.scheduledAt || '');
  const aMissing = Number.isNaN(ta);
  const bMissing = Number.isNaN(tb);
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  return dir * (ta - tb);
}

export function fmtTime(iso) {
  const loc = dateLocale();
  return new Intl.DateTimeFormat(loc, { timeZone: TZ, hour: '2-digit', minute: '2-digit', ...hour12For(loc) }).format(new Date(iso));
}

// The FULL stamp - every component (weekday + date + time) - as opposed to
// fmtStampShort (no weekday) and fmtTime (time only). "Full" names the component
// set, not the verbosity: it reads "Mi, 22.07.26 · 09:00", not "Mittwoch, 22. Juli
// 2026 um 09:00", which was too long for the dense rows and pickers that use it.
// Composed from the two helpers below rather than a third Intl.DateTimeFormat, so
// the app can only ever have ONE date style and ONE time style.
export function fmtFull(iso) {
  return `${fmtDayShort(new Date(iso))}, ${fmtStampShort(iso)}`;
}

// Relative schedule label for the triage/detail identity line ("in 2 days",
// "tomorrow", "5 minutes ago") so an operator reads urgency at a glance instead
// of parsing an absolute date. Localizes itself via Intl.RelativeTimeFormat (no
// manual strings) and pairs with fmtTime for the exact clock time. numeric:'auto'
// yields "tomorrow"/"yesterday" where the locale has a word for it.
export function fmtRelative(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return '';
  const rtf = new Intl.RelativeTimeFormat(dateLocale(), { numeric: 'auto' });
  const abs = Math.abs(ms);
  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  if (abs < HOUR) return rtf.format(Math.round(ms / MIN), 'minute');
  if (abs < DAY) return rtf.format(Math.round(ms / HOUR), 'hour');
  return rtf.format(Math.round(ms / DAY), 'day');
}

// Dense stamp for compact rows: 2-digit DD.MM.YY (locale-ordered, so de-CH reads
// 29.06.26) joined to the time. KISS - no weekday, no "scheduled for" prefix.
export function fmtStampShort(iso) {
  const loc = dateLocale();
  const date = new Intl.DateTimeFormat(loc, { timeZone: TZ, day: '2-digit', month: '2-digit', year: '2-digit' }).format(new Date(iso));
  return `${date} · ${fmtTime(iso)}`;
}

export function fmtDayShort(date) {
  return new Intl.DateTimeFormat(dateLocale(), { timeZone: TZ, weekday: 'short' }).format(date);
}

export function fmtDayNum(date) {
  return new Intl.DateTimeFormat(dateLocale(), { timeZone: TZ, day: 'numeric' }).format(date);
}

export function fmtMonthYear(date) {
  return new Intl.DateTimeFormat(dateLocale(), { timeZone: TZ, month: 'long', year: 'numeric' }).format(date);
}

// Short all-numeric date in the active display locale (en-US 6/12/2026, de-CH
// 12.6.2026). The day-form campaign label routes through this so it follows
// dateLocale() like every other on-screen date instead of a hard-coded template.
export function fmtDateShort(date) {
  return new Intl.DateTimeFormat(dateLocale(), { timeZone: TZ, day: 'numeric', month: 'numeric', year: 'numeric' }).format(date);
}

export function fmtRange(start, end) {
  const d = new Intl.DateTimeFormat(dateLocale(), { timeZone: TZ, day: 'numeric', month: 'short' });
  return `${d.format(start)} - ${d.format(end)}`;
}

// All-numeric DD.MM range for narrow header widths, where the month-name form
// ("22. Juni - 28. Juni") would force the toolbar onto a second line. Locale-aware
// like fmtRange, but two-digit day + month so de-CH and en both read "22.06".
export function fmtRangeShort(start, end) {
  const d = new Intl.DateTimeFormat(dateLocale(), { timeZone: TZ, day: '2-digit', month: '2-digit' });
  return `${d.format(start)} - ${d.format(end)}`;
}

// Monday 00:00 (local) of the week containing `date`.
export function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7; // Mon=0 ... Sun=6
  d.setDate(d.getDate() - day);
  return d;
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function localDayKey(date) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(date);
}

// Drag-drop reschedule decision for the Week board (App#moveToDay). Builds the
// target Date from the drop column's day + the post's preserved wall-clock time,
// then returns it ONLY when the move should reschedule. Returns null to skip:
//  - unchanged-time no-op (next === original wall-clock on the same day), or
//  - a past-day drop, refused to match the List DateTimePicker's disablePast
//    rule (DateTimePicker.jsx isPast = key < todayKey). The comparison is on the
//    local day-key (Intl sv-SE, plan TZ), NOT next.getTime() < now, so a
//    same-day earlier-clock drop stays ALLOWED (today is never "past").
export function moveToDayTarget(scheduledAt, day, now = new Date()) {
  const orig = new Date(scheduledAt);
  const next = new Date(day);
  next.setHours(orig.getHours(), orig.getMinutes(), 0, 0);
  if (next.getTime() === orig.getTime()) return null; // unchanged-time no-op
  if (localDayKey(next) < localDayKey(now)) return null; // past day: refuse
  return next;
}

export function fmtBytes(bytes) {
  if (bytes == null) return '';
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

// Locale-grouped integer (en-US 1,234 / de-CH 1'234) for Insights metrics, so
// counts group their thousands the same way every other number follows the
// active display locale. A non-numeric input falls back to 0.
export function fmtInt(n) {
  return new Intl.NumberFormat(dateLocale()).format(Number(n) || 0);
}

// ── The status STAIRCASE: five fixed stops, red -> grey -> green ────────────────────
// The owner wants status colour to read as a single lifecycle progression, not a
// bag of hues: a post travels deep-red (rejected) -> light-red (halted/failed) ->
// grey (not yet in motion) -> light-green (in motion, human-cleared) -> deep-green
// (published). Defined ONCE here and spread into every status map below (STATE_META,
// APPROVAL_META, STATUS_PILL_META, ROW_STATUS_META) so a bucket can never drift a
// half-shade between the pill, the accent bar and the month dot.
//
// `cls` = pill tint (`bg-<c>/<a> text-<c>-<n> dark:text-<c>-<n> ring-<c>/<a>`), `dot`
// = the solid month-cell dot (it carries the staircase most legibly, so deep vs light
// are kept clearly apart: red-600 vs rose-400, emerald-600 vs emerald-400), `bar`/
// `strip` = the two Planner attention-accent styles. Every text pairing clears WCAG
// 2.2 AA (>= 4.5:1) on BOTH app body backgrounds (light #f8fafc / dark #09090b);
// measured ratios (light / dark): deepRed red-700 6.18 / red-300 10.48; lightRed
// rose-700 6.01 / rose-300 10.52 (rose-600 is 4.49 and fails light, hence rose-700);
// grey zinc-600 7.39 / zinc-300 13.46; lightGreen emerald-700 5.24 / emerald-400
// 10.35; deepGreen emerald-800 7.34 / emerald-300 13.05. Colour is never the sole
// signal - every pill still leads with its own lucide icon + carries a text label
// (WCAG 1.4.1); the stops are told apart by icon + label, not hue alone.
export const STAIR = {
  rejected: { cls: 'bg-red-500/15 text-red-700 dark:text-red-300 ring-red-500/40', dot: 'bg-red-600', bar: 'bg-red-600', strip: 'bg-red-500/10' },
  halted: { cls: 'bg-rose-400/15 text-rose-700 dark:text-rose-300 ring-rose-400/30', dot: 'bg-rose-400', bar: 'bg-rose-400', strip: 'bg-rose-400/10' },
  pending: { cls: 'bg-zinc-500/12 text-zinc-600 dark:text-zinc-300 ring-zinc-500/25', dot: 'bg-zinc-400', bar: 'bg-zinc-400', strip: 'bg-zinc-500/10' },
  inMotion: { cls: 'bg-emerald-400/15 text-emerald-700 dark:text-emerald-400 ring-emerald-400/30', dot: 'bg-emerald-400', bar: 'bg-emerald-400', strip: 'bg-emerald-400/10' },
  published: { cls: 'bg-emerald-600/18 text-emerald-800 dark:text-emerald-300 ring-emerald-600/45', dot: 'bg-emerald-600', bar: 'bg-emerald-600', strip: 'bg-emerald-600/10' },
};

// Structural only: `cls` = pill tint, `dot` = month-view status dot color (UX-05),
// `Icon` = a decorative (aria-hidden) lucide glyph the pills lead with, matching the
// TimeChip's icon+tone treatment (DESIGN.md section 3). The pills still carry their
// text label, so the icon is coherence, never the sole signal (WCAG 1.4.1).
// The user-facing labels moved to the locale pack - StatusPill resolves them via
// t('state.<key>') (long) / t('state.short.<key>') (the single-word week-card form,
// UX-02). The map key IS the i18n key suffix, so this map stays the single source of
// which states exist while carrying no prose. Every entry draws its tone from the
// shared STAIR (above), so the lifecycle progression is one palette, not per-map hues.
export const STATE_META = {
  posted: { cls: STAIR.published.cls, dot: STAIR.published.dot, Icon: CheckCircle },
  'scheduled-native': { cls: STAIR.inMotion.cls, dot: STAIR.inMotion.dot, Icon: CalendarClock },
  'fired-assumed': { cls: STAIR.published.cls, dot: STAIR.published.dot, Icon: Send },
  // Verify read-back outcomes (lib/verify.mjs): confirmed live on every targeted
  // platform, or read back not-live/missing. They refine 'fired-assumed'.
  'verified-live': { cls: STAIR.published.cls, dot: STAIR.published.dot, Icon: BadgeCheck },
  'verify-failed': { cls: STAIR.halted.cls, dot: STAIR.halted.dot, Icon: AlertTriangle },
  'waiting-due': { cls: STAIR.inMotion.cls, dot: STAIR.inMotion.dot, Icon: Clock },
  overdue: { cls: STAIR.halted.cls, dot: STAIR.halted.dot, Icon: OctagonX },
  // The platform refused it (lib/plans.mjs lastFailureFor). Same light-red HALTED stop
  // as overdue - both are stalled failures - but its own icon and label, because
  // "overdue" reads as "pendpost was not running" and that is a lie here. Only a
  // rejected post earns the DEEP red; a failure that pendpost can retry stays light.
  'publish-failed': { cls: STAIR.halted.cls, dot: STAIR.halted.dot, Icon: AlertTriangle },
  // A publish that HICCUPED but is NOT terminal (lastFailure.terminal === false): the
  // platform stumbled (e.g. Instagram's intermittent rupload ProcessingFailedError) and
  // pendpost is auto-retrying it. Not the red HALTED stop - the system is handling it, so
  // it reads as the calm GREY "working" stop with a retry glyph, never the alarm red the
  // old code showed for a post it was already recovering. Reserves red for terminal:true.
  'publish-retrying': { cls: STAIR.pending.cls, dot: STAIR.pending.dot, Icon: RefreshCw },
  parked: { cls: STAIR.pending.cls, dot: STAIR.pending.dot, Icon: PauseCircle },
};

// Structural only; ApprovalPill resolves the label via t('approval.<key>'). `Icon`
// is decorative (aria-hidden), mirroring the TimeChip tones (approved=CheckCircle,
// pending=Clock, rejected=OctagonX) for cross-surface coherence. Draft + pending sit
// on the GREY stop (not yet in motion); approved steps to light-green (human-cleared);
// rejected is the deep-red terminus.
export const APPROVAL_META = {
  draft: { cls: STAIR.pending.cls, Icon: Pencil },
  pending: { cls: STAIR.pending.cls, Icon: Clock },
  approved: { cls: STAIR.inMotion.cls, Icon: CheckCircle },
  rejected: { cls: STAIR.rejected.cls, Icon: OctagonX },
};

// FR1: the Planner scheduled-time chip carries approval/breaker meaning at a
// glance, in exactly three semantic tones. The chip overlays a cover image, so
// the tones use a near-solid background (not the translucent /15 of the pills on
// flat surfaces) to hold >= 4.5:1 contrast over arbitrary cover art. Yellow uses
// dark text; green and red use white text. Each tone carries its own lucide icon
// + accessible name so meaning never rests on color alone (WCAG 1.4.1). The
// accessible name moved to the locale pack: TimeChip resolves t('timeChip.<tone>').
// Triage-first: color is spent ONLY on attention. An approved/clear post no longer
// paints the chip green (green-on-everything made green the background and dulled the
// genuinely urgent red/amber) - it reads as a NEUTRAL dark-glass chip, just the time.
// needs-approval (amber) and halted (red) keep their tones so the chip reinforces the
// status pill exactly where action is required. Each tone still pairs its color with
// an icon + accessible name (WCAG 1.4.1); tone keys are unchanged.
export const TIME_CHIP_META = {
  approved: { tone: 'approved', cls: 'bg-zinc-900/60 text-white ring-white/20', Icon: CheckCircle },
  'needs-approval': { tone: 'needs-approval', cls: 'bg-amber-500/90 text-zinc-950 ring-amber-300/40', Icon: Clock },
  halted: { tone: 'halted', cls: 'bg-red-600/90 text-white ring-red-300/40', Icon: OctagonX },
};

// A post is subject to the Meta breaker/lane only when it targets a Meta surface
// (Facebook or Instagram); a LinkedIn-only or YouTube-only post is never halted
// by a Meta 368 block or a paused Meta lane.
export function postTouchesMeta(post) {
  return (post?.platforms || []).some((p) => p === 'facebook' || p === 'instagram');
}

// FR1: map a post (+ the active client's Meta lane signals) to one of the three
// time-chip tones. Evaluated top to bottom, first match wins; halted overrides
// everything. `lane` is { metaBlockedUntil, metaPaused } - both Meta-lane-only
// and client-scoped. A missing approval is treated as draft (fail-closed: the
// human approval gate must never read as clear-to-publish by omission).
export function timeChipTone(post, lane = {}) {
  // 1. HALTED (red) - overrides all.
  if (post.approval === 'rejected') return 'halted';
  if (lane.metaBlockedUntil && postTouchesMeta(post)) return 'halted'; // Meta 368 block
  if (lane.metaPaused && postTouchesMeta(post)) return 'halted'; // lane pause / META_PUBLISHING_PAUSED
  // 2. NEEDS APPROVAL (yellow).
  if (post.approval === 'draft' || post.approval === 'pending') return 'needs-approval';
  // 3. APPROVED / CLEAR (green).
  if (post.approval === 'approved') return 'approved';
  return 'needs-approval'; // fail-safe: a missing approval is treated as draft.
}

// Triage-first: the ONE thing a manager scans for is "does this need me?". A post
// needs attention when its collapsed status (postStatusKey) is draft / pending /
// rejected / overdue - i.e. it is not yet settled (scheduled / posted / parked).
// This is the single predicate the Planner card (accent + saturated pill) and the
// month dot share, so the two surfaces can never disagree on what is "urgent".
const ATTENTION_STATUS = new Set(['draft', 'pending', 'rejected', 'overdue']);
export function needsAttention(post) {
  return ATTENTION_STATUS.has(postStatusKey(post));
}

// Structural only (like STATE_META): the ONE unified status the Planner surfaces
// render, keyed by postStatusKey's collapsed bucket - the SINGLE SOURCE OF TRUTH for
// the card pill, its accent, AND the month dot, so they can never drift (e.g. a
// draft-that-is-also-past-due reads as "draft" everywhere, not slate on the card but
// red on the dot). `cls` = pill tint (attention buckets saturated; settled buckets
// quiet/ghost so a done card recedes in the week grid). `bar`/`strip` = the two
// attention-accent styles (left bar vs. tinted band); settled buckets carry neither.
// `dot` = the month-cell status dot (settled buckets still get a distinct calm hue so
// the month view can tell upcoming from published at a glance). `Icon` is a decorative
// lead glyph (the pill keeps its text label, so color is never the sole signal, WCAG
// 1.4.1). Labels resolve from the pack under the status.<bucket> keys (already present
// for the Status filter), so this map carries no prose.
export const STATUS_PILL_META = {
  draft: { cls: STAIR.pending.cls, bar: STAIR.pending.bar, strip: STAIR.pending.strip, dot: STAIR.pending.dot, Icon: Pencil },
  pending: { cls: STAIR.pending.cls, bar: STAIR.pending.bar, strip: STAIR.pending.strip, dot: STAIR.pending.dot, Icon: Clock },
  rejected: { cls: STAIR.rejected.cls, bar: STAIR.rejected.bar, strip: STAIR.rejected.strip, dot: STAIR.rejected.dot, Icon: OctagonX },
  overdue: { cls: STAIR.halted.cls, bar: STAIR.halted.bar, strip: STAIR.halted.strip, dot: STAIR.halted.dot, Icon: OctagonX },
  // verify-failed filters under the 'overdue' "needs attention" bucket (postStatusKey)
  // but keeps its OWN visible treatment (postDisplayStatusKey): a post that fired and
  // read back not-live is not "pendpost wasn't running", so the planner card must not
  // mislabel it the red "Overdue". Shares the light-red HALTED stop with overdue so the
  // calendar pill/accent/dot match the StatusPill on the detail + run-now surfaces; its
  // own icon + label ("Ungeprüft") is what tells it apart, not a separate hue.
  'verify-failed': { cls: STAIR.halted.cls, bar: STAIR.halted.bar, strip: STAIR.halted.strip, dot: STAIR.halted.dot, Icon: AlertTriangle },
  // Same light-red HALTED stop as overdue (a refusal IS a stalled failure), different
  // icon + label: "Overdue" tells the owner pendpost was not running, the wrong fix.
  'publish-failed': { cls: STAIR.halted.cls, bar: STAIR.halted.bar, strip: STAIR.halted.strip, dot: STAIR.halted.dot, Icon: AlertTriangle },
  // Non-terminal hiccup, pendpost is auto-retrying (see STATE_META['publish-retrying']):
  // GREY "working" stop, and NO attention accent (bar/strip empty, like scheduled) - the
  // system is recovering it, so the card must not wear the red left-edge alarm.
  'publish-retrying': { cls: STAIR.pending.cls, bar: '', strip: '', dot: STAIR.pending.dot, Icon: RefreshCw },
  // Settled, in-motion: light-green. No attention accent (bar/strip empty) - the card
  // is on track, so it carries the staircase tone without the left-edge alarm.
  scheduled: { cls: STAIR.inMotion.cls, bar: '', strip: '', dot: STAIR.inMotion.dot, Icon: CalendarClock },
  posted: { cls: STAIR.published.cls, bar: '', strip: '', dot: STAIR.published.dot, Icon: CheckCircle },
  parked: { cls: STAIR.pending.cls, bar: '', strip: '', dot: STAIR.pending.dot, Icon: PauseCircle },
};

// Which cards visually recede (dimmed): only the "set aside" buckets - parked
// (manually unscheduled) and rejected (won't publish as-is). Every other card -
// scheduled, posted, draft, pending, overdue - renders at full, regular strength.
export function postIsDimmed(post) {
  const k = postStatusKey(post);
  return k === 'parked' || k === 'rejected';
}

// The VISIBLE status bucket for the planner surfaces (card pill, accent, month dot).
// Identical to postStatusKey EXCEPT verify-failed is NOT folded into 'overdue': it
// still FILTERS as overdue ("needs attention"), but a fired-then-read-back-not-live
// post (e.g. a YouTube video left private past its publishAt) is not the same as
// "past due, pendpost wasn't running". Showing the red "Overdue" pill + tip there is
// actively wrong; this keeps the calendar in step with the StatusPill (which already
// renders verify-failed directly) on the detail + run-now surfaces. Filtering stays
// on postStatusKey, so the Status filter is unchanged.
export function postDisplayStatusKey(post) {
  if (post.derivedState === 'verify-failed') return 'verify-failed';
  // Same reasoning for a REFUSED post: it filters as overdue, but showing the owner
  // "past due, pendpost wasn't running" when a platform actually rejected the post sends
  // them to start a scheduler that is already running. The reason rides on post.lastFailure.
  if (post.derivedState === 'publish-failed') {
    // A NON-terminal failure is one pendpost is auto-retrying (a transient platform
    // hiccup) - it is not "Failed", it is "Retrying". Only a terminal failure (parked
    // after the retry window, or a hard refusal) keeps the red 'publish-failed' pill.
    // A HALTED failure (the lane is circuit-broken, e.g. X 402 credits depleted) is
    // NOT auto-retrying either, so it keeps the honest red pill - never "Retrying".
    // Filtering is unchanged (postStatusKey still folds both into 'overdue').
    return post.lastFailure && post.lastFailure.terminal === false && !post.lastFailure.halted ? 'publish-retrying' : 'publish-failed';
  }
  return postStatusKey(post);
}

// The VISIBLE derivedState for the two-axis StatusPill (detail / run-now dialog), which
// keys STATE_META by the raw derivedState. Mirrors postDisplayStatusKey's one refinement:
// a non-terminal publish-failed reads as 'publish-retrying' so that surface agrees with
// the planner card ("the two surfaces can never disagree"). Everything else is unchanged.
export function postDisplayState(post) {
  if (post?.derivedState === 'publish-failed' && post.lastFailure && post.lastFailure.terminal === false && !post.lastFailure.halted) {
    return 'publish-retrying';
  }
  return post?.derivedState;
}

// Month-cell status dot, derived from the SAME visible bucket as the card pill
// (STATUS_PILL_META) so the month view and the week/list cards never disagree on a
// post's status - the previous overdue-first precedence painted a draft-that-is-also
// -past-due red on the dot while the card read it as a quiet "draft".
export function postDot(post) {
  return STATUS_PILL_META[postDisplayStatusKey(post)]?.dot || 'bg-zinc-400';
}

// The ONE status the overview cards render (List row, Week card). Identical to
// postDisplayStatusKey EXCEPT an approved-and-on-track post (bucket 'scheduled',
// approval 'approved') reads as a calm GREEN 'approved' instead of the neutral zinc
// 'scheduled'. This is the single place the human-approval gate turns green on the
// overview - brand/DESIGN.md section 3 (approved = emerald CheckCircle) - so the owner
// sees "Freigegeben" at a glance instead of a dark neutral chip on one side and an
// unrelated pill on the other. Every ATTENTION bucket (draft/pending/rejected/overdue/
// verify-failed/publish-failed) still wins over it via postDisplayStatusKey, so green is
// the quiet baseline and never competes with an urgent tone on the same row (canon:
// colour is spent on attention). Keyed off the same visible bucket as the card/dot, so
// the two can never drift. A rejected post is never 'scheduled', so it is unaffected.
export function rowStatusKey(post) {
  const key = postDisplayStatusKey(post);
  if (key === 'scheduled' && post?.approval === 'approved') return 'approved';
  return key;
}

// STATUS_PILL_META plus the green 'approved' baseline (emerald, CheckCircle) that
// rowStatusKey introduces. Reuses APPROVAL_META.approved's tone so the overview's green
// matches the detail/approval surfaces exactly. Its label resolves from approval.approved
// ("Freigegeben"), NOT a status.<key> (there is no 'approved' status bucket) - the row
// status component handles that one label mapping.
export const ROW_STATUS_META = {
  ...STATUS_PILL_META,
  approved: { cls: STAIR.inMotion.cls, bar: '', strip: '', dot: STAIR.inMotion.dot, Icon: CheckCircle },
};

// Title-case a campaign id's base segment: "meta-rollout" -> "Meta Rollout".
function titleizeBase(base) {
  return base.replace(/-/g, ' ').replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

// "full-rollout-2026-06-12" -> "Full Rollout · 6/12/2026" (en-US) / "... ·
// 12.06.2026" (de-CH); the platform-prefixed month form "meta-rollout-2026-06"
// -> "Meta Rollout · June 2026" (UX-11: raw slugs read like infrastructure in an
// owner-facing select, and the YYYY-MM form would otherwise render the
// meaningless "Meta Rollout 2026 06"). Both date forms route through dateLocale()
// so the label matches every other on-screen date instead of a fixed dd.mm.yyyy.
export function prettyCampaign(id) {
  const ymd = String(id).match(/^(.*?)-(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) return `${titleizeBase(ymd[1])} · ${fmtDateShort(new Date(Number(ymd[2]), Number(ymd[3]) - 1, Number(ymd[4])))}`;
  const ym = String(id).match(/^(.*?)-(\d{4})-(\d{2})$/);
  if (ym) return `${titleizeBase(ym[1])} · ${fmtMonthYear(new Date(Number(ym[2]), Number(ym[3]) - 1, 1))}`;
  return titleizeBase(String(id));
}

// The campaign's base name with any trailing -YYYY-MM(-DD) date stripped, for
// surfaces that ALREADY show a post's own date and must not render a second,
// ambiguous campaign date next to it (PostDetail / Freigaben card / Planner row).
export function campaignBaseLabel(id) {
  return titleizeBase(String(id).replace(/-\d{4}-\d{2}(-\d{2})?$/, ''));
}

export function fmtDayAria(date) {
  return new Intl.DateTimeFormat(dateLocale(), { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(date);
}

// A safe display title for a post: never surface a machine timestamp as a title.
// If post.title looks like an ISO timestamp (…T12:01:55.124Z), skip it; fall back
// to the first caption line (also timestamp-guarded), else the given fallback (or
// the post id). One source of truth so Published/Planner never render raw ISO
// noise - and it future-proofs against a noisy caption whose first line is a date.
const ISO_TITLE_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
export function postDisplayTitle(post, fallback) {
  const title = post?.title?.trim();
  if (title && !ISO_TITLE_RE.test(title)) return title;
  const firstLine = post?.caption?.split('\n')[0]?.trim();
  if (firstLine && !ISO_TITLE_RE.test(firstLine)) return firstLine;
  return fallback || post?.id || '';
}

// Mandate F: the shared "what belongs in the Active campaigns picker" rule. An
// archived campaign (active !== true) must never appear in the top picker - it
// stays reachable only through the "All campaigns" filter mode. One source of
// truth so the picker and the campaign management table agree.
export function activeCampaigns(campaigns) {
  return (campaigns || []).filter((c) => c.active === true);
}

// ── Spec 37: the account-warmth publish ADVISORY judge (app-side MIRROR twin) ──────────
// A mirror of lib/lane-readiness.mjs#laneReadiness. The browser bundle cannot import lib/
// (server boundary - the same reason postNeedsMedia above is duplicated), so this is a
// hand-kept twin. ONE shared fixture (lib/lane-readiness.mjs READINESS_CASES) guards that
// this twin and the engine judge never drift (app twin test + node test both iterate it).
// After the 2026-07-13 reversal the judge no longer routes: it returns { advisories }
// (display-only warnings that accumulate); every approved reddit post auto-publishes. Keep
// the RULES and the advisory { code, params } shapes byte-identical to the engine.
export const MANUAL_LANES = new Set(['reddit']); // mirror of lib/lane-readiness.mjs (the fence)
export const WARMTH_MIN_AGE_DAYS = 30;
export const WARMTH_MIN_KARMA = 100;
export function laneReadiness(lane, inputs = {}) {
  if (!MANUAL_LANES.has(lane)) return { advisories: [] };
  const { accountAgeDays, linkKarma, commentKarma, subRequirementsMet, isPromo } = inputs || {};
  const advisories = [];
  if (isPromo !== false) advisories.push({ code: 'promo', params: {} });
  const age = Number(accountAgeDays);
  const lk = Number(linkKarma);
  const ck = Number(commentKarma);
  const karmaKnown = Number.isFinite(lk) && Number.isFinite(ck);
  const karma = karmaKnown ? lk + ck : null;
  if (!Number.isFinite(age) || !karmaKnown || age < WARMTH_MIN_AGE_DAYS || karma < WARMTH_MIN_KARMA) {
    advisories.push({ code: 'cold', params: { ageDays: Number.isFinite(age) ? age : null, karma } });
  }
  if (subRequirementsMet !== true) advisories.push({ code: 'subRequirements', params: {} });
  return { advisories };
}

// Extract the reddit warmth (state.reddit.warmth, surfaced on the setup reddit entry)
// into laneReadiness's warmth inputs. A missing warmth passes undefined age/karma so the
// judge fail-closes to 'cold'. `setup` is the useSetup() payload ({ platforms:[...] }).
export function redditWarmthInputs(setup) {
  const w = (setup?.platforms || []).find((p) => p.platform === 'reddit')?.warmth || null;
  return {
    accountAgeDays: w ? w.ageDays : undefined,
    linkKarma: w ? w.linkKarma : undefined,
    commentKarma: w ? w.commentKarma : undefined,
  };
}
export function redditWarmth(setup) {
  return (setup?.platforms || []).find((p) => p.platform === 'reddit')?.warmth || null;
}

// The Reddit karma builder (warm-up mode). A cold account's posts get filtered, so the loop is:
// comment genuinely to earn standing, watch the numbers climb, and only post once warm. These
// helpers are pure and display-only; the warm threshold is the SAME WARMTH_MIN_* the judge uses,
// so the gauge and the `cold` advisory can never disagree.

// The account's standing derived from the cached warmth ({ ageDays, linkKarma, commentKarma,
// karma }). Returns null when warmth was never probed (the gauge then shows a connect/measure
// prompt, never a fabricated 0 - data honesty). `warm` is true ONLY when BOTH gates are known
// and met, matching laneReadiness's `cold` predicate exactly.
export function warmthStanding(warmth) {
  if (!warmth || typeof warmth !== 'object') return null;
  const age = Number(warmth.ageDays);
  const lk = Number(warmth.linkKarma);
  const ck = Number(warmth.commentKarma);
  const ageKnown = Number.isFinite(age);
  const karmaKnown = Number.isFinite(lk) && Number.isFinite(ck);
  const karma = karmaKnown ? lk + ck : (Number.isFinite(Number(warmth.karma)) ? Number(warmth.karma) : null);
  const warm = ageKnown && karma != null && age >= WARMTH_MIN_AGE_DAYS && karma >= WARMTH_MIN_KARMA;
  return {
    ageDays: ageKnown ? age : null,
    linkKarma: Number.isFinite(lk) ? lk : null,
    commentKarma: Number.isFinite(ck) ? ck : null,
    karma,
    warm,
    // How far to warm, per gate; 0 once met, null when the input was never measured.
    toKarma: karma == null ? null : Math.max(0, WARMTH_MIN_KARMA - karma),
    toDays: ageKnown ? Math.max(0, WARMTH_MIN_AGE_DAYS - age) : null,
  };
}

// A warm-up (karma) query: the one flag that turns an ordinary Radar query into a karma builder.
export function isWarmupQuery(q) { return Boolean(q && q.warmup === true); }

// A brand-mention (reputation) query: the R9 flag that turns an ordinary Radar query into a watch
// for people talking ABOUT the brand, not buying intent.
export function isMentionQuery(q) { return Boolean(q && q.mention === true); }

// CLIENT MIRROR of lib/radar-prompt.mjs `brandBlock`: the exact "THE BRAND / THE PRODUCT" block the
// Radar agent will see, so the Setup card can show a faithful live preview. The server function is
// the source of truth; this mirrors it (the same pattern as signalIsMention/signalIsKarma mirroring
// server logic) because a Node lib cannot be imported into the browser bundle. Keep the two in step:
// if brandBlock changes, change this too. Returns '' when facts is empty (the pendpost-default case).
export function radarBrandPreview(brand) {
  const facts = brand && typeof brand.facts === 'string' ? brand.facts.trim() : '';
  if (!facts) return '';
  const audience = brand && typeof brand.audience === 'string' ? brand.audience.trim() : '';
  const notFor = brand && typeof brand.notForClaims === 'string' ? brand.notForClaims.trim() : '';
  const lines = [
    'THE BRAND / THE PRODUCT (the only facts you may state about it - nothing beyond this, and never',
    'invent a limitation either; if you do not know whether it does something, leave it out):',
    facts,
  ];
  if (audience) lines.push(`Who it serves: ${audience}`);
  if (brand.isSupplyOnly === true) {
    const who = audience ? ` (its audience is ${audience})` : '';
    lines.push(`A genuine signal is someone who could BECOME part of, or SUPPLY to, this product${who}. Someone merely LOOKING FOR what that audience offers is the wrong side of the market: treat it as out of scope - watch or ignore it, never draft a reply to it.`);
  }
  if (notFor) lines.push(`Never claim: ${notFor}`);
  return lines.join('\n');
}

// Is this signal a brand-mention item? True iff the saved search it matched is a mention query.
// Signals carry only the query ID (matchedQuery), so the query list is the source of truth -
// mirrors signalIsKarma exactly.
export function signalIsMention(signal, radar) {
  const qid = signal && signal.matchedQuery;
  if (!qid) return false;
  const qs = Array.isArray(radar?.queries) ? radar.queries : [];
  return qs.some((q) => isMentionQuery(q) && q.id === qid);
}

// Is this signal a karma-building item? True iff the saved search it matched is a warm-up query.
// Signals carry only the query ID (matchedQuery), so the query list is the source of truth.
export function signalIsKarma(signal, radar) {
  const qid = signal && signal.matchedQuery;
  if (!qid) return false;
  const qs = Array.isArray(radar?.queries) ? radar.queries : [];
  return qs.some((q) => isWarmupQuery(q) && q.id === qid);
}

// A karma item is a POST IDEA (a non-promo post to submit) rather than a comment target when it
// points at the subreddit itself instead of a thread: a real Reddit thread permalink carries
// `/comments/`, a subreddit link does not. The warm-up scan brief writes post ideas exactly that
// way (subreddit url, drafted post in the text), so the shape is the marker - no extra field to
// store. Caller gates this behind signalIsKarma so an ordinary reddit thread never qualifies.
export function signalIsPostIdea(signal) {
  if (!signal || signal.source !== 'reddit') return false;
  const url = String(signal.url || '');
  return /^https?:\/\//.test(url) && !/\/comments\//.test(url);
}

// The post's lanes that pendpost CANNOT publish to, because they are not connected - read
// from pendpost_health's setup (lib/setup.mjs), the same shape redditWarmth reads.
//
// Why this exists: approving is a no-op on an unconnected lane. setApproval checks the actor
// and self-approval and never connectivity, and the button was never disabled, so the one
// place an operator decides whether a post goes out was the one place that could not tell
// them it would not. The post then sat in the queue failing at publish time, forever.
//
// A 'skipped' lane is deliberately NOT unconnected: the operator said they are not using it,
// so the post is theirs to place and there is nothing to fix. Only an incomplete lane - one
// that is meant to work and does not - earns the hand-off. Unknown platform ids are ignored
// rather than guessed at: absence of evidence is not evidence of disconnection, and a false
// "you must post this yourself" on a working lane is the worse error.
export function unconnectedLanes(post, setup) {
  const rows = setup?.platforms;
  if (!Array.isArray(rows) || !rows.length) return [];
  return (post?.platforms || []).filter((p) => {
    const row = rows.find((r) => r.platform === p || r.platform === setupIdOf(p));
    return row ? row.status === 'incomplete' : false;
  });
}

// Where the operator is supposed to put a post pendpost cannot publish for them.
//
// Why this exists: the hand-off copied the caption and then opened `radarReplyTo.url ||
// externalUrl`, which a normal planned post carries neither of. So the button handed back a
// clipboard and no destination, and nothing on screen said where the text was meant to go.
// That is the dead end the hand-off was built to remove, one step further along.
//
// ONE rule for the table, so this never becomes a pile of per-platform guesses: every entry
// is the platform's OWN documented share/submit intent, built only from values we already
// hold. A lane we cannot resolve honestly returns { platform, url: null } - the destination
// NAME is still true and the UI says it plainly, but no URL is ever invented (the
// derivePermalinks discipline, lib/plans.mjs). Reddit-without-a-subreddit additionally
// carries reason: 'noSubreddit' so the UI can offer the fix instead of silence.
//
// Note which lanes can resolve at all while DISCONNECTED, because that is the whole case
// here: reddit works because the subreddit is a PLAN field (per-post, spec 36) with a config
// default behind it, and mastodon works because MASTODON_INSTANCE_URL is readable while the
// token is missing. Everything else has nothing to build from until it is connected.
export const HANDOFF_URL_BUDGET = 2000;

function withinBudget(url) {
  return url.length <= HANDOFF_URL_BUDGET;
}

// The client-side twin of the engine's link-capture gate (externalUrl/postedUrl "must be
// an absolute http(s) URL"): validating BEFORE the send lets the capture rows refuse a
// bad paste with a localized message instead of surfacing the raw English engine string.
export function isAbsoluteHttpUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// The text a lane would ACTUALLY publish - the same override precedence the engines
// resolve at publish time. The hand-off used to copy post.caption alone, but reddit
// publishes (redditText || caption), X publishes (xCaption || caption), and so on -
// so the clipboard could differ from what the approval gate approved, leaking the
// "post exactly this" promise (ux-audit dim-1, gap G5).
//
// ONE table, and every row is COPIED from the engine's own resolver line, never
// invented here: x-social.mjs tweetText, telegram-social.mjs / discord-social.mjs
// messageText, tiktok-social.mjs captionText, mastodon-social.mjs statusText,
// nostr-social.mjs noteText, reddit-social.mjs bodyText, pinterest-social.mjs
// pinDescription, wordpress-social.mjs bodyMarkdown, ghost-social.mjs postHtml
// (markdown source, pre-render). youtube is the one lane with NO caption fallback
// (yt-social.mjs buildMeta: snippet.description = post.description || '') - handing
// over the caption there would hand over text the engine never publishes. Every
// other lane (meta/linkedin/bluesky/gbp, and any future id) publishes the shared
// caption, which the default row expresses.
const LANE_TEXT_PRECEDENCE = {
  x: ['xCaption', 'caption'],
  telegram: ['tgCaption', 'caption'],
  discord: ['dcCaption', 'caption'],
  tiktok: ['ttCaption', 'caption'],
  mastodon: ['mastodonCaption', 'caption'],
  nostr: ['nostrCaption', 'caption'],
  reddit: ['redditText', 'caption'],
  pinterest: ['pinDescription', 'caption'],
  wordpress: ['body', 'caption'],
  ghost: ['body', 'caption'],
  youtube: ['description'],
};

export function effectiveLaneText(post, platform) {
  const fields = LANE_TEXT_PRECEDENCE[platform] || ['caption'];
  for (const field of fields) {
    const value = String(post?.[field] || '').trim();
    if (value) return value;
  }
  return '';
}

export function handOffTarget(post, platform, accounts) {
  // Prefill with the lane's EFFECTIVE text, so the submit page shows the same text
  // the engine would have published (and the same text the hand-off clipboard holds).
  const caption = effectiveLaneText(post, platform);
  if (platform === 'reddit') {
    const sub = String(post?.redditSubreddit || accounts?.reddit?.subreddit || '')
      .replace(/^\/?r\//, '')
      .trim();
    if (!sub) return { platform, url: null, reason: 'noSubreddit' };
    const base = `https://www.reddit.com/r/${sub}/submit`;
    const label = `r/${sub}`;
    const q = new URLSearchParams();
    const title = String(post?.title || '').trim();
    if (title) q.set('title', title);
    // A link post prefills the URL field; a self post prefills the body. Never both:
    // reddit's submit page is one or the other, and sending both picks for the operator.
    const link = String(post?.redditUrl || '').trim();
    if (link) q.set('url', link);
    else if (caption) q.set('text', caption);
    const full = `${base}?${q}`;
    if (withinBudget(full)) return { platform, url: full, label, truncated: false };
    // Over budget: drop the body, keep the title. The caption is on the clipboard either
    // way, so the operator loses a paste, not the text - and the hint says so.
    q.delete('text');
    const short = q.size ? `${base}?${q}` : base;
    return { platform, url: short, label, truncated: true };
  }
  if (platform === 'x') {
    const url = caption ? `https://x.com/intent/post?text=${encodeURIComponent(caption)}` : 'https://x.com/intent/post';
    return withinBudget(url)
      ? { platform, url, label: 'X', truncated: false }
      : { platform, url: 'https://x.com/intent/post', label: 'X', truncated: true };
  }
  if (platform === 'mastodon') {
    const instance = String(accounts?.mastodon?.instanceUrl || '').replace(/\/+$/, '').trim();
    if (!instance) return { platform, url: null };
    const label = instance.replace(/^https?:\/\//, '');
    const url = caption ? `${instance}/share?text=${encodeURIComponent(caption)}` : `${instance}/share`;
    return withinBudget(url)
      ? { platform, url, label, truncated: false }
      : { platform, url: `${instance}/share`, label, truncated: true };
  }
  return { platform, url: null };
}

// A radar reply-to / signal carries the source post's canonical URL on the AUTHOR's own
// instance (Mastodon status.url). Opening that lands the operator as an anonymous visitor on
// a remote instance ("Sign in to continue") even though they're signed into their OWN
// instance. When the source is Mastodon and we know our home instance, rewrite the link so the
// thread opens where the operator is already signed in: the status is federated onto our
// instance under externalId (the SAME id the reply fires at - NOT the id in the remote url,
// which is the author-instance id), so /@author/externalId is the local thread. Non-Mastodon
// sources and the disconnected case pass the URL through unchanged, mirroring handOffTarget.
export function mastodonThreadUrl({ source, url, author, externalId } = {}, accounts) {
  if (source !== 'mastodon') return url || null;
  const instance = String(accounts?.mastodon?.instanceUrl || '').replace(/\/+$/, '').trim();
  if (!instance) return url || null;
  const acct = String(author || '').replace(/^@/, '').trim();
  const id = String(externalId || '').trim();
  if (acct && id) return `${instance}/@${acct}/${id}`;               // full thread, logged in
  if (url) return `${instance}/authorize_interaction?uri=${encodeURIComponent(url)}`; // resolver fallback
  return url || null;
}

// The publish advisories for ONE reddit post, as displayed in the app (the Freigaben warmth
// warning). Fed by the post's isPromo + the cached warmth + subRequirementsMet. These are
// display-only: every approved reddit post auto-publishes regardless (owner: warn-and-allow).
// `subRequirementsMet` defaults true (optimistic) because the app does not run a live per-card
// presubmit - a genuinely sub-unmet post's subreddit problems surface via the PlatformBlockers panel.
export function redditPostReadiness(post, setup, subRequirementsMet = true) {
  if (!(post?.platforms || []).includes('reddit')) return { advisories: [] };
  // A Radar reply-to-external (spec 34) is human-gated and handled entirely by the radar path -
  // it is NOT a warmth-screened submission, so it carries no advisories here.
  if (post?.radarReplyTo) return { advisories: [] };
  return laneReadiness('reddit', { ...redditWarmthInputs(setup), isPromo: post?.isPromo, subRequirementsMet });
}

// DISPLAY ONLY (deliberately not in the judge, and not in the shared READINESS_CASES fixture):
// `cold` and `promo` together is not two pieces of news, it is one. A new account posting a
// promotional link is precisely the pattern Reddit's sitewide spam filter exists to catch, and
// showing the two as separate "heads-up" clauses is what let a launch post go out and get
// filtered. Collapsed, the operator gets one sentence that says what to DO instead. The engine
// judge (lib/lane-readiness.mjs) still emits both codes unchanged, so nothing downstream of it
// moves - this is a rendering merge, and the twin tests passing untouched is the proof.
function collapseColdPromo(list) {
  const cold = list.find((a) => a.code === 'cold');
  if (!cold || !list.some((a) => a.code === 'promo')) return list;
  // Keep the cold advisory's params (the age/karma numbers the sentence quotes) and drop the
  // promo row; any other advisory (subRequirements) keeps its own place after it.
  return [{ code: 'coldPromo', params: cold.params }, ...list.filter((a) => a.code !== 'cold' && a.code !== 'promo')];
}

// Localize the accumulated advisories ({ code, params }[]) into one warning string - used by
// the Freigaben warmth warning. `t` is injected (this stays a pure helper). A null age/karma
// (warmth never probed) renders as "?" so the sentence never says "null". The locale strings
// use {n} (days) / {k} (karma), matching Setup's setup.reddit.warmth.cold.
export function readinessAdvisoryText(t, advisories) {
  const list = collapseColdPromo(Array.isArray(advisories) ? advisories.filter((a) => a && a.code) : []);
  if (!list.length) return '';
  return list
    .map((a) => {
      const p = a.params || {};
      return t(`readiness.reason.${a.code}`, {
        n: p.ageDays == null ? '?' : p.ageDays,
        k: p.karma == null ? '?' : p.karma,
      });
    })
    .join(' · ');
}

export const TYPE_LABEL = {
  reel: 'Reel', story: 'Story', video: 'Video', text: 'Text', poll: 'Poll', carousel: 'Carousel',
  'youtube-short': 'YouTube Short', 'youtube-longform': 'YouTube Video', image: 'Image',
  'nostr-longform': 'Nostr article',
};

// C+D: the single source of truth for a post's media-container aspect, keyed by
// type. The calendar Week card and PostPreview both resolve their box height from
// this so a landscape YouTube longform reads SHORT (16:9) and a portrait reel reads
// TALL (9:16) instead of every type being force-cropped into one 9:16 frame; width
// stays uniform because the grid column owns it. Unknown/missing types fall back to
// the tall 9:16 box (the create-mode story/reel default).
const TYPE_ASPECT = {
  'youtube-longform': 'aspect-video', // 16:9 short
  video: 'aspect-[4/5]', // feed video
  image: 'aspect-square',
  text: 'aspect-[1.91/1]', // matches the LinkedIn card preview ratio
  'nostr-longform': 'aspect-[1.91/1]', // spec 18: a NIP-23 article card (reuses text's ratio)
  poll: 'aspect-[1.91/1]', // spec 10: a media-less text-card ratio (no media box)
  // Spec 05: the FALLBACK box for an album whose slides are not probed yet. The real
  // shape comes from carouselFrame(media.items) via mediaAspect below - square is only
  // the honest "unknown" default (IG's own default album frame), never a claim.
  carousel: 'aspect-square',
  reel: 'aspect-[9/16]', story: 'aspect-[9/16]', 'youtube-short': 'aspect-[9/16]',
};
export function coverAspect(type) {
  return TYPE_ASPECT[type] || 'aspect-[9/16]';
}

// The single source of truth for a probed render's box aspect, keyed by the
// backend's resolution label (lib/assets.mjs specChecks). Shared by the Assets
// grid AND mediaAspect below so the two can never drift. 'other'/unknown is absent
// on purpose - the caller falls back to the type-based aspect.
export const RES_ASPECT = {
  'story-9x16': 'aspect-[9/16]',
  'feed-4x5': 'aspect-[4/5]',
  'square-1x1': 'aspect-square',
};

// The same probed labels as a HUMAN-READABLE ratio, for the one place a carousel
// can honestly state its shape: the album itself. Deliberately a twin of RES_ASPECT
// rather than a merge - one is a Tailwind box class, the other is copy - and 'other'
// is absent from both on purpose (an off-spec file has no ratio to claim).
export const RES_RATIO = {
  'story-9x16': '9:16',
  'feed-4x5': '4:5',
  'square-1x1': '1:1',
};

// Spec 05: a carousel has no single media file, so its frame and its ratio have to
// come from the resolved SLIDES (post.media.items[], lib/plans.mjs resolveMediaItems)
// rather than from the type. Returns:
//   aspect - the box to draw. The FIRST probed slide wins, because that is the shape
//            the lane crops the album to; with object-contain an odd slide then
//            letterboxes visibly instead of being silently cropped.
//   ratio  - claimed ONLY when every probed slide agrees. Same honesty rule as
//            typeRatio below: silence beats a ratio that is wrong for some slide.
//   mixed  - true when the probed slides disagree, so the UI can say so. Not a
//            blocker: a mixed album publishes, it just crops on IG.
// 'other' and an unprobed null are "unknown", NOT a third shape - an unscanned slide
// must never make a uniform album read as mixed.
export function carouselFrame(items) {
  const labels = (Array.isArray(items) ? items : [])
    .map((it) => it?.resolution)
    .filter((r) => r && r !== 'other');
  const shapes = [...new Set(labels)];
  return {
    aspect: RES_ASPECT[labels[0]] || coverAspect('carousel'),
    ratio: shapes.length === 1 ? RES_RATIO[shapes[0]] : null,
    mixed: shapes.length > 1,
  };
}

// The cover box aspect for a PLANNER post: drive it off the media file's real
// measured shape when the asset scan has probed it (post.media.resolution), so a
// LinkedIn 4:5 video reads 4:5 and a 9:16 one reads 9:16 - instead of forcing every
// `video` type into one 4:5 box. Falls back to the type-keyed coverAspect when the
// probe is unknown ('other', not yet scanned, or a media-less text post).
export function mediaAspect(post) {
  // Spec 05: a carousel's shape lives on its slides, never on the (always null)
  // single media.resolution. Handled HERE rather than at each call site so the
  // Planner card, the preview and every future consumer are fixed at once.
  if (post?.type === 'carousel') return carouselFrame(post?.media?.items).aspect;
  return RES_ASPECT[post?.media?.resolution] || coverAspect(post?.type);
}

// --- Grid-crop preview (how a tall cover looks on a platform's profile grid) ---
//
// The reel PLAYER (feed + Reels tab) shows the full 9:16 - nothing is cut. But the
// profile GRID and Explore tiles center-crop that 9:16 cover to the grid tile ratio,
// silently trimming the top and bottom. Operators put title text there, so the grid
// often chops the very thing the cover was made to say. These helpers model that crop
// so the preview and the Planner can show the cover AS THE GRID WILL CROP IT.

// The numeric source aspect (width/height) of a post's cover, for crop math. The probe
// wins (same precedence as mediaAspect); type is the fallback when the file is not yet
// scanned or is off-spec ('other'). approximate=true whenever the number came from the
// type, so the UI can say so instead of implying a pixel-exact crop.
const RES_RATIO_NUM = { 'story-9x16': 9 / 16, 'feed-4x5': 4 / 5, 'square-1x1': 1 };
const TYPE_RATIO_NUM = {
  reel: 9 / 16, story: 9 / 16, 'youtube-short': 9 / 16,
  video: 4 / 5, image: 1, carousel: 1, 'youtube-longform': 16 / 9,
};
function sourceRatioNum(post) {
  if (post?.type === 'carousel') {
    const label = (Array.isArray(post?.media?.items) ? post.media.items : [])
      .map((it) => it?.resolution).find((r) => r && r !== 'other');
    if (label && RES_RATIO_NUM[label] != null) return { num: RES_RATIO_NUM[label], approximate: false };
    return { num: TYPE_RATIO_NUM.carousel, approximate: true };
  }
  const r = post?.media?.resolution;
  if (r && RES_RATIO_NUM[r] != null) return { num: RES_RATIO_NUM[r], approximate: false };
  const byType = TYPE_RATIO_NUM[post?.type];
  return byType != null ? { num: byType, approximate: true } : null;
}

// The single source of truth for a platform's profile-grid tile shape for VERTICAL
// covers. Only platforms whose grid tile is less-tall than a 9:16 cover appear here;
// a platform absent from the map imposes no grid crop (YouTube Shorts plays full
// 9:16; LinkedIn/X play native with no grid tile). Modeled and honestly approximate -
// platforms change these, so this is the ONE place to update. Ratios are width/height.
export const GRID_CROP = {
  instagram: { ratio: 4 / 5, aspect: 'aspect-[4/5]' }, // portrait grid tile (since 2025)
  facebook: { ratio: 4 / 5, aspect: 'aspect-[4/5]' }, // reels grid, portrait
  tiktok: { ratio: 3 / 4, aspect: 'aspect-[3/4]' },
  pinterest: { ratio: 2 / 3, aspect: 'aspect-[2/3]' },
};

// Given a post, which of its target platforms crop the cover on their grid, and by
// how much. `cropped` is true only when the source cover is TALLER (smaller w/h) than
// a target grid ratio. `tightest` is the worst-case crop (largest grid ratio = most
// trimmed); `keptFraction` = source/grid = the share of height that survives, centered.
// Stories are excluded on purpose: an IG/FB story is ephemeral and never hits the grid.
export function gridCropInfo(post) {
  const empty = { cropped: false, platforms: [], tightest: null, keptFraction: 1, approximate: false, aspect: null };
  if (post?.type === 'story') return empty;
  const src = sourceRatioNum(post);
  if (!src || src.num == null) return empty;
  const targets = (post?.platforms || [])
    .map((p) => {
      const g = GRID_CROP[p];
      return g && g.ratio > src.num + 1e-6 ? { platform: p, ratio: g.ratio, aspect: g.aspect } : null;
    })
    .filter(Boolean);
  if (!targets.length) return { ...empty, approximate: src.approximate };
  const tightest = targets.reduce((a, b) => (b.ratio > a.ratio ? b : a));
  return {
    cropped: true,
    platforms: targets,
    tightest,
    keptFraction: src.num / tightest.ratio,
    approximate: src.approximate,
    aspect: tightest.aspect,
  };
}

// The aspect a PLANNER card should draw so it mirrors the profile grid: the tightest
// cropping target's tile when the cover is cropped, else today's native mediaAspect.
// Reuses mediaAspect for the no-crop fallback so the two can never drift.
export function gridDisplayAspect(post) {
  const info = gridCropInfo(post);
  return info.cropped ? info.aspect : mediaAspect(post);
}

// Is this post's media a still image? The server's probe is authoritative
// (lib/assets.mjs IMAGE_CODECS -> media.kind), and the extension test only covers
// the window before a new file is scanned. Deliberately keyed on the MEDIA, not on
// post.type: a mistyped post (type=video carrying a JPEG) still renders honestly,
// and every consumer asks the question the same way. Drives the preview's img-vs-
// video branch, the file-row icon, and the cover editor's gate - which is why it
// lives here instead of being re-derived at each call site.
export function isImageMedia(media) {
  return media?.kind === 'image' || /\.(jpe?g|png)$/i.test(media?.url || '');
}
// CI-2 / mirrors lib/plans.mjs#postNeedsMedia (server, kept as a small local copy
// so the browser bundle never imports the server-only lib module - same pattern as
// PostDetail's COMMENT_CAPABLE_PLATFORMS/EDIT_LANE_ID). Text/article posts
// (LinkedIn), native polls (spec 10) and Nostr NIP-23 long-form articles (spec 18)
// carry no media by design; every other type does. Gates the validate-media probe
// (useValidateMedia) so a media-less post never fires GET .../validate-media - the
// server 404s (media_missing) on a post with no file/path, which is expected there
// but is just console noise on a type that was never going to have media.
export function postNeedsMedia(post) {
  return !['text', 'poll', 'nostr-longform'].includes(post?.type);
}

export const PLATFORMS = ['facebook', 'instagram', 'linkedin', 'youtube', 'x', 'telegram', 'discord', 'reddit', 'pinterest', 'tiktok', 'mastodon', 'wordpress', 'ghost', 'nostr', 'gbp'];

// The X developer portal where the operator tops up API credits (the account-level
// fix for an HTTP 402 credits-depleted lane halt). Single-sourced in the setup
// payload (lib/playbooks.mjs -> setup.platforms[].playbook.portalUrl); this constant
// is the fallback for surfaces that do not carry the health payload (e.g. Activity),
// and mirrors that value. Keep the two in step if X ever moves the portal.
export const X_PORTAL_URL = 'https://developer.x.com/en/portal/dashboard';

// The authorable post formats, in menu order. Shared by the Composer's format
// select and the PostDetail quick-edit select so the two lists can never drift.
// 'poll' (spec 10) is a media-less native poll offered only on the seven poll lanes.
// 'carousel' (spec 05) is a media-backed native album offered only on the carousel lanes.
// 'image' (spec 16) is a media-BACKED single-image TYPE offered ONLY on reddit (a Reddit
// image submission); it is an OPT_IN format (below) so it never leaks to another lane.
export const TYPES = ['reel', 'story', 'video', 'text', 'youtube-short', 'youtube-longform', 'poll', 'carousel', 'image', 'nostr-longform'];

// A12: the formats a given lane can actually publish, so a text-only lane
// (x/mastodon/nostr/…) is never offered "Reel"/"Story" and a feed lane is never
// offered a YouTube format. The visual feeds (instagram/tiktok) take reel/story/
// video; youtube takes its two native formats + plain video; every text/chat/blog
// lane publishes text or a plain video. EVERY real lane has an explicit entry below;
// an empty/unknown id falls back to BASE_FALLBACK_FORMATS (never the full TYPES), which
// deliberately EXCLUDES the opt-in TYPEs (poll/carousel) so a newly added TYPE can never
// auto-leak to an unlisted lane - the pinterest-offered-Poll regression this fixes (a
// lane opts IN to poll/carousel by unioning it into its own array, never via the fallback).
// For a MULTI-platform post the caller unions each lane's set (in TYPES order).
const VISUAL_LANE_FORMATS = ['reel', 'story', 'video'];
const TEXT_LANE_FORMATS = ['text', 'video'];
// Spec 10: the seven poll-capable lanes ADD 'poll' to their format list via their OWN
// array (`[...TEXT_LANE_FORMATS, 'poll']`) - never by mutating the shared
// TEXT_LANE_FORMATS const, which would leak the poll format to fb/wordpress/ghost/gbp
// (they also use it but publish no native poll).
const POLL_LANE_FORMATS = [...TEXT_LANE_FORMATS, 'poll'];
// Spec 05: the carousel-capable lanes ADD 'carousel' to their format list via their OWN
// array - never by mutating a shared const, which would leak the native-album format to
// fb/tiktok/mastodon/nostr/... (they assemble no carousel: FB stays reel-gated, tiktok
// photo-mode + mastodon/nostr have no engine branch). instagram rides the visual set;
// x/linkedin/telegram/discord/reddit ride the poll set; pinterest has its OWN explicit
// entry (below) so it offers carousel WITHOUT the poll leak the old full-TYPES fallback
// caused (spec 05 review #7 - pinterest has no poll engine).
const VISUAL_CAROUSEL_FORMATS = [...VISUAL_LANE_FORMATS, 'carousel'];
const POLL_CAROUSEL_FORMATS = [...POLL_LANE_FORMATS, 'carousel'];
// The opt-in TYPEs kept OUT of the fallback so no future TYPE auto-leaks to an unlisted
// lane; a lane offers one only by unioning it into its own array above. Spec 16 adds
// 'image' here so the Reddit-only image TYPE can never leak to another lane's format
// select; spec 18 adds 'nostr-longform' so the Nostr-only NIP-23 article TYPE stays
// nostr-exclusive (only nostr unions it in below).
const OPT_IN_FORMATS = ['poll', 'carousel', 'image', 'nostr-longform'];
const BASE_FALLBACK_FORMATS = TYPES.filter((t) => !OPT_IN_FORMATS.includes(t));
// Spec 16: reddit ADDS 'image' to its own array (never via the fallback) - so ONLY reddit
// offers the image submission TYPE, alongside the poll + carousel it already gained.
const REDDIT_FORMATS = [...POLL_CAROUSEL_FORMATS, 'image'];
// Spec 17: pinterest's PLATFORM_FORMATS is now an EXPLICIT, HONEST list of what the
// pin engine actually publishes - a native video pin (type=video, spec 17), a native
// carousel pin (type=carousel, spec 05) and a plain image pin (type=image, the
// same public-imageUrl path reddit's type=image also opts into). It no longer
// borrows reel/story/text/youtube-short/youtube-longform from the base fallback -
// the pin engine never assembled those as anything but an untyped image pin, so
// offering them was a leftover from the pre-spec-05 full-TYPES fallback (tidy fold-
// in flagged by spec 17). Existing posts of a since-dropped type keep publishing
// (cmdPublishDue still branches on post.type, not on this offered set) - this only
// changes what the Composer/PostDetail format selects OFFER going forward.
const PLATFORM_FORMATS = {
  // Spec 39: instagram ADDS 'image' to its own array (never via the shared consts -
  // the OPT_IN anti-leak rule): the feed IMAGE container publishes from the public
  // imageUrl, the same transport pinterest's image pin uses.
  instagram: [...VISUAL_CAROUSEL_FORMATS, 'image'],
  tiktok: VISUAL_LANE_FORMATS,
  youtube: ['youtube-short', 'youtube-longform', 'video'],
  facebook: TEXT_LANE_FORMATS,
  linkedin: POLL_CAROUSEL_FORMATS,
  // Byte lanes: media-kind-driven engines that upload a still image directly, so each ADDS
  // 'image' via its OWN array (the OPT_IN anti-leak rule), twin-guarded against IMAGE_LANES in
  // capabilities.mjs. linkedin stays image-free above: its still images exist only as carousel
  // slides / an article hero, never a single-image share.
  x: [...POLL_CAROUSEL_FORMATS, 'image'],
  telegram: [...POLL_CAROUSEL_FORMATS, 'image'],
  discord: [...POLL_CAROUSEL_FORMATS, 'image'],
  reddit: REDDIT_FORMATS,
  pinterest: ['video', 'carousel', 'image'],
  // E2: mastodon assembles a native album of up to 4 attachments, so it gets its OWN
  // array with 'carousel' rather than mutating the shared POLL_LANE_FORMATS const, which
  // would leak the format to fb/tiktok/nostr, none of which assemble one. It also uploads a
  // single still image by kind, so it ADDS 'image' the same way (twin-guarded by IMAGE_LANES).
  mastodon: [...POLL_LANE_FORMATS, 'carousel', 'image'],
  wordpress: TEXT_LANE_FORMATS,
  ghost: TEXT_LANE_FORMATS,
  // Spec 18: nostr ADDS the NIP-23 long-form article to its own array (never via the
  // fallback) - so ONLY nostr offers 'nostr-longform', alongside the poll it already had.
  nostr: [...POLL_LANE_FORMATS, 'nostr-longform'],
  gbp: TEXT_LANE_FORMATS,
};
export function formatsForPlatform(platformId) {
  return PLATFORM_FORMATS[platformId] || BASE_FALLBACK_FORMATS;
}

// The aspect ratio each lane RECOMMENDS for a format, shown in brackets next to the
// format name so an operator renders the right shape before attaching media.
//
// Sparse ON PURPOSE. A lane with no canonical ratio (telegram/discord/reddit/
// mastodon/nostr/wordpress/ghost/gbp accept whatever you send) has no entry, and its
// formats render label-only rather than inventing a spec that does not exist. That is
// also why this is NOT a type-keyed default with per-lane overrides: a default would
// have to print "Video (16:9)" on Telegram, which has no such rule.
//
// Distinct from TYPE_ASPECT above, which is a LAYOUT box (how tall to draw the
// preview, and overridden by the real probed resolution). The two legitimately
// disagree - X video is 16:9 here, 4:5 there - so they must not be merged.
//
// instagram.image shipped with spec 39 (the feed IMAGE container; 4:5 is IG's
// recommended portrait feed ratio).
//
// NO `carousel` entry for instagram/x/linkedin, on purpose. Those lanes accept more
// than one album shape (IG publishes 1:1 AND 4:5 children; X and LinkedIn pin no
// ratio at all), so the old `carousel: '1:1'` was an invented spec - it printed
// "Karussell (1:1)" over a real 1080x1350 album. A carousel's actual constraint is
// "every slide the same shape", which no single ratio can express, so the album
// REPORTS its measured shape via carouselFrame instead of the label CLAIMING one.
// pinterest keeps its entry: 2:3 is the same recommendation it makes for every pin
// format, so it is a real rule rather than a guess.
const PLATFORM_TYPE_RATIO = {
  instagram: { reel: '9:16', story: '9:16', video: '4:5', image: '4:5' },
  tiktok: { reel: '9:16', story: '9:16', video: '9:16' },
  youtube: { 'youtube-short': '9:16', 'youtube-longform': '16:9', video: '16:9' },
  x: { video: '16:9' },
  linkedin: { video: '16:9' },
  facebook: { video: '16:9' },
  pinterest: { video: '2:3', image: '2:3', carousel: '2:3' },
};

// The ratio to show for a format on THIS post's target lanes. A post can target
// several lanes at once and one file cannot be two shapes, so this reports a ratio
// only when every targeted lane that HAS a rule agrees. An x+mastodon video reads
// 16:9 (mastodon has no rule, so it does not object); an instagram+x video reports
// nothing, because 4:5 and 16:9 are both wrong for the other lane and silence is
// honest where no single answer is right.
export function typeRatio(platforms, type) {
  const ratios = new Set((platforms || []).map((p) => PLATFORM_TYPE_RATIO[p]?.[type]).filter(Boolean));
  return ratios.size === 1 ? [...ratios][0] : null;
}

// The ONE format-option label, so the Composer's select and the PostDetail select
// (twins that must never drift) read identically: "Reel (9:16)", or a bare "Reel"
// when no targeted lane pins a ratio.
export function typeOptionLabel(t, platforms, type) {
  const ratio = typeRatio(platforms, type);
  return ratio ? `${t(`type.${type}`)} (${ratio})` : t(`type.${type}`);
}

// ── Per-platform field relevance ──────────────────────────────────────────────
// The SINGLE source of truth for "which content fields does this post actually
// use", so the Composer (authoring) and the PostDetail dialog (review) render the
// SAME field set and can never drift. Derived by reading each engine lane in
// scripts/<lane>-social.mjs to see what it consumes:
//   - `caption` is the shared base body text. Every chat/feed lane reads it
//     (fb, ig, linkedin, telegram, discord, reddit, pinterest, tiktok, gbp), and
//     x/mastodon/nostr read it as the FALLBACK behind their own note override.
//     youtube + the blog lanes (wordpress/ghost) ignore it entirely — a YouTube
//     video posts title+description, an article posts title+body — so a "caption"
//     field there is pure noise (the "Kein Bildtext" bug this model fixes).
//   - the per-platform note overrides REPLACE the caption for their one lane:
//     xCaption (x), mastodonCaption (mastodon), nostrCaption (nostr).
//   - youtube: title + description + tags + blogSlug (+ firstComment).
//   - wordpress/ghost: title + body + excerpt + tags + image (ghost adds
//     canonicalUrl + the newsletter opt-in ghostEmail, refined by newsletter/
//     emailSegment/emailOnly, spec 01) + metaTitle/metaDescription/
//     featureImageAlt (spec 13; wpCategories is WordPress-only).
//   - linkedin text/article: title + liDescription + link + image.
//   - instagram: firstComment (feed) OR interactiveStory + hashtags (story).
//   - gbp: the local-post intent object.
const CAPTION_PLATFORMS = ['facebook', 'instagram', 'linkedin', 'x', 'telegram', 'discord', 'reddit', 'pinterest', 'tiktok', 'mastodon', 'nostr', 'gbp'];

// Which targeted platforms consume `field`, in PLATFORMS order (for the label
// icons that show an operator exactly which networks a field feeds).
const FIELD_PLATFORMS = {
  caption: CAPTION_PLATFORMS,
  xCaption: ['x'],
  xReplyTo: ['x'],
  mastodonCaption: ['mastodon'],
  nostrCaption: ['nostr'],
  // B1 (ux-audit dim-6 P1): the remaining per-lane prose overrides the engines
  // publish (LANE_TEXT_PRECEDENCE above mirrors the engine resolvers). They were
  // MCP-writable but invisible in the app - an agent could ship text the
  // approver never saw. Each is lane-exclusive, like xCaption.
  tgCaption: ['telegram'],
  dcCaption: ['discord'],
  ttCaption: ['tiktok'],
  redditText: ['reddit'],
  // Pinterest carries TWO overrides: pinDescription shadows the caption (the
  // engine's pinDescription || caption), pinTitle shadows post.title (which has
  // no pinterest surface of its own in this map).
  pinTitle: ['pinterest'],
  pinDescription: ['pinterest'],
  // The pinned first comment: Instagram posts it under a feed post, YouTube pins
  // it on the video (scripts/yt-social.mjs postComment); LinkedIn posts it as a
  // comment on the org's own share right after publish (spec 11, scripts/
  // linkedin-social.mjs postComment). Stories have no comment.
  firstComment: ['instagram', 'youtube', 'linkedin'],
  interactiveStory: ['instagram'],
  // Spec 18: a Nostr NIP-23 article's hashtags map to `t` topic tags.
  hashtags: ['instagram', 'nostr'],
  // Spec 18: a Nostr long-form article also reads title/body/excerpt/image (the
  // shared blog long-form fields), so those badge the nostr lane too.
  title: ['youtube', 'linkedin', 'wordpress', 'ghost', 'nostr'],
  description: ['youtube'],
  tags: ['youtube', 'wordpress', 'ghost'],
  blogSlug: ['youtube'],
  body: ['wordpress', 'ghost', 'nostr'],
  excerpt: ['wordpress', 'ghost', 'nostr'],
  canonicalUrl: ['ghost'],
  ghostEmail: ['ghost'],
  // Spec 01: Ghost newsletter refinements riding the ghostEmail opt-in - which
  // newsletter, which audience segment, and email-only (no web version).
  newsletter: ['ghost'],
  emailSegment: ['ghost'],
  emailOnly: ['ghost'],
  link: ['linkedin'],
  image: ['linkedin', 'wordpress', 'ghost', 'nostr'],
  // Specs 17+39: the PUBLIC media URL for the URL-only lanes - the pinterest pin
  // image / video-pin cover, and the instagram feed IMAGE container. Distinct from
  // `image` above (the LinkedIn/blog article decoration on a TEXT post).
  imageUrl: ['pinterest', 'instagram'],
  liDescription: ['linkedin'],
  gbp: ['gbp'],
  // Specs 21+39: cross-lane image alt-text (X media metadata, WordPress attachment
  // alt_text/caption, Pinterest pin alt_text, Instagram feed-IMAGE container
  // alt_text - spec 39 closed the IG coverage gate).
  altText: ['x', 'wordpress', 'pinterest', 'instagram'],
  // Spec 13: rich long-form metadata - SEO meta title/description (Yoast/
  // RankMath on WordPress, native on Ghost) and the feature-image alt text (both
  // blog lanes). wpCategories is WordPress-only taxonomy, distinct from tags -
  // Ghost has no categories concept (tags + native meta cover it).
  metaTitle: ['wordpress', 'ghost'],
  metaDescription: ['wordpress', 'ghost'],
  featureImageAlt: ['wordpress', 'ghost'],
  wpCategories: ['wordpress'],
  // Spec 27: draft/pending-review publish status - hand off to a native
  // WordPress draft or the TikTok inbox for a human to finish + publish.
  publishAsDraft: ['wordpress', 'ghost', 'tiktok'],
  // Spec 14: rich link/CTA - Telegram inline buttons + link-preview/format
  // control, and a Discord rich embed card. Each is lane-exclusive (one
  // structured object per lane, never shared).
  tgCta: ['telegram'],
  dcEmbed: ['discord'],
  // Spec 26: Discord forum/thread targeting - a webhook posts into a specific
  // forum/media-channel thread (new via dcThreadName, or an existing one via
  // dcThreadId). Discord-only, mutually exclusive (platformValidate warns).
  dcThreadName: ['discord'],
  dcThreadId: ['discord'],
  // Spec 25: disclosure & interaction settings - TikTok interaction/disclosure
  // post_info flags (duet/stitch/comment, AI-label, branded-content, cover
  // frame), a Mastodon content-warning (spoiler_text + sensitive), and an X
  // reply-audience enum (reply_settings). Each is lane-exclusive.
  ttInteraction: ['tiktok'],
  spoilerText: ['mastodon'],
  xReplySettings: ['x'],
  // Spec 10: the native-poll object feeds the seven poll-capable lanes (the label
  // icons show which of the post's targets carry the poll).
  poll: ['x', 'linkedin', 'telegram', 'discord', 'mastodon', 'reddit', 'nostr'],
  // Spec 05: the native-carousel slide set feeds the seven carousel-capable lanes.
  mediaItems: ['instagram', 'x', 'linkedin', 'telegram', 'discord', 'reddit', 'pinterest', 'mastodon'],
  // Spec 16: the Reddit link submission URL + the picked link-flair template - all
  // reddit-exclusive (the engine reads them only on the reddit lane).
  redditUrl: ['reddit'],
  redditFlairId: ['reddit'],
  redditFlairText: ['reddit'],
  // Spec 36: the per-post destination subreddit (falls back to the connection
  // default REDDIT_SUBREDDIT). Reddit-exclusive - the engine reads it only there.
  redditSubreddit: ['reddit'],
  // Spec 37: organic-vs-promotional flag. Reddit-exclusive - it decides the reddit
  // publish tier (a promo post always degrades to manual). ABSENCE = promo.
  isPromo: ['reddit'],
  // Spec 17: the Pinterest board-section target - rides POST /v5/pins on either
  // the image or the native-video pin path. Pinterest-exclusive.
  pinBoardSection: ['pinterest'],
};

// Spec 10: the offered poll durations, in menu order. `minutes` is what persists on
// post.poll.durationMinutes; `key` selects the i18n label (composer.poll.duration.<key>).
// Shared by the Composer's duration <select> AND the PostDetail read-only recap so the
// two never label the same duration differently.
export const POLL_DURATIONS = [
  { minutes: 5, key: '5min' },
  { minutes: 60, key: '1h' },
  { minutes: 1440, key: '1d' },
  { minutes: 4320, key: '3d' },
  { minutes: 10080, key: '7d' },
];
export const POLL_DEFAULT_DURATION = 1440;
// The i18n label key for a stored duration, or null for a non-preset value (the
// caller falls back to "<n> min").
export function pollDurationKey(minutes) {
  return POLL_DURATIONS.find((d) => d.minutes === minutes)?.key || null;
}

// The pure relevance map for a post's (platforms, type): true iff at least one
// targeted platform consumes the field. Mirrors the Composer's conditional-field
// gates EXACTLY (verified line-by-line against Composer.jsx), so both surfaces
// share one rule. Type-gated fields (firstComment/interactiveStory/hashtags/
// link/liDescription) fold the type in.
export function fieldRelevance(platforms = [], type = 'reel') {
  const has = (p) => platforms.includes(p);
  const anyBlog = has('wordpress') || has('ghost');
  const liArticle = has('linkedin') && type === 'text'; // Composer isLinkedinArticle
  // Spec 18: a Nostr NIP-23 long-form article reuses the blog long-form authoring UI
  // (title/body/excerpt/image/hashtags). Its content is the Markdown body, so the
  // short-note caption + nostrCaption are meaningless for it - suppressed below to keep
  // the article authoring surface clean (net-simplify).
  const nostrLong = has('nostr') && type === 'nostr-longform';
  return {
    caption: CAPTION_PLATFORMS.some(has) && !nostrLong,
    xCaption: has('x'),
    xReplyTo: has('x'),
    mastodonCaption: has('mastodon'),
    nostrCaption: has('nostr') && !nostrLong,
    // B1: the chat/feed-lane prose overrides, each gated on its own lane only
    // (not type-gated - every post type on that lane publishes the text).
    tgCaption: has('telegram'),
    dcCaption: has('discord'),
    ttCaption: has('tiktok'),
    redditText: has('reddit'),
    pinTitle: has('pinterest'),
    pinDescription: has('pinterest'),
    // Instagram: feed only (a story has no comment). YouTube: any video (pinned
    // first comment). LinkedIn: any share type (spec 11 - unlike an IG story, a
    // LinkedIn share always has a comment surface). scripts/yt-social.mjs +
    // meta-social.mjs + linkedin-social.mjs all consume it.
    firstComment: (has('instagram') && type !== 'story') || has('youtube') || has('linkedin'),
    interactiveStory: has('instagram') && type === 'story',
    // Spec 18: a Nostr article's hashtags map to NIP-23 `t` topic tags.
    hashtags: (has('instagram') && type === 'story') || nostrLong,
    title: has('youtube') || has('linkedin') || anyBlog || nostrLong,
    description: has('youtube'),
    tags: has('youtube') || anyBlog,
    blogSlug: has('youtube'),
    body: anyBlog || nostrLong,
    excerpt: anyBlog || nostrLong,
    canonicalUrl: has('ghost'),
    ghostEmail: has('ghost'),
    newsletter: has('ghost'),
    emailSegment: has('ghost'),
    emailOnly: has('ghost'),
    link: liArticle,
    image: liArticle || anyBlog || nostrLong,
    // Specs 17+39: the public media URL. The asymmetry is DELIBERATE and must not
    // be tidied into symmetry: pinterest is NOT type-gated because a pinterest
    // VIDEO pin also requires imageUrl as its cover_image_url; instagram needs it
    // only for the feed IMAGE type.
    imageUrl: has('pinterest') || (has('instagram') && type === 'image'),
    liDescription: liArticle,
    gbp: has('gbp'),
    // Meaningful only alongside an uploadable image; each engine no-ops when the
    // post carries none (honest, avoids type-coupling in this relevance map).
    altText: has('x') || has('wordpress') || has('pinterest') || has('instagram'),
    // Spec 13: rich long-form metadata - SEO meta + feature-image alt apply to
    // either blog lane; wpCategories is WordPress-only (Ghost has no categories).
    metaTitle: anyBlog,
    metaDescription: anyBlog,
    featureImageAlt: anyBlog,
    wpCategories: has('wordpress'),
    // Spec 27: draft/pending-review publish status - WordPress `status=draft`
    // or the TikTok inbox upload. Approval (§H.2) is untouched; this only
    // changes the destination status once the engine is already allowed to act.
    publishAsDraft: has('wordpress') || has('ghost') || has('tiktok'),
    // Spec 14: rich link/CTA - Telegram inline CTA buttons + link-preview/
    // format control; Discord rich embed card. Not type-gated (both lanes'
    // sendMessage/webhook accept them regardless of type).
    tgCta: has('telegram'),
    dcEmbed: has('discord'),
    // Spec 26: Discord forum/thread targeting fields - not type-gated (the
    // webhook accepts them regardless of post type).
    dcThreadName: has('discord'),
    dcThreadId: has('discord'),
    // Spec 25: disclosure & interaction settings. Not type-gated (each engine's
    // publish path accepts the field regardless of post type).
    ttInteraction: has('tiktok'),
    spoilerText: has('mastodon'),
    xReplySettings: has('x'),
    // Spec 10: the poll options/duration block is type-gated (like interactiveStory).
    // The format select only offers 'poll' on the seven poll lanes, so a poll-typed
    // post already targets a poll-capable lane.
    poll: type === 'poll',
    // Spec 05: the carousel slide picker is type-gated. The format select only offers
    // 'carousel' on the seven carousel lanes, so a carousel-typed post already targets
    // a carousel-capable lane.
    mediaItems: type === 'carousel',
    // Spec 16: the Reddit link URL + flair picker apply whenever reddit is targeted
    // (not type-gated - a link post is type=text+redditUrl, and any reddit post can
    // carry a flair). The engine ignores them on every other lane.
    redditUrl: has('reddit'),
    redditFlairId: has('reddit'),
    redditFlairText: has('reddit'),
    // Spec 36: the per-post subreddit target applies whenever reddit is targeted.
    redditSubreddit: has('reddit'),
    // Spec 37: the organic/promotional toggle applies whenever reddit is targeted
    // (not type-gated - any reddit post carries the flag; the engine ignores it elsewhere).
    isPromo: has('reddit'),
    // Spec 17: the board-section picker applies whenever pinterest is targeted
    // (not type-gated - both the image and native-video pin path accept it).
    pinBoardSection: has('pinterest'),
  };
}

// The editable text fields for the detail dialog, in render order (primary text
// leads: the platform's own body text first, then its supporting fields). `kind`
// picks the control (textarea vs single-line input); `mono` flags the markdown
// body. PostDetail resolves the i18n label + renders each; Composer reuses the
// relevance map above for its own gating.
const EDITABLE_FIELDS = [
  { key: 'caption', kind: 'textarea' },
  { key: 'xCaption', kind: 'textarea' },
  { key: 'xReplyTo', kind: 'input' },
  // B1: the Telegram/Discord message overrides sit with their lane's other
  // fields (dcCaption directly above the Discord thread-targeting pair).
  { key: 'tgCaption', kind: 'textarea' },
  { key: 'dcCaption', kind: 'textarea' },
  // Spec 26: Discord forum/thread targeting - the thread to post into (a NEW
  // forum thread by name, or an EXISTING thread by id; mutually exclusive).
  { key: 'dcThreadName', kind: 'input' },
  { key: 'dcThreadId', kind: 'input' },
  { key: 'ttCaption', kind: 'textarea' },
  { key: 'mastodonCaption', kind: 'textarea' },
  { key: 'nostrCaption', kind: 'textarea' },
  // Spec 25: Mastodon content-warning text - the sibling short-note override
  // fields carry it, so it sits with them here.
  { key: 'spoilerText', kind: 'input' },
  // B1: the Reddit self-post body override + the two Pinterest pin overrides
  // (pinTitle shadows post.title, pinDescription shadows the caption).
  { key: 'redditText', kind: 'textarea' },
  { key: 'pinTitle', kind: 'input' },
  { key: 'pinDescription', kind: 'textarea' },
  { key: 'title', kind: 'input' },
  { key: 'description', kind: 'textarea' },
  { key: 'body', kind: 'textarea', mono: true },
  { key: 'excerpt', kind: 'textarea' },
  { key: 'liDescription', kind: 'textarea' },
  { key: 'tags', kind: 'input' },
  { key: 'firstComment', kind: 'textarea' },
  { key: 'altText', kind: 'textarea' },
  // Spec 13: rich long-form metadata (WordPress/Ghost).
  { key: 'metaTitle', kind: 'input' },
  { key: 'metaDescription', kind: 'textarea' },
  { key: 'wpCategories', kind: 'input' },
  { key: 'featureImageAlt', kind: 'input' },
];

// The relevant-but-read-only extras (authored in the Composer, shown here for
// review completeness): supporting URLs/flags + the structured intent objects.
// Spec 16: redditUrl (the link submission target) + redditFlairId (rendered as a flair
// chip - PostExtras shows redditFlairText || redditFlairId) ride here as read-only review
// rows. redditFlairText is intentionally NOT listed (it rides the redditFlairId chip).
// Spec 36: redditSubreddit (the per-post target) rides here as a read-only review row
// shown only when set - mirroring its spec-16 siblings redditUrl/redditFlairId, so a
// no-subreddit post's Details block stays byte-identical to today.
// Spec 37: isPromo rides here as a read-only review row (shown only when a post is
// explicitly ORGANIC, isPromo === false - the informative case; a promo/unset post shows
// no row, byte-identical to before). Editing happens in the Composer, matching the
// established boolean pattern (publishAsDraft/emailOnly are authored in the Composer and
// reviewed read-only here - ContentField only renders text controls). Net-simplify: no
// second edit surface for the same flag.
const EXTRA_FIELDS = ['link', 'image', 'imageUrl', 'redditUrl', 'redditFlairId', 'redditSubreddit', 'isPromo', 'pinBoardSection', 'canonicalUrl', 'blogSlug', 'ghostEmail', 'newsletter', 'emailSegment', 'emailOnly', 'hashtags', 'gbp', 'interactiveStory', 'publishAsDraft', 'tgCta', 'dcEmbed', 'ttInteraction', 'xReplySettings', 'poll'];

// The platforms (in PLATFORMS order) that `field` feeds on THIS post — its
// declared platform set intersected with the post's targets.
function platformsForField(field, targeted) {
  const set = FIELD_PLATFORMS[field] || [];
  return set.filter((p) => targeted.includes(p));
}

// Override collapse: which ONE caption field to HIDE so a post never shows two
// fields for one message. Two mirror-image cases:
//   - Single override lane: the base caption IS the post, so hide the still-empty
//     per-platform override. It stays visible once it carries its own content
//     (legacy posts keep both fields with the override hint).
//   - Several targets, ALL override lanes each carrying its OWN non-empty text:
//     the base caption is unpublishable (every lane overrides it), so hide it.
//     Conservative — any target without an override, or an empty one, keeps the
//     base caption visible (a later platform with no override still falls back to
//     it, so the field is kept in the data model, just not rendered here).
// `values` holds the current field values (a post object, or the Composer's live
// draft merged with the saved post).
//
// The platform -> override-field map is DERIVED from LANE_TEXT_PRECEDENCE (B1:
// one source of precedence knowledge, never a second hand-written copy): a lane
// qualifies when its precedence is [override, caption] AND the override field is
// exclusive to that lane (FIELD_PLATFORMS). The exclusivity check is what keeps
// wordpress/ghost out - their [body, caption] head is the SHARED blog body, a
// primary field that must never be collapse-hidden. Exported for PostDetail's
// override-hint rendering (same set, same source).
export const OVERRIDE_FIELD = Object.fromEntries(
  Object.entries(LANE_TEXT_PRECEDENCE)
    .filter(([, fields]) => fields.length === 2 && fields[1] === 'caption' && (FIELD_PLATFORMS[fields[0]] || []).length === 1)
    .map(([platform, fields]) => [platform, fields[0]]),
);
export function collapsedOverrideKey(platforms, values = {}) {
  const list = platforms || [];
  if (list.length === 1) {
    const key = OVERRIDE_FIELD[list[0]];
    return key && !String(values[key] || '').trim() ? key : null;
  }
  if (list.length > 1 && list.every((p) => OVERRIDE_FIELD[p] && String(values[OVERRIDE_FIELD[p]] || '').trim())) {
    return 'caption';
  }
  return null;
}

// The full render model for the PostDetail dialog: the relevance map (also used
// by tests + Composer), the ordered EDITABLE fields (each with the targeted
// platforms that consume it), and the ordered read-only EXTRAS. Never lists a
// field no targeted platform uses.
export function fieldsForPost(post) {
  const platforms = post?.platforms || [];
  const type = post?.type || 'reel';
  const rel = fieldRelevance(platforms, type);
  const collapsed = collapsedOverrideKey(platforms, post || {});
  const fields = EDITABLE_FIELDS
    .filter((f) => rel[f.key] && f.key !== collapsed)
    .map((f) => ({ ...f, platforms: platformsForField(f.key, platforms) }));
  const extras = EXTRA_FIELDS
    .filter((k) => rel[k])
    .map((k) => ({ key: k, platforms: platformsForField(k, platforms) }));
  return { rel, fields, extras };
}

// The SETUP id a DISPLAY platform keys off for connection + skip. Facebook and
// Instagram are two display entities behind ONE Meta connector, so both resolve to
// 'meta'; every other display platform maps to itself. Single source of truth so
// visiblePlatforms and platformEnabled agree on which account/skip slot to read.
const SETUP_ID = { facebook: 'meta', instagram: 'meta' };
export function setupIdOf(platform) {
  return SETUP_ID[platform] || platform;
}

// A display platform is CONNECTED when its accountStatus slot authenticates. Meta
// (facebook/instagram) reports `configured` (a Page token + id); reddit accepts
// either authenticated OR configured (script-app creds == both); every other lane
// reports `authenticated` (the wave-2 static lanes mastodon/wordpress/ghost/nostr
// and OAuth gbp all set it). Mirrors lib/setup.mjs hasCredential / accountStatus.
function platformConnected(platform, accounts) {
  const slot = accounts?.[setupIdOf(platform)];
  if (!slot) return false;
  if (platform === 'facebook' || platform === 'instagram') return Boolean(slot.configured);
  if (platform === 'reddit') return Boolean(slot.authenticated || slot.configured);
  return Boolean(slot.authenticated);
}

// The POLICY half of "show this logo": is the platform turned ON in posting policy?
// Deny-by-default for Facebook (the one Meta lane that ships off - only Instagram
// shows by default), default-ON for everything else (hidden only by an explicit
// posting.platforms[p] === false). Mirrors lib/mode.mjs / lib/writes.mjs.
export function platformEnabled(platform, posting) {
  const policy = posting?.platforms || {};
  if (platform === 'facebook') return policy.facebook === true;
  return policy[platform] !== false;
}

// The SINGLE source of truth for "show only the relevant platform logos": a display
// platform appears ONLY where it is connected AND enabled AND not skipped. Returns
// the matching display ids in PLATFORMS order (facebook conditionally present).
// "Not skipped" reads posting.skippedPlatforms (SETUP ids), so a skipped Meta hides
// both facebook AND instagram. The skip is checked BEFORE connection so the rule
// reads literally, but it can only ever bite an UNCONNECTED lane: exactly mirroring
// lib/setup.mjs (isSkipped = !connected && skipped.includes(p)), a skip on a live
// lane is stale and never hides it. Pure - undefined accounts/posting yields [].
export function visiblePlatforms(accounts, posting) {
  if (!accounts) return [];
  const skipped = Array.isArray(posting?.skippedPlatforms) ? posting.skippedPlatforms : [];
  return PLATFORMS.filter((platform) => {
    const connected = platformConnected(platform, accounts);
    // A stale skip only counts while the lane is NOT connected (lib/setup.mjs); a
    // connected lane is simply connected, never hidden by a leftover skip flag.
    if (!connected && skipped.includes(setupIdOf(platform))) return false;
    if (!connected) return false;
    if (!platformEnabled(platform, posting)) return false;
    return true;
  });
}

// The Radar sources a scan can actually search right now: the evidence behind whether
// "Scan now" renders, and behind the per-source rows that say why a source is quiet.
//
// hackernews is ALWAYS scannable - it needs no credential (RADAR_SOURCE_SCOPE.hackernews
// is null; the engine queries Algolia unauthenticated). It used to be excluded here, back
// when an agent copy-paste block was the primary path and the engine scan was a demoted
// fallback that "must not show for every operator". That block is gone and pendpost's own
// scan is the only scan, so the premise died and the conclusion inverts: excluding a
// working keyless source would leave the zero-credential operator with no way to scan at
// all, which is the dead end the demotion was trying to avoid in the first place.
//
// The credentialed three keep two honest signals, no third: reddit/mastodon ride their
// Setup connection (the accountStatus every other surface reads); bluesky has no Setup
// card at all (creds are .env-only), so its only evidence is the persisted last-scan
// status - a source that returned ok ran with working credentials. `web` is agent-ingested
// and never searchable.
const KEYLESS_RADAR_SOURCES = ['hackernews'];
const ENGINE_RADAR_SOURCES = ['reddit', 'mastodon', 'bluesky'];
const SETUP_RADAR_SOURCES = ['reddit', 'mastodon'];
export function scannableRadarSources(accounts, sources) {
  const credentialed = ENGINE_RADAR_SOURCES.filter((src) => {
    if (SETUP_RADAR_SOURCES.includes(src) && platformConnected(src, accounts)) return true;
    return sources?.[src]?.ok === true;
  });
  return [...KEYLESS_RADAR_SOURCES, ...credentialed];
}

// The client mirror of lib/radar.mjs effectiveRadarSources (WP6): which sources this
// project's scans cover, for the glyph strips. Same rules - explicit flag wins, searchable
// lanes default ON, agent-found reply lanes default ON when connected (accounts evidence, or
// a persisted ok scan for .env-only bluesky). Driven by the SERVER's capability table
// (feed.capabilities) so the client never hardcodes one. `web` is never a scan target.
export function effectiveRadarSourcesClient(radar, capabilities, accounts, sourceStatus) {
  const flags = radar && radar.sources && typeof radar.sources === 'object' ? radar.sources : {};
  return Object.keys(capabilities || {}).filter((id) => {
    if (id === 'web') return false;
    const f = flags[id];
    const flag = f && typeof f === 'object' ? f.scan : undefined;
    if (flag === false) return false;
    if (flag === true) return true;
    if (capabilities[id]?.search === true) return true;
    return platformConnected(id, accounts) || sourceStatus?.[id]?.ok === true;
  });
}

// The connect state of ONE Radar source, for the per-source rows: 'keyless' (no credential
// exists to give it), 'scanning' (credentialed and searched), or 'needsConnecting'. Split
// out from scannableRadarSources because the rows must distinguish "nothing to connect" from
// "connected" - collapsing those two into one green state is how the panel used to imply it
// was searching Reddit when Reddit was never wired up.
export function radarSourceState(src, accounts, sources) {
  if (KEYLESS_RADAR_SOURCES.includes(src)) return 'keyless';
  return scannableRadarSources(accounts, sources).includes(src) ? 'scanning' : 'needsConnecting';
}

// The platform chips the filter bar offers. visiblePlatforms answers "which lanes
// may I post to" (connected + enabled), which is the WRONG question for a filter:
// a lane can hold real posts without being connected or even being in PLATFORMS.
// Radar's bluesky replies are exactly that - no accounts entry, absent from
// PLATFORMS - so they sat in the queue with no chip that could ever select them.
//
// So union what is connected with what is actually ON the loaded posts, mirroring
// the presentTypes idiom (App.jsx): a lane holding posts is filterable, today's
// bluesky and any future lane alike. `selected` keeps an ACTIVE pick visible even
// after its last post leaves the scope, so the chip filtering the view can always be
// clicked off. Known lanes keep PLATFORMS order; off-list lanes follow, sorted for
// a stable bar. The caller still drops any id with no PLATFORM_META (no icon/label).
export function presentPlatforms(accounts, posting, posts = [], selected = []) {
  const connected = visiblePlatforms(accounts, posting);
  const pool = new Set(connected);
  for (const post of posts || []) for (const p of post.platforms || []) pool.add(p);
  for (const p of selected || []) pool.add(p);
  const known = PLATFORMS.filter((p) => pool.has(p));
  const extra = [...pool].filter((p) => !PLATFORMS.includes(p)).sort();
  return [...known, ...extra];
}

// The platforms whose OWN scheduler fires a future post (Facebook
// scheduled_publish_time, YouTube publishAt, Mastodon scheduled_at, WordPress
// status 'future', Ghost scheduled + published_at), so it publishes on time even
// when the user's machine is off. Mirrors lib/plans.mjs NATIVE_SCHEDULING_PLATFORMS
// (the app bundle cannot import the core, so the set is restated here next to the
// existing PLATFORMS list). Every other lane needs pendpost running at the due time.
export const NATIVE_SCHEDULING_PLATFORMS = new Set(['facebook', 'youtube', 'mastodon', 'wordpress', 'ghost']);

// Presentational only: 'native' = the platform publishes it even with the computer
// off; 'local' = pendpost must be running. Used for the per-platform delivery hint
// on a post's platforms, which the post-level schedule badge cannot show on a MIXED
// post (FB-native + IG-local) because deriveState collapses to one post-level state.
export function deliveryMode(platform) {
  return NATIVE_SCHEDULING_PLATFORMS.has(platform) ? 'native' : 'local';
}

// The TRUE delivery mechanism once the cloud is accounted for: 'cloud' when the
// always-on runtime publishes this lane (the platform's setup id is in the cloud's
// covered set AND the cloud is on for this brand), else the base deliveryMode
// ('native' self-schedules, 'local' needs pendpost running). Reuses setupIdOf so
// facebook/instagram resolve to the 'meta' cloud lane - no second platform->lane map.
// 'cloud' and 'native' both mean "fires without the user"; only 'local' needs action.
export function effectiveDelivery(platform, { cloudOn = false, cloudLanes = [], type = null, localOnlyTypes = [] } = {}) {
  // H6: some post FORMATS the cloud cannot fire at all (a carousel, a nostr longform),
  // whatever the lane's capability says. The capability endpoint is lane-shaped and
  // structurally cannot answer a per-type question, so the list arrives as an option
  // (lib/capabilities.mjs LOCAL_ONLY_TYPES, carried on the capabilities shape).
  //
  // Checked BEFORE the cloud lane check, because the format outranks the lane: an album
  // on LinkedIn with the cloud on still needs this machine awake. NOT before the native
  // check below, though - a self-scheduling platform holds the post itself, so the Mac
  // being asleep is irrelevant there and claiming otherwise would be a false alarm.
  //
  // Both new options default to inert, so every existing call site is byte-identical.
  const base = deliveryMode(platform);
  if (base !== 'native' && type && localOnlyTypes.includes(type)) return 'local';
  if (cloudOn && cloudLanes.includes(setupIdOf(platform))) return 'cloud';
  return base;
}

// One filterable status per post. Approval states (draft/pending/rejected) take
// precedence over the schedule derivedState - "needs work" is what the owner
// filters on first. The scheduled-native / waiting-due / fired-assumed schedule
// states all collapse to one "scheduled" bucket for filtering.
export function postStatusKey(post) {
  if (post.approval === 'rejected') return 'rejected';
  if (post.approval === 'draft') return 'draft';
  if (post.approval === 'pending') return 'pending';
  if (post.derivedState === 'overdue') return 'overdue';
  if (post.derivedState === 'verify-failed') return 'overdue'; // read back not-live: needs attention
  if (post.derivedState === 'publish-failed') return 'overdue'; // the platform refused it: needs attention
  if (post.derivedState === 'posted' || post.derivedState === 'verified-live') return 'posted';
  if (post.derivedState === 'parked') return 'parked';
  return 'scheduled';
}

// LATE = the due time passed and the post still has not published. For a post on a
// CLOUD or NATIVE lane this holds whatever its approval state - a post awaiting a
// decision past its slot HAS missed it, and that is the at-risk fact worth alarming on.
// Two kinds are exempt while unapproved, upstream in deriveState (their due clock starts
// at approval): a radar reply, and a self-post / local-only post (reddit/tiktok/
// pinterest/gbp) that nothing but the owner can fire - see lib/plans.mjs awaitingApproval.
//
// ONE predicate, used by BOTH the alarm count (App.jsx overdueCount -> the red
// "Nicht veroeffentlicht" banner + the Ueberfaellig chip) AND the 'overdue' status
// filter (matchesFilters). That is the point: the banner and the list it sends you to
// are now the same set BY CONSTRUCTION, so the count can never sit above an empty list.
// Distinct from postStatusKey's 'overdue' BUCKET, which is the card's collapsed label
// and correctly yields to the approval axis - a late draft still reads "Entwurf" on its
// card, but it is still late, still counted, and now still reachable.
export function isLate(post) {
  if (!post) return false;
  return post.derivedState === 'overdue' || postStatusKey(post) === 'overdue';
}

// A post the scheduler would act on RIGHT NOW, mirroring runDue's gate
// (lib/scheduler.mjs lanesFor). Two cases, both requiring approval:
//   1. PUBLISH: derivedState 'overdue' (past due, a pending lane still owed -
//      already implies not posted/parked/future/native) with - for any non-text
//      type - a local render present.
//   2. RELEASE: a natively-scheduled YouTube video YouTube left PRIVATE past its
//      publishAt (read-back state 'private-overdue', surfaced as derivedState
//      'verify-failed'). Run-now flips it public (no re-upload); the video is
//      already on YouTube, so no local render is required.
// State is time-derived upstream (deriveState), so no `now` arg is needed. Single
// source of truth for both the planner's due count and the run-now dialog's list.
export function isDueNow(post) {
  if (!post) return false;
  if (post.approval !== 'approved') return false;
  // Stale approval: edited after it was blessed, so eligibleDuePosts refuses it
  // (lib/scheduler.mjs) until re-approval. Without this the run-now surface would
  // promise a fire the engine silently declines.
  if (post.editedSinceApproval) return false;
  // A refused post is still due - retrying by hand is the whole recovery, so run-now must
  // keep offering it rather than hiding the one control that resolves the state.
  if (post.derivedState === 'overdue' || post.derivedState === 'publish-failed') return post.type === 'text' || Boolean(post.media?.exists);
  if (isYouTubeReleaseDue(post)) return true;
  return false;
}

// The RELEASE subcase of isDueNow: a natively-scheduled YouTube video YouTube left
// private past its publishAt. Run-now flips it public rather than publishing. The
// dialog uses it to label the row "make public" instead of a generic publish.
export function isYouTubeReleaseDue(post) {
  return post?.derivedState === 'verify-failed'
    && post?.verify?.platforms?.youtube?.state === 'private-overdue';
}

// Status-filter chips, in owner-priority order, each with an IconBadge tone. The
// chip label is resolved by the consumer via t('status.<key>').
export const STATUS_FILTERS = [
  { key: 'draft', tone: 'neutral' },
  { key: 'pending', tone: 'warn' },
  { key: 'rejected', tone: 'err' },
  { key: 'scheduled', tone: 'info' },
  { key: 'posted', tone: 'ok' },
  { key: 'overdue', tone: 'err' },
  { key: 'parked', tone: 'neutral' },
];

// Shared multi-select filter predicate (3g). Empty array = no constraint (all).
// platformFilter matches if the post targets ANY selected platform; typeFilter
// matches the post's single type; statusFilter matches its collapsed status key.
export function matchesFilters(post, platformFilter = [], typeFilter = [], statusFilter = []) {
  const pOk = !platformFilter.length || (post.platforms || []).some((p) => platformFilter.includes(p));
  const tOk = !typeFilter.length || typeFilter.includes(post.type);
  // 'overdue' is the AT-RISK view, not just a pill bucket: it must CONTAIN every post
  // the alarm counts (isLate) - including one that is late while still awaiting a
  // decision, whose collapsed bucket is 'draft'/'pending'. Matching on the bucket alone
  // would structurally hide exactly the posts the banner is shouting about, which is how
  // "Nicht veroeffentlicht: 1" could sit above an empty list.
  const sOk = !statusFilter.length
    || statusFilter.includes(postStatusKey(post))
    || (statusFilter.includes('overdue') && isLate(post));
  return pOk && tOk && sOk;
}

// Actionable = still needs an approval decision, so it belongs in the "To review" queue
// and the sidebar pending badge. A decision settles a post either way: approved and
// rejected both leave the queue (the owner has decided). Two carve-outs keep it honest:
// an edited-since-approval post is approval:'approved' but its content diverged from what
// was blessed, so it needs a FRESH decision; a rejected post whose content is reworked is
// reverted to 'draft' by the engine (updatePost) and re-enters on its own. A posted post
// is never actionable. SINGLE SOURCE OF TRUTH - Freigaben (the queue + tab count) and App
// (the sidebar badge) both import this, so the badge and the list can never disagree.
export function isActionable(post) {
  return post.derivedState !== 'posted'
    && post.approval !== 'rejected'
    && (post.approval !== 'approved' || post.editedSinceApproval);
}

// ONE truthful next-actor state per card. The approval card used to stack three
// independent badges ("Geplant" + "Du postest selbst" + "Automatisch freigegeben")
// that could contradict each other on one post. This is a strict first-match
// PROJECTION over the existing inputs (derivedState, unconnectedLanes,
// isActionable's carve-outs) - no state machinery is re-derived - answering the
// single question the reviewer has: who acts next, and what is that act.
//
// Returns { key, actor, at? }:
//   done            system - posted/verified-live, nothing left to do.
//   publish-failed  you    - the platform refused it (renders as today's red pill).
//   overdue         you    - past due with pendpost still owing a lane (red pill).
//   handOff         you    - a target lane is unconnected: approval publishes
//                            nothing, YOU post it (beats every schedule claim).
//   reApprove       you    - approved but edited since: needs a fresh decision
//                            (beats the auto-approved provenance).
//   clientSignoff   client - awaiting the client's sign-off (the ReviewStatusChip
//                            already names who and how long; render nothing extra).
//   approve         you    - pending/draft: the queue's default state.
//   rejected        you    - decided against; rework re-enters as draft.
//   scheduled       system - approved with a slot: goes out at `at`.
//   awaitingSlot    system - approved, no slot yet.
export function nextActorOf(post, setup) {
  if (post.derivedState === 'posted' || post.derivedState === 'verified-live') {
    return { key: 'done', actor: 'system' };
  }
  // V6 clamp, folded into the derivation: a post awaiting client sign-off never
  // reads overdue-red (the engine keeps reviewPending out of 'overdue'; this
  // guards the GUI the same way the old pillState clamp did).
  if (!post.reviewPending && (post.derivedState === 'publish-failed' || post.derivedState === 'overdue')) {
    return { key: post.derivedState, actor: 'you' };
  }
  if (unconnectedLanes(post, setup).length) return { key: 'handOff', actor: 'you' };
  if (post.approval === 'approved' && post.editedSinceApproval) return { key: 'reApprove', actor: 'you' };
  if (post.reviewPending) return { key: 'clientSignoff', actor: 'client' };
  if (post.approval === 'rejected') return { key: 'rejected', actor: 'you' };
  if (post.approval === 'approved') {
    return post.scheduledAt
      ? { key: 'scheduled', actor: 'system', at: post.scheduledAt }
      : { key: 'awaitingSlot', actor: 'system' };
  }
  // pending / draft / absent: the decision is the next act.
  return { key: 'approve', actor: 'you' };
}

// The best PUBLIC link for one lane of a post - the "posted = linked" contract
// (owner decision 3), client-side only: every input already rides the plans DTO.
// Precedence, most authoritative first:
//   1. verify read-back permalink (the platform said so),
//   2. the id-derived post.permalinks[lane] (the engine minted the id),
//   3. a manual mark's captured URL (manualCompletions[lane].externalUrl -
//      the link-capture flows write exactly this),
//   4. post.externalUrl for Instagram (no derivable public slug) and for any
//      radar reply (whole-post manual marks store the live reply URL there).
// null when nothing is provable - callers render NOTHING then, never a dead
// control and never a fabricated link (the derivePermalinks discipline).
export function resolveLivePermalink(post, platform) {
  const v = post.verify?.platforms?.[platform];
  if (v?.permalink) return v.permalink;
  if (post.permalinks?.[platform]) return post.permalinks[platform];
  const manual = post.manualCompletions?.[platform]?.externalUrl;
  if (manual) return manual;
  if ((platform === 'instagram' || post.radarReplyTo) && post.externalUrl) return post.externalUrl;
  return null;
}

// Suggest the next free post id for a type: a short type prefix + the lowest
// unused integer (r1, st1, v1, yts1, ...). Editable in the composer.
const TYPE_PREFIX = { reel: 'r', story: 'st', video: 'v', text: 'txt', poll: 'pl', carousel: 'car', 'youtube-short': 'yts', 'youtube-longform': 'ytv', image: 'img', 'nostr-longform': 'na' };
export function suggestPostId(type, posts = []) {
  const prefix = TYPE_PREFIX[type] || 'p';
  const used = new Set((posts || []).map((p) => p.id));
  for (let n = 1; n < 1000; n += 1) {
    if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
  }
  return `${prefix}${used.size + 1}`;
}

// X reply-chain (xReplyTo) context for a post, resolved WITHIN its own campaign:
// the sibling post it threads under (parent) and the posts that thread under it
// (replies). Same-campaign only - the engine resolves the reference within one
// plan and fail-closes when the parent is gone (scripts/x-social.mjs), so a
// dangling reference means "held forever". One rule, reused by PostDetail, the
// planner list and the approvals queue so the three never drift.
export function deriveThread(post, posts = []) {
  const parent = post.xReplyTo
    ? (posts || []).find((p) => p.campaign === post.campaign && p.id === post.xReplyTo) || null
    : null;
  const replies = (posts || []).filter((p) => p.campaign === post.campaign && p.xReplyTo === post.id);
  return { parent, replies };
}

// The WHOLE thread `post` belongs to, root-first: walk xReplyTo up to the opener,
// then collect every transitive reply beneath it. Handles the linked-list chaining
// the thread composer produces (each reply threads under the previous tweet) as
// well as a star. Same-campaign only; cycle-safe. Returns [post] when standalone.
export function collectThread(post, posts = []) {
  const inCampaign = (posts || []).filter((p) => p.campaign === post.campaign);
  const byId = (id) => inCampaign.find((p) => p.id === id) || null;
  // Walk up to the root opener.
  let root = post;
  const climbed = new Set([root.id]);
  while (root.xReplyTo) {
    const parent = byId(root.xReplyTo);
    if (!parent || climbed.has(parent.id)) break;
    climbed.add(parent.id);
    root = parent;
  }
  // Collect the root + every transitive descendant (breadth-first, cycle-safe).
  const out = [];
  const seen = new Set();
  const queue = [root];
  while (queue.length) {
    const cur = queue.shift();
    if (seen.has(cur.id)) continue;
    seen.add(cur.id);
    out.push(cur);
    for (const p of inCampaign) {
      if (p.xReplyTo === cur.id && !seen.has(p.id)) queue.push(p);
    }
  }
  return out;
}

// Outcome of a publish_due_run for ONE post, from the server's `ran` rows (the
// per-lane truth: ok only when a result row actually succeeded). Callers
// localize: `held` = the cloud owns the lane inside its handoff grace, `reason`
// = the first real failure's message. rows.length === 0 means nothing was
// dispatched at all (not due / not approved / already posted).
export function publishRunOutcome(res, postId) {
  const rows = (res?.ran || []).filter((r) => r.postId === postId);
  const fired = rows.some((r) => r.ok);
  const held = !fired && rows.some((r) => r.errorCode === 'cloud_held');
  // `halted` = the lane is paused by an account-level circuit breaker (X 402 credits,
  // lib/scheduler.mjs) and was dropped before dispatch. Mirrors `held`: the click did
  // not fail, it just cannot fire until the operator resumes the lane. Both marker codes
  // are excluded from `reason` so a genuine per-lane failure still surfaces its message.
  const halted = !fired && rows.some((r) => r.errorCode === 'lane_halted');
  const fail = rows.find((r) => !r.ok && r.errorCode !== 'cloud_held' && r.errorCode !== 'lane_halted');
  return { rows, fired, held, halted, reason: fail ? (fail.errorMessage || fail.errorCode) : null };
}
