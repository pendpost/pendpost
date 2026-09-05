#!/usr/bin/env node
// test/radar-keyword-fanout.test.mjs - the Mastodon, Bluesky and Hacker News Radar adapters
// joined ALL keywords into one space-separated query, which those backends treat as AND, so
// a multi-keyword query returned ~nothing (reddit already ` OR `-joins). Each adapter now
// issues ONE search per term (Bluesky: each #hashtag is its own term; HN falls back to the
// query label), dedupes by externalId, and follows the Mastodon hashtag-loop error precedent:
// a 429 aborts with rate_limited only when nothing was collected yet, otherwise the loop
// stops and keeps what it has. Proven IN-PROCESS against a stubbed global.fetch, zero live
// credentials/network (mirrors mastodon-timeout.test.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-fanout-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;

const realFetch = global.fetch;
const res = (body, { status = 200, retryAfter = null } = {}) => Promise.resolve({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (k.toLowerCase() === 'retry-after' && retryAfter != null ? String(retryAfter) : null) },
  text: () => Promise.resolve(JSON.stringify(body)),
  json: () => Promise.resolve(body),
});

// Records every fetched URL and answers each search from `answers` (one per search call, in
// order); `answers` entries are either { body } or { status, body? }. Non-search calls (the
// Bluesky createSession) get `session`.
function stubFetch({ isSearch, answers, session = null }) {
  const urls = [];
  let i = 0;
  global.fetch = (url) => {
    const u = String(url);
    urls.push(u);
    if (!isSearch(u)) return res(session || {});
    const a = answers[i++] || { body: {} };
    return res(a.body || {}, { status: a.status || 200, retryAfter: a.retryAfter ?? null });
  };
  return urls;
}
const paramOf = (u, key) => new URL(u).searchParams.get(key);
const radarRow = (RUN) => RUN.results.find((r) => r && r.action === 'radar');

