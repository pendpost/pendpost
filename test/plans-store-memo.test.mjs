#!/usr/bin/env node
// test/plans-store-memo.test.mjs - the plan-store walk must stay cheap on repeat.
//
// Incident 2026-10-13 (~19:00Z): the live daemon stopped answering every request,
// /api/health included, for minutes. Every read surface walks the WHOLE store through
// loadPlanStore, and each walk redid every post's file work (existsSync + statSync per
// media ref, a sha1 over the raw post, path math): 30-150 ms of synchronous work per walk.
// A burst of reads queued on the one event loop and saturated it. lib/plans.mjs now
// memoizes each plan file's post views; this test pins that:
//
//   (a) a WARM walk does no per-post file work: counted on node:fs and node:crypto
//       directly, so it is implementation-neutral (the pre-fix walk made 600+ fs calls
//       and 300 sha1s per walk of this store and fails here),
//   (b) a warm walk of 300 posts stays far under the 100 ms loop budget,
//   (c) everything the memo keys on invalidates it at once: an atomic plan rewrite, an
//       in-place plan rewrite, a media file landing or vanishing, a cover sibling, a
//       probe-cache change (but NOT an unrelated state save), the client scope, the age cap,
//   (d) the clock- and state-dependent fields (derivedState, lastFailure) stay LIVE on a
//       cache hit, so the scheduler sees exactly what it saw before,
//   (f) getPosting (on nearly every read path) is memoized by config.json's stat, hands
//       each caller its own deep copy, and never memoizes a failed read as the defaults,
//   (e) a caller mutating a returned post cannot leak into the next walk.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-plan-memo-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const PLANS = path.join(WS, 'data', 'plans');
const MEDIA = path.join(WS, 'data', 'media');
const PLAN_REL = 'data/plans/memo/post-plan.json';
const PLAN_ABS = path.join(WS, PLAN_REL);
fs.mkdirSync(path.dirname(PLAN_ABS), { recursive: true });
fs.mkdirSync(MEDIA, { recursive: true });
fs.writeFileSync(path.join(PLANS, 'active-plans.json'), JSON.stringify({ plans: [{ id: 'memo', path: PLAN_REL, active: true }] }, null, 2));
// overdueGraceSeconds 0 so a post flips to overdue the moment it is past due (part d).
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ overdueGraceSeconds: 0 }, null, 2));

const N = 300;
const T0 = Date.now();
function makePlan(captionOf = (i) => `post ${i}`) {
  const posts = [];
  for (let i = 0; i < N; i += 1) {
    posts.push({
      id: `p${i}`,
      type: 'reel',
      platforms: ['linkedin'],
      scheduledAt: new Date(T0 + 3600_000 + i * 60_000).toISOString(),
      caption: captionOf(i),
      path: `data/media/clip-${i}.mp4`,
      approval: 'approved',
      approvalBy: 'owner',
      approvalAt: new Date(T0 - 3600_000).toISOString(),
    });
  }
  // p0 is the clock probe for part (d): due 1.5 s from now, so a few seconds of fake clock
  // (well inside the memo's age cap) carries it past due without touching any file.
  posts[0].scheduledAt = new Date(T0 + 1500).toISOString();
  return { campaign: 'memo', timezone: 'UTC', posts };
}
function writePlanAtomic(plan) {
  const tmp = `${PLAN_ABS}.tmp-test`;
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2));
  fs.renameSync(tmp, PLAN_ABS);
}
writePlanAtomic(makePlan());
// Half the media exists, so the walk exercises both the hit and the miss branches.
for (let i = 0; i < N; i += 2) fs.writeFileSync(path.join(MEDIA, `clip-${i}.mp4`), 'x');

const plans = await import('../lib/plans.mjs');
const { loadPlanStore, findCampaign, normalizePost } = plans;
const { loadState, saveState, markProbeCacheChanged } = await import('../lib/state.mjs');
const { getPosting } = await import('../lib/config.mjs');
const { withClient } = await import('../lib/context.mjs');

const postOf = (id, store = loadPlanStore()) => store.campaigns[0].posts.find((p) => p.id === id);

// ---- counters on the shared module objects plans.mjs calls through ----
const counts = { existsSync: 0, statSync: 0, createHash: 0 };
const real = { existsSync: fs.existsSync, statSync: fs.statSync, createHash: crypto.createHash };
fs.existsSync = (...a) => { counts.existsSync += 1; return real.existsSync(...a); };
fs.statSync = (...a) => { counts.statSync += 1; return real.statSync(...a); };
crypto.createHash = (...a) => { counts.createHash += 1; return real.createHash(...a); };
const resetCounts = () => { counts.existsSync = 0; counts.statSync = 0; counts.createHash = 0; };

