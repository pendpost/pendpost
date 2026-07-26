#!/usr/bin/env node
// test/poll-assembly.test.mjs - spec 10 (native poll), per-lane engine assembly
// (Pattern P3). Each poll-capable lane (x, linkedin, telegram, discord, mastodon,
// reddit, nostr) branches on post.type === 'poll' inside its existing publish-due
// (mastodon rides `schedule`) and attaches the lane's NATIVE poll object.
//
// Mock-first (Pattern P9): the credential-free mock-driver.mjs mirrors each live
// engine's publish, echoing the assembled poll (options + duration) AS A FIELD on the
// publish row so a test can assert - with no network - that the driver "saw" the poll
// the live engine would attach. A media-less poll still converges to `posted` (both
// media predicates were updated), and the poll object round-trips options + duration.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-poll-asm-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans', 'poll-camp'), { recursive: true });

const { runMockCommand } = await import('../lib/drivers/mock-driver.mjs');
// Guarded entrypoints (no main() on import) - so the pure poll-assembly helpers are
// unit-testable without a relay/Telegram round-trip.
const { buildPollTags } = await import('../scripts/nostr-social.mjs');
const { buildPollBody } = await import('../scripts/telegram-social.mjs');

const planPath = path.join(WS, 'data', 'plans', 'poll-camp', 'post-plan.json');
const OPTIONS = ['Yes', 'No', 'Maybe'];
const DURATION = 1440;
const approved = { approval: 'approved', status: 'planned', executionMode: 'fully-scheduled' };

// A poll post for one lane. Past-due so mastodon's `schedule` takes the immediate-
// publish branch (a poll fires as one `publish` row on every lane).
function pollPost(id, lane) {
  return { id, platforms: [lane], type: 'poll', caption: 'Best release day?', poll: { options: [...OPTIONS], durationMinutes: DURATION }, scheduledAt: '2020-01-01T00:00:00Z', ...approved };
}
function mkPlan(posts) { fs.writeFileSync(planPath, JSON.stringify({ campaign: 'poll-camp', posts }, null, 2)); }

// (engine platform id, the mock lane, the publish-due/schedule command)
const LANES = [
  ['x', 'x', 'publish-due'],
  ['linkedin', 'linkedin', 'publish-due'],
  ['telegram', 'telegram', 'publish-due'],
  ['discord', 'discord', 'publish-due'],
  ['reddit', 'reddit', 'publish-due'],
  ['nostr', 'nostr', 'publish-due'],
  ['mastodon', 'mastodon', 'schedule'], // native lane rides `schedule`
];

