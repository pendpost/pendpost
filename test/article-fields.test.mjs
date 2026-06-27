#!/usr/bin/env node
// test/article-fields.test.mjs - the LinkedIn article-card fields (image +
// description) survive the write/read seam.
//
// Two pure assertions, no manifest, no I/O:
//   1. normalizePost (the read DTO) SURFACES image + description. This guards the
//      documented silent failure mode: a field that persists on write but is
//      dropped by the read DTO is invisible to plan_get / platform_validate / the
//      dashboard with no error (the write-side/read-side parity rule).
//   2. validateFieldValues REJECTS a non-URL image and ACCEPTS a valid one - the
//      cheap automated gate on the new field's validation contract (every
//      create/update passes through this validator).
// The non-blocking warning path + create/update persistence are covered by the
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

const HERO = 'https://res.cloudinary.com/demo/image/upload/v1/sample.jpg';

// --- 1. normalizePost surfaces image + description -------------------------
const planEntry = { id: 'test-campaign' };
const plan = { timezone: 'UTC' };
const articlePost = {
  id: 'blog-x',
  type: 'text',
  platforms: ['linkedin'],
  title: 'Titel',
  link: 'https://example.com/blog/x',
  image: HERO,
  description: 'Die Kartenbeschreibung.',
  caption: 'Caption',
};
const dto = normalizePost(planEntry, plan, articlePost);
check('normalizePost surfaces image', () => assert.equal(dto.image, HERO));
check('normalizePost surfaces description', () => assert.equal(dto.description, 'Die Kartenbeschreibung.'));

const bareDto = normalizePost(planEntry, plan, { id: 'y', type: 'text', platforms: ['linkedin'] });
check('normalizePost defaults image to null when absent', () => assert.equal(bareDto.image, null));

// --- 2. validateFieldValues guards the image URL --------------------------
check('valid image + description pass', () => assert.equal(validateFieldValues({ image: HERO, description: 'd' }), null));

const badUrl = validateFieldValues({ image: 'not-a-url' });
check('non-URL image is rejected', () => {
  assert.ok(badUrl, 'expected an error body');
  assert.equal(badUrl.code, 'invalid_input');
  assert.match(badUrl.message, /image must be an absolute http\(s\) URL/);
});

const badType = validateFieldValues({ image: 123 });
check('non-string image is rejected', () => {
  assert.ok(badType, 'expected an error body');
  assert.equal(badType.code, 'invalid_input');
  assert.match(badType.message, /image must be a string/);
});

// --- 3. normalizePost surfaces the mark_posted fields (same write/read seam) ---
const postedDto = normalizePost(planEntry, plan, {
  id: 'm', type: 'reel', platforms: ['instagram'],
  status: 'posted', publishedVia: 'manual', externalUrl: 'https://www.instagram.com/p/abc',
});
check('normalizePost surfaces publishedVia', () => assert.equal(postedDto.publishedVia, 'manual'));
check('normalizePost surfaces externalUrl', () => assert.equal(postedDto.externalUrl, 'https://www.instagram.com/p/abc'));
check('normalizePost defaults publishedVia/externalUrl to null when absent', () => {
  assert.equal(bareDto.publishedVia, null);
  assert.equal(bareDto.externalUrl, null);
});

if (failures) {
  console.error(`[article-fields] FAIL - ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('[article-fields] OK - image + description survive the write/read seam.');
// writes.mjs pulls the lib graph (no top-level timers); force a clean exit.
process.exit(0);
