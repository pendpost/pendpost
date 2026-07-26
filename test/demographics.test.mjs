#!/usr/bin/env node
// test/demographics.test.mjs - spec 07 (audience demographics), Pattern P5, the
// SAME account-scoped seam gbp-performance.test.mjs proves for spec 04, run
// credential-free through the REAL engine entrypoints + the REAL sweep.
//
// Proves, end-to-end:
//   1. each covered lane's `demographics` verb (meta/youtube/linkedin/pinterest)
//      returns ONE normalized account row ({ postId:null, platform, action:
//      'demographics', ok:true, scope:'account', demographics:{...} }) with the
//      lane-appropriate structured breakdown (age/gender/geo for meta/pinterest,
//      age/gender for youtube, seniority/function/industry/region for linkedin).
//   2. an ungranted lane degrades to { ok:false, error:'needs_scope', scope:'...' }
//      (P9) with the EXACT scope string the live engine would name - never a throw.
//   3. the GENERIC account pass (spec 04) stores each payload under
//      state.insights.account[lane].demographics and exposes it on getInsights()/
//      generateDigest().
//   4. pinterest, newly wired into the sweep (spec 07), also gets its regular
//      per-post `insights` row - proof the ENGINES/LANES/lanesWithEvidence wiring
//      is real, not just the account pass.
//   5. tiktok is a documented no-op: a tiktok-only campaign is never spawned (no
//      ENGINES entry, no crash, no phantom account row).
//   6. merge-on-write: a pre-existing sibling field on the SAME lane (whatever
//      key another verb wrote) survives the demographics account pass adding
//      .demographics - the account store is a generic per-lane MAP, so 07 is the
//      first spec proving demographics is a well-behaved co-tenant, not just a
//      lone occupant.
//   7. the digest renders an Audience section (en + de-CH, ß-free).
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

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-demographics-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_MOCK_UNGRANTED;

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
// One evidence campaign covering every demographics-carrying lane + a tiktok-only
// campaign (evidence for a lane with NO account verb - and not even in ENGINES).
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({
  plans: [
    { id: 'local', path: 'data/plans/local.json', active: true },
    { id: 'tiktok-only', path: 'data/plans/tiktok-only.json', active: true },
  ],
}, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'plans', 'local.json'), JSON.stringify({
  campaign: 'local',
  posts: [
    { id: 'm1', platforms: ['instagram'], status: 'posted', igMediaId: 'mock_ig_1', scheduledAt: '2020-01-01T00:00:00Z', caption: 'IG post' },
    { id: 'y1', platforms: ['youtube'], status: 'posted', ytVideoId: 'mockYtVideo1', scheduledAt: '2020-01-01T00:00:00Z', caption: 'YT post' },
    { id: 'l1', platforms: ['linkedin'], status: 'posted', liPostId: 'urn:li:share:123', scheduledAt: '2020-01-01T00:00:00Z', caption: 'LI post' },
    { id: 'p1', platforms: ['pinterest'], status: 'posted', pinId: 'mock_pin_1', scheduledAt: '2020-01-01T00:00:00Z', caption: 'Pin post' },
  ],
}, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'plans', 'tiktok-only.json'), JSON.stringify({
  campaign: 'tiktok-only',
  posts: [{ id: 't1', platforms: ['tiktok'], status: 'posted', tiktokVideoId: 'mock_tt_1', scheduledAt: '2020-01-01T00:00:00Z', caption: 'TikTok post' }],
}, null, 2));

