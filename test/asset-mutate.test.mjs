#!/usr/bin/env node
// test/asset-mutate.test.mjs - C2: delete_asset + rename_asset (the REST + MCP
// twins live in api.mjs/mcp.mjs; this pins the lib/writes.mjs implementations).
//
// Both writes model uploadAsset (actor required, sanitizeAssetName on EVERY
// name, atomic fs ops, one activity entry) and ADD in-use protection: a plan
// post whose resolveMediaPath() lands on the target asset's abs path (the SAME
// key scanAssets uses) blocks the mutation with code 'needs_confirm' naming the
// using post(s) UNLESS confirm:true. The .jpg cover sibling is moved/removed
// alongside the .mp4. rename refuses an overwrite and an extension change.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib
// (util binds WORKSPACE_ROOT at import; mirrors test/asset-scan.test.mjs). No
// clients.json -> the activeRoot() legacy single-client fallback resolves data/
// under WS.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-assetmut-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const dataDir = path.join(WS, 'data');
const mediaDir = path.join(dataDir, 'media');
const plansDir = path.join(dataDir, 'plans');
const campDir = path.join(plansDir, 'mut-camp');
fs.mkdirSync(mediaDir, { recursive: true });
fs.mkdirSync(campDir, { recursive: true });

// A plan with ONE post that references in-use.mp4 by an activeRoot-relative path
// so resolveMediaPath() lands on data/media/in-use.mp4 (the in-use key). The
// unused.mp4 render is referenced by NO post.
const FUTURE = '2099-01-01T09:00:00Z';
fs.writeFileSync(path.join(plansDir, 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'mut-camp', path: 'data/plans/mut-camp/post-plan.json', active: true }],
}, null, 2));
fs.writeFileSync(path.join(campDir, 'post-plan.json'), JSON.stringify({
  campaign: 'Mut Camp',
  timezone: 'UTC',
  posts: [
    {
      id: 'p-uses-it', type: 'reel', platforms: ['instagram'], scheduledAt: FUTURE,
      path: 'data/media/in-use.mp4', caption: 'Uses the in-use render.',
      status: 'planned', approval: 'draft',
    },
  ],
}, null, 2));

