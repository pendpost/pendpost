// radar-ambiguous-terms.test.mjs - Radar 2.0 step 1, item 1: ambiguous keywords and the
// unjudged fence.
//
// The live failure this pins: a client's QR-bill search carried the keyword "bLink" (the Swiss
// banking API). Hacker News search is case-insensitive, and the keyword anchor folded case too, so
// every post about a bird or a cat that "blinks" anchored, and with no agent provider set the judge
// never ran and all of them were shown as the feed. The texts below are reconstructions of that
// noise class, not copies of live data.
//
// Proofs:
//   (a) isAmbiguousKeyword: mixed-case acronyms, short terms and listed terms are ambiguous; a
//       multi-word phrase and a plain product name are not;
//   (b) keywordAnchors / scoreSignal: an ambiguous keyword anchors only on an exact case match,
//       or when another anchor of the same query (a co-anchor) is present;
//   (c) engineDropReason drops the "blink" noise as noAnchor and keeps the real "bLink" post;
//       posting.radar.ambiguousTerms extends the list;
//   (d) listRadar never surfaces an unjudged hit (a watched one still shows), and says why with
//       judgeHealth 'not_configured' when no agent provider is set; with a provider set the flag
//       is null; the config validator accepts ambiguousTerms and refuses a malformed list.
//
// Zero-dep node:assert. Temp PENDPOST_ROOT, PENDPOST_MODE=mock, set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-ambiguous-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));

const Q_QR = { id: 'qr-bill', label: 'QR-bill', lang: 'en', keywords: ['Swiss QR-bill', 'QR-IBAN', 'camt.053 import', 'bLink'], sources: ['hackernews'] };

const BIRD = 'Did you know an owl can blink with only one eye at a time? Watched one blink at dusk.';
const CAT = 'My cat does the slow blink at me every morning, apparently that means trust.';
const REAL = 'Has anyone wired the bLink API into a small accounting tool? Looking for experiences.';
const CO = 'Our blink-and-miss-it import for the Swiss QR-bill finally works.';