// ---- (a) warm walks do no per-post file work -------------------------------------
const cold = loadPlanStore();
ok(cold.campaigns[0].posts.length === N, `the cold walk returns all ${N} posts`);
ok(cold.campaigns[0].posts.filter((p) => p.media?.exists).length === N / 2, 'the cold walk resolves media existence per post');
resetCounts();
const WALKS = 20;
for (let i = 0; i < WALKS; i += 1) loadPlanStore();
findCampaign('memo'); // the one-post lookup (plan_get, the comments panel) is a full walk too
const perWalkFs = (counts.existsSync + counts.statSync) / (WALKS + 1);
ok(perWalkFs < 10, `a warm walk makes a handful of fs calls, not one per post (${perWalkFs.toFixed(1)} per walk over ${N} posts)`);
ok(counts.createHash === 0, `a warm walk hashes nothing (${counts.createHash} createHash calls over ${WALKS + 1} walks)`);

// ---- (b) a warm walk stays far under the loop budget ------------------------------
const times = [];
for (let i = 0; i < 15; i += 1) {
  const t = performance.now();
  loadPlanStore();
  times.push(performance.now() - t);
}
times.sort((x, y) => x - y);
ok(times[7] < 25, `a warm walk of ${N} posts takes well under 100 ms (median ${times[7].toFixed(2)} ms)`);

// ---- (c) invalidation: everything the memo keys on -------------------------------
let builds = plans.planStoreStats().viewBuilds;
const rebuilt = (msg) => {
  const now = plans.planStoreStats().viewBuilds;
  ok(now > builds, msg);
  builds = now;
};

writePlanAtomic(makePlan((i) => (i === 7 ? 'edited by the engine' : `post ${i}`)));
ok(postOf('p7').caption === 'edited by the engine', 'an atomic plan rewrite is visible on the very next walk');
rebuilt('... and it rebuilt the views');

// An in-place rewrite of the SAME length keeps the inode and the size: only mtime moves.
const before = fs.readFileSync(PLAN_ABS, 'utf8');
const after = before.replace('edited by the engine', 'edited by the OWNER!');
assert.strictEqual(after.length, before.length);
fs.writeFileSync(PLAN_ABS, after);
const future = new Date(Date.now() + 5000);
fs.utimesSync(PLAN_ABS, future, future); // never rely on mtime granularity in a test
ok(postOf('p7').caption === 'edited by the OWNER!', 'an in-place, same-size plan rewrite is visible on the next walk');
rebuilt('... and it rebuilt the views');

ok(postOf('p1').media.exists === false, 'p1 starts without its media');
fs.writeFileSync(path.join(MEDIA, 'clip-1.mp4'), 'x');
ok(postOf('p1').media.exists === true, 'a media file landing in the media dir is seen on the next walk');
rebuilt('... and it rebuilt the views');

fs.writeFileSync(path.join(MEDIA, 'clip-1.jpg'), 'jpg');
ok(Boolean(postOf('p1').media.cover), 'a render-sibling cover landing is seen on the next walk');
rebuilt('... and it rebuilt the views');

fs.rmSync(path.join(MEDIA, 'clip-2.mp4'));
ok(postOf('p2').media.exists === false, 'a media file vanishing is seen on the next walk');
rebuilt('... and it rebuilt the views');

loadPlanStore();
ok(plans.planStoreStats().viewBuilds === builds, 'an unchanged store is a cache hit (control)');
saveState();
loadPlanStore();
ok(plans.planStoreStats().viewBuilds === builds, 'a plain state save (a comment read accreting engagers) keeps the views');
markProbeCacheChanged();
loadPlanStore();
rebuilt('a probe-cache change (lib/assets.mjs scanAssets) rebuilds the views');

const unscoped = postOf('p0').media.url;
const scoped = withClient(WS, () => postOf('p0').media.url);
ok(!/clientId=/.test(unscoped) && /clientId=/.test(scoped), 'the client scope is part of the key: a bound walk never reuses an unbound media url, nor the reverse');
ok(!/clientId=/.test(postOf('p0').media.url), '... and the unbound walk is still unscoped afterwards');

// ---- (d) live fields on a cache hit ----------------------------------------------
const realNow = Date.now;
try {
  // The fake clock is pinned to p0's own due time, never to wall time, so a slow run (a loaded
  // box) cannot carry p0 past due before the first read. One forced rebuild AT the fake clock
  // anchors the memo's age there, so the +3 s step below is a cache hit by construction.
  const base = Date.parse(postOf('p0').scheduledAt) - 1000;
  Date.now = () => base;
  plans.clearPlanStoreCache();
  const stateBefore = postOf('p0').derivedState;
  const hitBuilds = plans.planStoreStats().viewBuilds;
  Date.now = () => base + 3000; // < PLAN_VIEW_TTL_MS: the views are reused
  const p0 = postOf('p0');
  ok(plans.planStoreStats().viewBuilds === hitBuilds, 'a few seconds later the views are still a cache hit');
  const raw = JSON.parse(fs.readFileSync(PLAN_ABS, 'utf8'));
  const expected = normalizePost({ id: 'memo', path: PLAN_REL }, raw, raw.posts[0], base + 3000).derivedState;
  ok(stateBefore !== expected && p0.derivedState === expected, `derivedState follows the clock on a cache hit (${stateBefore} -> ${p0.derivedState})`);

  ok(postOf('p3').lastFailure === null, 'p3 has no failure yet');
  const st = loadState();
  st.activity = [{ ts: new Date(base + 1000).toISOString(), action: 'publish', campaign: 'memo', postId: 'p3', platform: 'linkedin', ok: false, errorMessage: 'token expired' }, ...(st.activity || [])];
  // Deliberately NO saveState: the in-memory feed is what the scheduler and the read model share.
  const p3 = postOf('p3');
  ok(p3.lastFailure && p3.lastFailure.message === 'token expired', 'lastFailure reads the live activity feed on a cache hit');
  ok(plans.planStoreStats().viewBuilds === hitBuilds, '... still without a rebuild');

  Date.now = () => base + plans.PLAN_VIEW_TTL_MS + 1000;
  loadPlanStore();
  ok(plans.planStoreStats().viewBuilds > hitBuilds, 'past the age cap the views are rebuilt (in-place media rewrites heal)');
} finally {
  Date.now = realNow;
}

