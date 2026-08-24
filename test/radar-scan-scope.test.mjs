#!/usr/bin/env node
// test/radar-scan-scope.test.mjs - the effective scan scope (WP6, 2026-07-17).
//
// posting.radar.sources[id].scan is the Setup-card toggle; effectiveRadarSources derives
// the set every surface reads (the agent brief, the Studio glyph strips). Rules:
// explicit flag wins; absent -> searchable lanes ON (as always), agent-found reply lanes
// (x/youtube/...) ON exactly when connected; `web` never a scan target. The config
// validator refuses unknown source keys and non-boolean flags.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-scope-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

try {
  const { effectiveRadarSources, agentResearchSources, RADAR_SOURCES } = await import('../lib/radar.mjs');
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);

  // ===== derivation =====
  const none = effectiveRadarSources({}, () => false);
  ok(RADAR_SOURCES.every((s) => none.includes(s)), 'with no flags and nothing connected, the four searchable lanes are ON (unchanged default)');
  ok(!none.includes('x') && !none.includes('youtube'), 'agent-found reply lanes are OFF while their platform is not connected');
  ok(!none.includes('web'), 'web is never a scan target');

  const xConn = effectiveRadarSources({}, (id) => id === 'x');
  ok(xConn.includes('x') && !xConn.includes('youtube'), 'connecting a platform auto-readies it for Radar ("auf Abruf"), and only it');

  const optedOut = effectiveRadarSources({ sources: { reddit: { scan: false } } }, () => false);
  ok(!optedOut.includes('reddit') && optedOut.includes('hackernews'), 'an explicit scan:false removes a searchable lane, its siblings stay');

  const forcedOn = effectiveRadarSources({ sources: { youtube: { scan: true } } }, () => false);
  ok(forcedOn.includes('youtube'), 'an explicit scan:true wins over the not-connected default');

  // ===== agentResearchSources: the agent SPAWNS only on agent-found (search:false) sources =====
  // The searchable lanes are the native engine's job; the agent WebFetching them is wasted budget
  // (Reddit is blocked for it) and starves the agent-found lanes under the 10-min job cap.
  const mixed = agentResearchSources(['reddit', 'mastodon', 'bluesky', 'hackernews', 'x', 'youtube', 'linkedin', 'instagram']);
  ok(JSON.stringify(mixed) === JSON.stringify(['x', 'youtube', 'linkedin', 'instagram']),
    'agentResearchSources drops every search lane and keeps the agent-found sources in order');
  ok(agentResearchSources(['reddit', 'mastodon', 'bluesky', 'hackernews']).length === 0,
    'a set of only searchable lanes yields ZERO agent lanes - the engine owns them (caller falls back so a GEO-only scan still rides one lane)');
  ok(JSON.stringify(agentResearchSources(['linkedin', 'instagram'])) === JSON.stringify(['linkedin', 'instagram']),
    'the new linkedin/instagram sources are agent-found and survive the filter');
  ok(agentResearchSources([]).length === 0 && agentResearchSources(null).length === 0,
    'empty / non-array input is safe (never throws)');

  // ===== config validation =====
  const rev = () => getConfig().rev;
  const good = await asClient(() => setConfig({ ifRev: rev(), actor: 'owner', set: { posting: { radar: { sources: { reddit: { scan: false }, x: { scan: true } } } } } }));
  ok(good.ok === true, 'a valid sources map saves');
  const badKey = await asClient(() => setConfig({ ifRev: rev(), actor: 'owner', set: { posting: { radar: { sources: { myspace: { scan: true } } } } } }));
  ok(badKey.ok !== true, 'an unknown source key is refused');
  const badWeb = await asClient(() => setConfig({ ifRev: rev(), actor: 'owner', set: { posting: { radar: { sources: { web: { scan: true } } } } } }));
  ok(badWeb.ok !== true, 'web is refused as a sources key (never a scan target)');
  const badVal = await asClient(() => setConfig({ ifRev: rev(), actor: 'owner', set: { posting: { radar: { sources: { reddit: { scan: 'yes' } } } } } }));
  ok(badVal.ok !== true, 'a non-boolean scan flag is refused');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-scan-scope] OK - the effective scan scope derives one way for every surface, config-validated (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-scan-scope] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
