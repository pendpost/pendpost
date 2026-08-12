// mark-posted-lane.test.mjs (ux-audit 2026-08-04, dim-1 G4/L4) - lane-scoped manual
// completion. mark_posted was post-scoped only: on a mixed multi-lane post, marking it
// posted closed ALL lanes, including ones pendpost still owed. The optional `platform`
// param records manual completion (+ optional externalUrl) for THAT lane only, aligned
// with deriveState's per-platform evidence walk (plans.mjs platformPending) and the
// scheduler's lanesOwed, so a manually completed lane stops being owed without
// closing its siblings. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-mark-lane-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });

const planRel = 'data/plans/lane-plan.json';
const past = new Date(Date.now() - 3600_000).toISOString();
const plan = { id: 'lane-camp', campaign: 'lane-camp', posts: [
  // The mixed post under test: two allow-by-default lanes, nothing minted yet.
  { id: 'mixed-1', type: 'text', platforms: ['reddit', 'telegram'], status: 'planned', approval: 'approved', scheduledAt: past, caption: 'hello' },
  // Mixed post where one lane already carries REAL publish evidence (tg fired, reddit owed).
  { id: 'mixed-2', type: 'text', platforms: ['reddit', 'telegram'], status: 'planned', approval: 'approved', scheduledAt: past, caption: 'hello', tgMessageId: '555' },
  // Single-lane post: the post-scoped path must be byte-compatible with before.
  { id: 'single-1', type: 'text', platforms: ['telegram'], status: 'planned', approval: 'approved', scheduledAt: past, caption: 'hello' },
] };
fs.writeFileSync(path.join(WS, planRel), JSON.stringify(plan, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [{ id: 'lane-camp', path: planRel, active: true }] }, null, 2));
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({}));

const readPlan = () => JSON.parse(fs.readFileSync(path.join(WS, planRel), 'utf8'));

