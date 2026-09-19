// lib/engage-digest.mjs - the "Respond for me" block in the daily digest (spec 50 §S8, §7.7).
//
// PURE, and deliberately so. It takes the already-loaded state.engage subtree, the engage policy,
// a translator and a few facts the caller already holds, and returns lines. No state read, no
// config read, no clock of its own - which is what makes the §11 acceptance case
// ("every number in the block equals a counter or a spec 44 evidence count; no follower field
// exists") a thing a test can actually check rather than trust.
//
// WHERE THE NUMBERS COME FROM, and nowhere else:
//   Today / Last 7 days   state.engage.counters, keyed `${lane} ${kind} ${YYYY-MM-DD}` in the
//                         CLIENT's timezone. Counters move on `done` only (lib/engage.mjs), so
//                         every figure here is an action that actually happened.
//   Needs you             state.engage.asks with status 'open'.
//   Cooling down          state.engage.lanes[lane].pausedUntil in the future.
//   answered back         the spec 44 author-reply count, computed by the caller off the reply
//                         posts' radarReplyState (the single source of truth) and passed in.
//
// AND WHAT IS DELIBERATELY ABSENT: follower counts, reach, impressions, "engagement rate". The
// owner's decision (spec 50 §0/§6) is that this feature reports what it DID, never how big it
// made anything look - a vanity number in a digest is how an autonomy feature starts optimising
// for the wrong thing. There is no code path here that could produce one.
import { dateKeyFor } from './engage-pacer.mjs';

const DAY = 24 * 3600 * 1000;

// The kinds the "Today" line reports, in the order §S8 prints them. `upvote` folds into `like`:
// they are two names for one act (§7.2 shares the capability cell), and two separate numbers for
// the same thing would read as two different things happening.
const REPORTED_KINDS = Object.freeze(['reply', 'like', 'follow', 'repost', 'dm']);
const FOLD = Object.freeze({ upvote: 'like' });

// Sum the counters for one kind across every lane, over the given date keys.
function tally(counters, kind, dateKeys) {
  let n = 0;
  for (const [key, value] of Object.entries(counters || {})) {
    // `${lane} ${kind} ${YYYY-MM-DD}` - split from the RIGHT so a lane name can never be
    // confused with the kind, and a future lane with a space in it cannot break the parse.
    const parts = String(key).split(' ');
    if (parts.length < 3) continue;
    const day = parts[parts.length - 1];
    const rawKind = parts[parts.length - 2];
    const folded = FOLD[rawKind] || rawKind;
    if (folded !== kind || !dateKeys.includes(day)) continue;
    const v = Number(value);
    if (Number.isFinite(v)) n += v;
  }
  return n;
}

// The last `days` client-local date keys, today first.
function recentDateKeys(now, tz, days) {
  const out = [];
  for (let i = 0; i < days; i += 1) out.push(dateKeyFor(now - (i * DAY), tz));
  return out;
}

// The §S8 block, or [] when there is nothing honest to say. Returns markdown lines the digest
// pushes verbatim, exactly like radarDigestLines.
//
// `opts.telegramChatId` drives row 9e: the digest is the ONE place the owner reliably reads, so
// a missing push channel is named there rather than left as a silent gap. `opts.clientName` is
// the brand the block is about (the digest is per client, and a multi-brand operator reading
// three digests needs to know which one this is).
export function engageDigestLines(engage, policy, t, opts = {}) {
  const mode = (policy && policy.mode) || 'off';
  // "only when mode is not off" (§S8). An off client's digest is byte-unchanged.
  if (mode === 'off') return [];

  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const tz = (typeof opts.tz === 'string' && opts.tz) || 'UTC';
  const counters = (engage && engage.counters) || {};
  const todayKeys = [dateKeyFor(now, tz)];
  const weekKeys = recentDateKeys(now, tz, 7);

  const lines = [];
  const paused = policy && policy.paused === true;
  const modeLabel = t(paused ? 'digest.engage.mode.paused' : `digest.engage.mode.${mode}`);
  lines.push(t('digest.engage.header', { client: String(opts.clientName || '').trim() || t('digest.engage.thisClient'), mode: modeLabel }));

  // ---- Today ------------------------------------------------------------------------------
  const todayParts = REPORTED_KINDS.map((kind) => `${t(`digest.engage.kind.${kind}`)} ${tally(counters, kind, todayKeys)}`);
  lines.push(t('digest.engage.today', { parts: todayParts.join(' · ') }));

  // ---- Needs you --------------------------------------------------------------------------
  const asks = Array.isArray(engage && engage.asks) ? engage.asks.filter((a) => a && a.status === 'open') : [];
  if (!asks.length) {
    lines.push(t('digest.engage.needsYou.none'));
  } else {
    // A short parenthetical for the first few, so the line is actionable rather than a bare
    // count. Every field is optional on an Ask in this phase (P5 owns the shape), so each one is
    // read defensively and simply omitted when absent - never rendered as "undefined".
    const named = asks.slice(0, 3).map((a) => {
      const what = String((a && (a.reasonLine || a.question || a.kind)) || '').trim();
      const who = String((a && a.author) || '').trim();
      const bits = [what, who ? (who.startsWith('@') ? who : `@${who}`) : ''].filter(Boolean);
      return bits.join(', ');
    }).filter(Boolean);
    lines.push(t('digest.engage.needsYou', { n: asks.length, detail: named.length ? ` (${named.join('; ')})` : '' }));
  }

  // ---- Cooling down -----------------------------------------------------------------------
  const cooling = [];
  for (const [lane, rt] of Object.entries((engage && engage.lanes) || {})) {
    const until = Date.parse((rt && rt.pausedUntil) || '') || 0;
    if (until <= now) continue;
    const reason = (rt && rt.pauseReason) || null;
    cooling.push(reason ? `${lane} (${t(`digest.engage.reason.${reason}`)})` : lane);
  }
  lines.push(cooling.length ? t('digest.engage.cooling', { lanes: cooling.join(', ') }) : t('digest.engage.cooling.none'));

  // ---- Last 7 days ------------------------------------------------------------------------
  // The payoff line, and the only one that pairs two sources: replies WE posted (a counter) and
  // replies that got an answer back (spec 44 evidence, counted by the caller). Both are facts on
  // disk; neither is a rate, a projection or a reach figure.
  const replies7 = tally(counters, 'reply', weekKeys);
  const answered = Number(opts.authorRepliedCount);
  lines.push(t('digest.engage.week', { replies: replies7, answered: Number.isFinite(answered) ? answered : 0 }));

  // ---- row 9e: no push channel ------------------------------------------------------------
  // An ask nobody hears about is the failure mode this line exists to prevent. Only shown when
  // there is actually something to miss: a Live client with no Telegram chat id stored.
  if (mode === 'live' && !String(opts.telegramChatId || '').trim()) {
    lines.push(t('digest.engage.noPush'));
  }

  lines.push('');
  return lines;
}
