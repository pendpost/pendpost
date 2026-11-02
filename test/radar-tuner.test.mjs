// radar-tuner.test.mjs - the query tuner (relevance plan 2026-09-30, Phase 1e).
//
// Proofs:
//   (a) trigger: a search is due after 5 new "not relevant" since its last tune, or after a week
//       with >= 10 shown; nothing due = no spawn, no job row;
//   (b) strict validation: an answer that is not { changes:[...] } is refused whole; a change for a
//       search the job was not shown, an exclude that equals the search's own keyword, a shared-host
//       domain mute, a bad source, and a "disable" the stats do not back are each dropped; minScore
//       is clamped to +15 and 70;
//   (c) a real run through the fake agent: narrowing lands in config as the FULL queries array
//       (every other search intact), mutes land in state, broadening becomes proposals, every
//       applied change is logged, and the owner-only radar keys are byte-unchanged;
//   (d) apply / dismiss a proposal, undo each kind of applied change;
//   (e) the revision-conflict retry of the config seam;
//   (f) a bad answer fails the job and changes nothing;
//   (g) nothing due = no spawn, and the daily sweep's once-a-day gate.
//
// HERMETIC: every spawn goes to a fake binary via PENDPOST_AGENT_BIN_CLAUDE_CODE, which answers
// with whatever the test wrote to tune-answer.json and logs the prompt it was given.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-tuner-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));
fs.writeFileSync(path.join(WS, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\n');

const ANSWER = path.join(WS, 'tune-answer.json');
const LOG = path.join(WS, 'tune-calls.ndjson');
const bin = path.join(WS, 'tune-claude');
fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
const tools = args[args.indexOf('--allowed-tools') + 1];
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ tools, prompt }) + '\\n');
const answer = fs.readFileSync(${JSON.stringify(ANSWER)}, 'utf8');
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: answer, total_cost_usd: 0.01 }));
`);
fs.chmodSync(bin, 0o755);
process.env.PENDPOST_AGENT_BIN_CLAUDE_CODE = bin;
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const DAY = 86_400_000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const Q1 = { id: 'q1', label: 'coach software', brief: 'coaches looking for booking software', keywords: ['coaching software'], excludeKeywords: ['fitness'], sources: ['mastodon'], minScore: 30 };
const Q2 = { id: 'q2', label: 'scheduler seekers', keywords: ['social media scheduler'], sources: ['hackernews'] };
const Q3 = { id: 'q3', label: 'quiet search', keywords: ['something rare'], sources: ['reddit'] };
// Owner-only keys the tuner must never touch.
const OWNER = { agent: { provider: 'claude-code', dailyBudget: 3 }, drafting: { minScore: 40, maxPerRun: 5 }, xEnterprise: false };
const config = { radar: { enabled: true, dailyEnabled: true, dailyAt: '00:00', ...OWNER, brand: { facts: 'Acme books coaches.', audience: 'independent coaches in Switzerland', notForClaims: 'sports coaches' }, queries: [Q1, Q2, Q3] } };
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify(config));
const stats = {
  // q1: almost all noise (2 of 30 not marked), 28 "less" since never tuned -> due, disable backed.
  q1: { shown: 30, less: 28, done: 0, drafted: 0, replied: 0, since: ago(10) },
  // q2: a week old, 40 shown, mostly fine -> due by the weekly rule; disable NOT backed.
  q2: { shown: 40, less: 6, done: 3, drafted: 2, replied: 1, since: ago(8) },
  // q3: 3 shown, 1 less, recent -> not due.
  q3: { shown: 3, less: 1, done: 0, drafted: 0, replied: 0, since: ago(1) },
};
const feedback = { q1: { less: [{ excerpt: 'NFL quarterback coach signs a new deal', source: 'mastodon', externalId: 'x1', url: 'https://m.example/1', at: ago(1) }], more: [] } };
fs.writeFileSync(path.join(WS, 'state.json'), JSON.stringify({ radar: { signals: [], seen: [], queryStats: stats, feedback } }));
const readConfig = () => JSON.parse(fs.readFileSync(path.join(WS, 'config.json'), 'utf8'));
const answer = (obj) => fs.writeFileSync(ANSWER, typeof obj === 'string' ? obj : JSON.stringify(obj));

try {
  const T = await import('../lib/radar-tuner.mjs');
  const { radarTune, radarAgentScan, listRadar } = await import('../lib/writes.mjs');
  const { loadState } = await import('../lib/state.mjs');
  const { getConfig, setConfig, RADAR_OWNER_ONLY_KEYS } = await import('../lib/config.mjs');

  // ---- (a) trigger ---------------------------------------------------------------------------
  const now = Date.now();
  ok(T.tuneDue({ shown: 3, less: 5, since: ago(1) }, now), '5 "not relevant" since the last tune -> due');
  ok(!T.tuneDue({ shown: 50, less: 9, lessAtTune: 5, tunedAt: ago(2), since: ago(30) }, now), '4 new since the last tune, tuned 2 days ago -> not due');
  // Radar 2.0 step 1: the weekly rule reads RATED finds (owner actions), not shown ones. The old
  // assertion "a week and >= 10 shown -> due" encoded unrated volume as learning and is replaced.
  ok(T.tuneDue({ shown: 12, less: 2, done: 7, replied: 1, since: ago(8) }, now), 'a week and >= 10 rated (acted + not relevant) -> due');
  ok(!T.tuneDue({ shown: 50, less: 0, since: ago(8) }, now), 'a week and 50 shown but none rated -> not due (nothing to learn from)');
  ok(!T.tuneDue({ shown: 9, less: 0, since: ago(8) }, now), 'a week but under 10 shown -> not due');
  ok(T.tuneDue({ shown: 9, less: 1, skipped: 4, since: ago(1) }, now), '5 not relevant + skipped since the last tune -> due');
  ok(T.queryPrecision({ shown: 24, less: 0 }) === null, 'precision: 24 shown, nothing rated -> unknown (null), no longer 100%');
  ok(T.queryPrecision({ shown: 30, less: 1, skipped: 1, done: 1, replied: 1 }) === 0.5, 'precision: acted (done + replied) over rated (acted + less + skipped)');
  ok(T.queryPrecision({ shown: 30, drafted: 9 }) === null, 'precision: an agent draft is not an owner action');
  ok(!T.tuneDue({ shown: 40, less: 3, since: ago(3) }, now), 'under a week and under 5 "less" -> not due');
  const due = T.tuneCandidates(config.radar.queries, stats, feedback, now);
  ok(due.map((q) => q.id).join(',') === 'q1,q2', `the due searches, most "less" first: q1,q2 (got ${due.map((q) => q.id).join(',')})`);
  ok(T.tuneCandidates(config.radar.queries, stats, feedback, now, { force: true }).length === 3, 'force (tune now) takes every search with learning to read');
  ok(T.tuneCandidates([{ ...Q1, enabled: false }], stats, feedback, now).length === 0, 'a paused search is never tuned');

  // ---- (b) strict validation -----------------------------------------------------------------
  ok(T.validateTuneOutput(null, { queries: due, stats }).ok === false, 'a null answer is refused');
  ok(T.validateTuneOutput({ verdicts: [] }, { queries: due, stats }).ok === false, 'an answer without a changes array is refused whole');
  ok(T.validateTuneOutput([{ kind: 'disable' }], { queries: due, stats }).ok === false, 'a bare array is refused whole');
  const v = T.validateTuneOutput({ changes: [
    { queryId: 'q1', kind: 'excludeKeywords', add: ['NFL', 'quarterback', 'fitness'], why: 'sports' },
    { queryId: 'q1', kind: 'excludeKeywords', add: ['coaching software'], why: 'would kill the search' },
    { queryId: 'q1', kind: 'minScore', value: 99, why: 'too loose' },
    { queryId: 'q1', kind: 'disable', why: 'noise' },
    { queryId: 'q2', kind: 'disable', why: 'not backed by the numbers' },
    { queryId: 'q3', kind: 'excludeKeywords', add: ['x'], why: 'q3 was not shown' },
    { queryId: 'q1', kind: 'muteDomain', value: 'mastodon.social', why: 'shared host' },
    { queryId: 'q1', kind: 'muteDomain', value: 'https://relay.example/path', why: 'relay' },
    { queryId: 'q1', kind: 'sources', add: ['myspace'], why: 'bad source' },
    { queryId: 'q2', kind: 'hashtags', add: ['socialmedia'], why: 'where they ask' },
    { queryId: 'q1', kind: 'rewrite', why: 'unknown kind' },
    { queryId: 'q2', kind: 'newQuery', query: { label: 'Buffer switchers', keywords: ['alternative to Buffer'], sources: ['reddit'], lang: 'en' }, why: 'switchers' },
    { queryId: 'q2', kind: 'newQuery', query: { label: 'x', keywords: [] }, why: 'no keywords' },
  ] }, { queries: due, stats });
  ok(v.ok === true, 'a well-formed answer validates');
  const nk = v.narrowing.map((c) => `${c.queryId}:${c.kind}`).join(',');
  ok(nk === 'q1:excludeKeywords,q1:minScore,q1:disable,q1:muteDomain', `narrowing kept: exclude, minScore, the backed disable, the relay mute (got ${nk})`);
  ok(v.narrowing[0].add.join(',') === 'NFL,quarterback', 'an exclude the search already has is not re-added');
  ok(v.narrowing[1].value === 45, `minScore clamps to +15 over the current 30 (got ${v.narrowing[1].value})`);
  ok(v.narrowing[3].value === 'relay.example', 'a domain mute is normalized to its host');
  ok(v.proposals.map((p) => p.kind).join(',') === 'hashtags,newQuery', `broadening becomes proposals: hashtags, newQuery (got ${v.proposals.map((p) => p.kind).join(',')})`);
  ok(v.rejected === 7, `seven changes dropped (own keyword, unbacked disable, unseen search, shared host, bad source, unknown kind, empty new search) (got ${v.rejected})`);
  const capped = T.validateTuneOutput({ changes: [{ queryId: 'q2', kind: 'minScore', value: 90 }] }, { queries: [{ ...Q2, minScore: 65 }], stats });
  ok(capped.narrowing[0].value === 70, 'minScore never goes above 70');
  const prompt = T.radarTunePrompt({ brand: config.radar.brand, queries: due, stats, feedback });
  ok(prompt.includes('independent coaches in Switzerland') && prompt.includes('"NFL quarterback coach signs a new deal"') && prompt.includes('SEARCH q1') && !prompt.includes('SEARCH q3'), 'the prompt carries the audience, the examples as JSON data, and only the due searches');
  ok(!prompt.includes(String.fromCharCode(0x2014)), 'no em dash in the tune prompt');

  // ---- (f) bad output ----------------------------------------------------------------------------
  answer('I think you should exclude sports.');
  const bad = await radarTune({ action: 'run', actor: 'owner' });
  ok(bad.ok === true && bad.job && bad.job.state === 'failed' && ['bad_json', 'bad_output'].includes(bad.job.reason), `a prose answer fails the job (${bad.job && bad.job.reason})`);
  answer({ verdicts: [] });
  const bad2 = await radarTune({ action: 'run', actor: 'owner' });
  ok(bad2.job && bad2.job.state === 'failed' && bad2.job.reason === 'bad_output', `an answer without changes fails as bad_output (${bad2.job && bad2.job.reason})`);
  ok(JSON.stringify(readConfig()) === JSON.stringify(config), 'a failed tune changes nothing in config');
  ok(calls().every((c) => c.tools === ''), 'the tuner child gets NO tools');

  // ---- (c) a real run ----------------------------------------------------------------------
  answer({ changes: [
    { queryId: 'q1', kind: 'excludeKeywords', add: ['NFL', 'quarterback'], why: 'sports coaching' },
    { queryId: 'q1', kind: 'minScore', value: 40, why: 'too loose' },
    { queryId: 'q1', kind: 'muteDomain', value: 'relay.example', why: 'a news relay' },
    { queryId: 'q1', kind: 'muteAuthor', value: '@PromoBot', source: 'mastodon', why: 'a vendor' },
    { queryId: 'q2', kind: 'disable', why: 'not backed' },
    { queryId: 'q2', kind: 'hashtags', add: ['socialmedia'], why: 'where they ask' },
    { queryId: 'q2', kind: 'newQuery', query: { label: 'Buffer switchers', keywords: ['alternative to Buffer'], sources: ['reddit'] }, why: 'switchers' },
  ] });
  const ownerBefore = Object.fromEntries(RADAR_OWNER_ONLY_KEYS.map((k) => [k, getConfig().posting.radar[k]]));
  const run = await radarTune({ action: 'run', actor: 'owner' });
  ok(run.ok === true && run.job && run.job.state === 'done' && run.job.scope === 'tune', `the tune job settles done (${run.job && `${run.job.state}/${run.job.reason}`})`);
  ok(run.job.applied === 4 && run.job.proposed === 2 && run.job.rejected === 1, `4 applied, 2 proposed, 1 rejected (${run.job.applied}/${run.job.proposed}/${run.job.rejected})`);
  const cfg = readConfig().radar;
  ok(cfg.queries.length === 3 && cfg.queries.map((q) => q.id).join(',') === 'q1,q2,q3', 'config still holds the FULL queries array, in order');
  const q1 = cfg.queries.find((q) => q.id === 'q1');
  ok(q1.excludeKeywords.join(',') === 'fitness,NFL,quarterback' && q1.minScore === 40, `q1 narrowed: excludes added, minScore 30 -> 40 (${JSON.stringify({ ex: q1.excludeKeywords, m: q1.minScore })})`);
  ok(JSON.stringify(cfg.queries.find((q) => q.id === 'q2')) === JSON.stringify(Q2) && JSON.stringify(cfg.queries.find((q) => q.id === 'q3')) === JSON.stringify(Q3), 'q2 (unbacked disable) and q3 are untouched');
  const ownerAfter = Object.fromEntries(RADAR_OWNER_ONLY_KEYS.map((k) => [k, getConfig().posting.radar[k]]));
  ok(JSON.stringify(ownerAfter) === JSON.stringify(ownerBefore), 'every owner-only radar key reads exactly as before the tune');
  ok(cfg.agent.provider === 'claude-code' && cfg.agent.dailyBudget === 3 && cfg.drafting.minScore === 40 && cfg.xEnterprise === false, 'the owner values themselves survive the write');
  let st = loadState().radar;
  ok(st.muted.domains.some((d) => d.value === 'relay.example' && d.by === 'tuner') && st.muted.authors.some((a) => a.value === 'promobot' && a.source === 'mastodon' && a.by === 'tuner'), 'the mutes land in state, tagged by the tuner');
  const open = st.tuneProposals.filter((p) => p.status === 'open');
  ok(open.length === 2 && open.some((p) => p.kind === 'hashtags') && open.some((p) => p.kind === 'newQuery'), 'broadening waits as two open proposals');
  ok(st.tuneLog.length === 4 && st.tuneLog.every((e) => e.auto === true && e.id && e.at && 'before' in e && 'after' in e), 'every applied change has a log row with before/after, auto:true');
  ok(st.queryStats.q1.tunedAt && st.queryStats.q1.lessAtTune === 28 && st.queryStats.q2.tunedAt, 'the tuned searches restart their tune clock');
  ok(T.tuneCandidates(cfg.queries, st.queryStats, st.feedback, Date.now()).length === 0, 'right after a tune nothing is due again');
  const listed = await listRadar({});
  ok(listed.tune && listed.tune.proposals.length === 2 && listed.tune.log.length === 4 && listed.queryStats.q1.shown === 30, 'radar_list carries queryStats, the open proposals and the undoable log');
  // A repeat of the same proposals is not proposed twice.
  const repeat = await radarTune({ action: 'run', actor: 'owner' });
  ok(repeat.ok === true && repeat.job && repeat.job.proposed === 0, `the same proposals are never proposed twice (${repeat.job && repeat.job.proposed})`);

  // ---- (d) apply / dismiss / undo -------------------------------------------------------------
  st = loadState().radar;
  const hashP = st.tuneProposals.find((p) => p.kind === 'hashtags' && p.status === 'open');
  const newP = st.tuneProposals.find((p) => p.kind === 'newQuery' && p.status === 'open');
  const noId = await radarTune({ action: 'apply', actor: 'owner' });
  ok(noId.code === 'invalid_input', 'apply without a proposalId is refused');
  const noActor = await radarTune({ action: 'apply', proposalId: hashP.id });
  ok(noActor.code === 'invalid_input', 'every action needs an actor');
  const badAct = await radarTune({ action: 'explode', actor: 'owner' });
  ok(badAct.code === 'invalid_input', 'an unknown action is refused');
  const applied = await radarTune({ action: 'apply', proposalId: hashP.id, actor: 'owner' });
  ok(applied.ok === true && applied.log && applied.log.auto === false, 'apply writes the proposal and logs it (auto:false)');
  ok(readConfig().radar.queries.find((q) => q.id === 'q2').hashtags.join(',') === 'socialmedia', 'the proposed hashtag is on the search');
  const again = await radarTune({ action: 'apply', proposalId: hashP.id, actor: 'owner' });
  ok(again.code === 'invalid_input', 'an applied proposal cannot be applied twice');
  const addQ = await radarTune({ action: 'apply', proposalId: newP.id, actor: 'owner' });
  const qs = readConfig().radar.queries;
  ok(addQ.ok === true && qs.length === 4 && qs[3].label === 'Buffer switchers' && qs[3].id === addQ.log.after, `a new-search proposal appends a search with a fresh id (${addQ.log && addQ.log.after})`);
  // A third proposal to dismiss.
  const s2 = loadState();
  s2.radar.tuneProposals.push({ id: 'tp-manual', at: new Date().toISOString(), queryId: 'q1', kind: 'keywords', add: ['Coaching-Plattform'], why: 'German wording', status: 'open' });
  const dis = await radarTune({ action: 'dismiss', proposalId: 'tp-manual', actor: 'owner' });
  ok(dis.ok === true && loadState().radar.tuneProposals.find((p) => p.id === 'tp-manual').status === 'dismissed', 'dismiss turns a proposal down');
  ok(!(await listRadar({})).tune.proposals.some((p) => p.id === 'tp-manual'), 'a dismissed proposal leaves the list');

  st = loadState().radar;
  const logOf = (kind) => st.tuneLog.find((e) => e.kind === kind && !e.undoneAt);
  const u1 = await radarTune({ action: 'undo', logId: logOf('excludeKeywords').id, actor: 'owner' });
  ok(u1.ok === true && readConfig().radar.queries.find((q) => q.id === 'q1').excludeKeywords.join(',') === 'fitness', 'undo removes exactly the excludes the tuner added');
  const u2 = await radarTune({ action: 'undo', logId: logOf('minScore').id, actor: 'owner' });
  ok(u2.ok === true && readConfig().radar.queries.find((q) => q.id === 'q1').minScore === 30, 'undo restores the earlier minScore');
  const u3 = await radarTune({ action: 'undo', logId: logOf('muteDomain').id, actor: 'owner' });
  ok(u3.ok === true && !loadState().radar.muted.domains.some((d) => d.value === 'relay.example'), 'undo lifts the tuner mute');
  const u4 = await radarTune({ action: 'undo', logId: addQ.log.id, actor: 'owner' });
  ok(u4.ok === true && readConfig().radar.queries.length === 3, 'undo of an applied new search removes it');
  const u5 = await radarTune({ action: 'undo', logId: u1.logId, actor: 'owner' });
  ok(u5.code === 'invalid_input', 'an undone change cannot be undone twice');
  ok(!(await listRadar({})).tune.log.some((e) => e.id === u1.logId), 'an undone change leaves the undoable list');
  // The owner edits a field after the tune: undo refuses rather than overwrite their edit.
  answer({ changes: [{ queryId: 'q1', kind: 'minScore', value: 35 }] });
  const r2 = await radarTune({ action: 'run', actor: 'owner' });
  ok(r2.job && r2.job.applied === 1, 'a forced re-run applies the new minScore');
  const cfg2 = getConfig();
  setConfig({ ifRev: cfg2.rev, actor: 'owner', set: { posting: { radar: { queries: cfg2.posting.radar.queries.map((q) => (q.id === 'q1' ? { ...q, minScore: 50 } : q)) } } } });
  const msLog = loadState().radar.tuneLog.filter((e) => e.kind === 'minScore' && !e.undoneAt).pop();
  const u6 = await radarTune({ action: 'undo', logId: msLog.id, actor: 'owner' });
  ok(u6.code === 'stale_write' && readConfig().radar.queries.find((q) => q.id === 'q1').minScore === 50, 'undo never overwrites a value the owner changed since');

  // ---- (e) the revision-conflict retry ----------------------------------------------------------
  let reads = 0;
  const staleOnce = () => { reads += 1; const c = getConfig(); return reads === 1 ? { ...c, rev: 'stale-rev' } : c; };
  const retried = T.writeQueriesWithRetry({ read: staleOnce, mutate: (cur) => ({ queries: cur.map((q) => (q.id === 'q3' ? { ...q, excludeKeywords: ['spam'] } : q)) }) });
  ok(retried.ok === true && reads === 2 && readConfig().radar.queries.find((q) => q.id === 'q3').excludeKeywords[0] === 'spam', 'a revision clash re-reads once and lands on the fresh config');
  const alwaysStale = () => ({ ...getConfig(), rev: 'stale-rev' });
  const gaveUp = T.writeQueriesWithRetry({ read: alwaysStale, mutate: (cur) => ({ queries: cur }) });
  ok(gaveUp.code === 'stale_write', 'a second clash gives up with stale_write, it never loops');
  const owned = T.writeQueriesWithRetry({ mutate: (cur) => ({ queries: cur }), write: (args) => ({ ok: Object.keys(args.set.posting.radar).join(',') === 'queries' }) });
  ok(owned.ok === true, 'the seam only ever sends posting.radar.queries (no owner-only key can ride along)');

  // ---- (g) nothing due, and the daily gate -------------------------------------------------------
  const none = await radarAgentScan({ actor: 'scheduler', scope: 'tune' });
  ok(none.ok === true && none.job === null && none.tuned === 0, 'with no search due the tune spawns nothing and writes no job row');
  const { dailyRadarTune } = await import('../lib/radar-sweep.mjs');
  // Today's scans have run; nothing is due -> no job, the clock is stamped.
  const s3 = loadState();
  s3.radar.lastDailyScan = new Date().toISOString();
  s3.radar.lastAgentScan = new Date().toISOString();
  const jobsBefore = loadState().radar.jobs.length;
  const d1 = await dailyRadarTune();
  ok(d1 && d1.job === null && loadState().radar.lastTuneRun && loadState().radar.jobs.length === jobsBefore, 'the daily tune with nothing due spawns nothing and stamps its clock');
  const d2 = await dailyRadarTune();
  ok(d2 === null, 'the daily tune runs at most once a day');
} catch (err) {
  failures += 1;
  console.error('  FAIL - threw:', err && err.stack ? err.stack : err);
}

try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best effort */ }
if (failures) {
  console.error(`[radar-tuner] FAIL - ${failures} assertion(s) failed, ${pass} passed`);
  assert.fail(`${failures} assertion(s) failed`);
}
console.log(`[radar-tuner] OK - trigger, strict validation, auto-applied narrowing, proposals, undo and the rev retry (${pass} assertions).`);
