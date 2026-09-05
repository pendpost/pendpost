// publish-hold.mjs - the LOCAL counterpart of the cloud re-fire cap
// (lib/cloud-client.mjs MAX_REFIRE_ATTEMPTS). The 2026-08 incident: three IG
// image posts whose mirror URL 404'd failed with Meta 9004 on EVERY 60s
// scheduler tick for three days - 7,800 attempts, a 3.1 MB plan file, and no
// terminal state an operator could see. The cloud path caps re-fires at 3 and
// stamps the failure terminal; the local engine had nothing. This module is
// that cap, shared by the live engines' appendAttempt and the mock driver
// (mock mode bypasses the engine's command dispatch entirely, so the logic
// must live lib-side - the lib/public-media.mjs precedent).
//
// Semantics mirror the cloud cap deliberately (cloud-client.mjs:1533):
// GENERIC, no per-platform error taxonomy - a permanent refusal is
// indistinguishable from a transient one until retries stop helping. After
// MAX_PUBLISH_ATTEMPTS trailing failures on the same platform+action the post
// gets a durable `publishHold` stamp ({ at, lane, code, message } - the
// state.cloudFailures entry shape). The scheduler's lanesOwed and the engines'
// publish-due loops skip a held post entirely (the radarReplyState
// 'target_gone' precedent), so it surfaces as a terminal 'publish-failed' the
// operator acts on instead of hammering the platform. The hold clears on a
// successful attempt, and operator-side on reschedule/edit (lib/writes.mjs) -
// rescheduling, even to the same time, is the "retry now" verb.
import { MEDIA_URL_DEAD_MARK } from './public-media.mjs';

export const MAX_PUBLISH_ATTEMPTS = 3;

// Transient (retry-with-backoff) window. A GENUINE refusal parks fast at
// MAX_PUBLISH_ATTEMPTS; a TRANSIENT failure (see isTransientFailure) instead
// rides out a bad spell with backoff for up to this long before it, too, parks.
// 2026-08-16 incident: Instagram's rupload endpoint intermittently returned
// HTTP 400 ProcessingFailedError with debug_info.retriable=FALSE on a perfectly
// valid reel - it failed all 4 of the scheduler's attempts inside a ~3h Meta bad
// spell, then published UNCHANGED on the next try (non-publishing probes of the
// identical bytes measured a fluctuating pass/fail rate). The generic 3-strike
// cap permanently parked a healthy post. So: treat that error class (and plain
// network/offline failures) as transient and ride it out instead of parking.
export const TRANSIENT_RETRY_WINDOW_MS = 3 * 60 * 60 * 1000; // ~3h

// Spacing between transient retries (minutes); the last value repeats until the
// window closes. Paces the 60s scheduler tick so a bad spell is ridden out in
// ~10-12 attempts, never hammered every tick (the 2026-08 storm lesson).
const TRANSIENT_BACKOFF_MIN = [1, 2, 5, 10, 20, 30];

export function transientBackoffMs(nAttempt) {
  const i = Math.min(Math.max(1, nAttempt), TRANSIENT_BACKOFF_MIN.length) - 1;
  return TRANSIENT_BACKOFF_MIN[i] * 60 * 1000;
}

// Should this failed attempt be RETRIED (backoff, bounded by the window) instead
// of counting toward the fast permanent-park cap? Two classes, keyed off the
// attempt row the engines already record (no caller change, and the mock driver
// gets the same treatment through the same fields):
//  - network / offline: the platform was unreachable, not refusing.
//  - Instagram rupload ProcessingFailedError: Meta labels it retriable:false but
//    it is empirically intermittent (see the window note above), so its
//    permanence flag is not trustworthy.
// A 368 action-block and every other refusal are NOT transient (park fast).
export function isTransientFailure(entry) {
  if (!entry || entry.ok !== false) return false;
  if (entry.errorCode === 368) return false;
  const s = `${entry.errorCode ?? ''} ${entry.errorMessage ?? ''}`;
  if (/ProcessingFailedError/i.test(s)) return true;
  if (/\b(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNRESET)\b/i.test(s)) return true;
  if (/fetch failed|network (?:error|timeout)|socket hang ?up|getaddrinfo/i.test(s)) return true;
  return false;
}

