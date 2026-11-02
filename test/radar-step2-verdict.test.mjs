// radar-step2-verdict.test.mjs - Radar 2.0 step 2 (spec 53): the structured verdict, the context
// the judge reads, the action the ENGINE derives from the facts, and the top-N inbox.
//
// Proofs:
//   (a) pure rules (lib/radar-verdict.mjs): coercion fails closed (an unknown authorRole is not a
//       seeker, a missing replyable is not true), only seeker + replyable + intent!=none is
//       actionable, vendor/competitor/bot drop, the inbox is the top N by rank and never padded;
//   (b) the judge: normalizeVerdict carries the four facts, a candidate line carries thread title,
//       author name and bio, age and reply count, and the prompt names every value;
//   (c) the scan seam: a kept VENDOR is dropped into the seen ledger (the self-advertising coach
//       case), a kept seeker in a replyable place is `reply`, a kept peer is `watch`;
//   (d) the ingest seam: an agent's vendor is dropped (roleDropped), a classified seeker is
//       actionable, a find without facts is stored `unclassified` and never actionable, and the
//       next scan's classification pass gives it facts;
//   (e) listRadar: inboxRank marks at most posting.radar.dailyTarget signals, never padded;
//   (f) config: dailyTarget validates 1-50 and defaults to 5;
//   (g) lane context: normalizeSignal keeps replyCount / authorName / authorBio; the HN mapper sets
//       replyCount for a story.
//
// HERMETIC: the judge is a fake binary (PENDPOST_AGENT_BIN_CLAUDE_CODE); the engine candidates
// come from the mock radar verb's scenario file. No network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-step2-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));
fs.writeFileSync(path.join(WS, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\n');

const BIN_VAR = 'PENDPOST_AGENT_BIN_CLAUDE_CODE';
const LOG = path.join(WS, 'judge-calls.ndjson');
// The fake judge decides by a marker in the text and answers the step-2 shape:
//   SEEKER -> keep, seeker, replyable, ask_reco      VENDOR -> keep:true but authorRole vendor
//   PEER   -> keep, peer, replyable                  CLOSED -> keep, seeker, NOT replyable
//   anything else -> drop off-topic
const judgeBin = path.join(WS, 'judge-claude');
fs.writeFileSync(judgeBin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
const items = prompt.split('\\n').filter((l) => l.startsWith('{"id":"c')).map((l) => JSON.parse(l));
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ items }) + '\\n');
const v = (i) => {
  if (/SEEKER/.test(i.text)) return { id: i.id, keep: true, score: 80, intent: 'ask_reco', authorRole: 'seeker', replyable: true, timing: 'fresh', reason: 'asks which tool to use', reasonCode: null };
  if (/VENDOR/.test(i.text)) return { id: i.id, keep: true, score: 45, intent: 'none', authorRole: 'vendor', replyable: true, timing: 'fresh', reason: 'a coach offering sessions', reasonCode: null };
  if (/PEER/.test(i.text)) return { id: i.id, keep: true, score: 60, intent: 'howto_stuck', authorRole: 'peer', replyable: true, timing: 'fresh', reason: 'gives advice', reasonCode: null };
  if (/CLOSED/.test(i.text)) return { id: i.id, keep: true, score: 70, intent: 'ask_reco', authorRole: 'seeker', replyable: false, timing: 'fresh', reason: 'under a launch thread', reasonCode: null };
  return { id: i.id, keep: false, score: 5, intent: 'none', authorRole: 'peer', replyable: false, timing: 'fresh', reason: 'off topic', reasonCode: 'off-topic' };
};
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify({ verdicts: items.map(v) }), total_cost_usd: 0.01 }));
`);
fs.chmodSync(judgeBin, 0o755);
process.env[BIN_VAR] = judgeBin;

const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const nowIso = new Date().toISOString();
const post = (id, text, extra = {}) => ({ externalId: id, url: `https://example.org/@u/${id}`, author: `u_${id}`, text, community: null, ts: nowIso, ...extra });
const Q = { id: 'sched', label: 'scheduler seekers', brief: 'people asking which social media scheduler to use', keywords: ['social media scheduler'], sources: ['mastodon'] };

