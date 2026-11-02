#!/usr/bin/env node
// test/radar-feed-source.test.mjs - Radar 2.0 step 3 (spec 54): the generic feed source.
//
// Proofs (no external network: parsing runs on fixture strings, the SSRF fence on stubbed resolvers,
// and the end-to-end connect proofs against a local loopback HTTP server only):
//   (a) RSS 2.0 (incl. a Mastodon tag RSS item), Atom and JSON Feed parse into Signals: title +
//       stripped body, link, author (Mastodon author from the status url), date, stable id;
//       entities decode, CDATA unwraps, scripts are dropped;
//   (b) the address check is fail-closed: IPv4 private ranges and every IPv6 bypass form
//       (::ffff:0:0/96 in dotted and hex, ::/96, 64:ff9b::/96 NAT64, 2002::/16 with a private
//       embedded IPv4, 100::/64, ULA, link-local, Teredo, documentation) are private; public v4 and
//       2000::/3 unicast are not;
//   (c) static refusals: non-http schemes, credentials in the url, IP-literal and .local hosts;
//   (d) DNS REBINDING: a resolver that answers a public IP on the pre-check and 127.0.0.1 on the
//       connect lookup is refused at connect time, and the local server never sees a request;
//   (e) the owner's feedAllowPrivate opt-in (host:port) reaches the loopback server; a redirect to a
//       private host is refused on its own hop; the 2 MB cap and the redirect cap hold;
//   (f) feedRadar: per-feed failures degrade, all-failed is engine_failure, all-429 rate_limited;
//   (g) config: feeds[] and feedAllowPrivate are validated; feedAllowPrivate is owner-only;
//       the feed lane is opt-in and runs only for a query that lists feeds.
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-feed-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>#selfhosted</title>
<item><guid isPermaLink="true">https://mastodon.social/@jane/113</guid><link>https://mastodon.social/@jane/113</link><pubDate>Tue, 28 Oct 2026 10:00:00 +0000</pubDate>
<description>&lt;p&gt;Is there an &lt;b&gt;alternative&lt;/b&gt; to Postiz that runs on a Pi?&lt;/p&gt;&lt;script&gt;x()&lt;/script&gt;</description></item>
<item><title><![CDATA[Fish & chips <3]]></title><link>https://blog.example/fish</link><dc:creator>Bob</dc:creator><description>Plain &amp; simple &#8211; &#x263A;</description></item>
</channel></rss>`;
const ATOM = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>postiz issues</title>
<entry><id>tag:github.com,2008:Issue/1</id><title type="html">Looking for a self-hosted Buffer alternative</title>
<link rel="alternate" type="text/html" href="https://github.com/o/r/issues/1"/><updated>2026-10-28T09:00:00Z</updated>
<author><name>ann</name></author><content type="html">&lt;p&gt;We need Mastodon support.&lt;/p&gt;</content></entry></feed>`;
const JSONF = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'J', items: [
  { id: 'j1', url: 'https://j.example/1', title: 'Which scheduler for Bluesky?', content_html: '<p>asking for a friend</p>', date_published: '2026-10-27T08:00:00Z', authors: [{ name: 'Cleo' }] },
] });

// The loopback server: counts requests; /feed answers RSS, /big answers 3 MB, /hop redirects.
let hits = 0;
const server = http.createServer((req, res) => {
  hits += 1;
  if (req.url === '/feed') { res.writeHead(200, { 'content-type': 'application/rss+xml' }); res.end(RSS); return; }
  if (req.url === '/big') { res.writeHead(200); res.end('x'.repeat(3 * 1024 * 1024)); return; }
  if (req.url === '/to-private') { res.writeHead(302, { location: 'http://10.0.0.5/feed' }); res.end(); return; }
  if (req.url.startsWith('/loop')) { res.writeHead(302, { location: `/loop${req.url.length}` }); res.end(); return; }
  res.writeHead(404); res.end();
});

