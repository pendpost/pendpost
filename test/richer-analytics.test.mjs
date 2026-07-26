#!/usr/bin/env node
// test/richer-analytics.test.mjs - spec 08 (richer own-account analytics),
// Pattern P5, run credential-free through the REAL engine entrypoints + the
// REAL sweep.
//
// Proves, end-to-end:
//   1. linkedin's `insights` verb now ALSO returns `reach`/`engagement` (new
//      scalar keys on an already-swept lane - no sweep change needed).
//   2. youtube's `insights` verb ALSO returns `watchTimeMin`/`avgViewSec`; an
//      ungranted yt-analytics.readonly scope degrades that supplementary pair
//      to absent while the base statistics (views/likes/comments) still render
//      (P9 - the row stays ok:true, never dropped).
//   3. telegram is newly swept (ENGINES/LANES/lanesWithEvidence): its `insights`
//      verb returns ONE account-scoped `subscribers` row, merged into
//      state.insights.account.telegram by the GENERIC scope:'account' branch
//      in the per-post store loop (not the separate ACCOUNT_PASS spawn).
//   4. ghost is newly swept: its `insights` verb returns per-post
//      opened/sent/clicks metrics.
//   5. nostr is newly swept: its `insights` verb returns per-post
//      reactions/zaps counts, parsed from a mock relay frame - AND the
//      Node-20 (no global WebSocket) path degrades to empty metrics, never a
//      throw.
//   6. every new metric key resolves to a localized label (en + de-CH,
//      ß-free) - no raw-key fallback.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-richer-analytics-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_MOCK_UNGRANTED;

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'local', path: 'data/plans/local.json', active: true }],
}, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'plans', 'local.json'), JSON.stringify({
  campaign: 'local',
  posts: [
    { id: 'l1', platforms: ['linkedin'], status: 'posted', liPostId: 'urn:li:share:123', scheduledAt: '2020-01-01T00:00:00Z', caption: 'LI post' },
    { id: 'y1', platforms: ['youtube'], status: 'posted', ytVideoId: 'mockYtVideo1', scheduledAt: '2020-01-01T00:00:00Z', caption: 'YT post' },
    { id: 't1', platforms: ['telegram'], status: 'posted', tgMessageId: '4242', scheduledAt: '2020-01-01T00:00:00Z', caption: 'TG post' },
    { id: 'g1', platforms: ['ghost'], status: 'posted', ghostPostId: 'mockghost1', scheduledAt: '2020-01-01T00:00:00Z', title: 'Ghost post', body: 'body' },
    { id: 'n1', platforms: ['nostr'], status: 'posted', nostrEventId: 'a'.repeat(64), scheduledAt: '2020-01-01T00:00:00Z', caption: 'Nostr note' },
  ],
}, null, 2));

