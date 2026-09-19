#!/usr/bin/env node
// test/digest-engage.test.mjs - the "Respond for me" digest block (spec 50 §S8, §11).
//
// THE ACCEPTANCE SENTENCE, verbatim from §11: "every number in the block equals a counter or
// spec 44 evidence count; no follower field exists." Both halves are load-bearing.
//
// The first half is what keeps the digest HONEST. A digest is the one surface the owner reads
// without checking, so a number in it that nothing on disk backs is worse than no number: it is
// a claim the owner will act on. Every figure here is therefore traced back to the exact
// state.engage.counters entry that produced it, and the test moves a counter and watches the
// line move with it.
//
// The second half is the owner's decision (§0/§6) that this feature reports what it DID, never
// how big it made anything look. Follower counts, reach and engagement rates are absent BY
// CONSTRUCTION, and the test asserts on the rendered text so a future line cannot smuggle one in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-digest-engage-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { engageDigestLines } = await import('../lib/engage-digest.mjs');
const { makeT } = await import('../lib/i18n.mjs');
const { dateKeyFor } = await import('../lib/engage-pacer.mjs');

const t = makeT('en');
const tDe = makeT('de-CH');
const NOW = Date.parse('2026-09-09T12:00:00Z');
const DAY = 24 * 3600 * 1000;
const today = dateKeyFor(NOW, 'UTC');
const daysAgo = (n) => dateKeyFor(NOW - n * DAY, 'UTC');

// The counters the whole block is derived from. Written by hand here, exactly as
// lib/engage.mjs#incrementCounter writes them: `${lane} ${kind} ${YYYY-MM-DD}`.
const counters = {
  [`mastodon reply ${today}`]: 5,
  [`reddit reply ${today}`]: 4,
  [`mastodon like ${today}`]: 9,
  [`bluesky upvote ${today}`]: 5,      // upvote FOLDS into like - one act, one number
  [`bluesky follow ${today}`]: 2,
  [`mastodon repost ${today}`]: 1,
  [`reddit reply ${daysAgo(3)}`]: 20,
  [`mastodon reply ${daysAgo(6)}`]: 12,
  [`mastodon reply ${daysAgo(9)}`]: 500, // OUTSIDE the 7-day window: must not appear anywhere
};

const engage = {
  counters,
  asks: [
    { id: 'a1', status: 'open', reasonLine: 'press inquiry', author: 'journo' },
    { id: 'a2', status: 'answered' },
  ],
  lanes: {
    x: { pausedUntil: new Date(NOW + 6 * 3600 * 1000).toISOString(), pauseReason: 'platform_limit' },
    mastodon: { pausedUntil: new Date(NOW - DAY).toISOString(), pauseReason: 'repeated_failure' },
  },
};

const render = (policy, opts = {}) => engageDigestLines(engage, policy, opts.t || t, {
  now: NOW, tz: 'UTC', authorRepliedCount: 6, clientName: 'pendpost', telegramChatId: 'chat-1', ...opts,
});