try {
  const F = await import('../lib/radar-feed.mjs');
  const { feedRadar } = await import('../scripts/feed-radar.mjs');

  // ---- (a) parsing -----------------------------------------------------------------------------
  const rss = F.parseFeed(RSS, 'https://mastodon.social/tags/selfhosted.rss');
  ok(rss.format === 'rss' && rss.items.length === 2, `RSS: two items (${rss.items.length})`);
  const m = rss.items[0];
  ok(m.source === 'feed' && m.url === 'https://mastodon.social/@jane/113' && m.author === 'jane@mastodon.social', `Mastodon tag item: link and author from the status url (${m.author})`);
  ok(m.text === 'Is there an alternative to Postiz that runs on a Pi?', `HTML stripped, entities decoded, script dropped (${JSON.stringify(m.text)})`);
  ok(m.ts === '2026-10-28T10:00:00.000Z' && m.community === 'mastodon.social', 'pubDate -> ISO, community = the feed host');
  ok(/^[0-9a-f]{24}$/.test(m.externalId) && F.parseFeed(RSS, 'https://mastodon.social/tags/selfhosted.rss').items[0].externalId === m.externalId, 'a stable hashed id');
  ok(rss.items[1].text.startsWith('Fish & chips <3\n\nPlain & simple \u2013 \u263a') && rss.items[1].author === 'Bob', `CDATA title, dc:creator, numeric entities (${JSON.stringify(rss.items[1].text)})`);
  const atom = F.parseFeed(ATOM, 'https://github.com/o/r/issues.atom');
  ok(atom.format === 'atom' && atom.items.length === 1 && atom.items[0].url === 'https://github.com/o/r/issues/1' && atom.items[0].author === 'ann', 'Atom: alternate link, author/name');
  ok(atom.items[0].text === 'Looking for a self-hosted Buffer alternative\n\nWe need Mastodon support.' && atom.items[0].ts === '2026-10-28T09:00:00.000Z', 'Atom: title + content, updated date');
  const jf = F.parseFeed(JSONF, 'https://j.example/feed.json');
  ok(jf.format === 'json' && jf.items[0].author === 'Cleo' && jf.items[0].text === 'Which scheduler for Bluesky?\n\nasking for a friend', 'JSON Feed: title, content_html stripped, authors[0]');
  ok(F.parseFeed('<html>nope</html>').format === null && F.parseFeed('{"nope":1}').format === null, 'not a feed: format null, no items');

  // ---- (b) the address check ---------------------------------------------------------------------
  const priv = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:0:7f00:1', '::127.0.0.1', '::7f00:1', '64:ff9b::7f00:1', '64:ff9b::808:808',
    '2002:7f00:1::', '2002:a00:1::1', '100::1', 'fc00::1', 'fd12::1', 'fe80::1', 'fe80::1%en0', 'ff02::1', '2001::1', '2001:db8::1', 'not-an-ip'];
  const bypassed = priv.filter((ip) => !F.isPrivateAddress(ip));
  ok(bypassed.length === 0, `every private and IPv6 bypass form is refused (bypassed: ${bypassed.join(', ') || 'none'})`);
  const pub = ['8.8.8.8', '93.184.216.34', '2606:4700::1111', '2a00:1450:4001::64', '2002:808:808::1'];
  ok(pub.every((ip) => !F.isPrivateAddress(ip)), `public v4, 2000::/3 unicast and a 6to4 with a public v4 pass (${pub.filter((ip) => F.isPrivateAddress(ip)).join(', ') || 'all'})`);

  // ---- (c) static refusals ------------------------------------------------------------------------
  const pubResolve = async () => [{ address: '93.184.216.34', family: 4 }];
  const refused = async (u) => (await F.checkFeedUrl(u, { resolve: pubResolve })).ok === false;
  ok(await refused('file:///etc/passwd') && await refused('gopher://x/1') && await refused('ftp://x/'), 'non-http schemes refused');
  ok(await refused('http://user:pw@example.com/feed'), 'credentials in the url refused');
  ok(await refused('http://127.0.0.1/') && await refused('http://[::ffff:127.0.0.1]/') && await refused('http://2130706433/') && await refused('http://0x7f.1/'), 'IP-literal private hosts refused (incl. integer and hex forms)');
  ok(await refused('http://nas.local/feed') && await refused('http://localhost:1200/x'), '.local and localhost refused');
  ok((await F.checkFeedUrl('http://evil.example/', { resolve: async () => ['93.184.216.34', '10.0.0.1'] })).ok === false, 'a host with ANY private answer is refused');

  // ---- (d) DNS rebinding: public on the pre-check, 127.0.0.1 on the connect ------------------------
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  let calls = 0;
  const rebinding = async () => { calls += 1; return calls === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]; };
  hits = 0;
  let res = await F.fetchFeed(`http://rebind.example:${port}/feed`, { resolve: rebinding, timeoutMs: 5000 });
  ok(calls === 2, `the resolver ran twice: the pre-check and the connect-time lookup (${calls})`);
  ok(res.ok === false && res.error === 'refused' && /private address 127\.0\.0\.1/.test(res.detail), `the connect-time lookup refuses the rebound address (${res.error}: ${res.detail})`);
  ok(hits === 0, 'the loopback server never received the request');
  // The guarded lookup on its own, in the all:true form node's happy-eyeballs connect uses.
  const lk = F.guardedLookup({ resolve: async () => ['93.184.216.34', '::ffff:10.0.0.1'] });
  const lkErr = await new Promise((r) => lk('mixed.example', { all: true }, (err) => r(err)));
  ok(lkErr && lkErr.code === 'EPRIVATE', 'guardedLookup refuses when any answer is private (all:true)');
  const lkOk = await new Promise((r) => F.guardedLookup({ resolve: async () => ['93.184.216.34'] })('pub.example', {}, (err, addr, fam) => r({ err, addr, fam })));
  ok(!lkOk.err && lkOk.addr === '93.184.216.34' && lkOk.fam === 4, 'guardedLookup passes a public answer through (single form)');

  // ---- (e) the owner's opt-in, redirects, size --------------------------------------------------
  const loopResolve = async () => [{ address: '127.0.0.1', family: 4 }];
  hits = 0;
  res = await F.fetchFeed(`http://rsshub.test:${port}/feed`, { resolve: loopResolve, allowPrivate: [`rsshub.test:${port}`], timeoutMs: 5000 });
  ok(res.ok === true && hits === 1 && F.parseFeed(res.body, `http://rsshub.test:${port}/feed`).items.length === 2, `feedAllowPrivate (host:port) reaches the owner's local RSSHub (${res.error || 'ok'})`);
  res = await F.fetchFeed(`http://rsshub.test:${port}/feed`, { resolve: loopResolve, allowPrivate: ['other.test'], timeoutMs: 5000 });
  ok(res.ok === false && res.error === 'refused', 'a different allowlisted host does not cover this one');
  res = await F.fetchFeed(`http://rsshub.test:${port}/to-private`, { resolve: loopResolve, allowPrivate: [`rsshub.test:${port}`], timeoutMs: 5000 });
  ok(res.ok === false && res.error === 'refused' && /10\.0\.0\.5/.test(res.detail), `a redirect to a private host is refused on its own hop (${res.detail})`);
  res = await F.fetchFeed(`http://rsshub.test:${port}/loop`, { resolve: loopResolve, allowPrivate: [`rsshub.test:${port}`], timeoutMs: 5000 });
  ok(res.ok === false && /more than 3 redirects/.test(res.detail), 'the redirect hops are capped');
  res = await F.fetchFeed(`http://rsshub.test:${port}/big`, { resolve: loopResolve, allowPrivate: [`rsshub.test:${port}`], timeoutMs: 5000 });
  ok(res.ok === false && res.error === 'too_large', 'a body past 2 MB is refused');

  // ---- (f) feedRadar aggregation (transport stubbed) ------------------------------------------------
  const get = (map) => async (url) => {
    const a = map[url.toString()] || { status: 404 };
    return { status: a.status || 200, header: (k) => (a.headers || {})[k] ?? null, body: a.body || '', tooBig: false };
  };
  const both = { 'https://a.example/rss': { body: RSS }, 'https://b.example/atom': { body: ATOM } };
  let row = await feedRadar({ feeds: ['https://a.example/rss', 'https://b.example/atom'] }, { resolve: pubResolve, get: get(both) });
  ok(row.ok === true && row.items.length === 3 && !row.degrade, `two feeds -> one ok row with 3 items (${row.items.length})`);
  row = await feedRadar({ feeds: ['https://a.example/rss', 'https://c.example/missing', 'http://10.0.0.1/x'] }, { resolve: pubResolve, get: get(both) });
  ok(row.ok === true && row.items.length === 2 && row.degrade && /c\.example: HTTP 404/.test(row.degrade.detail) && /private address 10\.0\.0\.1/.test(row.degrade.detail), `partial failure keeps the items and names each failed feed (${row.degrade && row.degrade.detail})`);
  row = await feedRadar({ feeds: ['https://c.example/missing'] }, { resolve: pubResolve, get: get(both) });
  ok(row.ok === false && row.error === 'engine_failure' && /HTTP 404/.test(row.detail), 'every feed failed -> engine_failure with the detail');
  row = await feedRadar({ feeds: ['https://d.example/x'] }, { resolve: pubResolve, get: get({ 'https://d.example/x': { status: 429, headers: { 'retry-after': '30' } } }) });
  ok(row.ok === false && row.error === 'rate_limited' && row.retryAfter === 30, 'every feed 429 -> rate_limited');
  row = await feedRadar({}, {});
  ok(row.ok === true && row.items.length === 0, 'no feeds: an empty ok row, no request');

  // ---- (g) config + lane gating -----------------------------------------------------------------------
  const R = await import('../lib/radar.mjs');
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  const set = (actor, radar) => asClient(() => setConfig({ ifRev: getConfig().rev, actor, set: { posting: { radar } } }));
  const q = (feeds) => ({ id: 'qf', label: 'F', keywords: ['scheduler'], feeds });
  ok(!(await set('agent', { queries: [q(['https://mastodon.social/tags/selfhosted.rss'])] })).code, 'an agent may add feed urls to a query');
  ok((await set('agent', { queries: [q(['file:///etc/passwd'])] })).code === 'invalid_input', 'a non-http feed url is refused by config');
  ok((await set('agent', { queries: [q(['http://u:p@x.example/'])] })).code === 'invalid_input', 'a feed url with credentials is refused by config');
  ok((await set('agent', { feedAllowPrivate: ['localhost:1200'] })).code === 'invalid_input', 'feedAllowPrivate is owner-only');
  ok(!(await set('owner', { feedAllowPrivate: ['localhost:1200'] })).code, 'the owner may allow a private host');
  ok((await set('owner', { feedAllowPrivate: ['http://x/'] })).code === 'invalid_input', 'feedAllowPrivate takes host[:port] only');
  ok(R.radarOptionalLanes(q(['https://a.example/rss']), {}).length === 0, 'the feed lane is opt-in: off without its switch');
  ok(R.radarOptionalLanes(q(['https://a.example/rss']), { sources: { feed: { scan: true } } }).join() === 'feed', 'switch on + feeds -> the feed lane');
  ok(R.radarOptionalLanes(q([]), { sources: { feed: { scan: true } } }).length === 0, 'switch on, no feeds on the query -> no feed lane');
  ok(!R.effectiveRadarSources({}, () => false).includes('feed') && R.effectiveRadarSources({ sources: { feed: { scan: true } } }, () => false).includes('feed'), 'effectiveRadarSources: feed only by its switch');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-feed-source] OK - ${pass} assertions`);
} catch (err) {
  console.error(`[radar-feed-source] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  server.close();
  fs.rmSync(WS, { recursive: true, force: true });
}
