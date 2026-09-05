#!/usr/bin/env node
// test/radar-skipped-lanes.test.mjs - posting.skippedPlatforms reaches Radar (2026-09-04).
//
// posting.skippedPlatforms ("I do not use this platform") used to be a POSTING-only skip:
// runRadarScan fanned a query with no sources[] out to all of RADAR_SOURCES, so a skipped
// lane (bluesky for the live client) was searched on every scan and parked a standing
// `not_connected` row in state.radar.sources; the agent brief's allowed lanes had the same
// blind spot. ONE rule now, read by both paths through effectiveRadarSources:
//
//   a lane the operator skipped is OUT of the derived default scan set, unless an explicit
//   Setup-card scan:true flag or a query's own sources[] names it.
//
//   (a) derivation: skipped removes a searchable lane and a connected agent lane; instagram
//       maps to the `meta` setup id; an explicit scan:true still wins; scan:false still wins.
//   (b) engine: a query with no sources[] never searches a skipped lane and records no row
//       for it; a query that NAMES the lane still searches it.
//   (c) sources truth: the standing degrade row of a skipped lane is dropped on the next scan
//       (a lane that is not scanned has no status to report), unrelated rows are untouched.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-skipped-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

try {
  const { effectiveRadarSources, radarSourceSkipped, RADAR_SOURCES } = await import('../lib/radar.mjs');
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { runRadarScan } = await import('../lib/writes.mjs');
  const { loadState } = await import('../lib/state.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  const ROOT = clientRoot(activeClientId());

  // ===== (a) derivation =====
  const base = effectiveRadarSources({}, () => false, ['bluesky']);
  ok(!base.includes('bluesky'), 'a skipped searchable lane leaves the default scan set');
  ok(['reddit', 'hackernews', 'mastodon'].every((s) => base.includes(s)), 'its searchable siblings stay ON');
  const xSkipped = effectiveRadarSources({}, () => true, ['x']);
  ok(!xSkipped.includes('x') && xSkipped.includes('youtube'), 'a skipped agent lane stays OFF even while connected; connected siblings stay ON');
  const metaSkipped = effectiveRadarSources({}, () => true, ['meta']);
  ok(!metaSkipped.includes('instagram'), 'instagram follows the `meta` setup id (skippedPlatforms speaks setup ids)');
  const forced = effectiveRadarSources({ sources: { bluesky: { scan: true } } }, () => false, ['bluesky']);
  ok(forced.includes('bluesky'), 'an explicit Setup-card scan:true wins over the skip');
  const unchanged = effectiveRadarSources({}, () => false);
  ok(RADAR_SOURCES.every((s) => unchanged.includes(s)), 'no skippedPlatforms argument = the old derivation, unchanged');
  ok(radarSourceSkipped('instagram', ['meta']) && radarSourceSkipped('bluesky', ['bluesky']) && !radarSourceSkipped('bluesky', null) && !radarSourceSkipped('reddit', ['bluesky']),
    'radarSourceSkipped is the one id mapping both paths read');

  // ===== (b)+(c) engine path =====
  fs.mkdirSync(path.join(ROOT, 'data', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
  // The standing rows the live client carried: a skipped lane's not_connected row plus an
  // unrelated agent-lane row that no engine scan ever runs.
  fs.writeFileSync(path.join(ROOT, 'state.json'), JSON.stringify({
    radar: {
      signals: [], seen: [], lastScan: null, geo: {}, jobs: [],
      sources: { bluesky: { ok: false, error: 'not_connected', scope: 'bluesky_app_password' }, x: { ok: false, error: 'timeout', scope: 'tweet.write' } },
    },
  }, null, 2));
  const rev = () => getConfig().rev;
  const saved = await asClient(() => setConfig({
    ifRev: rev(), actor: 'owner',
    set: { posting: { skippedPlatforms: ['bluesky'], radar: { enabled: true, queries: [
      { id: 'wide', label: 'wide', enabled: true, keywords: ['scheduler'] },
    ] } } },
  }));
  ok(saved.ok === true, `config with skippedPlatforms:["bluesky"] + a sources-less query saves (${JSON.stringify(saved).slice(0, 120)})`);

  const scan1 = await asClient(() => runRadarScan({}));
  ok(scan1.ok === true && scan1.enabled === true, 'engine scan runs');
  ok(!scan1.items.some((s) => s.source === 'bluesky'), 'a sources-less query never surfaces a signal from the skipped lane');
  ok(['reddit', 'hackernews', 'mastodon'].every((s) => scan1.items.some((i) => i.source === s)), 'the three non-skipped lanes still yield');
  const rows1 = await asClient(() => loadState().radar.sources);
  ok(!('bluesky' in rows1), `the skipped lane's stale not_connected row is dropped (rows: ${Object.keys(rows1).join(',')})`);
  ok(rows1.x && rows1.x.error === 'timeout', 'an unrelated standing row (agent lane x) is left alone');
  ok(rows1.reddit && rows1.reddit.ok === true, 'the lanes that ran record their rows as before');

  const named = await asClient(() => setConfig({
    ifRev: rev(), actor: 'owner',
    set: { posting: { radar: { queries: [
      { id: 'named', label: 'named', enabled: true, keywords: ['scheduler'], sources: ['bluesky'] },
    ] } } },
  }));
  ok(named.ok === true, 'a query that names the skipped lane explicitly saves');
  const scan2 = await asClient(() => runRadarScan({ queryId: 'named' }));
  ok(scan2.items.some((s) => s.source === 'bluesky' && s.matchedQuery === 'named'), 'a query naming the skipped lane in sources[] still searches it (explicit wins)');
  const rows2 = await asClient(() => loadState().radar.sources);
  ok(rows2.bluesky && rows2.bluesky.ok === true, 'and its row is recorded for that scan (not pruned - it ran)');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-skipped-lanes] OK - a skipped platform is out of the default Radar scan set on both paths, explicit naming wins (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-skipped-lanes] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
