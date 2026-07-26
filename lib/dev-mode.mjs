// dev-mode.mjs - the READ/COMPOSE-ONLY guard for `npm run dev:live`.
//
// `npm run dev:live` boots a LOCAL dev Studio pointed at the operator's REAL data dir
// (data/clients/*, every connected client) on a SEPARATE port, so new features can be tested
// against live campaigns / posts / Radar signals / warmth WITHOUT risking the live
// install. The live launchd daemon `pendpost` (server.mjs, 127.0.0.1:8090) is ALREADY
// the sole writer of publish/schedule state; two live writers is the failure mode.
//
// HARD SAFETY INVARIANT (designed out, not just warned): when PENDPOST_DEV_READONLY=1
// the dev instance is READ/COMPOSE-ONLY - it may READ everything and COMPOSE drafts
// (a draft stays approval:'pending'; the daemon never fires a pending post), but it
// NEVER writes publish / schedule / approval state. Enforced at four engine chokepoints:
//   1. bootScheduler()   - never start the 24h tick (so no publish-due fires, no daily
//      Radar scan, no cloud reconcile) in the dev process. (lib/scheduler.mjs)
//   2. runDueExclusive() - hard-refuse. This is the ONE path posts fire through - the
//      scheduler tick, the dashboard "Check now" button, AND the MCP due-runner all
//      funnel through it, so one guard closes every publish route. (lib/scheduler.mjs)
//   3. setApproval()     - refuse ANY approval decision (approve OR reject). Dev makes no
//      approval decisions on live data, so the daemon never inherits a dev-approved post
//      to fire. Composing/editing DRAFTS still works. (lib/writes.mjs)
//   4. bootScheduleBackfill() - never heal dateless posts (that write is a scheduledAt, i.e.
//      SCHEDULE state) from the dev process. dev:live boots the same server.mjs, so without
//      this the dev Studio would rewrite the operator's live plans behind the daemon's back.
//      The sibling bootCoverBackfill() is deliberately UNguarded - a cover is media, not
//      schedule state. (lib/writes.mjs)
// state.json writes are atomic (tmp+rename, lib/state.mjs), so a dev COMPOSE write racing
// the daemon can never corrupt the file - it is last-write-wins on the volatile draft, not
// a torn write. The three guards above ensure dev never touches publish/schedule state at all.
//
// Zero deps. The flag is read from the environment on EVERY call (not captured at module
// load) so tests can toggle it and so it is honest regardless of import order.

// The refusal code every guarded write returns (matches the {ok:false, code, message}
// convention of lib/writes.mjs#errorBody and the scheduler's busy refusal).
export const DEV_READONLY_CODE = 'dev_readonly';

// True when this process is the READ/COMPOSE-ONLY dev instance (`npm run dev:live`).
export function isDevReadonly() {
  return process.env.PENDPOST_DEV_READONLY === '1';
}
