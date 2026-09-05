#!/usr/bin/env node
// test/radar-copy-posted.test.mjs - R5 piece 2 (ux-audit 2026-08-04, dim-2 G2/N1).
//
// A copy-draft lane (HN, non-Enterprise X, karma post ideas) has no engine publish path:
// the operator copies the drafted text and posts it by hand. Until now the feed had no way
// to record THAT the copy went out, so isAnswered counted a copy draft "answered" the moment
// the scan drafted it (a lie - a drafted-but-unposted reply is not an answer). markCopyPosted
// is the missing signal-level write: a durable {postedUrl?, ts} ledger keyed by signal (the
// `seen` pattern), surfaced by listRadar as signal.copyPosted, so isAnswered can count a copy
// draft answered ONLY once it is marked posted. This pins the write + the read-back join +
// durability across a re-scan.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-copyposted-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { radarIngest, markCopyPosted, listRadar } = await import('../lib/writes.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');

const setRadar = (radar) => setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar } } });
const QUERY = { id: 'q1', label: 'q', sources: ['reddit', 'hackernews'], keywords: ['schedule'] };

let sn = 0;
const seed = async ({ source = 'hackernews', text = 'Looking for a tool to schedule posts across HN and Reddit.' } = {}) => {
  sn += 1;
  const externalId = `ext-${sn}`;
  const url = `https://example.com/thread/${sn}`;
  const res = await radarIngest({ queryId: 'q1', signals: [{ source, ts: new Date().toISOString(), externalId, url, author: `u${sn}`, text, score: 70 }], actor: 'agent:claude' });
  assert.ok(res.ok, `ingest ok: ${JSON.stringify(res)}`);
  return { source, ts: new Date().toISOString(), externalId, url };
};
const findSignal = async (sig) => (await listRadar({})).items.find((s) => s.source === sig.source && s.externalId === sig.externalId);

try {
  setRadar({ enabled: true, queries: [QUERY] });

  // --- validation ----------------------------------------------------------------
  const noActor = await markCopyPosted({ source: 'hackernews', externalId: 'x' });
  ok(noActor.code === 'invalid_input', 'actor is required');
  const badSrc = await markCopyPosted({ source: 'myspace', externalId: 'x', actor: 'owner' });
  ok(badSrc.code === 'invalid_input', 'an unknown source is refused');
  const noExt = await markCopyPosted({ source: 'hackernews', externalId: '  ', actor: 'owner' });
  ok(noExt.code === 'invalid_input', 'externalId is required');
  const badUrl = await markCopyPosted({ source: 'hackernews', externalId: 'x', actor: 'owner', postedUrl: 'ftp://nope' });
  ok(badUrl.code === 'invalid_input', 'a non-http(s) postedUrl is refused');

  // --- the happy path: mark a copy draft posted, with a link -----------------------
  const hn = await seed({ source: 'hackernews' });
  const before = await findSignal(hn);
  ok(before && !before.copyPosted, 'before marking, the signal carries no copyPosted marker');

  const r1 = await markCopyPosted({ source: 'hackernews', externalId: hn.externalId, actor: 'owner', postedUrl: 'https://news.ycombinator.com/item?id=42' });
  ok(r1.ok === true && r1.source === 'hackernews', 'markCopyPosted succeeds');
  ok(r1.postedUrl === 'https://news.ycombinator.com/item?id=42', 'the response echoes the posted link');

  const after = await findSignal(hn);
  ok(after && after.copyPosted && after.copyPosted.at, 'listRadar surfaces signal.copyPosted with a timestamp');
  ok(after.copyPosted.postedUrl === 'https://news.ycombinator.com/item?id=42', 'the surfaced marker carries the posted link');

  // --- a bare mark (no link) is allowed; a later mark corrects the link in place -----
  const karma = await seed({ source: 'reddit' }); // a karma post idea posts by hand too
  const bare = await markCopyPosted({ source: 'reddit', externalId: karma.externalId, actor: 'owner' });
  ok(bare.ok === true && bare.postedUrl === null, 'a bare mark (no link) is allowed on a copy source');
  const bareSig = await findSignal(karma);
  ok(bareSig.copyPosted && bareSig.copyPosted.postedUrl === null, 'the bare marker is surfaced with a null link');
  const fix = await markCopyPosted({ source: 'reddit', externalId: karma.externalId, actor: 'owner', postedUrl: 'https://reddit.com/r/x/karma' });
  ok(fix.ok === true, 'a second mark is allowed (link correction)');
  const fixed = await findSignal(karma);
  ok(fixed.copyPosted.postedUrl === 'https://reddit.com/r/x/karma', 'the link was corrected in place (last write wins)');

  // --- durability: the marker outlives a re-scan that rebuilds the signal cache ------
  await radarIngest({ queryId: 'q1', signals: [{ source: 'hackernews', ts: new Date().toISOString(), externalId: hn.externalId, url: hn.url, author: 'u1', text: 'refreshed text', score: 90 }], actor: 'agent:claude' });
  const rescanned = await findSignal(hn);
  ok(rescanned && rescanned.copyPosted && rescanned.copyPosted.postedUrl === 'https://news.ycombinator.com/item?id=42',
    'the copyPosted marker survives a re-scan (durable ledger, not a cache field)');
} catch (err) {
  failures += 1;
  console.error('  FAIL - threw:', err && err.stack || err);
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
