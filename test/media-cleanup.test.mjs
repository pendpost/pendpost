#!/usr/bin/env node
// test/media-cleanup.test.mjs - docs/specs/media-cleanup.md. The reference-counting rules that
// decide whether a local video may be deleted, the dry run, the run, and the missing-media
// self-heal. The incident behind it (2026-11-05): an IG reel had posted, its YouTube twin was
// still planned, the file was deleted by hand, and the twin broke.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-media-cleanup-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const { planCleanup, mediaCleanup, classifyPost, healMissingMedia, findMissingMedia, restoreTargetOk } = await import('../lib/media-cleanup.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const { setConfig, getConfig } = await import('../lib/config.mjs');
const { pendpostHealth } = await import('../lib/writes.mjs');

const DAY = 24 * 3600 * 1000;
const NOW = Date.now();
const ago = (days) => new Date(NOW - days * DAY).toISOString();
const ahead = (days) => new Date(NOW + days * DAY).toISOString();
const mediaDir = path.join(WS, 'data', 'media');
const plansDir = path.join(WS, 'data', 'plans');

// A fresh workspace per test: media files (aged 30 days unless told otherwise) + plans.
function setup({ files = {}, plans = {}, manifest = null, trash = {} }) {
  fs.rmSync(path.join(WS, 'data'), { recursive: true, force: true });
  fs.rmSync(path.join(WS, 'state.json'), { force: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  for (const [name, spec] of Object.entries(files)) {
    const abs = path.join(mediaDir, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, spec.content || `bytes of ${name}`);
    const t = (NOW - (spec.ageDays ?? 30) * DAY) / 1000;
    fs.utimesSync(abs, t, t);
  }
  const entries = [];
  for (const [id, posts] of Object.entries(plans)) {
    fs.mkdirSync(path.join(plansDir, id), { recursive: true });
    fs.writeFileSync(path.join(plansDir, id, 'post-plan.json'), JSON.stringify({ campaign: id, timezone: 'UTC', posts }, null, 2));
    entries.push({ id, path: `data/plans/${id}/post-plan.json`, active: true });
  }
  for (const [id, list] of Object.entries(trash)) {
    fs.mkdirSync(path.join(plansDir, id), { recursive: true });
    fs.writeFileSync(path.join(plansDir, id, 'post-plan.trash.json'), JSON.stringify({ campaign: id, entries: list }, null, 2));
  }
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, 'active-plans.json'), JSON.stringify({ plans: manifest || entries }, null, 2));
  // The state cache is per root and survives the file delete: reset it in memory too.
  const st = loadState();
  for (const k of Object.keys(st)) delete st[k];
  st.assets = {};
  saveState();
}

const posted = (id, file, days, extra = {}) => ({ id, type: 'reel', platforms: ['instagram'], path: `data/media/${file}`, status: 'posted', postedAt: ago(days), scheduledAt: ago(days), approval: 'approved', ...extra });
const planned = (id, file, extra = {}) => ({ id, type: 'reel', platforms: ['youtube'], path: `data/media/${file}`, status: 'planned', scheduledAt: ahead(3), approval: 'approved', ...extra });
const names = (rows) => rows.map((r) => r.file).sort();
const keptReason = (plan, file) => plan.kept.find((k) => k.file === file)?.reason;

test('twin posts sharing one file: a posted reel keeps its file while the YouTube twin is still planned', () => {
  setup({
    files: { 'wythe.mp4': {} },
    plans: {
      'knowledge-reels': [posted('ig-wythe', 'wythe.mp4', 20)],
      'knowledge-yt': [planned('yt-wythe', 'wythe.mp4')],
    },
  });
  const plan = planCleanup({ graceDays: 7, now: NOW });
  assert.equal(plan.deletable.length, 0);
  assert.equal(keptReason(plan, 'wythe.mp4'), 'needed');
  assert.match(plan.kept[0].detail, /knowledge-yt\/yt-wythe/);
});

