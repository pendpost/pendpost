// radar.test.mjs - the Radar (beta) listening seam (spec 32, Patterns P3/P4-read/P9)
// run end-to-end through the lib faces, credential-free, mock-mode, no network.
//
// Proofs (spec 32 §8):
//   (a) the zero-dep intent scorer ranks a buying question ABOVE chatter, and tags
//       'competitor-mention' when a competitor name appears (+ the suggestedAction
//       vocabulary is honored).
//   (b) the per-source seam (runLaneRadar) returns { ok:true, items:[Signal] } in mock
//       and { ok:false, error:'needs_scope' } under PENDPOST_MOCK_UNGRANTED (P9) - the
//       mock SHORT-CIRCUITS with no engine, so bluesky/hacker-news (no engine yet) work.
//   (c) the orchestrator (runRadarScan) scores + dedupes by source+externalId and
//       persists to state.radar; a repeat scan does NOT double the feed; listRadar reads
//       it back with filters; the beta gate (enabled:false) keeps everything inert.
//   (d) the posting.radar config validator accepts a well-formed subtree + rejects junk.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib
// (util binds WORKSPACE_ROOT at import; mirrors test/connect-discover.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ENGINE = {
  reddit: 'scripts/reddit-social.mjs', mastodon: 'scripts/mastodon-social.mjs',
  bluesky: 'scripts/bluesky-social.mjs', hackernews: 'scripts/hacker-news-social.mjs',
};
// Spawn one source engine's `radar` verb directly (mock mode), returning the parsed
// envelope's { action:'radar' } row. Mirrors how the seam spawns it, but here we assert
// the ENGINE's own main() intercept routes `radar` to the mock driver (spec 33).
function spawnRadar(source, extraEnv = {}) {
  const out = execFileSync(process.execPath, [path.join(REPO, SOURCE_ENGINE[source]), 'radar', '--query', '{"keywords":["buffer alternative"],"competitors":["Buffer"]}', '--json'], {
    cwd: REPO, env: { ...process.env, PENDPOST_MODE: 'mock', ...extraEnv }, encoding: 'utf8',
  });
  const env = JSON.parse(out.trim().split('\n').pop());
  return { env, row: Array.isArray(env.results) ? env.results.find((r) => r && r.action === 'radar') : null };
}

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
// The close-the-loop section (spec 34) creates a campaign + queued replies, which need
// the plan store dirs (mirrors test/auto-approve.test.mjs).
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

// The canonical Signal shape (spec 32 §4) - all fields present, intent fields typed.
function isSignal(s) {
  return s && typeof s === 'object'
    && typeof s.source === 'string' && s.source
    && typeof s.externalId === 'string' && s.externalId
    && typeof s.text === 'string'
    && typeof s.intentScore === 'number' && s.intentScore >= 0 && s.intentScore <= 100
    && Array.isArray(s.intentTags)
    && ['reply', 'comparison-page', 'watch', 'ignore'].includes(s.suggestedAction);
}

