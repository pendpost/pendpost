#!/usr/bin/env node
// test/radar-watchlist.test.mjs - Radar 2.0 step 3 (spec 54): posting.radar.watchlist.
//
// Proofs:
//   (a) config: lanes x/bluesky/mastodon/github only, valid handles, owner-only; a partial write
//       keeps the other lanes;
//   (b) matching: @handle, case and the Mastodon host unify; a lane without a list matches nothing;
//   (c) the inbox: a watched author's ask outranks an equal stranger's (x1.5 boost);
//   (d) the pre-filter: a watched author anchors without a keyword (like a watched community);
//   (e) the owner-verified action path (RADAR_OWNER_ACTION) OFFERS the author in
//       watchlistSuggestions, never adds it; an MCP/agent call offers nothing; an already watched
//       author is not offered; listRadar returns the open suggestions.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-watchlist-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

try {
  const W = await import('../lib/radar-watchlist.mjs');
  const V = await import('../lib/radar-verdict.mjs');
  const { engineDropReason } = await import('../lib/radar-prefilter.mjs');
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { triageSignal, listRadar } = await import('../lib/writes.mjs');
  const { RADAR_OWNER_ACTION } = await import('../lib/radar-tuner.mjs');
  const { loadState, saveState } = await import('../lib/state.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  const set = (actor, radar) => asClient(() => setConfig({ ifRev: getConfig().rev, actor, set: { posting: { radar } } }));

  // ---- (a) config --------------------------------------------------------------------------------
  ok(W.isRadarWatchlist({ x: ['@jane_dev', 'bob'], bluesky: ['jane.bsky.social'], mastodon: ['jane@mastodon.social'], github: ['octocat'] }), 'a valid watchlist');
  ok(!W.isRadarWatchlist({ reddit: ['x'] }) && !W.isRadarWatchlist({ x: ['has space'] }) && !W.isRadarWatchlist({ x: 'jane' }) && !W.isRadarWatchlist([]), 'unknown lanes, bad handles, non-arrays refused');
  ok(!W.isRadarWatchlist({ x: Array.from({ length: 101 }, (_, i) => `h${i}`) }), 'at most 100 handles per lane');
  ok((await set('agent', { watchlist: { x: ['jane_dev'] } })).code === 'invalid_input', 'an agent cannot write the watchlist (owner-only, seeded by hand)');
  ok(!(await set('owner', { watchlist: { x: ['jane_dev'], github: ['octocat'] } })).code, 'the owner can');
  ok(!(await set('owner', { watchlist: { bluesky: ['ann.bsky.social'] } })).code, 'a partial watchlist write');
  const cfg = () => asClient(() => getConfig());
  const wl = (await cfg()).posting.radar.watchlist;
  ok(wl && wl.x[0] === 'jane_dev' && wl.github[0] === 'octocat' && wl.bluesky[0] === 'ann.bsky.social', `a partial write keeps the other lanes (${JSON.stringify(wl)})`);

  // ---- (b) matching -----------------------------------------------------------------------------------
  const list = { x: ['@Jane_Dev'], mastodon: ['ann@fosstodon.org'], bluesky: ['ann.bsky.social'] };
  ok(W.isWatchedAuthor({ source: 'x', author: 'jane_dev' }, list) && W.isWatchedAuthor({ source: 'x', author: '@JANE_DEV' }, list), 'X: @ and case unify');
  ok(W.isWatchedAuthor({ source: 'mastodon', author: 'ann@fosstodon.org' }, list), 'Mastodon acct matches');
  ok(W.isWatchedAuthor({ source: 'bluesky', author: 'ann.bsky.social' }, list) && !W.isWatchedAuthor({ source: 'bluesky', author: 'ann.other.social' }, list), 'Bluesky handles compare whole (a domain)');
  ok(!W.isWatchedAuthor({ source: 'github', author: 'jane_dev' }, list) && !W.isWatchedAuthor({ source: 'hackernews', author: 'jane_dev' }, list), 'a lane without a list (or not a watchlist lane) matches nothing');
  ok(W.watchedHandles({ x: ['@a', 'A', 'b'] }, 'x').join() === 'a,b', 'watchedHandles strips @ and de-duplicates');

  // ---- (c) the inbox boost -------------------------------------------------------------------------------
  const now = Date.now();
  const act = (id, author) => ({ source: 'x', externalId: id, author, intent: 'ask_reco', authorRole: 'seeker', replyable: true, timing: 'fresh', intentScore: 60, ts: new Date(now - 3600_000).toISOString(), classifiedBy: 'judge' });
  const items = [act('1', 'stranger'), act('2', 'jane_dev')];
  const pick = V.selectInbox(items, { target: 1, now, isWatchedAuthor: (s) => W.isWatchedAuthor(s, list) });
  ok(pick.ranked.length === 1 && pick.ranked[0].externalId === '2', 'with one slot, the watched author wins an otherwise equal ask');
  ok(Math.abs(V.inboxRank(items[1], now, { watchedAuthor: true }) / V.inboxRank(items[1], now) - V.RADAR_WATCHED_AUTHOR_BOOST) < 1e-9, 'the boost is x1.5');
  ok(V.selectInbox(items, { target: 1, now }).ranked[0].externalId === '1', 'without the predicate the order is unchanged (stable, first wins)');

  // ---- (d) the pre-filter anchor ------------------------------------------------------------------------
  const off = { source: 'x', externalId: '9', author: 'jane_dev', text: 'Shipping a small update to my side project tonight, feedback welcome.' };
  const qx = { id: 'q', keywords: ['social media scheduler'] };
  ok(engineDropReason(off, qx, {}) === 'noAnchor', 'a stranger post without the keyword has no anchor');
  ok(engineDropReason(off, qx, { isWatched: (s) => W.isWatchedAuthor(s, list) }) === null, 'the same post by a watched author is kept (the author is the anchor)');

  // ---- (e) offers on the owner path ------------------------------------------------------------------------
  await set('owner', { enabled: true, queries: [{ id: 'q1', label: 'Q', keywords: ['scheduler'] }], watchlist: { x: ['jane_dev'] } });
  const sig = (id, author, source = 'x') => ({ source, externalId: id, url: `https://x.com/${author}/status/${id}`, author, text: 'which scheduler should I use?', matchedQuery: 'q1', ts: new Date().toISOString(), intentScore: 50, intentTags: [], suggestedAction: 'reply', judged: true });
  await asClient(() => {
    const st = loadState();
    st.radar = { ...(st.radar || {}), signals: [sig('a', 'newfriend'), sig('b', 'mcpcaller'), sig('c', 'jane_dev'), sig('d', 'hn_person', 'hackernews')], seen: [] };
    saveState();
  });
  const owner = (externalId, source = 'x') => asClient(() => triageSignal({ source, externalId, action: 'dismiss', actor: 'owner', [RADAR_OWNER_ACTION]: true }));
  await owner('a');
  await asClient(() => triageSignal({ source: 'x', externalId: 'b', action: 'dismiss', actor: 'owner' })); // MCP: no Symbol
  await owner('c');
  await owner('d', 'hackernews');
  await owner('a'); // a repeat: no second offer
  const st = await asClient(() => loadState());
  const offers = st.radar.watchlistSuggestions || [];
  ok(offers.length === 1 && offers[0].source === 'x' && offers[0].author === 'newfriend' && offers[0].from === 'x a', `only the owner-verified Done offers its author (${JSON.stringify(offers)})`);
  ok(!offers.some((o) => o.author === 'mcpcaller'), 'an MCP/agent call (no owner Symbol) offers nothing, whatever its actor string');
  ok(!offers.some((o) => o.author === 'jane_dev'), 'an already watched author is not offered');
  ok(!offers.some((o) => o.source === 'hackernews'), 'a lane without a watchlist is not offered');
  ok(((await cfg()).posting.radar.watchlist.x || []).join() === 'jane_dev', 'the watchlist itself is untouched (offer, never add)');
  let feed = await asClient(() => listRadar({}));
  ok(Array.isArray(feed.watchlistSuggestions) && feed.watchlistSuggestions.length === 1 && feed.watchlistSuggestions[0].author === 'newfriend', 'listRadar returns the open suggestions');
  await set('owner', { watchlist: { x: ['jane_dev', 'newfriend'] } });
  feed = await asClient(() => listRadar({}));
  ok(feed.watchlistSuggestions.length === 0, 'once the owner watches the author, the suggestion closes');
  ok(Array.isArray(feed.optionalSources) && feed.optionalSources.map((s) => s.id).join() === 'x,feed,github', 'listRadar also carries the optional source switches');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-watchlist] OK - ${pass} assertions`);
} catch (err) {
  console.error(`[radar-watchlist] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