try {
  const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
  initMultiClient();
  fs.mkdirSync(clientRoot('default'), { recursive: true });
  fs.writeFileSync(path.join(clientRoot('default'), '.env'), [
    'MASTODON_INSTANCE_URL=https://masto.example',
    'MASTODON_ACCESS_TOKEN=tok123',
    'BLUESKY_IDENTIFIER=you.bsky.social',
    'BLUESKY_APP_PASSWORD=app-pass',
    'BLUESKY_PDS_URL=https://pds.example',
    '',
  ].join('\n'), { mode: 0o600 });

  const masto = await import('../scripts/mastodon-social.mjs');
  const bsky = await import('../scripts/bluesky-social.mjs');
  const hn = await import('../scripts/hacker-news-social.mjs');

  const KW = ['alpha', 'beta', 'gamma'];
  const q3 = JSON.stringify({ keywords: KW });

  // ============================ Mastodon ============================
  {
    const isSearch = (u) => u.includes('/api/v2/search');
    const status = (id) => ({ id, url: `https://masto.example/@a/${id}`, content: `<p>${id}</p>`, account: { acct: 'a' }, created_at: '2026-09-01T00:00:00Z' });

    // (1) three keywords => three searches, one keyword each; (2) shared id appears once
    masto.RUN.results.length = 0;
    let urls = stubFetch({ isSearch, answers: [
      { body: { statuses: [status('m1'), status('m2')] } },
      { body: { statuses: [status('m2'), status('m3')] } },
      { body: { statuses: [] } },
    ] });
    await masto.cmdRadar({ query: q3 });
    let searches = urls.filter(isSearch);
    ok(searches.length === 3, `mastodon: 3 keywords => 3 /api/v2/search requests (got ${searches.length})`);
    ok(searches.every((u, i) => paramOf(u, 'q') === KW[i]), `mastodon: each q carries exactly one keyword (${searches.map((u) => paramOf(u, 'q')).join(',')})`);
    let row = radarRow(masto.RUN);
    ok(row && row.ok === true && row.items.length === 3, `mastodon: the post two searches both returned appears once (${row && row.items.length} items)`);
    ok(row && row.items.map((it) => it.externalId).sort().join(',') === 'm1,m2,m3', 'mastodon: the deduped items are m1,m2,m3');

    // (3a) 429 on the FIRST term, nothing collected => rate_limited
    masto.RUN.results.length = 0;
    stubFetch({ isSearch, answers: [{ status: 429, retryAfter: 30 }] });
    await masto.cmdRadar({ query: q3 });
    row = radarRow(masto.RUN);
    ok(row && row.ok === false && row.error === 'rate_limited' && row.retryAfter === 30, `mastodon: 429 on the first term (nothing collected) => rate_limited row (got ${row && row.error})`);

    // (3b) 429 on the THIRD term, items already collected => ok with items from terms 1-2
    masto.RUN.results.length = 0;
    urls = stubFetch({ isSearch, answers: [
      { body: { statuses: [status('m1')] } },
      { body: { statuses: [status('m2')] } },
      { status: 429 },
    ] });
    await masto.cmdRadar({ query: q3 });
    row = radarRow(masto.RUN);
    ok(row && row.ok === true && row.items.map((it) => it.externalId).join(',') === 'm1,m2', `mastodon: 429 on the third term keeps the items from terms 1-2 (got ${row && (row.error || row.items.map((it) => it.externalId).join(','))})`);
    ok(urls.filter(isSearch).length === 3, 'mastodon: the loop stops at the 429 (no fourth request, the third was the 429)');

    // the D6 carry survives: 401 mid-loop with items already collected => ok + degrade
    masto.RUN.results.length = 0;
    stubFetch({ isSearch, answers: [{ body: { statuses: [status('m1')] } }, { status: 401 }] });
    await masto.cmdRadar({ query: q3 });
    row = radarRow(masto.RUN);
    ok(row && row.ok === true && row.items.length === 1 && row.degrade && row.degrade.error === 'needs_scope' && row.degrade.scope === 'read:search', 'mastodon: a 401 after items were collected keeps ok:true and CARRIES the needs_scope degrade (D6)');

    // a 401 with nothing collected => needs_scope row (unchanged priority)
    masto.RUN.results.length = 0;
    urls = stubFetch({ isSearch, answers: [{ status: 401 }] });
    await masto.cmdRadar({ query: q3 });
    row = radarRow(masto.RUN);
    ok(row && row.ok === false && row.error === 'needs_scope' && row.scope === 'read:search', 'mastodon: 401 on the first term with nothing collected => needs_scope read:search');
    ok(urls.filter(isSearch).length === 1, 'mastodon: the 401 breaks the loop (every further keyword would 401 too)');
  }

  // ============================ Bluesky ============================
  {
    const isSearch = (u) => u.includes('app.bsky.feed.searchPosts');
    const session = { accessJwt: 'jwt-1' };
    const post = (rkey) => ({ uri: `at://did:plc:x/app.bsky.feed.post/${rkey}`, author: { handle: 'a.bsky.social' }, record: { text: rkey }, indexedAt: '2026-09-01T00:00:00Z' });

    // (1) + (2)
    bsky.RUN.results.length = 0;
    let urls = stubFetch({ isSearch, session, answers: [
      { body: { posts: [post('b1'), post('b2')] } },
      { body: { posts: [post('b2'), post('b3')] } },
      { body: { posts: [] } },
    ] });
    await bsky.cmdRadar({ query: q3 });
    let searches = urls.filter(isSearch);
    ok(searches.length === 3, `bluesky: 3 keywords => 3 searchPosts requests (got ${searches.length})`);
    ok(searches.every((u, i) => paramOf(u, 'q') === KW[i]), `bluesky: each q carries exactly one keyword (${searches.map((u) => paramOf(u, 'q')).join(',')})`);
    let row = radarRow(bsky.RUN);
    ok(row && row.ok === true && row.items.length === 3, `bluesky: the post two searches both returned appears once (${row && row.items.length} items)`);

    // (3a) 429 first
    bsky.RUN.results.length = 0;
    stubFetch({ isSearch, session, answers: [{ status: 429, retryAfter: 12 }] });
    await bsky.cmdRadar({ query: q3 });
    row = radarRow(bsky.RUN);
    ok(row && row.ok === false && row.error === 'rate_limited' && row.retryAfter === 12, `bluesky: 429 on the first term (nothing collected) => rate_limited row (got ${row && row.error})`);

    // (3b) 429 third
    bsky.RUN.results.length = 0;
    stubFetch({ isSearch, session, answers: [
      { body: { posts: [post('b1')] } },
      { body: { posts: [post('b2')] } },
      { status: 429 },
    ] });
    await bsky.cmdRadar({ query: q3 });
    row = radarRow(bsky.RUN);
    ok(row && row.ok === true && row.items.map((it) => it.externalId.split('/').pop()).join(',') === 'b1,b2', `bluesky: 429 on the third term keeps the items from terms 1-2 (got ${row && (row.error || row.items.length)})`);

    // (4) hashtags become their own #tag searches
    bsky.RUN.results.length = 0;
    urls = stubFetch({ isSearch, session, answers: [{ body: { posts: [] } }, { body: { posts: [] } }, { body: { posts: [] } }] });
    await bsky.cmdRadar({ query: JSON.stringify({ keywords: ['alpha'], hashtags: ['#swiss', 'zurich'] }) });
    searches = urls.filter(isSearch).map((u) => paramOf(u, 'q'));
    ok(searches.join('|') === 'alpha|#swiss|#zurich', `bluesky: hashtags become their own #tag searches (got ${searches.join('|')})`);
    row = radarRow(bsky.RUN);
    ok(row && row.ok === true && row.items.length === 0 && !row.degrade, 'bluesky: every search answered empty => a genuine empty ok row');

    // 401 mid-loop with items => ok + carried degrade (Mastodon D6 shape); 401 first => needs_scope
    bsky.RUN.results.length = 0;
    stubFetch({ isSearch, session, answers: [{ body: { posts: [post('b1')] } }, { status: 401 }] });
    await bsky.cmdRadar({ query: q3 });
    row = radarRow(bsky.RUN);
    ok(row && row.ok === true && row.items.length === 1 && row.degrade && row.degrade.error === 'needs_scope' && row.degrade.scope === 'bluesky_app_password', 'bluesky: a 401 after items were collected keeps ok:true and CARRIES the needs_scope degrade');
    bsky.RUN.results.length = 0;
    urls = stubFetch({ isSearch, session, answers: [{ status: 403 }] });
    await bsky.cmdRadar({ query: q3 });
    row = radarRow(bsky.RUN);
    ok(row && row.ok === false && row.error === 'needs_scope' && row.scope === 'bluesky_app_password', 'bluesky: 403 on the first term with nothing collected => needs_scope row');
    ok(urls.filter(isSearch).length === 1, 'bluesky: the 403 breaks the loop');

    // a transient error on one term does not hide the others; every term erroring => engine_failure
    bsky.RUN.results.length = 0;
    stubFetch({ isSearch, session, answers: [{ status: 500 }, { body: { posts: [post('b9')] } }, { status: 502 }] });
    await bsky.cmdRadar({ query: q3 });
    row = radarRow(bsky.RUN);
    ok(row && row.ok === true && row.items.length === 1, 'bluesky: a 5xx on one term continues to the next (items from the healthy term survive)');
    bsky.RUN.results.length = 0;
    stubFetch({ isSearch, session, answers: [{ status: 500 }, { status: 500 }, { status: 502 }] });
    await bsky.cmdRadar({ query: q3 });
    row = radarRow(bsky.RUN);
    ok(row && row.ok === false && row.error === 'engine_failure' && /502/.test(row.message), `bluesky: every term erroring => engine_failure with the last error (got ${row && row.error} ${row && row.message})`);
  }

  // ============================ Hacker News ============================
  {
    const isSearch = (u) => u.includes('hn.algolia.com');
    const hit = (id) => ({ objectID: id, author: 'pg', title: `t-${id}`, created_at_i: 1756684800 });

    // (1) + (2)
    hn.RUN.results.length = 0;
    let urls = stubFetch({ isSearch, answers: [
      { body: { hits: [hit('h1'), hit('h2')] } },
      { body: { hits: [hit('h2'), hit('h3')] } },
      { body: { hits: [] } },
    ] });
    await hn.cmdRadar({ query: q3 });
    let searches = urls.filter(isSearch);
    ok(searches.length === 3, `hn: 3 keywords => 3 Algolia requests (got ${searches.length})`);
    ok(searches.every((u, i) => paramOf(u, 'query') === KW[i]), `hn: each Algolia query carries exactly one keyword (${searches.map((u) => paramOf(u, 'query')).join(',')})`);
    let row = radarRow(hn.RUN);
    ok(row && row.ok === true && row.items.length === 3, `hn: the hit two searches both returned appears once (${row && row.items.length} items)`);

    // (3a) 429 first
    hn.RUN.results.length = 0;
    stubFetch({ isSearch, answers: [{ status: 429, retryAfter: 5 }] });
    await hn.cmdRadar({ query: q3 });
    row = radarRow(hn.RUN);
    ok(row && row.ok === false && row.error === 'rate_limited' && row.retryAfter === 5, `hn: 429 on the first term (nothing collected) => rate_limited row (got ${row && row.error})`);

    // (3b) 429 third
    hn.RUN.results.length = 0;
    stubFetch({ isSearch, answers: [
      { body: { hits: [hit('h1')] } },
      { body: { hits: [hit('h2')] } },
      { status: 429 },
    ] });
    await hn.cmdRadar({ query: q3 });
    row = radarRow(hn.RUN);
    ok(row && row.ok === true && row.items.map((it) => it.externalId).join(',') === 'h1,h2', `hn: 429 on the third term keeps the items from terms 1-2 (got ${row && (row.error || row.items.length)})`);

    // (5) no keywords + label => one search with the label
    hn.RUN.results.length = 0;
    urls = stubFetch({ isSearch, answers: [{ body: { hits: [hit('h7')] } }] });
    await hn.cmdRadar({ query: JSON.stringify({ label: 'pendpost radar' }) });
    searches = urls.filter(isSearch);
    ok(searches.length === 1 && paramOf(searches[0], 'query') === 'pendpost radar', `hn: no keywords + label => ONE search with the label (got ${searches.map((u) => paramOf(u, 'query')).join('|')})`);
    row = radarRow(hn.RUN);
    ok(row && row.ok === true && row.items.length === 1, 'hn: the label search returns its items');

    // no keywords, no label => empty ok row, no request
    hn.RUN.results.length = 0;
    urls = stubFetch({ isSearch, answers: [] });
    await hn.cmdRadar({ query: '{}' });
    row = radarRow(hn.RUN);
    ok(row && row.ok === true && row.items.length === 0 && urls.length === 0, 'hn: no keywords and no label => empty ok row without any request');

    // every term erroring => engine_failure; one healthy term => ok
    hn.RUN.results.length = 0;
    stubFetch({ isSearch, answers: [{ status: 500 }, { status: 503 }, { status: 500 }] });
    await hn.cmdRadar({ query: q3 });
    row = radarRow(hn.RUN);
    ok(row && row.ok === false && row.error === 'engine_failure', `hn: every term erroring => engine_failure (got ${row && row.error})`);

    // the 10-term cap
    hn.RUN.results.length = 0;
    urls = stubFetch({ isSearch, answers: Array.from({ length: 12 }, () => ({ body: { hits: [] } })) });
    await hn.cmdRadar({ query: JSON.stringify({ keywords: Array.from({ length: 12 }, (_, i) => `k${i}`) }) });
    ok(urls.filter(isSearch).length === 10, `hn: 12 keywords are capped at 10 searches (got ${urls.filter(isSearch).length})`);
  }
} finally {
  global.fetch = realFetch;
  fs.rmSync(WS, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
