// radar-hn-context.test.mjs - Radar 2.0 step 1, item 2: Hacker News hits carry their context.
//
// The live failure this pins: a client's feed was 12 April comments under OTHER products' "Show HN"
// threads (a reply there is a hijack), the Ask HN body (story_text) was thrown away so a real
// question read as its title only, and the search spent its 25 hits per term on years-old threads
// the seam then dropped as stale. Fixtures are reconstructions of those hit shapes, not live data.
//
// Proofs:
//   (a) hnSearchUrl sends numericFilters=created_at_i>N for a lookback, and nothing without one;
//   (b) hnHitToSignal: a story keeps title + story_text (HTML decoded); a comment keeps its own
//       words and carries the parent story title as threadTitle; normalizeSignal keeps it;
//   (c) cmdRadar (stubbed fetch, zero network) forwards query.lookbackDays to every request and
//       returns comments with threadTitle;
//   (d) engineDropReason: a comment under someone else's Show HN / Launch HN is dropped as
//       foreign_launch_thread; one under an Ask HN thread, under the brand's own Show HN, a
//       top-level Show HN story, and a brand-mention query's hit are all kept.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-hn-context-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;

const realFetch = global.fetch;
const reply = (body) => Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(body)), json: () => Promise.resolve(body) });

const ASK_STORY = { objectID: '9001', _tags: ['story', 'ask_hn'], author: 'seeker', title: 'Ask HN: How do you schedule posts to Mastodon and Bluesky?', story_text: '<p>I post to four networks by hand.</p><p>Is there a self-hosted tool that doesn&#x27;t charge per channel?</p>', created_at_i: 1761700000 };
const SHOW_COMMENT = { objectID: '9002', _tags: ['comment'], author: 'fan', comment_text: 'Nice! How does this compare to Buffer for scheduling posts?', story_title: 'Show HN: PostBot, a social media scheduler I built', story_id: 8000, created_at_i: 1761700100 };
const ASK_COMMENT = { objectID: '9003', _tags: ['comment'], author: 'helper', comment_text: 'I also need a social media scheduler that is self-hosted, any tips?', story_title: 'Ask HN: Self-hosted social media scheduler?', created_at_i: 1761700200 };