try {
  const V = await import('../lib/radar-verdict.mjs');
  const { normalizeVerdict, judgePrompt, candidateLine, ageLabel } = await import('../lib/radar-judge.mjs');
  const { normalizeSignal } = await import('../lib/radar.mjs');
  const { hnHitToSignal } = await import('../scripts/hacker-news-social.mjs');

  // ---- (a) pure rules -------------------------------------------------------------------
  const c0 = V.coerceClassification({ intent: 'Ask-Reco', authorRole: 'SEEKER', replyable: 'yes', timing: 'Fresh' });
  ok(c0.intent === 'ask_reco' && c0.authorRole === 'seeker' && c0.replyable === true && c0.timing === 'fresh', `coercion tolerates case, dashes and "yes" (${JSON.stringify(c0)})`);
  const c1 = V.coerceClassification({ intent: 'buying', authorRole: 'customer', replyable: 1 });
  ok(c1.intent === null && c1.authorRole === null && c1.replyable === null, 'unknown values coerce to null, never to a pass');
  ok(V.radarEligibility({ ...c1 }).tier === 'watch', 'an unknown authorRole is NOT a seeker: watch, never act');
  ok(V.radarEligibility({ intent: 'ask_reco', authorRole: 'seeker' }).tier === 'watch', 'a missing replyable is not true: watch');
  ok(V.radarEligibility({ intent: 'ask_reco', authorRole: 'seeker', replyable: true }).tier === 'act', 'seeker + replyable + a real intent is actionable');
  ok(V.radarEligibility({ intent: 'none', authorRole: 'seeker', replyable: true }).tier === 'watch', 'intent none is never actionable');
  ok(V.radarEligibility({ intent: 'ask_reco', authorRole: 'peer', replyable: true }).tier === 'watch', 'a peer is watch at most');
  ok(V.radarEligibility({ intent: 'ask_reco', authorRole: 'seeker', replyable: false }).reasonCode === 'not-replyable', 'a closed place is watch, reason not-replyable');
  for (const role of ['vendor', 'competitor', 'bot']) {
    const e = V.radarEligibility({ intent: 'ask_reco', authorRole: role, replyable: true });
    ok(e.tier === 'drop' && e.reasonCode === V.RADAR_ROLE_DROP_CODE[role], `${role} drops with ${e.reasonCode}`);
  }
  ok(V.classifiedAction({ intent: 'comparing', authorRole: 'seeker', replyable: true }, 'comparison-page') === 'comparison-page'
    && V.classifiedAction({ intent: 'ask_reco', authorRole: 'seeker', replyable: true }, 'ignore') === 'reply'
    && V.classifiedAction({ intent: 'ask_reco', authorRole: 'peer', replyable: true }, 'reply') === 'watch',
  'the score picks only between reply and comparison-page; the facts decide actionable vs watch');
  const w = V.withClassification({ source: 'x', externalId: '1', intentScore: 20, suggestedAction: 'ignore', unclassified: true }, { intent: 'ask_reco', authorRole: 'seeker', replyable: true, timing: 'fresh' }, { by: 'agent' });
  ok(w.suggestedAction === 'reply' && w.classifiedBy === 'agent' && !('unclassified' in w) && w.timing === 'fresh', 'withClassification stamps the facts, clears the flag and re-derives the action');

  const mk = (id, extra) => ({ source: 'reddit', externalId: id, intentScore: 60, intent: 'ask_reco', authorRole: 'seeker', replyable: true, ts: nowIso, ...extra });
  const pool = [
    mk('fresh-quiet', { replyCount: 0 }),
    mk('fresh-crowded', { replyCount: 80 }),
    mk('old', { ts: new Date(Date.now() - 20 * 86400_000).toISOString() }),
    mk('building', { intent: 'building_public' }),
    mk('peer', { authorRole: 'peer' }),
    mk('answered', { replied: { url: null } }),
  ];
  const pick = V.selectInbox(pool, { target: 3 });
  ok(pick.ranked.map((s) => s.externalId).join(',') === 'fresh-quiet,fresh-crowded,building', `the inbox ranks intent x freshness x fewer replies (got ${pick.ranked.map((s) => s.externalId).join(',')})`);
  ok(pick.actionable === 4 && !pick.keys.has('reddit peer') && !pick.keys.has('reddit answered'), 'a peer and an answered thread are never in the inbox');
  const thin = V.selectInbox([mk('only')], { target: 5 });
  ok(thin.ranked.length === 1, 'NEVER PAD: one qualifying signal gives an inbox of one, not five');
  ok(V.selectInbox([mk('p', { authorRole: 'peer' })], { target: 5 }).ranked.length === 0, 'no qualifying signal gives an empty inbox');
  ok(V.dailyTargetOf({}) === 5 && V.dailyTargetOf({ dailyTarget: 3 }) === 3 && V.dailyTargetOf({ dailyTarget: 0 }) === 5 && V.dailyTargetOf({ dailyTarget: 99 }) === 5, 'dailyTargetOf defaults to 5 and ignores out-of-range values');

  // ---- (b) the judge ----------------------------------------------------------------------
  const nv = normalizeVerdict({ keep: true, score: 70, intent: 'competitor_pain', authorRole: 'seeker', replyable: true, timing: 'evergreen' });
  ok(nv.intent === 'competitor_pain' && nv.authorRole === 'seeker' && nv.replyable === true && nv.timing === 'evergreen', 'normalizeVerdict carries the four facts');
  const nv2 = normalizeVerdict({ keep: true, score: 70 });
  ok(nv2 && nv2.authorRole === null && nv2.replyable === null && nv2.intent === null, 'a step-1 shaped verdict keeps working, with unknown facts (fail closed downstream)');
  const NOW = Date.parse('2026-10-29T12:00:00Z');
  ok(ageLabel('2026-10-29T07:00:00Z', NOW) === '5h' && ageLabel('2026-10-25T12:00:00Z', NOW) === '4d' && ageLabel(null, NOW) === null, 'age reads as 5h / 4d, undated stays absent');
  const line = candidateLine({ id: 'c1', alias: 's1', signal: { source: 'hackernews', author: 'jane', authorName: 'Jane D', authorBio: 'Coach. Book a free call!', threadTitle: 'Ask HN: Which scheduler?', ts: '2026-10-29T07:00:00Z', replyCount: 3, text: 'hello' } }, NOW);
  ok(line.threadTitle === 'Ask HN: Which scheduler?' && line.authorBio === 'Coach. Book a free call!' && line.authorName === 'Jane D' && line.age === '5h' && line.replies === 3, `a candidate line carries the step-2 context (${JSON.stringify(line)})`);
  const bare = candidateLine({ id: 'c2', alias: 's1', signal: { source: 'mastodon', author: 'x', text: 't' } }, NOW);
  ok(!('authorBio' in bare) && !('threadTitle' in bare) && !('replies' in bare) && !('age' in bare), 'absent context stays absent');
  const longLine = JSON.stringify(candidateLine({ id: 'c3', alias: 's1', signal: { source: 'x', author: 'a'.repeat(500), authorBio: 'b'.repeat(2000), threadTitle: 't'.repeat(2000), text: 'x'.repeat(9000) } }, NOW));
  ok(longLine.length < 1400, `the per-candidate budget stays sane (${longLine.length} chars)`);
  const prompt = judgePrompt({ searches: [{ alias: 's1', query: Q }], items: [{ id: 'c1', alias: 's1', signal: { source: 'x', author: 'a', text: 't' } }] });
  ok(V.RADAR_INTENTS.every((i) => prompt.includes(i)) && V.RADAR_AUTHOR_ROLES.every((r) => prompt.includes(r)), 'the prompt names every intent and author role');
  ok(/coaches, consultants, freelancers and\s+agencies describing what THEY offer/.test(prompt), 'the prompt names the self-advertising coach as a vendor');
  ok(/"replyable":true/.test(prompt) && /Show HN/.test(prompt), 'the prompt asks for replyable and names the launch-thread case');
  ok(!prompt.includes(String.fromCharCode(0x2014)), 'no em dash in the judge prompt');

  // ---- (c) the scan seam ---------------------------------------------------------------
  const { runRadarScan, listRadar, radarIngest } = await import('../lib/writes.mjs');
  const { loadState, saveState } = await import('../lib/state.mjs');
  const fixture = { sched: [
    post('seek1', 'SEEKER: which social media scheduler do you use for a small shop?', { replyCount: 2 }),
    post('vend1', 'VENDOR: as a coach I use a social media scheduler, book a free session with me'),
    post('peer1', 'PEER: my tip for any social media scheduler, batch your posts'),
    post('clos1', 'CLOSED: which social media scheduler should I pick?'),
  ] };
  const fixturePath = path.join(WS, 'fixture.json');
  fs.writeFileSync(fixturePath, JSON.stringify(fixture));
  process.env.PENDPOST_MOCK_RADAR_FIXTURE = fixturePath;
  const writeConfig = (extra = {}) => fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ radar: { enabled: true, queries: [Q], agent: { provider: 'claude-code' }, ...extra } }));
  writeConfig();

  const scan = await runRadarScan({});
  let st = loadState().radar;
  const byId = (id) => st.signals.find((s) => s.externalId === id);
  ok(!byId('vend1'), 'a KEPT candidate whose author is a vendor never reaches the feed');
  const seenV = st.seen.find((e) => e.externalId === 'vend1');
  ok(seenV && seenV.by === 'judge' && seenV.reason === 'vendor-or-bot', `the vendor is filed in the seen ledger as vendor-or-bot (${JSON.stringify(seenV)})`);
  ok(scan.judge.byReason['vendor-or-bot'] === 1, 'the role drop is tallied');
  ok(byId('seek1') && byId('seek1').suggestedAction === 'reply' && byId('seek1').authorRole === 'seeker' && byId('seek1').classifiedBy === 'judge', 'a seeker in a replyable place is reply, with its facts stored');
  ok(byId('seek1').replyCount === 2, 'the lane context (reply count) is stored on the signal');
  ok(byId('peer1') && byId('peer1').suggestedAction === 'watch', 'a kept peer is watch, whatever its score (60)');
  ok(byId('clos1') && byId('clos1').suggestedAction === 'watch' && byId('clos1').intentScore === 70, 'a seeker in a non-replyable place is watch, score 70 notwithstanding');
  const sentLines = calls().flatMap((c) => c.items);
  ok(sentLines.some((l) => l.replies === 2 && typeof l.age === 'string'), 'the judge was sent the reply count and the age');

  // ---- (e) the inbox -----------------------------------------------------------------
  let feed = await listRadar({});
  ok(feed.inbox && feed.inbox.target === 5 && feed.inbox.shown === 1 && feed.inbox.actionable === 1, `inbox: target 5, 1 shown, never padded (${JSON.stringify(feed.inbox)})`);
  ok(feed.items.find((s) => s.externalId === 'seek1').inboxRank === 1 && !feed.items.find((s) => s.externalId === 'peer1').inboxRank, 'only the actionable signal carries an inboxRank');
  ok(feed.inbox.more === feed.items.length - 1, 'everything else is counted under "more"');

  // ---- (d) the ingest seam --------------------------------------------------------------
  const sig = (id, extra) => ({ source: 'web', url: `https://example.com/${id}`, externalId: id, ts: new Date().toISOString(), text: `thread ${id} about a social media scheduler`, score: 70, ...extra });
  const ing = await radarIngest({ actor: 'agent:radar-scan', queryId: 'sched', signals: [
    sig('a-vendor', { authorRole: 'vendor', intent: 'none', replyable: true }),
    sig('a-bot', { authorRole: 'bot', intent: 'ask_reco', replyable: true }),
    sig('a-seeker', { authorRole: 'seeker', intent: 'comparing', replyable: true, timing: 'fresh', authorBio: 'indie dev', threadTitle: 'Best tools?' }),
    sig('a-bare', { text: 'SEEKER: thread a-bare, which social media scheduler?' }),
  ] });
  ok(ing.ok && ing.accepted === 2 && ing.roleDropped === 2 && ing.unclassified === 1, `ingest: 2 accepted, 2 role drops, 1 unclassified (${JSON.stringify({ a: ing.accepted, r: ing.roleDropped, u: ing.unclassified })})`);
  ok(typeof ing.classifyNote === 'string' && /authorRole/.test(ing.classifyNote), 'the child is told, in words, to send the facts');
  st = loadState().radar;
  ok(!byId('a-vendor') && !byId('a-bot') && st.seen.some((e) => e.externalId === 'a-vendor' && e.reason === 'vendor-or-bot'), 'an agent-named vendor or bot is dropped and filed');
  ok(byId('a-seeker') && byId('a-seeker').classifiedBy === 'agent' && byId('a-seeker').suggestedAction !== 'watch' && byId('a-seeker').authorBio === 'indie dev' && byId('a-seeker').threadTitle === 'Best tools?', 'a classified agent find is actionable and keeps its context');
  ok(byId('a-bare') && byId('a-bare').unclassified === true && byId('a-bare').suggestedAction === 'watch' || (byId('a-bare') && byId('a-bare').unclassified === true), 'a find without facts is stored unclassified');
  feed = await listRadar({});
  const bareRow = feed.items.find((s) => s.externalId === 'a-bare');
  ok(bareRow && !bareRow.inboxRank, 'an unclassified find is listed but never in the inbox');
  ok(feed.judge && feed.judge.unclassified === 1, 'the judge row counts the unclassified finds');

  // The next scan's classification pass reads it (and nothing already classified).
  fs.rmSync(LOG, { force: true });
  await runRadarScan({});
  st = loadState().radar;
  const classifiedNow = byId('a-bare');
  ok(classifiedNow && classifiedNow.unclassified !== true && classifiedNow.authorRole === 'seeker' && classifiedNow.classifiedBy === 'judge', 'the scan classification pass gives the bare find its facts');
  const reLines = calls().flatMap((c) => c.items).map((l) => l.text);
  ok(reLines.length === 1 && /a-bare/.test(reLines[0]), `only the unclassified find was sent again (${reLines.join(' | ')})`);
  fs.rmSync(LOG, { force: true });
  await runRadarScan({});
  ok(calls().length === 0, 'a third scan sends nothing: classified signals are never re-judged');

  // dailyTarget narrows the inbox.
  writeConfig({ dailyTarget: 1 });
  feed = await listRadar({});
  ok(feed.inbox.target === 1 && feed.inbox.shown === 1 && feed.items.filter((s) => s.inboxRank).length === 1 && feed.inbox.actionable >= 2, `dailyTarget 1 shows one ask (${JSON.stringify(feed.inbox)})`);

  // A legacy signal judged before step 2 (no facts) is classified once, then left alone.
  st = loadState().radar;
  st.signals.push({ source: 'mastodon', externalId: 'legacy1', url: 'https://example.org/@u/legacy1', author: 'u', text: 'VENDOR: legacy coach advert', matchedQuery: 'sched', ts: nowIso, intentScore: 48, intentTags: [], suggestedAction: 'reply', scoredBy: 'agent', judged: true });
  saveState();
  writeConfig();
  fs.rmSync(LOG, { force: true });
  await runRadarScan({});
  st = loadState().radar;
  ok(!byId('legacy1') && st.seen.some((e) => e.externalId === 'legacy1' && e.reason === 'vendor-or-bot'), 'a pre-step-2 "reply" coach advert is re-read once and leaves the feed');

  // ---- (f) config --------------------------------------------------------------------
  const { getConfig, setConfig, RADAR_DEFAULTS } = await import('../lib/config.mjs');
  ok(RADAR_DEFAULTS.dailyTarget === 5, 'RADAR_DEFAULTS.dailyTarget is 5');
  let bad;
  try { bad = await setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { dailyTarget: 0 } } } }); } catch (e) { bad = { ok: false, error: String(e) }; }
  ok(bad && bad.ok !== true && bad.code === 'invalid_input', 'dailyTarget 0 is refused');
  const good = await setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { dailyTarget: 3 } } } });
  ok(good && good.ok !== false && getConfig().posting.radar.dailyTarget === 3, 'dailyTarget 3 is saved');

  // ---- (g) lane context -----------------------------------------------------------------
  const ns = normalizeSignal({ source: 'mastodon', id: '1', text: 't', authorName: '  Jane  ', authorBio: 'Coach\n\nBook now', replyCount: '4' });
  ok(ns.authorName === 'Jane' && ns.authorBio === 'Coach Book now' && ns.replyCount === 4, 'normalizeSignal keeps the author name, bio and reply count');
  ok(!('replyCount' in normalizeSignal({ source: 'x', id: '2', text: 't', replyCount: null })), 'a missing reply count stays absent');
  const story = hnHitToSignal({ objectID: '9', title: 'Ask HN: scheduler?', story_text: 'which one', num_comments: 12, _tags: ['story'], created_at_i: 1761700000 });
  const comment = hnHitToSignal({ objectID: '10', comment_text: 'I use x', story_title: 'Ask HN: scheduler?', num_comments: null, _tags: ['comment'], created_at_i: 1761700000 });
  ok(story.replyCount === 12 && !('replyCount' in comment), 'the HN mapper sets replyCount for a story, not for a comment');
} catch (err) {
  failures += 1;
  console.error(`  FAIL - threw: ${err && err.stack}`);
}
console.log(`\n${pass} passed, ${failures} failed`);
if (failures) { console.error(`[radar-step2-verdict] FAIL - ${failures} assertion(s) failed`); process.exit(1); }
