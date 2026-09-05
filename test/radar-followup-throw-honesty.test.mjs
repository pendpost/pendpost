#!/usr/bin/env node
// test/radar-followup-throw-honesty.test.mjs - E9 (audit 2026-08-31): a THROWING follow-up
// fetch is not a check.
//
// reconcileCopyFollowups used to swallow a fetch throw, count the target as `checked` and -
// via the not-replied branch on a parser hiccup - advance lastCheckedTs as if it had looked.
// A broken fetch therefore read as "checked, no reply". Now a thrown target is skipped
// entirely: not counted, marker (lastCheckedTs) untouched, due again next pass - and a later
// healthy pass still checks + stamps it.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-followup-throw-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

try {
  const { radarIngest, markCopyPosted } = await import('../lib/writes.mjs');
  const { reconcileCopyFollowups } = await import('../lib/radar-sweep.mjs');
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  const { loadState } = await import('../lib/state.mjs');

  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: {
    enabled: true, queries: [{ id: 'q1', label: 'q', sources: ['hackernews'], keywords: ['schedule'] }],
  } } } });

  await radarIngest({ queryId: 'q1', actor: 'agent:claude', signals: [
    { source: 'hackernews', externalId: 'hn1', url: 'https://news.ycombinator.com/item?id=1', author: 'buyer_jane', text: 'every scheduler is overpriced', score: 70, ts: '2026-08-01T10:00:00.000Z' },
  ] });
  await markCopyPosted({ source: 'hackernews', externalId: 'hn1', actor: 'owner', postedUrl: 'https://news.ycombinator.com/item?id=1' });
  const entry = () => (loadState().radar.copyPosted || []).find((e) => e.externalId === 'hn1');

  // ===== a THROWING fetch: not counted, marker untouched =====
  const boom = async () => { throw new Error('ECONNRESET'); };
  const r1 = await reconcileCopyFollowups(Date.now(), boom);
  ok(r1.checked === 0 && r1.replied === 0, `E9: a thrown fetch is NOT counted as checked (got ${JSON.stringify(r1)})`);
  ok(!entry().radarFollowup || !entry().radarFollowup.lastCheckedTs,
    'the per-target marker did not advance - the target stays due next pass');

  // ===== a NULL fetch (degraded, not thrown): counted as an attempt, still no stamp =====
  const r2 = await reconcileCopyFollowups(Date.now(), async () => null);
  ok(r2.checked === 1 && r2.replied === 0, 'a degraded null fetch still counts as an attempted check (unchanged)');
  ok(!entry().radarFollowup || !entry().radarFollowup.lastCheckedTs, 'but stamps nothing - no false "we looked" marker');

  // ===== the next healthy pass really checks and stamps =====
  const emptyThread = { id: 1, author: 'buyer_jane', children: [] };
  const r3 = await reconcileCopyFollowups(Date.now(), async () => emptyThread);
  ok(r3.checked === 1 && r3.replied === 0, 'the healthy pass checks the same target (it stayed due)');
  ok(entry().radarFollowup && entry().radarFollowup.lastCheckedTs,
    'and NOW the marker advances - lastCheckedTs is stamped by a real look');

  console.log(`[radar-followup-throw-honesty] OK - throws never advance the checked marker; real looks do (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-followup-throw-honesty] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
