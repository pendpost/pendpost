#!/usr/bin/env node
// gbp-performance.test.mjs - the account-scoped insights sweep pass (spec 04,
// Pattern P5) run credential-free, no network.
//
// Proves, end-to-end through the REAL engine entrypoint + the REAL sweep:
//   1. the gbp `performance` verb returns ONE normalized account row
//      ({ postId:null, platform:'gbp', action:'performance', ok:true,
//      scope:'account', performance:{ calls, websiteClicks, directions, bookings,
//      conversations, impressions, searchKeywords:[{keyword,count}] } }).
//   2. an ungranted project degrades to { ok:false, error:'needs_scope',
//      scope:'business.manage' } (P9) - never a throw.
//   3. insights.mjs's GENERIC account pass stores the payload under
//      state.insights.account.gbp and exposes it on the getInsights() /
//      generateDigest() envelopes.
//   4. the account pass is GENERIC: a lane the sweep does not track (x here - it
//      is outside ENGINES/LANES, unlike linkedin which spec 07 gave a
//      demographics account verb) is simply skipped - no crash, no phantom entry.
//   5. the sweep degrades cleanly: an ungranted gbp performance row is filtered
//      out of the store (section omits), while the per-post pass is untouched.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

// PENDPOST_ROOT must be set BEFORE importing lib (util binds WORKSPACE_ROOT at
// import). PENDPOST_MODE=mock forces the credential-free driver.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-gbpperf-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_MOCK_UNGRANTED;

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
// A gbp-evidence campaign (a posted post carrying gbpPostId) + an x-only campaign
// (evidence for a lane the sweep does not even track - x ships its own insights
// verb but is absent from ENGINES/LANES/lanesWithEvidence - spec 07 gave linkedin
// its own demographics account verb, so x is the lane that keeps this generic
// skip real).
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({
  plans: [
    { id: 'local', path: 'data/plans/local.json', active: true },
    { id: 'x-only', path: 'data/plans/x-only.json', active: true },
  ],
}, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'plans', 'local.json'), JSON.stringify({
  campaign: 'local',
  posts: [{ id: 'g1', platforms: ['gbp'], status: 'posted', gbpPostId: 'accounts/1/locations/2/localPosts/xyz', scheduledAt: '2020-01-01T00:00:00Z', caption: 'Local shop update' }],
}, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'plans', 'x-only.json'), JSON.stringify({
  campaign: 'x-only',
  posts: [{ id: 'x1', platforms: ['x'], status: 'posted', xPostId: 'mock_x_123', scheduledAt: '2020-01-01T00:00:00Z', caption: 'A note' }],
}, null, 2));

