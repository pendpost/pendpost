#!/usr/bin/env node
// test/youtube-limits.test.mjs - platformValidate counts YouTube snippet limits the
// way the Data API does (developers.google.com/youtube/v3/docs/videos): title 100
// characters, description 5000 BYTES, no < or > in either, tags 500 characters with
// the commas and the quotes around space-containing tags counted.
//
// Regression: the description was checked in characters and the tags as the raw
// comma string, so a German description of 2600 umlauts (5200 bytes) or a tag list
// with spaces could pass validation and then fail the upload.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-yt-limits-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const plansDir = path.join(WS, 'data', 'plans');
const campDir = path.join(plansDir, 'yt');
fs.mkdirSync(campDir, { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));

const post = (id, extra = {}) => ({
  id, platforms: ['youtube'], type: 'youtube-short', path: 'data/media/clip.mp4',
  title: 'A fine title', description: 'A fine description.', scheduledAt: '2099-01-01T09:00:00Z',
  status: 'planned', executionMode: 'fully-scheduled', approval: 'approved', approvalBy: 'owner',
  approvalAt: '2026-01-01T00:00:00Z', createdBy: 'agent:claude', ...extra,
});
const spacedTags = Array.from({ length: 70 }, (_, i) => `ab ${String(i).padStart(2, '0')}`).join(', ');

fs.writeFileSync(path.join(plansDir, 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'yt', path: 'data/plans/yt/post-plan.json', active: true }],
}));
fs.writeFileSync(path.join(campDir, 'post-plan.json'), JSON.stringify({
  campaign: 'YouTube limits', timezone: 'UTC',
  posts: [
    post('ok'),
    post('umlauts', { description: 'ä'.repeat(2600) }),
    post('ascii-5000', { description: 'a'.repeat(5000) }),
    post('brackets', { description: 'Use <b>bold</b> here' }),
    post('long-title', { title: 'T'.repeat(101) }),
    post('spaced-tags', { tags: spacedTags }),
  ],
}));

const { platformValidate, ytTagsLength } = await import('../lib/writes.mjs');
const problems = async (id) => (await platformValidate({ campaign: 'yt', postId: id })).platforms.youtube.problems;
const has = (list, re) => list.some((p) => re.test(p));

try {
  // ytTagsLength follows the documented example: Foo-Baz is 7, "Foo Baz" is 9.
  assert.equal(ytTagsLength('Foo-Baz'), 7);
  assert.equal(ytTagsLength('Foo Baz'), 9);
  assert.equal(ytTagsLength('a, b c'), 1 + 1 + 5);
  assert.equal(ytTagsLength(''), 0);

  assert.equal(has(await problems('ok'), /bytes|title is|< and >|tags total/), false, 'a well-formed post has no limit problems');
  assert.ok(has(await problems('umlauts'), /description is 5200 bytes/), '2600 umlauts are 5200 bytes, over the cap');
  assert.equal(has(await problems('ascii-5000'), /bytes/), false, '5000 ASCII characters are exactly at the cap');
  assert.ok(has(await problems('brackets'), /< and >/), 'angle brackets are rejected');
  assert.ok(has(await problems('long-title'), /title is 101 chars/), 'title over 100 characters');
  assert.ok(spacedTags.length < 500, 'the raw comma string looks short enough');
  assert.ok(has(await problems('spaced-tags'), /tags total \d+ chars as YouTube counts them/), 'quotes around spaced tags push it over 500');

  console.log('youtube-limits: all assertions passed');
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
