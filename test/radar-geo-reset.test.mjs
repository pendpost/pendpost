#!/usr/bin/env node
// test/radar-geo-reset.test.mjs - the per-tenant GEO footprint reset (radar_geo_reset).
//
// A brand's KI-Sichtbarkeit STATE (footprint log + derived comparison backlog + dismissed ledger)
// lives in state.radar.geo, not config - so a config edit cannot clear it. When one tenant's state
// was seeded with another brand's competitors/questions (the pendpost-competitor rows that landed
// under bondigoo), the owner needs a way to drop them. This proves: the reset clears all three
// arrays under the BOUND client, is owner-only, and is idempotent.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-geo-reset-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

try {
  const { radarGeoReset } = await import('../lib/writes.mjs');
  const { loadState, saveState } = await import('../lib/state.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);

  // Seed a polluted GEO state: footprint rows + a derived backlog + a dismissed entry.
  asClient(() => {
    const s = loadState();
    s.radar = s.radar && typeof s.radar === 'object' ? s.radar : {};
    s.radar.geo = {
      footprint: [
        { actor: 'agent:radar-geo', question: 'best social scheduler', mentioned: false, competitorsMentioned: ['Buffer', 'Hootsuite'] },
        { actor: 'agent:radar-geo', question: 'buffer alternative', mentioned: false, competitorsMentioned: ['Metricool'] },
      ],
      comparisonBacklog: [{ key: 'buffer', title: 'vs Buffer', buyerPhrases: ['what should I use to schedule social posts?'] }],
      dismissedBacklog: ['hootsuite'],
    };
    saveState();
  });

  // A non-owner is refused BEFORE anything is cleared.
  const refused = await asClient(() => radarGeoReset({ actor: 'agent:radar' }));
  ok(refused.ok !== true && /only the owner/.test(refused.message || ''), 'a non-owner reset is refused - it drops agent-logged history');
  const stillThere = asClient(() => loadState());
  ok((stillThere.radar.geo.footprint || []).length === 2, 'and the refused reset left the footprint untouched');

  // The owner reset clears all three arrays and reports the counts removed.
  const done = await asClient(() => radarGeoReset({ actor: 'owner' }));
  ok(done.ok === true, 'the owner reset succeeds');
  ok(done.cleared && done.cleared.footprint === 2 && done.cleared.comparisonBacklog === 1 && done.cleared.dismissedBacklog === 1,
    'it reports the counts it removed (2 footprint, 1 backlog, 1 dismissed)');
  const after = asClient(() => loadState());
  ok((after.radar.geo.footprint || []).length === 0, 'the footprint is cleared on disk');
  ok((after.radar.geo.comparisonBacklog || []).length === 0, 'the derived backlog is cleared');
  ok((after.radar.geo.dismissedBacklog || []).length === 0, 'the dismissed ledger is cleared');

  // Idempotent: a second reset resolves to the same end state, counts now zero.
  const again = await asClient(() => radarGeoReset({ actor: 'owner' }));
  ok(again.ok === true && again.cleared.footprint === 0, 'a second reset is a safe no-op (idempotent) - counts are zero');

  // The REST face (S7.3, radar-reliability 2026-08-31): the verb is no longer MCP-only.
  // Static, like autonomy-ledger's route assertions: the route exists, names its MCP twin
  // (parity check 1), and forwards body.actor UNCHANGED into radarGeoReset - which means the
  // owner gate proven above fires for REST callers too: a POST whose body does not carry
  // actor:'owner' gets the same refusal, with nothing cleared.
  const apiSrc = fs.readFileSync(new URL('../lib/api.mjs', import.meta.url), 'utf8');
  ok(/path:\s*'\/api\/radar\/geo-reset',\s*mcpTool:\s*'radar_geo_reset'/.test(apiSrc),
    'the REST face exists: POST /api/radar/geo-reset names mcpTool radar_geo_reset');
  ok(/radarGeoReset\(\{\s*clientId:\s*body\.clientId,\s*actor:\s*body\.actor\s*\}\)/.test(apiSrc),
    'the route dispatches to radarGeoReset with the body actor unmodified - a non-owner REST caller is refused by the verb itself');
  // The Studio helper acts as the owner, like every other owner write in app/src/lib/api.js.
  const appSrc = fs.readFileSync(new URL('../app/src/lib/api.js', import.meta.url), 'utf8');
  ok(/postJson\('\/api\/radar\/geo-reset',\s*\{\s*actor:\s*ACTOR\s*\}\)/.test(appSrc),
    'the Studio helper posts actor: ACTOR (owner) to the route');

  console.log(`[radar-geo-reset] OK - owner-only reset clears the per-tenant footprint + derived backlog + dismissed ledger under the bound client, reports the counts, is idempotent, and carries its REST + Studio faces (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
