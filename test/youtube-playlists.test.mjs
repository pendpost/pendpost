#!/usr/bin/env node
// test/youtube-playlists.test.mjs - YouTube playlists (spec 15, Pattern P3 engine
// verbs + P4 write pair + read tool + P9). Proves, mock-mode + credential-free:
//   1. playlist-create returns { ok:true, id, title }.
//   2. playlist-add resolves the video id from --plan --only -> post.ytVideoId
//      (cmdFeatured's exact resolution pattern) and returns an item id.
//   3. a second add against the SAME plan entry + playlist reports duplicate:true
//      (no second insert) - the mock persists the membership on the SAME
//      post.ytPlaylistItems echo the live engine writes (engine-owned field), so
//      the plan file on disk gains the entry.
//   4. playlists-list returns the canned list ({id,title,privacy,itemCount}).
//   5. an ungranted token (PENDPOST_MOCK_UNGRANTED=youtube) degrades every verb to
//      a { ok:false, error:'needs_scope', scope:'youtube' } RESULT ROW while the
//      top envelope stays ok:true (P9, never a throw) - mirrors the discover/
//      demographics convention, not the comments/reply top-level-ok:false one.
//   6. source-level: ytPlaylistItems is engine-owned (ENGINE_OWNED_FIELDS), the
//      three verbs are wired into COMMANDS, and playlist-create/playlist-add are
//      NOT in the plan-required guard (they take --title/--id, not --plan).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const engine = path.join(REPO, 'scripts', 'yt-social.mjs');
const ytSrc = fs.readFileSync(engine, 'utf8');

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-yt-playlists-'));
const planPath = path.join(WS, 'data', 'plans', 'c', 'post-plan.json');
// Point WORKSPACE_ROOT (frozen at first lib import) + the mock driver at WS BEFORE any
// lib/writes.mjs import, so the REST/lib read-model case below resolves activeRoot() ->
// WS and the engine subprocess runs credential-free.
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

function writePlan(post) {
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, JSON.stringify({
    campaign: 'c', timezone: 'UTC',
    posts: [{ id: 'yt1', type: 'youtube-short', platforms: ['youtube'], scheduledAt: '2099-01-01T09:00:00Z', title: 't', description: 'd', status: 'scheduled', approval: 'approved', ...post }],
  }, null, 2));
}
function readPlanPost() {
  return JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0];
}

