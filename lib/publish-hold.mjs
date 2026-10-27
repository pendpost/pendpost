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
// Mechanism (measured 2026-10-22): rupload processes the video inside the request and
// fails at ~35s, so a reel passes only while Meta processes it in time; a long reel
// (~70s, ~64s of processing) rarely does. The fix for that is the video_url path
// (scripts/meta-social.mjs), which the cloud uses; this window still covers rupload.
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
// An engine could not tell whether a publishing call went live AND could not check the
// platform (scripts/meta-social.mjs, the ambiguous-publish rule, owner decision 2026-10-14).
// Never transient (a blind backoff retry is exactly the double post the rule prevents) and
// parked on the first strike: the owner looks at the Page, then marks it posted or uses Try
// again, which checks the Page before it publishes.
export const PUBLISH_UNCONFIRMED = 'publish_unconfirmed';

// A publishing call ended without a verdict and left its intent marker (scripts/meta-social.mjs
// contract C1/C2): the next run waits for Meta to settle, checks the Page, then adopts or
// publishes. Transient by definition (a later tick is exactly the recovery), never a strike.
export const PUBLISH_PENDING_CHECK = 'publish_pending_check';

export function isTransientFailure(entry) {
  if (!entry || entry.ok !== false) return false;
  if (entry.errorCode === 368) return false;
  if (entry.errorCode === PUBLISH_UNCONFIRMED) return false;
  if (entry.errorCode === PUBLISH_PENDING_CHECK) return true;
  const s = `${entry.errorCode ?? ''} ${entry.errorMessage ?? ''}`;
  if (/ProcessingFailedError/i.test(s)) return true;
  if (/\b(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNRESET)\b/i.test(s)) return true;
  if (/fetch failed|network (?:error|timeout)|socket hang ?up|getaddrinfo/i.test(s)) return true;
  // Gateway/timeout/rate statuses are the platform being briefly unavailable, not a verdict
  // on the post (2026-09-29: a 408 then a 503 parked a healthy reel after 9 minutes).
  if (/\bHTTP (?:408|429|5\d\d)\b/.test(s)) return true;
  return false;
}

// errorCode an engine records when its own pre-submit content check refuses a due
// post (see isTerminalRefusal). The message names what the operator has to fix.
export const INVALID_CONTENT = 'invalid_content';

// The engines' pre-submit BLOCK-ROW codes that mean "this post's content cannot
// publish on this lane as authored": the same bytes fail the same check on every
// tick, so they park on the first strike like INVALID_CONTENT. The scheduler records
// these rows as attempts (lib/scheduler.mjs, the results loop), since the engines
// push them without appendAttempt.
//  - invalid_input    caption/body over the lane limit (lib/caption.mjs captionBlockRow,
//                     the X 280 cap), unparseable scheduledAt (yt skipRow)
//  - invalid_carousel slide count/cap/mix (lib/carousel.mjs carouselBlockRow)
//  - invalid_poll     option count/duration (lib/poll.mjs pollBlockRow)
//  - invalid_media    measured A/V desync or a non-video file (lib/assets.mjs
//                     avSyncBlockRow, yt skipRow)
//  - unsupported      a shape the lane cannot assemble locally (IG image without a
//                     public URL, pinterest/reddit carousels, video without a cover)
// Deliberately NOT here: media_missing (a render still being written or synced can
// appear on its own, so it rides the generic 3-strike cap), needs_scope and the other
// credential failures (isCredentialFailure below: also first strike, but the recovery is
// a reconnect, not an edit) and engine_failure (the platform: the cap or transient backoff).
// No engine records one of these codes from a platform response today, so keying on
// the code cannot park a post the platform refused only transiently.
export const CONTENT_BLOCK_CODES = new Set([
  INVALID_CONTENT, 'invalid_input', 'invalid_carousel', 'invalid_poll', 'invalid_media', 'unsupported',
]);

// X's February 2026 reply restriction, in both phrasings X has used: below Enterprise,
// an API reply to a post whose author did not mention you is refused, every time.
export const X_REPLY_RESTRICTED = /you can only reply to or quote posts where you are|reply to this conversation is not allowed/i;

// A LOCAL credential failure: the lane's own credential is missing, expired, revoked or
// lacks a scope, AFTER the engine's own refresh attempt (ensureFreshToken) already failed.
// Owner decision 2026-09-25: reconnect-first. A retry cannot fix a revoked token and the
// operator is the next actor, so it parks on the FIRST strike (isTerminalRefusal) with
// recovery 'reconnect' (failureRecovery) instead of spending the 3-strike cap while the
// Studio says "retrying". Keyed off what the engines actually record, never a guess:
//   needs_scope        the engines' own credential code (bluesky/reddit/tiktok/linkedin
//                      member author/pinterest media:write/x+yt+mastodon radar 401/403;
//                      nostr's not-configured row via the scheduler's r.error fallback)
//   190                Meta OAuthException 190, an expired or invalidated token
//                      (meta-social.mjs api() sets errorCode = err.fbCode)
//   HTTP 401           every engine's api() formats "<Lane> <METHOD> <path>: HTTP <status>"
//   invalid_grant      the OAuth refresh exchange refused the stored refresh token
//   the ensureFreshToken / requireEnv / mintToken throws: "No <VAR>_TOKEN", "access token
//                      expired", "token refresh failed" / "Refresh failed", "<VAR> missing
//                      in .env", "credentials missing" (reddit), which reach the attempt
//                      through the scheduler's zero-row engine_failure branch
//   nostr's signing key nostr has no token: its credential is the client-side key, and
//                      nostr-social.mjs parsePrivateKey / bech32Decode throw "NOSTR_PRIVATE_KEY
//                      must be nsec1... / decodes to N bytes / is out of the secp256k1 range"
//                      or "bech32: <why>" (bech32Decode's only other caller, lud06, swallows
//                      its throw). "no relay accepted the event" is NOT here: relays can
//                      refuse a note while the key is fine.
// NOT a credential failure, whatever the code says: a transient failure (a refresh that
// failed on the NETWORK keeps its backoff), a 429 or 5xx (the platform stumbled, not the
// credential), and X's reply restriction (recorded as needs_scope, but only a manual post
// ever lands it). Accepts the attempt row ({ errorCode, errorMessage }) and the failure
// shape ({ code, message }) so the hold release and failureRecovery share it.
const CREDENTIAL_CODES = new Set(['needs_scope', 190]);
const CREDENTIAL_MESSAGE = new RegExp([
  String.raw`\bHTTP 401\b`,
  String.raw`\binvalid_grant\b`,
  String.raw`\bOAuthException 190\b|error validating access token`,
  String.raw`\bcredentials missing\b|\b[A-Z][A-Z0-9_]+ missing in \.env\b`,
  String.raw`\bNo [A-Z][A-Z0-9_]*_TOKEN\b`,
  String.raw`\baccess token expired\b`,
  String.raw`\btoken refresh failed\b|\bRefresh failed\b`,
  String.raw`\bNOSTR_PRIVATE_KEY (?:must be nsec1|decodes to|is out of|is not set)`,
  String.raw`\bbech32: `,
].join('|'), 'i');
const NOT_CREDENTIAL_STATUS = /\bHTTP (?:429|5\d\d)\b/;

