#!/usr/bin/env node
// test/carousel-asset-inuse.test.mjs - H5. An album's slide files read as UNUSED, so
// delete_asset and rename_asset would remove one out from under a scheduled post
// without so much as a confirm prompt.
//
// Both in-use sites built their path set from the SINGLE media.path
// (lib/assets.mjs scanAssets usedBy, and lib/writes.mjs usingPosts, which
// delete_asset and rename_asset share). A carousel's media.path is always null: its
// slides live on media.items[]. 19 real bondigoo slide files were deletable this way.
//
// The fix is ONE type-gated path set (plans.postMediaPaths) used at both sites. The
// `type === 'carousel'` gate is load-bearing beyond this unit: it is what makes the
// next unit's decision to KEEP orphan mediaItems on a switch away from carousel safe,
// because an orphan can then never claim a file.
//
// A rename deliberately does NOT rewrite mediaItems refs. That matches the documented
// doctrine, and the failure is fail-closed: carouselReady goes false, the post stops
// being due-eligible, and H2's coded blocker names it. Half-publishing an album is the
// outcome worth avoiding, not a broken ref.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-carousel-inuse-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const mediaDir = path.join(WS, 'data', 'media');
const campDir = path.join(WS, 'data', 'plans', 'cai');
fs.mkdirSync(mediaDir, { recursive: true });
fs.mkdirSync(campDir, { recursive: true });
const NAMES = ['s1.jpg', 's2.jpg', 's3.jpg', 'twice.jpg', 'solo.mp4', 'orphan.jpg', 'free.jpg'];
for (const n of NAMES) fs.writeFileSync(path.join(mediaDir, n), 'x');
const rel = (f) => `data/media/${f}`;
const abs = (f) => path.join(mediaDir, f);

fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'cai', path: 'data/plans/cai/post-plan.json', active: true }],
}, null, 2));

const base = {
  status: 'planned', executionMode: 'fully-scheduled', createdBy: 'agent:claude',
  scheduledAt: '2099-01-01T09:00:00Z', caption: 'Swipe', platforms: ['linkedin'],
};
const posts = [
  { id: 'album', type: 'carousel', mediaItems: [{ path: rel('s1.jpg') }, { path: rel('s2.jpg') }, { path: rel('s3.jpg') }], ...base },
  // The same file used twice in ONE album must yield ONE row, not two.
  { id: 'dupe', type: 'carousel', mediaItems: [{ path: rel('twice.jpg') }, { path: rel('twice.jpg') }, { path: rel('s1.jpg') }], ...base },
  // Regression fence: a single-media post keeps claiming its one file.
  { id: 'reel1', type: 'reel', path: rel('solo.mp4'), ...base },
  // The H3-safety assertion: a post switched AWAY from carousel keeps its orphan
  // mediaItems, and the type gate must make that orphan inert. orphan.jpg is free.
  { id: 'switched', type: 'reel', path: rel('solo.mp4'), mediaItems: [{ path: rel('orphan.jpg') }], ...base },
];
fs.writeFileSync(path.join(campDir, 'post-plan.json'), JSON.stringify({ campaign: 'cai', timezone: 'UTC', folder: '', posts }, null, 2));

const { scanAssets } = await import('../lib/assets.mjs');
const { deleteAsset, renameAsset } = await import('../lib/writes.mjs');

const noProbe = async () => ({ error: 'no ffprobe in test' });
const noCover = async () => false;

try {
  const scan = await scanAssets(noProbe, noCover);
  const row = (f) => (scan.assets || []).find((a) => a.file === f) || {};
  const users = (f) => (row(f).usedBy || []).map((u) => `${u.campaign}/${u.postId}`).sort();

  // ---- the Library stops calling album slides unused ---------------------------------
  ok(users('s1.jpg').includes('cai/album'), 'Library: slide 1 is reported as used by its album (was unused)');
  ok(users('s2.jpg').join() === 'cai/album', 'Library: a middle slide is used by exactly its album');
  ok(users('s3.jpg').join() === 'cai/album', 'Library: the last slide is used by its album');
  ok(users('s1.jpg').join() === 'cai/album,cai/dupe',
    'Library: a slide shared by two albums lists BOTH posts');
  ok((row('twice.jpg').usedBy || []).length === 1,
    'Library: a file used twice in ONE album yields ONE row, not a duplicate');
  ok(users('solo.mp4').includes('cai/reel1'),
    'Library: a single-media post still claims its one file (unchanged)');
  ok(users('free.jpg').length === 0, 'Library: a genuinely unused file is still reported unused');

  // ---- the type gate: an orphan mediaItems set claims nothing -------------------------
  ok(users('orphan.jpg').length === 0,
    'type gate: a post switched AWAY from carousel does NOT claim its orphan mediaItems - which is what makes keeping them safe');

  // ---- delete_asset and rename_asset both refuse, via the one shared predicate --------
  const del = await deleteAsset({ file: 's2.jpg', actor: 'owner' });
  ok(del.code === 'needs_confirm',
    'delete_asset refuses a slide instead of silently removing it from under a scheduled album');
  ok(/cai\/album/.test(del.message), 'delete_asset names the album that would break');
  ok(Array.isArray(del.usedBy) && del.usedBy.length === 1, 'delete_asset returns the structured usedBy row');
  ok(fs.existsSync(abs('s2.jpg')), 'delete_asset did NOT touch the file while refusing');

  const ren = await renameAsset({ file: 's3.jpg', toName: 'renamed.jpg', actor: 'owner' });
  ok(ren.code === 'needs_confirm',
    'rename_asset refuses a slide too - one shared predicate closes both verbs at once');
  ok(fs.existsSync(abs('s3.jpg')), 'rename_asset did NOT touch the file while refusing');

  const orphanDel = await deleteAsset({ file: 'orphan.jpg', actor: 'owner' });
  ok(orphanDel.ok === true,
    'delete_asset still deletes a file only an ORPHAN mediaItems ref points at - the gate keeps it inert, no false confirm prompt');

  const freeDel = await deleteAsset({ file: 'free.jpg', actor: 'owner' });
  ok(freeDel.ok === true, 'delete_asset still deletes a genuinely unused file with no prompt');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
