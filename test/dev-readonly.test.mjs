// dev-readonly.test.mjs - the READ/COMPOSE-ONLY guard for `npm run dev:live` (lib/dev-mode.mjs).
//
// Proves the three engine chokepoints refuse when PENDPOST_DEV_READONLY=1 so the dev
// instance can NEVER write publish/schedule/approval state, while COMPOSE (createPost of a
// pending draft) still works - and that with the flag OFF the guards are byte-inert.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-dev-readonly-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DEV_READONLY;
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { isDevReadonly, DEV_READONLY_CODE } = await import('../lib/dev-mode.mjs');
const { createCampaign, createPost, approvePost, rejectPost } = await import('../lib/writes.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');

try {
  // ---- 1. isDevReadonly reads the env on every call ----------------------
  ok(isDevReadonly() === false, 'isDevReadonly() is false without the flag');
  process.env.PENDPOST_DEV_READONLY = '1';
  ok(isDevReadonly() === true, 'isDevReadonly() flips true when PENDPOST_DEV_READONLY=1');
  process.env.PENDPOST_DEV_READONLY = '0';
  ok(isDevReadonly() === false, 'isDevReadonly() is false for any value other than "1"');

  // ---- 2. COMPOSE still works read-only: a draft can be created ----------
  process.env.PENDPOST_DEV_READONLY = '1';
  const CAMP = 'dev-ro-camp';
  const cc = await createCampaign({ id: CAMP, note: 'dev-ro', timezone: 'UTC', actor: 'owner' });
  ok(cc.ok, 'createCampaign works in read-only dev (compose)');
  const cp = await createPost({
    campaign: CAMP,
    post: { id: 'p1', type: 'text', platforms: ['x'], scheduledAt: '2020-01-01T00:00:00Z', caption: 'a draft' },
    actor: 'agent:claude',
  });
  ok(cp.ok, 'createPost of a pending draft works in read-only dev (compose)');

  // ---- 3. setApproval refuses BOTH verdicts in read-only dev -------------
  // setApproval failures return errorBody => { code, message } (no ok:true), so a refusal is
  // identified by the code and the ABSENCE of ok:true.
  const appr = await approvePost({ campaign: CAMP, postId: 'p1', actor: 'owner' });
  ok(appr && appr.ok !== true && appr.code === DEV_READONLY_CODE, 'approvePost is refused with dev_readonly in read-only dev');
  const rej = await rejectPost({ campaign: CAMP, postId: 'p1', actor: 'owner' });
  ok(rej && rej.ok !== true && rej.code === DEV_READONLY_CODE, 'rejectPost is refused with dev_readonly in read-only dev');

  // ---- 4. the draft was NOT mutated (approval stayed pending) ------------
  const { loadPlanStore } = await import('../lib/plans.mjs');
  const post = (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []).find((p) => p.id === 'p1');
  ok(post && post.approval !== 'approved' && post.approval !== 'rejected', 'the draft keeps its pre-decision state - dev wrote no approval verdict');

  // ---- 5. runDueExclusive (the ONE publish path) refuses -----------------
  const due = await runDueExclusive('owner');
  ok(due && due.ok === false && due.code === DEV_READONLY_CODE, 'runDueExclusive is refused with dev_readonly (tick + Check-now + MCP all funnel here)');

  // ---- 6. flag OFF: the guards are byte-inert (approve works) ------------
  delete process.env.PENDPOST_DEV_READONLY;
  const appr2 = await approvePost({ campaign: CAMP, postId: 'p1', actor: 'owner' });
  ok(appr2 && appr2.ok === true, 'with the flag OFF, approvePost works normally (guard is inert)');

  console.log(`\n${pass} checks passed (dev:live read/compose-only guard)`);
} catch (err) {
  console.error('not ok -', err && err.message);
  console.error(err);
  process.exit(1);
} finally {
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best-effort */ }
}
