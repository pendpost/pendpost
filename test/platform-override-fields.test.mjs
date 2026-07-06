#!/usr/bin/env node
// test/platform-override-fields.test.mjs - the per-platform text overrides for
// the telegram/discord/tiktok/reddit/pinterest lanes (tgCaption, dcCaption,
// ttCaption, redditText, pinTitle, pinDescription) survive the write/read seam.
//
// The engines already read these fields (additive xCaption pattern, falling
// back to caption / title); this guards the app-layer parity done for
// mastodonCaption/nostrCaption in 4623055:
//   1. normalizePost (the read DTO) SURFACES all six overrides. This guards the
//      documented silent failure mode: a field that persists on write but is
//      dropped by the read DTO is invisible to plan_get / platform_validate /
//      the dashboard with no error (the write-side/read-side parity rule).
//   2. validateFieldValues ACCEPTS string values and REJECTS non-strings - the
//      cheap automated gate on the validation contract (every create/update
//      passes through this validator).
// UPDATABLE_FIELDS acceptance + create/update persistence are covered by the
// live MCP round-trip (manifest-coupled, integration-first), not duplicated here.
import assert from 'node:assert';
import { normalizePost } from '../lib/plans.mjs';
import { validateFieldValues } from '../lib/writes.mjs';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL - ${name}: ${err.message}`);
  }
}

const OVERRIDES = ['tgCaption', 'dcCaption', 'ttCaption', 'redditText', 'pinTitle', 'pinDescription'];

// --- 1. normalizePost surfaces all six overrides ---------------------------
const planEntry = { id: 'test-campaign' };
const plan = { timezone: 'UTC' };
const overridePost = {
  id: 'multi-lane',
  type: 'text',
  platforms: ['telegram', 'discord', 'tiktok', 'reddit', 'pinterest'],
  caption: 'Shared caption',
  title: 'Shared title',
  tgCaption: 'Telegram text',
  dcCaption: 'Discord text',
  ttCaption: 'TikTok text',
  redditText: 'Reddit body',
  pinTitle: 'Pin title',
  pinDescription: 'Pin description',
};
const dto = normalizePost(planEntry, plan, overridePost);
for (const k of OVERRIDES) {
  check(`normalizePost surfaces ${k}`, () => assert.equal(dto[k], overridePost[k]));
}

const bareDto = normalizePost(planEntry, plan, { id: 'y', type: 'text', platforms: ['telegram'] });
for (const k of OVERRIDES) {
  check(`normalizePost defaults ${k} to '' when absent`, () => assert.equal(bareDto[k], ''));
}

// --- 2. validateFieldValues enforces the string contract -------------------
check('string values for all six overrides pass', () => assert.equal(
  validateFieldValues(Object.fromEntries(OVERRIDES.map((k) => [k, 'text']))),
  null,
));

for (const k of OVERRIDES) {
  const bad = validateFieldValues({ [k]: 123 });
  check(`non-string ${k} is rejected`, () => {
    assert.ok(bad, 'expected an error body');
    assert.equal(bad.code, 'invalid_input');
    assert.match(bad.message, new RegExp(`${k} must be a string`));
  });
}

if (failures) {
  console.error(`[platform-override-fields] FAIL - ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('[platform-override-fields] OK - the six lane overrides survive the write/read seam.');
// writes.mjs pulls the lib graph (no top-level timers); force a clean exit.
process.exit(0);