try {
  for (const [platform, lane, command] of LANES) {
    mkPlan([pollPost('pl1', lane)]);
    const out = await runMockCommand({ platform, command, planPath, only: 'pl1' });

    const publishRow = out.results.find((r) => r.action === 'publish' && r.ok === true);
    ok(Boolean(publishRow), `${platform}: the poll fires exactly one publish result row`);
    ok(publishRow && publishRow.poll && Array.isArray(publishRow.poll.options) && publishRow.poll.options.length === 3,
      `${platform}: the driver saw the poll object with its 3 options`);
    ok(publishRow && publishRow.poll && publishRow.poll.durationMinutes === DURATION,
      `${platform}: the poll object carries the requested duration (${DURATION} min)`);
    ok(out.results.filter((r) => r.action === 'publish').length === 1,
      `${platform}: exactly one publish row (no duplicate/half-post)`);

    // A media-less poll still converges to `posted` (both media predicates updated).
    const saved = JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0];
    ok(saved.status === 'posted', `${platform}: the media-less poll converges to posted (no "media missing" stranding)`);
  }

  // A poll fanned out to several poll lanes at once attaches its poll on EACH lane's
  // publish row (the meta lane does not carry a poll - it is not a poll lane).
  mkPlan([{ id: 'pl2', platforms: ['x', 'telegram', 'discord'], type: 'poll', caption: 'Q?', poll: { options: ['A', 'B'], durationMinutes: 60 }, scheduledAt: '2020-01-01T00:00:00Z', ...approved }]);
  for (const lane of ['x', 'telegram', 'discord']) {
    const out = await runMockCommand({ platform: lane, command: 'publish-due', planPath, only: 'pl2' });
    const row = out.results.find((r) => r.action === 'publish' && r.ok === true);
    ok(row && row.poll && row.poll.options.length === 2 && row.poll.durationMinutes === 60,
      `${lane}: a multi-lane poll attaches its 2-option / 60-min poll on this lane`);
  }

  // ---- nostr: NIP-88 option tags (spec 10 review, finding #1) ----------------
  const pollFor = (opts, durationMinutes, extra = {}) => ({ type: 'poll', poll: { options: opts, durationMinutes, ...extra } });
  const tags = buildPollTags(pollFor(['Yes', 'No', 'Maybe'], 1440), ['wss://relay.example'], 1000);
  const optionTags = tags.filter((tg) => tg[0] === 'option');
  ok(optionTags.length === 3, 'nostr: buildPollTags emits one NIP-88 `option` tag per choice');
  ok(!tags.some((tg) => tg[0] === 'poll_option'), 'nostr: NO NIP-69 `poll_option` tag (NIP-88 poll vocabulary is `option`)');
  ok(optionTags[0][0] === 'option' && optionTags[0][1] === '0' && optionTags[0][2] === 'Yes',
    'nostr: an option tag is [option, <id>, <label>]');
  ok(tags.some((tg) => tg[0] === 'polltype' && tg[1] === 'singlechoice'), 'nostr: carries the polltype tag');
  ok(tags.some((tg) => tg[0] === 'endsAt' && tg[1] === String(1000 + 1440 * 60)), 'nostr: carries the endsAt (unix seconds) tag');

  // ---- telegram: open_period auto-close (spec 10 review, finding #2) ----------
  const dayBody = buildPollBody(pollFor(['A', 'B'], 1440), 'Q?', '@chan');
  ok(dayBody.open_period === 86400, 'telegram: a 1-day poll sets open_period=86400 (Bot API 9.6 - it DOES close after 1 day)');
  const weekBody = buildPollBody(pollFor(['A', 'B'], 10080), 'Q?', '@chan');
  ok(weekBody.open_period === 604800, 'telegram: a 7-day poll sets open_period=604800 (no longer silently dropped at the old 600s ceiling)');
  const hugeBody = buildPollBody(pollFor(['A', 'B'], 60000), 'Q?', '@chan');
  ok(!('open_period' in hugeBody), 'telegram: a beyond-auto-close duration is created open-ended (no open_period), not silently clamped');

  // ---- structured invalid_poll row instead of a silent-empty envelope (finding #4) ----
  mkPlan([{ id: 'bad-opts', platforms: ['telegram'], type: 'poll', caption: 'Q?', poll: { options: ['Only one'], durationMinutes: 60 }, scheduledAt: '2020-01-01T00:00:00Z', ...approved }]);
  const badOpts = await runMockCommand({ platform: 'telegram', command: 'publish-due', planPath, only: 'bad-opts' });
  const badOptsRow = badOpts.results.find((r) => r.action === 'publish');
  ok(badOptsRow && badOptsRow.ok === false && badOptsRow.errorCode === 'invalid_poll',
    'telegram: an under-options poll yields a structured { ok:false, errorCode:"invalid_poll" } row');
  ok(badOpts.results.length >= 1, 'telegram: a blocked poll is NOT a silent empty { ok:true, results:[] } envelope');
  ok(JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0].status !== 'posted', 'telegram: a blocked poll never converges to posted');

  mkPlan([{ id: 'bad-dur', platforms: ['x'], type: 'poll', caption: 'Q?', poll: { options: ['A', 'B'], durationMinutes: 1 }, scheduledAt: '2020-01-01T00:00:00Z', ...approved }]);
  const badDur = await runMockCommand({ platform: 'x', command: 'publish-due', planPath, only: 'bad-dur' });
  const badDurRow = badDur.results.find((r) => r.action === 'publish');
  ok(badDurRow && badDurRow.ok === false && badDurRow.errorCode === 'invalid_poll',
    'x: an out-of-range poll duration (1 min < X floor 5) yields a structured invalid_poll row');

  // ---- a poll never gets a mock set-alt row (spec 10 review, finding #5) ------
  mkPlan([{ id: 'alt-poll', platforms: ['x'], type: 'poll', caption: 'Q?', altText: 'stray alt', poll: { options: ['A', 'B'], durationMinutes: 60 }, scheduledAt: '2020-01-01T00:00:00Z', ...approved }]);
  const altOut = await runMockCommand({ platform: 'x', command: 'publish-due', planPath, only: 'alt-poll' });
  ok(!altOut.results.some((r) => r.action === 'set-alt'),
    'x: a poll carrying stray altText gets NO mock set-alt row (matches live - polls skip uploadMedia)');
  ok(altOut.results.some((r) => r.action === 'publish' && r.ok === true), 'x: the poll itself still publishes (mock matches live)');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
