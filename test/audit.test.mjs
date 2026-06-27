#!/usr/bin/env node
// test/audit.test.mjs - NFR-AUD-01/02 audit-trail invariants as a gate.
//
// (a) NFR-AUD-02: the activity feed is capped at 500, newest-first. Append more
//     than 500 entries through the PUBLIC appendActivity path and assert the
//     stored length is exactly 500, the oldest entries are gone, and the very
//     newest survives at the head.
// (b) NFR-AUD-01: a write without an actor is rejected. plan_update_post
//     (updatePost) and approve (approvePost) both require an actor and return
//     invalid_input when none is supplied. (No-self-approval is NOT re-tested
//     here - test/mock-loop.test.mjs already covers it.)
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib
// (util binds WORKSPACE_ROOT at import; mirrors test/mock-loop.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-audit-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { appendActivity, getActivity } = await import('../lib/scheduler.mjs');
const { loadState } = await import('../lib/state.mjs');
const { updatePost, approvePost } = await import('../lib/writes.mjs');

try {
  // ---- (a) NFR-AUD-02: capped at 500 newest-first -------------------------
  const TOTAL = 620; // comfortably over the 500 cap
  for (let i = 0; i < TOTAL; i += 1) {
    appendActivity({ campaign: null, postId: null, platform: null, action: 'audit-seed', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: 'test', seq: i });
  }
  const stored = loadState().activity || [];
  ok(stored.length === 500, `activity feed is capped at exactly 500 entries after appending ${TOTAL} (got ${stored.length})`);
  // appendActivity PREPENDS, so the head is the newest (seq = TOTAL - 1).
  ok(stored[0].seq === TOTAL - 1, `the newest entry survives at the head (seq ${stored[0].seq} === ${TOTAL - 1})`);
  // The oldest 120 (seq 0..119) were sliced off by age; the surviving tail is
  // the 500 most-recent, so the smallest surviving seq is TOTAL - 500.
  const oldestSurviving = stored[stored.length - 1].seq;
  ok(oldestSurviving === TOTAL - 500, `the oldest ${TOTAL - 500} entries were dropped by the cap (smallest surviving seq ${oldestSurviving} === ${TOTAL - 500})`);
  ok(!stored.some((e) => e.seq === 0), 'the very first (oldest) entry is gone, not retained');
  // getActivity also clamps to the cap and stays newest-first.
  const view = getActivity(1000);
  ok(view.length === 500, `getActivity clamps a 1000 request to the 500 cap (got ${view.length})`);
  ok(view[0].seq === TOTAL - 1, 'getActivity returns newest-first');

  // ---- (b) NFR-AUD-01: a write without an actor is rejected ----------------
  // Valid-FORMAT ids so the call reaches the actor check (requireIds validates
  // the id shape only, before any plan lookup). No actor -> invalid_input.
  const noActorUpdate = await updatePost({ campaign: 'acme', postId: 'reel1', ifRev: 'deadbeef', fields: { caption: 'x' } });
  ok(noActorUpdate.code === 'invalid_input', `plan_update_post without an actor is rejected (code=${noActorUpdate.code})`);
  ok(/actor/i.test(noActorUpdate.message || ''), 'the rejection names the missing actor');

  const blankActorUpdate = await updatePost({ campaign: 'acme', postId: 'reel1', ifRev: 'deadbeef', fields: { caption: 'x' }, actor: '   ' });
  ok(blankActorUpdate.code === 'invalid_input', 'a blank/whitespace actor is also rejected on plan_update_post');

  const noActorApprove = await approvePost({ campaign: 'acme', postId: 'reel1' });
  ok(noActorApprove.code === 'invalid_input', `approve without an actor is rejected (code=${noActorApprove.code})`);

  console.log(`[audit] OK - activity feed capped at 500 newest-first; actor-less writes rejected (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