try {
  const { scoreSignal, scoreInto, runLaneRadar, RADAR_SOURCES, RADAR_CAPABILITIES, signalKey, mergeSignals, isExcluded, normalizeSignal } = await import('../lib/radar.mjs');
  const { runRadarScan, listRadar, triageSignal } = await import('../lib/writes.mjs');

  // ---- (a) the intent scorer -----------------------------------------------
  const buyingQ = scoreSignal('What tool should I use to schedule social posts across platforms?', { competitors: [] });
  const chatter = scoreSignal('Just shipped a new feature today, feeling good about it.', { competitors: [] });
  ok(buyingQ.intentScore > chatter.intentScore, `scorer ranks a buying question (${buyingQ.intentScore}) ABOVE chatter (${chatter.intentScore})`);
  ok(buyingQ.intentTags.includes('buying-question'), 'scorer tags the buying question buying-question');
  ok(chatter.suggestedAction === 'ignore' || chatter.suggestedAction === 'watch', `low-intent chatter suggests watch/ignore (got ${chatter.suggestedAction})`);

  const withCompetitor = scoreSignal('Is Buffer worth it, or is there a better alternative to Buffer?', { competitors: ['Buffer'] });
  ok(withCompetitor.intentTags.includes('competitor-mention'), 'scorer tags competitor-mention when a competitor name appears');
  ok(withCompetitor.intentTags.includes('alternative-seeking'), 'scorer tags alternative-seeking on "alternative to"');
  ok(withCompetitor.suggestedAction === 'comparison-page', `a competitor/alternative thread suggests a comparison-page (got ${withCompetitor.suggestedAction})`);
  // A competitor from posting.radar.competitorsDefault (via opts) counts too.
  const viaDefault = scoreSignal('Anyone compared this to Hootsuite lately?', {}, { competitorsDefault: ['Hootsuite'] });
  ok(viaDefault.intentTags.includes('competitor-mention'), 'scorer honors competitorsDefault from opts');
  // A query's intentPatterns OVERRIDE the default library.
  const overridden = scoreSignal('this mentions FLUXCAP somewhere', { intentPatterns: [{ phrase: 'FLUXCAP', weight: 30, tag: 'buying-question' }] });
  ok(overridden.intentScore >= 30 && overridden.intentTags.includes('buying-question'), 'query.intentPatterns override the default phrase library');

  // ---- (a2) the default library is BILINGUAL (EN + de/de-CH) and covers SERVICE-seeking ----
  // Non-English markets (e.g. a Swiss coaching platform) must get useful scores OUT OF THE BOX,
  // without hand-writing intentPatterns. German buyer language + "looking for a coach/consultant"
  // (a service/person, not a software noun) must outrank chatter and carry the right tag.
  const deRec = scoreSignal('Kann mir jemand einen guten Business Coach in Zürich empfehlen?');
  ok(deRec.intentScore > chatter.intentScore && deRec.intentTags.includes('recommendation-request'), `German "kann jemand ... empfehlen" scores as a recommendation (${deRec.intentScore}) above chatter (${chatter.intentScore})`);
  const deSuche = scoreSignal('Ich suche eine Coaching-Plattform für meine Kundschaft. Alternative zu Coachy?');
  ok(deSuche.intentScore >= 20 && (deSuche.intentTags.includes('recommendation-request') || deSuche.intentTags.includes('alternative-seeking')), `German "ich suche ... / alternative zu" scores as buyer intent (${deSuche.intentScore})`);
  // Adjective gap: "looking for an ADHD coach" / "a good career coach" must still match (a real
  // buyer rarely writes "looking for a coach" with no qualifier); "any good recommendation" too.
  const svc = scoreSignal('Looking for an ADHD coach, any good recommendation?');
  ok(svc.intentScore > chatter.intentScore && svc.intentTags.includes('recommendation-request'), `service-seeking with an adjective ("looking for an ADHD coach") scores as a recommendation (${svc.intentScore}), not chatter`);
  const svc2 = scoreSignal('Career coach recommendations? Worth it?');
  ok(svc2.intentScore >= 20, `"coach recommendations / worth it" scores as buyer intent (${svc2.intentScore})`);
  // Guard: the bilingual additions must NOT push neutral chatter into actionable territory.
  ok(chatter.suggestedAction === 'ignore' || chatter.suggestedAction === 'watch', `chatter stays low after the bilingual additions (${chatter.suggestedAction})`);

  // ---- (a3) spec 40 6.9: gaps found on real threads -------------------------
  // Every phrase below is ordinary buyer language the library scored at or near zero,
  // so a genuine buying question ranked alongside chatter. The scorer is the ONLY
  // ranking pendpost has (it is LLM-free by design), so a miss here is a signal the
  // operator never sees. Each addition is paired with a chatter guard: the point is a
  // better ranking, not a bigger pile.
  const best = scoreSignal('What is the best social media scheduler for a small team?');
  ok(best.intentScore > chatter.intentScore && best.intentTags.includes('buying-question'),
    `"what is the best X" scores as a buying question (${best.intentScore}) above chatter (${chatter.intentScore})`);
  const bestNoun = scoreSignal('Best scheduling tool for someone posting to Mastodon and X?');
  ok(bestNoun.intentScore > chatter.intentScore, `"best <adj> tool" scores above chatter (${bestNoun.intentScore})`);
  const need = scoreSignal('I need an app that can queue posts while I am away.');
  ok(need.intentScore > chatter.intentScore && need.intentTags.includes('recommendation-request'),
    `"I need an app" scores as a recommendation request (${need.intentScore})`);
  const suggestions = scoreSignal('Any suggestions for scheduling across three networks?');
  ok(suggestions.intentScore > chatter.intentScore, `"any suggestions" scores above chatter (${suggestions.intentScore})`);
  const switching = scoreSignal('Switching away from Buffer, what else is out there?');
  ok(switching.intentScore > chatter.intentScore && switching.intentTags.includes('alternative-seeking'),
    `"switching away from X" is alternative-seeking (${switching.intentScore})`);
  const pricePain = scoreSignal('Buffer got too expensive for what it does.');
  ok(pricePain.intentTags.includes('pain-described'), '"too expensive" reads as described pain');
  // German parity: the same two gaps in de/de-CH.
  const deBest = scoreSignal('Was ist das beste Tool, um Beiträge zu planen?');
  ok(deBest.intentScore > chatter.intentScore, `German "was ist das beste" scores above chatter (${deBest.intentScore})`);
  const deNeed = scoreSignal('Ich brauche eine App, die meine Beiträge plant.');
  ok(deNeed.intentScore > chatter.intentScore, `German "ich brauche ein/eine" scores above chatter (${deNeed.intentScore})`);

  // Chatter guard, the part that keeps this honest. These are NEAR-MISS sentences that
  // share vocabulary with the additions above but carry no buying intent at all. If a
  // broadened pattern is too greedy it shows up HERE first, as a feed full of noise.
  for (const [label, text] of [
    ['best-day chatter', 'Best day I have had in ages, the weather is finally good.'],
    ['need-coffee chatter', 'I need a coffee before I look at this pull request again.'],
    ['moving-house chatter', 'Moving away from the city next month, wish me luck.'],
    ['expensive-chatter', 'Rent is too expensive in this city, honestly.'],
    ['shipped chatter', 'Just shipped a new feature today, feeling good about it.'],
  ]) {
    const s = scoreSignal(text);
    ok(s.suggestedAction === 'ignore' || s.suggestedAction === 'watch',
      `${label} stays out of the reply queue (${s.suggestedAction}, score ${s.intentScore})`);
  }

  // ---- (b) the per-source seam (mock short-circuit + P9 degrade) ------------
  ok(RADAR_SOURCES.length === 4, `four Radar sources registered (got ${RADAR_SOURCES.length})`);
  const query = { id: 'q1', label: 'scheduling', sources: RADAR_SOURCES, competitors: ['Buffer'], minScore: 0 };
  for (const source of RADAR_SOURCES) {
    const res = await runLaneRadar(source, query);
    ok(res.ok === true && Array.isArray(res.items) && res.items.length > 0, `${source}: runLaneRadar returns { ok:true, items:[...] } in mock (no engine spawn)`);
    ok(res.items.every(isSignal) === false ? false : true, `${source}: items are normalized Signals`);
    // The mock returns UNSCORED signals (the lib face scores) - but they ARE Signal-shaped.
    ok(res.items.every((it) => typeof it.source === 'string' && typeof it.externalId === 'string' && typeof it.text === 'string'), `${source}: each item carries source+externalId+text`);
  }
  ok(RADAR_CAPABILITIES.hackernews.reply === false, 'hackernews is search-only (reply:false)');
  ok(RADAR_CAPABILITIES.reddit.humanGated === true, 'reddit reply is humanGated');

  // P9 degrade: an ungranted source returns needs_scope, others still return.
  process.env.PENDPOST_MOCK_UNGRANTED = 'reddit';
  const ung = await runLaneRadar('reddit', query);
  ok(ung.ok === false && ung.error === 'needs_scope' && typeof ung.scope === 'string', `ungranted reddit degrades to { ok:false, error:'needs_scope', scope } (got ${ung.scope})`);
  const stillOk = await runLaneRadar('bluesky', query);
  ok(stillOk.ok === true && stillOk.items.length > 0, 'a DIFFERENT source still returns while reddit is ungranted (non-fatal)');
  delete process.env.PENDPOST_MOCK_UNGRANTED;

  // ---- beta gate: Radar OFF ⇒ inert -----------------------------------------
  const offScan = await runRadarScan({});
  ok(offScan.ok === true && offScan.enabled === false && offScan.items.length === 0, 'Radar OFF (default) ⇒ runRadarScan is inert (enabled:false, empty feed, no scan)');

  // Turn Radar ON with one query over all four sources (write config.json directly -
  // activeRoot()/config.json in the legacy no-clients workspace).
  const configPath = path.join(WS, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    radar: { enabled: true, competitorsDefault: ['Buffer'], replyVoiceDefault: '', queries: [query] },
  }));

  // ---- (c) orchestrator: scan, dedupe, persist, list ------------------------
  const scan1 = await runRadarScan({});
  ok(scan1.ok === true && scan1.enabled === true, 'runRadarScan resolves ok:true + enabled:true when Radar is on');
  ok(scan1.items.length === RADAR_SOURCES.length * 3, `first scan surfaces ${RADAR_SOURCES.length * 3} signals (3 canned per source)`);
  ok(scan1.items.every(isSignal), 'every scanned item is a fully-scored Signal (source+externalId+intentScore+suggestedAction)');
  // Highest-intent first.
  ok(scan1.items.every((s, i) => i === 0 || scan1.items[i - 1].intentScore >= s.intentScore), 'the scanned feed is sorted highest-intent first');
  // A competitor-mentioning signal actually got the tag through the full pipeline.
  ok(scan1.items.some((s) => s.intentTags.includes('competitor-mention')), 'the scored feed carries a competitor-mention signal end-to-end');
  ok(scan1.sources.reddit && scan1.sources.reddit.ok === true, 'per-source status records reddit ok');

  // Dedupe: a SECOND scan must not double the feed (same source+externalId keys).
  const scan2 = await runRadarScan({});
  ok(scan2.items.length === scan1.items.length, `a repeat scan dedupes by source+externalId (still ${scan1.items.length}, not doubled)`);
  const keys = scan2.items.map(signalKey);
  ok(new Set(keys).size === keys.length, 'no duplicate source+externalId keys survive the merge');

  // listRadar reads the cache back with filters (never scans).
  const listAll = await listRadar({});
  ok(listAll.ok === true && listAll.enabled === true && listAll.items.length === scan1.items.length, 'listRadar reads the full cached feed back');
  const listReddit = await listRadar({ source: 'reddit' });
  ok(listReddit.items.length === 3 && listReddit.items.every((s) => s.source === 'reddit'), 'listRadar filters by source');
  const listHigh = await listRadar({ minScore: 40 });
  ok(listHigh.items.every((s) => s.intentScore >= 40), 'listRadar filters by minScore floor');
  const listReply = await listRadar({ action: 'reply' });
  ok(listReply.items.every((s) => s.suggestedAction === 'reply'), 'listRadar filters by suggestedAction');

  // ---- (review #4) mergeSignals best-score-wins on a key collision ----------
  const base = { source: 'reddit', externalId: 'clash', text: 't', ts: new Date().toISOString() };
  const lo = { ...base, intentScore: 20, intentTags: [], suggestedAction: 'watch' };
  const hi = { ...base, intentScore: 80, intentTags: ['buying-question'], suggestedAction: 'reply' };
  ok(mergeSignals([], [lo, hi]).find((s) => s.externalId === 'clash').intentScore === 80, 'mergeSignals keeps the HIGHER intentScore on a key collision (weaker-then-stronger)');
  ok(mergeSignals([], [hi, lo]).find((s) => s.externalId === 'clash').intentScore === 80, 'mergeSignals best-score-wins regardless of fresh order');
  ok(mergeSignals([hi], [lo]).find((s) => s.externalId === 'clash').intentScore === 80, 'a weaker re-scan never DOWNGRADES an existing higher-intent signal (review #4)');
  // Watched exempt from prune (review #3 / US7).
  const aged = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const pruneOut = mergeSignals([{ source: 'reddit', externalId: 'oldw', text: 't', ts: aged, intentScore: 5, watched: true }, { source: 'reddit', externalId: 'oldn', text: 't', ts: aged, intentScore: 5 }], []);
  ok(pruneOut.some((s) => s.externalId === 'oldw') && !pruneOut.some((s) => s.externalId === 'oldn'), 'a WATCHED aged signal survives the retention prune; an unwatched aged one does not (US7)');

  // ---- foundAt: when pendpost first saw the thread (the "New" chip's clock) ----
  const t0 = Date.now();
  const stamped = mergeSignals([], [{ ...base, externalId: 'fresh1', intentScore: 10 }], [], t0);
  ok(stamped.find((s) => s.externalId === 'fresh1').foundAt === new Date(t0).toISOString(), 'a FRESH signal is stamped foundAt at merge time');
  // Sticky: a re-scan refreshing the same thread (even with a better score) keeps the ORIGINAL
  // foundAt - a known thread must never read as "new" again.
  const later = mergeSignals(stamped, [{ ...base, externalId: 'fresh1', intentScore: 90 }], [], t0 + 86_400_000);
  ok(later.find((s) => s.externalId === 'fresh1').foundAt === new Date(t0).toISOString(), 'foundAt is STICKY across re-scans - a refreshed thread is not "new" again');
  // Pre-existing cached signals from before this field shipped are NOT back-stamped: an old
  // feed must not light up entirely "new" on the first merge after the update.
  const legacy = mergeSignals([{ ...base, externalId: 'old1', intentScore: 10 }], [], [], t0);
  ok(!legacy.find((s) => s.externalId === 'old1').foundAt, 'an EXISTING unstamped signal stays unstamped - no retroactive "new"');

  // ---- (review #6) excludeKeywords drops a matching signal ------------------
  ok(isExcluded('Just shipped a feature', { excludeKeywords: ['shipped'] }) === true, 'isExcluded matches a keyword (case-insensitive substring)');
  ok(isExcluded('a buying question', { excludeKeywords: ['shipped'] }) === false, 'isExcluded ignores non-matches');
  // Integration: re-configure the query with excludeKeywords, scan, assert the excluded
  // canned signal (mock signal 3 = "...shipped...") is NOT among the freshly-scored hits.
  fs.writeFileSync(configPath, JSON.stringify({
    radar: { enabled: true, competitorsDefault: ['Buffer'], queries: [{ ...query, excludeKeywords: ['shipped'] }] },
  }));
  const exScan = await runRadarScan({});
  ok(exScan.scanned === RADAR_SOURCES.length * 2, `excludeKeywords drops the "shipped" signal: ${RADAR_SOURCES.length * 2} freshly scored (was ${RADAR_SOURCES.length * 3}) (review #6)`);
  fs.writeFileSync(configPath, JSON.stringify({ radar: { enabled: true, competitorsDefault: ['Buffer'], queries: [query] } }));

  // ---- (review #7) numeric-epoch ts is coerced so recency/prune work --------
  const epochSig = normalizeSignal({ source: 'reddit', externalId: 'e1', text: 't', ts: Math.floor(Date.now() / 1000) });
  ok(typeof epochSig.ts === 'string' && !Number.isNaN(Date.parse(epochSig.ts)), 'normalizeSignal coerces a numeric epoch ts to a Date.parse-able ISO string (review #7)');

  // ---- (review #8) scoreSignal never throws on a malformed config -----------
  let threw = false;
  try { scoreSignal('some text', { subreddits: 5, competitors: 'nope', intentPatterns: 3 }, { community: 'r/x' }); } catch { threw = true; }
  ok(threw === false, 'scoreSignal guards non-array config fields (subreddits:5) and never throws (review #8)');

  // ---- (review #3) triage: dismiss is durable across a re-scan; watch pins ---
  const feed0 = await listRadar({});
  const victim = feed0.items.find((s) => s.source === 'reddit');
  const dis = await triageSignal({ source: victim.source, externalId: victim.externalId, action: 'dismiss', actor: 'tester' });
  ok(dis.ok === true && dis.action === 'dismiss', 'triageSignal(dismiss) resolves ok');
  ok(!(await listRadar({})).items.some((s) => signalKey(s) === signalKey(victim)), 'a dismissed signal is gone from the feed (US6)');
  await runRadarScan({});
  ok(!(await listRadar({})).items.some((s) => signalKey(s) === signalKey(victim)), 'a re-scan does NOT re-surface a dismissed signal (US6, seen dedupe)');
  const keep = (await listRadar({})).items.find((s) => s.source === 'reddit');
  const wat = await triageSignal({ source: keep.source, externalId: keep.externalId, action: 'watch', actor: 'tester' });
  ok(wat.ok === true && wat.watched === true, 'triageSignal(watch) resolves ok with watched:true');
  const watFeed = await listRadar({});
  ok(watFeed.items.find((s) => signalKey(s) === signalKey(keep))?.watched === true, 'the watched signal carries watched:true (US7)');
  ok(watFeed.items[0].watched === true, 'the watched signal sorts FIRST (pinned)');
  const cleared = await triageSignal({ source: keep.source, externalId: keep.externalId, action: 'clear', actor: 'tester' });
  ok(cleared.ok === true, 'triageSignal(clear) resolves ok');
  ok((await listRadar({})).items.find((s) => signalKey(s) === signalKey(keep))?.watched !== true, 'clear un-pins the watched signal');
  // triage guards: bad source / missing externalId / bad action / no actor.
  ok((await triageSignal({ source: 'facebook', externalId: 'x', action: 'dismiss', actor: 't' })).code === 'invalid_input', 'triage rejects a non-radar source');
  ok((await triageSignal({ source: 'reddit', externalId: '', action: 'dismiss', actor: 't' })).code === 'invalid_input', 'triage requires externalId');
  ok((await triageSignal({ source: 'reddit', externalId: 'x', action: 'nope', actor: 't' })).code === 'invalid_input', 'triage rejects an unknown action');
  ok((await triageSignal({ source: 'reddit', externalId: 'x', action: 'dismiss', actor: '' })).code === 'invalid_input', 'triage requires an actor');

  // ---- (d) the config validator --------------------------------------------
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const cfg = getConfig();
  const okWrite = setConfig({ ifRev: cfg.rev, actor: 'tester', set: { posting: { radar: { enabled: true, competitorsDefault: ['Buffer', 'Hootsuite'], replyVoiceDefault: 'friendly', queries: [{ id: 'q2', label: 'x', sources: ['reddit'], keywords: ['a'], minScore: 30, cadence: 'daily' }] } } } });
  ok(!okWrite.code, `config_set accepts a well-formed posting.radar subtree (got ${okWrite.code || 'ok'})`);
  const cfg2 = getConfig();
  const badWrite = setConfig({ ifRev: cfg2.rev, actor: 'tester', set: { posting: { radar: { enabled: 'yes' } } } });
  ok(badWrite.code === 'invalid_input', 'config_set rejects a malformed radar subtree (enabled must be boolean)');
  const cfg3 = getConfig();
  const badQuery = setConfig({ ifRev: cfg3.rev, actor: 'tester', set: { posting: { radar: { queries: [{ minScore: 500 }] } } } });
  ok(badQuery.code === 'invalid_input', 'config_set rejects a query with an out-of-range minScore');
  // Not owner-gated: a non-owner actor can enable/tune Radar (unlike autoApprove).
  const cfg4 = getConfig();
  const agentWrite = setConfig({ ifRev: cfg4.rev, actor: 'agent:claude', set: { posting: { radar: { enabled: true } } } });
  ok(!agentWrite.code, 'posting.radar is NOT owner-gated (an agent may tune queries)');

  // review #1: a PARTIAL radar write shallow-merges and must NOT wipe siblings.
  let cfgP = getConfig();
  setConfig({ ifRev: cfgP.rev, actor: 'owner', set: { posting: { radar: { enabled: true, competitorsDefault: ['Buffer'], queries: [{ id: 'keep', label: 'keep', sources: ['reddit'], minScore: 20 }] } } } });
  cfgP = getConfig();
  const pause = setConfig({ ifRev: cfgP.rev, actor: 'agent:claude', set: { posting: { radar: { enabled: false } } } }); // partial "pause Radar" write
  ok(!pause.code, 'a partial radar write (enabled:false) is accepted');
  const afterPause = getConfig().posting.radar;
  ok(afterPause.enabled === false, 'the partial write applied enabled:false');
  ok(Array.isArray(afterPause.queries) && afterPause.queries.some((q) => q.id === 'keep'), 'the partial write PRESERVED queries (review #1 - no data-loss wipe)');
  ok(Array.isArray(afterPause.competitorsDefault) && afterPause.competitorsDefault.includes('Buffer'), 'the partial write PRESERVED competitorsDefault');

  // ---- (spec 33) the four source engines' `radar` verb, spawned directly -----
  // Each engine's own main() must route `radar` to the mock driver (it is in
  // MOCKABLE_COMMANDS) - proving the verb is wired end-to-end, incl. the two NEW
  // engines (bluesky, hacker-news). Happy + PENDPOST_MOCK_UNGRANTED degrade.
  for (const source of ['reddit', 'mastodon', 'bluesky', 'hackernews']) {
    const { env, row } = spawnRadar(source);
    ok(env.ok === true && row && row.action === 'radar' && row.ok === true, `${source}: engine main() routes \`radar\` to the mock driver ({action:'radar', ok:true})`);
    ok(row && Array.isArray(row.items) && row.items.length > 0 && row.items.every((it) => it.externalId && typeof it.text === 'string'), `${source}: the radar row carries normalized-shaped Signal items`);
    const ung = spawnRadar(source, { PENDPOST_MOCK_UNGRANTED: source });
    ok(ung.env.error === 'needs_scope' || (ung.row && ung.row.error === 'needs_scope'), `${source}: PENDPOST_MOCK_UNGRANTED degrades the radar verb to needs_scope (P9)`);
  }
  // HN is search-ONLY: RADAR_CAPABILITIES marks it reply:false, and the engine's COMMANDS
  // has no `reply` verb - a LIVE (non-mock) `reply` spawn exits non-zero (usage).
  ok(RADAR_CAPABILITIES.hackernews.reply === false, 'RADAR_CAPABILITIES.hackernews.reply is false (surface-only)');
  let hnReplyRejected = false;
  try {
    execFileSync(process.execPath, [path.join(REPO, SOURCE_ENGINE.hackernews), 'reply', '--json'], { cwd: REPO, env: { ...process.env, PENDPOST_MODE: 'live' }, encoding: 'utf8', stdio: 'pipe' });
  } catch { hnReplyRejected = true; }
  ok(hnReplyRejected, 'the hacker-news engine exposes NO reply verb (live `reply` spawn is rejected)');

  // ---- (spec 33 / review #2) the live-envelope PARSER, via a fake engine ------
  // Point the reddit lane at a FAKE engine (PENDPOST_REDDIT_ENGINE override) that emits
  // a chosen radar row, so runLaneRadar's parser is genuinely exercised for the
  // rate_limited + present-but-failed + ok paths (the mock only ever emits needs_scope).
  const fakePath = path.join(WS, 'fake-radar-engine.mjs');
  fs.writeFileSync(fakePath, [
    "const m = process.env.FAKE_RADAR || 'ok';",
    "let row;",
    "if (m === 'rate_limited') row = { platform:'reddit', action:'radar', ok:false, error:'rate_limited', retryAfter:7 };",
    "else if (m === 'failed') row = { platform:'reddit', action:'radar', ok:false, error:'boom' };",
    "else row = { platform:'reddit', action:'radar', ok:true, items:[{ source:'reddit', externalId:'f1', text:'hi', url:'u', author:'a', ts:new Date().toISOString() }] };",
    "process.stdout.write(JSON.stringify({ ok:true, results:[row] }) + '\\n');",
  ].join('\n'));
  process.env.PENDPOST_REDDIT_ENGINE = fakePath;
  process.env.FAKE_RADAR = 'rate_limited';
  const rl = await runLaneRadar('reddit', {});
  ok(rl.ok === false && rl.error === 'rate_limited' && rl.retryAfter === 7, 'runLaneRadar parses a rate_limited row -> { ok:false, error:rate_limited, retryAfter } (review #2)');
  process.env.FAKE_RADAR = 'failed';
  const fr = await runLaneRadar('reddit', {});
  ok(fr.ok === false && fr.error === 'boom', 'runLaneRadar parses a present-but-failed row -> { ok:false, error } (never a false-empty ok:true)');
  process.env.FAKE_RADAR = 'ok';
  const okr = await runLaneRadar('reddit', {});
  ok(okr.ok === true && okr.items.length === 1 && okr.items[0].source === 'reddit', 'runLaneRadar parses an ok row -> normalized items');
  delete process.env.PENDPOST_REDDIT_ENGINE;
  delete process.env.FAKE_RADAR;

  // ---- (spec 34) close the loop: queue -> approve (distinct) -> mock publish to target ----
  const { RADAR_REPLY_SOURCES } = await import('../lib/radar.mjs');
  const { createCampaign, queueRadarReply, approvePost, createPost, updatePost, markPosted } = await import('../lib/writes.mjs');
  const { runDueExclusive } = await import('../lib/scheduler.mjs');
  const { loadPlanStore } = await import('../lib/plans.mjs');

  // ---- (S3b) listRadar joins a POSTED radar reply back to its signal (repliedUrl) --------
  const s3sig = (await listRadar({ source: 'reddit' })).items[0];
  ok(!('repliedUrl' in s3sig) || s3sig.repliedUrl == null, 'a signal with no reply carries no repliedUrl');
  await createCampaign({ id: 'radar-reply-camp', note: 'radar', timezone: 'UTC', actor: 'owner' });
  await createPost({ campaign: 'radar-reply-camp', post: { id: 'rr1', type: 'text', platforms: ['reddit'], caption: 'a helpful reply', scheduledAt: '2020-01-01T00:00:00Z', radarReplyTo: { url: s3sig.url || 'https://example.com/t', source: 'reddit', externalId: s3sig.externalId } }, actor: 'owner' });
  await markPosted({ campaign: 'radar-reply-camp', postId: 'rr1', actor: 'owner', externalUrl: 'https://reddit.com/r/x/comment/rr1' });
  const afterReply = await listRadar({});
  const marked = afterReply.items.find((s) => s.source === 'reddit' && s.externalId === s3sig.externalId);
  ok(marked && marked.repliedUrl === 'https://reddit.com/r/x/comment/rr1', 'listRadar marks a signal repliedUrl once a posted radarReplyTo post targets it (S3b)');
  const others = afterReply.items.filter((s) => !(s.source === 'reddit' && s.externalId === s3sig.externalId));
  ok(others.every((s) => s.repliedUrl == null), 'only the replied signal is marked - the rest carry no repliedUrl');
  const { loadState, saveState } = await import('../lib/state.mjs');

  // ---- the evidence-first `replied` contract (the "Beantwortet" truth fix) --------------
  // A mark_posted WITH a URL is operator-supplied evidence: via 'external', url = that link,
  // plus the reply post's own address so the UI can open the answer in the planner.
  ok(marked.replied && marked.replied.via === 'external' && marked.replied.url === 'https://reddit.com/r/x/comment/rr1', 'replied.via=external + the operator URL when mark_posted carried one');
  ok(marked.replied.postId === 'rr1' && marked.replied.campaign === 'radar-reply-camp', 'replied carries the reply post address {postId, campaign} for open-in-planner');
  ok(marked.repliedUrl === marked.replied.url, 'repliedUrl stays as a deprecated alias of replied.url');
  // The MatthewBerman repro: status:'posted' minted by mark_posted with NO url and NO
  // platform id = zero evidence. via:'manual', url:null - and NEVER the signal's own url
  // (the old join linked "Beantwortet" back to the question here).
  {
    const st = loadState();
    st.radar.signals.push({ source: 'mastodon', externalId: 'manual1', url: 'https://mastodon.example/@asker/111', author: 'asker', text: 'is there a buffer alternative?', ts: new Date().toISOString(), intentScore: 55 });
    saveState();
    await createPost({ campaign: 'radar-reply-camp', post: { id: 'rrm1', type: 'text', platforms: ['mastodon'], caption: 'we can help with that', scheduledAt: '2020-01-01T00:00:00Z', radarReplyTo: { url: 'https://mastodon.example/@asker/111', source: 'mastodon', externalId: 'manual1' } }, actor: 'owner' });
    await markPosted({ campaign: 'radar-reply-camp', postId: 'rrm1', actor: 'owner' });
    const manualSig = (await listRadar({})).items.find((s) => s.source === 'mastodon' && s.externalId === 'manual1');
    ok(manualSig && manualSig.replied && manualSig.replied.via === 'manual' && manualSig.replied.url === null, 'a no-evidence manual mark is via:manual with url:null (never a fabricated link)');
    ok(manualSig.repliedUrl == null && manualSig.repliedUrl !== manualSig.url, 'the alias is null too - the signal\'s own thread url is NEVER served as the answer');
    // Attach-after-the-fact: the ONE legal mark_posted re-entry records the real link ->
    // the same signal upgrades to via:external on the next read. This is the UI's
    // paste-a-link affordance, end to end.
    const attach = await markPosted({ campaign: 'radar-reply-camp', postId: 'rrm1', actor: 'owner', externalUrl: 'https://mastodon.example/@op/222' });
    ok(attach.ok, 'mark_posted re-entry attaches the live URL to an already-manual post');
    const upgraded = (await listRadar({})).items.find((s) => s.source === 'mastodon' && s.externalId === 'manual1');
    ok(upgraded.replied.via === 'external' && upgraded.replied.url === 'https://mastodon.example/@op/222', 'the attached URL upgrades the state to via:external with the real answer link');
  }

  // ---- resolveReplyPermalink: the pure per-lane evidence table ---------------------------
  // Input mirrors a NORMALIZED post (ids nested, verify/permalinks/externalUrl top-level).
  {
    const { resolveReplyPermalink } = await import('../lib/radar.mjs');
    const base = (lane, ext, over = {}) => ({ radarReplyTo: { source: lane, externalId: ext, url: 'https://signal.example/thread' }, ids: {}, verify: null, externalUrl: null, manualCompletions: null, permalinks: {}, ...over });
    const rd = resolveReplyPermalink(base('reddit', 't3_q1', { ids: { redditPostId: 't1_c9' } }));
    ok(rd.via === 'published' && rd.url === 'https://www.reddit.com/comments/q1/comment/c9/', 'reddit: t1_ comment + t3_ thread derive the canonical comment permalink');
    const rdFallback = resolveReplyPermalink(base('reddit', 't3_q1', { ids: { redditPostId: 'reply_t3_q1' } }));
    ok(rdFallback.via === 'published' && rdFallback.url === null, 'reddit: the reply_ failure-fallback id NEVER derives a link (published, url null)');
    const rdPath = resolveReplyPermalink(base('reddit', 't3_q1', { ids: { redditPostId: 't1_c9', redditPermalink: '/r/x/comments/q1/t/c9/' } }));
    ok(rdPath.url === 'https://www.reddit.com/r/x/comments/q1/t/c9/', 'reddit: the platform-stored permalink PATH wins over derivation');
    const bx = resolveReplyPermalink(base('bluesky', 'at://did:plc:asker/app.bsky.feed.post/q', { ids: { blueskyPostId: 'at://did:plc:me/app.bsky.feed.post/r7' } }));
    ok(bx.via === 'published' && bx.url === 'https://bsky.app/profile/did:plc:me/post/r7', 'bluesky: the at:// uri derives the bsky.app permalink');
    ok(resolveReplyPermalink(base('bluesky', 'x', { ids: { blueskyPostId: 'not-an-at-uri' } })).url === null, 'bluesky: a malformed id derives nothing (never a guessed link)');
    const xr = resolveReplyPermalink(base('x', '123', { ids: { xPostId: '999' }, permalinks: { x: 'https://x.com/i/web/status/999' } }));
    ok(xr.via === 'published' && xr.url === 'https://x.com/i/web/status/999', 'x: the minted id resolves via the shared permalinks derivation');
    const yt = resolveReplyPermalink(base('youtube', 'vid42', { ids: { ytCommentId: 'Ugz9' } }));
    ok(yt.via === 'published' && yt.url === 'https://www.youtube.com/watch?v=vid42&lc=Ugz9', 'youtube: video id + comment-thread id derive the ?lc= watch permalink');
    const mastoNoEnv = resolveReplyPermalink(base('mastodon', '111', { ids: { mastodonStatusId: '222' } }));
    ok(mastoNoEnv.via === 'published' && mastoNoEnv.url === null, 'mastodon: a minted id WITHOUT env identity stays url:null (honest, never guessed)');
    const nostr = resolveReplyPermalink(base('nostr', 'a'.repeat(64), { ids: { nostrEventId: 'b'.repeat(64) } }));
    ok(nostr.via === 'published' && nostr.url === null, 'nostr: read-time derivation is null by design (driver writes externalUrl at publish)');
    const ver = resolveReplyPermalink(base('mastodon', '111', { ids: { mastodonStatusId: '222' }, verify: { platforms: { mastodon: { permalink: 'https://inst.example/@me/222' } } }, externalUrl: 'https://else.example/x' }));
    ok(ver.url === 'https://inst.example/@me/222', 'the verify read-back permalink beats every other source');
    const lane = resolveReplyPermalink(base('mastodon', '111', { manualCompletions: { mastodon: { at: 'now', externalUrl: 'https://inst.example/@me/333' } } }));
    ok(lane.via === 'external' && lane.url === 'https://inst.example/@me/333', 'a lane-scoped manual completion URL counts as external evidence');
    const naked = resolveReplyPermalink(base('mastodon', '111'));
    ok(naked.via === 'manual' && naked.url === null && naked.url !== 'https://signal.example/thread', 'zero evidence = via:manual, url:null - the signal url is NEVER the answer');
  }
  ok(RADAR_REPLY_SOURCES.length === 5 && ['reddit', 'mastodon', 'bluesky', 'youtube', 'nostr'].every((s) => RADAR_REPLY_SOURCES.includes(s)) && !RADAR_REPLY_SOURCES.includes('hackernews') && !RADAR_REPLY_SOURCES.includes('x'), 'RADAR_REPLY_SOURCES = reddit/mastodon/bluesky/youtube/nostr (HN surface-only; x has no reply path X will accept; nostr flipped wave 5)');
  await createCampaign({ id: 'radarc', note: 'radar replies', timezone: 'UTC', actor: 'owner' });
  const getP = (id) => (loadPlanStore().campaigns.find((c) => c.id === 'radarc')?.posts || []).find((p) => p.id === id);
  // Each reply-capable source: queue (pending) -> the mock loop does NOT fire it while
  // pending -> a DISTINCT actor approves -> the mock publish loop replies to the RESOLVED
  // target (mints the source's reply id). This exercises the whole fence end-to-end.
  const ID_FIELD = { reddit: 'redditPostId', mastodon: 'mastodonStatusId', bluesky: 'blueskyPostId' };
  const EXT = { reddit: 't3_abc', mastodon: '12345', bluesky: 'at://did:plc:x/app.bsky.feed.post/xyz' };
  // Only the sources whose radar reply FIRES in the mock scheduler are exercised here.
  // x + youtube are reply-capable too (RADAR_REPLY_SOURCES), but they post through live-only
  // engine paths (x createTweet, yt commentThreads.insert) with no mock-driver stand-in - so
  // their id-mapping is pinned by a direct fetch-stub in radar-x-youtube-reply.test.mjs and
  // proven end-to-end by the live-verify session, not by this mock loop.
  const MOCK_FIREABLE = ['reddit', 'mastodon', 'bluesky'];
  for (const source of RADAR_REPLY_SOURCES.filter((s) => MOCK_FIREABLE.includes(s))) {
    const idField = ID_FIELD[source];
    const q = await queueRadarReply({ campaign: 'radarc', signalUrl: `https://example.test/${source}`, source, externalId: EXT[source], text: 'happy to help - here is how we handle that', actor: 'agent:radar', confirm: true });
    ok(q.ok && q.approval === 'pending', `${source}: queueRadarReply seeds a PENDING reply-post`);
    // Fail-closed: the mock publish loop must NOT fire a PENDING reply (never posts unapproved).
    await runDueExclusive('scheduler', { campaign: 'radarc', postId: q.postId });
    ok(!getP(q.postId).ids[idField] && getP(q.postId).status !== 'posted', `${source}: a PENDING reply is NEVER fired by the publish loop (no approval => no post)`);
    // A DISTINCT actor approves -> the reply now fires to the resolved external target.
    const appr = await approvePost({ campaign: 'radarc', postId: q.postId, actor: 'owner' });
    ok(appr.ok, `${source}: a distinct actor (owner) approves the queued reply`);
    // Approval re-anchors scheduledAt to ~5min out (writes.mjs setApproval - the human's
    // decision is the send anchor, so the reply goes out shortly AFTER approval, not at its
    // draft time). Advance past that window so the due-gated lane fires now, exactly as the
    // live scheduler would once those minutes elapse. A scheduling-only edit never trips
    // editedSinceApproval (the content hash excludes scheduledAt), so approval survives.
    const due = await updatePost({ campaign: 'radarc', postId: q.postId, ifRev: getP(q.postId).rev, fields: { scheduledAt: new Date(Date.now() - 60000).toISOString() }, actor: 'owner' });
    ok(due.ok, `${source}: the reply reaches its (post-approval re-anchored) send time`);
    await runDueExclusive('scheduler', { campaign: 'radarc', postId: q.postId });
    const posted = getP(q.postId);
    ok(posted.ids[idField] && posted.status === 'posted', `${source}: the approved reply POSTS to the resolved external thread (${idField} minted)`);
    // Mock/live parity for the reply-evidence write: the lanes whose LIVE engine persists
    // the reply's own public URL at publish (mastodon; nostr likewise) do it in mock too.
    if (source === 'mastodon') ok(typeof posted.externalUrl === 'string' && posted.externalUrl.includes(posted.ids[idField]), `${source}: publish persists the reply's own public URL (externalUrl) for the Beantwortet link`);
  }
  // radar_target_gone (safety review #5): an externalId containing 'gone' degrades at fire
  // time - never a stray post. It is TERMINAL (radarReplyState=target_gone) so a SECOND tick
  // does NOT re-attempt (the lane is no longer owed) - no API hammering, no new activity row.
  const qg = await queueRadarReply({ campaign: 'radarc', signalUrl: 'https://example.test/gone', source: 'reddit', externalId: 't3_gone', text: 'hello there friend', actor: 'agent:radar', confirm: true });
  await approvePost({ campaign: 'radarc', postId: qg.postId, actor: 'owner' });
  // Same re-anchor as the happy path above: advance past the ~5min approval anchor so the
  // reply is due and the engine actually runs (and hits the target_gone branch) this tick.
  await updatePost({ campaign: 'radarc', postId: qg.postId, ifRev: getP(qg.postId).rev, fields: { scheduledAt: new Date(Date.now() - 60000).toISOString() }, actor: 'owner' });
  await runDueExclusive('scheduler', { campaign: 'radarc', postId: qg.postId });
  const goneP = getP(qg.postId);
  ok(!goneP.ids.redditPostId && goneP.status !== 'posted', 'a Radar reply to a GONE thread does NOT post (radar_target_gone, never a stray submission)');
  ok(goneP.radarReplyState === 'target_gone', 'a gone target is TERMINAL: radarReplyState=target_gone is stamped + persisted');
  const act1 = (loadState().activity || []).length;
  await runDueExclusive('scheduler', { campaign: 'radarc', postId: qg.postId });
  const act2 = (loadState().activity || []).length;
  ok(act2 === act1, 'a SECOND tick does NOT re-attempt the gone reply (lane no longer owed => no engine spawn, no new activity row - review #5)');

  // ---- (safety review #3) source<->platform mismatch: rejected at create AND never fires ----
  const mismatch = await createPost({ campaign: 'radarc', actor: 'owner', post: { id: 'mismatch1', type: 'text', platforms: ['mastodon'], caption: 'hi there', radarReplyTo: { url: 'https://reddit.com/r/x/comments/y', source: 'reddit', externalId: 't3_y' } } });
  ok(mismatch.code === 'invalid_input', 'a source<->platform mismatch is REJECTED at create (platforms:[mastodon] + radarReplyTo.source:reddit) - never queued');
  // Defense in depth: even a hand-planted mismatch never fires (the engine guard skips it).
  const misPlan = path.join(WS, 'mismatch-plan.json');
  fs.writeFileSync(misPlan, JSON.stringify({ campaign: 'mm', posts: [{ id: 'm1', type: 'text', platforms: ['mastodon'], caption: 'hi there', approval: 'approved', approvalBy: 'owner', createdBy: 'agent:radar', executionMode: 'fully-scheduled', status: 'planned', scheduledAt: new Date(Date.now() - 60000).toISOString(), radarReplyTo: { url: 'https://reddit.com/x', source: 'reddit', externalId: 't3_x' } }] }, null, 2));
  const misOut = execFileSync(process.execPath, [path.join(REPO, 'scripts/mastodon-social.mjs'), 'schedule', '--plan', misPlan, '--only', 'm1', '--json'], { cwd: REPO, env: { ...process.env, PENDPOST_MODE: 'mock' }, encoding: 'utf8' });
  const misEnv = JSON.parse(misOut.trim().split('\n').pop());
  ok(!(misEnv.results || []).some((r) => r.action === 'publish' && r.ok), 'the mastodon engine NEVER fires a wrong-target reply (radarReplyTo.source=reddit on the mastodon lane produces no successful publish)');

  // ---- (safety review #4) mastodon (native-anytime) does NOT fire a FUTURE-scheduled reply ----
  const qf = await queueRadarReply({ campaign: 'radarc', signalUrl: 'https://example.test/m', source: 'mastodon', externalId: '55555', text: 'reply later today', actor: 'agent:radar', confirm: true });
  const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const resched = await updatePost({ campaign: 'radarc', postId: qf.postId, ifRev: getP(qf.postId).rev, fields: { scheduledAt: future }, actor: 'owner' });
  ok(resched.ok, 'reschedule the mastodon reply to tomorrow');
  await approvePost({ campaign: 'radarc', postId: qf.postId, actor: 'owner' });
  await runDueExclusive('scheduler', { campaign: 'radarc', postId: qf.postId });
  ok(!getP(qf.postId).ids.mastodonStatusId && getP(qf.postId).status !== 'posted', 'a FUTURE-scheduled mastodon reply is NOT fired ahead of due (review #4 - no early-fire on the native-anytime lane)');

  // ---- (safety review #1) the bluesky engine never does a blind whole-plan write ----
  // Run it LIVE (no creds) against a plan with a sibling post; the reply degrades to
  // needs_scope and the plan file is left BYTE-IDENTICAL (the old whole-plan write would
  // have re-serialized it, risking a frozen-snapshot clobber of a sibling/concurrent edit).
  const bskPlan = path.join(WS, 'bsk-plan.json');
  const bskContent = `${JSON.stringify({ campaign: 'bsk', posts: [
    { id: 'a1', type: 'text', platforms: ['bluesky'], caption: 'reply', approval: 'approved', approvalBy: 'owner', createdBy: 'agent:radar', executionMode: 'fully-scheduled', status: 'planned', scheduledAt: new Date(Date.now() - 60000).toISOString(), radarReplyTo: { url: 'https://bsky.app/x', source: 'bluesky', externalId: 'at://did:plc:x/app.bsky.feed.post/xyz' } },
    { id: 'b1', type: 'text', platforms: ['x'], caption: 'SIBLING_UNTOUCHED', approval: 'approved' },
  ], meta: 'keep' }, null, 2)}\n`;
  fs.writeFileSync(bskPlan, bskContent);
  execFileSync(process.execPath, [path.join(REPO, 'scripts/bluesky-social.mjs'), 'publish-due', '--plan', bskPlan, '--only', 'a1', '--json'], { cwd: REPO, env: { ...process.env, PENDPOST_MODE: 'live' }, encoding: 'utf8' });
  ok(fs.readFileSync(bskPlan, 'utf8') === bskContent, 'the bluesky engine does NOT blind-write the whole plan (a no-creds run leaves the plan byte-identical - review #1; the success path uses the locked merge-only savePlan)');

