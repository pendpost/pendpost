// radar-freshness-locale.test.mjs - Radar 2.0 step 1, item 4: the scan searches in the queries'
// language, the default lookback is a week, and agent-ingested signals age out with it.
//
// The live failures this pins: a client whose dashboard is de-CH and whose queries are all English
// had its agent scans search in German (the market default fell back to the UI locale), and its
// feed held April threads in late October because agent-ingested signals were exempt from every
// age rule. Fixtures are synthetic.
//
// Proofs:
//   (a) radarSearchLocale follows the queries' own lang, then posting.contentLanguage, and NEVER
//       posting.locale; the brief built from it names the right market;
//   (b) the agent scan passes radarSearchLocale, not getContentLocale(), to the brief;
//   (c) the default lookback is 7 days, and a client's saved lookbackDays still wins;
//   (d) mergeSignals prunes an ingested signal past the lookback unless it is watched or
//       evergreen; with no lookback set, curated signals still never age out.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-freshness-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));

const DAY = 86_400_000;

try {
  const { radarSearchLocale, radarScanPrompt } = await import('../lib/radar-prompt.mjs');
  const { mergeSignals } = await import('../lib/radar.mjs');
  const { RADAR_DEFAULTS, RADAR_LOOKBACK_DAYS_DEFAULT, getPosting } = await import('../lib/config.mjs');

  // ---- (a) the search language follows the queries ------------------------------------------
  const EN = [{ id: 'a', label: 'a', lang: 'en', keywords: ['schedule posts'] }, { id: 'b', label: 'b', lang: 'en-GB', keywords: ['crosspost'] }];
  const MIXED = [{ id: 'a', label: 'a', lang: 'en' }, { id: 'c', label: 'c', lang: 'de' }];
  const NONE = [{ id: 'x', label: 'x', keywords: ['scheduler'] }];
  ok(radarSearchLocale(EN, { locale: 'de-CH' }) === 'en', 'all-English queries on a de-CH dashboard search in English');
  ok(radarSearchLocale(MIXED, { locale: 'de-CH' }) === null, 'mixed query languages and no content language: no market default (each query line decides)');
  ok(radarSearchLocale(MIXED, { locale: 'de-CH', contentLanguage: 'fr' }) === 'fr', 'mixed query languages fall back to the explicit content language');
  ok(radarSearchLocale(NONE, { locale: 'de-CH' }) === null, 'queries without lang never inherit the UI locale');
  ok(radarSearchLocale(NONE, { locale: 'en', contentLanguage: 'de-CH' }) === 'de-CH', 'queries without lang use the brand content language');
  ok(radarSearchLocale([...EN, ...NONE], { locale: 'de-CH' }) === null, 'one query without lang means no batch-wide market from the others');
  const brief = radarScanPrompt(EN, 20, 'acme', null, null, 'de-CH', null, 7, null, radarSearchLocale(EN, { locale: 'de-CH' }));
  ok(/primary market is en\./.test(brief) && !/primary market is de-CH/.test(brief), 'the brief names English as the market, not the dashboard locale');
  ok(/Write that line in German\./.test(brief), 'the closing log line still follows the dashboard (de-CH)');

  // ---- (b) the call site ---------------------------------------------------------------------------
  // A source check, on purpose: the agent scan needs a live MCP server to run end to end, and the
  // regression this guards is one argument at one call site.
  const writesSrc = fs.readFileSync(path.join(REPO, 'lib', 'writes.mjs'), 'utf8');
  const call = writesSrc.match(/prompt: radarScanPrompt\(([^\n]*)\),\n/);
  // Spec 55 appended one argument after it (the extra research tools); the locale stays the 10th.
  ok(call && /radarSearchLocale\(queriesWithFeedback, getPosting\(\)\)(, extra\.tools)?\s*$/.test(call[1]), 'the agent scan passes radarSearchLocale(...) as the search locale');
  ok(call && !/getContentLocale\(\)/.test(call[1]), 'and no longer passes getContentLocale() (which fell back to the UI locale)');

  // ---- (c) the lookback default ----------------------------------------------------------------------
  ok(RADAR_LOOKBACK_DAYS_DEFAULT === 7 && RADAR_DEFAULTS.lookbackDays === 7, 'the default lookback is 7 days');
  fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ radar: { enabled: true, queries: [] } }));
  ok(getPosting().radar.lookbackDays === 7, 'a client with no saved lookback reads the 7-day default');
  fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ radar: { enabled: true, lookbackDays: 90, queries: [] } }));
  ok(getPosting().radar.lookbackDays === 90, 'a client that saved lookbackDays:90 keeps it (configs are not rewritten)');
  fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ radar: { enabled: true, lookbackDays: null, queries: [] } }));
  ok(getPosting().radar.lookbackDays === null, 'an explicit null (no limit) stays null');

  // ---- (d) ingested signals age out with the lookback ---------------------------------------------------
  const now = Date.now();
  const ago = (d) => new Date(now - d * DAY).toISOString();
  const ing = (id, d, extra = {}) => ({ source: 'web', externalId: id, text: 't', ts: ago(d), intentScore: 50, ingested: true, ...extra });
  const feed = [ing('fresh', 2), ing('stale', 20), ing('pinned', 20, { watched: true }), ing('evergreen', 200, { evergreen: true }), ing('undated', 0, { ts: null })];
  const kept7 = mergeSignals(feed, [], [], now, { lookbackDays: 7 }).map((s) => s.externalId).sort().join(',');
  ok(kept7 === 'evergreen,fresh,pinned', `under a 7-day lookback: fresh, watched and evergreen stay; stale and undated ingests go (got ${kept7})`);
  const keptNone = mergeSignals(feed, [], [], now).map((s) => s.externalId).sort().join(',');
  ok(keptNone === 'evergreen,fresh,pinned,stale,undated', `no lookback passed: curated signals never age out, as before (got ${keptNone})`);
  const keptNull = mergeSignals(feed, [], [], now, { lookbackDays: null }).length;
  ok(keptNull === feed.length, 'lookbackDays null (no limit) keeps every curated signal');
  const engineOld = mergeSignals([{ source: 'reddit', externalId: 'e', text: 't', ts: ago(20), intentScore: 50 }], [], [], now, { lookbackDays: 7 });
  ok(engineOld.length === 1, 'an engine signal keeps its own 30-day retention rule (only ingested signals follow the lookback here)');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-freshness-locale] OK - scans search in the queries' language, a week is the default window, curated signals age out with it (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-freshness-locale] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
