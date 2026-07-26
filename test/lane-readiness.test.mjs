#!/usr/bin/env node
// test/lane-readiness.test.mjs - the pure account-warmth publish ADVISORY judge (spec 37,
// reversed 2026-07-13). Reddit posts ALWAYS auto-execute after a distinct human's approval;
// the judge no longer ROUTES to a manual tier - it returns display-only ADVISORIES
// (promo / cold / subRequirements) that the app surfaces as warnings and that accumulate.
// The never-auto-APPROVE fence (lib/auto-approve.mjs, keyed on MANUAL_LANES) is unchanged
// and load-bearing: a distinct human still approves EVERY reddit post. Zero-dep node:assert.
import assert from 'node:assert';
import { laneReadiness, MANUAL_LANES, READINESS_CASES, WARMTH_MIN_AGE_DAYS, WARMTH_MIN_KARMA } from '../lib/lane-readiness.mjs';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); console.log(`  ok - ${msg}`); pass += 1; };

// 1. Every shared fixture case (the SAME array the app twin test iterates).
for (const c of READINESS_CASES) {
  eq(laneReadiness(c.lane, c.inputs), c.expect, `fixture: ${c.name}`);
}

// 2. MANUAL_LANES is the single source of truth and STILL contains reddit (the fence).
ok(MANUAL_LANES instanceof Set && MANUAL_LANES.has('reddit'), 'MANUAL_LANES is a Set that contains reddit (the never-auto-approve fence)');
ok(!MANUAL_LANES.has('x') && !MANUAL_LANES.has('mastodon'), 'MANUAL_LANES excludes non-manual lanes');

// 3. Thresholds are the documented 30d / 100 karma.
ok(WARMTH_MIN_AGE_DAYS === 30 && WARMTH_MIN_KARMA === 100, 'warmth thresholds are 30 days / 100 karma');

// 4. The judge NEVER routes: it returns an { advisories } shape with NO tier field. A warm +
// organic + requirements-met reddit post carries no advisories (nothing to warn about).
const warm = laneReadiness('reddit', { isPromo: false, accountAgeDays: 400, linkKarma: 900, commentKarma: 900, subRequirementsMet: true });
ok(!('tier' in warm), 'the judge returns NO tier field (manual routing retired - reddit auto-executes after approval)');
eq(warm.advisories, [], 'a warm + organic + requirements-met reddit post carries NO advisories');

// 5. Every screening concern surfaces as an ADVISORY (warn-and-allow), never a block, and they
// ACCUMULATE (a fully-unknown post warns on all three - the operator sees every concern).
const allBad = laneReadiness('reddit', {}); // promo (absence) + cold (no warmth) + subRequirements (undefined)
const codes = allBad.advisories.map((a) => a.code);
ok(codes.includes('promo') && codes.includes('cold') && codes.includes('subRequirements'), 'a fully-unknown reddit post accumulates promo + cold + subRequirements advisories');

// 6. A non-manual lane is never screened (no advisories).
eq(laneReadiness('bluesky', { isPromo: true }).advisories, [], 'a non-manual lane carries no advisories');

// 7. Advisories carry { code, params } only (no prose) - the app localizes.
const cold = laneReadiness('reddit', { isPromo: false, accountAgeDays: 10, linkKarma: 10, commentKarma: 10, subRequirementsMet: true });
const coldAdv = cold.advisories.find((a) => a.code === 'cold');
ok(coldAdv && coldAdv.params.ageDays === 10 && coldAdv.params.karma === 20, 'cold advisory carries { code, params:{ageDays,karma} }');
ok(!('text' in coldAdv) && !('message' in coldAdv), 'advisory objects carry NO prose key');

console.log(`\n${pass} checks passed`);