try {
  const R = await import('../lib/radar.mjs');
  const { engineDropReason } = await import('../lib/radar-prefilter.mjs');

  // ---- (a) which keywords are ambiguous ------------------------------------------------------
  ok(R.isAmbiguousKeyword('bLink'), '"bLink" (lower-case start, inner capital) is ambiguous');
  ok(R.isAmbiguousKeyword('eBay') && R.isAmbiguousKeyword('iCal'), 'other mixed-case acronyms are ambiguous');
  ok(R.isAmbiguousKeyword('AI') && R.isAmbiguousKeyword('MCP') && R.isAmbiguousKeyword('qr'), 'terms of 3 letters or fewer are ambiguous');
  ok(R.isAmbiguousKeyword('Buffer') && R.isAmbiguousKeyword('later'), 'the default listed everyday-word competitors are ambiguous');
  ok(!R.isAmbiguousKeyword('Swiss QR-bill'), 'a multi-word phrase is never ambiguous on its own');
  ok(!R.isAmbiguousKeyword('Hootsuite') && !R.isAmbiguousKeyword('QR-IBAN') && !R.isAmbiguousKeyword('TikTok'), 'a plain product name, an upper-case code and CamelCase are not ambiguous by default');
  ok(R.isAmbiguousKeyword('Pilot', R.ambiguousTermSet(['pilot'])), 'a client-listed term is ambiguous (compared folded)');

  // ---- (b) the anchor rule ---------------------------------------------------------------------
  ok(!R.keywordAnchors(BIRD, ['bLink']), 'folded "blink" no longer anchors the keyword "bLink"');
  ok(!R.keywordAnchors('the blinking cursor', ['bLink']), 'a substring hit ("blinking") does not anchor either');
  ok(R.keywordAnchors(REAL, ['bLink']), 'the exact, case-sensitive "bLink" anchors');
  ok(R.keywordAnchors(CO, Q_QR.keywords), 'a co-anchor from the same query ("Swiss QR-bill") anchors the post');
  ok(!R.keywordAnchors('ask MCP anything', ['mcp']), 'an all-lower-case ambiguous term has no case to check: never anchors alone');
  ok(R.keywordAnchors('Which MCP server for bookkeeping?', ['MCP']), 'an upper-case short term anchors on its exact form');
  ok(!R.keywordAnchors('we are piloting a new menu', ['Pilot'], { ambiguousTerms: ['pilot'] }), 'a listed term needs its exact case');
  ok(R.keywordAnchors('a Pilot tool for invoices', ['Pilot'], { ambiguousTerms: ['pilot'] }), 'a listed term anchors on its exact case');
  ok(R.scoreSignal(BIRD, Q_QR).anchored === false, 'scoreSignal: the bird post is unanchored under the QR-bill search');
  ok(R.scoreSignal(REAL, Q_QR).anchored === true, 'scoreSignal: the real bLink post is anchored');
  ok(R.RADAR_SCORER_VERSION >= 4, 'the scorer version was bumped, so stored engine scores re-rank once');

  // ---- (c) the engine-lane pre-filter ------------------------------------------------------------
  const sig = (id, text) => R.normalizeSignal({ source: 'hackernews', externalId: id, url: `https://news.ycombinator.com/item?id=${id}`, author: `u${id}`, text, ts: new Date().toISOString() }, 'hackernews');
  ok(engineDropReason(sig('1', BIRD), Q_QR, {}) === 'noAnchor', 'the owl post is dropped as noAnchor');
  ok(engineDropReason(sig('2', CAT), Q_QR, {}) === 'noAnchor', 'the cat post is dropped as noAnchor');
  ok(engineDropReason(sig('3', REAL), Q_QR, {}) === null, 'the real bLink question survives the pre-filter');
  const Q_PILOT = { id: 'p', label: 'p', keywords: ['Pilot'], sources: ['hackernews'] };
  ok(engineDropReason(sig('4', 'my pilot license renewal is due'), Q_PILOT, {}) === null, 'without a listing, "Pilot" keeps the old folded match');
  ok(engineDropReason(sig('5', 'my pilot license renewal is due'), Q_PILOT, { ambiguousTerms: ['pilot'] }) === 'noAnchor', 'posting.radar.ambiguousTerms makes "pilot" need its exact case');

  // ---- (d) the unjudged fence in listRadar -------------------------------------------------------
  const { listRadar } = await import('../lib/writes.mjs');
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  const now = new Date().toISOString();
  const unjudged = (id, extra = {}) => ({ source: 'hackernews', externalId: id, url: `https://news.ycombinator.com/item?id=${id}`, author: 'a', text: BIRD, matchedQuery: 'qr-bill', ts: now, intentScore: 20, intentTags: [], suggestedAction: 'watch', scoredBy: 'engine', scorerVersion: R.RADAR_SCORER_VERSION, unjudged: true, ...extra });
  const judged = { source: 'hackernews', externalId: 'j1', url: 'https://news.ycombinator.com/item?id=j1', author: 'b', text: REAL, matchedQuery: 'qr-bill', ts: now, intentScore: 70, intentTags: ['buying-question'], suggestedAction: 'reply', scoredBy: 'agent', judged: true };
  fs.writeFileSync(path.join(WS, 'state.json'), JSON.stringify({ radar: {
    signals: [unjudged('u1'), unjudged('u2'), unjudged('u3', { watched: true }), judged],
    seen: [],
    judge: { at: now, status: 'not_judged', candidates: 2, judged: 0, kept: 0, dropped: 0, unjudged: 2, byReason: {}, error: 'no_provider' },
  } }));
  fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ radar: { enabled: true, agent: { provider: '' }, queries: [Q_QR] } }));
  let feed = await listRadar({});
  const ids = feed.items.map((s) => s.externalId).sort().join(',');
  ok(ids === 'j1,u3', `the unjudged hits are held back; the judged one and the watched one show (got ${ids})`);
  ok(feed.judgeHealth === 'not_configured', `no provider + held-back hits => judgeHealth not_configured (got ${feed.judgeHealth})`);
  ok(feed.judge && feed.judge.configured === false && feed.judge.hiddenUnjudged === 2, 'the judge row says it is not configured and how many hits it holds back');

  const cfg = JSON.parse(fs.readFileSync(path.join(WS, 'config.json'), 'utf8'));
  cfg.radar.agent = { provider: 'claude-code' };
  fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify(cfg));
  feed = await listRadar({});
  ok(feed.judgeHealth === null, 'with a provider set the health flag is null');
  ok(feed.items.map((s) => s.externalId).sort().join(',') === 'j1,u3', 'unjudged hits stay hidden even with a provider (only a verdict lifts them)');

  // The config validator accepts the new key and refuses a malformed one.
  const good = await setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { ambiguousTerms: ['bLink', 'pilot'] } } } });
  ok(good.ok !== false && !good.code, `ambiguousTerms: ["bLink","pilot"] is accepted (${good.code || 'ok'})`);
  const bad = await setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { ambiguousTerms: ['two words'] } } } });
  ok(bad.code === 'invalid_input', `a multi-word ambiguous term is refused (${bad.code})`);

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-ambiguous-terms] OK - ambiguous keywords need an exact case or a co-anchor, unjudged hits never surface (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-ambiguous-terms] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
