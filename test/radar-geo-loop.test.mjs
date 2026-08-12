// radar-geo-loop.test.mjs - GEO loop closure (ux-audit 2026-08-04, R4 = dim-7 P1+P2+P4).
//
// The central dead end (dim-7 gap 1): a rival that AI assistants repeatedly name instead
// of the brand never minted a pages-worth-writing entry, because comparisonBacklog derived
// ONLY from signal text. Three pieces close the loop:
//   P1 (bridge): comparisonBacklog gains a second input - rivals with >= 2 mentioned:false
//       co-occurrences in the footprint mint an entry (same self-name exclusion, stopword
//       guard, cap, and dismissed-backlog ledger as text-derived entries). Bridge entries
//       carry an honest source marker phrase ("AI assistants name <rival> for: <question>"),
//       never invented thread links.
//   P2 (share of voice): one pure per-competitor tally across signal text and footprint
//       rivals, most-frequent-first with counts, riding the geo object in listRadar - the
//       server truth that replaces the panel's ad-hoc client-side aggregation.
//   P4 (assistant label): optional short `assistant` string per footprint check, so the
//       trend can separate training-corpus presence from live retrieval.
//
// Zero-dep node:assert style. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-geo-loop-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
const configPath = path.join(WS, 'config.json');

const miss = (question, rivals, extra = {}) => ({ question, mentioned: false, competitorsMentioned: rivals, ts: new Date().toISOString(), ...extra });

