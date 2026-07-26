#!/usr/bin/env node
// test/carousel-normalize.test.mjs - spec 05 (native carousel), the media model (§4c).
// A carousel is MEDIA-BACKED (unlike a poll): its readiness rides the resolved
// media.items[] set, NOT the media-less predicates. normalizePost:
//   - builds media.items[] (each { file, url, path, exists, resolution }, resolved via
//     the SAME resolveMediaPath anchoring as a single video), and
//   - sets the top-level media.exists to carouselReady (2+ items, ALL on disk) so the
//     SACRED eligibleDuePosts media gate + the platformValidate readiness line keep
//     working UNCHANGED (no forked filter).
// So a 1-item (or missing-slide) carousel reads as "media missing" and is NOT eligible;
// a 2-item resolved carousel is eligible.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-carousel-norm-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
// Real slide files so resolveMediaPath resolves them (anchored at PENDPOST_ROOT).
for (const f of ['a.jpg', 'b.jpg', 'c.jpg']) fs.writeFileSync(path.join(WS, f), 'x');

const { normalizePost, carouselReady, resolveMediaItems } = await import('../lib/plans.mjs');
const { eligibleDuePosts } = await import('../lib/scheduler.mjs');

const planEntry = { id: 'car-camp', path: 'data/plans/car-camp/post-plan.json' };
const plan = { campaign: 'car-camp', timezone: 'UTC', folder: '', posts: [] };
const base = { platforms: ['instagram'], type: 'carousel', caption: 'Swipe', approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: '2020-01-01T00:00:00Z' };

try {
  // ---- 1. media.items[] resolves each slide -------------------------------
  const twoRaw = { id: 'car2', ...base, mediaItems: [{ file: 'a.jpg' }, { file: 'b.jpg' }] };
  const two = normalizePost(planEntry, plan, twoRaw);
  ok(Array.isArray(two.media.items) && two.media.items.length === 2, 'media.items[] has one resolved entry per slide');
  ok(two.media.items.every((i) => i.exists && i.path && i.url), 'each resolved slide carries exists + path + url');
  ok(Array.isArray(two.mediaItems) && two.mediaItems.length === 2, 'the RAW mediaItems refs round-trip on the DTO (write/read parity)');

  // ---- 2. carouselReady + media.exists gate on 2+ resolved slides ---------
  ok(carouselReady(plan, twoRaw) === true, 'carouselReady === true for 2 resolved slides');
  ok(two.media.exists === true, 'top-level media.exists === carouselReady (true) for a ready carousel');

  const oneRaw = { id: 'car1', ...base, mediaItems: [{ file: 'a.jpg' }] };
  const one = normalizePost(planEntry, plan, oneRaw);
  ok(carouselReady(plan, oneRaw) === false, 'carouselReady === false for a single slide (a carousel needs 2+)');
  ok(one.media.exists === false, 'media.exists === false for a 1-slide carousel (reads as "media missing")');

  const missingRaw = { id: 'carM', ...base, mediaItems: [{ file: 'a.jpg' }, { file: 'zzz.jpg' }] };
  const missing = normalizePost(planEntry, plan, missingRaw);
  ok(missing.media.items[1].exists === false, 'a slide absent on disk resolves with exists:false');
  ok(carouselReady(plan, missingRaw) === false && missing.media.exists === false, 'a carousel with a missing slide is NOT ready');
  // MAJOR-1 seam: the RESOLVED media.items[] for the unresolved slide has path:null (a seed
  // that read it and dropped falsy paths would DELETE the slide on the next full-set save),
  // while the RAW post.mediaItems still carries the ref VERBATIM - so the Composer seeds the
  // carousel editor from post.mediaItems (raw), never post.media.items[] (resolved).
  ok(missing.media.items[1].path === null, 'the resolved media.items entry for a not-yet-on-disk slide has path:null (a resolved seed would drop it)');
  ok(missing.mediaItems.length === 2 && missing.mediaItems[1].file === 'zzz.jpg', 'the RAW mediaItems preserves the unresolved slide verbatim (the Composer round-trip seam)');

  // resolveMediaItems is the single seam both the DTO + carouselReady read.
  ok(resolveMediaItems(plan, twoRaw).length === 2, 'resolveMediaItems returns the ordered resolved set');
  ok(resolveMediaItems(plan, { type: 'video', file: 'a.jpg' }).length === 0, 'resolveMediaItems is empty for a non-carousel post');

  // ---- 3. eligibleDuePosts: only a ready carousel passes the media gate ----
  const campaigns = [{ id: 'car-camp', posts: [two, one] }];
  const eligibleIds = [...eligibleDuePosts(campaigns)].map(({ post }) => post.id);
  ok(eligibleIds.includes('car2'), 'eligibleDuePosts yields the 2-slide carousel (media.exists=carouselReady=true)');
  ok(!eligibleIds.includes('car1'), 'eligibleDuePosts SKIPS the 1-slide carousel (NOT ready -> media gate holds, no fork)');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
