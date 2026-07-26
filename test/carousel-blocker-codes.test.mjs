#!/usr/bin/env node
// test/carousel-blocker-codes.test.mjs - H2. All nine carousel blockers reached the
// de-CH dashboard in raw English. platformValidate's localisation seam is the parallel
// problemCodes[i] array (the SPA zips it with problems[i] and resolves
// blockers.validate.*), and only ONE of the nine carousel rows carried a code.
//
// Three of the reasons live inside carouselUnsupported, which returned a bare string, so
// this also pins the refactor: an internal unsupportedFor() -> {code, reason} with a
// BYTE-STABLE carouselUnsupported() wrapper plus a new carouselUnsupportedCode().
//
// The English strings are asserted VERBATIM. That is not pedantry: lib/drivers/
// mock-driver.mjs emits the same reasons for the credential-free demo loop, and the live
// engines emit them at publish. If a refactor reworded one, the mock would start lying
// about what live does. The bytes are the contract; the code is the localisation.
//
// Also guards that every emitted code EXISTS in BOTH locale packs, so a new coded
// blocker cannot ship half-localised.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-carousel-codes-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;

const mediaDir = path.join(WS, 'data', 'media');
const campDir = path.join(WS, 'data', 'plans', 'cbc');
fs.mkdirSync(mediaDir, { recursive: true });
fs.mkdirSync(campDir, { recursive: true });
for (let i = 0; i < 16; i += 1) fs.writeFileSync(path.join(mediaDir, `i${i}.jpg`), 'x');
for (let i = 0; i < 16; i += 1) fs.writeFileSync(path.join(mediaDir, `v${i}.mp4`), 'x');
const img = (n) => Array.from({ length: n }, (_, i) => ({ path: `data/media/i${i}.jpg` }));
const vid = (n) => Array.from({ length: n }, (_, i) => ({ path: `data/media/v${i}.mp4` }));
const imgUrl = (n) => img(n).map((it, i) => ({ ...it, url: `https://cdn.example.com/i${i}.jpg` }));

fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'cbc', path: 'data/plans/cbc/post-plan.json', active: true }],
}, null, 2));

const base = {
  type: 'carousel', status: 'planned', executionMode: 'fully-scheduled',
  approval: 'approved', approvalBy: 'owner', approvalAt: '2026-01-01T00:00:00Z',
  createdBy: 'agent:claude', scheduledAt: '2099-01-01T09:00:00Z', caption: 'Swipe',
};
const posts = [
  // wordpress has no carousel engine branch. (mastodon used to stand here, until E2
  // gave it a real one - which is exactly the drift this assertion is meant to catch.)
  { id: 'lane', platforms: ['wordpress'], mediaItems: imgUrl(3), ...base },
  { id: 'min', platforms: ['linkedin'], mediaItems: img(1), ...base },
  { id: 'max', platforms: ['instagram'], mediaItems: vid(15), ...base },
  { id: 'mix', platforms: ['x'], mediaItems: [{ path: 'data/media/i0.jpg' }, { path: 'data/media/v0.mp4' }], ...base },
  { id: 'pinvid', platforms: ['pinterest'], mediaItems: [...imgUrl(2), { path: 'data/media/v0.mp4' }], ...base },
  { id: 'pinurl', platforms: ['pinterest'], mediaItems: img(3), ...base },
  // E1 wired the reddit gallery submit, so the wholesale degrade became an image-only
  // clause: a VIDEO slide is what a gallery still cannot carry.
  { id: 'reddit', platforms: ['reddit'], mediaItems: [...imgUrl(2), { path: 'data/media/v0.mp4' }], ...base },
  { id: 'igurl', platforms: ['instagram'], mediaItems: img(3), ...base },
  { id: 'gone', platforms: ['linkedin'], mediaItems: [...img(2), { path: 'data/media/nope.jpg' }], ...base },
];
fs.writeFileSync(path.join(campDir, 'post-plan.json'), JSON.stringify({ campaign: 'cbc', timezone: 'UTC', folder: '', posts }, null, 2));

const { platformValidate } = await import('../lib/writes.mjs');
const { carouselUnsupported, carouselUnsupportedCode } = await import('../lib/carousel.mjs');

// Every problem row for `platform`, zipped with its parallel code, so the two arrays
// are checked at the SAME index the SPA reads them at.
async function rows(postId, platform) {
  const res = await platformValidate({ campaign: 'cbc', postId });
  const p = res.platforms?.[platform] || {};
  return (p.problems || []).map((text, i) => ({ text, code: (p.problemCodes || [])[i] }));
}
const find = (rs, re) => rs.find((r) => re.test(r.text));

const seenCodes = new Set();
function coded(rs, re, code, params, label) {
  const r = find(rs, re);
  ok(Boolean(r), `${label}: the English problem is still emitted, byte-stable`);
  ok(r.code?.code === code, `${label}: carries the machine code ${code} (was a raw English string in de-CH)`);
  seenCodes.add(code);
  for (const [k, v] of Object.entries(params)) {
    ok(r.code?.params?.[k] === v, `${label}: params.${k} = ${JSON.stringify(v)}`);
  }
  return r;
}

