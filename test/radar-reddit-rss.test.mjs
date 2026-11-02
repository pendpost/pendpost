#!/usr/bin/env node
// test/radar-reddit-rss.test.mjs - the read-only Reddit RSS fallback for an unconnected reddit
// Radar lane (docs/plans/radar-relevance-2026-09-30, lib/radar-reddit-rss.mjs).
//
// Reddit's search lane needs a BYO OAuth app, which no client has, so the lane sat at
// not_connected and nobody scanned Reddit at all. Its public search feeds answer without auth.
// Proven here, with NO live network call (fetch is stubbed, the clock is fake):
//   (1) URL building: one OR-of-quoted-phrases search, restrict_sr per listed subreddit, the `t`
//       window sized from the lookback, proper encoding.
//   (2) Atom parsing from a realistic fixture: ids, permalinks, authors without /u/, subreddit,
//       HTML stripped, entities decoded, Reddit's "submitted by" footer dropped, published ts.
//   (3) Pacing: >= 10s between requests (also across scans and concurrent callers), at most 12
//       per scan, the rest counted as skipped.
//   (4) 429 backs off exponentially then stops the lane cleanly; 403 stops it at once; a stop
//       after earlier yields keeps the items and carries the degrade.
//   (5) Capabilities: an RSS lane never claims reply or followup; it takes the copy-paste path.
//   (6) The scan seam: a connected (or refused) OAuth lane never touches RSS; an unconnected one
//       searches RSS, the candidates run the normal pre-filter + judge path, the row says
//       mode:'rss', and an answer to such a thread saves as a copy draft. A query naming reddit
//       is searched even when reddit is in skippedPlatforms; a sources-less query is not.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-rss-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE; // the fallback is live-mode only; every fetch below is stubbed
const realFetch = global.fetch;

// The fixture, with its September dates moved to "a few days ago" so the lookback window never
// ages it out whenever the suite runs.
const DAY = 86_400_000;
const FIXTURE = fs.readFileSync(path.join(HERE, 'fixtures', 'reddit-search.atom'), 'utf8')
  .replace(/2026-09-(\d\d)T/g, (_m, d) => `${new Date(Date.now() - (31 - Number(d)) * DAY).toISOString().slice(0, 10)}T`);

// A fetch stub: answers from `answer(url, n)` ({ status, body, retryAfter }), records every call.
function stubFetch(answer, clock = null) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const n = calls.length;
    calls.push({ url: String(url), at: clock ? clock.now() : Date.now(), ua: init.headers && init.headers['User-Agent'] });
    const a = answer(String(url), n) || {};
    const status = a.status || 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => (String(k).toLowerCase() === 'retry-after' && a.retryAfter != null ? String(a.retryAfter) : null) },
      text: async () => (a.body != null ? a.body : ''),
    };
  };
  fn.calls = calls;
  return fn;
}
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}
const freshShared = () => ({ lastAt: 0, notBefore: 0, chain: Promise.resolve() });
const gaps = (calls) => calls.slice(1).map((c, i) => c.at - calls[i].at);

