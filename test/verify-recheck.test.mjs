#!/usr/bin/env node
// test/verify-recheck.test.mjs - the bounded verify-failed re-check
// (lib/verify.mjs verifySweep + recheckDue), ux-audit dim-1 G3 / R1a.
//
// Before this, verifySweep re-checked ONLY 'fired-assumed' posts: one transient
// platform hiccup during a read-back parked a genuinely-live post in a red
// verify-failed state forever unless the operator found the manual Verify. Now
// the sweep re-checks verify-failed posts too, with a growing backoff and a hard
// cap (MAX_VERIFY_RECHECKS, aligned with publish-hold's cap-at-3 doctrine):
//
// (a) The first sweep of a fired-assumed post that reads back not-live lands
//     verify-failed with NO recheck stamp (the fresh block starts the clock).
// (b) An immediate second sweep is a no-op - the backoff spacing holds, so a
//     60s tick can never hammer the platform.
// (c) Once the spacing elapses, the sweep re-reads; still-failed stamps
//     verify.recheck { count, at } so the spacing grows and the budget is finite.
// (d) A later successful read flips the post to verified-live and the fresh
//     verify block carries no recheck stamp (a future failure gets a new budget).
// (e) After MAX_VERIFY_RECHECKS failed re-checks the sweep stops entirely
//     (no engine spawn), and the manual verifyPost (the GUI "Re-check" verb)
//     still works past the cap and heals the post.
//
// Driven against the REAL sweep -> engine subprocess -> mock driver path
// (PENDPOST_MODE=mock; PENDPOST_MOCK_VERIFY_FAIL forces the mock read-back to
// report a terminal not-live state - the PENDPOST_MOCK_FAIL idiom).
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-recheck-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_MOCK_VERIFY_FAIL;
delete process.env.META_PUBLISHING_PAUSED;

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { verifySweep, verifyPost, MAX_VERIFY_RECHECKS } = await import('../lib/verify.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { resolvePlanPath } = await import('../lib/planWrite.mjs');

const getPost = (camp, id) => (loadPlanStore().campaigns.find((c) => c.id === camp)?.posts || []).find((p) => p.id === id);
const planAbs = () => resolvePlanPath(loadPlanStore().campaigns.find((c) => c.id === 'vr').path);
// Direct disk edit of the raw plan (test-only; no engine is running concurrently).
const editRaw = (id, fn) => {
  const abs = planAbs();
  const plan = JSON.parse(fs.readFileSync(abs, 'utf8'));
  fn((plan.posts || []).find((p) => p.id === id));
  fs.writeFileSync(abs, JSON.stringify(plan, null, 2));
};
const LONG_AGO = new Date(Date.now() - 60 * 60_000).toISOString(); // 60 min: past every backoff step

try {
  const cc = await createCampaign({ id: 'vr', note: 'verify recheck', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, `createCampaign: ${JSON.stringify(cc)}`);
  for (const id of ['p1', 'p2']) {
    const cp = await createPost({
      campaign: 'vr',
      post: { id, type: 'text', platforms: ['x'], scheduledAt: '2020-01-01T00:00:00Z', caption: `a short note about the workshop, take ${id}` },
      actor: 'agent:claude',
    });
    assert.ok(cp.ok, `createPost ${id}: ${JSON.stringify(cp)}`);
    const ap = await approvePost({ campaign: 'vr', postId: id, actor: 'owner' });
    assert.ok(ap.ok, `approvePost ${id}: ${JSON.stringify(ap)}`);
  }
  // Hand the posts off: a minted platform id + past due = fired-assumed.
  editRaw('p1', (p) => { p.xPostId = 'x_mock_p1'; });
  editRaw('p2', (p) => { p.xPostId = 'x_mock_p2'; });
  assert.equal(getPost('vr', 'p1').derivedState, 'fired-assumed', 'precondition: p1 fired-assumed');

  // ---- (a) a failing read-back parks the post verify-failed, no stamp yet ----
  process.env.PENDPOST_MOCK_VERIFY_FAIL = 'x:missing';
  const s1 = await verifySweep();
  ok(s1.ok && s1.checked === 2, `first sweep checks both fired-assumed posts (checked=${s1.checked})`);
  const p1a = getPost('vr', 'p1');
  ok(p1a.derivedState === 'verify-failed', 'failed read-back derives verify-failed');
  ok(p1a.verify?.platforms?.x?.state === 'missing', 'the not-live state is recorded on the verify block');
  ok(!p1a.verify?.recheck, 'the fresh verify block carries no recheck stamp');

  // ---- (b) an immediate next sweep is a no-op (backoff spacing holds) ----
  const s2 = await verifySweep();
  ok(s2.ok && s2.checked === 0, 'an immediate second sweep re-checks nothing (spacing holds, no per-tick hammering)');

  // ---- (c) after the spacing, the sweep re-reads and stamps the counter ----
  editRaw('p1', (p) => { p.verify.at = LONG_AGO; });
  editRaw('p2', (p) => { p.verify.at = LONG_AGO; });
  const s3 = await verifySweep();
  ok(s3.ok && s3.checked === 2, `an elapsed backoff re-checks the verify-failed posts (checked=${s3.checked})`);
  const p1b = getPost('vr', 'p1');
  ok(p1b.derivedState === 'verify-failed' && p1b.verify?.recheck?.count === 1, 'a still-failed re-check stamps verify.recheck.count=1');
  const s4 = await verifySweep();
  ok(s4.ok && s4.checked === 0, 'the stamp restarts the spacing - the very next sweep is a no-op again');

  // ---- (d) a later successful read flips to verified-live, stamp cleared ----
  delete process.env.PENDPOST_MOCK_VERIFY_FAIL;
  editRaw('p1', (p) => { p.verify.recheck.at = LONG_AGO; });
  // p2 stays failing for the cap test below: put it back on the failing path
  // by leaving its recheck stamp fresh (not yet due).
  const s5 = await verifySweep();
  ok(s5.ok && s5.checked === 1, `only the due post is re-checked (checked=${s5.checked})`);
  const p1c = getPost('vr', 'p1');
  ok(p1c.derivedState === 'verified-live', 'a successful later sweep heals verify-failed to verified-live');
  ok(!p1c.verify?.recheck, 'the healed verify block carries no recheck stamp (a future failure gets a fresh budget)');

  // ---- (e) the cap: after MAX_VERIFY_RECHECKS failed re-checks, the sweep stops ----
  process.env.PENDPOST_MOCK_VERIFY_FAIL = 'x:missing';
  let p2 = getPost('vr', 'p2');
  assert.equal(p2.verify?.recheck?.count, 1, 'precondition: p2 already burned recheck 1');
  while ((getPost('vr', 'p2').verify?.recheck?.count || 0) < MAX_VERIFY_RECHECKS) {
    editRaw('p2', (p) => { p.verify.recheck.at = LONG_AGO; });
    const s = await verifySweep();
    assert.ok(s.ok && s.checked === 1, `recheck loop sweep: ${JSON.stringify(s)}`);
  }
  p2 = getPost('vr', 'p2');
  ok(p2.verify.recheck.count === MAX_VERIFY_RECHECKS, `the recheck counter caps at ${MAX_VERIFY_RECHECKS}`);
  editRaw('p2', (p) => { p.verify.recheck.at = LONG_AGO; });
  const beforeAt = getPost('vr', 'p2').verify.at;
  const s6 = await verifySweep();
  ok(s6.ok && s6.checked === 0, 'past the cap the sweep never re-checks again (bounded, not infinite)');
  ok(getPost('vr', 'p2').verify.at === beforeAt, 'no engine read happened past the cap (verify.at untouched)');

  // ---- the manual verb still works past the cap and heals the post ----
  delete process.env.PENDPOST_MOCK_VERIFY_FAIL;
  const manual = await verifyPost({ campaign: 'vr', postId: 'p2', actor: 'owner' });
  assert.ok(manual.ok, `manual verifyPost: ${JSON.stringify(manual)}`);
  const p2b = getPost('vr', 'p2');
  ok(p2b.derivedState === 'verified-live', 'the manual Re-check verb works past the cap and heals the post');
  ok(!p2b.verify?.recheck, 'the manual re-check resets the recheck budget');

  console.log(`\nverify-recheck: ${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
