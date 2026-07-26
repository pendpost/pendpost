#!/usr/bin/env node
// test/carousel-validate.test.mjs - spec 05 review. Two coherence contracts:
//
//  (1) CAP RECONCILE (finding #2). validateFieldValues (the create/update gate) bounds a
//      carousel at the GLOBAL max any lane supports (20 = LinkedIn/Reddit) so a lawful
//      20-slide LinkedIn carousel the UI offers SAVES; the tighter per-lane cap (IG 10, ...)
//      is enforced by Pruefen (platformValidate), the poll precedent of shape-permissive
//      create + readiness-enforces. A 15-slide LinkedIn saves; a 15-slide IG saves as a
//      draft but Pruefen blocks it at cap 10; 21 items is rejected at save.
//
//  (2) VALIDATOR<->ENGINE COHERENCE (findings #3/#6). platformValidate BLOCKS a carousel the
//      live engine can never publish, so a GREEN Pruefen never green-lights something the
//      engine silently drops: an Instagram carousel with any IMAGE slide (no feed-image seam;
//      an all-VIDEO IG carousel is fine), pinterest/reddit (no local media seam), and any lane
//      with no carousel branch (mastodon/... -> "carousel is not supported on <lane>").
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib (mirrors
// test/poll-validate.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-carousel-validate-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;

const mediaDir = path.join(WS, 'data', 'media');
const campDir = path.join(WS, 'data', 'plans', 'cv');
fs.mkdirSync(mediaDir, { recursive: true });
fs.mkdirSync(campDir, { recursive: true });
// Real slide files so resolveMediaItems reads exists:true (no "missing on disk" noise).
const IMG = (n) => `data/media/img${n}.jpg`;
const VID = (n) => `data/media/vid${n}.mp4`;
for (let i = 0; i < 20; i += 1) fs.writeFileSync(path.join(mediaDir, `img${i}.jpg`), 'x');
for (let i = 0; i < 3; i += 1) fs.writeFileSync(path.join(mediaDir, `vid${i}.mp4`), 'x');
const imgSlides = (n) => Array.from({ length: n }, (_, i) => ({ path: IMG(i) }));
const vidSlides = (n) => Array.from({ length: n }, (_, i) => ({ path: VID(i) }));

fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'cv', path: 'data/plans/cv/post-plan.json', active: true }],
}, null, 2));

const base = {
  type: 'carousel', status: 'planned', executionMode: 'fully-scheduled',
  approval: 'approved', approvalBy: 'owner', approvalAt: '2026-01-01T00:00:00Z',
  createdBy: 'agent:claude', scheduledAt: '2099-01-01T09:00:00Z', caption: 'Swipe',
};
const posts = [
  { id: 'ig15', platforms: ['instagram'], mediaItems: vidSlides(3).concat(imgSlides(12)), ...base }, // 15, over IG cap 10
  { id: 'ig-img', platforms: ['instagram'], mediaItems: imgSlides(3), ...base }, // image slides -> no IG feed-image seam
  { id: 'ig-vid', platforms: ['instagram'], mediaItems: vidSlides(3), ...base }, // all video -> publishable
  { id: 'li15', platforms: ['linkedin'], mediaItems: imgSlides(15), ...base }, // 15, under LinkedIn cap 20
  { id: 'masto', platforms: ['wordpress'], mediaItems: imgSlides(3), ...base }, // lane has no carousel branch (mastodon gained one in E2)
];
fs.writeFileSync(path.join(campDir, 'post-plan.json'), JSON.stringify({ campaign: 'cv', timezone: 'UTC', folder: '', posts }, null, 2));

const { validateFieldValues, platformValidate } = await import('../lib/writes.mjs');

try {
  // ---- (1) cap reconcile: SAVE (validateFieldValues) bounds at 20, not 10 -------------
  ok(validateFieldValues({ mediaItems: imgSlides(15) }) === null,
    'save: a 15-slide carousel passes validateFieldValues (under the 20 global bound)');
  ok(validateFieldValues({ mediaItems: imgSlides(20) }) === null,
    'save: a 20-slide LinkedIn-lawful carousel passes validateFieldValues (the global bound IS 20)');
  const over = validateFieldValues({ mediaItems: imgSlides(20).concat({ path: IMG(0) }) });
  ok(over && over.code === 'invalid_input' && /at most 20 items/.test(over.message),
    'save: a 21-slide carousel is rejected at save with the 20-item bound');

  // ---- (1) cap reconcile: Pruefen enforces the tighter per-lane cap -------------------
  const ig15 = await platformValidate({ campaign: 'cv', postId: 'ig15' });
  ok((ig15.platforms?.instagram?.problems || []).some((p) => /instagram allows at most 10 carousel items \(this carousel has 15\)/.test(p)),
    'Pruefen: a 15-slide IG carousel is blocked at the IG cap of 10 (saved as a draft, blocked at readiness)');

  const li15 = await platformValidate({ campaign: 'cv', postId: 'li15' });
  ok(!(li15.platforms?.linkedin?.problems || []).some((p) => /allows at most \d+ carousel items/.test(p)),
    'Pruefen: a 15-slide LinkedIn carousel has NO cap problem (LinkedIn cap is 20)');

  // ---- (2) coherence: IG image carousel BLOCKED; all-video IG carousel PASSES ----------
  const igImg = await platformValidate({ campaign: 'cv', postId: 'ig-img' });
  const igImgProblems = igImg.platforms?.instagram?.problems || [];
  ok(igImgProblems.some((p) => /no feed-image|image_url|image-carousel/i.test(p)),
    'Pruefen: an IG IMAGE carousel is blocked (no feed-image publish seam)');

  const igVid = await platformValidate({ campaign: 'cv', postId: 'ig-vid' });
  const igVidProblems = igVid.platforms?.instagram?.problems || [];
  ok(!igVidProblems.some((p) => /no feed-image|image_url|image-carousel/i.test(p)),
    'Pruefen: an ALL-VIDEO IG carousel has NO image-seam problem (the engine builds video children)');
  ok(!igVidProblems.some((p) => /is not supported|allows at most \d+ carousel|needs at least 2/.test(p)),
    'Pruefen: an all-video IG carousel carries no carousel-shape problem (connectivity aside)');

  // ---- (2) coherence: an unsupported lane is blocked, never stranded ------------------
  const masto = await platformValidate({ campaign: 'cv', postId: 'masto' });
  ok((masto.platforms?.wordpress?.problems || []).some((p) => /carousel is not supported on wordpress/.test(p)),
    'Pruefen: a carousel on a lane with no carousel branch (mastodon) is blocked, not stranded');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
