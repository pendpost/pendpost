import { AlertTriangle, BadgeCheck, CalendarClock, CheckCircle, Clock, OctagonX, PauseCircle, Pencil, Send } from 'lucide-react';
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

// The hour12 override for a resolved display locale: de-CH (any non-en-US) is always
// 24-hour; en-US follows the preference (auto = no override, i.e. its 12-hour default).
function hour12For(loc) {
  if (loc !== 'en-US') return { hour12: false };
  if (_timeFormat === '24h') return { hour12: false };
  if (_timeFormat === '12h') return { hour12: true };
  return {};
}

export function fmtTime(iso) {
  const loc = dateLocale();
  return new Intl.DateTimeFormat(loc, { timeZone: TZ, hour: '2-digit', minute: '2-digit', ...hour12For(loc) }).format(new Date(iso));
}

export function fmtFull(iso) {
  const loc = dateLocale();
  return new Intl.DateTimeFormat(loc, {
    timeZone: TZ,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...hour12For(loc),
  }).format(new Date(iso));
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

// Structural only: `cls` = pill tint, `dot` = month-view status dot color (UX-05),
// `Icon` = a decorative (aria-hidden) lucide glyph the pills lead with, matching the
// TimeChip's icon+tone treatment (DESIGN.md section 3). The pills still carry their
// text label, so the icon is coherence, never the sole signal (WCAG 1.4.1).
// The user-facing labels moved to the locale pack - StatusPill resolves them via
// t('state.<key>') (long) / t('state.short.<key>') (the single-word week-card form,
// UX-02). The map key IS the i18n key suffix, so this map stays the single source of
// which states exist while carrying no prose.
export const STATE_META = {
  posted: { cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30', dot: 'bg-emerald-500', Icon: CheckCircle },
  'scheduled-native': { cls: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 ring-cyan-500/30', dot: 'bg-cyan-500', Icon: CalendarClock },
  'fired-assumed': { cls: 'bg-teal-500/15 text-teal-700 dark:text-teal-300 ring-teal-500/30', dot: 'bg-teal-500', Icon: Send },
  // Verify read-back outcomes (lib/verify.mjs): confirmed live on every targeted
  // platform, or read back not-live/missing. They refine 'fired-assumed'.
  'verified-live': { cls: 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-300 ring-emerald-600/40', dot: 'bg-emerald-600', Icon: BadgeCheck },
  'verify-failed': { cls: 'bg-orange-500/15 text-orange-700 dark:text-orange-300 ring-orange-500/30', dot: 'bg-orange-500', Icon: AlertTriangle },
  'waiting-due': { cls: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-sky-500/30', dot: 'bg-sky-500', Icon: Clock },
  overdue: { cls: 'bg-red-500/15 text-red-700 dark:text-red-300 ring-red-500/30', dot: 'bg-red-500', Icon: OctagonX },
  parked: { cls: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-300 ring-zinc-500/30', dot: 'bg-zinc-400', Icon: PauseCircle },
};

// Structural only; ApprovalPill resolves the label via t('approval.<key>'). `Icon`
// is decorative (aria-hidden), mirroring the TimeChip tones (approved=CheckCircle,
// pending=Clock, rejected=OctagonX) for cross-surface coherence.
export const APPROVAL_META = {
  draft: { cls: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-300 ring-zinc-500/30', Icon: Pencil },
  pending: { cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/30', Icon: Clock },
  approved: { cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30', Icon: CheckCircle },
  rejected: { cls: 'bg-red-500/15 text-red-700 dark:text-red-300 ring-red-500/30', Icon: OctagonX },
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
  draft: { cls: 'bg-slate-500/15 text-slate-600 dark:text-slate-300 ring-slate-500/30', bar: 'bg-slate-400', strip: 'bg-slate-500/10', dot: 'bg-slate-400', Icon: Pencil },
  pending: { cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/30', bar: 'bg-amber-500', strip: 'bg-amber-500/10', dot: 'bg-amber-500', Icon: Clock },
  rejected: { cls: 'bg-red-500/15 text-red-700 dark:text-red-300 ring-red-500/30', bar: 'bg-red-500', strip: 'bg-red-500/10', dot: 'bg-red-500', Icon: OctagonX },
  overdue: { cls: 'bg-red-500/15 text-red-700 dark:text-red-300 ring-red-500/30', bar: 'bg-red-500', strip: 'bg-red-500/10', dot: 'bg-red-500', Icon: OctagonX },
  // verify-failed filters under the 'overdue' "needs attention" bucket (postStatusKey)
  // but keeps its OWN visible treatment (postDisplayStatusKey): a post that fired and
  // read back not-live is not "pendpost wasn't running", so the planner card must not
  // mislabel it the red "Overdue". Mirrors STATE_META's verify-failed orange so the
  // calendar pill/accent/dot match the StatusPill on the detail + run-now surfaces.
  'verify-failed': { cls: 'bg-orange-500/15 text-orange-700 dark:text-orange-300 ring-orange-500/30', bar: 'bg-orange-500', strip: 'bg-orange-500/10', dot: 'bg-orange-500', Icon: AlertTriangle },
  scheduled: { cls: 'bg-zinc-500/10 text-zinc-500 dark:text-zinc-400 ring-zinc-500/20', bar: '', strip: '', dot: 'bg-sky-500', Icon: CalendarClock },
  posted: { cls: 'bg-zinc-500/10 text-emerald-700/80 dark:text-emerald-400/70 ring-zinc-500/20', bar: '', strip: '', dot: 'bg-emerald-500', Icon: CheckCircle },
  parked: { cls: 'bg-zinc-500/10 text-zinc-500 dark:text-zinc-400 ring-zinc-500/20', bar: '', strip: '', dot: 'bg-zinc-400', Icon: PauseCircle },
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
  return post.derivedState === 'verify-failed' ? 'verify-failed' : postStatusKey(post);
}

// Month-cell status dot, derived from the SAME visible bucket as the card pill
// (STATUS_PILL_META) so the month view and the week/list cards never disagree on a
// post's status - the previous overdue-first precedence painted a draft-that-is-also
// -past-due red on the dot while the card read it as a quiet "draft".
export function postDot(post) {
  return STATUS_PILL_META[postDisplayStatusKey(post)]?.dot || 'bg-zinc-400';
}

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

// Mandate F: the shared "what belongs in the Active campaigns picker" rule. An
// archived campaign (active !== true) must never appear in the top picker - it
// stays reachable only through the "All campaigns" filter mode. One source of
// truth so the picker and the campaign management table agree.
export function activeCampaigns(campaigns) {
  return (campaigns || []).filter((c) => c.active === true);
}

export const TYPE_LABEL = {
  reel: 'Reel', story: 'Story', video: 'Video', text: 'Text',
  'youtube-short': 'YouTube Short', 'youtube-longform': 'YouTube Video', image: 'Image',
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

// The cover box aspect for a PLANNER post: drive it off the media file's real
// measured shape when the asset scan has probed it (post.media.resolution), so a
// LinkedIn 4:5 video reads 4:5 and a 9:16 one reads 9:16 - instead of forcing every
// `video` type into one 4:5 box. Falls back to the type-keyed coverAspect when the
// probe is unknown ('other', not yet scanned, or a media-less text post).
export function mediaAspect(post) {
  return RES_ASPECT[post?.media?.resolution] || coverAspect(post?.type);
}
export const PLATFORMS = ['facebook', 'instagram', 'linkedin', 'youtube', 'x'];

// The platforms whose OWN scheduler fires a future post (Facebook
// scheduled_publish_time, YouTube publishAt), so it publishes on time even when
// the user's machine is off. Mirrors lib/plans.mjs NATIVE_SCHEDULING_PLATFORMS
// (the app bundle cannot import the core, so the set is restated here next to the
// existing PLATFORMS list). Every other lane needs pendpost running at the due time.
export const NATIVE_SCHEDULING_PLATFORMS = new Set(['facebook', 'youtube']);

// Presentational only: 'native' = the platform publishes it even with the computer
// off; 'local' = pendpost must be running. Used for the per-platform delivery hint
// on a post's platforms, which the post-level schedule badge cannot show on a MIXED
// post (FB-native + IG-local) because deriveState collapses to one post-level state.
export function deliveryMode(platform) {
  return NATIVE_SCHEDULING_PLATFORMS.has(platform) ? 'native' : 'local';
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
  if (post.derivedState === 'posted' || post.derivedState === 'verified-live') return 'posted';
  if (post.derivedState === 'parked') return 'parked';
  return 'scheduled';
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
  if (post.derivedState === 'overdue') return post.type === 'text' || Boolean(post.media?.exists);
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
  const sOk = !statusFilter.length || statusFilter.includes(postStatusKey(post));
  return pOk && tOk && sOk;
}

// Suggest the next free post id for a type: a short type prefix + the lowest
// unused integer (r1, st1, v1, yts1, ...). Editable in the composer.
const TYPE_PREFIX = { reel: 'r', story: 'st', video: 'v', text: 'txt', 'youtube-short': 'yts', 'youtube-longform': 'ytv', image: 'img' };
export function suggestPostId(type, posts = []) {
  const prefix = TYPE_PREFIX[type] || 'p';
  const used = new Set((posts || []).map((p) => p.id));
  for (let n = 1; n < 1000; n += 1) {
    if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
  }
  return `${prefix}${used.size + 1}`;
}
