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
export const MAX_PUBLISH_ATTEMPTS = 3;

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
    // A real success on any lane means the post is publishing again - reset.
    if (post.publishHold) post.publishHold = null;
    return;
  }
  if (entry.ok !== false || post.publishHold) return;
  // Trailing consecutive failures for THIS platform+action. Rows from other
  // lanes neither count nor break the streak (an FB ok between IG failures
  // must not mask a stuck IG lane); any prior success on this lane ends it.
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
