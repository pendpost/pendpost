// radar-verdict.mjs - the structured Radar verdict and the action the ENGINE derives from it
// (Radar 2.0 step 2, spec 53).
//
// Before step 2 the judge answered { keep, score, reason } and the suggested action came from the
// score alone (suggestAction: 40+ = reply). Live, that let a coach advertising her own sessions
// score 42-48 and land in the inbox as "reply": the score said "on topic", nothing said "seller".
// Step 2 asks the judge (and the scanning agent) for four structured facts about the post and
// derives eligibility from those facts, never from the free-form score:
//
//   intent      ask_reco | competitor_pain | comparing | howto_stuck | building_public |
//               evergreen_cited | none
//   authorRole  seeker | vendor | competitor | peer | bot
//   replyable   true when a reply from the brand fits this place (open thread, not someone
//               else's launch thread, not an announcement)
//   timing      fresh | evergreen
//
// Rules (fail closed):
//   - vendor, competitor, bot          -> dropped, with a reason code
//   - seeker + replyable + intent!=none -> actionable (reply, or comparison-page by the tags)
//   - anything else that was kept       -> watch at most
//   - a missing or unknown value is NOT a pass: an unknown authorRole is not "seeker", a missing
//     replyable is not "true". An unclassified signal is never actionable.
//
// Pure and import-free, so lib/radar.mjs (re-score), lib/radar-judge.mjs (coercer) and
// lib/writes.mjs (scan, ingest, list) share one rule without an import cycle.

export const RADAR_INTENTS = Object.freeze(['ask_reco', 'competitor_pain', 'comparing', 'howto_stuck', 'building_public', 'evergreen_cited', 'none']);
export const RADAR_AUTHOR_ROLES = Object.freeze(['seeker', 'vendor', 'competitor', 'peer', 'bot']);
export const RADAR_TIMINGS = Object.freeze(['fresh', 'evergreen']);
// Roles that never reach the feed: the post is somebody selling, a rival, or a machine.
export const RADAR_DROP_ROLES = Object.freeze(['vendor', 'competitor', 'bot']);
// The reason code a role drop is filed under (state.radar.seen[].reason, judge.byReason).
export const RADAR_ROLE_DROP_CODE = Object.freeze({ vendor: 'vendor-or-bot', bot: 'vendor-or-bot', competitor: 'competitor' });

const token = (x) => String(x == null ? '' : x).trim().toLowerCase().replace(/[\s-]+/g, '_');

// One raw value -> a member of `allowed`, or null. Tolerates case, spaces and dashes
// ("Ask-Reco" -> ask_reco); anything else is unknown.
function member(raw, allowed) {
  const t = token(raw);
  return allowed.includes(t) ? t : null;
}

// A boolean the model may have sent as a string. Anything else is unknown (null), never false-y
// true: "replyable" is a gate, so only an explicit yes opens it.
function bool(raw) {
  if (raw === true || raw === false) return raw;
  const t = token(raw);
  if (t === 'true' || t === 'yes') return true;
  if (t === 'false' || t === 'no') return false;
  return null;
}

/**
 * Coerce the four structured fields of a raw verdict (judge or agent). Each comes back as a known
 * value or null. Never throws.
 * @returns {{ intent:string|null, authorRole:string|null, replyable:boolean|null, timing:string|null }}
 */
export function coerceClassification(v) {
  const o = v && typeof v === 'object' ? v : {};
  return {
    intent: member(o.intent, RADAR_INTENTS),
    authorRole: member(o.authorRole ?? o.author_role ?? o.role, RADAR_AUTHOR_ROLES),
    replyable: bool(o.replyable),
    timing: member(o.timing, RADAR_TIMINGS),
  };
}

// A signal is classified when the three gating facts are known. timing is ranking material only.
export function isClassified(s) {
  return Boolean(s) && RADAR_INTENTS.includes(s.intent) && RADAR_AUTHOR_ROLES.includes(s.authorRole) && typeof s.replyable === 'boolean';
}

/**
 * The engine's eligibility verdict for one signal.
 * @returns {{ tier:'act'|'watch'|'drop', reasonCode:string|null }}
 *   act   = may sit in the inbox as a reply target
 *   watch = kept, visible under "more", never in the inbox
 *   drop  = never in the feed (vendor, competitor, bot)
 */
export function radarEligibility(s) {
  if (!s || typeof s !== 'object') return { tier: 'watch', reasonCode: 'unclassified' };
  if (RADAR_DROP_ROLES.includes(s.authorRole)) return { tier: 'drop', reasonCode: RADAR_ROLE_DROP_CODE[s.authorRole] };
  if (!isClassified(s)) return { tier: 'watch', reasonCode: 'unclassified' };
  if (s.authorRole !== 'seeker') return { tier: 'watch', reasonCode: 'not-a-seeker' };
  if (s.replyable !== true) return { tier: 'watch', reasonCode: 'not-replyable' };
  if (s.intent === 'none') return { tier: 'watch', reasonCode: 'no-intent' };
  return { tier: 'act', reasonCode: null };
}

/**
 * The suggested action for a classified signal. `scoreAction` is what the score-based rule
 * (lib/radar.mjs suggestAction) would say; it only decides BETWEEN the two actionable kinds
 * (reply vs comparison-page), never whether the signal is actionable.
 */