// Helpers to (re)seed the two renders + their cover siblings before each block.
function seedRender(name) {
  fs.writeFileSync(path.join(mediaDir, name), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
}
function seedCover(mp4Name) {
  fs.writeFileSync(path.join(mediaDir, mp4Name.replace(/\.mp4$/, '.jpg')), Buffer.from([255, 216, 255, 224]));
}

const { deleteAsset, renameAsset } = await import('../lib/writes.mjs');
const { getActivity } = await import('../lib/scheduler.mjs');

const exists = (name) => fs.existsSync(path.join(mediaDir, name));
const latestAction = () => getActivity(1)[0]?.action || null;

try {
  ok(typeof deleteAsset === 'function', 'deleteAsset is exported from lib/writes.mjs');
  ok(typeof renameAsset === 'function', 'renameAsset is exported from lib/writes.mjs');

  // =========================== delete_asset ==================================

  // ---- (1) unused delete removes file + cover and logs 'asset-delete' --------
  seedRender('unused.mp4');
  seedCover('unused.mp4');
  ok(exists('unused.mp4') && exists('unused.jpg'), 'precondition: unused.mp4 + its cover exist');
  const del = await deleteAsset({ file: 'unused.mp4', actor: 'owner' });
  ok(del.ok === true, 'delete of an UNUSED asset returns ok:true');
  ok(del.deleted && del.deleted.file === 'unused.mp4', 'result carries deleted.file');
  ok(!exists('unused.mp4'), 'the .mp4 is removed');
  ok(!exists('unused.jpg'), 'the paired .jpg cover sibling is removed too');
  ok(latestAction() === 'asset-delete', "one 'asset-delete' activity row is written");

  // ---- (2) in-use delete WITHOUT confirm => needs_confirm naming the post ----
  seedRender('in-use.mp4');
  const blocked = await deleteAsset({ file: 'in-use.mp4', actor: 'owner' });
  ok(blocked.code === 'needs_confirm', 'delete of an IN-USE asset without confirm => needs_confirm');
  ok(/p-uses-it/.test(blocked.message) && /mut-camp/.test(blocked.message),
    'the needs_confirm message names the using post (campaign/postId)');
  ok(exists('in-use.mp4'), 'nothing is deleted while it is refused');

  // ---- (2b) in-use delete WITH confirm deletes (plan row left dangling) ------
  const forced = await deleteAsset({ file: 'in-use.mp4', actor: 'owner', confirm: true });
  ok(forced.ok === true, 'delete of an in-use asset WITH confirm:true returns ok');
  ok(!exists('in-use.mp4'), 'the in-use render is removed with confirm');
  // The plan post still references it (left dangling by design, mirroring deletePost force).
  const planAfter = JSON.parse(fs.readFileSync(path.join(campDir, 'post-plan.json'), 'utf8'));
  ok(planAfter.posts[0].path === 'data/media/in-use.mp4', 'the plan row is left dangling (not auto-rewritten)');

  // ---- (3) missing source => invalid_input (before any fs touch) -------------
  const gone = await deleteAsset({ file: 'no-such.mp4', actor: 'owner' });
  ok(gone.code === 'invalid_input' && /no-such\.mp4/.test(gone.message),
    'delete of a missing source => invalid_input naming the file');

  // ---- (4) missing actor => invalid_input ------------------------------------
  seedRender('actorless.mp4');
  const noActor = await deleteAsset({ file: 'actorless.mp4' });
  ok(noActor.code === 'invalid_input', 'delete with no actor => invalid_input');
  ok(exists('actorless.mp4'), 'a missing-actor delete touches no file');

  // ---- (5) traversal / bad name => invalid_input before any fs touch ---------
  const trav = await deleteAsset({ file: '../secret.mp4', actor: 'owner' });
  ok(trav.code === 'invalid_input', 'delete of a path-traversal name => invalid_input');
  const seg = await deleteAsset({ file: 'a/b.mp4', actor: 'owner' });
  ok(seg.code === 'invalid_input', 'delete of a name with a path segment => invalid_input');

  // =========================== rename_asset ==================================

  // ---- (6) rename moves the file + its cover and logs 'asset-rename' ---------
  seedRender('old.mp4');
  seedCover('old.mp4');
  const ren = await renameAsset({ file: 'old.mp4', toName: 'new.mp4', actor: 'owner' });
  ok(ren.ok === true, 'rename of an UNUSED asset returns ok:true');
  ok(!exists('old.mp4') && exists('new.mp4'), 'the .mp4 is renamed');
  ok(!exists('old.jpg') && exists('new.jpg'), 'the paired .jpg cover is renamed to match');
  ok(ren.renamed && ren.renamed.from === 'old.mp4' && ren.renamed.to === 'new.mp4', 'result carries renamed.{from,to}');
  ok(latestAction() === 'asset-rename', "one 'asset-rename' activity row is written");

  // ---- (7) rename validates BOTH names (traversal + bad name) ----------------
  seedRender('valid.mp4');
  const travSrc = await renameAsset({ file: '../x.mp4', toName: 'ok.mp4', actor: 'owner' });
  ok(travSrc.code === 'invalid_input', 'rename with a traversal SOURCE => invalid_input');
  const travDst = await renameAsset({ file: 'valid.mp4', toName: '../x.mp4', actor: 'owner' });
  ok(travDst.code === 'invalid_input', 'rename with a traversal TARGET => invalid_input');
  ok(exists('valid.mp4'), 'a rejected rename moves nothing');

  // ---- (8) rename refuses an extension change (away from the source ext) -----
  const extChange = await renameAsset({ file: 'valid.mp4', toName: 'valid.mov', actor: 'owner' });
  ok(extChange.code === 'invalid_input', 'rename that changes the extension => invalid_input');
  ok(exists('valid.mp4') && !exists('valid.mov'), 'an extension-change rename moves nothing');

  // ---- (9) rename refuses overwrite (existing toName) ------------------------
  seedRender('taken.mp4');
  const overwrite = await renameAsset({ file: 'valid.mp4', toName: 'taken.mp4', actor: 'owner' });
  ok(overwrite.code === 'invalid_input' && /taken\.mp4/.test(overwrite.message),
    'rename to an EXISTING name => invalid_input (never overwrite)');
  ok(exists('valid.mp4') && exists('taken.mp4'), 'neither file is touched on a refused overwrite');

  // ---- (10) rename of an in-use asset is confirm-gated -----------------------
  seedRender('in-use.mp4'); // re-create the in-use render (the post still points here)
  const renBlocked = await renameAsset({ file: 'in-use.mp4', toName: 'renamed-in-use.mp4', actor: 'owner' });
  ok(renBlocked.code === 'needs_confirm', 'rename of an IN-USE asset without confirm => needs_confirm');
  ok(/p-uses-it/.test(renBlocked.message), 'the rename needs_confirm message names the using post');
  ok(exists('in-use.mp4') && !exists('renamed-in-use.mp4'), 'a refused in-use rename moves nothing');
  const renForced = await renameAsset({ file: 'in-use.mp4', toName: 'renamed-in-use.mp4', actor: 'owner', confirm: true });
  ok(renForced.ok === true, 'rename of an in-use asset WITH confirm:true returns ok');
  ok(!exists('in-use.mp4') && exists('renamed-in-use.mp4'), 'the in-use render is renamed with confirm');

  // ---- (11) rename missing source => invalid_input --------------------------
  const renGone = await renameAsset({ file: 'no-such.mp4', toName: 'whatever.mp4', actor: 'owner' });
  ok(renGone.code === 'invalid_input' && /no-such\.mp4/.test(renGone.message),
    'rename of a missing source => invalid_input naming the file');

  // ---- (12) rename missing actor => invalid_input ---------------------------
  const renNoActor = await renameAsset({ file: 'taken.mp4', toName: 'taken2.mp4' });
  ok(renNoActor.code === 'invalid_input', 'rename with no actor => invalid_input');
  ok(exists('taken.mp4') && !exists('taken2.mp4'), 'a missing-actor rename touches no file');

  console.log(`[asset-mutate] OK - delete+rename confirm-gated, in-use-protected, traversal-safe, cover-paired, one activity entry each (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
