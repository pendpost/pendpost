// radar-ingest.test.mjs - spec 38: agent-driven Radar scanning (radar_ingest).
// The connected agent does the SEARCH (its own web-search/browse tools); pendpost only
// SCORES, DEDUPES, persists and gates. radar_ingest is logRadarFootprint's sibling: the
// agent submits found conversations as signals, pendpost validates + stores them, makes
// NO new outbound request and calls NO model. This proves radar_ingest is byte-identical
// downstream to runRadarScan (same query -> same scored result), enforces the https url +
// size caps, gates on posting.radar.enabled, supports the new source:"web", and that a
// reply queued on an ingested signal is STILL excluded from auto-approve (fence unchanged).
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib (util binds
// WORKSPACE_ROOT at import; mirrors test/radar.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-ingest-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
// The fence section (spec 34) creates a campaign + a queued reply, which needs the plan store.
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const isSignal = (s) => s && typeof s.source === 'string' && s.source
  && typeof s.externalId === 'string' && s.externalId
  && typeof s.text === 'string'
  && typeof s.intentScore === 'number' && s.intentScore >= 0 && s.intentScore <= 100
  && Array.isArray(s.intentTags)
  && ['reply', 'comparison-page', 'watch', 'ignore'].includes(s.suggestedAction);

try {
  const { RADAR_SOURCES, RADAR_CAPABILITIES, RADAR_REPLY_SOURCES, scoreInto, normalizeSignal, signalKey } = await import('../lib/radar.mjs');
  const { radarIngest, runRadarScan, listRadar, triageSignal, runLaneRadar, createCampaign, queueRadarReply, approvePost } = await import('../lib/writes.mjs');
  const { inAutoApproveScope } = await import('../lib/auto-approve.mjs');
  const { loadPlanStore } = await import('../lib/plans.mjs');

  const QUERY = { id: 'q1', label: 'scheduling', sources: RADAR_SOURCES, keywords: ['schedule'], competitors: ['Buffer'], minScore: 0 };
  const COMPETITORS_DEFAULT = ['Hootsuite'];

  // ---- (a) the new source:"web" capability ---------------------------------
  ok(RADAR_CAPABILITIES.web && RADAR_CAPABILITIES.web.search === false && RADAR_CAPABILITIES.web.reply === false,
    'RADAR_CAPABILITIES.web = { search:false, reply:false } (the open-web source; never spawns an engine, never a reply form)');
  ok(RADAR_SOURCES.length === 4 && !RADAR_SOURCES.includes('web'),
    'RADAR_SOURCES stays the 4 engine lanes (web never spawns a search engine)');
  ok(!RADAR_REPLY_SOURCES.includes('web'), 'web is not a reply-capable source');

  // ---- (b) beta gate: Radar OFF => inert ------------------------------------
  const offIngest = await radarIngest({ actor: 'agent:claude', queryId: 'q1', signals: [{ source: 'web', url: 'https://example.com/a', text: 'hi' }] });
  ok(offIngest.ok === true && offIngest.enabled === false && offIngest.accepted === 0,
    'Radar OFF (default) => radarIngest is inert (enabled:false, accepted:0, no persist)');

  // Turn Radar ON with one query over all sources + a competitorsDefault.
  const configPath = path.join(WS, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ radar: { enabled: true, competitorsDefault: COMPETITORS_DEFAULT, queries: [QUERY] } }));

  // ---- (c) actor + queryId + shape gates ------------------------------------
  ok((await radarIngest({ actor: '', queryId: 'q1', signals: [] })).code === 'invalid_input', 'radarIngest requires an actor');
  ok((await radarIngest({ actor: 'a', queryId: 'nope', signals: [] })).code === 'invalid_input', 'radarIngest rejects an unknown queryId');
  ok((await radarIngest({ actor: 'a', queryId: 'q1', signals: 'x' })).code === 'invalid_input', 'radarIngest rejects a non-array signals');

  // ---- (d) US-A3: an empty signals:[] is an honest "ran, found 0" ------------
  const before = await listRadar({});
  const empty = await radarIngest({ actor: 'agent:claude', queryId: 'q1', signals: [] });
  ok(empty.ok === true && empty.accepted === 0 && empty.dropped === 0 && empty.deduped === 0, 'signals:[] => { accepted:0, dropped:0, deduped:0 } (an honest ran-found-nothing)');
  ok(typeof empty.lastScan === 'string' && !Number.isNaN(Date.parse(empty.lastScan)), 'signals:[] still restamps lastScan (the honest "last scan Xm ago" indicator)');
  ok(!('footprintRate' in empty), 'the ingest return carries NO footprintRate (that belongs to the footprint tool)');
  ok((await listRadar({})).items.length === before.items.length, 'signals:[] does not change the feed');

  // ---- (e) a scored web signal renders in the feed, byte-identically to scoreInto ----
  const rawWeb = { source: 'web', url: 'https://example.com/thread', text: 'What tool should I use to schedule posts? Any alternatives to Buffer?', author: 'someone', community: 'news.example', ts: new Date().toISOString() };
  const ing = await radarIngest({ actor: 'agent:claude', queryId: 'q1', signals: [rawWeb] });
  ok(ing.ok === true && ing.accepted === 1 && ing.dropped === 0, 'a valid web signal is accepted (accepted:1, dropped:0)');
  const feed1 = await listRadar({});
  const webSig = feed1.items.find((s) => s.source === 'web');
  ok(webSig && isSignal(webSig), 'the ingested web signal renders in the SAME ranked feed as engine signals, fully scored');
  // Byte-identical downstream: the stored score must equal a direct scoreInto with the RESOLVED
  // query + competitorsDefault (the SAME scorer/args runRadarScan uses).
  const expected = scoreInto(normalizeSignal(rawWeb, 'web'), QUERY, { competitorsDefault: COMPETITORS_DEFAULT });
  ok(webSig.intentScore === expected.intentScore, `the ingested score equals scoreInto with the resolved query (${webSig.intentScore} === ${expected.intentScore})`);
  ok(JSON.stringify([...webSig.intentTags].sort()) === JSON.stringify([...expected.intentTags].sort()), 'the ingested intentTags equal scoreInto with the resolved query');
  ok(webSig.suggestedAction === expected.suggestedAction, 'the ingested suggestedAction equals scoreInto with the resolved query');
  ok(webSig.matchedQuery === 'q1', 'the ingested signal is stamped matchedQuery = the resolved query id');

  // ---- (f) radar_ingest scores/dedupes IDENTICALLY to runRadarScan ----------
  // Scan the mock reddit lane so the feed holds engine-scored reddit signals, then re-ingest
  // one of THEM (stripped of its intent fields) under the same query. The scorer must
  // reproduce the exact same score (identical scorer), and the merge must dedupe it (identical
  // dedupe key) - not double the feed, not downgrade the signal.
  await runRadarScan({});
  const scanned = (await listRadar({ source: 'reddit' })).items[0];
  ok(scanned && isSignal(scanned), 'runRadarScan populated an engine-scored reddit signal');
  const feedLenBefore = (await listRadar({})).items.length;
  const { intentScore, intentTags, suggestedAction, watched, repliedUrl, ...bareRaw } = scanned; // strip the scored fields
  void intentScore; void intentTags; void suggestedAction; void watched; void repliedUrl;
  const reingest = await radarIngest({ actor: 'agent:claude', queryId: 'q1', signals: [bareRaw] });
  ok(reingest.accepted === 1 && reingest.deduped === 1, 're-ingesting an already-scanned signal is accepted:1 + deduped:1 (identical dedupe key source+externalId)');
  const feedAfter = await listRadar({});
  ok(feedAfter.items.length === feedLenBefore, 're-ingest does NOT double the feed (deduped by source+externalId)');
  const reSig = feedAfter.items.find((s) => signalKey(s) === signalKey(scanned));
  ok(reSig && reSig.intentScore === scanned.intentScore, `the re-ingested signal keeps the SAME score as runRadarScan produced (${reSig.intentScore}) - radar_ingest and the engine path are indistinguishable downstream`);

  // ---- (g) a non-https url is REJECTED (XSS via href + reply-prompt interpolation) ----
  const badUrl = await radarIngest({ actor: 'agent:claude', queryId: 'q1', signals: [
    { source: 'web', url: 'javascript:alert(1)', text: 'evil' },
    { source: 'web', url: 'ftp://x/y', text: 'evil2' },
    { source: 'web', url: 'https://good.example/ok', text: 'What should I use for scheduling?' },
  ] });
  ok(badUrl.accepted === 1 && badUrl.dropped === 2, 'non-https urls (javascript:, ftp:) are DROPPED; only the https signal is accepted (dropped:2)');
  ok(!(await listRadar({})).items.some((s) => /^javascript:/i.test(s.url || '')), 'no javascript: url ever enters the feed (the rendered-href injection surface is closed)');

  // ---- (h) an unknown source is dropped -------------------------------------
  const badSrc = await radarIngest({ actor: 'agent:claude', queryId: 'q1', signals: [{ source: 'facebook', url: 'https://facebook.com/x', text: 'hi' }] });
  ok(badSrc.accepted === 0 && badSrc.dropped === 1, 'a signal with an unknown source (facebook) is dropped');

  // ---- (i) size caps: text<=2000, author/community<=200, <=50 signals/call ---
  const bigText = 'x'.repeat(5000);
  const bigAuthor = 'a'.repeat(500);
  const capIng = await radarIngest({ actor: 'agent:claude', queryId: 'q1', signals: [
    { source: 'web', url: 'https://example.com/big', text: bigText, author: bigAuthor, community: 'c'.repeat(500) },
  ] });
  ok(capIng.accepted === 1, 'an over-size signal is still accepted (fields are clipped, not dropped)');
  const capSig = (await listRadar({})).items.find((s) => s.url === 'https://example.com/big');
  ok(capSig && capSig.text.length === 2000, 'text is clipped to 2000 chars');
  ok(capSig && capSig.author.length === 200 && capSig.community.length === 200, 'author + community are clipped to 200 chars');
  const many = Array.from({ length: 60 }, (_, i) => ({ source: 'web', url: `https://example.com/n${i}`, text: `looking for a tool ${i}` }));
  const manyIng = await radarIngest({ actor: 'agent:claude', queryId: 'q1', signals: many });
  ok(manyIng.accepted <= 50 && manyIng.dropped >= 10, 'no more than 50 signals per call are accepted; the excess is reported dropped (never silently discarded)');

  // ---- (j) deterministic sha256(url) externalId fallback --------------------
  const noId = await radarIngest({ actor: 'agent:claude', queryId: 'q1', signals: [{ source: 'web', url: 'https://example.com/noid', text: 'What should I use for X?' }] });
  ok(noId.accepted === 1, 'a signal with no externalId is accepted (url-hash fallback)');
  const noIdSig = (await listRadar({})).items.find((s) => s.url === 'https://example.com/noid');
  ok(noIdSig && noIdSig.externalId && noIdSig.externalId.length >= 16, 'a missing externalId is filled with a deterministic hash of the url');
  const noId2 = await radarIngest({ actor: 'agent:claude', queryId: 'q1', signals: [{ source: 'web', url: 'https://example.com/noid', text: 'What should I use for X?' }] });
  ok(noId2.deduped === 1, 're-ingesting the same url (no externalId) is idempotent: the sha256(url) fallback dedupes it');

  // ---- (k0) agent-CURATED signals persist: an old-dated ingested signal is NOT age-pruned ----
  // The agent deliberately submits threads it judged relevant; niche markets surface genuinely
  // relevant but older conversations. Unlike an engine firehose (which re-surfaces live results),
  // a curated ingest must not silently vanish under the 30-day retention prune. It is retention-
  // exempt (like a watched signal), still capped by RADAR_SIGNAL_CAP, and recency still SCORES it low.
  const oldTs = new Date(Date.now() - 120 * 86_400_000).toISOString(); // 120 days old
  const oldIngest = await radarIngest({ actor: 'agent:claude', queryId: 'q1', signals: [
    { source: 'reddit', url: 'https://reddit.com/r/askswitzerland/comments/oldbutreal', externalId: 't3_oldbutreal', text: 'Looking for a career coach recommendation in Zurich, is it worth it?', author: 'seeker', community: 'r/askswitzerland', ts: oldTs },
  ] });
  ok(oldIngest.accepted === 1 && oldIngest.total >= 1, 'an old-dated (120d) ingested signal is accepted AND kept in the feed (curated, retention-exempt)');
  const oldSig = (await listRadar({})).items.find((s) => s.externalId === 't3_oldbutreal');
  ok(oldSig, 'the 120-day-old ingested signal survives in the feed (not age-pruned like an engine firehose result)');
  // Sanity: an engine-scanned signal with the same old ts WOULD be pruned - prove the exemption is
  // specific to ingested (mergeSignals age-prunes a non-ingested, non-watched old signal).
  const { mergeSignals: mergeS } = await import('../lib/radar.mjs');
  const engineOld = mergeS([], [{ source: 'reddit', externalId: 't3_engineold', text: 't', ts: oldTs, intentScore: 50 }]);
  ok(!engineOld.some((s) => s.externalId === 't3_engineold'), 'a non-ingested old engine signal IS still age-pruned (the exemption is specific to curated ingests)');

  // ---- (k) a web signal is TRIAGEABLE (widened triageSignal source guard) ----
  const tri = await triageSignal({ source: 'web', externalId: noIdSig.externalId, action: 'dismiss', actor: 'tester' });
  ok(tri.ok === true && tri.action === 'dismiss', 'a web signal can be dismissed (triageSignal accepts every RADAR_CAPABILITIES source, not just the 4 lanes)');
  ok(!(await listRadar({})).items.some((s) => s.source === 'web' && s.externalId === noIdSig.externalId), 'the dismissed web signal is gone from the feed');

  // ---- (l) the fence is UNCHANGED: a reply queued on an INGESTED signal ------
  //         can never auto-approve (auto-approve.mjs + MANUAL_LANES byte-identical).
  await radarIngest({ actor: 'agent:claude', queryId: 'q1', signals: [
    { source: 'reddit', url: 'https://reddit.com/r/x/comments/ing', externalId: 't3_ingested', text: 'What scheduler should I use? Buffer alternative?', author: 'op', community: 'r/SaaS', ts: new Date().toISOString() },
  ] });
  await createCampaign({ id: 'ingest-fence', note: 'radar', timezone: 'UTC', actor: 'owner' });
  const q = await queueRadarReply({ campaign: 'ingest-fence', signalUrl: 'https://reddit.com/r/x/comments/ing', source: 'reddit', externalId: 't3_ingested', text: 'happy to help - here is how we approach that', actor: 'agent:radar', confirm: true });
  ok(q.ok && q.approval === 'pending', 'a reply queued on an INGESTED reddit signal seeds a PENDING reply-post');
  const post = (loadPlanStore().campaigns.find((c) => c.id === 'ingest-fence')?.posts || []).find((p) => p.id === q.postId);
  const scope = inAutoApproveScope(post, { enabled: true, platforms: ['reddit'], types: ['text'] }, { id: 'ingest-fence' });
  ok(scope.match === false && scope.reason === 'radar_reply_human_only', 'the reply on the ingested signal is EXCLUDED from auto-approve (reason radar_reply_human_only) - the fence is unchanged');

  // ---- (m) approval re-anchors the send time (owner 2026-07-20) --------------
  // A radar reply is stamped with its DRAFT time, so by approval it is usually already
  // "overdue". Approving must move it to ~5 minutes AFTER the approval - the human's
  // decision is the anchor, not the agent's draft moment.
  const approvedFrom = Date.now();
  const appr = await approvePost({ campaign: 'ingest-fence', postId: q.postId, actor: 'owner' });
  ok(appr.ok === true, 'the owner approves the radar reply');
  const apprPost = (loadPlanStore().campaigns.find((c) => c.id === 'ingest-fence')?.posts || []).find((p) => p.id === q.postId);
  const sched = Date.parse(apprPost.scheduledAt);
  ok(sched >= approvedFrom + 4 * 60 * 1000 && sched <= Date.now() + 6 * 60 * 1000, `an approved radar reply is re-scheduled ~5min after approval, not left overdue at its draft time (got ${apprPost.scheduledAt})`);

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-ingest] OK - agent-driven radar_ingest scores/dedupes like the engine, guards url/size/gate, supports web, keeps the fence (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-ingest] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