try {
  const rss = await import('../lib/radar-reddit-rss.mjs');
  const radar = await import('../lib/radar.mjs');
  const { engineDropReason } = await import('../lib/radar-prefilter.mjs');

  // ===== (1) URL building =====
  ok(rss.redditRssQuery({ keywords: ['social media scheduler', 'buffer alternative'] }) === '("social media scheduler" OR "buffer alternative")',
    'keywords become ONE search: quoted phrases OR-ed in parentheses');
  ok(rss.redditRssQuery({ keywords: ['self-hosted scheduler'] }) === '"self-hosted scheduler"', 'a single keyword is just the quoted phrase');
  ok(rss.redditRssQuery({ keywords: ['A b', 'a B', ' "quoted" x '] }) === '("A b" OR "quoted x")', 'duplicates (case-insensitive) collapse; inner double quotes are dropped');
  ok(rss.redditRssQuery({ label: 'Coach werden' }) === '"Coach werden"', 'no keywords: the label is the phrase');
  ok(rss.redditRssQuery({}) === '', 'nothing to search: an empty query');
  const long = rss.redditRssQuery({ keywords: Array.from({ length: 60 }, (_, i) => `keyword phrase number ${i}`) });
  ok(long.length <= rss.RSS_QUERY_MAX && long.startsWith('("keyword phrase number 0"'), `a long keyword list is cut to fit Reddit's limit (${long.length} chars), first keywords first`);

  ok(rss.rssWindowFor(1 / 48) === 'hour' && rss.rssWindowFor(1) === 'day' && rss.rssWindowFor(7) === 'week'
    && rss.rssWindowFor(30) === 'month' && rss.rssWindowFor(90) === 'year' && rss.rssWindowFor(undefined) === 'week',
  't window = the smallest of hour/day/week/month/year covering the lookback; absent = week');

  const subUrl = rss.redditRssUrl({ q: '("social media scheduler" OR "Zürich coach")', subreddit: 'r/selfhosted', t: 'month' });
  const su = new URL(subUrl);
  ok(su.origin === 'https://www.reddit.com' && su.pathname === '/r/selfhosted/search.rss', `a subreddit search hits /r/<sub>/search.rss (${su.pathname})`);
  ok(su.searchParams.get('q') === '("social media scheduler" OR "Zürich coach")' && su.searchParams.get('restrict_sr') === '1'
    && su.searchParams.get('sort') === 'new' && su.searchParams.get('t') === 'month', 'q round-trips, restrict_sr=1, sort=new, t=month');
  ok(subUrl.includes('%22social+media+scheduler%22') && subUrl.includes('Z%C3%BCrich') && subUrl.includes('%28'), 'quotes, spaces, umlauts and parentheses are percent-encoded');
  const globalUrl = new URL(rss.redditRssUrl({ q: '"x"', t: 'week' }));
  ok(globalUrl.pathname === '/search.rss' && !globalUrl.searchParams.has('restrict_sr'), 'no subreddit: the Reddit-wide /search.rss, never restrict_sr');
  const perSub = rss.redditRssUrlsFor({ keywords: ['a'], subreddits: ['r/selfhosted', '/r/SaaS/', 'selfhosted'], lookbackDays: 30 });
  ok(perSub.length === 2 && perSub.every((u) => new URL(u.url).searchParams.get('t') === 'month') && perSub[1].subreddit === 'SaaS',
    'one search per distinct listed subreddit ("r/x", "/r/x/" and "x" are the same sub), window from lookbackDays');
  const oneGlobal = rss.redditRssUrlsFor({ keywords: ['a', 'b'] });
  ok(oneGlobal.length === 1 && oneGlobal[0].subreddit === null, 'no subreddits: exactly one global search for all keywords');
  ok(/^pendpost-radar\/\S+ \(\+https:\/\/pendpost\.com\)$/.test(rss.redditRssUserAgent()), `descriptive User-Agent (${rss.redditRssUserAgent()})`);

  // ===== (2) Atom parsing =====
  const items = rss.parseRedditAtom(FIXTURE);
  ok(items.length === 3, `the three entries with an id parse, the id-less one is skipped (${items.length})`);
  const [a, b, c] = items;
  ok(a.source === 'reddit' && a.externalId === 't3_1abc2de', 'externalId is the t3_ fullname');
  ok(a.url === 'https://www.reddit.com/r/selfhosted/comments/1abc2de/looking_for_a_selfhosted_social_media_scheduler/', 'url is the thread permalink');
  ok(a.author === 'example_seeker' && b.author === 'Another-User_42', 'author has the /u/ prefix stripped');
  ok(a.community === 'r/selfhosted', 'community is r/<subreddit>');
  ok(a.text.startsWith('Looking for a self-hosted social media scheduler\n\nBuffer just raised prices again'), 'text = title, blank line, body');
  ok(!/[<>]/.test(a.text.replace(/<10/, '')) && !/SC_OFF|img|href|table/i.test(a.text), 'HTML tags, comments and the thumbnail table are gone');
  ok(a.text.includes("I'm done paying per channel 😅") && a.text.includes('Mastodon, Bluesky & LinkedIn') && a.text.includes('"just works"'),
    'double-escaped entities decode (&amp;#39; -> \', &amp;amp; -> &, &amp;quot; -> "), emoji survive');
  ok(!/submitted by|\[link\]|\[comments\]/.test(a.text + b.text + c.text), "Reddit's \"submitted by ... [link] [comments]\" footer is dropped");
  ok(b.text.includes('Budget is <10 €/month.') && b.text.startsWith('Buffer alternative with local drafts & an API?'), 'numeric (&#x20AC;) and named entities decode in body and title');
  ok(c.text === 'The 2026 "social media scheduler" roundup', 'a link post is its title alone');
  ok(a.ts && Date.parse(a.ts) === Date.parse(FIXTURE.match(/<published>([^<]+)<\/published>/)[1]), 'ts comes from <published>');
  ok(rss.parseRedditAtom('<html>not a feed</html>').length === 0 && rss.parseRedditAtom(null).length === 0, 'a malformed feed yields [] and never throws');
  const updatedOnly = rss.parseRedditAtom('<feed><entry><id>t3_zz9</id><link href="https://www.reddit.com/r/x/comments/zz9/y/"/><updated>2026-01-02T03:04:05+00:00</updated><title>t</title></entry></feed>');
  ok(updatedOnly.length === 1 && updatedOnly[0].ts === '2026-01-02T03:04:05.000Z' && updatedOnly[0].community === 'r/x', 'no <published>: <updated> is the ts; the sub falls back to the permalink');
  ok(rss.htmlToText('<p>a&amp;b</p><script>x()</script><p>c</p>') === 'a&b\nc' && rss.decodeEntities('&#128512;&#xZZ;&bogus;') === '😀&#xZZ;&bogus;',
    'htmlToText drops scripts and keeps paragraph breaks; unknown references are left as written');

  // ===== (3) pacing =====
  {
    const clock = fakeClock();
    const f = stubFetch(() => ({ body: FIXTURE }), clock);
    const pacer = rss.createRedditRssPacer({ now: clock.now, sleep: clock.sleep, shared: freshShared() });
    const subs = Array.from({ length: 15 }, (_, i) => `sub${i}`);
    const r = await rss.searchRedditRss({ keywords: ['social media scheduler'], subreddits: subs }, { pacer, fetch: f });
    ok(f.calls.length === rss.RSS_MAX_REQUESTS && pacer.used === 12, `a 15-subreddit query spends exactly the 12-request budget (${f.calls.length} fetches)`);
    ok(gaps(f.calls).every((g) => g >= 10_000), `every request starts >= 10s after the previous one (gaps ${[...new Set(gaps(f.calls))].join(',')})`);
    ok(pacer.skipped === 3, `the 3 searches past the budget are counted as skipped (${pacer.skipped})`);
    ok(r.ok === true && r.mode === 'rss' && r.items.length === 3, 'the result is ok, mode rss, and the same thread seen in several feeds counts once');
    ok(f.calls.every((call) => /^pendpost-radar\//.test(call.ua || '')), 'every request carries the descriptive User-Agent');
    const again = await rss.searchRedditRss({ keywords: ['x'] }, { pacer, fetch: f });
    ok(f.calls.length === 12 && again.ok === true && again.items.length === 0 && pacer.skipped === 4, 'a later query in the SAME scan makes no request once the budget is spent');
  }
  {
    // Two scans (two pacers) share the process clock; concurrent callers are serialized.
    const clock = fakeClock();
    const shared = freshShared();
    const f = stubFetch(() => ({ body: FIXTURE }), clock);
    const p1 = rss.createRedditRssPacer({ now: clock.now, sleep: clock.sleep, shared });
    const p2 = rss.createRedditRssPacer({ now: clock.now, sleep: clock.sleep, shared });
    await Promise.all([
      rss.searchRedditRss({ keywords: ['a'], subreddits: ['one', 'two'] }, { pacer: p1, fetch: f }),
      rss.searchRedditRss({ keywords: ['b'], subreddits: ['three'] }, { pacer: p2, fetch: f }),
    ]);
    ok(f.calls.length === 3 && gaps(f.calls).every((g) => g >= 10_000), `concurrent scans are serialized and still >= 10s apart (gaps ${gaps(f.calls).join(',')})`);
  }

  // ===== (4) 429 / 403 / partial =====
  {
    const clock = fakeClock();
    const f = stubFetch(() => ({ status: 429 }), clock);
    const pacer = rss.createRedditRssPacer({ now: clock.now, sleep: clock.sleep, shared: freshShared() });
    const r = await rss.searchRedditRss({ keywords: ['a'], subreddits: ['one', 'two'] }, { pacer, fetch: f });
    ok(f.calls.length === 1 + rss.RSS_MAX_RETRIES, `a persistent 429 is retried ${rss.RSS_MAX_RETRIES} times, no more (${f.calls.length} fetches)`);
    const g = gaps(f.calls);
    ok(g[0] >= rss.RSS_BACKOFF_BASE_MS && g[1] >= 2 * rss.RSS_BACKOFF_BASE_MS, `the backoff grows exponentially (${g.join(',')} ms)`);
    ok(r.ok === false && r.error === 'rate_limited' && r.mode === 'rss' && r.items.length === 0, 'then the lane stops cleanly: ok:false, rate_limited, mode rss');
    ok(r.degraded === true && r.detail === rss.REDDIT_RSS_LIMITED_DETAIL, `the 429 stop says degraded, plainly (${r.detail})`);
    ok(pacer.stopped && pacer.stopped.error === 'rate_limited' && pacer.skipped === 1, 'the stop is remembered for the scan and the unasked subreddit counts as skipped');
    const after = await rss.searchRedditRss({ keywords: ['b'] }, { pacer, fetch: f });
    ok(f.calls.length === 3 && after.ok === false && after.error === 'rate_limited', 'a later query in the same scan makes NO request and reports the stop');
  }
  {
    const clock = fakeClock();
    const f = stubFetch((u, n) => (n === 0 ? { status: 429, retryAfter: 50 } : { body: FIXTURE }), clock);
    const pacer = rss.createRedditRssPacer({ now: clock.now, sleep: clock.sleep, shared: freshShared() });
    const r = await rss.searchRedditRss({ keywords: ['a'] }, { pacer, fetch: f });
    ok(f.calls.length === 2 && gaps(f.calls)[0] >= 50_000 && r.ok === true && r.items.length === 3, 'a longer Retry-After is honoured, and a retry that succeeds yields normally');
  }
  {
    const clock = fakeClock();
    const f = stubFetch(() => ({ status: 403, body: 'blocked' }), clock);
    const pacer = rss.createRedditRssPacer({ now: clock.now, sleep: clock.sleep, shared: freshShared() });
    const r = await rss.searchRedditRss({ keywords: ['a'], subreddits: ['one', 'two'] }, { pacer, fetch: f });
    ok(f.calls.length === 1 && r.ok === false && r.error === 'engine_failure' && /403/.test(r.detail || '') && pacer.stopped, 'a 403 stops the lane at once, no retry');
    // Radar 2.0 step 3: no OAuth + a refused public feed reads as an honest degrade, with the way out.
    ok(r.degraded === true && r.detail === rss.REDDIT_RSS_REFUSED_DETAIL && /Connect a Reddit app \(OAuth\)/.test(r.detail), `the 403 row says degraded, plainly (${r.detail})`);
  }
  {
    const clock = fakeClock();
    const f = stubFetch((u) => (u.includes('/r/one/') ? { body: FIXTURE } : { status: 429 }), clock);
    const pacer = rss.createRedditRssPacer({ now: clock.now, sleep: clock.sleep, shared: freshShared() });
    const r = await rss.searchRedditRss({ keywords: ['a'], subreddits: ['one', 'two'] }, { pacer, fetch: f });
    ok(r.ok === true && r.items.length === 3 && r.degrade && r.degrade.error === 'rate_limited', 'a stop after an earlier subreddit yielded keeps the items and carries the degrade');
  }
  {
    const clock = fakeClock();
    const f = stubFetch((u) => (u.includes('/r/one/') ? { status: 502 } : { body: FIXTURE }), clock);
    const pacer = rss.createRedditRssPacer({ now: clock.now, sleep: clock.sleep, shared: freshShared() });
    const r = await rss.searchRedditRss({ keywords: ['a'], subreddits: ['one', 'two'] }, { pacer, fetch: f });
    ok(r.ok === true && r.items.length === 3 && r.degrade && r.degrade.error === 'engine_failure' && !pacer.stopped, 'a 5xx is that one search\'s problem: the next subreddit is still asked');
  }

  // ===== (5) capabilities =====
  const rssRows = { reddit: { ok: true, mode: 'rss' } };
  const caps = radar.effectiveRadarCapabilities({}, rssRows);
  ok(caps.reddit.reply === false && caps.reddit.copyDraft === true && !('followup' in caps.reddit) && caps.reddit.search === true && caps.reddit.mode === 'rss',
    'an RSS lane claims no reply and no followup; it is search + copy-draft');
  ok(!radar.radarReplySources({}, rssRows).includes('reddit') && radar.radarCopyDraftSources({}, rssRows).includes('reddit'), 'reddit leaves the reply sources and joins the copy-draft sources');
  ok(radar.radarReplySources({}, { reddit: { ok: false, error: 'rate_limited', mode: 'rss' } }).includes('reddit') === false, 'a failed RSS row is still RSS: no reply');
  ok(radar.effectiveRadarCapabilities({}, { reddit: { ok: true } }).reddit.reply === true && radar.effectiveRadarCapabilities({}).reddit.reply === true,
    'an OAuth row (no mode) or no rows at all: the capability table is unchanged');
  const both = radar.effectiveRadarCapabilities({ xEnterprise: true }, rssRows);
  ok(both.x.reply === true && both.reddit.reply === false && radar.RADAR_CAPABILITIES.reddit.reply === true, 'xEnterprise and RSS compose; the frozen table itself is never mutated');

  // The phrase-gate exemption only holds when the search was restricted to a listed subreddit.
  const off = radar.normalizeSignal({ ...a, text: 'Which tool do you all use for this?' }, 'reddit');
  ok(engineDropReason(off, { keywords: ['social media scheduler'], subreddits: ['selfhosted'] }) === null, 'a hit from a listed-subreddit search skips the phrase gate (the community is the anchor)');
  ok(engineDropReason(off, { keywords: ['social media scheduler'] }) === 'noAnchor', 'the same hit from a Reddit-wide search must anchor on the phrase (dropped: noAnchor)');

  // Default scan set: reddit is in it while not connected; the skip rules are the query-level ones.
  ok(radar.effectiveRadarSources({}, () => false, []).includes('reddit'), 'an unconnected reddit lane is in the default scan set');
  const skippedDefaults = radar.effectiveRadarSources({}, () => false, ['reddit']);
  ok(radar.radarQueryLanes({ sources: ['reddit'] }, skippedDefaults).includes('reddit') && !radar.radarQueryLanes({}, skippedDefaults).includes('reddit'),
    'reddit in skippedPlatforms: a query naming reddit still gets it, a sources-less query does not');

  // ===== (6) the scan seam =====
  const { initMultiClient, clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  initMultiClient();
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { runRadarScan, listRadar, queueRadarReply } = await import('../lib/writes.mjs');
  const { loadState } = await import('../lib/state.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const ROOT = clientRoot(activeClientId());
  const asClient = (fn) => withClient(ROOT, fn);
  fs.mkdirSync(path.join(ROOT, 'data', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

  // Fake engines: reddit answers per FAKE_REDDIT; the other three lanes answer empty, so no test
  // path can reach a real search API.
  const fakeReddit = path.join(WS, 'fake-reddit-engine.mjs');
  fs.writeFileSync(fakeReddit, [
    "const m = process.env.FAKE_REDDIT || 'ok';",
    'let row;',
    "if (m === 'not_connected') row = { platform:'reddit', action:'radar', ok:false, error:'not_connected', scope:'reddit_oauth' };",
    "else if (m === 'needs_scope') row = { platform:'reddit', action:'radar', ok:false, error:'needs_scope', scope:'reddit_oauth' };",
    "else row = { platform:'reddit', action:'radar', ok:true, items:[{ source:'reddit', externalId:'t3_oauth1', url:'https://www.reddit.com/r/selfhosted/comments/oauth1/x/', author:'oauth_user', community:'r/selfhosted', text:'Any social media scheduler that runs on a Raspberry Pi?', ts:new Date().toISOString() }] };",
    "process.stdout.write(JSON.stringify({ ok:true, results:[row] }) + '\\n');",
  ].join('\n'));
  const fakeEmpty = path.join(WS, 'fake-empty-engine.mjs');
  fs.writeFileSync(fakeEmpty, "process.stdout.write(JSON.stringify({ ok:true, results:[{ action:'radar', ok:true, items:[] }] }) + '\\n');\n");
  process.env.PENDPOST_REDDIT_ENGINE = fakeReddit;
  for (const lane of ['HACKERNEWS', 'BLUESKY', 'MASTODON']) process.env[`PENDPOST_${lane}_ENGINE`] = fakeEmpty;

  const rev = () => getConfig().rev;
  const QUERY = { id: 'sched', label: 'scheduler seekers', enabled: true, keywords: ['social media scheduler', 'buffer alternative'], subreddits: ['selfhosted'], sources: ['reddit'] };
  const saved = await asClient(() => setConfig({ ifRev: rev(), actor: 'owner', set: { posting: { radar: { enabled: true, lookbackDays: 30, queries: [QUERY] } } } }));
  ok(saved.ok === true, `radar config with a reddit query saves (${JSON.stringify(saved).slice(0, 100)})`);

  // Connected OAuth: the engine verb answers, RSS is never touched.
  let f = stubFetch(() => ({ body: FIXTURE }));
  global.fetch = f;
  process.env.FAKE_REDDIT = 'ok';
  const s1 = await asClient(() => runRadarScan({}));
  const row1 = await asClient(() => loadState().radar.sources.reddit);
  ok(s1.ok === true && f.calls.length === 0, 'connected OAuth lane: zero RSS requests');
  ok(row1 && row1.ok === true && !('mode' in row1) && !('requests' in row1), `connected OAuth lane: the row is the plain ok row (${JSON.stringify(row1)})`);
  ok(s1.items.some((s) => s.externalId === 't3_oauth1'), 'the OAuth item ingests as before');
  const l1 = await asClient(() => listRadar({}));
  ok(l1.capabilities.reddit.reply === true, 'connected OAuth lane: reddit keeps its reply capability');

  process.env.FAKE_REDDIT = 'needs_scope';
  await asClient(() => runRadarScan({}));
  const row2 = await asClient(() => loadState().radar.sources.reddit);
  ok(f.calls.length === 0 && row2.error === 'needs_scope' && !('mode' in row2), 'a stored-but-refused credential (needs_scope) stays a reconnect prompt, no RSS');

  // Not connected: RSS search, normal pipeline, mode:'rss', copy path.
  rss.resetRedditRssClock();
  process.env.FAKE_REDDIT = 'not_connected';
  const s3 = await asClient(() => runRadarScan({}));
  ok(f.calls.length === 1, `unconnected lane: one query x one subreddit = exactly one RSS request (${f.calls.length})`);
  const u3 = new URL(f.calls[0].url);
  ok(u3.pathname === '/r/selfhosted/search.rss' && u3.searchParams.get('restrict_sr') === '1' && u3.searchParams.get('t') === 'month'
    && u3.searchParams.get('q') === '("social media scheduler" OR "buffer alternative")', `the request is the restricted OR-phrase search with t from lookbackDays (${f.calls[0].url})`);
  const row3 = await asClient(() => loadState().radar.sources.reddit);
  ok(row3 && row3.ok === true && row3.mode === 'rss' && row3.requests === 1, `the reddit row says it ran read-only via RSS (${JSON.stringify(row3)})`);
  const got = s3.items.filter((s) => s.source === 'reddit' && /^t3_1abc2d/.test(s.externalId));
  ok(got.length === 3, `the RSS candidates land in the feed (${got.length})`);
  ok(got.every((s) => s.unjudged === true && s.intentScore <= radar.RADAR_UNJUDGED_CAP) && s3.judge && s3.judge.candidates >= 3,
    'they went through the judge step like any engine candidate (no provider here: fail-closed, capped, flagged unjudged)');
  ok(got.every((s) => s.community === 'r/selfhosted' && s.author !== 'unknown' && s.url.startsWith('https://www.reddit.com/r/selfhosted/comments/')), 'stored shape matches the OAuth path (community, author, permalink)');
  const l3 = await asClient(() => listRadar({}));
  ok(l3.capabilities.reddit.reply === false && l3.capabilities.reddit.copyDraft === true && !('followup' in l3.capabilities.reddit),
    'listRadar: the RSS lane claims no reply and no followup, so the panel takes its copy path');
  ok(l3.sources.reddit && l3.sources.reddit.mode === 'rss', 'the per-source row the panel reads carries mode:"rss"');
  const answer = await asClient(() => queueRadarReply({
    source: 'reddit', externalId: 't3_1abc2de', signalUrl: got.find((s) => s.externalId === 't3_1abc2de').url,
    text: 'We moved to a small self-hosted setup and it has held up.', actor: 'owner', confirm: true,
  }));
  ok(answer.ok === true && answer.mode === 'copy', `an answer to an RSS-found thread saves as a copy draft, never a reply post (${JSON.stringify(answer).slice(0, 140)})`);

  // reddit in skippedPlatforms: a query that NAMES reddit is still searched via RSS.
  rss.resetRedditRssClock();
  const skip = await asClient(() => setConfig({ ifRev: rev(), actor: 'owner', set: { posting: { skippedPlatforms: ['reddit'] } } }));
  ok(skip.ok === true, 'skippedPlatforms:["reddit"] saves');
  f = stubFetch(() => ({ body: FIXTURE }));
  global.fetch = f;
  await asClient(() => runRadarScan({}));
  const row4 = await asClient(() => loadState().radar.sources.reddit);
  ok(f.calls.length === 1 && row4 && row4.mode === 'rss', 'reddit skipped, but the query names reddit: it is searched via RSS and its row is kept');

  // ...while a sources-less query leaves the skipped lane alone.
  rss.resetRedditRssClock();
  const wide = await asClient(() => setConfig({ ifRev: rev(), actor: 'owner', set: { posting: { radar: { queries: [{ id: 'wide', label: 'wide', enabled: true, keywords: ['social media scheduler'] }] } } } }));
  ok(wide.ok === true, 'a sources-less query saves');
  f = stubFetch(() => ({ body: FIXTURE }));
  global.fetch = f;
  await asClient(() => runRadarScan({}));
  ok(f.calls.length === 0, 'reddit skipped + a sources-less query: no RSS request');

  // Mock mode never reaches the network, even with the lane unconnected.
  rss.resetRedditRssClock();
  await asClient(() => setConfig({ ifRev: rev(), actor: 'owner', set: { posting: { skippedPlatforms: [], radar: { queries: [QUERY] } } } }));
  process.env.PENDPOST_MODE = 'mock';
  f = stubFetch(() => ({ body: FIXTURE }));
  global.fetch = f;
  await asClient(() => runRadarScan({}));
  ok(f.calls.length === 0, 'mock mode: an unconnected reddit lane makes no RSS request');
  delete process.env.PENDPOST_MODE;

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-reddit-rss] OK - unconnected reddit searches read-only via RSS, paced, copy-path only (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-reddit-rss] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  global.fetch = realFetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