function runEngine(script, args, extraEnv = {}) {
  const out = execFileSync(process.execPath, [path.join(REPO, 'scripts', script), ...args], {
    cwd: REPO,
    env: { ...process.env, PENDPOST_ROOT: WS, ...extraEnv },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const { fetchInsights, getInsights, generateDigest } = await import('../lib/insights.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
// Pure parser (import is safe - the engine guards main() behind a direct-exec check).
const { parsePinterestDemographics } = await import('../scripts/pinterest-social.mjs');

// lane -> [engine script, plan-file arg, expected structured categories, expected needs_scope scope]
const LANES = {
  meta: { script: 'meta-social.mjs', categories: ['age', 'gender', 'country', 'city'], scope: 'instagram_business_manage_insights' },
  youtube: { script: 'yt-social.mjs', categories: ['age', 'gender'], scope: 'yt-analytics.readonly' },
  linkedin: { script: 'linkedin-social.mjs', categories: ['seniority', 'function', 'industry', 'region'], scope: 'rw_organization_admin' },
  pinterest: { script: 'pinterest-social.mjs', categories: ['age', 'gender', 'region'], scope: 'ads:read' },
};

try {
  // ---- 0. pinterest parser hardening: an array-shaped or dirty audience_insights
  // payload yields empty/omitted buckets, NEVER fabricated '0'/'1' index rows -----
  const arrShaped = parsePinterestDemographics({ age: ['x', 'y'], gender: { female: '55', male: 'nope' }, region: 42 });
  ok(Object.keys(arrShaped.age).length === 0, 'pinterest parser: an ARRAY-shaped category yields an EMPTY bucket, not garbage {0:..,1:..} rows');
  ok(arrShaped.gender.female === 55 && !('male' in arrShaped.gender), 'pinterest parser: non-finite values are dropped, finite string numbers are coerced');
  ok(Object.keys(arrShaped.region).length === 0, 'pinterest parser: a non-object (number) category yields an EMPTY bucket');
  ok(Object.keys(parsePinterestDemographics({}).age).length === 0, 'pinterest parser: a missing category yields an EMPTY bucket (no throw)');

  // ---- 1. each lane's engine `demographics` verb -> one normalized account row --
  for (const [lane, def] of Object.entries(LANES)) {
    const res = runEngine(def.script, ['demographics', '--plan', path.join(WS, 'data', 'plans', 'local.json'), '--json', '--actor', 'pendpost']);
    ok(res.ok === true && Array.isArray(res.results) && res.results.length === 1, `${lane}: demographics emits exactly one result row`);
    const row = res.results[0];
    ok(row.postId === null && row.platform === lane && row.action === 'demographics' && row.ok === true && row.scope === 'account',
      `${lane}: the row is the account-scoped shape { postId:null, platform:${lane}, action:demographics, ok:true, scope:account }`);
    ok(row.demographics && typeof row.demographics === 'object', `${lane}: the row carries a demographics payload object`);
    ok(def.categories.every((c) => row.demographics[c] && typeof row.demographics[c] === 'object'),
      `${lane}: demographics carries the expected structured categories (${def.categories.join(', ')})`);
    for (const c of def.categories) {
      ok(Object.values(row.demographics[c]).every((v) => typeof v === 'number'), `${lane}: ${c} bucket values are numbers, never fabricated strings`);
    }
  }

  // ---- 2. ungranted -> needs_scope (P9) with the EXACT per-lane scope, never a throw --
  for (const [lane, def] of Object.entries(LANES)) {
    const ung = runEngine(def.script, ['demographics', '--plan', path.join(WS, 'data', 'plans', 'local.json'), '--json', '--actor', 'pendpost'], { PENDPOST_MOCK_UNGRANTED: lane });
    ok(ung.ok === false && ung.error === 'needs_scope' && ung.scope === def.scope,
      `${lane}: ungranted demographics degrades to { ok:false, error:needs_scope, scope:${def.scope} }`);
  }

  // ---- 5. tiktok: no ENGINES entry -> never spawned, no crash, no phantom row ----
  const swTiktokOnly = await fetchInsights({ campaign: 'tiktok-only' });
  ok(swTiktokOnly.ok && swTiktokOnly.results.length === 0, 'tiktok-only campaign: the sweep runs clean with zero results (tiktok has no ENGINES entry - documented no-op)');

  // ---- 3. the GENERIC account pass stores every lane's payload + exposes it ----
  const sw = await fetchInsights({ campaign: 'local' });
  ok(sw.ok, 'sweep (local campaign) returns ok');
  const env = getInsights();
  for (const [lane, def] of Object.entries(LANES)) {
    const stored = env.account[lane]?.demographics;
    ok(stored && def.categories.every((c) => stored[c] && Object.keys(stored[c]).length > 0),
      `state.insights.account.${lane}.demographics holds the structured categories on the envelope`);
    ok(typeof env.account[lane].fetchedAt === 'string', `the stored account.${lane} block carries a fetchedAt timestamp`);
  }
  ok(!('tiktok' in env.account), 'tiktok never gets a phantom account entry (no ENGINES/ACCOUNT_PASS mapping)');

  // ---- 4. pinterest also gets its regular per-post `insights` row (proof the
  // ENGINES/LANES/lanesWithEvidence wiring, not just the account pass, is real) --
  ok(Boolean(loadState().insights?.data?.['local/p1/pinterest']), 'pinterest per-post insights is now swept too (spec 07 wires it into ENGINES/LANES/lanesWithEvidence)');

  // ---- 6. merge-on-write: a pre-existing sibling field on the SAME lane survives
  // the demographics account pass adding .demographics (generic per-lane MAP) -----
  const st = loadState();
  st.insights = st.insights || {};
  st.insights.account = st.insights.account || {};
  st.insights.account.meta = { performance: { impressions: 500 }, fetchedAt: '2020-01-01T00:00:00.000Z' };
  saveState();
  await fetchInsights({ campaign: 'local' });
  const merged = getInsights().account.meta;
  ok(merged.performance && merged.performance.impressions === 500, 'merge: a pre-existing sibling field on the meta lane is PRESERVED across the demographics sweep, not clobbered');
  ok(merged.demographics && merged.demographics.age && Object.keys(merged.demographics.age).length > 0, 'merge: the account pass ADDS demographics to the same lane alongside the pre-existing field');

  // ---- 7. digest renders the Audience section (en + de-CH, ß-free) --------------
  const digest = generateDigest({ locale: 'en' });
  ok(digest.ok && /## Audience/.test(digest.digest), 'generateDigest() renders the Audience section header');
  ok(/Meta|LinkedIn|YouTube|Pinterest/.test(digest.digest), 'the Audience section names at least one lane');
  const de = generateDigest({ locale: 'de-CH' });
  ok(/## Zielgruppe/.test(de.digest), 'de-CH digest renders the localized Audience section header');
  ok(!/ß/.test(de.digest), 'de-CH digest stays eszett-free');
  // AU-1: meta returns BOTH country and city (both -> demographics.geo). The digest
  // must collapse them under ONE "Top locations:" line per geo-carrying lane
  // (meta/linkedin/pinterest = 3), never the duplicated meta pair (which was 4).
  ok((digest.digest.match(/Top locations:/g) || []).length === 3, 'digest renders the geo line ONCE per lane (country+city collapse under one "Top locations:", not a doubled meta heading)');
  // AU-2: a region slug is humanized to words for display (linkedin north-america).
  ok(/North America/.test(digest.digest) && !/north-america/.test(digest.digest), 'digest humanizes region slugs (north-america -> North America), leaving the raw token nowhere in the output');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[demographics] OK - per-lane account row shape, needs_scope degrade with exact scope, generic account-pass store + envelope, pinterest sweep wiring, tiktok no-op, merge-on-write, digest Audience section (${pass} assertions).`);
} catch (err) {
  console.error(`[demographics] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