export function isCredentialFailure(f) {
  if (!f || f.ok === true) return false;
  const code = f.errorCode ?? f.code ?? null;
  const message = f.errorMessage ?? f.message ?? '';
  const s = `${code ?? ''} ${message}`;
  if (X_REPLY_RESTRICTED.test(s)) return false;
  if (NOT_CREDENTIAL_STATUS.test(s)) return false;
  if (isTransientFailure({ ok: false, errorCode: code, errorMessage: message })) return false;
  return CREDENTIAL_CODES.has(code) || CREDENTIAL_MESSAGE.test(String(message));
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
  if (X_REPLY_RESTRICTED.test(s)) return true;
  // A PROBE-CONFIRMED dead public media URL (IG feed image / carousel slide /
  // pinterest pin): the URL 404s or serves non-image bytes, so Meta's server-side
  // fetch fails identically on every retry until it is re-mirrored. The engines'
  // pre-fire fail-safe (and the post-9004 diagnosis) stamp classifyMediaProbe's
  // sentence, whose tail is MEDIA_URL_DEAD_MARK - match it to park on the FIRST
  // strike instead of the 3-strike cap (the 2026-08 storm re-fired such a post
  // every 60s for days). Only the CONFIRMED-dead message carries this mark; a bare
  // Meta 9004 with an inconclusive probe does not, so it still rides the cap.
  if (s.includes(MEDIA_URL_DEAD_MARK)) return true;
  // The engine's own pre-submit content check refused the post (no title, no
  // destination, body over the lane limit). Nothing reached the platform and the
  // same content fails the same check on every tick, so only an edit can fix it -
  // and an edit clears the hold (lib/writes.mjs updatePost). Keyed on the code
  // because the engines word these checks per lane. The block-row codes are the
  // same class (see CONTENT_BLOCK_CODES).
  if (CONTENT_BLOCK_CODES.has(entry.errorCode)) return true;
  // Unconfirmed publish: the owner must look first (see PUBLISH_UNCONFIRMED).
  if (entry.errorCode === PUBLISH_UNCONFIRMED) return true;
  // A local credential failure (see isCredentialFailure): the stored credential is gone,
  // expired or short a scope, so every retry fails the same way until the operator
  // reconnects the lane. A passing recheck after that reconnect releases the hold
  // (lib/writes.mjs releaseCredentialHolds).
  if (isCredentialFailure(entry)) return true;
  return false;
}


// The cloud's credential refusals (lib/cloud-client.mjs CREDENTIAL_REFUSALS): the cloud
// could not prove which account the post would land on, so it published nothing.
const CREDENTIAL_REFUSAL_CODES = new Set(['account_unresolved', 'account_mismatch']);

// The ONE thing that recovers a failure no retry can fix, or null when a retry may still
// land it. Surfaced as post.lastFailure.recovery (lib/plans.mjs lastFailureFor), so the
// Studio never says "retrying" or offers "publish now" for a post that will be refused
// again, and names the action that does work instead:
//   'reconnect' - a cloud credential refusal, or a local credential failure
//                 (isCredentialFailure): reconnect the lane under Einrichtung.
//   'manual'    - X refuses the reply via the API: copy the text and post it by hand.
//   'edit'      - the content cannot publish as authored: edit it (an edit clears the hold).
// `f` is { code, message, refusedCode } (any source). The X reply check runs before the
// code, because the engine records that 403 as needs_scope, and a reconnect never fixes it.
// A confirmed-dead media URL is deliberately NOT here: re-mirroring fixes it and the held
// post's "Try again" is then the right verb.
export function failureRecovery(f) {
  if (!f) return null;
  if (f.refusedCode && CREDENTIAL_REFUSAL_CODES.has(f.refusedCode)) return 'reconnect';
  const s = `${f.code ?? ''} ${f.message ?? ''}`;
  if (X_REPLY_RESTRICTED.test(s)) return 'manual';
  if (CONTENT_BLOCK_CODES.has(f.code) || /duplicate content/i.test(s)) return 'edit';
  if (isCredentialFailure({ code: f.code, message: f.message })) return 'reconnect';
  return null;
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
    if (isTransientFailure(a)) continue; // a ridden-out outage is not a strike
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