try {
  const { markPosted } = await import('../lib/writes.mjs');
  const { loadPlanStore, PLATFORM_ID_FIELDS } = await import('../lib/plans.mjs');
  const { lanesOwed } = await import('../lib/scheduler.mjs');

  // --- validation ---------------------------------------------------------------
  const bad = await markPosted({ campaign: 'lane-camp', postId: 'mixed-1', actor: 'owner', platform: 'x' });
  ok(bad.code === 'invalid_input', 'a platform the post does not target is refused');
  const badName = await markPosted({ campaign: 'lane-camp', postId: 'mixed-1', actor: 'owner', platform: 'myspace' });
  ok(badName.code === 'invalid_input', 'an unknown platform name is refused');

  // --- lane-scoped mark leaves the sibling lane open ------------------------------
  const r1 = await markPosted({ campaign: 'lane-camp', postId: 'mixed-1', actor: 'owner', platform: 'reddit', externalUrl: 'https://reddit.com/r/x/abc' });
  ok(r1.ok === true, 'lane-scoped mark succeeds');
  ok(r1.platform === 'reddit', 'response names the lane it recorded');
  ok(Array.isArray(r1.pendingPlatforms) && r1.pendingPlatforms.length === 1 && r1.pendingPlatforms[0] === 'telegram', 'response reports the still-pending sibling lane');
  let p = readPlan().posts.find((x) => x.id === 'mixed-1');
  ok(p.status === 'planned', 'the post stays open while a sibling lane is still owed');
  ok(p.manualCompletions && p.manualCompletions.reddit && p.manualCompletions.reddit.at, 'the lane marker is recorded with a timestamp');
  ok(p.manualCompletions.reddit.externalUrl === 'https://reddit.com/r/x/abc', 'the lane marker carries its own externalUrl');
  ok(!p.externalUrl, 'the post-level externalUrl is untouched by a lane-scoped mark');

  // --- the pending predicate + the scheduler respect the marker --------------------
  let { campaigns } = loadPlanStore();
  let norm = campaigns.find((c) => c.id === 'lane-camp').posts.find((x) => x.id === 'mixed-1');
  ok(norm.manualCompletions && norm.manualCompletions.reddit, 'normalizePost surfaces manualCompletions (write/read parity)');
  let owed = lanesOwed(norm);
  ok(!owed.includes('reddit'), 'lanesOwed no longer owes the manually completed lane');
  ok(owed.includes('telegram'), 'lanesOwed still owes the untouched sibling lane');

  // --- double-mark refused, url correction allowed ---------------------------------
  const dup = await markPosted({ campaign: 'lane-camp', postId: 'mixed-1', actor: 'owner', platform: 'reddit' });
  ok(dup.code === 'invalid_input', 'marking the same lane twice without a url is refused');
  const fix = await markPosted({ campaign: 'lane-camp', postId: 'mixed-1', actor: 'owner', platform: 'reddit', externalUrl: 'https://reddit.com/r/x/fixed' });
  ok(fix.ok === true, 'the one legal re-entry: correcting the lane url');
  p = readPlan().posts.find((x) => x.id === 'mixed-1');
  ok(p.manualCompletions.reddit.externalUrl === 'https://reddit.com/r/x/fixed', 'the lane url was corrected in place');

  // --- marking the LAST open lane closes the post ----------------------------------
  const r2 = await markPosted({ campaign: 'lane-camp', postId: 'mixed-1', actor: 'owner', platform: 'telegram' });
  ok(r2.ok === true && r2.post.status === 'posted', 'marking the last open lane closes the post');
  p = readPlan().posts.find((x) => x.id === 'mixed-1');
  ok(p.status === 'posted' && p.postedAt, 'storage: status posted + postedAt stamped');
  ok(p.publishedVia === 'manual', 'all-manual evidence -> publishedVia manual');

  // --- a lane with REAL publish evidence refuses a manual marker --------------------
  const minted = await markPosted({ campaign: 'lane-camp', postId: 'mixed-2', actor: 'owner', platform: 'telegram' });
  ok(minted.code === 'invalid_input', 'a lane that already minted its platform id is refused');
  const r3 = await markPosted({ campaign: 'lane-camp', postId: 'mixed-2', actor: 'owner', platform: 'reddit' });
  ok(r3.ok === true && r3.post.status === 'posted', 'manual reddit + minted telegram = all evidence in, post closes');
  p = readPlan().posts.find((x) => x.id === 'mixed-2');
  ok(!p.publishedVia, 'mixed engine+manual evidence -> publishedVia stays unset (honest)');

  // --- lane-scoped url re-entry works on the closed post ----------------------------
  const late = await markPosted({ campaign: 'lane-camp', postId: 'mixed-2', actor: 'owner', platform: 'reddit', externalUrl: 'https://reddit.com/r/x/late' });
  ok(late.ok === true, 'a posted post still accepts a lane url correction');
  p = readPlan().posts.find((x) => x.id === 'mixed-2');
  ok(p.manualCompletions.reddit.externalUrl === 'https://reddit.com/r/x/late', 'the late lane url landed');

  // --- the post-scoped path is unchanged --------------------------------------------
  const whole = await markPosted({ campaign: 'lane-camp', postId: 'single-1', actor: 'owner', externalUrl: 'https://t.me/c/1' });
  ok(whole.ok === true && whole.post.status === 'posted' && whole.post.publishedVia === 'manual', 'post-scoped mark still closes the whole post');
  p = readPlan().posts.find((x) => x.id === 'single-1');
  ok(p.externalUrl === 'https://t.me/c/1' && !p.manualCompletions, 'post-scoped mark writes the post-level url, no lane markers');

  // sanity: every lane the registry knows is a valid platform param target
  ok(PLATFORM_ID_FIELDS.reddit && PLATFORM_ID_FIELDS.telegram, 'PLATFORM_ID_FIELDS registry covers the tested lanes');
} catch (err) {
  failures += 1;
  console.error('  FAIL - threw:', err && err.stack || err);
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