export function classifiedAction(s, scoreAction) {
  const { tier } = radarEligibility(s);
  if (tier === 'drop') return 'ignore';
  if (tier === 'watch') return 'watch';
  return scoreAction === 'comparison-page' ? 'comparison-page' : 'reply';
}

/**
 * Stamp classification facts on a signal and re-derive its action. Returns a fresh object.
 * `by` says who classified it ('judge' | 'agent'). `scoreAction` as in classifiedAction.
 */
export function withClassification(signal, fields, { by = 'judge', scoreAction = null } = {}) {
  const f = coerceClassification(fields);
  const next = { ...signal, intent: f.intent, authorRole: f.authorRole, replyable: f.replyable, ...(f.timing ? { timing: f.timing } : {}) };
  if (!f.timing) delete next.timing;
  delete next.unclassified;
  next.classifiedBy = by;
  next.suggestedAction = classifiedAction(next, scoreAction != null ? scoreAction : signal.suggestedAction);
  return next;
}

// ---- the inbox: top N actionable signals (posting.radar.dailyTarget) ----------------------------

export const RADAR_DAILY_TARGET_DEFAULT = 5;
export const RADAR_DAILY_TARGET_MAX = 50;

// How much each intent is worth to the brand. A direct "what should I use" and a person unhappy
// with a rival are the asks a reply converts best; a builder posting progress is the weakest.
export const RADAR_INTENT_WEIGHT = Object.freeze({
  ask_reco: 1, competitor_pain: 1, comparing: 0.9, howto_stuck: 0.8, evergreen_cited: 0.7, building_public: 0.5, none: 0,
});

const HOUR_MS = 3600 * 1000;

// Fresh beats old: full weight inside 48h, then a week, then a floor. An evergreen thread keeps a
// fixed weight whatever its age (an AI-cited thread, `evergreen: true`, counts as one even when the
// judge read its timing differently); an undated post sits in the middle.
export function freshnessFactor(s, now = Date.now()) {
  if (s && (s.timing === 'evergreen' || s.evergreen === true)) return 0.7;
  const t = Date.parse(s && s.ts);
  if (Number.isNaN(t)) return 0.5;
  const ageH = Math.max(0, (now - t) / HOUR_MS);
  if (ageH <= 48) return 1;
  if (ageH <= 24 * 7) return 0.6;
  return 0.3;
}

// Fewer existing replies = a reply is more likely to be read. Unknown counts are neutral.
export function repliesFactor(s) {
  const n = Number(s && s.replyCount);
  if (!Number.isFinite(n) || n < 0) return 1;
  if (n === 0) return 1.1;
  if (n <= 5) return 1;
  if (n <= 20) return 0.8;
  return 0.6;
}

/** The inbox rank of one signal: intent weight x freshness x fewer replies x boosts x score. */
// Radar 2.0 step 3: `watchedAuthor` (the author is on posting.radar.watchlist) is a x1.5 boost of
// its own, so a watched person's ask outranks a stranger's equal one.
export const RADAR_WATCHED_AUTHOR_BOOST = 1.5;
export function inboxRank(s, now = Date.now(), { watchedAuthor = false } = {}) {
  const w = RADAR_INTENT_WEIGHT[s && s.intent] ?? 0;
  const score = Math.max(0, Math.min(100, Number(s && s.intentScore) || 0));
  const boost = (s && s.watched === true ? 1.5 : 1) * (s && s.authorReplied ? 1.5 : 1) * (watchedAuthor === true ? RADAR_WATCHED_AUTHOR_BOOST : 1);
  return w * freshnessFactor(s, now) * repliesFactor(s) * boost * (0.5 + score / 200);
}

// The owner's configured N, clamped; anything unusable is the default.
export function dailyTargetOf(radar) {
  const n = Number(radar && radar.dailyTarget);
  return Number.isInteger(n) && n >= 1 && n <= RADAR_DAILY_TARGET_MAX ? n : RADAR_DAILY_TARGET_DEFAULT;
}

/**
 * Pick the inbox: the top `target` actionable, still-open signals by inboxRank. Never pads: fewer
 * qualifying signals give a shorter inbox. `isOpen(s)` says whether a signal still needs a move
 * (default: no posted reply and no hand-posted copy).
 * @returns {{ keys:Set<string>, ranked:object[], target:number, actionable:number }}
 */
export function selectInbox(items, { target = RADAR_DAILY_TARGET_DEFAULT, now = Date.now(), keyOf, isOpen, isWatchedAuthor } = {}) {
  const watchedAuthor = typeof isWatchedAuthor === 'function' ? isWatchedAuthor : () => false;
  const key = typeof keyOf === 'function' ? keyOf : (s) => `${s && s.source} ${s && s.externalId}`;
  const open = typeof isOpen === 'function' ? isOpen : (s) => !(s && (s.replied || s.copyPosted));
  const actionable = (Array.isArray(items) ? items : []).filter((s) => s && open(s) && radarEligibility(s).tier === 'act');
  const ranked = actionable
    .map((s) => ({ s, r: inboxRank(s, now, { watchedAuthor: watchedAuthor(s) === true }) }))
    .sort((a, b) => (b.r - a.r) || (Number(b.s.intentScore) - Number(a.s.intentScore)))
    .slice(0, Math.max(0, target))
    .map((x) => x.s);
  return { keys: new Set(ranked.map(key)), ranked, target, actionable: actionable.length };
}
