#!/usr/bin/env node
// test/schedule-backfill.test.mjs - the REPAIR half of the Termin invariant.
//
// createPost/validateFieldValues fence every write path (HTTP, MCP, Composer,
// ThreadComposer), so no NEW post can be dateless. But a gate cannot reach rows already
// on disk: posts written before the gate landed, a hand-edited plan file, or a restored
// backup can all still carry scheduledAt:null. Such a post mints zero publish lanes
// (scheduler.lanesFor returns [] on NaN) and can never read as overdue (Date.parse(null)
// is NaN, so plans.deriveState's pastDue is permanently false) - it rots as 'waiting-due'
// forever, silently never publishing. backfillMissingSchedules heals exactly that.
//
// The dateless rows are written DIRECTLY to the plan file here - that is the point. It is
// the only way they can exist, and createPost refusing to make one is itself asserted
// below, so the two halves of the invariant are proved together.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib (util
// binds the root at import). No clients.json -> the activeRoot() legacy single-client
// fallback resolves data/ under WS. `now` is injected, so no clock games.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-schedbackfill-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DEV_READONLY;

const PLANS = path.join(WS, 'data', 'plans');
fs.mkdirSync(PLANS, { recursive: true });
fs.writeFileSync(path.join(PLANS, 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { createCampaign, createPost, backfillMissingSchedules, bootScheduleBackfill } = await import('../lib/writes.mjs');
const { getActivity } = await import('../lib/scheduler.mjs');

// A fixed clock: the repaired Termin must be exactly NOW + 3 days, to the millisecond.
const NOW = Date.parse('2026-07-15T09:00:00.000Z');
const EXPECTED = '2026-07-18T09:00:00.000Z';

const planFile = () => path.join(PLANS, 'launch', 'post-plan.json');
const readPlan = () => JSON.parse(fs.readFileSync(planFile(), 'utf8'));
const postById = (id) => readPlan().posts.find((p) => p.id === id);

// Write a post straight into the plan file, bypassing createPost - the only way a
// dateless row can come into existence (legacy data / hand edit / restored backup).
const writeRawPost = (post) => {
  const plan = readPlan();
  plan.posts.push(post);
  fs.writeFileSync(planFile(), JSON.stringify(plan, null, 2));
};

try {
  ok(typeof backfillMissingSchedules === 'function', 'backfillMissingSchedules is exported from lib/writes.mjs');
  ok(typeof bootScheduleBackfill === 'function', 'bootScheduleBackfill is exported from lib/writes.mjs');

  const c = await createCampaign({ id: 'launch', timezone: 'UTC', actor: 'owner' });
  assert.ok(c.ok, `createCampaign: ${JSON.stringify(c)}`);

  // ======================= the create-side gate is NOT softened =======================
  // The backfill is a repair for data the gate could not reach, never a licence to
  // create dateless posts. An agent that omits the Termin must still be told, loudly.
  // errorBody() returns { code, message } with NO ok field, so refusal is `!ok` + the code.
  const noDate = await createPost({ campaign: 'launch', post: { id: 'nope', type: 'text', platforms: ['reddit'], caption: 'no termin' }, actor: 'agent:claude' });
  ok(!noDate.ok && noDate.code === 'invalid_input', 'createPost still REFUSES a post with no scheduledAt (the gate stays hard)');
  const nullDate = await createPost({ campaign: 'launch', post: { id: 'nope2', type: 'text', platforms: ['reddit'], scheduledAt: null, caption: 'null termin' }, actor: 'agent:claude' });
  ok(!nullDate.ok && nullDate.code === 'invalid_input', 'createPost still REFUSES an explicit scheduledAt:null');
  const junkDate = await createPost({ campaign: 'launch', post: { id: 'nope3', type: 'text', platforms: ['reddit'], scheduledAt: 'whenever', caption: 'junk' }, actor: 'agent:claude' });
  ok(!junkDate.ok && junkDate.code === 'invalid_input', 'createPost still REFUSES an unparseable scheduledAt');

  // A legitimately scheduled post, created through the real path.
  const good = await createPost({ campaign: 'launch', post: { id: 'dated', type: 'text', platforms: ['reddit'], scheduledAt: '2026-08-01T10:00:00Z', caption: 'has a termin' }, actor: 'agent:claude' });
  assert.ok(good.ok, `createPost (dated): ${JSON.stringify(good)}`);

  // ======================= the repair =======================
  // The exact shape of the two live launch-oss rows: explicit null, plus an omitted key.
  writeRawPost({ id: 'reddit-r-mcp', type: 'text', platforms: ['reddit'], scheduledAt: null, caption: 'legacy null', status: 'planned', approval: 'draft' });
  writeRawPost({ id: 'reddit-r-selfhosted', type: 'text', platforms: ['reddit'], caption: 'legacy missing key', status: 'planned', approval: 'draft' });

  ok(postById('reddit-r-mcp').scheduledAt === null, 'precondition: a dateless row exists on disk (createPost could not have made it)');

  const r1 = await backfillMissingSchedules({ now: NOW });
  ok(r1.repaired === 2, `backfill repaired both dateless posts (repaired=${r1.repaired})`);
  ok(r1.failed === 0, 'backfill reported no failures');
  ok(r1.scanned === 3, `backfill scanned every post in the plan (scanned=${r1.scanned})`);
  ok(r1.skipped === 1, `the already-dated post counted as skipped, not repaired (skipped=${r1.skipped})`);

  ok(postById('reddit-r-mcp').scheduledAt === EXPECTED, `the null Termin became now+3d (${postById('reddit-r-mcp').scheduledAt})`);
  ok(postById('reddit-r-selfhosted').scheduledAt === EXPECTED, 'the MISSING scheduledAt key also became now+3d');
  ok(postById('dated').scheduledAt === '2026-08-01T10:00:00Z', 'a post that already had a Termin is left EXACTLY as it was');

  // ======================= approval is untouched =======================
  // The repair gives a post a slot; it must never bless one. The distinct-human approval
  // fence is what keeps a repaired post from publishing on its own.
  ok(postById('reddit-r-mcp').approval === 'draft', 'the repair does NOT touch approval (a healed post still needs a human)');
  ok(postById('reddit-r-mcp').caption === 'legacy null', 'the repair touches scheduledAt ONLY, not content');

  // ======================= never silent =======================
  const acts = getActivity(50).filter((a) => a.action === 'schedule-backfill');
  ok(acts.length === 2, `every repair is recorded in the activity feed (${acts.length} entries)`);
  ok(acts.every((a) => a.ok === true), 'the backfill activity entries record success');
  ok(acts.some((a) => a.postId === 'reddit-r-mcp') && acts.some((a) => a.postId === 'reddit-r-selfhosted'), 'each repaired post is individually attributable');

  // ======================= idempotent =======================
  const r2 = await backfillMissingSchedules({ now: NOW + 999999 });
  ok(r2.repaired === 0, 'a second run repairs nothing - the invariant already holds');
  ok(postById('reddit-r-mcp').scheduledAt === EXPECTED, 'a second run does not re-stamp an already-repaired post');
  ok(getActivity(50).filter((a) => a.action === 'schedule-backfill').length === 2, 'a no-op run writes no activity noise');

  // ======================= dev:live is read-only =======================
  // The highest-risk edge. dev:live boots the SAME server.mjs; a scheduledAt is SCHEDULE
  // state, so the dev instance must never write one - the live daemon is the sole writer.
  // (bootCoverBackfill is deliberately unguarded: a cover is media, not schedule state.)
  writeRawPost({ id: 'dev-dateless', type: 'text', platforms: ['reddit'], scheduledAt: null, caption: 'must survive dev boot' });
  process.env.PENDPOST_DEV_READONLY = '1';
  await bootScheduleBackfill();
  ok(postById('dev-dateless').scheduledAt === null, 'PENDPOST_DEV_READONLY=1: bootScheduleBackfill writes NOTHING (dev never writes schedule state)');
  delete process.env.PENDPOST_DEV_READONLY;

  // ...and the live daemon still heals it.
  await bootScheduleBackfill();
  ok(typeof postById('dev-dateless').scheduledAt === 'string', 'with the guard off, the boot hook heals the same post');

  console.log(`\n${pass} assertions passed`);
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
