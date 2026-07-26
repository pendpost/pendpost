#!/usr/bin/env node
// test/reddit-warmth-persist.test.mjs - spec 37 review fix #1 (warmth clobber window).
//
// The bug: the reddit engine subprocess wrote state.reddit.warmth to state.json directly,
// but the long-lived server caches state per root and its scheduler tick loadState()+
// saveState()s from the STALE cache every 60s, atomically rewriting state.json WITHOUT the
// subprocess's warmth key -> the app fail-closes to cold (Offene Aktionen + "Manuell") while
// the engine reads live warmth and AUTO-FIRES = a duplicate-post window.
//
// The fix: NEVER write warmth from the subprocess. Persist it SERVER-SIDE, in-process
// (lib/state.mjs persistRedditWarmth), through the server's OWN cached state object, so a
// subsequent server-side write (the scheduler tick) PRESERVES it. This test proves warmth
// survives that subsequent write, AND that the engine source no longer writes state.json.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-warmth-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const { persistRedditWarmth, loadState, saveState } = await import('../lib/state.mjs');
const statePath = path.join(WS, 'state.json');
const WARMTH = { ageDays: 400, linkKarma: 3000, commentKarma: 2000, karma: 5000, checkedAt: '2026-07-12T00:00:00Z' };

try {
  // 1. persistRedditWarmth writes state.reddit.warmth through the server cache.
  persistRedditWarmth(WARMTH);
  ok(loadState().reddit.warmth.karma === 5000, 'persistRedditWarmth stores warmth in the cached state');
  ok(JSON.parse(fs.readFileSync(statePath, 'utf8')).reddit.warmth.karma === 5000, 'warmth is written to state.json');

  // 2. A SUBSEQUENT server-side write (a scheduler tick: loadState -> mutate -> saveState)
  // must PRESERVE reddit.warmth (the no-clobber proof - this is what the old subprocess
  // write lost every 60s).
  const s = loadState();
  s.activity = Array.isArray(s.activity) ? s.activity : [];
  s.activity.push({ ts: new Date().toISOString(), action: 'scheduler-run', ok: true });
  saveState();
  const disk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  ok(disk.reddit && disk.reddit.warmth && disk.reddit.warmth.karma === 5000, 'reddit.warmth SURVIVES a subsequent scheduler-tick state write (no clobber)');
  ok(disk.activity.length === 1, 'the scheduler tick DID write its own change (proving it really re-saved)');

  // 3. A re-persist (a later presubmit/discover) updates warmth in place, still surviving.
  persistRedditWarmth({ ...WARMTH, karma: 6000 });
  const s2 = loadState(); s2.activity.push({ ts: 'x', action: 'y', ok: true }); saveState();
  ok(JSON.parse(fs.readFileSync(statePath, 'utf8')).reddit.warmth.karma === 6000, 'a refreshed warmth also survives a later tick write');

  // 4. The ENGINE no longer writes state.json (the clobber source is removed): the source
  // must not import/call lib/state.mjs from the reddit engine.
  const engineSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'reddit-social.mjs'), 'utf8');
  // No ACTUAL import/dynamic-import of state.mjs (a comment mention is fine).
  ok(!/(?:from|import\()\s*['"][^'"]*state\.mjs/.test(engineSrc), 'scripts/reddit-social.mjs no longer imports lib/state.mjs (no subprocess state write)');
  ok(!/persistWarmth\s*\(/.test(engineSrc), 'the subprocess persistWarmth helper/call is gone');
  ok(/RUN\.warmth\s*=/.test(engineSrc) && /discoverRow\.warmth\s*=/.test(engineSrc), 'the engine RETURNS warmth (connect + discover) for the server to persist');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
