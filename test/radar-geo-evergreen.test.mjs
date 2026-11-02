// test/radar-geo-evergreen.test.mjs - Radar 2.0 step 4 (spec 55): the threads AI answers cite
// become EVERGREEN Radar targets, through the existing GEO footprint report.
//
// Proofs:
//   (a) url validation + lane identity (lib/radar-evergreen.mjs): http(s) only, no credentials,
//       length cap, tracking params and fragment dropped; reddit/HN/bluesky/github/mastodon/x/
//       youtube map to the engine's own ids, a non-thread page on a known host maps to nothing, a
//       bare homepage is never a target;
//   (b) a cited url -> an evergreen signal: ingested, evergreen, timing evergreen, UNCLASSIFIED,
//       suggestedAction watch, never in the inbox, eligible for the judge's classification pass;
//   (c) dedup: by key and by url (a host or tracking variant), against the cache and the seen
//       ledger; an existing row (an owner-watched one included) is never rewritten;
//   (d) the cap: at most 10 new targets per running job (or per call without one);
//   (e) untrusted input: junk urls are dropped and counted, Radar off adds nothing, a non-array is
//       refused, blocked domains are honoured;
//   (f) the freshness lookback never prunes an evergreen signal (mergeSignals), and the flag is
//       sticky across a higher-scored re-ingest;
//   (g) end to end: a GEO child reports citedUrls over MCP and the targets land.
//
// HERMETIC: the GEO child is a fake binary via PENDPOST_AGENT_BIN_CLAUDE_CODE. No network.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-geo-evergreen-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));

const BIN_VAR = 'PENDPOST_AGENT_BIN_CLAUDE_CODE';
const savedBin = process.env[BIN_VAR];
let server;

// A standalone GEO child that reports one question with 12 cited threads (2 over the job cap) and
// one junk url, in two calls, so the per-JOB cap (not just the per-call cap) is what binds.
const geoBin = path.join(WS, 'geo-claude');
fs.writeFileSync(geoBin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
const call = (argsObj) => fetch(cfg.mcpServers.pendpost.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'radar_footprint_log', arguments: argsObj } }) });
const urls = (from, n) => Array.from({ length: n }, (_, i) => ({ url: 'https://forum.example.org/t/scheduler-question-' + (from + i), title: 'Which scheduler do you use? #' + (from + i) }));
call({ actor: 'agent:radar-geo', question: 'best social scheduler', mentioned: false, citedUrls: [...urls(0, 6), { url: 'javascript:alert(1)' }] })
  .then(() => call({ actor: 'agent:radar-geo', question: 'buffer alternative', mentioned: false, citedUrls: urls(6, 6) }))
  .then(() => process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'checked 2 questions' })))
  .catch((e) => { process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: String(e.message) })); process.exit(1); });