test('twin posts sharing one file: deletable once every twin is done and the grace passed', () => {
  setup({
    files: { 'wythe.mp4': {} },
    plans: {
      'knowledge-reels': [posted('ig-wythe', 'wythe.mp4', 20)],
      'knowledge-yt': [posted('yt-wythe', 'wythe.mp4', 10, { platforms: ['youtube'], ytVideoId: 'abc' })],
    },
  });
  const plan = planCleanup({ graceDays: 7, now: NOW });
  assert.deepEqual(names(plan.deletable), ['wythe.mp4']);
  assert.equal(plan.deletable[0].posts.length, 2);
});

test('a pending post keeps the file, also in an inactive campaign and in a plan the manifest does not list', () => {
  setup({
    files: { 'a.mp4': {}, 'b.mp4': {} },
    plans: { live: [posted('ig-a', 'a.mp4', 30), posted('ig-b', 'b.mp4', 30)], parked: [planned('yt-a', 'a.mp4')], loose: [{ ...planned('li-b', 'b.mp4'), status: 'scheduled' }] },
    manifest: [
      { id: 'live', path: 'data/plans/live/post-plan.json', active: true },
      { id: 'parked', path: 'data/plans/parked/post-plan.json', active: false },
      // 'loose' is on disk but not listed: it still counts.
    ],
  });
  const plan = planCleanup({ graceDays: 7, now: NOW });
  assert.equal(plan.deletable.length, 0);
  assert.equal(keptReason(plan, 'a.mp4'), 'needed');
  assert.equal(keptReason(plan, 'b.mp4'), 'needed');
});

test('a natively scheduled YouTube post (ytVideoId, scheduled) does not keep the file; without the id it does', () => {
  setup({
    files: { 'native.mp4': {}, 'pending.mp4': {} },
    plans: {
      ig: [posted('ig-native', 'native.mp4', 20), posted('ig-pending', 'pending.mp4', 20)],
      yt: [
        { ...planned('yt-native', 'native.mp4'), status: 'scheduled', ytVideoId: 'yt123' },
        { ...planned('yt-pending', 'pending.mp4'), status: 'scheduled' },
      ],
    },
  });
  const plan = planCleanup({ graceDays: 7, now: NOW });
  assert.deepEqual(names(plan.deletable), ['native.mp4']);
  assert.equal(keptReason(plan, 'pending.mp4'), 'needed');
  // A multi-lane scheduled post is NOT handed off by its YouTube id alone.
  assert.equal(classifyPost({ status: 'scheduled', platforms: ['youtube', 'instagram'], ytVideoId: 'x' }).state, 'needs');
  // Nor is one still owing an "also as story" target.
  assert.equal(classifyPost({ status: 'posted', postedAt: ago(30), type: 'reel', platforms: ['instagram'], alsoStory: true, igMediaId: '1' }).state, 'needs');
});

test('the grace is respected: from the newest done post, and from the file mtime', () => {
  setup({
    files: { 'recent.mp4': {}, 'old.mp4': {}, 'touched.mp4': { ageDays: 1 } },
    plans: { c: [posted('p1', 'recent.mp4', 30), posted('p2', 'recent.mp4', 3), posted('p3', 'old.mp4', 30), posted('p4', 'touched.mp4', 30)] },
  });
  const seven = planCleanup({ graceDays: 7, now: NOW });
  assert.deepEqual(names(seven.deletable), ['old.mp4']);
  assert.equal(keptReason(seven, 'recent.mp4'), 'in-grace');
  assert.equal(keptReason(seven, 'touched.mp4'), 'recently-changed');
  const two = planCleanup({ graceDays: 2, now: NOW });
  assert.deepEqual(names(two.deletable), ['old.mp4', 'recent.mp4']);
  const zero = planCleanup({ graceDays: 0, now: NOW });
  assert.deepEqual(names(zero.deletable), ['old.mp4', 'recent.mp4', 'touched.mp4']);
});

