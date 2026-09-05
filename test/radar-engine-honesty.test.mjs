#!/usr/bin/env node
// test/radar-engine-honesty.test.mjs - D7 + D1 (audit 2026-08-31): engine lane honesty.
//
// D7: the reddit radar search hardcoded t:'week', ignoring posting.radar.lookbackDays - a
//     30-day lookback searched 7 days. redditWindowFor maps the configured lookback to the
//     SMALLEST reddit window that covers it (1 -> day, <=7 -> week, <=31 -> month, else
//     year), and the seam (runRadarScan) forwards the configured value on the query.
// D1: runLaneRadar discarded the execFile err/stderr, so a 30s timeout kill was
//     indistinguishable from a crash. A killed/signalled spawn now classifies as
//     'engine_timeout'; a crash keeps 'engine_failure' and carries the first stderr line
//     as `detail`.
//
// PENDPOST_RADAR_TIMEOUT_MS (test-only seam) is set BEFORE importing lib/radar.mjs so the
// hang stub is killed in under a second instead of 30s.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-engine-honesty-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
// Big enough that a node process still BOOTS under a fully loaded test runner (the echo
// engine must never be the one killed), small enough that the hang stub dies fast.
process.env.PENDPOST_RADAR_TIMEOUT_MS = '4000';

const savedEngine = process.env.PENDPOST_REDDIT_ENGINE;

// A crashing engine: stderr names the cause, no envelope ever reaches stdout.
const crashBin = path.join(WS, 'crash-engine.mjs');
fs.writeFileSync(crashBin, `console.error('Boom: creds file corrupted');\nprocess.exit(1);\n`);
// A hanging engine: says nothing until well past the (shortened) kill bound.
const hangBin = path.join(WS, 'hang-engine.mjs');
fs.writeFileSync(hangBin, `setTimeout(() => {}, 60_000);\n`);
// An echo engine: valid ok envelope, and it records the --query JSON it was handed.
const echoBin = path.join(WS, 'echo-engine.mjs');
const queryDump = path.join(WS, 'query-seen.json');
fs.writeFileSync(echoBin, `import fs from 'node:fs';
const i = process.argv.indexOf('--query');
fs.writeFileSync(${JSON.stringify(queryDump)}, process.argv[i + 1] || '{}');
process.stdout.write(JSON.stringify({ ok: true, results: [{ action: 'radar', ok: true, items: [] }] }) + '\\n');
`);

try {
  const { runLaneRadar } = await import('../lib/radar.mjs');
  const { redditWindowFor } = await import('../scripts/reddit-social.mjs');
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { runRadarScan } = await import('../lib/writes.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);

  // ===== D7: the pure window mapping =====
  ok(redditWindowFor(1) === 'day', '1 day -> day');
  ok(redditWindowFor(7) === 'week', '7 days -> week');
  ok(redditWindowFor(2) === 'week', '2 days -> week (smallest window that still covers it)');
  ok(redditWindowFor(31) === 'month', '31 days -> month');
  ok(redditWindowFor(8) === 'month', '8 days -> month');
  ok(redditWindowFor(90) === 'year', '90 days -> year');
  ok(redditWindowFor(undefined) === 'week' && redditWindowFor('nope') === 'week' && redditWindowFor(0) === 'week',
    'absent/invalid keeps the historical week default');

  // ===== D7: the seam forwards the configured lookback on the query =====
  process.env.PENDPOST_REDDIT_ENGINE = echoBin;
  await asClient(() => setConfig({
    ifRev: getConfig().rev, actor: 'owner',
    set: { posting: { radar: {
      enabled: true, lookbackDays: 30,
      queries: [{ id: 'q1', label: 'S', enabled: true, sources: ['reddit'], keywords: ['schedule'] }],
    } } },
  }));
  const scan = await asClient(() => runRadarScan({}));
  assert.ok(scan.ok === true && scan.enabled === true, `runRadarScan: ${JSON.stringify(scan)}`);
  const seen = JSON.parse(fs.readFileSync(queryDump, 'utf8'));
  ok(seen.lookbackDays === 30, `D7: the engine received the configured lookbackDays on its query (got ${JSON.stringify(seen.lookbackDays)})`);

  // ===== D1: a crash is engine_failure WITH the first stderr line as detail =====
  process.env.PENDPOST_REDDIT_ENGINE = crashBin;
  const crash = await asClient(() => runLaneRadar('reddit', { id: 'q1', keywords: ['x'] }));
  ok(crash.ok === false && crash.error === 'engine_failure', `a crashed engine is engine_failure (got ${crash.error})`);
  ok(crash.detail === 'Boom: creds file corrupted', `D1: the first stderr line survives as detail (got ${JSON.stringify(crash.detail)})`);

  // ===== D1: a timeout kill is engine_timeout, distinguishable from the crash =====
  process.env.PENDPOST_REDDIT_ENGINE = hangBin;
  const hung = await asClient(() => runLaneRadar('reddit', { id: 'q1', keywords: ['x'] }));
  ok(hung.ok === false && hung.error === 'engine_timeout', `a killed (timed-out) engine is engine_timeout, not a crash (got ${hung.error})`);

  console.log(`[radar-engine-honesty] OK - lookback reaches the reddit window; timeout vs crash are distinguishable (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-engine-honesty] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  if (savedEngine === undefined) delete process.env.PENDPOST_REDDIT_ENGINE; else process.env.PENDPOST_REDDIT_ENGINE = savedEngine;
  delete process.env.PENDPOST_RADAR_TIMEOUT_MS;
  fs.rmSync(WS, { recursive: true, force: true });
}
