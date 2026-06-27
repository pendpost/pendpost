#!/usr/bin/env node
// test/interactive-fields.test.mjs - the FR4 interactive-story + per-post hashtag
// fields (US-FR-04) survive the write/read seam, mirroring test/article-fields.test.mjs.
//
// Pure assertions, no manifest, no I/O:
//   1. normalizePost (the read DTO plan_get returns) SURFACES interactiveStory + hashtags
//      unchanged. This guards the documented silent failure mode: a field that persists
//      on write but is dropped by the read DTO is invisible to plan_get / the dashboard
//      with no error (the write-side/read-side parity rule).
//   2. An ABSENT value normalizes to the safe default (interactiveStory -> null,
//      hashtags -> []), mirroring how the existing optional fields default.
//   3. validateFieldValues ACCEPTS a valid poll sticker + hashtag array and REJECTS a
//      bad sticker kind, a non-array hashtags, and an out-of-range layout coord - the
//      cheap automated gate on the new fields' validation contract (every create/update
//      passes through this validator).
//   4. effectiveHashtags enforces override-wins: a non-empty per-post list precedes the
//      global presets; an empty per-post list inherits the global presets.
// The live create/update persistence is covered by the MCP round-trip (manifest-coupled,
// integration-first), not duplicated here.
import assert from 'node:assert';
import { normalizePost, effectiveHashtags } from '../lib/plans.mjs';
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

const planEntry = { id: 'test-campaign' };
const plan = { timezone: 'UTC' };

// A poll sticker with layout coords, plus a per-post hashtag override.
const POLL_STICKER = { kind: 'poll', question: 'Yes or no?', options: ['Yes', 'No'], x: 0.5, y: 0.4 };
const INTERACTIVE = { stickers: [POLL_STICKER] };
const HASHTAGS = ['#launch', '#brand'];

// --- 1. normalizePost surfaces interactiveStory + hashtags unchanged -------
const storyPost = {
  id: 'st1',
  type: 'story',
  platforms: ['instagram'],
  caption: 'Caption',
  interactiveStory: INTERACTIVE,
  hashtags: HASHTAGS,
};
const dto = normalizePost(planEntry, plan, storyPost);
check('normalizePost surfaces interactiveStory unchanged', () => {
  assert.deepEqual(dto.interactiveStory, INTERACTIVE);
});
check('normalizePost surfaces the poll sticker with its layout coords', () => {
  assert.deepEqual(dto.interactiveStory.stickers[0], POLL_STICKER);
});
check('normalizePost surfaces hashtags unchanged', () => {
  assert.deepEqual(dto.hashtags, HASHTAGS);
});

// --- 2. absent values normalize to the safe default ------------------------
const bareDto = normalizePost(planEntry, plan, { id: 'y', type: 'story', platforms: ['instagram'] });
check('normalizePost defaults interactiveStory to null when absent', () => {
  assert.strictEqual(bareDto.interactiveStory, null);
});
check('normalizePost defaults hashtags to [] when absent', () => {
  assert.deepEqual(bareDto.hashtags, []);
});

// --- 3. validateFieldValues guards the new fields --------------------------
check('valid interactiveStory + hashtags pass', () => {
  assert.strictEqual(validateFieldValues({ interactiveStory: INTERACTIVE, hashtags: HASHTAGS }), null);
});
check('null interactiveStory + null hashtags pass (clear-to-default)', () => {
  assert.strictEqual(validateFieldValues({ interactiveStory: null, hashtags: null }), null);
});

const badKind = validateFieldValues({ interactiveStory: { stickers: [{ kind: 'gif' }] } });
check('an unknown sticker kind is rejected', () => {
  assert.ok(badKind, 'expected an error body');
  assert.strictEqual(badKind.code, 'invalid_input');
  assert.match(badKind.message, /sticker kind must be one of/);
});

const badHashtags = validateFieldValues({ hashtags: 'not-an-array' });
check('non-array hashtags is rejected', () => {
  assert.ok(badHashtags, 'expected an error body');
  assert.strictEqual(badHashtags.code, 'invalid_input');
  assert.match(badHashtags.message, /hashtags must be an array of strings/);
});

const badCoord = validateFieldValues({ interactiveStory: { stickers: [{ kind: 'poll', x: 2 }] } });
check('an out-of-range sticker layout coord is rejected', () => {
  assert.ok(badCoord, 'expected an error body');
  assert.strictEqual(badCoord.code, 'invalid_input');
  assert.match(badCoord.message, /sticker x must be a number between 0 and 1/);
});

const badEnvelope = validateFieldValues({ interactiveStory: ['not', 'an', 'object'] });
check('a non-object interactiveStory is rejected', () => {
  assert.ok(badEnvelope, 'expected an error body');
  assert.strictEqual(badEnvelope.code, 'invalid_input');
  assert.match(badEnvelope.message, /interactiveStory must be an object/);
});

// --- 4. effectiveHashtags override-wins ------------------------------------
const GLOBAL = ['#global1', '#global2'];
check('a non-empty per-post hashtags overrides the global presets', () => {
  assert.deepEqual(effectiveHashtags({ hashtags: HASHTAGS }, GLOBAL), HASHTAGS);
});
check('an empty per-post hashtags inherits the global presets', () => {
  assert.deepEqual(effectiveHashtags({ hashtags: [] }, GLOBAL), GLOBAL);
});
check('an absent per-post hashtags inherits the global presets', () => {
  assert.deepEqual(effectiveHashtags({}, GLOBAL), GLOBAL);
});

if (failures) {
  console.error(`[interactive-fields] FAIL - ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('[interactive-fields] OK - interactiveStory + per-post hashtags survive the write/read seam (override-wins enforced).');
// writes.mjs pulls the lib graph (no top-level timers); force a clean exit.
process.exit(0);
