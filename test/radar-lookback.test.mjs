// radar-lookback.test.mjs - the scan LOOKBACK window (posting.radar.lookbackDays, default 90).
//
// The gap this closes: Radar surfaced a thread by RELEVANCE alone, so a question answered
// seven years ago could enter the feed and - because the card leads with foundAt - read as a
// live conversation the operator should jump into. Answering it costs the brand credibility
// and buys nothing. lookbackDays bounds what a scan may SURFACE, which is a different job
// from RADAR_RETENTION_DAYS (how long the feed KEEPS what it surfaced).
//
// What this pins:
//   1. the default (90) and the validator bounds (1-3650, or null/0 = no limit).
//   2. withinLookback's truth table, including the fail-CLOSED on an undated post (Wave 3 Q3,
//      2026-09-04): it used to be kept fail-open, and the child learned that omitting ts was the
//      cheap way past the window. Undated = outside the window; radarIngest itemizes the drop
//      as droppedUndated and SAYS so in the result text, so the child learns to send ts.
//   3. the FENCE, not just the prompt: radarIngest drops a known-old find even though the
//      scan prompt already asked for recent ones (a prompt is an instruction, this is a gate),
//      and reports it dropped rather than silently discarding it.
//   4. lookbackDays null => no limit: a decade-old thread ingests again.
//   5. the prompt carries the window to the agent only when one is configured.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib (util binds
// WORKSPACE_ROOT at import; mirrors test/radar-ingest.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-lookback-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const DAY = 24 * 3600 * 1000;
const agoDays = (d) => new Date(Date.now() - d * DAY).toISOString();