// ---- spec 42: the MODEL's verdict beats the regex's, where there is one ----------------
// The regex measured 16, 0 and 0 on three threads a model had verified in the first live scan, and
// `suggestedAction:'reply'` needs 40. So a regex that KEPT the last word would have ranked
// model-found signals below engine noise, rendered "Match 0" over them, and hidden them behind the
// per-query minScore - the exact dead end specs 38-42 exist to delete, one layer down.
{
  const q = { id: 'q1', keywords: ['schedule'] };
  const sig = { text: 'can anyone recommend a tool to schedule social posts?', ts: new Date().toISOString() };

  const engine = scoreInto(sig, q, {});
  ok(engine.scoredBy === 'engine', 'with no agent score the regex still scores it (spec 38 contract unchanged)');

  const agent = scoreInto(sig, q, { agentScore: 82 });
  ok(agent.intentScore === 82 && agent.scoredBy === 'agent', 'the agent score WINS - it read the thread, the regex counted phrases');
  ok(agent.suggestedAction === 'reply', 'suggestedAction is RE-DERIVED from the winning score, not left at the regex verdict');
  ok(JSON.stringify(agent.intentTags) === JSON.stringify(engine.intentTags), 'the tags stay the regex\'s - phrase-matching is a job it is genuinely good at');

  ok(scoreInto(sig, q, { agentScore: 999 }).intentScore === 100, 'an out-of-range score clamps high');
  ok(scoreInto(sig, q, { agentScore: -5 }).intentScore === 0, 'and clamps low');
  ok(scoreInto(sig, q, { agentScore: 'abc' }).scoredBy === 'engine', 'garbage falls back to the regex rather than scoring 0');

  // THE TRAP, and it shipped for ten minutes: Number(null) is 0 and Number.isFinite(0) is true, so
  // "the agent gave no score" read as "the agent rated it zero" - turning the fallback into "rate
  // everything irrelevant". radar-ingest.test.mjs caught it on the first run.
  ok(scoreInto(sig, q, { agentScore: null }).scoredBy === 'engine', 'null means NO score, not a score of zero (Number(null) === 0)');
  ok(scoreInto(sig, q, { agentScore: undefined }).scoredBy === 'engine', 'undefined likewise');
  ok(scoreInto(sig, q, { agentScore: null }).intentScore === engine.intentScore, 'and a null-scored signal is byte-identical to an unscored one');
  // A real zero IS a verdict: an agent saying "I read this and it is irrelevant" must be heard.
  const zero = scoreInto(sig, q, { agentScore: 0 });
  ok(zero.intentScore === 0 && zero.scoredBy === 'agent' && zero.suggestedAction === 'ignore', 'an explicit 0 from the agent is a real verdict, not a missing one');
}

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar] OK - the Radar (beta) seam scores, scans, dedupes, degrades + gates cleanly (${pass} assertions).`);
} catch (err) {
  console.error(`[radar] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