// ---- (h) a slow walk does not expire its own views -----------------------------------
// Incident 2026-10-24: under memory pressure (GBs of swap) one cold walk took longer than
// PLAN_VIEW_TTL_MS. The views were stamped with the walk's START time, so they were already
// past the age cap when the walk returned, and the very next walk rebuilt everything again:
// every walk cold, forever, and the daemon's event loop never came up for air. The age is
// counted from when a view was BUILT.
try {
  const base = realNow();
  let first = true;
  // The walk reads the clock once at its start (base); every later read, including the
  // moment each view finishes building, lands past the age cap: a walk slower than the TTL.
  Date.now = () => { if (first) { first = false; return base; } return base + plans.PLAN_VIEW_TTL_MS + 1000; };
  plans.clearPlanStoreCache();
  loadPlanStore();
  const slowBuilds = plans.planStoreStats().viewBuilds;
  Date.now = () => base + plans.PLAN_VIEW_TTL_MS + 1500;
  loadPlanStore();
  ok(plans.planStoreStats().viewBuilds === slowBuilds, 'the walk right after a slow (> TTL) walk is a cache hit, not another cold rebuild');
} finally {
  Date.now = realNow;
}

// ---- (f) the posting config is memoized by its stat, one deep copy per caller --------
resetCounts();
const cfgA = getPosting();
cfgA.overdueGraceSeconds = 999;
cfgA.review.required = true;
const cfgB = getPosting();
ok(cfgB.overdueGraceSeconds === 0 && cfgB.review.required !== true, 'getPosting hands every caller its own copy: an edit never leaks into the next read');
const cfgPath = path.join(WS, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ overdueGraceSeconds: 7 }, null, 2));
const later = new Date(Date.now() + 10_000);
fs.utimesSync(cfgPath, later, later);
ok(getPosting().overdueGraceSeconds === 7, 'a config.json edit is seen on the next read');
// A transient read failure (EMFILE under a burst: stat needs no fd, open does) must NOT be
// memoized as the defaults, or e.g. review.required=false (the client sign-off fence) would
// stick until the next config write: fail-OPEN. Critic round 2, MEDIUM-1.
fs.writeFileSync(cfgPath, JSON.stringify({ overdueGraceSeconds: 300, review: { required: true } }, null, 2));
const later2 = new Date(Date.now() + 20_000);
fs.utimesSync(cfgPath, later2, later2);
const realRead = fs.readFileSync;
let failing = true; // every config read fails while the burst lasts
fs.readFileSync = (f, ...rest) => {
  if (failing && String(f) === cfgPath) { throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }); }
  return realRead(f, ...rest);
};
try {
  const during = getPosting();
  ok(during.review.required !== true, 'a failed config read serves the defaults for that one read (unchanged behavior)');
  failing = false;
  const next = getPosting();
  ok(next.review.required === true && next.overdueGraceSeconds === 300, 'the very next read re-reads the real config: a transient failure is never memoized (sign-off fence stays closed)');
} finally {
  fs.readFileSync = realRead;
}
fs.writeFileSync(cfgPath, JSON.stringify({ overdueGraceSeconds: 0 }, null, 2));

// ---- (e) a caller's mutation cannot leak into the next walk -------------------------
const mutated = postOf('p5');
mutated.caption = 'mutated by a caller';
mutated.derivedState = 'bogus';
ok(postOf('p5').caption === 'post 5' && postOf('p5').derivedState !== 'bogus', 'mutating a returned post leaves the next walk untouched');

// ---- (g) a plan the manifest no longer lists leaves the memo ------------------------
loadPlanStore();
const cachedBefore = plans.planStoreStats().cachedPlans;
fs.writeFileSync(path.join(PLANS, 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
ok(loadPlanStore().campaigns.length === 0, 'a campaign removed from the manifest is gone from the walk');
ok(plans.planStoreStats().cachedPlans < cachedBefore, `... and its parsed plan is evicted from the memo (${cachedBefore} -> ${plans.planStoreStats().cachedPlans})`);

fs.existsSync = real.existsSync;
fs.statSync = real.statSync;
crypto.createHash = real.createHash;
fs.rmSync(WS, { recursive: true, force: true });
console.log(`\nplans-store-memo: ${pass} checks passed`);