try {
  const { withinLookback, RADAR_CAPABILITIES, effectiveRadarSources, agentResearchSources } = await import('../lib/radar.mjs');
  const { RADAR_DEFAULTS, getConfig, setConfig } = await import('../lib/config.mjs');
  const { radarIngest, listRadar } = await import('../lib/writes.mjs');
  const { radarScanPrompt } = await import('../lib/radar-prompt.mjs');

  // ---- (1) the default + the validator bounds -------------------------------
  ok(RADAR_DEFAULTS.lookbackDays === 90,
    'posting.radar.lookbackDays defaults to 90 days - a quarter of conversation is live, older is history');
  const set = (v) => setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { lookbackDays: v } } } });
  const refused = (v) => set(v).code === 'invalid_input';
  ok(!refused(90) && !refused(1) && !refused(3650), 'config_set accepts a whole number of days 1-3650');
  ok(!refused(null) && !refused(0), 'null and 0 are accepted as the explicit "no limit"');
  ok(refused(-1) && refused(3651) && refused(1.5) && refused('90'),
    'a negative, an absurd window, a fraction and a numeric STRING are all refused (a typo can never yield a zero-day feed)');

  // ---- (1b) quora is ARMED, not inert ---------------------------------------
  // x/linkedin/instagram arm once their publish lane is connected. Quora has no publish lane
  // at all, so that rule would arm it never - and a source the agent never researches cannot
  // produce the copy draft the whole capability exists for.
  ok(RADAR_CAPABILITIES.quora.noLane === true, 'quora is marked noLane - there is no pendpost lane to connect it through');
  const armed = effectiveRadarSources({}, () => false);
  ok(armed.includes('quora'), 'with NOTHING connected, quora is still in the effective scan scope');
  ok(agentResearchSources(armed).includes('quora'), 'and it reaches the agent research scope, which is what actually sends it looking at quora.com');
  ok(!effectiveRadarSources({ sources: { quora: { scan: false } } }, () => false).includes('quora'),
    'the explicit scan:false flag still turns it off - armed by default is not unturnoffable');

  // ---- (2) withinLookback's truth table -------------------------------------
  const now = Date.now();
  ok(withinLookback(agoDays(1), 90, now) === true, 'a post from yesterday is inside a 90-day window');
  ok(withinLookback(agoDays(89), 90, now) === true, 'a post from 89 days ago is still inside it');
  ok(withinLookback(agoDays(91), 90, now) === false, 'a post from 91 days ago is outside it');
  ok(withinLookback(agoDays(2500), 90, now) === false, 'the seven-year-old thread that motivated this is outside it');
  ok(withinLookback(null, 90, now) === false && withinLookback('not a date', 90, now) === false,
    'an UNDATED (or unparseable) post is OUTSIDE the window - fail closed; no date, no entry');
  ok(withinLookback(null, null, now) === true && withinLookback(null, 0, now) === true,
    'with NO window configured an undated post still passes - the fail-closed is a property of the window, not a ban on undated rows');
  ok(withinLookback(agoDays(2500), null, now) === true && withinLookback(agoDays(2500), 0, now) === true,
    'lookbackDays null/0 = no limit: every age passes');

  // ---- (3) the FENCE: radarIngest drops a known-old find ---------------------
  const QUERY = { id: 'q1', label: 'scheduling', keywords: ['schedule'], minScore: 0 };
  const configPath = path.join(WS, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ radar: { enabled: true, lookbackDays: 90, queries: [QUERY] } }));

  const res = await radarIngest({
    actor: 'agent:claude',
    queryId: 'q1',
    signals: [
      { source: 'web', url: 'https://example.com/fresh', text: 'What should I use to schedule posts?', ts: agoDays(3) },
      { source: 'quora', url: 'https://quora.com/old-question', text: 'What should I use to schedule posts?', ts: agoDays(2500) },
      { source: 'quora', url: 'https://quora.com/undated', text: 'What should I use to schedule posts?' },
    ],
  });
  ok(res.ok === true && res.accepted === 1 && res.dropped === 2,
    `the 7-year-old find AND the undated find are DROPPED and reported (accepted 1, dropped 2) - got accepted ${res.accepted}, dropped ${res.dropped}`);
  ok(res.staleDropped === 1 && res.droppedUndated === 1,
    'the drops are itemized apart - staleDropped 1 (searched too far back), droppedUndated 1 (did not read the date) - two different fixes for the child');
  ok(typeof res.note === 'string' && /1 signal dropped for missing ts/.test(res.note) && /Send ts \(ISO-8601\)/.test(res.note),
    'the result the child reads SAYS how many were dropped for missing ts and what to do about it - a number alone teaches nothing');
  ok(JSON.stringify(res).includes('dropped for missing ts'),
    'the sentence survives the MCP text rendering (JSON.stringify of the result body)');
  const urls = (await listRadar({})).items.map((s) => s.url);
  ok(urls.includes('https://example.com/fresh'), 'the recent find is in the feed');
  ok(!urls.includes('https://quora.com/undated'), 'the UNDATED find never entered the feed - a window is a window');
  ok(!urls.includes('https://quora.com/old-question'), 'the out-of-window find never entered the feed');

  // ---- (4) no limit configured => the old thread ingests ---------------------
  fs.writeFileSync(configPath, JSON.stringify({ radar: { enabled: true, lookbackDays: null, queries: [QUERY] } }));
  const unbounded = await radarIngest({
    actor: 'agent:claude',
    queryId: 'q1',
    signals: [
      { source: 'quora', url: 'https://quora.com/old-question', text: 'What should I use to schedule posts?', ts: agoDays(2500) },
      { source: 'quora', url: 'https://quora.com/undated', text: 'What should I use to schedule posts?' },
    ],
  });
  ok(unbounded.ok === true && unbounded.accepted === 2 && unbounded.dropped === 0 && unbounded.droppedUndated === 0 && !('note' in unbounded),
    'with lookbackDays null the SAME decade-old find AND the undated find ingest, no note - the window is a setting, not a hardcode');
  const unboundedUrls = (await listRadar({})).items.map((s) => s.url);
  ok(unboundedUrls.includes('https://quora.com/old-question') && unboundedUrls.includes('https://quora.com/undated'), 'and both land in the feed');
  const undated = (await listRadar({})).items.find((s) => s.url === 'https://quora.com/undated');
  ok(undated && undated.ts === null, 'the undated find keeps ts:null - nothing invents a date for it, so the card can still say "age unknown"');

  // ---- (5) the prompt carries the window ------------------------------------
  const withWindow = radarScanPrompt([QUERY], 20, 'acme', null, null, null, null, 90);
  ok(/TIME WINDOW: only surface posts published within the last 90 days/.test(withWindow),
    'the scan prompt states the window in days, so the agent filters BEFORE it spends a find on an old thread');
  ok(/an undated find is OUTSIDE this\nwindow and pendpost drops it/.test(withWindow) && /Never guess a date/.test(withWindow),
    'tells the child an undated find is dropped (send ts) AND still forbids guessing a date - the fence is not a loophole in either direction');
  ok(!/you may still report it/.test(withWindow), 'the old fail-open promise ("you may still report it") is gone from the brief');
  ok(!/TIME WINDOW/.test(radarScanPrompt([QUERY], 20, 'acme', null, null, null, null, null)),
    'with no window configured the prompt says nothing about time - no phantom instruction');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-lookback] OK - the lookback window bounds what a scan surfaces, drops known-old finds, drops undated ones and says so (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-lookback] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