test('references count by any field, -4x5 variants are separate files, unreferenced and non-video files are kept', () => {
  setup({
    files: { 'x.mp4': {}, 'x-4x5.mp4': {}, 'carousel.mp4': {}, 'odd.mp4': {}, 'stray.mp4': {}, 'x.jpg': {}, 'slide.png': {} },
    plans: {
      c: [
        posted('ig-x', 'x.mp4', 30, { cover: { path: 'data/media/x.jpg' } }),
        planned('li-x', 'x-4x5.mp4', { platforms: ['linkedin'] }),
        { id: 'album', type: 'carousel', status: 'planned', scheduledAt: ahead(1), mediaItems: [{ path: 'data/media/slide.png' }, { file: 'carousel.mp4' }] },
        { id: 'weird', type: 'text', status: 'planned', scheduledAt: ahead(1), someFutureField: { nested: ['https://cdn.example/x/odd.mp4?v=2'] } },
      ],
    },
  });
  const plan = planCleanup({ graceDays: 7, now: NOW });
  assert.deepEqual(names(plan.deletable), ['x.mp4']);
  assert.equal(keptReason(plan, 'x-4x5.mp4'), 'needed');
  assert.equal(keptReason(plan, 'carousel.mp4'), 'needed');
  assert.equal(keptReason(plan, 'odd.mp4'), 'needed');
  assert.equal(keptReason(plan, 'stray.mp4'), 'unreferenced');
  // Images and covers are never candidates at all.
  assert.ok(!plan.kept.some((k) => k.file.endsWith('.jpg') || k.file.endsWith('.png')));
});

test('deleted posts count from trashedAt; rejected posts are done; a done post with no time keeps the file', () => {
  setup({
    files: { 'trashed-old.mp4': {}, 'trashed-new.mp4': {}, 'rejected.mp4': {}, 'timeless.mp4': {} },
    plans: { c: [
      { ...planned('r', 'rejected.mp4'), approval: 'rejected', approvalAt: ago(20) },
      { id: 't', type: 'reel', path: 'data/media/timeless.mp4', status: 'posted' },
    ] },
    trash: { c: [
      { post: planned('d1', 'trashed-old.mp4'), trashedAt: ago(20) },
      { post: planned('d2', 'trashed-new.mp4'), trashedAt: ago(1) },
    ] },
  });
  const plan = planCleanup({ graceDays: 7, now: NOW });
  assert.deepEqual(names(plan.deletable), ['rejected.mp4', 'trashed-old.mp4']);
  assert.equal(keptReason(plan, 'trashed-new.mp4'), 'in-grace');
  assert.equal(keptReason(plan, 'timeless.mp4'), 'no-time');
});

