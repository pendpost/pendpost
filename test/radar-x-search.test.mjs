#!/usr/bin/env node
// test/radar-x-search.test.mjs - Radar 2.0 step 3 (spec 54): the optional X engine search.
//
// Proofs (zero network: the verb runs in-process against a stubbed fetch and auth; the scan seam
// runs an echo engine through PENDPOST_X_ENGINE):
//   (a) the recent-search query: keywords OR-ed, phrases quoted, -is:retweet, lang:xx, 512 chars;
//       the watchlist becomes from: queries;
//   (b) every request asks for the author expansion (username, description, public_metrics), and
//       a tweet maps to a Signal with authorBio + replyCount + a status url;
//   (c) the read budget: max_results never exceeds it, reads are counted, below one page the verb
//       stops with capReached;
//   (d) 429 -> rate_limited, 401/403 -> needs_scope, never a throw;
//   (e) capability: x stays search:false until the owner's switch AND the credentials exist;
//       runLaneRadar('x') still refuses a bare call;
//   (f) the scan: the month counter is persisted, from:/lists ride the first query only, and at the
//       cap the lane reports paused (read_cap) and the engine is not spawned.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-x-search-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
process.env.PENDPOST_RADAR_TIMEOUT_MS = '8000';

// The echo engine for the scan proofs: records every --query it gets, answers two posts and the
// reads it was told to report.
const echoBin = path.join(WS, 'x-echo-engine.mjs');
const dump = path.join(WS, 'x-queries.jsonl');
fs.writeFileSync(echoBin, `import fs from 'node:fs';
const i = process.argv.indexOf('--query');
const q = JSON.parse(process.argv[i + 1] || '{}');
fs.appendFileSync(${JSON.stringify(dump)}, JSON.stringify(q) + '\\n');
const n = Math.min(12, Number(q.readBudget) || 0);
const items = [1, 2].map((k) => ({ externalId: 'x' + q.id + k, url: 'https://x.com/a/status/' + k, author: 'asker' + k, text: 'What social media scheduler should I use for many networks? ' + q.id + k, ts: new Date().toISOString() }));
process.stdout.write(JSON.stringify({ ok: true, results: [{ action: 'radar', ok: true, items, reads: { posts: n, requests: 1, capReached: false } }] }) + '\\n');
`);

const resp = (body, status = 200, headers = {}) => Promise.resolve({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: () => Promise.resolve(JSON.stringify(body)) });
const tweet = (id, author = 'u1', text = 'any good scheduler for mastodon and bluesky?') => ({ id, author_id: author, text, created_at: '2026-10-28T10:00:00.000Z', public_metrics: { reply_count: 3, like_count: 1 } });
const users = [{ id: 'u1', username: 'jane_dev', name: 'Jane', description: 'indie dev, ships side projects', public_metrics: { followers_count: 120 } }];

