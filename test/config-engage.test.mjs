#!/usr/bin/env node
// test/config-engage.test.mjs - the posting.radar.engage subtree (spec 50 §7.1,
// "Respond for me"), plus the posting.notify delivery preference beside it.
//
// engage is the widest autonomy in the app: it can reply, like, follow, repost, message and
// post original content on every lane. Its caps, gaps, waking hours and warm-up ARE the
// safety story, so this pins the three properties that keep them honest:
//   1. every default is closed or conservative, and always fully shaped;
//   2. only the OWNER may write it (an agent must never raise a cap or flip to live), while
//      posting.notify - a delivery address, not autonomy - stays agent-writable;
//   3. a PARTIAL write never clobbers a sibling, one level deeper than its owner-only
//      siblings need, because a missing cap would read as "no limit".
// Plus the autoReply -> engage migration on read: the same autonomy the owner already
// authorized, expressed in the new shape, never wider.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-engage-cfg-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

try {
  const { getConfig, setConfig, RADAR_OWNER_ONLY_KEYS, migrateAutoReplyToEngage } = await import('../lib/config.mjs');
  const { ENGAGE_KINDS } = await import('../lib/radar.mjs');
  const eng = () => getConfig().posting.radar.engage;
  const write = (v, actor = 'owner') => setConfig({ ifRev: getConfig().rev, actor, set: { posting: { radar: { engage: v } } } });
  const refused = (v, actor = 'owner') => write(v, actor).code === 'invalid_input';

  // 1. Defaults: closed, conservative, always fully shaped.
  const d = eng();
  ok(d && typeof d === 'object', 'engage is always present as an object');
  ok(d.mode === 'off', 'mode defaults off (fail-closed: nothing is posted for you)');
  ok(d.paused === false, 'paused defaults false');
  ok(d.minScore === 30, 'minScore defaults 30 (medium and up)');
  ok(d.maxDecisionsPerRun === 40, 'maxDecisionsPerRun defaults 40');
  ok(d.model === 'claude-opus-4-8', 'model defaults to the spec 50 D9 model');
  ok(d.lanes && typeof d.lanes === 'object' && Object.keys(d.lanes).length === 0, 'no lane is enabled by default');
  ok(ENGAGE_KINDS.every((k) => Number.isInteger(d.caps[k])), 'every kind has a numeric daily cap');
  assert.deepStrictEqual(d.caps, { reply: 10, like: 20, upvote: 20, follow: 5, repost: 3, dm: 2, post: 1 });
  ok(true, 'the caps are the spec 50 §7.1 defaults');
  assert.deepStrictEqual(d.gapMinutes, { min: 2, max: 15 });
  assert.deepStrictEqual(d.wakingHours, { start: '08:00', end: '22:00' });
  assert.deepStrictEqual(d.warmup, { days: 14, factor: 0.5 });
  assert.deepStrictEqual(d.grace, { minutes: 15, followerThreshold: 10000 });
  assert.deepStrictEqual(d.originalPosts, { enabled: true, minSignals: 3, windowDays: 7 });
  assert.deepStrictEqual(d.chrome, { probeTtlHours: 24 });
  ok(true, 'gaps, waking hours, warm-up, grace, original posts and the Chrome probe carry their defaults');

  // 2. OWNER-ONLY. An agent may tune queries; it may never grant itself this.
  ok(RADAR_OWNER_ONLY_KEYS.includes('engage'), 'engage is in RADAR_OWNER_ONLY_KEYS');
  const agentTry = write({ mode: 'live' }, 'agent:claude');
  ok(agentTry.code === 'invalid_input' && /only the owner/.test(agentTry.message || ''), 'an agent write is refused');
  ok(eng().mode === 'off', 'and the refused write changed nothing');
  const agentCaps = write({ caps: { dm: 200 } }, 'agent:claude');
  ok(agentCaps.code === 'invalid_input', 'an agent cannot raise a cap either');
  ok(write({ mode: 'dry_run' }).ok !== false, 'the owner may set the mode');
  ok(eng().mode === 'dry_run', 'and the owner write persists');

  // 3. A PARTIAL write never clobbers a sibling - at BOTH levels. A missing cap would read
  //    as "no limit", which is the one wrong answer here.
  write({ lanes: { reddit: { enabled: true } }, caps: { dm: 0 } });
  write({ caps: { reply: 3 } });
  ok(eng().mode === 'dry_run', 'a later partial write keeps the stored mode');
  ok(eng().lanes.reddit.enabled === true, 'and the stored lane');
  ok(eng().caps.dm === 0, 'and the OTHER cap the owner had lowered');
  ok(eng().caps.reply === 3, 'while applying its own cap');
  ok(eng().caps.like === 20, 'and every untouched kind keeps its default');
  // The sibling radar keys survive an engage write, and engage survives an agent's queries write.
  setConfig({ ifRev: getConfig().rev, actor: 'agent:claude', set: { posting: { radar: { queries: [{ id: 'q1', label: 'q' }] } } } });
  ok(eng().mode === 'dry_run' && eng().caps.reply === 3, "an agent's queries write does not drop the owner's engage policy");
  ok(getConfig().posting.radar.queries.length === 1, 'and the queries write applied');

  // 3b. "Live now, keep safety rails" (spec 50, the Radar automation switch). The switch writes
  //     EXACTLY { engage: { mode: 'live' } } and nothing else. That must flip the mode and leave
  //     every safety rail standing: the deep-merge is the only thing between the switch and a
  //     live system with its warm-up, caps and "ask me before anything sensitive" silently reset.
  const railsBefore = { caps: { ...eng().caps }, warmup: { ...eng().warmup }, grace: { ...eng().grace }, sensitive: eng().ask.sensitiveConfirm };
  const liveWrite = write({ mode: 'live' });
  ok(liveWrite.ok !== false && eng().mode === 'live', 'the switch flips the mode to live');
  assert.deepStrictEqual(eng().caps, railsBefore.caps);
  assert.deepStrictEqual(eng().warmup, railsBefore.warmup);
  assert.deepStrictEqual(eng().grace, railsBefore.grace);
  ok(eng().ask.sensitiveConfirm === railsBefore.sensitive && eng().ask.sensitiveConfirm === true,
    'going Live keeps every cap, the warm-up CONFIG, grace AND "sensitive -> ask me first" exactly as they were - the mode flip never wipes the rest of the engage subtree');
  ok(eng().lanes.reddit.enabled === true, 'and the owner\'s enabled lanes survive the flip');
  write({ mode: 'dry_run' }); // leave the rest of the suite on its prior footing

  // 4. Validator ranges: accept the edges, refuse what is outside them.
  ok(write({ minScore: 0 }).ok !== false && write({ minScore: 100 }).ok !== false, 'minScore accepts 0 and 100');
  ok(refused({ minScore: 101 }) && refused({ minScore: -1 }), 'minScore outside 0-100 is refused');
  ok(write({ caps: { follow: 0 } }).ok !== false && write({ caps: { follow: 200 } }).ok !== false, 'a cap accepts 0 (kind disabled) and 200');
  ok(refused({ caps: { follow: 201 } }) && refused({ caps: { follow: -1 } }) && refused({ caps: { follow: 1.5 } }), 'a cap outside 0-200, or fractional, is refused');
  ok(refused({ caps: { bribe: 1 } }), 'a cap for a kind that does not exist is refused');
  ok(write({ gapMinutes: { min: 1, max: 120 } }).ok !== false, 'gapMinutes accepts 1 and 120');
  ok(refused({ gapMinutes: { min: 0, max: 15 } }) && refused({ gapMinutes: { min: 2, max: 121 } }), 'a zero or out-of-range gap is refused');
  ok(refused({ gapMinutes: { min: 20, max: 5 } }), 'a gap whose min exceeds its max is refused');
  ok(write({ warmup: { days: 0, factor: 0 } }).ok !== false && write({ warmup: { days: 90, factor: 1 } }).ok !== false, 'warmup accepts 0-90 days and a 0-1 factor');
  ok(refused({ warmup: { days: 91, factor: 0.5 } }) && refused({ warmup: { days: 14, factor: 2 } }), 'a warm-up factor above 1 (which would RAISE the cap) is refused');
  ok(write({ grace: { minutes: 0, followerThreshold: 0 } }).ok !== false && write({ grace: { minutes: 120, followerThreshold: 1000000 } }).ok !== false, 'grace accepts 0-120 minutes and any non-negative threshold');
  ok(refused({ grace: { minutes: 121, followerThreshold: 10 } }) && refused({ grace: { minutes: 15, followerThreshold: -1 } }), 'an out-of-range grace is refused');
  ok(write({ wakingHours: { start: '00:00', end: '23:59' } }).ok !== false, 'wakingHours accepts HH:MM');
  ok(refused({ wakingHours: { start: '8:00', end: '22:00' } }) && refused({ wakingHours: { start: '24:00', end: '22:00' } }), 'a malformed clock time is refused');
  ok(refused({ maxDecisionsPerRun: 0 }) && refused({ maxDecisionsPerRun: 201 }), 'maxDecisionsPerRun outside 1-200 is refused');
  ok(refused({ chrome: { probeTtlHours: 0 } }) && refused({ chrome: { probeTtlHours: 169 } }), 'the Chrome probe TTL outside 1-168 hours is refused');
  ok(refused({ originalPosts: { minSignals: 0 } }) && refused({ originalPosts: { windowDays: 91 } }), 'the original-post thresholds are bounded');

  // 5. Closed key sets: mode, lanes and unknown keys.
  ok(refused({ mode: 'on' }), 'an unknown mode is refused');
  ok(refused({ mode: 'shadow' }), 'a coined mode name is refused');
  ok(refused({ paused: 'yes' }), 'a non-boolean paused is refused');
  ok(refused({ bogus: 1 }), 'an unknown engage key is refused');
  ok(refused({ lanes: { notalane: { enabled: true } } }), 'a lane that is not a Radar source is refused');
  ok(refused({ lanes: { reddit: { enabled: 'yes' } } }), 'a non-boolean lane switch is refused');
  ok(refused({ lanes: { reddit: { bogus: 1 } } }), 'an unknown lane key is refused');
  ok(write({ lanes: { x: { enabled: true, handle: '@pendpost', warmupStartedAt: null } } }).ok !== false, 'a full lane entry is accepted');

  // 6. posting.notify: a delivery ADDRESS, not autonomy - so NOT owner-gated.
  const notify = () => getConfig().posting.notify;
  ok(notify().telegramChatId === '', 'notify.telegramChatId defaults to empty (not set up)');
  const nWrite = (v, actor = 'agent:claude') => setConfig({ ifRev: getConfig().rev, actor, set: { posting: { notify: v } } });
  ok(nWrite({ telegramChatId: '-1001234567890' }).ok !== false, 'an agent may store the owner chat id (a preference, not autonomy)');
  ok(notify().telegramChatId === '-1001234567890', 'and it persists');
  ok(nWrite({ bogus: 1 }).code === 'invalid_input', 'an unknown notify key is refused');
  ok(nWrite({ telegramChatId: 42 }).code === 'invalid_input', 'a non-string chat id is refused');

  // 7. MIGRATION (pure function): an untouched engage + an ENABLED autoReply reads as live on
  //    exactly those lanes, with every non-reply kind at 0. Never wider than what was granted.
  const migrated = migrateAutoReplyToEngage({ autoReply: { enabled: true, lanes: ['reddit', 'mastodon'] } });
  ok(migrated.mode === 'live', 'an enabled autoReply migrates to engage mode live');
  ok(migrated.lanes.reddit.enabled === true && migrated.lanes.mastodon.enabled === true, 'on exactly the autoReply lanes');
  ok(Object.keys(migrated.lanes).length === 2, 'and no other lane');
  ok(migrated.caps.reply === 10, 'replies keep their cap');
  ok(ENGAGE_KINDS.filter((k) => k !== 'reply').every((k) => migrated.caps[k] === 0), 'and every non-reply kind is capped at 0 - the migration never widens what was granted');
  ok(migrateAutoReplyToEngage({ autoReply: { enabled: false, lanes: ['reddit'] } }).mode === 'off', 'a disabled autoReply migrates to nothing');
  ok(migrateAutoReplyToEngage({ autoReply: { enabled: true, lanes: [] } }).mode === 'off', 'an enabled autoReply with no lane migrates to nothing');
  ok(migrateAutoReplyToEngage({}).mode === 'off', 'no autoReply at all migrates to nothing');
  ok(migrateAutoReplyToEngage(null).mode === 'off', 'and a missing radar subtree does not throw');
  ok(migrateAutoReplyToEngage({ autoReply: { enabled: true, lanes: ['reddit'] }, engage: { mode: 'off' } }).mode === 'off',
    'once the owner has CHOSEN a mode, that IS the policy - autoReply no longer speaks for it');
  ok(migrateAutoReplyToEngage({ autoReply: { enabled: true, lanes: ['reddit'] }, engage: { paused: false } }).mode === 'live',
    'a stored subtree that never named a mode still migrates');
  const partial = migrateAutoReplyToEngage({ engage: { caps: { reply: 2 } } });
  ok(partial.caps.reply === 2 && partial.caps.like === 20, 'the migration also full-shapes a partially stored subtree');

  // 8. And the migration is applied ON READ, through getConfig - on a config.json written by
  //    a build that predates engage, which is the only shape the migration exists for. A
  //    second process, because the config module caches nothing but the ROOT is read once.
  const WS2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-engage-mig-'));
  fs.writeFileSync(path.join(WS2, 'config.json'), JSON.stringify({ radar: { enabled: true, autoReply: { enabled: true, lanes: ['bluesky'] } } }));
  const { execFileSync } = await import('node:child_process');
  const probe = `
    const m = await import(${JSON.stringify(path.resolve('lib/config.mjs'))});
    const e = m.getConfig().posting.radar.engage;
    console.log(JSON.stringify({ mode: e.mode, lanes: Object.keys(e.lanes), dm: e.caps.dm, reply: e.caps.reply }));
    // The first write CRYSTALLISES it: what lands on disk is the migrated policy.
    m.setConfig({ ifRev: m.getConfig().rev, actor: 'owner', set: { posting: { radar: { engage: { paused: true } } } } });
    const after = m.getConfig().posting.radar.engage;
    console.log(JSON.stringify({ mode: after.mode, paused: after.paused, lanes: Object.keys(after.lanes) }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], { env: { ...process.env, PENDPOST_ROOT: WS2, PENDPOST_MODE: 'mock' }, encoding: 'utf8' });
  const lines = out.trim().split('\n');
  const seen = JSON.parse(lines[lines.length - 2]);
  const after = JSON.parse(lines[lines.length - 1]);
  ok(seen.mode === 'live' && seen.lanes.join() === 'bluesky', 'a legacy autoReply config presents as engage live through getConfig');
  ok(seen.dm === 0 && seen.reply === 10, 'with replies only - every other kind is capped at 0');
  ok(after.mode === 'live' && after.paused === true && after.lanes.join() === 'bluesky', 'and the first engage write crystallises the migrated policy on disk');
  fs.rmSync(WS2, { recursive: true, force: true });
} catch (err) {
  failures += 1;
  console.error('  FAIL - threw:', (err && err.stack) || err);
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