function runYt(args, extraEnv = {}) {
  const out = execFileSync(process.execPath, [engine, ...args], {
    cwd: REPO,
    env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: 'mock', ...extraEnv },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}
const row = (envelope, action) => (envelope.results || []).find((r) => r.action === action);

try {
  // ===== (0) source-level wiring =====
  ok(/ENGINE_OWNED_FIELDS = \[[^\]]*'ytPlaylistItems'/.test(ytSrc), 'ytPlaylistItems is engine-owned (field-merge save preserves it)');
  ok(/'playlists-list':\s*cmdPlaylistsList/.test(ytSrc) && /'playlist-create':\s*cmdPlaylistCreate/.test(ytSrc) && /'playlist-add':\s*cmdPlaylistAdd/.test(ytSrc), 'playlists-list/playlist-create/playlist-add are wired into the COMMANDS map');
  const guardLine = ytSrc.match(/\[['"]schedule['"][^\]]*\]\.includes\(args\._\[0\]\)/);
  ok(guardLine && !/playlist-create|playlist-add/.test(guardLine[0]), 'playlist-create/playlist-add are NOT in the plan-required guard (they take --title/--id, not --plan)');

  // ===== (1) playlists-list: the canned list =====
  writePlan({});
  const list = runYt(['playlists-list', '--json']);
  const listRow = row(list, 'playlists-list');
  ok(list.ok === true && listRow?.ok === true, 'mock playlists-list envelope + row resolve ok:true');
  ok(Array.isArray(listRow.playlists) && listRow.playlists.length > 0, 'playlists-list returns a non-empty playlists[]');
  ok(listRow.playlists.every((p) => typeof p.id === 'string' && typeof p.title === 'string' && 'privacy' in p && 'itemCount' in p), 'every playlist carries { id, title, privacy, itemCount }');

  // ===== (2) playlist-create: returns an id + echoes the title =====
  const created = runYt(['playlist-create', '--title', 'Launch Series', '--json']);
  const createRow = row(created, 'playlist-create');
  ok(createRow?.ok === true && typeof createRow.id === 'string' && createRow.id, 'mock playlist-create returns { ok:true, id }');
  ok(createRow.title === 'Launch Series', 'playlist-create echoes back the requested title');

  // ===== (3) playlist-add: resolves ytVideoId from --plan --only, returns an item id =====
  writePlan({ ytVideoId: 'VID123' });
  const targetPlaylist = listRow.playlists[0].id;
  const added = runYt(['playlist-add', '--plan', planPath, '--only', 'yt1', '--playlist-id', targetPlaylist, '--json']);
  const addRow = row(added, 'playlist-add');
  ok(addRow?.ok === true && typeof addRow.id === 'string' && addRow.id, 'mock playlist-add returns { ok:true, id } (item id)');
  ok(addRow.videoId === 'VID123', 'playlist-add resolved the video id from the plan post\'s ytVideoId (no --id passed)');
  ok(addRow.playlistId === targetPlaylist && addRow.duplicate !== true, 'first add is not flagged duplicate');
  ok((readPlanPost().ytPlaylistItems || []).some((e) => e.playlistId === targetPlaylist && e.itemId === addRow.id), 'the post-plan on disk gained the ytPlaylistItems echo { playlistId, itemId } (engine-owned merge)');

  // ===== (4) a second add against the SAME plan entry + playlist -> duplicate:true =====
  const addedAgain = runYt(['playlist-add', '--plan', planPath, '--only', 'yt1', '--playlist-id', targetPlaylist, '--json']);
  const addAgainRow = row(addedAgain, 'playlist-add');
  ok(addAgainRow?.ok === true && addAgainRow.duplicate === true, 'a second add to the same playlist reports duplicate:true (no double-add)');
  ok(addAgainRow.id === addRow.id, 'the duplicate row echoes the SAME item id as the original add');
  ok((readPlanPost().ytPlaylistItems || []).length === 1, 'the duplicate add did not append a second ytPlaylistItems entry');

  // ===== (4b) echo guard: an explicit videoId override that ISN'T the post's
  // published video must NOT record a false membership on that post =====
  writePlan({ ytVideoId: 'VID123' });
  const otherPlaylist = listRow.playlists[1].id;
  const mismatch = runYt(['playlist-add', '--plan', planPath, '--only', 'yt1', '--id', 'DIFFERENT_VID', '--playlist-id', otherPlaylist, '--json']);
  const mismatchRow = row(mismatch, 'playlist-add');
  ok(mismatchRow?.ok === true && mismatchRow.videoId === 'DIFFERENT_VID', 'an ad-hoc videoId override still adds (returns the override video id)');
  ok(!(readPlanPost().ytPlaylistItems || []).length, 'a videoId that isn\'t the post\'s ytVideoId writes NO ytPlaylistItems echo (no false membership)');

  // ===== (5) P9: an ungranted token degrades every verb to a needs_scope ROW,
  // top envelope stays ok:true (never a throw) =====
  const ungrantedEnv = { PENDPOST_MOCK_UNGRANTED: 'youtube' };
  const listU = runYt(['playlists-list', '--json'], ungrantedEnv);
  ok(listU.ok === true, 'ungranted playlists-list: top envelope stays ok:true');
  ok(row(listU, 'playlists-list')?.ok === false && row(listU, 'playlists-list').error === 'needs_scope' && row(listU, 'playlists-list').scope === 'youtube', 'ungranted playlists-list ROW degrades to needs_scope:youtube (P9)');

  const createU = runYt(['playlist-create', '--title', 'X', '--json'], ungrantedEnv);
  ok(createU.ok === true, 'ungranted playlist-create: top envelope stays ok:true');
  ok(row(createU, 'playlist-create')?.ok === false && row(createU, 'playlist-create').error === 'needs_scope' && row(createU, 'playlist-create').scope === 'youtube', 'ungranted playlist-create ROW degrades to needs_scope:youtube (P9)');

  const addU = runYt(['playlist-add', '--plan', planPath, '--only', 'yt1', '--playlist-id', targetPlaylist, '--json'], ungrantedEnv);
  ok(addU.ok === true, 'ungranted playlist-add: top envelope stays ok:true');
  ok(row(addU, 'playlist-add')?.ok === false && row(addU, 'playlist-add').error === 'needs_scope' && row(addU, 'playlist-add').scope === 'youtube', 'ungranted playlist-add ROW degrades to needs_scope:youtube (P9)');

  // ===== (6) listYoutubePlaylists lib: a row-LESS crash envelope (a token-refresh
  // throw before any row is pushed) resolves ok:false, so the panel shows its ERROR
  // state - never the empty "no playlists" copy for a read that actually FAILED. We
  // point the youtube engine at a fake that emits exactly that crash envelope. =====
  const fakeEngine = path.join(WS, 'crash-engine.mjs');
  fs.writeFileSync(fakeEngine, "process.stdout.write(JSON.stringify({ ok:false, error:'token refresh failed: invalid_grant', results: [] }) + '\\n');\n");
  process.env.PENDPOST_YOUTUBE_ENGINE = fakeEngine;
  try {
    const { listYoutubePlaylists } = await import('../lib/writes.mjs');
    const crashed = await listYoutubePlaylists({});
    ok(crashed.ok === false && crashed.code === 'engine_failure', 'a row-less crash envelope resolves ok:false engine_failure (not a false-empty ok:true)');
  } finally {
    delete process.env.PENDPOST_YOUTUBE_ENGINE;
  }

  // ===== (7) REST/lib read-model path (YP-1 regression): youtubePlaylistAdd through
  // lib/writes.mjs against a SAVED plan, loaded via loadPlanStore -> normalizePost.
  // On that DTO the minted id lives at post.ids.ytVideoId; the raw top-level
  // post.ytVideoId is ALWAYS undefined, so the shipped `!post.ytVideoId` guard
  // rejected EVERY UI/REST add with "has no ytVideoId yet". The engine-driven cases
  // above never exercised this layer (they pass a raw --plan straight to the engine),
  // which is exactly why the regression shipped. This asserts the add SUCCEEDS:
  // the DTO video id resolves and an item id comes back. =====
  writePlan({ ytVideoId: 'VID123', status: 'posted', postedAt: '2099-01-01T09:05:00Z' });
  fs.writeFileSync(
    path.join(WS, 'data', 'plans', 'active-plans.json'),
    JSON.stringify({ plans: [{ id: 'c', path: 'data/plans/c/post-plan.json', active: true }] }, null, 2),
  );
  {
    const { youtubePlaylistAdd } = await import('../lib/writes.mjs');
    const restAdd = await youtubePlaylistAdd({ campaign: 'c', postId: 'yt1', playlistId: 'mock_playlist_series_a', actor: 'agent:test', clientId: 'default' });
    ok(restAdd.ok === true && typeof restAdd.id === 'string' && restAdd.id, 'REST path youtubePlaylistAdd resolves ytVideoId from the read-model DTO (post.ids.ytVideoId) and returns an item id - proving the UI/REST layer the engine test skipped');
    ok(restAdd.videoId === 'VID123', 'REST path resolved the minted video id VID123 from the DTO (not the always-undefined raw post.ytVideoId)');
    ok(restAdd.postId === 'yt1', 'REST path echoes the resolved postId back');
    ok((readPlanPost().ytPlaylistItems || []).some((e) => e.itemId === restAdd.id), 'the saved plan gained the ytPlaylistItems echo via the read-model add (engine-owned merge, video IS the post\'s own)');
  }

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[youtube-playlists] OK - list/create/add verbs, ytVideoId resolution, duplicate detection, engine-owned ytPlaylistItems echo, videoId-override echo guard, crash-envelope error shape, P9 needs_scope degrade (${pass} assertions).`);
} catch (err) {
  console.error(`[youtube-playlists] FAIL - ${err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
