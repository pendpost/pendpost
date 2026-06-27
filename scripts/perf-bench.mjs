#!/usr/bin/env node
// scripts/perf-bench.mjs - INFORMATIONAL performance bench (NFR-PERF-01/02).
//
// NOT part of `npm run check` - this is a manual tool. It seeds ~4000 posts in a
// single campaign in a throwaway temp PENDPOST_ROOT, then measures the p95 of
// the three hot operations the JSON model rewrites whole files for:
//   - plan_get        (read: parse one plan file + normalize every post)
//   - plan_update_post (write: read-mutate-write the whole plan file under lock)
//   - appendActivity  (write: prepend + slice + rewrite the whole state.json)
//
// It then prints a one-line verdict: whether the run crosses the documented
// JSON->SQLite migration threshold (NFR-PERF-02: p95 > 100ms, or a single
// post-plan.json > 5 MB on disk). Crossing the line is a SIGNAL to move that
// client to node:sqlite, not an automatic action - this tool never migrates.
//
// Run: node scripts/perf-bench.mjs [posts]   (default 4000)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const POSTS = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 4000;
const P95_THRESHOLD_MS = 100; // NFR-PERF-02 latency trigger
const PLAN_SIZE_THRESHOLD = 5 * 1024 * 1024; // NFR-PERF-02 file-size trigger (5 MB)
const STATE_SIZE_NOTE = 5 * 1024 * 1024; // informational state.json size note

// A throwaway workspace - set BEFORE importing lib (util binds WORKSPACE_ROOT at
// import). No clients.json -> the legacy single-workspace fallback, so the bench
// measures the plain JSON model directly.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-perf-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;

const CAMP = 'bench';
const plansDir = path.join(WS, 'data', 'plans');
const campDir = path.join(plansDir, CAMP);
const planFile = path.join(campDir, 'post-plan.json');
fs.mkdirSync(campDir, { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });

// Seed ~POSTS text posts in one plan file (text posts need no media render, so
// the read path normalizes cleanly). Direct write is the fast seed; the measured
// ops below all go through the REAL lib read/write paths.
const seeded = [];
for (let i = 0; i < POSTS; i += 1) {
  seeded.push({
    id: `p${i}`,
    type: 'text',
    platforms: ['linkedin'],
    scheduledAt: new Date(Date.now() + i * 60000).toISOString(),
    caption: `bench post number ${i} - a plain caption with enough text to be realistic for sizing the whole-file rewrite cost of the JSON model`,
    createdBy: 'bench',
    approval: 'draft',
  });
}
fs.writeFileSync(planFile, `${JSON.stringify({ campaign: CAMP, timezone: 'UTC', posts: seeded }, null, 2)}\n`);
fs.writeFileSync(
  path.join(plansDir, 'active-plans.json'),
  `${JSON.stringify({ plans: [{ id: CAMP, path: path.relative(WS, planFile), active: true }] }, null, 2)}\n`,
);

const { findCampaign, postRev } = await import('../lib/plans.mjs');
const { updatePost } = await import('../lib/writes.mjs');
const { appendActivity } = await import('../lib/scheduler.mjs');

function p95(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}
function fmt(ms) { return `${ms.toFixed(2)}ms`; }
async function timeit(label, iterations, fn) {
  // One warm-up so first-call JIT/IO cost does not skew the p95.
  await fn(0);
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = process.hrtime.bigint();
    // eslint-disable-next-line no-await-in-loop
    await fn(i + 1);
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6);
  }
  const v = p95(samples);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  console.log(`  ${label.padEnd(18)} n=${String(iterations).padStart(4)}  p95=${fmt(v).padStart(10)}  mean=${fmt(mean).padStart(10)}`);
  return v;
}

try {
  const planBytes = fs.statSync(planFile).size;
  console.log(`pendpost perf-bench (informational, NOT a CI gate)`);
  console.log(`  seeded ${POSTS} posts in one campaign; post-plan.json = ${(planBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log('');

  // plan_get: the read path plan_get uses (findCampaign -> loadPlanStore ->
  // normalize every post). Read-only, so no file churn between samples.
  const ITER = 50;
  const p95Get = await timeit('plan_get', ITER, () => {
    const { campaign } = findCampaign(CAMP);
    if (!campaign) throw new Error('bench campaign vanished');
    return campaign;
  });

  // plan_update_post: read-mutate-write the whole plan file under lock. Echo the
  // live rev each time (optimistic concurrency) and flip the caption.
  const p95Update = await timeit('plan_update_post', ITER, async (i) => {
    const { campaign } = findCampaign(CAMP);
    const target = campaign.posts[0];
    const res = await updatePost({ campaign: CAMP, postId: target.id, ifRev: target.rev, fields: { caption: `bench edit ${i} ${target.caption}`.slice(0, 600) }, actor: 'bench' });
    if (res.code) throw new Error(`plan_update_post failed: ${JSON.stringify(res)}`);
    return res;
  });

  // appendActivity: prepend + slice(500) + rewrite the whole state.json.
  const p95Append = await timeit('appendActivity', ITER, (i) => {
    appendActivity({ campaign: CAMP, postId: 'p0', platform: 'linkedin', action: 'bench', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: 'bench', seq: i });
  });

  const stateFile = path.join(WS, 'state.json');
  const stateBytes = fs.existsSync(stateFile) ? fs.statSync(stateFile).size : 0;

  console.log('');
  // NFR-PERF-02 verdict: whichever trigger fires first.
  const worstP95 = Math.max(p95Get, p95Update, p95Append);
  const crossLatency = worstP95 > P95_THRESHOLD_MS;
  const crossSize = planBytes > PLAN_SIZE_THRESHOLD;
  if (crossLatency || crossSize) {
    const reasons = [];
    if (crossLatency) reasons.push(`p95 ${fmt(worstP95)} > ${P95_THRESHOLD_MS}ms`);
    if (crossSize) reasons.push(`post-plan.json ${(planBytes / 1024 / 1024).toFixed(2)} MB > 5 MB`);
    console.log(`VERDICT: this client CROSSES the NFR-PERF-02 JSON->SQLite threshold (${reasons.join('; ')}) - consider moving it to node:sqlite.`);
  } else {
    console.log(`VERDICT: under the NFR-PERF-02 threshold (worst p95 ${fmt(worstP95)} <= ${P95_THRESHOLD_MS}ms, post-plan.json ${(planBytes / 1024 / 1024).toFixed(2)} MB <= 5 MB) - the JSON model is fine here.`);
  }
  if (stateBytes > STATE_SIZE_NOTE) {
    console.log(`NOTE: state.json is ${(stateBytes / 1024 / 1024).toFixed(2)} MB (> 5 MB) - the activity/insight caps should keep it small; investigate if it grows.`);
  }
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