try {
  const { comparisonBacklog, shareOfVoice, GEO_BRIDGE_MIN_MISSES } = await import('../lib/radar.mjs');
  const { logRadarFootprint, listRadar, triageSignal } = await import('../lib/writes.mjs');

  // ---- P1 (a): repeated miss mints ONE bridge entry ---------------------------------
  console.log('P1: footprint-to-backlog bridge (pure derivation)');
  {
    const fp = [miss('best scheduler?', ['Buffer']), miss('top social tools?', ['Buffer'])];
    const out = comparisonBacklog([], [], fp);
    ok(out.length === 1 && out[0].key === 'buffer', 'a rival named in >= 2 missed checks mints exactly one backlog entry');
    ok(out[0].title === 'pendpost vs Buffer', 'the bridge entry title positions the brand against the rival');
    ok(out[0].buyerPhrases.some((p) => p === 'AI assistants name Buffer for: best scheduler?'), 'the phrase field carries the honest source marker (assistant miss, not a thread quote)');
    ok(out[0].buyerPhrases.some((p) => p.includes('top social tools?')), 'each distinct missed question contributes its own marker phrase');
    ok(out[0].examples.length === 0, 'a bridge entry never invents thread links (examples stay empty)');
    ok(Number(GEO_BRIDGE_MIN_MISSES) === 2, 'the mint threshold is exported and is 2');
  }
  {
    const out = comparisonBacklog([], [], [miss('best scheduler?', ['Buffer'])]);
    ok(out.length === 0, 'a single miss does NOT mint (one bad answer is noise, a pattern is a page)');
  }
  {
    const fp = [
      { question: 'q', mentioned: true, competitorsMentioned: ['Buffer'], ts: new Date().toISOString() },
      { question: 'q2', mentioned: true, competitorsMentioned: ['Buffer'], ts: new Date().toISOString() },
    ];
    ok(comparisonBacklog([], [], fp).length === 0, 'mentioned:true checks never count toward the bridge (the brand WAS named)');
  }
  {
    const fp = [miss('q', ['Buffer', 'buffer'])];
    const out = comparisonBacklog([], [], [...fp, miss('q2', [])]);
    ok(out.length === 0, 'a rival repeated WITHIN one check counts once (no self-inflating co-occurrence)');
  }
  {
    const fp = [miss('q', ['pendpost']), miss('q2', ['pendpost'])];
    ok(comparisonBacklog([], [], fp).length === 0, 'the self-name never mints a bridge entry (existing exclusion holds)');
    const fp2 = [miss('q', ['the']), miss('q2', ['the'])];
    ok(comparisonBacklog([], [], fp2).length === 0, 'COMPETITOR_STOPWORDS guard holds for footprint rivals too');
  }
  {
    const fp = [miss('q', ['Buffer']), miss('q2', ['Buffer'])];
    const out = comparisonBacklog([], [{ key: 'buffer', at: new Date().toISOString() }], fp);
    ok(out.length === 0, 'a DISMISSED bridge entry stays dismissed across recomputes (ledger applies to bridge keys)');
  }
  {
    // Merge: the same rival in signal text AND the footprint clusters into ONE entry.
    const sigs = [{ source: 'reddit', url: 'https://r/1', text: 'looking for an alternative to Buffer', intentTags: ['alternative-seeking'] }];
    const fp = [miss('best scheduler?', ['Buffer']), miss('q2', ['Buffer'])];
    const out = comparisonBacklog(sigs, [], fp);
    ok(out.filter((b) => b.key === 'buffer').length === 1, 'signal-derived and bridge-derived clusters MERGE on the competitor key (one entry, not two)');
    const entry = out.find((b) => b.key === 'buffer');
    ok(entry.buyerPhrases.some((p) => /alternative to Buffer/i.test(p)) && entry.buyerPhrases.some((p) => p.startsWith('AI assistants name')), 'the merged entry keeps both the real buyer phrase and the source marker');
    ok(entry.examples.includes('https://r/1'), 'the merged entry keeps the real thread link from the signal side');
  }
  {
    // Cap 20 still holds with bridge entries in the mix.
    const fp = [];
    for (let i = 0; i < 30; i += 1) { fp.push(miss('q', [`Rivaltool${i}`]), miss('q2', [`Rivaltool${i}`])); }
    ok(comparisonBacklog([], [], fp).length === 20, 'COMPARISON_BACKLOG_CAP (20) applies to bridge-minted entries too');
  }
  {
    ok(comparisonBacklog([], []).length === 0 && comparisonBacklog([]).length === 0, 'omitting the footprint arg is byte-compatible (older callers unchanged)');
  }

  // ---- P2: share of voice (pure math) -----------------------------------------------
  console.log('P2: shareOfVoice (pure per-competitor tally)');
  {
    const sigs = [
      { source: 'reddit', url: 'https://r/1', text: 'looking for an alternative to Buffer', intentTags: ['alternative-seeking'] },
      { source: 'reddit', url: 'https://r/2', text: 'Hootsuite vs Buffer which is better', intentTags: ['competitor-mention'] },
    ];
    const fp = [miss('q', ['Buffer', 'Later']), miss('q2', ['Buffer'])];
    const sov = shareOfVoice(sigs, fp);
    ok(Array.isArray(sov) && sov.length === 3, 'tallies every distinct rival across signals + footprint');
    ok(sov[0].name === 'Buffer' && sov[0].count === 4, 'most-frequent-first: Buffer counted in 2 signals + 2 checks = 4');
    ok(sov.find((r) => r.name === 'Hootsuite')?.count === 1 && sov.find((r) => r.name === 'Later')?.count === 1, 'each source contributes one count per rival per item');
    ok(sov.every((r) => typeof r.key === 'string' && typeof r.name === 'string' && Number.isFinite(r.count)), 'entries are { key, name, count }');
  }
  {
    const sigs = [{ source: 'reddit', url: 'https://r/1', text: 'alternative to Buffer or maybe an alternative to Buffer', intentTags: ['alternative-seeking'] }];
    const sov = shareOfVoice(sigs, []);
    ok(sov.length === 1 && sov[0].count === 1, 'a rival repeated within ONE signal counts once');
  }
  {
    const sigs = [{ source: 'reddit', url: 'https://r/1', text: 'alternative to Buffer', intentTags: [] }];
    ok(shareOfVoice(sigs, []).length === 0, 'an untagged signal (no alternative-seeking / competitor-mention) never counts');
  }
  {
    const fp = [miss('q', ['pendpost', 'the']), miss('q2', ['pendpost'])];
    ok(shareOfVoice([], fp).length === 0, 'self-name and stopwords are excluded from the tally');
  }
  {
    ok(shareOfVoice().length === 0 && shareOfVoice([], []).length === 0, 'empty inputs yield an empty tally (never throws)');
  }

  // ---- P4 + persist sites: E2E through the engine verbs -----------------------------
  console.log('P4 + persist sites: logRadarFootprint (assistant field + backlog recompute)');
  fs.writeFileSync(configPath, JSON.stringify({ radar: { enabled: true, queries: [], geo: { buyingQuestions: ['best scheduler?'] } } }));
  {
    const bad = await logRadarFootprint({ actor: 'agent:radar-geo', question: 'q', mentioned: false, assistant: 42 });
    ok(bad.code === 'invalid_input', 'assistant must be a string when present (a number is refused)');
    const badArr = await logRadarFootprint({ actor: 'agent:radar-geo', question: 'q', mentioned: false, assistant: ['ChatGPT'] });
    ok(badArr.code === 'invalid_input', 'assistant must be a string when present (an array is refused)');
  }
  {
    const r = await logRadarFootprint({ actor: 'agent:radar-geo', question: 'best scheduler?', mentioned: false, competitorsMentioned: ['Buffer'], assistant: '  ChatGPT web  ' });
    ok(r.ok === true, 'a valid assistant label is accepted');
    const geo = (await listRadar({})).geo;
    ok(geo.footprint.at(-1).assistant === 'ChatGPT web', 'the assistant label is stored trimmed on the footprint entry');
    ok(geo.comparisonBacklog.length === 0, 'one miss does not yet mint (threshold 2, E2E)');
  }
  {
    const r = await logRadarFootprint({ actor: 'agent:radar-geo', question: 'best scheduler?', mentioned: false, competitorsMentioned: ['Buffer'], assistant: 'x'.repeat(200) });
    ok(r.ok === true && (await listRadar({})).geo.footprint.at(-1).assistant.length === 60, 'the assistant label is capped at 60 chars (clip, never drop)');
  }
  {
    const geo = (await listRadar({})).geo;
    ok(geo.comparisonBacklog.some((b) => b.key === 'buffer'), 'the SECOND miss minted the bridge entry - logRadarFootprint recomputes the backlog (a fresh check updates it, no scan needed)');
    ok(Array.isArray(geo.shareOfVoice) && geo.shareOfVoice[0]?.name === 'Buffer' && geo.shareOfVoice[0]?.count === 2, 'listRadar rides the server-derived shareOfVoice on the geo object');
  }
  {
    const r = await logRadarFootprint({ actor: 'agent:radar-geo', question: 'best scheduler?', mentioned: true });
    ok(r.ok === true && (await listRadar({})).geo.footprint.at(-1).assistant === null, 'assistant stays optional - an entry without it stores null (shape stable)');
  }
  {
    // Dismiss the bridge entry, then log another miss: it must NOT resurrect.
    const d = await triageSignal({ backlogKey: 'buffer', action: 'dismiss', actor: 'owner' });
    ok(d.ok === true, 'a bridge-minted backlog entry is dismissable via the same triage verb');
    await logRadarFootprint({ actor: 'agent:radar-geo', question: 'best scheduler?', mentioned: false, competitorsMentioned: ['Buffer'] });
    ok(!(await listRadar({})).geo.comparisonBacklog.some((b) => b.key === 'buffer'), 'a dismissed bridge entry stays dismissed when a fresh miss recomputes the backlog');
  }

  // ---- P4: the prompt asks the child to name what it checked ------------------------
  console.log('P4: prompt line');
  {
    const { radarGeoPrompt, radarScanPrompt } = await import('../lib/radar-prompt.mjs');
    const p = radarGeoPrompt(['best scheduler?'], { clientId: 'c1', brandName: 'acme' });
    ok(/assistant:/.test(p), 'the standalone geo brief asks for the assistant label');
    const folded = radarScanPrompt([{ id: 'q1', label: 'l' }], 20, 'c1', null, { questions: ['best scheduler?'], brandName: 'acme' });
    ok(/assistant:/.test(folded), 'the folded scan geo block asks for the assistant label too (same block)');
  }
} catch (e) {
  failures += 1;
  console.error('FATAL', e);
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