test('an unreadable plan file aborts the run: nothing is deleted', async () => {
  setup({ files: { 'a.mp4': {} }, plans: { c: [posted('p', 'a.mp4', 30)] } });
  fs.mkdirSync(path.join(plansDir, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(plansDir, 'broken', 'post-plan.json'), '{ not json');
  const plan = planCleanup({ graceDays: 7, now: NOW });
  assert.equal(plan.ok, false);
  assert.equal(plan.deletable.length, 0);
  const res = await mediaCleanup({ dryRun: false, actor: 'agent:test' });
  assert.equal(res.code, 'manifest_error');
  assert.ok(fs.existsSync(path.join(mediaDir, 'a.mp4')));
});

test('dry run deletes nothing; a run deletes, logs bytes, keeps the sha256 and the cover', async () => {
  setup({
    files: { 'gone.mp4': { content: 'x'.repeat(5000) }, 'gone.jpg': {}, 'keep.mp4': {} },
    plans: { c: [posted('p1', 'gone.mp4', 30), planned('p2', 'keep.mp4')] },
  });
  const st = loadState();
  const goneAbs = path.join(mediaDir, 'gone.mp4');
  st.fileHashes = { [goneAbs]: { sha256: 'a'.repeat(64), bytes: 5000, mtimeMs: 1 } };
  st.assets[goneAbs] = { probe: {} };
  saveState();

  const dry = await mediaCleanup({ actor: 'agent:test' });
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.enabled, false); // works with the setting off
  assert.deepEqual(names(dry.deletable), ['gone.mp4']);
  assert.equal(dry.bytesDeletable, 5000);
  assert.ok(fs.existsSync(goneAbs), 'dry run must not delete');
  assert.equal(dry.deleted, undefined);

  const run = await mediaCleanup({ dryRun: false, actor: 'agent:test', fetchMedia: async () => ({ present: false }) });
  assert.equal(run.ok, true);
  assert.equal(run.bytesFreed, 5000);
  assert.deepEqual(run.deleted.map((d) => d.file), ['gone.mp4']);
  assert.ok(!fs.existsSync(goneAbs));
  assert.ok(fs.existsSync(path.join(mediaDir, 'gone.jpg')), 'the cover stays');
  assert.ok(fs.existsSync(path.join(mediaDir, 'keep.mp4')));
  const after = loadState();
  assert.equal(after.fileHashes[goneAbs].sha256, 'a'.repeat(64), 'the sha256 survives for a later restore');
  assert.equal(after.assets[goneAbs], undefined);
  const row = after.activity.find((a) => a.action === 'media-cleanup');
  assert.ok(row && row.bytesFreed === 5000 && row.files[0].file === 'gone.mp4');
  assert.match(row.errorMessage, /gone\.mp4/);
  assert.ok(after.mediaCleanup.lastRunAt);
});

test('config: posting.mediaCleanup validates and shallow-merges', () => {
  setup({});
  let cfg = getConfig();
  assert.deepEqual(cfg.posting.mediaCleanup, { enabled: false, graceDays: 7 });
  const bad = setConfig({ ifRev: cfg.rev, actor: 'agent:test', set: { posting: { mediaCleanup: { graceDays: -1 } } } });
  assert.equal(bad.code, 'invalid_input');
  const bad2 = setConfig({ ifRev: cfg.rev, actor: 'agent:test', set: { posting: { mediaCleanup: { enabled: 'yes' } } } });
  assert.equal(bad2.code, 'invalid_input');
  cfg = setConfig({ ifRev: cfg.rev, actor: 'agent:test', set: { posting: { mediaCleanup: { graceDays: 3 } } } });
  assert.equal(cfg.ok, true);
  cfg = setConfig({ ifRev: cfg.rev, actor: 'agent:test', set: { posting: { mediaCleanup: { enabled: true } } } });
  assert.deepEqual(cfg.posting.mediaCleanup, { enabled: true, graceDays: 3 });
  fs.rmSync(path.join(WS, 'config.json'), { force: true });
});

// ---------- self-heal ----------