function runEngine(script, args, extraEnv = {}) {
  const out = execFileSync(process.execPath, [path.join(REPO, 'scripts', script), ...args], {
    cwd: REPO,
    env: { ...process.env, PENDPOST_ROOT: WS, ...extraEnv },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const { fetchInsights, getInsights, generateDigest } = await import('../lib/insights.mjs');
const { loadState } = await import('../lib/state.mjs');
const { makeT } = await import('../lib/i18n.mjs');

try {
  const planArg = ['--plan', path.join(WS, 'data', 'plans', 'local.json'), '--json', '--actor', 'pendpost'];

  // ---- 1. linkedin: reach/engagement on an already-swept lane -----------------
  const li = runEngine('linkedin-social.mjs', ['insights', ...planArg]);
  ok(li.ok === true && li.results.length === 1, 'linkedin insights emits one row');
  ok(typeof li.results[0].metrics.reach === 'number', 'linkedin metrics carries a numeric reach');
  ok(typeof li.results[0].metrics.engagement === 'number', 'linkedin metrics carries a numeric engagement');
  ok(typeof li.results[0].metrics.impressions === 'number', 'linkedin metrics still carries the pre-existing impressions field');

  // ---- 2. youtube: watchTimeMin/avgViewSec, degrading to absent when ungranted -
  const yt = runEngine('yt-social.mjs', ['insights', ...planArg]);
  ok(yt.ok === true && yt.results.length === 1, 'youtube insights emits one row');
  ok(typeof yt.results[0].metrics.watchTimeMin === 'number', 'youtube metrics carries a numeric watchTimeMin');
  ok(typeof yt.results[0].metrics.avgViewSec === 'number', 'youtube metrics carries a numeric avgViewSec');
  ok(typeof yt.results[0].metrics.views === 'number', 'youtube metrics still carries the pre-existing views field');

  const ytUng = runEngine('yt-social.mjs', ['insights', ...planArg], { PENDPOST_MOCK_UNGRANTED: 'youtube' });
  ok(ytUng.ok === true && ytUng.results[0].ok === true, 'youtube insights row stays ok:true when the supplementary analytics scope is ungranted');
  ok(!('watchTimeMin' in ytUng.results[0].metrics) && !('avgViewSec' in ytUng.results[0].metrics), 'ungranted: the supplementary watch-time fields are simply absent');
  ok(typeof ytUng.results[0].metrics.views === 'number', 'ungranted: the base statistics (views) still render (P9 - never drop the whole row)');

  // ---- 3. telegram: account-scoped subscribers, newly swept --------------------
  const tg = runEngine('telegram-social.mjs', ['insights', ...planArg]);
  ok(tg.ok === true && tg.results.length === 1, 'telegram insights emits exactly one row');
  const tgRow = tg.results[0];
  ok(tgRow.postId === null && tgRow.platform === 'telegram' && tgRow.scope === 'account', 'telegram row is account-scoped (postId:null, scope:account)');
  ok(typeof tgRow.metrics.subscribers === 'number', 'telegram row carries a numeric subscribers count');

  // ---- 4. ghost: per-post opened/sent/clicks, newly swept ----------------------
  const gh = runEngine('ghost-social.mjs', ['insights', ...planArg]);
  ok(gh.ok === true && gh.results.length === 1, 'ghost insights emits one row');
  const ghMetrics = gh.results[0].metrics;
  ok(typeof ghMetrics.opened === 'number' && typeof ghMetrics.sent === 'number' && typeof ghMetrics.clicks === 'number', 'ghost metrics carries numeric opened/sent/clicks');

  // ---- 5. nostr: per-post reactions/zaps, newly swept (MOCK driver values) -----
  const nr = runEngine('nostr-social.mjs', ['insights', ...planArg]);
  ok(nr.ok === true && nr.results.length === 1, 'nostr insights emits one row');
  const nrMetrics = nr.results[0].metrics;
  ok(typeof nrMetrics.reactions === 'number' && typeof nrMetrics.zaps === 'number', 'nostr metrics carries numeric reactions/zaps');

  // ---- 6. the REAL sweep wires all three newly-covered lanes + the account
  // merge for telegram, alongside the existing per-post lanes --------------------
  const sw = await fetchInsights();
  ok(sw.ok, 'sweep returns ok');
  const state = loadState();
  ok(Boolean(state.insights?.data?.['local/l1/linkedin']), 'sweep stores the linkedin per-post row');
  ok(Boolean(state.insights?.data?.['local/y1/youtube']), 'sweep stores the youtube per-post row');
  ok(Boolean(state.insights?.data?.['local/g1/ghost']), 'sweep stores the ghost per-post row (newly swept lane)');
  ok(Boolean(state.insights?.data?.['local/n1/nostr']), 'sweep stores the nostr per-post row (newly swept lane)');
  ok(!('local/t1/telegram' in (state.insights?.data || {})), 'telegram has no per-post row (it is account-scoped, not per-post)');
  ok(typeof state.insights?.account?.telegram?.metrics?.subscribers === 'number', 'sweep merges the telegram account row into state.insights.account.telegram via the generic scope:account branch');

  const env = getInsights();
  ok(typeof env.account?.telegram?.fetchedAt === 'string', 'getInsights() exposes the telegram account block with a fetchedAt timestamp');
  const liItem = env.items.find((i) => i.postId === 'l1');
  ok(liItem && typeof liItem.metrics.reach === 'number', 'getInsights() items expose the new linkedin reach field');
  const ghItem = env.items.find((i) => i.postId === 'g1');
  ok(ghItem && typeof ghItem.metrics.opened === 'number', 'getInsights() items expose the ghost opened field');
  const nrItem = env.items.find((i) => i.postId === 'n1');
  ok(nrItem && typeof nrItem.metrics.reactions === 'number', 'getInsights() items expose the nostr reactions field');

  // ---- 7. every new metric key resolves to a localized label, both locales -----
  const NEW_KEYS = ['engagement', 'subscribers', 'opened', 'sent', 'reactions', 'zaps', 'watchTimeMin', 'avgViewSec'];
  const tEn = makeT('en');
  const tDe = makeT('de-CH');
  for (const k of NEW_KEYS) {
    ok(tEn(`metric.${k}`) !== `metric.${k}`, `en: metric.${k} resolves to a localized label (no raw-key fallback)`);
    ok(tDe(`metric.${k}`) !== `metric.${k}`, `de-CH: metric.${k} resolves to a localized label (no raw-key fallback)`);
    ok(!/ß/.test(tDe(`metric.${k}`)), `de-CH: metric.${k} label stays eszett-free`);
  }
  ok(tEn('lane.telegram') === 'Telegram' && tDe('lane.telegram') === 'Telegram', 'lane.telegram resolves in both locales');
  ok(tEn('lane.ghost') === 'Ghost' && tDe('lane.ghost') === 'Ghost', 'lane.ghost resolves in both locales');
  ok(tEn('lane.nostr') === 'Nostr' && tDe('lane.nostr') === 'Nostr', 'lane.nostr resolves in both locales');

  // ---- 8. digest renders without raw-key leakage (mock lanes named honestly) ---
  const digest = generateDigest({ locale: 'en' });
  ok(digest.ok, 'generateDigest() succeeds with the three new lanes in play');
  const de = generateDigest({ locale: 'de-CH' });
  ok(!/ß/.test(de.digest), 'de-CH digest stays eszett-free with the new lanes rendered');

  // ---- 9. nostr Node-20 (no global WebSocket) degrade: empty metrics, no throw -
  // Runs the engine LIVE (not mock) with WebSocket deleted from globalThis, so the
  // real cmdInsights code path (not the mock driver) exercises the guard. argv[1]
  // is set to the REAL script path so the module's direct-exec guard fires main().
  const NOSTR_SCRIPT = path.join(REPO, 'scripts', 'nostr-social.mjs');
  const liveEnv = { ...process.env };
  delete liveEnv.PENDPOST_MODE;
  const probe = execFileSync(process.execPath, ['-e', `
    delete globalThis.WebSocket;
    process.argv = [process.argv[0], ${JSON.stringify(NOSTR_SCRIPT)}, 'insights', '--plan', ${JSON.stringify(path.join(WS, 'data', 'plans', 'local.json'))}, '--json', '--actor', 'pendpost'];
    await import(${JSON.stringify(NOSTR_SCRIPT)});
  `], { cwd: REPO, env: { ...liveEnv, PENDPOST_ROOT: WS }, encoding: 'utf8' });
  const probeEnvelope = JSON.parse(probe.trim().split('\n').pop());
  ok(probeEnvelope.ok === true, 'nostr insights on a WebSocket-absent runtime still returns ok:true (no throw)');
  ok(probeEnvelope.results[0]?.ok === true && probeEnvelope.results[0]?.metrics?.reactions === 0 && probeEnvelope.results[0]?.metrics?.zaps === 0,
    'nostr insights on a WebSocket-absent runtime degrades to empty (0) metrics, not a crash');

  // ---- 10. relay-silent: the REAL (non-mocked) cmdInsights with NO NOSTR_RELAYS
  // configured (no .env in this workspace) - "no relays to ask" degrades the same
  // honest way as "no relay answered": empty metrics, ok:true, never a throw. This
  // runs with the real global WebSocket present (no deletion), so on Node >= 22 it
  // exercises the `!relays.length` branch specifically, distinct from probe #9's
  // WebSocket-absent branch.
  const relaySilentProbe = execFileSync(process.execPath, ['-e', `
    process.argv = [process.argv[0], ${JSON.stringify(NOSTR_SCRIPT)}, 'insights', '--plan', ${JSON.stringify(path.join(WS, 'data', 'plans', 'local.json'))}, '--json', '--actor', 'pendpost'];
    await import(${JSON.stringify(NOSTR_SCRIPT)});
  `], { cwd: REPO, env: { ...liveEnv, PENDPOST_ROOT: WS }, encoding: 'utf8' });
  const relaySilentEnvelope = JSON.parse(relaySilentProbe.trim().split('\n').pop());
  ok(relaySilentEnvelope.ok === true, 'nostr insights with no NOSTR_RELAYS configured still returns ok:true (no throw)');
  ok(relaySilentEnvelope.results[0]?.ok === true && relaySilentEnvelope.results[0]?.metrics?.reactions === 0 && relaySilentEnvelope.results[0]?.metrics?.zaps === 0,
    'relay-silent (nothing configured to ask): reactions/zaps read exactly 0, never fabricated');

  // ---- 11. nostr HAPPY PATH: the real REQ/parse/dedupe/e-tag/count logic against
  // a stubbed WebSocket that emits fabricated EVENT/EOSE frames (the mock driver
  // only supplies canned scalars - it never exercises fetchEventsForNote). Two
  // relay URLs; relay-b re-emits one of relay-a's reaction ids (dedup must keep it
  // at one), and relay-a carries a rogue kind-7 event that e-tags a DIFFERENT note
  // (the tag guard must exclude it). Expected: reactions:3 (R1,R2,R3), zaps:2
  // (Z1,Z2) - NOT 4 reactions (the duplicate + the rogue would inflate it).
  const NOTE = 'a'.repeat(64);
  const OTHER = 'b'.repeat(64);
  const ev = (id, kind, taggedNote) => ({ id, kind, pubkey: `pk_${id}`, created_at: 1, content: '+', sig: `sig_${id}`, tags: [['e', taggedNote]] });
  const FRAMES = {
    'wss://relay-a': [ev('R1', 7, NOTE), ev('R2', 7, NOTE), ev('Z1', 9735, NOTE), ev('X1', 7, OTHER)],
    'wss://relay-b': [ev('R1', 7, NOTE), ev('R3', 7, NOTE), ev('Z2', 9735, NOTE)],
  };
  class FakeRelay {
    constructor(url) { this.url = url; this._l = {}; setTimeout(() => this._emit('open'), 0); }
    addEventListener(type, cb) { this._l[type] = cb; }
    _emit(type, e) { if (this._l[type]) this._l[type](e || {}); }
    send(raw) {
      let frame; try { frame = JSON.parse(raw); } catch { return; }
      if (frame[0] !== 'REQ') return;
      const subId = frame[1];
      const events = FRAMES[this.url] || [];
      setTimeout(() => {
        for (const e of events) this._emit('message', { data: JSON.stringify(['EVENT', subId, e]) });
        this._emit('message', { data: JSON.stringify(['EOSE', subId]) });
      }, 0);
    }
    close() { /* no-op - never emits a 'close' frame */ }
  }
  const savedWS = globalThis.WebSocket;
  globalThis.WebSocket = FakeRelay;
  try {
    const { gatherNoteEngagement } = await import('../scripts/nostr-social.mjs');
    const tally = await gatherNoteEngagement(['wss://relay-a', 'wss://relay-b'], NOTE);
    ok(tally.reactions === 3, `dedup + tag-guard: reactions === 3 (R1,R2,R3 - duplicate R1 counted once, rogue X1 excluded), got ${tally.reactions}`);
    ok(tally.zaps === 2, `zap receipts counted by kind 9735: zaps === 2 (Z1,Z2), got ${tally.zaps}`);
  } finally {
    globalThis.WebSocket = savedWS;
  }

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[richer-analytics] OK - linkedin reach/engagement, youtube watch-time + needs_scope degrade, telegram account-scoped subscribers, ghost opened/sent/clicks, nostr reactions/zaps (real REQ parse + dedup + tag-guard + Node-20/relay-silent degrade), engagement-rate not summed, locale coverage, sweep wiring (${pass} assertions).`);
} catch (err) {
  console.error(`[richer-analytics] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