function runEngine(args, extraEnv = {}) {
  const out = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'gbp-social.mjs'), ...args], {
    cwd: REPO,
    env: { ...process.env, PENDPOST_ROOT: WS, ...extraEnv },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const { fetchInsights, getInsights, generateDigest } = await import('../lib/insights.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');

const PERF_SCALARS = ['calls', 'websiteClicks', 'directions', 'bookings', 'conversations', 'impressions'];

try {
  // ---- 1. engine `performance` -> a normalized account row --------------------
  const perf = runEngine(['performance', '--plan', path.join(WS, 'data', 'plans', 'local.json'), '--json', '--actor', 'pendpost']);
  ok(perf.ok === true && Array.isArray(perf.results) && perf.results.length === 1, 'performance emits exactly one result row');
  const row = perf.results[0];
  ok(row.postId === null && row.platform === 'gbp' && row.action === 'performance' && row.ok === true && row.scope === 'account',
    'the row is the account-scoped shape { postId:null, platform:gbp, action:performance, ok:true, scope:account }');
  ok(row.performance && typeof row.performance === 'object', 'the row carries a performance payload object');
  ok(PERF_SCALARS.every((k) => typeof row.performance[k] === 'number'), 'every local-intent scalar is a number (calls/websiteClicks/directions/bookings/conversations/impressions)');
  ok(Array.isArray(row.performance.searchKeywords) && row.performance.searchKeywords.every((w) => typeof w.keyword === 'string' && typeof w.count === 'number'),
    'searchKeywords is a [{keyword,count}] list');

  // ---- 2. ungranted -> needs_scope (P9), never a throw -----------------------
  const ung = runEngine(['performance', '--plan', path.join(WS, 'data', 'plans', 'local.json'), '--json', '--actor', 'pendpost'], { PENDPOST_MOCK_UNGRANTED: 'gbp' });
  ok(ung.ok === false && ung.error === 'needs_scope' && ung.scope === 'business.manage', 'ungranted performance degrades to { ok:false, error:needs_scope, scope:business.manage }');

  // ---- 5. the SWEEP degrades cleanly when ungranted (run FIRST so a stale
  // granted payload never masks the absence) -----------------------------------
  process.env.PENDPOST_MOCK_UNGRANTED = 'gbp';
  const swU = await fetchInsights();
  ok(swU.ok, 'sweep (ungranted) returns ok');
  ok(!getInsights().account?.gbp, 'ungranted: no gbp account payload is stored (section omits, no false alarm)');
  ok(Boolean(loadState().insights?.data?.['local/g1/gbp']), 'ungranted degrade is ISOLATED: the per-post gbp insights row still stored');
  delete process.env.PENDPOST_MOCK_UNGRANTED;

  // ---- 3. the GENERIC account pass stores the payload + exposes it ------------
  const sw = await fetchInsights();
  ok(sw.ok, 'sweep (granted) returns ok');
  const env = getInsights();
  ok(env.account && typeof env.account === 'object', 'getInsights() carries an additive account map');
  const stored = env.account.gbp?.performance;
  ok(stored && PERF_SCALARS.every((k) => typeof stored[k] === 'number'), 'state.insights.account.gbp.performance holds the scalars on the envelope');
  ok(typeof env.account.gbp.fetchedAt === 'string', 'the stored account block carries a fetchedAt timestamp (metrics churn - lives in state, never a plan file)');
  ok(Array.isArray(stored.searchKeywords) && stored.searchKeywords.length > 0, 'the stored payload keeps the search keywords');
  ok(Boolean(loadState().insights?.account?.gbp?.performance), 'the payload is persisted under state.insights.account.gbp (sibling of .data)');

  // ---- 4. GENERIC: a lane the sweep does not track is skipped, no crash -------
  ok(!('x' in env.account), 'a lane outside ENGINES/LANES (x) is simply skipped - no phantom account entry, no crash');

  // ---- 6. merge-on-write: a pre-existing sibling payload (what spec 07 adds as
  // .demographics on the SAME lane) survives the account pass adding .performance.
  // Locks the { ...existing, ...payload } store contract 07 depends on -----------
  const st = loadState();
  st.insights = st.insights || {};
  st.insights.account = st.insights.account || {};
  st.insights.account.gbp = { demographics: { audienceAgeRanges: { '25-34': 61 } }, fetchedAt: '2020-01-01T00:00:00.000Z' };
  saveState();
  await fetchInsights();
  const merged = getInsights().account.gbp;
  ok(merged.demographics && merged.demographics.audienceAgeRanges['25-34'] === 61, 'merge: a pre-existing sibling payload (07 demographics) is PRESERVED across a sweep, not clobbered');
  ok(merged.performance && typeof merged.performance.calls === 'number', 'merge: the account pass ADDS performance to the same lane alongside demographics');

  // ---- digest surfaces the Local performance section -------------------------
  const digest = generateDigest({ locale: 'en' });
  ok(digest.ok && digest.account && digest.account.gbp, 'generateDigest() carries the additive account field');
  ok(/## Local performance/.test(digest.digest) && /Calls:/.test(digest.digest), 'the digest renders the Local performance section with the metric rows');
  const de = generateDigest({ locale: 'de-CH' });
  ok(/## Lokale Aktionen/.test(de.digest) && /Anrufe:/.test(de.digest), 'de-CH digest renders the localized Local performance section');
  ok(!/ß/.test(de.digest), 'de-CH digest stays eszett-free');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[gbp-performance] OK - account row shape, needs_scope degrade, generic account-pass store + envelope, lane-skip, digest section (${pass} assertions).`);
} catch (err) {
  console.error(`[gbp-performance] FAIL - ${err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