// Should this failed attempt PARK the post on the FIRST strike instead of spending
// the 3-strike cap? A terminal refusal fails identically on every retry, so each
// retry only burns a metered call for nothing. The 2026-07 X storm was exactly this:
// 722 "duplicate content" 403s + 723 "reply to a stranger" 403s, each retried to the
// cap. Keyed off the attempt MESSAGE the engines already record (code-agnostic, so a
// re-labelled errorCode can't slip past). This is PER-POST only - it stamps this one
// post's publishHold; it never halts the lane (an account-level 402 credits refusal is
// the only thing that halts a whole lane, via lib/state.mjs recordLaneBlock).
export function isTerminalRefusal(entry) {
  if (!entry || entry.ok !== false) return false;
  const s = `${entry.errorCode ?? ''} ${entry.errorMessage ?? ''}`;
  // X: an identical tweet is refused forever; a reply to someone who did not mention
  // you is refused forever (the non-Enterprise reply restriction, Feb 2026).
  if (/duplicate content/i.test(s)) return true;
  if (/you can only reply to or quote posts where you are/i.test(s)) return true;
  // A PROBE-CONFIRMED dead public media URL (IG feed image / carousel slide /
  // pinterest pin): the URL 404s or serves non-image bytes, so Meta's server-side
  // fetch fails identically on every retry until it is re-mirrored. The engines'
  // pre-fire fail-safe (and the post-9004 diagnosis) stamp classifyMediaProbe's
  // sentence, whose tail is MEDIA_URL_DEAD_MARK - match it to park on the FIRST
  // strike instead of the 3-strike cap (the 2026-08 storm re-fired such a post
  // every 60s for days). Only the CONFIRMED-dead message carries this mark; a bare
  // Meta 9004 with an inconclusive probe does not, so it still rides the cap.
  if (s.includes(MEDIA_URL_DEAD_MARK)) return true;
  return false;
}

// The attempts audit trail was an unbounded push (the lib/plans.mjs
// lastFailureFor comment flagged it); the storm proved it. Only the tail is
// ever read (lastFailureFor + the hold streak below), so cap it.
export const ATTEMPTS_TAIL_CAP = 100;

// The one write path for a publish attempt: append + trim, then maintain the
// hold. `entry` is the engines' attempt row ({ ts, platform, action, ok,
// errorCode, errorMessage, ... }). A cleared hold is written as null, never
// deleted: the engines' savePlan field-merge copies `mem[f] !== undefined`
// onto disk, so a delete would resurrect the stale hold from the disk copy.
export function recordAttempt(post, entry) {
  post.attempts = Array.isArray(post.attempts) ? post.attempts : [];
  post.attempts.push(entry);
  if (post.attempts.length > ATTEMPTS_TAIL_CAP) post.attempts = post.attempts.slice(-ATTEMPTS_TAIL_CAP);
  if (entry.ok === true) {
    // A real success on any lane means the post is publishing again - reset both
    // the terminal hold and any in-flight transient retry schedule.
    if (post.publishHold) post.publishHold = null;
    if (post.publishRetry) post.publishRetry = null;
    return;
  }
  if (entry.ok !== false || post.publishHold) return;

  const now = Date.parse(entry.ts) || Date.now();
  const lane = entry.platform || null;
  const action = entry.action || null;

  if (isTerminalRefusal(entry)) {
    // A permanent refusal: retrying only burns metered calls. Park on the first
    // strike (same terminal shape as the cap) so the operator edits/reschedules
    // instead of the tick hammering the platform. Ends any transient ride-out.
    post.publishRetry = null;
    post.publishHold = {
      at: entry.ts || new Date(now).toISOString(),
      lane,
      code: entry.errorCode ?? null,
      message: entry.errorMessage || null,
    };
    return;
  }

  if (isTransientFailure(entry)) {
    // Ride out an intermittent failure (network / Instagram ProcessingFailedError)
    // with backoff instead of parking a healthy post. publishRetry is per
    // platform+action, like the streak below; a new lane/action starts fresh.
    let r = post.publishRetry;
    if (!r || r.lane !== lane || r.action !== action) {
      r = { lane, action, firstAt: entry.ts || new Date(now).toISOString(), attempts: 0, nextAt: null };
    }
    r.attempts += 1;
    const elapsed = now - (Date.parse(r.firstAt) || now);
    if (elapsed >= TRANSIENT_RETRY_WINDOW_MS) {
      // The bad spell outlasted the ride-out window - park it (same terminal shape
      // as the permanent cap) so the operator + the feed-reconcile backstop take over.
      post.publishHold = {
        at: entry.ts || new Date(now).toISOString(),
        lane,
        code: entry.errorCode ?? null,
        message: entry.errorMessage || null,
      };
      post.publishRetry = null;
    } else {
      r.nextAt = new Date(now + transientBackoffMs(r.attempts)).toISOString();
      post.publishRetry = r;
    }
    return;
  }

  // Genuine refusal: a real refusal ends any prior transient ride-out, and the
  // fast 3-strike permanent-park applies. Trailing consecutive failures for THIS
  // platform+action; rows from other lanes neither count nor break the streak (an
  // FB ok between IG failures must not mask a stuck IG lane); any prior success ends it.
  post.publishRetry = null;
  let streak = 0;
  for (let i = post.attempts.length - 1; i >= 0; i--) {
    const a = post.attempts[i];
    if (!a || a.platform !== entry.platform || a.action !== entry.action) continue;
    if (a.ok !== false) break;
    streak++;
    if (streak >= MAX_PUBLISH_ATTEMPTS) break;
  }
  if (streak >= MAX_PUBLISH_ATTEMPTS) {
    post.publishHold = {
      at: entry.ts || new Date().toISOString(),
      lane: entry.platform || null,
      code: entry.errorCode ?? null,
      message: entry.errorMessage || null,
    };
  }
}