`);
fs.chmodSync(geoBin, 0o755);

try {
  const { normalizeCitedUrl, citedThread, urlDedupKey, coerceCitations, EVERGREEN_PER_RUN_CAP } = await import('../lib/radar-evergreen.mjs');
  const { RADAR_CAPABILITIES, mergeSignals, signalKey } = await import('../lib/radar.mjs');
  const { radarEligibility, freshnessFactor } = await import('../lib/radar-verdict.mjs');
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { logRadarFootprint, listRadar, radarIngest, radarAgentScan } = await import('../lib/writes.mjs');
  const { radarGeoPrompt, radarScanPrompt } = await import('../lib/radar-prompt.mjs');
  const { handleRpc, TOOLS } = await import('../lib/mcp.mjs');
  const { loadState, saveState } = await import('../lib/state.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  const cfgNow = () => asClient(() => getConfig());
  const radarNow = () => asClient(() => loadState().radar);
  const CLIENT_ROOT = clientRoot(activeClientId());
  fs.mkdirSync(CLIENT_ROOT, { recursive: true });
  fs.writeFileSync(path.join(CLIENT_ROOT, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\n');
  const caps = RADAR_CAPABILITIES;

  // ===== (a) url validation + lane identity =====
  ok(normalizeCitedUrl('javascript:alert(1)') === null && normalizeCitedUrl('data:text/html,x') === null && normalizeCitedUrl('ftp://x.org/a') === null, 'non-http(s) schemes are refused');
  ok(normalizeCitedUrl('https://user:pw@forum.example.org/t/1') === null, 'a url with embedded credentials is refused');
  ok(normalizeCitedUrl(`https://forum.example.org/${'a'.repeat(2100)}`) === null, 'an over-long url is refused');
  ok(normalizeCitedUrl('https://localhost/x') === null, 'a dotless host is refused');
  ok(normalizeCitedUrl(42) === null && normalizeCitedUrl('') === null, 'a non-string is refused');
  ok(normalizeCitedUrl('https://forum.example.org/t/1?utm_source=chatgpt.com&page=2#reply-4') === 'https://forum.example.org/t/1?page=2', 'tracking params and the fragment are dropped, real params kept');
  const t = (u) => citedThread(normalizeCitedUrl(u), { capabilities: caps });
  let th = t('https://www.reddit.com/r/socialmedia/comments/abc123/which_scheduler/');
  ok(th && th.source === 'reddit' && th.externalId === 't3_abc123' && th.community === 'socialmedia', 'a reddit thread maps to its t3_ fullname (the engine id)');
  th = t('https://old.reddit.com/r/socialmedia/comments/abc123/which_scheduler/def456/');
  ok(th && th.externalId === 't1_def456', 'a reddit comment permalink maps to its t1_ fullname');
  ok(t('https://redd.it/abc123').externalId === 't3_abc123', 'a redd.it short link maps to the post');
  ok(t('https://www.reddit.com/r/socialmedia/') === null, 'a subreddit page is not a thread');
  th = t('https://news.ycombinator.com/item?id=4242');
  ok(th && th.source === 'hackernews' && th.externalId === '4242', 'an HN item maps to its numeric id');
  ok(t('https://news.ycombinator.com/news') === null, 'the HN front page is not a thread');
  th = t('https://bsky.app/profile/did:plc:abc/post/3kxyz');
  ok(th && th.source === 'bluesky' && th.externalId === 'at://did:plc:abc/app.bsky.feed.post/3kxyz', 'a bluesky post maps to its at:// uri');
  ok(t('https://bsky.app/profile/someone.bsky.social') === null, 'a bluesky profile is not a thread');
  th = t('https://github.com/acme/tool/issues/12');
  ok(th && th.source === (caps.github ? 'github' : 'web'), `a github issue is a thread (source ${th && th.source})`);
  ok(t('https://github.com/acme/tool') === null && t('https://github.com/acme/tool/blob/main/README.md') === null, 'a repo page or README is not a thread');
  th = citedThread(normalizeCitedUrl('https://mastodon.social/@alice/112233445566'), { capabilities: caps, mastodonHost: 'mastodon.social' });
  ok(th && th.source === 'mastodon' && th.externalId === '112233445566' && th.community === 'mastodon.social', 'a status on the home instance maps to its id');
  // Security review: a status id is local to its instance; on the home instance it would name a
  // different post, so a status cited from another instance is a web thread, never a mastodon id.
  th = citedThread(normalizeCitedUrl('https://fosstodon.org/@bob/112233445566'), { capabilities: caps, mastodonHost: 'mastodon.social' });
  ok(th && th.source === (caps.web ? 'web' : th && th.source) && th.source !== 'mastodon', 'a status on another instance is never a mastodon id');
  ok((t('https://mastodon.social/@alice/1') || {}).source !== 'mastodon', 'with no home instance configured, no status maps to mastodon');
  th = t('https://x.com/someone/status/1800000000000000000');
  ok(th && th.source === 'x' && th.externalId === '1800000000000000000', 'a tweet maps to its id');
  th = t('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  ok(th && th.source === 'youtube' && th.externalId === 'dQw4w9WgXcQ', 'a youtube video maps to its id');
  th = t('https://forum.example.org/t/which-scheduler/99');
  ok(th && th.source === 'web' && /^[a-f0-9]{64}$/.test(th.externalId), 'any other thread is an open-web signal with a sha256 id (the radar_ingest rule)');
  ok(t('https://vendor.example.com/') === null, 'a bare homepage is never a target');
  ok(urlDedupKey('https://www.reddit.com/r/a/comments/x1/y/') === urlDedupKey('https://old.reddit.com/r/a/comments/x1/y?utm_source=z'), 'the url dedup key ignores host prefixes, trailing slashes and tracking');
  const co = coerceCitations(['https://forum.example.org/t/1', { url: 'https://forum.example.org/t/2', title: '  A   title ' }, { nope: 1 }, 7]);
  ok(co.items.length === 2 && co.items[1].title === 'A title' && co.invalid === 2, 'coerceCitations accepts strings and {url,title}, counts the rest invalid');

  // ===== (e) Radar off adds nothing =====
  let r = await asClient(() => logRadarFootprint({ actor: 'agent:radar-geo', question: 'best scheduler', mentioned: false, citedUrls: [{ url: 'https://forum.example.org/t/off-1' }] }));
  ok(r.ok === true && r.evergreen && r.evergreen.added === 0 && r.evergreen.skipped === 'radar_off', 'Radar off -> the footprint lands, no evergreen target is added');
  ok((radarNow().signals || []).length === 0, 'no signal exists after the Radar-off call');

  await asClient(() => setConfig({
    ifRev: cfgNow().rev,
    actor: 'owner',
    set: { posting: { radar: {
      enabled: true,
      lookbackDays: 7,
      blockedDomains: ['spam.example'],
      queries: [{ id: 'q1', label: 'Scheduling', enabled: true, keywords: ['scheduling'] }],
      sources: { reddit: { scan: true }, mastodon: { scan: false }, bluesky: { scan: false }, hackernews: { scan: false } },
    } } },
  }));

  r = await asClient(() => logRadarFootprint({ actor: 'agent:radar-geo', question: 'q', mentioned: false, citedUrls: 'https://x.org/a' }));
  ok(r.ok !== true && r.code === 'invalid_input', 'a non-array citedUrls is refused');

  // ===== (b) a cited url becomes an evergreen signal =====
  r = await asClient(() => logRadarFootprint({
    actor: 'agent:radar-geo', question: 'what is the best social media scheduler?', mentioned: false, assistant: 'ChatGPT',
    citedUrls: [
      { url: 'https://www.reddit.com/r/socialmedia/comments/abc123/which_scheduler/?utm_source=chatgpt.com', title: 'Which scheduler do you use for 5 platforms?' },
      { url: 'https://news.ycombinator.com/item?id=4242', title: 'Ask HN: what do you use to schedule posts?' },
      { url: 'javascript:alert(document.cookie)' },
      { url: 'https://vendor.example.com/' },
      { url: 'https://spam.example/t/1' },
      { url: 'https://www.reddit.com/r/socialmedia/' },
    ],
  }));
  ok(r.ok === true && r.evergreen.added === 2, `two cited threads were added (got ${JSON.stringify(r.evergreen)})`);
  ok(r.evergreen.dropped === 4, 'the junk url, the homepage, the blocked domain and the non-thread page were dropped and counted');
  let st = radarNow();
  const ev = st.signals.find((s) => s.source === 'reddit' && s.externalId === 't3_abc123');
  ok(ev && ev.evergreen === true && ev.timing === 'evergreen' && ev.ingested === true, 'the signal is evergreen, timing evergreen, ingested (curated)');
  ok(ev && ev.unclassified === true && !ev.intent && !ev.authorRole && ev.replyable === undefined, 'it is UNCLASSIFIED: no intent, role or replyable on the agent\'s word');
  ok(ev && ev.suggestedAction === 'watch' && radarEligibility(ev).tier === 'watch', 'its action is watch: never drafted or an ask until the judge reads it');
  ok(ev && ev.url === 'https://www.reddit.com/r/socialmedia/comments/abc123/which_scheduler/', 'the stored url is the normalised one (tracking dropped)');
  ok(ev && ev.text === 'Which scheduler do you use for 5 platforms?' && ev.threadTitle === ev.text, 'the title is the text and the thread title the judge reads');
  ok(ev && ev.citedFor && ev.citedFor.question === 'what is the best social media scheduler?' && ev.citedFor.assistant === 'ChatGPT', 'the row says which question and assistant cited it');
  ok(ev && /Cited by an AI answer/.test(ev.reason || ''), 'the reason line tells the operator why an old thread is here');
  ok(ev && ev.ts == null, 'no invented date');
  ok(st.geo.footprint.slice(-1)[0].cited === 2, 'the footprint entry records how many threads the answer cited');
  let feed = await asClient(() => listRadar({}));
  const listed = feed.items.find((s) => s.externalId === 't3_abc123');
  ok(listed, 'the evergreen signal is listed in the feed');
  ok(listed && listed.inboxRank == null && feed.inbox && feed.inbox.shown === 0, 'it is never in the inbox while unclassified');
  ok(freshnessFactor({ evergreen: true, timing: 'fresh', ts: '2020-01-01T00:00:00Z' }) === 0.7, 'an evergreen-flagged signal keeps the evergreen freshness weight whatever timing the judge reads');
  const evergreenTool = TOOLS.find((x) => x.name === 'radar_footprint_log');
  ok(evergreenTool && evergreenTool.inputSchema.properties.citedUrls && evergreenTool.inputSchema.properties.citedUrls.items.required.includes('url'), 'radar_footprint_log declares citedUrls[{url,title}]');

  // ===== (c) dedup + never rewrite =====
  // The owner watches the HN one and dismisses a third thread; a re-report must touch neither.
  asClient(() => {
    const s = loadState();
    const hn = s.radar.signals.find((x) => x.source === 'hackernews');
    hn.watched = true;
    hn.text = 'owner kept this';
    s.radar.seen.push({ source: 'web', externalId: citedThread(normalizeCitedUrl('https://forum.example.org/t/dismissed'), { capabilities: caps }).externalId, at: new Date().toISOString(), by: 'owner' });
    saveState();
  });
  const seenBefore = JSON.stringify(radarNow().seen);
  r = await asClient(() => logRadarFootprint({
    actor: 'agent:radar-geo', question: 'again', mentioned: false,
    citedUrls: [
      { url: 'https://old.reddit.com/r/socialmedia/comments/abc123/which_scheduler', title: 'REWRITTEN TITLE' },
      { url: 'https://news.ycombinator.com/item?id=4242', title: 'REWRITTEN' },
      { url: 'https://forum.example.org/t/dismissed' },
    ],
  }));
  ok(r.evergreen.added === 0 && r.evergreen.deduped === 3, `every known thread is deduped (got ${JSON.stringify(r.evergreen)})`);
  st = radarNow();
  ok(st.signals.find((s) => s.externalId === 't3_abc123').text === 'Which scheduler do you use for 5 platforms?', 'the existing row is not rewritten by a re-report');
  const hnRow = st.signals.find((s) => s.source === 'hackernews');
  ok(hnRow.watched === true && hnRow.text === 'owner kept this', 'the owner-watched row is untouched');
  ok(!st.signals.some((s) => s.url === 'https://forum.example.org/t/dismissed'), 'a dismissed thread never comes back');
  ok(JSON.stringify(st.seen) === seenBefore, 'the seen ledger is untouched');
  // A url variant of an existing ENGINE signal (same thread, different id form) is deduped by url.
  asClient(() => {
    const s = loadState();
    s.radar.signals.push({ source: 'mastodon', externalId: '999', url: 'https://fosstodon.org/@bob/555', author: 'bob', text: 'which scheduler?', intentScore: 50, intentTags: [], suggestedAction: 'reply', ts: new Date().toISOString() });
    saveState();
  });
  r = await asClient(() => logRadarFootprint({ actor: 'agent:radar-geo', question: 'q2', mentioned: false, citedUrls: [{ url: 'https://fosstodon.org/@bob/555/' }] }));
  ok(r.evergreen.added === 0 && r.evergreen.deduped === 1, 'a thread already stored under another id is deduped by url');

  // ===== (d) the cap =====
  const fifteen = Array.from({ length: 15 }, (_, i) => ({ url: `https://forum.example.org/t/cap-${i}` }));
  r = await asClient(() => logRadarFootprint({ actor: 'agent:radar-geo', question: 'cap', mentioned: false, citedUrls: fifteen }));
  ok(r.evergreen.added === EVERGREEN_PER_RUN_CAP && r.evergreen.capped === 5, `without a job the cap is per call: ${EVERGREEN_PER_RUN_CAP} added, 5 capped (got ${JSON.stringify(r.evergreen)})`);

  // ===== (f) the lookback never prunes an evergreen signal =====
  const now = Date.now();
  const old = { source: 'web', externalId: 'old1', url: 'https://forum.example.org/t/old', text: 'old', ingested: true, intentScore: 10, ts: '2019-01-01T00:00:00Z' };
  const merged = mergeSignals([{ ...old }, { ...old, externalId: 'ever1', evergreen: true }, { ...old, externalId: 'ever2', evergreen: true, ts: null }], [], [], now, { lookbackDays: 7 });
  ok(!merged.some((s) => s.externalId === 'old1'), 'an old ingested signal is pruned by the lookback');
  ok(merged.some((s) => s.externalId === 'ever1') && merged.some((s) => s.externalId === 'ever2'), 'old and undated evergreen signals survive the lookback');
  const reIngested = mergeSignals([{ ...old, externalId: 'ever3', evergreen: true }], [{ ...old, externalId: 'ever3', intentScore: 90 }], [], now, { lookbackDays: 7 });
  ok(reIngested.length === 1 && reIngested[0].evergreen === true && reIngested[0].intentScore === 90, 'evergreen is sticky when a higher-scored copy replaces the row');
  // ...and through the real persist path: an unrelated ingest merges, the cited threads stay.
  const evergreenBefore = radarNow().signals.filter((s) => s.evergreen === true).length;
  await asClient(() => radarIngest({ actor: 'agent:radar-scan', queryId: 'q1', signals: [{ source: 'web', url: 'https://example.com/fresh', text: 'what do you use for scheduling?', ts: new Date().toISOString(), authorRole: 'seeker', intent: 'ask_reco', replyable: true }] }));
  ok(radarNow().signals.filter((s) => s.evergreen === true).length === evergreenBefore, `an ingest merge with a 7-day lookback keeps every undated evergreen target (${evergreenBefore})`);

  // ===== prompts =====
  const geoBrief = radarGeoPrompt(['best scheduler'], { clientId: 'acme' });
  ok(/citedUrls/.test(geoBrief) && /never invent or guess one/.test(geoBrief) && /vendor homepage/.test(geoBrief), 'the GEO brief asks for citedUrls, never invented, never vendor pages');
  ok(/citedUrls/.test(radarScanPrompt([{ id: 'q1', keywords: ['x'] }], 20, 'acme', null, { questions: ['best scheduler'] })), 'the folded GEO block in the scan brief asks for them too');

  // ===== (g) end to end: the GEO child reports citations over MCP, the per-JOB cap binds =====
  asClient(() => { const s = loadState(); s.radar.signals = []; saveState(); });
  await asClient(() => setConfig({ ifRev: cfgNow().rev, actor: 'owner', set: { posting: { radar: { geo: { buyingQuestions: ['best social scheduler', 'buffer alternative'] }, agent: { provider: 'claude-code' } } } } }));
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const out = await handleRpc(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  process.env.PENDPOST_PORT = String(server.address().port);
  process.env[BIN_VAR] = geoBin;
  r = await asClient(() => radarAgentScan({ actor: 'owner', scope: 'geo' }));
  ok(r.ok === true && r.job && r.job.state === 'done', `the GEO recheck ran to done (${r.job && r.job.state} ${r.job && r.job.reason})`);
  st = radarNow();
  const landed = st.signals.filter((s) => s.evergreen === true);
  ok(landed.length === EVERGREEN_PER_RUN_CAP, `12 cited threads over two calls -> ${EVERGREEN_PER_RUN_CAP} land (the per-JOB cap; got ${landed.length})`);
  ok(landed.every((s) => s.unclassified === true && s.suggestedAction === 'watch'), 'every landed target is unclassified and watch-only');
  ok(st.jobs[0].evergreenAdded === EVERGREEN_PER_RUN_CAP, 'the job row counts the evergreen targets it added');
  ok(!st.signals.some((s) => /javascript/i.test(s.url)), 'the junk url never landed');
  ok(st.geo.footprint.length >= 2, 'both footprint checks were recorded');
  void signalKey;
} catch (e) {
  failures += 1;
  console.error('  FAIL - threw:', e && e.stack ? e.stack : e);
} finally {
  if (server) server.close();
  if (savedBin === undefined) delete process.env[BIN_VAR]; else process.env[BIN_VAR] = savedBin;
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