try {
  // ---- 1. mode off produces NOTHING --------------------------------------------------------
  ok(engageDigestLines(engage, { mode: 'off' }, t, { now: NOW }).length === 0,
    'an off client gets no block at all - its digest stays byte-unchanged');
  ok(engageDigestLines(engage, {}, t, { now: NOW }).length === 0, 'and so does a client with no engage policy at all');

  // ---- 2. Every number traces to a counter -------------------------------------------------
  const lines = render({ mode: 'live', paused: false });
  const text = lines.join('\n');
  console.log(`\n--- rendered block ---\n${text}\n---------------------\n`);

  ok(/Respond for me \(pendpost\) · Live/.test(text), 'the header names the brand and the mode');

  // replied = 5 (mastodon) + 4 (reddit) = 9, summed across lanes.
  ok(/replied 9\b/.test(text), 'replied 9 = the two lanes\' reply counters for TODAY, summed (5 + 4)');
  // liked = 9 (mastodon like) + 5 (bluesky upvote): upvote folds into like.
  ok(/liked 14\b/.test(text), 'liked 14 folds `upvote` into `like` - two names for one platform act, so one number');
  ok(/followed 2\b/.test(text), 'followed 2 comes straight off the follow counter');
  ok(/reposted 1\b/.test(text), 'reposted 1 likewise');
  ok(/messages 0\b/.test(text), 'and a kind with NO counter renders 0, never a blank or an omitted field');

  // The 7-day line: 4 + 5 today + 20 (3 days ago) + 12 (6 days ago) = 41. The 9-days-ago 500 is
  // outside the window and must not leak in.
  ok(/Last 7 days: 41 replies/.test(text), 'the 7-day reply figure sums exactly the last seven date keys (9 + 20 + 12 = 41)');
  ok(!/500/.test(text), 'a counter from 9 days ago is OUTSIDE the window and appears nowhere');
  ok(/6 got an answer back/.test(text), 'and the "answered back" half is the spec 44 evidence count the caller passed in');

  // ---- 3. Moving a counter moves the line ---------------------------------------------------
  // The strongest form of "every number equals a counter": change the counter, watch the number.
  const bumped = { ...engage, counters: { ...counters, [`mastodon like ${today}`]: 10 } };
  const bumpedText = engageDigestLines(bumped, { mode: 'live' }, t, { now: NOW, tz: 'UTC', authorRepliedCount: 6, clientName: 'pendpost', telegramChatId: 'c' }).join('\n');
  ok(/liked 15\b/.test(bumpedText), 'raising one counter by one raises exactly one figure by one - nothing here is computed twice or estimated');

  // ---- 4. Needs you + cooling down ----------------------------------------------------------
  ok(/Needs you: 1 open/.test(text), 'only OPEN asks are counted (the answered one is not open work)');
  ok(/press inquiry/.test(text) && /@journo/.test(text), 'with a short parenthetical, so the line is actionable rather than a bare count');
  ok(/Cooling down: x \(platform limit\)/.test(text), 'the cooling-down line names the lane and says its reason in words, never the raw enum');
  ok(!/repeated_failure|platform_limit/.test(text), 'no raw enum value reaches the digest (spec 50 §10)');
  ok(!/mastodon \(several failed/.test(text), 'a lane whose cool-down has EXPIRED is not listed - "cooling down" means right now');

  const quiet = engageDigestLines(
    { counters: {}, asks: [], lanes: {} }, { mode: 'live' }, t,
    { now: NOW, tz: 'UTC', authorRepliedCount: 0, clientName: 'pendpost', telegramChatId: 'c' },
  ).join('\n');
  ok(/Needs you: nothing/.test(quiet) && /Cooling down: none/.test(quiet),
    'an idle client gets explicit "nothing" and "none" lines rather than missing ones - a silent gap reads as a bug');
  ok(/replied 0 · liked 0 · followed 0 · reposted 0 · messages 0/.test(quiet), 'and a day with no activity says so in full');

  // ---- 5. NO follower / reach / rate field, anywhere -----------------------------------------
  const forbidden = [/follower/i, /reach/i, /impression/i, /engagement rate/i, /audience/i, /views?\b/i];
  ok(forbidden.every((re) => !re.test(text)), 'no follower, reach, impression, rate or view figure exists in the block (§11, owner decision §0)');
  // And the module cannot produce one even with a hostile input: the counters are the only source.
  const hostile = engageDigestLines(
    { counters: { [`mastodon reply ${today}`]: 1 }, asks: [], lanes: {}, followers: 99999, reach: 12345 },
    { mode: 'live' }, t, { now: NOW, tz: 'UTC', authorRepliedCount: 0, clientName: 'p', telegramChatId: 'c' },
  ).join('\n');
  ok(!/99999/.test(hostile) && !/12345/.test(hostile),
    'a followers/reach field sitting in the state subtree is NOT rendered - the block reads counters and nothing else');

  // ---- 6. Modes ------------------------------------------------------------------------------
  ok(/· Dry run/.test(render({ mode: 'dry_run' }).join('\n')), 'a dry-run client says Dry run, not Live');
  ok(/· Live · paused/.test(render({ mode: 'live', paused: true }).join('\n')), 'and a paused one says so, because "Live" alone would be a lie');

  // ---- 7. Row 9e: no push channel -------------------------------------------------------------
  const noPush = render({ mode: 'live' }, { telegramChatId: '' }).join('\n');
  ok(/No phone push is set up/.test(noPush) && /owner-chat/.test(noPush),
    'a Live client with no Telegram chat id gets the setup line, naming the exact command - the digest is where the owner would otherwise never learn it');
  ok(!/No phone push/.test(text), 'a client that HAS one is not nagged');
  ok(!/No phone push/.test(render({ mode: 'dry_run' }, { telegramChatId: '' }).join('\n')),
    'and a dry-run client is not nagged either - nothing can need them yet');

  // ---- 8. de-CH ------------------------------------------------------------------------------
  const de = render({ mode: 'live' }, { t: tDe }).join('\n');
  console.log(`--- de-CH ---\n${de}\n-------------\n`);
  ok(/Für mich antworten \(pendpost\)/.test(de), 'the German block is translated, not an English leak');
  ok(/Heute: geantwortet 9 · geliked 14/.test(de), 'including the kind labels, with the same numbers');
  ok(/Letzte 7 Tage: 41 Antworten, 6 haben zurückgeschrieben/.test(de), 'and the payoff line');
  ok(/Kühlt ab: x \(Plattform-Limit\)/.test(de), 'and the cool-down reason');
  ok(!/ß/.test(de), 'Swiss orthography: never ß');
  ok(!/[—–]/.test(de) && !/[—–]/.test(text), 'and no em or en dashes in either language');

  console.log(`digest-engage: ${pass} checks passed${failures ? `, ${failures} FAILED` : ''}`);
  process.exit(failures ? 1 : 0);
} catch (err) {
  console.error('digest-engage test crashed:', err);
  process.exit(1);
}