try {
  // ---- the four shape blockers ------------------------------------------------------
  const lane = await rows('lane', 'wordpress');
  ok(find(lane, /^carousel is not supported on wordpress$/) !== undefined,
    'lane-unsupported: the English string is byte-identical');
  coded(lane, /is not supported on/, 'validate.carouselLaneUnsupported', { platform: 'wordpress' }, 'lane-unsupported');

  const min = await rows('min', 'linkedin');
  ok(find(min, /^carousel needs at least 2 media items$/) !== undefined,
    'min-items: the English string is byte-identical');
  coded(min, /needs at least/, 'validate.carouselMinItems', { min: 2 }, 'min-items');

  const max = await rows('max', 'instagram');
  ok(find(max, /^instagram allows at most 10 carousel items \(this carousel has 15\)$/) !== undefined,
    'max-items: the English string is byte-identical');
  coded(max, /allows at most/, 'validate.carouselMaxItems', { platform: 'instagram', max: 10, count: 15 }, 'max-items');

  const mix = await rows('mix', 'x');
  ok(find(mix, /^x cannot mix images and video in one carousel$/) !== undefined,
    'no-mix: the English string is byte-identical');
  coded(mix, /cannot mix/, 'validate.carouselNoMix', { platform: 'x' }, 'no-mix');

  // ---- the missing-on-disk blocker ---------------------------------------------------
  const gone = await rows('gone', 'linkedin');
  ok(find(gone, /^1 of 3 carousel media items are missing on disk$/) !== undefined,
    'missing-slides: the English string is byte-identical');
  coded(gone, /missing on disk/, 'validate.carouselMissingSlides', { missing: 1, count: 3 }, 'missing-slides');

  // ---- the four carouselUnsupported reasons ------------------------------------------
  const pinvid = await rows('pinvid', 'pinterest');
  ok(find(pinvid, /^pinterest carousel pins are image-only \(multiple_image_urls\) - drop the video slide or post it as its own video pin$/) !== undefined,
    'pinterest-video: the English string is byte-identical (the mock driver emits these same bytes)');
  coded(pinvid, /image-only/, 'validate.carouselPinterestVideo', {}, 'pinterest-video');

  const pinurl = await rows('pinurl', 'pinterest');
  ok(find(pinurl, /^pinterest carousel needs a public image URL per slide \(set each slide url, or a public media host in Settings\) - or post manually$/) !== undefined,
    'pinterest-url: the English string is byte-identical');
  coded(pinurl, /public image URL per slide/, 'validate.carouselPinterestSlideUrl', {}, 'pinterest-url');

  const reddit = await rows('reddit', 'reddit');
  ok(find(reddit, /^reddit galleries are image-only - drop the video slide or post it as its own video post$/) !== undefined,
    'reddit-video: the English string is byte-identical');
  coded(reddit, /galleries are image-only/, 'validate.carouselRedditVideo', {}, 'reddit-video');

  const igurl = await rows('igurl', 'instagram');
  ok(find(igurl, /^IG image-carousel slides need a public image_url/) !== undefined,
    'ig-slide-url: the English string is byte-identical');
  coded(igurl, /public image_url/, 'validate.igCarouselSlideUrl', {}, 'ig-slide-url');

  // ---- the refactor: the wrapper stays byte-stable, the code comes from one place -----
  const pinVidPost = posts.find((p) => p.id === 'pinvid');
  ok(carouselUnsupported(pinVidPost, 'pinterest') === 'pinterest carousel pins are image-only (multiple_image_urls) - drop the video slide or post it as its own video pin',
    'carouselUnsupported() still returns the exact same string after the refactor');
  ok(carouselUnsupportedCode(pinVidPost, 'pinterest') === 'validate.carouselPinterestVideo',
    'carouselUnsupportedCode() returns the code for the SAME condition');
  ok(carouselUnsupportedCode({ ...pinVidPost, platforms: ['linkedin'] }, 'linkedin') === null,
    'carouselUnsupportedCode() returns null where carouselUnsupported() returns null');
  ok(carouselUnsupported({ ...pinVidPost }, 'linkedin') === null,
    'a supported lane still degrades to null (unchanged)');

  // ---- every emitted code is in BOTH locale packs -------------------------------------
  ok(seenCodes.size === 9, `all nine carousel blockers are coded (saw ${seenCodes.size})`);
  for (const pack of ['en.json', 'de-CH.json']) {
    const strings = JSON.parse(fs.readFileSync(path.join(REPO, 'app', 'src', 'locales', pack), 'utf8')).strings || {};
    for (const code of [...seenCodes].sort()) {
      ok(typeof strings[`blockers.${code}`] === 'string' && strings[`blockers.${code}`].trim() !== '',
        `${pack}: blockers.${code} is present and non-empty`);
    }
  }
  // de-CH orthography is an owner rule, not a preference: real umlauts, never the sharp s.
  const de = JSON.parse(fs.readFileSync(path.join(REPO, 'app', 'src', 'locales', 'de-CH.json'), 'utf8')).strings || {};
  for (const code of seenCodes) {
    const s = de[`blockers.${code}`] || '';
    ok(!s.includes('ß'), `de-CH blockers.${code} uses ss, never the sharp s`);
    ok(!/[—–]/.test(s), `de-CH blockers.${code} carries no em or en dash`);
  }
  for (const code of seenCodes) {
    const en = JSON.parse(fs.readFileSync(path.join(REPO, 'app', 'src', 'locales', 'en.json'), 'utf8')).strings || {};
    ok(!/[—–]/.test(en[`blockers.${code}`] || ''), `en blockers.${code} carries no em or en dash`);
  }

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
