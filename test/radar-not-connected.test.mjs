// test/radar-not-connected.test.mjs - L4 engine half + D6/D8 (audit 2026-08-31).
//
// (1) `not_connected` vs `needs_scope`: the source engines reported needs_scope BOTH when a
//     credential exists but is rejected (401/403 - "reconnect") AND when it was NEVER
//     configured ("connect") - so the UI said "Zugriff abgelaufen" for a lane that was never
//     connected. A missing credential now degrades to error:'not_connected' (same scope for
//     deep-linking); a present-but-rejected one stays 'needs_scope', and the mint-error text
//     survives in `detail` instead of being discarded.
// (2) Partial-success masking: reddit/mastodon discarded the degrade row when ANY earlier
//     sub-search had yielded items - a lane that half-failed reported plain ok. The ok row
//     now CARRIES the degrade, runLaneRadar passes it through, and runRadarScan records it
//     in state.radar.sources (items still ingest).
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-not-connected-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

try {
  const { runLaneRadar } = await import('../lib/radar.mjs');
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { runRadarScan } = await import('../lib/writes.mjs');
  const { loadState } = await import('../lib/state.mjs');

  // ===== (1) the LIVE engines: a never-configured lane is not_connected, with its scope =====
  // Spawned with a clean env (no credential anywhere): the missing-credential branch runs
  // before any network call, so this is hermetic. The env floor mirrors runLaneRadar's spawn.
  const engines = {
    reddit: { script: 'scripts/reddit-social.mjs', scope: 'reddit_oauth' },
    mastodon: { script: 'scripts/mastodon-social.mjs', scope: 'read:search' },
    bluesky: { script: 'scripts/bluesky-social.mjs', scope: 'bluesky_app_password' },
  };
  for (const [source, { script, scope }] of Object.entries(engines)) {
    const out = execFileSync(process.execPath, [path.join(REPO, script), 'radar', '--query', '{}', '--json', '--actor', 'radar'], {
      cwd: REPO,
      env: { PATH: process.env.PATH, HOME: os.homedir(), PENDPOST_ROOT: WS, PENDPOST_MODE: 'live' },
      encoding: 'utf8',
    });
    const env = JSON.parse(String(out).trim().split('\n').pop());
    const row = (env.results || []).find((r) => r && r.action === 'radar');
    ok(row && row.ok === false && row.error === 'not_connected',
      `${source}: NEVER configured => error 'not_connected', not 'needs_scope' (got ${row && row.error})`);
    ok(row && row.scope === scope, `${source}: the not_connected row still carries scope ${scope} for the connect deep-link`);
  }

  // ===== (2) runLaneRadar maps not_connected exactly like needs_scope (present-but-failed row) =====
  const fakePath = path.join(WS, 'fake-radar-engine.mjs');
  fs.writeFileSync(fakePath, [
    "const m = process.env.FAKE_RADAR || 'ok';",
    "let row;",
    "if (m === 'not_connected') row = { platform:'reddit', action:'radar', ok:false, error:'not_connected', scope:'reddit_oauth' };",
    "else if (m === 'needs_scope_detail') row = { platform:'reddit', action:'radar', ok:false, error:'needs_scope', scope:'reddit_oauth', detail:'invalid_grant: bad password' };",
    "else if (m === 'ok_with_degrade') row = { platform:'reddit', action:'radar', ok:true, degrade:{ error:'needs_scope', scope:'reddit_oauth', detail:'HTTP 403 on r/two' }, items:[{ source:'reddit', externalId:'p1', text:'anyone found a scheduler that just works?', url:'https://reddit.com/p1', author:'a', ts:new Date().toISOString() }] };",
    "else row = { platform:'reddit', action:'radar', ok:true, items:[] };",
    "process.stdout.write(JSON.stringify({ ok:true, results:[row] }) + '\\n');",
  ].join('\n'));
  process.env.PENDPOST_REDDIT_ENGINE = fakePath;

  process.env.FAKE_RADAR = 'not_connected';
  const nc = await runLaneRadar('reddit', {});
  ok(nc.ok === false && nc.error === 'not_connected' && nc.scope === 'reddit_oauth',
    'runLaneRadar maps a not_connected row like needs_scope: { ok:false, error, scope } - nothing downstream breaks');

  process.env.FAKE_RADAR = 'needs_scope_detail';
  const nsd = await runLaneRadar('reddit', {});
  ok(nsd.ok === false && nsd.error === 'needs_scope' && nsd.detail === 'invalid_grant: bad password',
    'the underlying error text survives in `detail` instead of being discarded');

  // ===== (3) a half-failed lane still reports its degrade (D6/D8) =====
  process.env.FAKE_RADAR = 'ok_with_degrade';
  const wd = await runLaneRadar('reddit', {});
  ok(wd.ok === true && wd.items.length === 1 && wd.degrade && wd.degrade.error === 'needs_scope',
    'runLaneRadar keeps ok:true + items AND carries the degrade through');

  await setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: {
    enabled: true,
    queries: [{ id: 'q1', label: 'S', enabled: true, keywords: ['scheduler'], sources: ['reddit'] }],
  } } } });
  const scan = await runRadarScan({});
  ok(scan.ok === true && scan.scanned === 1, 'the half-failed lane still ingested its items');
  const rec = loadState().radar.sources.reddit;
  ok(rec && rec.ok === false && rec.error === 'needs_scope' && rec.partial === true && rec.scope === 'reddit_oauth',
    `D6 regression: state.radar.sources records the degrade of a half-failed lane (got ${JSON.stringify(rec)})`);

  // A later CLEAN ok for the same source still wins (a real full pass beats a stale degrade).
  process.env.FAKE_RADAR = 'ok';
  const scan2 = await runRadarScan({});
  ok(scan2.ok === true && loadState().radar.sources.reddit.ok === true,
    'a later clean ok overwrites the recorded degrade - real health beats a stale error');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-not-connected] OK - never-connected is not_connected (scope kept), rejected keeps needs_scope + detail, half-failed lanes record their degrade (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-not-connected] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  delete process.env.PENDPOST_REDDIT_ENGINE;
  delete process.env.FAKE_RADAR;
  fs.rmSync(WS, { recursive: true, force: true });
}