try {
  const X = await import('../scripts/x-social.mjs');
  const R = await import('../lib/radar.mjs');

  // ---- (a) query building ---------------------------------------------------------------------
  const q1 = X.xRadarSearchQuery({ keywords: ['social media scheduler', 'buffer alternative', 'crosspost'], lang: 'en-US' });
  ok(q1 === '("social media scheduler" OR "buffer alternative" OR crosspost) -is:retweet lang:en', `keywords OR-ed, phrases quoted, -is:retweet, lang:en (${q1})`);
  ok(X.xRadarSearchQuery({ label: 'pendpost' }) === 'pendpost -is:retweet', 'no keywords: the label is the term, no lang clause without a query lang');
  ok(X.xRadarSearchQuery({}) === null, 'nothing to search: null (no request)');
  const long = X.xRadarSearchQuery({ keywords: Array.from({ length: 60 }, (_, i) => `keyword number ${i}`) });
  ok(long && long.length <= X.X_QUERY_MAX, `a long keyword list is trimmed to X's 512 characters (${long && long.length})`);
  const from = X.xRadarFromQueries(['@jane_dev', 'bob', 'bob', 'not a handle!']);
  ok(from.length === 1 && from[0] === '(from:jane_dev OR from:bob) -is:retweet', `watchlist -> one from: query, @ stripped, duplicates and junk dropped (${from[0]})`);
  ok(X.xRadarFromQueries([]).length === 0, 'an empty watchlist makes no from: query');
  const now = Date.parse('2026-10-29T12:00:00Z');
  ok(X.xStartTime(30, now) > new Date(now - 7 * 86_400_000).toISOString(), 'start_time never reaches past the 7-day recent-search window');

  // ---- (b) request shape + signal mapping ----------------------------------------------------------
  const calls = [];
  const auth = async () => 'Bearer test-token';
  let answers = [];
  const fetchStub = (url) => { calls.push(String(url)); const a = answers.shift() || { body: { data: [] } }; return resp(a.body, a.status, a.headers); };
  answers = [{ body: { data: [tweet('101'), tweet('102')], includes: { users } } }];
  let row = await X.xRadar({ id: 'q', keywords: ['scheduler'], readBudget: 50 }, { fetch: fetchStub, auth, now });
  const u0 = new URL(calls[0]);
  ok(u0.pathname === '/2/tweets/search/recent', 'the recent-search endpoint');
  ok(u0.searchParams.get('expansions') === 'author_id' && /description/.test(u0.searchParams.get('user.fields')) && /public_metrics/.test(u0.searchParams.get('user.fields')), 'the author expansion asks for username, description and public_metrics');
  ok(/public_metrics/.test(u0.searchParams.get('tweet.fields')), 'tweet.fields carries public_metrics (reply_count)');
  ok(u0.searchParams.get('max_results') === '50', `max_results follows the budget (${u0.searchParams.get('max_results')})`);
  ok(row.ok === true && row.items.length === 2, 'an ok row with both posts');
  const s0 = row.items[0];
  ok(s0.source === 'x' && s0.externalId === '101' && s0.author === 'jane_dev' && s0.url === 'https://x.com/jane_dev/status/101', `signal: source, id, handle, status url (${s0.url})`);
  ok(s0.authorBio === 'indie dev, ships side projects' && s0.authorName === 'Jane' && s0.replyCount === 3, 'signal carries authorName, authorBio and replyCount for the judge');
  ok(row.reads.posts === 2 && row.reads.requests === 1 && row.reads.capReached === false, `reads counted (${JSON.stringify(row.reads)})`);

  // ---- (c) budget ---------------------------------------------------------------------------------------
  calls.length = 0;
  answers = [{ body: { data: Array.from({ length: 12 }, (_, i) => tweet(String(200 + i))), includes: { users } } }];
  row = await X.xRadar({ id: 'q', keywords: ['scheduler'], readBudget: 15, watchHandles: ['jane_dev'], xLists: ['123'] }, { fetch: fetchStub, auth, now });
  ok(new URL(calls[0]).searchParams.get('max_results') === '15', 'a budget of 15 asks for 15 posts');
  ok(calls.length === 1 && row.reads.capReached === true, `12 read, 3 left: below one page (10), the watchlist and list reads are not started (${calls.length} call(s))`);
  calls.length = 0;
  row = await X.xRadar({ id: 'q', keywords: ['scheduler'], readBudget: 5 }, { fetch: fetchStub, auth, now });
  ok(calls.length === 0 && row.ok === true && row.items.length === 0 && row.reads.capReached === true, 'a budget under one page makes no request and says capReached');
  calls.length = 0;
  answers = [{ body: { data: [tweet('301')], includes: { users } } }, { body: { data: [tweet('302')], includes: { users } } }, { body: { data: [tweet('303')], includes: { users } } }];
  row = await X.xRadar({ id: 'q', keywords: ['scheduler'], readBudget: 300, watchHandles: ['jane_dev'], xLists: ['123'] }, { fetch: fetchStub, auth, now });
  ok(calls.length === 3 && new URL(calls[1]).searchParams.get('query') === 'from:jane_dev -is:retweet' && new URL(calls[2]).pathname === '/2/lists/123/tweets', 'with budget: search, then the from: query, then the list read');
  ok(row.items.find((s) => s.externalId === '303').community === 'x-list:123', 'a list post is marked with its list (an anchor for the pre-filter)');

  // ---- (d) refusals ---------------------------------------------------------------------------------------
  answers = [{ status: 429, body: { title: 'Too Many Requests' }, headers: { 'x-rate-limit-reset': String(Math.floor(now / 1000) + 60) } }];
  row = await X.xRadar({ id: 'q', keywords: ['s'], readBudget: 100 }, { fetch: fetchStub, auth, now });
  ok(row.ok === false && row.error === 'rate_limited' && row.retryAfter === 60, `429 -> rate_limited with retryAfter from x-rate-limit-reset (${row.error}, ${row.retryAfter})`);
  answers = [{ status: 403, body: { title: 'Client Forbidden', detail: 'client-not-enrolled' } }];
  row = await X.xRadar({ id: 'q', keywords: ['s'], readBudget: 100 }, { fetch: fetchStub, auth, now });
  ok(row.ok === false && row.error === 'needs_scope' && /HTTP 403/.test(row.detail), `403 -> needs_scope with the reason (${row.detail})`);
  row = await X.xRadar({ id: 'q', keywords: ['s'], readBudget: 100 }, { fetch: () => Promise.reject(new Error('fetch failed')), auth, now });
  ok(row.ok === false && row.error === 'engine_failure', 'a network failure is engine_failure, never a throw');

  // ---- (e) capability gating -------------------------------------------------------------------------
  const env = (vals) => (k) => vals[k] || null;
  ok(R.RADAR_CAPABILITIES.x.search === false && R.RADAR_CAPABILITIES.x.reply === false, 'the frozen table keeps x search:false and reply:false');
  ok(R.xSearchActive({ x: { search: true } }, { env: env({}) }) === false, 'switch on, no credentials: not active');
  ok(R.xSearchActive({}, { env: env({ X_ACCESS_TOKEN: 't' }) }) === false, 'credentials, switch off (default): not active');
  ok(R.xSearchActive({ x: { search: true } }, { env: env({ X_ACCESS_TOKEN: 't' }) }) === true, 'switch on + credentials: active');
  ok(R.xSearchActive({ x: { search: true }, sources: { x: { scan: false } } }, { env: env({ X_ACCESS_TOKEN: 't' }) }) === false, 'X turned off for Radar (scan:false) wins');
  ok(R.xSearchActive({ x: { search: true } }, { env: env({ X_ACCESS_TOKEN: 't' }), skippedPlatforms: ['x'] }) === false, 'a skipped X platform wins');
  ok(R.agentResearchSources(['x', 'youtube'], { xEngine: true }).join() === 'youtube' && R.agentResearchSources(['x', 'youtube']).join() === 'x,youtube', 'the agent stops researching X only while the engine searches it');
  ok(R.radarXSettings({}).monthlyReadCap === 3000 && R.radarXSettings({ x: { monthlyReadCap: 50 } }).monthlyReadCap === 50, 'monthlyReadCap defaults to 3000');
  const bare = await R.runLaneRadar('x', { id: 'q' });
  ok(bare.ok === false && bare.error === 'invalid_input', 'a bare runLaneRadar("x") still refuses');

  // ---- (f) the scan seam ---------------------------------------------------------------------------------
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { runRadarScan, listRadar } = await import('../lib/writes.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  const { envPath } = await import('../lib/util.mjs');
  const { loadState } = await import('../lib/state.mjs');
  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  const ownerSet = (radar) => asClient(() => setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar } } }));
  const good = await ownerSet({ x: { search: false, monthlyReadCap: 100, lists: ['123'] } });
  ok(good && !good.code, `config accepts posting.radar.x (${good && good.message})`);
  const bad = [await ownerSet({ x: { search: 'yes' } }), await ownerSet({ x: { monthlyReadCap: -1 } }), await ownerSet({ x: { lists: ['abc'] } })];
  ok(bad.every((r) => r && r.code === 'invalid_input'), 'config refuses a bad x subtree');
  const agentWrite = await asClient(() => setConfig({ ifRev: getConfig().rev, actor: 'agent', set: { posting: { radar: { x: { search: true } } } } }));
  ok(agentWrite && agentWrite.code === 'invalid_input' && /owner/.test(agentWrite.message), 'an agent cannot turn the paid X search on (owner-only)');

  process.env.PENDPOST_X_ENGINE = echoBin;
  await asClient(() => fs.writeFileSync(envPath(), 'X_ACCESS_TOKEN=test-token\n', { mode: 0o600 }));
  const queries = [
    { id: 'qa', label: 'A', enabled: true, sources: ['hackernews'], keywords: ['social media scheduler'] },
    { id: 'qb', label: 'B', enabled: true, sources: ['hackernews'], keywords: ['crosspost tool'] },
  ];
  const w = await asClient(() => setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { enabled: true, queries, x: { search: true, monthlyReadCap: 30, lists: ['555'] }, watchlist: { x: ['jane_dev'] } } } } }));
  ok(w && !w.code, `owner config write ok (${w && w.message})`);
  let scan = await asClient(() => runRadarScan({}));
  let seen = fs.readFileSync(dump, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok(seen.length === 2, `the x engine ran once per query (${seen.length})`);
  ok(seen[0].readBudget === 30 && seen[1].readBudget === 18, `the budget shrinks by what the first query read (${seen.map((s) => s.readBudget).join(', ')})`);
  ok(Array.isArray(seen[0].watchHandles) && seen[0].watchHandles[0] === 'jane_dev' && seen[0].xLists[0] === '555' && !('watchHandles' in seen[1]), 'from:/list reads ride the first query only');
  ok(scan.xReads && scan.xReads.scan === 24 && scan.xReads.month === 24 && scan.xReads.cap === 30, `the scan reports its reads (${JSON.stringify(scan.xReads)})`);
  ok(scan.sources.x && scan.sources.x.ok === true && scan.sources.x.reads.month === 24, 'the x lane row carries the reads');
  const st = await asClient(() => loadState());
  ok(st.radar.xReads && st.radar.xReads.posts === 24 && st.radar.xReads.month === new Date().toISOString().slice(0, 7) && st.radar.xReads.history.length === 1, `the month counter and the read log persist (${JSON.stringify(st.radar.xReads)})`);

  // Second scan: 24 of 30 used, 6 left (< one page): paused, the engine is not spawned.
  fs.writeFileSync(dump, '');
  scan = await asClient(() => runRadarScan({}));
  ok(fs.readFileSync(dump, 'utf8').trim() === '', 'at the cap the x engine is not spawned');
  ok(scan.sources.x && scan.sources.x.ok === false && scan.sources.x.error === 'paused' && scan.sources.x.reason === 'read_cap' && /read cap reached \(24 of 30/.test(scan.sources.x.detail), `the lane reports paused (cap reached), never an error (${JSON.stringify(scan.sources.x)})`);
  ok(scan.ok === true, 'the scan itself stays ok');
  const list = await asClient(() => listRadar({}));
  ok(list.xReads && list.xReads.posts === 24 && list.xReads.cap === 30, 'listRadar shows the month reads against the cap');
  ok(list.capabilities.x.search === true && list.capabilities.x.reply === false, 'with the switch on and credentials, listRadar capabilities read x search:true, reply still false');
  const xOpt = list.optionalSources.find((s) => s.id === 'x');
  ok(xOpt && xOpt.ready === true && xOpt.on === true && xOpt.costNote === 'paid_per_read' && xOpt.monthlyReadCap === 30, `optionalSources names the x switch (${JSON.stringify(xOpt)})`);

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-x-search] OK - ${pass} assertions`);
} catch (err) {
  console.error(`[radar-x-search] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
