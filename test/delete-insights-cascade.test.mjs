#!/usr/bin/env node
// test/delete-insights-cascade.test.mjs - AU-3: deletePost must cascade to
// state.insights.data so a deleted post's per-post insights rows don't linger,
// keyed on a post id that no longer exists in any plan.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib
// (util binds WORKSPACE_ROOT at import; mirrors test/asset-mutate.test.mjs). No
// clients.json -> the activeRoot() legacy single-client fallback resolves data/
// under WS.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-del-insights-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const dataDir = path.join(WS, 'data');
const plansDir = path.join(dataDir, 'plans');
const campDir = path.join(plansDir, 'del-camp');
fs.mkdirSync(campDir, { recursive: true });

const PAST = '2020-01-01T00:00:00Z';
fs.writeFileSync(path.join(plansDir, 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'del-camp', path: 'data/plans/del-camp/post-plan.json', active: true }],
}, null, 2));
fs.writeFileSync(path.join(campDir, 'post-plan.json'), JSON.stringify({
  campaign: 'del-camp',
  timezone: 'UTC',
  posts: [
    // p1 has no publish evidence - deletable without force.
    { id: 'p1', type: 'text', platforms: ['x'], caption: 'gone soon', status: 'planned', approval: 'draft', scheduledAt: PAST },
    // p2 is a sibling post left untouched, to prove the cascade is scoped to
    // the deleted post's OWN rows and never touches another post's insights.
    { id: 'p2', type: 'text', platforms: ['x'], caption: 'stays', status: 'planned', approval: 'draft', scheduledAt: PAST },
  ],
}, null, 2));

// Seed state.json with insights rows for BOTH p1 (multiple platforms) and p2,
// mirroring the real key shape fetchInsights() writes.
const now = '2026-06-16T08:00:00.000Z';
fs.writeFileSync(path.join(WS, 'state.json'), JSON.stringify({
  insights: {
    lastFetch: now,
    data: {
      'del-camp/p1/x': { campaign: 'del-camp', postId: 'p1', platform: 'x', metrics: { likes: 12 }, fetchedAt: now, history: [] },
      'del-camp/p1/instagram': { campaign: 'del-camp', postId: 'p1', platform: 'instagram', metrics: { plays: 300 }, fetchedAt: now, history: [] },
      'del-camp/p2/x': { campaign: 'del-camp', postId: 'p2', platform: 'x', metrics: { likes: 5 }, fetchedAt: now, history: [] },
    },
  },
}, null, 2));

const { deletePost } = await import('../lib/writes.mjs');
const { loadState } = await import('../lib/state.mjs');

try {
  ok(typeof deletePost === 'function', 'deletePost is exported from lib/writes.mjs');

  // Precondition: both p1 rows and the p2 row are present.
  const before = loadState();
  ok(Object.keys(before.insights.data).length === 3, 'precondition: 3 stored insights rows (2 for p1, 1 for p2)');

  const del = await deletePost({ campaign: 'del-camp', postId: 'p1', actor: 'owner' });
  ok(del.ok === true, `deletePost(p1) returns ok:true (${JSON.stringify(del)})`);

  const after = loadState();
  ok(!('del-camp/p1/x' in after.insights.data), 'deleted post p1: the x insights row is gone');
  ok(!('del-camp/p1/instagram' in after.insights.data), 'deleted post p1: the instagram insights row is ALSO gone (every platform for that post)');
  ok('del-camp/p2/x' in after.insights.data, 'a SIBLING post (p2) keeps its own insights row untouched');
  ok(Object.keys(after.insights.data).length === 1, 'only the deleted post\'s rows were removed (1 row left)');

  // Deleting a post with NO stored insights at all must still succeed cleanly
  // (the best-effort cascade must never throw on an absent match).
  const del2 = await deletePost({ campaign: 'del-camp', postId: 'p2', actor: 'owner' });
  ok(del2.ok === true, `deletePost(p2) returns ok:true (${JSON.stringify(del2)})`);
  const after2 = loadState();
  ok(Object.keys(after2.insights.data).length === 0, 'deleting the last post with insights leaves an empty (not missing) insights.data map');

  console.log(`[delete-insights-cascade] OK - deletePost cascades to state.insights.data, scoped per-post, never touches a sibling (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