function serve(bytes) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => { res.writeHead(200); res.end(bytes); });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/blob` }));
  });
}

test('self-heal restores a missing file an upcoming post needs, verified by sha256', async () => {
  const bytes = Buffer.from('the real reel bytes');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  setup({ plans: { c: [planned('yt-x', 'lost.mp4'), posted('ig-x', 'other.mp4', 1)] } });
  const abs = path.join(mediaDir, 'lost.mp4');
  const st = loadState();
  st.fileHashes = { [abs]: { sha256: sha, bytes: bytes.length, mtimeMs: 1 } };
  saveState();
  assert.deepEqual(findMissingMedia().map((m) => m.postId), ['yt-x']); // the posted one is not owed
  const { server, url } = await serve(bytes);
  try {
    const out = await healMissingMedia({ fetchMedia: async (s) => (s === sha ? { present: true, url } : { present: false }) });
    assert.equal(out.restored.length, 1);
    assert.equal(out.missing.length, 0);
    assert.deepEqual(fs.readFileSync(abs), bytes);
    assert.ok(loadState().activity.some((a) => a.action === 'media-restore' && a.postId === 'yt-x'));
    assert.deepEqual(fs.readdirSync(mediaDir).filter((n) => n.includes('.tmp')), []);
  } finally { server.close(); }
});

test('self-heal never keeps a download that does not match the sha256', async () => {
  setup({ plans: { c: [planned('yt-x', 'lost.mp4')] } });
  const abs = path.join(mediaDir, 'lost.mp4');
  const st = loadState();
  st.fileHashes = { [abs]: { sha256: 'b'.repeat(64), bytes: 3, mtimeMs: 1 } };
  saveState();
  const { server, url } = await serve(Buffer.from('tampered'));
  try {
    const out = await healMissingMedia({ fetchMedia: async () => ({ present: true, url }) });
    assert.equal(out.missing[0].reason, 'hash-mismatch');
    assert.ok(!fs.existsSync(abs));
    assert.deepEqual(fs.readdirSync(mediaDir), []);
  } finally { server.close(); }
});

test('self-heal degrades cleanly and pendpost_health names why a file cannot come back', async () => {
  setup({ plans: { c: [planned('yt-purged', 'purged.mp4'), planned('yt-old-cloud', 'old.mp4'), planned('yt-never', 'never.mp4'), planned('yt-out', '../../outside.mp4')] } });
  const st = loadState();
  st.fileHashes = {
    [path.join(mediaDir, 'purged.mp4')]: { sha256: 'c'.repeat(64) },
    [path.join(mediaDir, 'old.mp4')]: { sha256: 'd'.repeat(64) },
  };
  saveState();
  const fetchMedia = async (sha) => {
    if (sha === 'c'.repeat(64)) return { present: false };
    throw Object.assign(new Error('cloud POST /v1/content/fetch -> HTTP 404'), { code: 'http_error', status: 404 });
  };
  const out = await healMissingMedia({ fetchMedia });
  const why = Object.fromEntries(out.missing.map((m) => [m.postId, m.reason]));
  assert.deepEqual(why, { 'yt-purged': 'purged', 'yt-old-cloud': 'endpoint-missing', 'yt-never': 'never-uploaded' });
  // A path that climbs out of data/media is never a restore target.
  assert.ok(!('yt-out' in why));
  assert.equal(restoreTargetOk(path.join(mediaDir, '..', '..', 'outside.mp4'), mediaDir), false);
  assert.equal(restoreTargetOk(path.join(mediaDir, 'notes.sh'), mediaDir), false);

  const health = pendpostHealth({ includeSetup: false });
  const codes = health.blockerCodes.map((b) => b.code);
  assert.ok(codes.includes('blocker.mediaLost.purged'));
  assert.ok(codes.includes('blocker.mediaLost.endpointMissing'));
  assert.ok(codes.includes('blocker.mediaLost.neverUploaded'));
  assert.ok(health.blockers.some((b) => /yt-purged needs purged\.mp4/.test(b)));
  // Putting the file back clears its row at once, without waiting for the next sweep.
  fs.writeFileSync(path.join(mediaDir, 'purged.mp4'), 'back');
  assert.ok(!pendpostHealth({ includeSetup: false }).blockerCodes.some((b) => b.code === 'blocker.mediaLost.purged'));
});

test('self-heal with no cloud connection says so instead of failing', async () => {
  setup({ plans: { c: [planned('yt-x', 'lost.mp4')] } });
  const st = loadState();
  st.fileHashes = { [path.join(mediaDir, 'lost.mp4')]: { sha256: 'e'.repeat(64) } };
  saveState();
  const out = await healMissingMedia(); // the real fetchCloudMedia: no baseUrl / api key here
  assert.equal(out.missing[0].reason, 'no-cloud');
});