try {
  const hn = await import('../scripts/hacker-news-social.mjs');
  const { normalizeSignal } = await import('../lib/radar.mjs');
  const { engineDropReason, isForeignLaunchThread, RADAR_DROP_REASONS } = await import('../lib/radar-prefilter.mjs');

  // ---- (a) the time filter ------------------------------------------------------------------
  const now = Date.UTC(2026, 9, 29, 12, 0, 0);
  const since = hn.hnSinceSec(7, now);
  ok(since === Math.floor(now / 1000) - 7 * 86_400, `hnSinceSec(7) is now minus 7 days in unix seconds (${since})`);
  ok(hn.hnSinceSec(null) === null && hn.hnSinceSec(0) === null, 'no lookback (null/0) means no floor');
  const withFloor = new URL(hn.hnSearchUrl('scheduler', { sinceSec: since }));
  ok(withFloor.searchParams.get('numericFilters') === `created_at_i>${since}`, `the request carries numericFilters=created_at_i>N (${withFloor.searchParams.get('numericFilters')})`);
  ok(!new URL(hn.hnSearchUrl('scheduler')).searchParams.has('numericFilters'), 'without a lookback no numericFilters is sent');

  // ---- (b) the hit shape ----------------------------------------------------------------------
  const story = hn.hnHitToSignal(ASK_STORY);
  ok(story.text.startsWith('Ask HN: How do you schedule posts') && story.text.includes("Is there a self-hosted tool that doesn't charge per channel?"), 'a story keeps its title AND its decoded story_text body');
  ok(!/<p>|&#x27;/.test(story.text), 'HTML tags and entities are decoded out of the body');
  ok(!('threadTitle' in story), 'a top-level story carries no threadTitle');
  const comment = hn.hnHitToSignal(SHOW_COMMENT);
  ok(comment.text === 'Nice! How does this compare to Buffer for scheduling posts?', 'a comment keeps its own words as text');
  ok(comment.threadTitle === 'Show HN: PostBot, a social media scheduler I built', 'a comment carries the parent story title as threadTitle');
  const norm = normalizeSignal(comment, 'hackernews');
  ok(norm.threadTitle === comment.threadTitle, 'normalizeSignal keeps threadTitle');
  ok(!('threadTitle' in normalizeSignal({ source: 'reddit', externalId: 'x', text: 't' }, 'reddit')), 'a signal without a thread title stays without one');

  // ---- (c) cmdRadar end to end, stubbed fetch -----------------------------------------------------
  const urls = [];
  global.fetch = (url) => { urls.push(String(url)); return reply({ hits: [ASK_STORY, SHOW_COMMENT, ASK_COMMENT] }); };
  hn.RUN.results.length = 0;
  await hn.cmdRadar({ query: JSON.stringify({ keywords: ['social media scheduler', 'schedule posts'], lookbackDays: 7 }) });
  global.fetch = realFetch;
  ok(urls.length === 2 && urls.every((u) => /^created_at_i>\d+$/.test(new URL(u).searchParams.get('numericFilters') || '')), `every Algolia request carries the lookback floor (${urls.map((u) => new URL(u).searchParams.get('numericFilters')).join(',')})`);
  const row = hn.RUN.results.find((r) => r && r.action === 'radar');
  ok(row && row.ok === true && row.items.length === 3, 'the three hits come back once each');
  ok(row && row.items.find((i) => i.externalId === '9002')?.threadTitle === SHOW_COMMENT.story_title, 'the comment hit rides with its threadTitle out of the engine');

  // ---- (d) the foreign launch thread rule -------------------------------------------------------------
  ok(RADAR_DROP_REASONS.includes('foreign_launch_thread'), 'foreign_launch_thread is a named drop reason');
  const Q = { id: 'sched', label: 'scheduler seekers', lang: 'en', keywords: ['social media scheduler', 'schedule posts'], sources: ['hackernews'] };
  const sig = (raw) => normalizeSignal(hn.hnHitToSignal(raw), 'hackernews');
  ok(engineDropReason(sig(SHOW_COMMENT), Q, {}) === 'foreign_launch_thread', 'a comment under another product\'s Show HN is dropped as foreign_launch_thread');
  ok(engineDropReason(sig({ ...SHOW_COMMENT, objectID: '9004', story_title: 'Launch HN: Postly (YC S26) - schedule posts everywhere' }), Q, {}) === 'foreign_launch_thread', 'a Launch HN thread counts as a launch too');
  ok(engineDropReason(sig(ASK_COMMENT), Q, {}) === null, 'a comment in an Ask HN thread is kept');
  ok(engineDropReason(sig(ASK_STORY), Q, {}) === null, 'the Ask HN story itself is kept');
  ok(engineDropReason(sig({ objectID: '9005', _tags: ['story', 'show_hn'], author: 'maker', title: 'Show HN: A social media scheduler you can self-host', created_at_i: 1761700300 }), Q, {}) === null, 'a top-level Show HN story is not caught by the comment rule');
  ok(engineDropReason(sig({ ...SHOW_COMMENT, objectID: '9006', story_title: 'Show HN: pendpost, a local-first social media scheduler' }), Q, { brandNames: ['pendpost'] }) === null, 'a comment under the brand\'s OWN Show HN is kept');
  ok(isForeignLaunchThread({ threadTitle: 'Show HN: Tillbooks, accounting for Swiss GmbHs' }, ['tillbooks.ch']) === false, 'a brand name given as a domain still recognises its own launch');
  ok(engineDropReason(sig({ ...SHOW_COMMENT, objectID: '9007', comment_text: 'pendpost does this too' }), { id: 'm', label: 'mentions', mention: true, keywords: ['pendpost'] }, {}) === null, 'a brand-mention query keeps a mention even under a foreign launch');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-hn-context] OK - HN hits keep their body and thread title, honour the lookback, and skip foreign launch threads (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-hn-context] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  global.fetch = realFetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
