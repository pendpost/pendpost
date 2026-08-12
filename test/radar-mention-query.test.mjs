#!/usr/bin/env node
// test/radar-mention-query.test.mjs - the `mention` flag on a Radar query (R9 brand-mention radar).
// A mention query is an ordinary Radar query with one extra boolean: it rides the SAME
// scan/ingest/reply rails, and the flag exists only so the feed can pin a mention pill on its
// signals, offer a mentions-only filter, and let the digest count reputation events. Proofs:
//   (a) the flag is a boolean, shape-checked at the door like every other query field;
//   (b) a mention query saves + round-trips (agent-writable, no owner gate: it grants no autonomy);
//   (c) a mention query is otherwise a normal query (enabled, sources, keywords all still apply).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-mention-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { getConfig, setConfig } = await import('../lib/config.mjs');
const setRadar = (radar, actor = 'owner') => setConfig({ ifRev: getConfig().rev, actor, set: { posting: { radar } } });
const mentionQuery = { id: 'brand-mentions', label: 'Brand mentions', sources: ['reddit', 'mastodon'], keywords: ['pendpost'], brief: 'people talking about us by name', cadence: 'daily', mention: true };

try {
  // ---- (a) shape ----
  ok(setRadar({ enabled: true, queries: [{ ...mentionQuery, mention: 'yes' }] }).ok !== true, '(a) mention is a boolean, shape-checked at the door');

  // ---- (b) round-trip, agent-writable ----
  const saved = setRadar({ enabled: true, queries: [mentionQuery] });
  assert.ok(saved.ok, JSON.stringify(saved));
  const q = getConfig().posting.radar.queries.find((x) => x.id === 'brand-mentions');
  ok(q && q.mention === true, '(b) a mention query saves and round-trips');
  const byAgent = setConfig({ ifRev: getConfig().rev, actor: 'agent:claude', set: { posting: { radar: { queries: [{ ...mentionQuery, brief: 'tweaked by the agent' }] } } } });
  ok(byAgent.ok === true, '(b) an agent may edit a mention query (the flag grants no autonomy, so no owner gate)');

  // ---- (c) still a normal query ----
  const q2 = getConfig().posting.radar.queries.find((x) => x.id === 'brand-mentions');
  ok(q2.enabled !== false && q2.sources[0] === 'reddit' && q2.keywords[0] === 'pendpost' && q2.cadence === 'daily', '(c) a mention query keeps every ordinary query field');

  // ---- (d) mention + warmup are independent flags ----
  const both = setRadar({ enabled: true, queries: [{ ...mentionQuery, warmup: true }] });
  ok(both.ok === true, '(d) mention and warmup can coexist on one query (both are shape-checked booleans)');

  console.log(`\n[radar-mention-query] OK - mention is a shape-checked, agent-writable, otherwise-ordinary query flag (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
