#!/usr/bin/env node
// test/radar-warmup-query.test.mjs - the `warmup` flag on a Radar query (Reddit karma builder).
// A warmup query is an ordinary Radar query with one extra boolean: it rides the SAME
// scan/ingest/reply rails, and the flag exists only so the feed can pin a karma pill on its
// signals and offer a karma-only filter. Proofs:
//   (a) the flag is a boolean, shape-checked at the door like every other query field;
//   (b) a warmup query saves + round-trips (agent-writable, no owner gate: it grants no autonomy);
//   (c) a warmup query is otherwise a normal query (enabled, sources, subreddits all still apply).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-warmup-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { getConfig, setConfig } = await import('../lib/config.mjs');
const setRadar = (radar, actor = 'owner') => setConfig({ ifRev: getConfig().rev, actor, set: { posting: { radar } } });
const warmupQuery = { id: 'warmup-reddit', label: 'Warm up', sources: ['reddit'], subreddits: ['mcp', 'selfhosted'], brief: 'threads I can help in, not sales', cadence: 'daily', warmup: true };

try {
  // ---- (a) shape ----
  ok(setRadar({ enabled: true, queries: [{ ...warmupQuery, warmup: 'yes' }] }).ok !== true, '(a) warmup is a boolean, shape-checked at the door');

  // ---- (b) round-trip, agent-writable ----
  const saved = setRadar({ enabled: true, queries: [warmupQuery] });
  assert.ok(saved.ok, JSON.stringify(saved));
  const q = getConfig().posting.radar.queries.find((x) => x.id === 'warmup-reddit');
  ok(q && q.warmup === true, '(b) a warmup query saves and round-trips');
  const byAgent = setConfig({ ifRev: getConfig().rev, actor: 'agent:claude', set: { posting: { radar: { queries: [{ ...warmupQuery, brief: 'tweaked by the agent' }] } } } });
  ok(byAgent.ok === true, '(b) an agent may edit a warmup query (the flag grants no autonomy, so no owner gate)');

  // ---- (c) still a normal query ----
  const q2 = getConfig().posting.radar.queries.find((x) => x.id === 'warmup-reddit');
  ok(q2.enabled !== false && q2.sources[0] === 'reddit' && q2.subreddits.length === 2 && q2.cadence === 'daily', '(c) a warmup query keeps every ordinary query field');

  console.log(`\n[radar-warmup-query] OK - warmup is a shape-checked, agent-writable, otherwise-ordinary query flag (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
