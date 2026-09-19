#!/usr/bin/env node
// test/engage-capabilities.test.mjs - the ENGAGE_CAPABILITIES table (spec 50 §7.2), the ONE
// place that knows how each engage kind executes on each lane.
//
// Pins what the pacer and the failsafe ladder depend on: every (lane, kind) cell is DECIDED
// (a list or an explicit null, never undefined - an undefined cell would read as "no route"
// in one caller and "not checked yet" in the next), the kinds the spec calls impossible are
// null, the executor tokens are the three the ladder knows, and the one config-dependent
// cell (x reply) flips with the owner-declared xEnterprise flag.
//
// Zero-dep node:assert, no state and no config: the table is frozen data.
import assert from 'node:assert';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

try {
  const { ENGAGE_CAPABILITIES, ENGAGE_KINDS, engageExecutorsFor, RADAR_CAPABILITIES } = await import('../lib/radar.mjs');

  const LANES = Object.keys(ENGAGE_CAPABILITIES);
  const EXECUTORS = ['api', 'browser', 'browser2'];

  // 1. The kind list is the spec's, in the spec's order.
  assert.deepStrictEqual([...ENGAGE_KINDS], ['reply', 'like', 'upvote', 'follow', 'repost', 'dm', 'post']);
  ok(true, 'ENGAGE_KINDS is the seven kinds of spec 50 D4');

  // 2. Every lane is a real Radar source, and `web` (a find, not an account) has no row.
  ok(LANES.every((l) => l in RADAR_CAPABILITIES), 'every engage lane is a known Radar source');
  ok(!('web' in ENGAGE_CAPABILITIES), 'web has no engage row - an open-web find is not an account');
  for (const l of ['reddit', 'mastodon', 'bluesky', 'hackernews', 'x', 'youtube', 'nostr', 'linkedin', 'instagram', 'quora']) {
    ok(LANES.includes(l), `${l} has an engage row`);
  }

  // 3. NO UNDEFINED CELL: every lane x kind is decided, and every non-null cell is a
  //    non-empty ordered list of known executor tokens.
  let undecided = [];
  let badToken = [];
  for (const lane of LANES) {
    for (const kind of ENGAGE_KINDS) {
      const cell = ENGAGE_CAPABILITIES[lane][kind];
      if (cell === undefined) undecided.push(`${lane}.${kind}`);
      else if (cell !== null && !(Array.isArray(cell) && cell.length && cell.every((x) => EXECUTORS.includes(x)))) badToken.push(`${lane}.${kind}`);
    }
    const id = ENGAGE_CAPABILITIES[lane].identity;
    if (!(id === null || (typeof id === 'string' && id.length))) badToken.push(`${lane}.identity`);
  }
  ok(undecided.length === 0, `no undefined cell for any lane x kind${undecided.length ? ` (${undecided.join(', ')})` : ''}`);
  ok(badToken.length === 0, `every non-null cell is an ordered list of api|browser|browser2${badToken.length ? ` (${badToken.join(', ')})` : ''}`);

  // 4. The null cells the spec names, one by one. These are "impossible on this platform",
  //    not "not built yet": triage must never emit them, so a silent flip to a list is a bug.
  const NULLS = [
    ['reddit', 'repost'],       // a crosspost reads as spam
    ['hackernews', 'follow'], ['hackernews', 'repost'], ['hackernews', 'dm'],
    ['youtube', 'repost'], ['youtube', 'dm'],
    ['instagram', 'repost'],
    ['quora', 'repost'], ['quora', 'dm'], ['quora', 'post'],
  ];
  for (const [lane, kind] of NULLS) ok(ENGAGE_CAPABILITIES[lane][kind] === null, `${lane}.${kind} is null (not possible on the platform)`);

  // 5. A browser route always comes with an identity check (spec 50 D13: the child confirms
  //    WHICH account Chrome is logged in as before it acts); an api-only lane needs none.
  for (const lane of LANES) {
    const row = ENGAGE_CAPABILITIES[lane];
    const usesBrowser = ENGAGE_KINDS.some((k) => Array.isArray(row[k]) && row[k].some((x) => x.startsWith('browser')));
    ok(usesBrowser ? typeof row.identity === 'string' : row.identity === null,
      usesBrowser ? `${lane} drives Chrome, so it names an identity check` : `${lane} is API-only, so it needs no identity check`);
  }

  // 6. The one config-dependent cell: x reply. Tier default = browser; xEnterprise puts the
  //    API route FIRST and keeps the browser as the fallback.
  assert.deepStrictEqual([...engageExecutorsFor('x', 'reply', null)], ['browser', 'browser2']);
  ok(true, 'x reply defaults to the browser route (X refuses API replies to strangers below Enterprise)');
  assert.deepStrictEqual([...engageExecutorsFor('x', 'reply', { radar: { xEnterprise: true } })], ['api', 'browser', 'browser2']);
  ok(true, 'xEnterprise flips x reply to api first, browser as the fallback');
  assert.deepStrictEqual([...engageExecutorsFor('x', 'reply', { posting: { radar: { xEnterprise: true } } })], ['api', 'browser', 'browser2']);
  ok(true, 'the flag is read from a whole config too');
  assert.deepStrictEqual([...engageExecutorsFor('x', 'reply', { xEnterprise: true })], ['api', 'browser', 'browser2']);
  ok(true, 'and from a bare radar subtree');
  ok(ENGAGE_CAPABILITIES.x.reply.join() === 'browser,browser2', 'the frozen table itself keeps the tier default');
  assert.deepStrictEqual([...engageExecutorsFor('x', 'like', { radar: { xEnterprise: true } })], ['api', 'browser']);
  ok(true, 'the flag touches ONLY x reply - like keeps its own order');

  // 7. Lookup is closed: an unknown lane, an unknown kind and a null cell all read as
  //    "no route", so a typo can never widen what the pacer will attempt.
  ok(engageExecutorsFor('facebook', 'reply', null) === null, 'an unknown lane has no executor');
  ok(engageExecutorsFor('reddit', 'bribe', null) === null, 'an unknown kind has no executor');
  ok(engageExecutorsFor('web', 'reply', null) === null, 'web has no executor');
  ok(engageExecutorsFor('quora', 'post', null) === null, 'a null cell returns null, never a list');
  assert.deepStrictEqual([...engageExecutorsFor('mastodon', 'reply', null)], ['api']);
  ok(true, 'an api lane returns the api route');

  // 8. Frozen: nothing at runtime may widen a route.
  ok(Object.isFrozen(ENGAGE_CAPABILITIES) && Object.isFrozen(ENGAGE_CAPABILITIES.reddit) && Object.isFrozen(ENGAGE_CAPABILITIES.reddit.reply),
    'the table and its rows and cells are frozen');
} catch (err) {
  failures += 1;
  console.error('  FAIL - threw:', (err && err.stack) || err);
}

console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
