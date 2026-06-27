#!/usr/bin/env node
// test/meta-lane-set.test.mjs - C1: per-client Meta cadence + lane-pause WRITE.
//
// setMetaLane({ cadence, paused, reason, actor }) atomically READ-MERGE-WRITES
// the WHOLE data/plans/meta-lane.json under activeRoot() inside withPlanLock, so
// cadence and paused/reason CO-EXIST (a naive whole-file overwrite would drop the
// sibling key). The validator enforces the anti-ban FLOOR (maxPer24h>=1 integer,
// minGapMinutes>=0 integer), paused boolean, reason string|null, requireActor.
// It NEVER reads/writes post.approval, and paused:false NEVER clears a recorded
// Meta-368 (isMetaBlocked stays independent). It stays shape-compatible with the
// scheduler's loadMetaCadence reader and the meta-social.mjs metaLaneState reader.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib
// (util binds WORKSPACE_ROOT at import; model: test/account-mode.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-lane-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.META_PUBLISHING_PAUSED;
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });

const { setMetaLane } = await import('../lib/writes.mjs');
const { recordMetaBlock } = await import('../lib/accounts.mjs');
const { loadState, isMetaBlocked } = await import('../lib/state.mjs');
const { getActivity } = await import('../lib/scheduler.mjs');
const { activeRoot } = await import('../lib/context.mjs');

const lanePath = () => path.join(activeRoot(), 'data', 'plans', 'meta-lane.json');
const readLane = () => JSON.parse(fs.readFileSync(lanePath(), 'utf8'));

try {
  // ---- 1. creates meta-lane.json with cadence ------------------------------
  const r1 = await setMetaLane({ cadence: { maxPer24h: 3, minGapMinutes: 120 }, actor: 'owner' });
  ok(r1 && r1.ok === true, 'setMetaLane with cadence returns ok:true');
  const after1 = readLane();
  ok(after1.cadence && after1.cadence.maxPer24h === 3 && after1.cadence.minGapMinutes === 120,
    'meta-lane.json created with the cadence {maxPer24h:3, minGapMinutes:120}');

  // The scheduler reader (loadMetaCadence is not exported; assert the on-disk
  // shape it parses: { cadence: { maxPer24h, minGapMinutes } }).
  ok(Number.isInteger(after1.cadence.maxPer24h) && Number.isInteger(after1.cadence.minGapMinutes),
    'cadence integers persist as integers (scheduler loadMetaCadence-compatible)');

  // ---- 2. pause-only call PRESERVES cadence (read-merge-write) --------------
  const r2 = await setMetaLane({ paused: true, reason: 'page under review', actor: 'owner' });
  ok(r2 && r2.ok === true, 'pause-only setMetaLane returns ok:true');
  const after2 = readLane();
  ok(after2.paused === true && after2.reason === 'page under review', 'pause + reason written');
  ok(after2.cadence && after2.cadence.maxPer24h === 3 && after2.cadence.minGapMinutes === 120,
    'cadence PRESERVED across a pause-only write (read-merge-write, not whole-file overwrite)');
  ok(typeof after2.paused === 'boolean' && (after2.reason === null || typeof after2.reason === 'string'),
    'paused boolean + reason string|null shape stays metaLaneState-compatible');

  // ---- 3. paused:false does NOT clear a recorded Meta-368 ------------------
  const blk = recordMetaBlock({ blockedUntil: new Date(Date.now() + 24 * 3600 * 1000).toISOString(), reason: '368', source: 'meta-social.mjs', actor: 'engine' });
  ok(blk.ok === true && isMetaBlocked(loadState()) === true, 'a Meta-368 block is recorded (isMetaBlocked true)');
  const r3 = await setMetaLane({ paused: false, actor: 'owner' });
  ok(r3 && r3.ok === true, 'resume (paused:false) returns ok:true');
  ok(readLane().paused === false, 'lane resumed (paused:false on disk)');
  ok(isMetaBlocked(loadState()) === true, 'resuming the lane does NOT clear the recorded Meta-368 (breaker independent)');

  // ---- 4. cadence FLOOR + type validation: each rejects + writes nothing ---
  const before = readLane();
  const beforeStr = JSON.stringify(before);
  const expectReject = async (args, label) => {
    const r = await setMetaLane({ ...args });
    ok(r && r.ok !== true && r.code === 'invalid_input', `${label} -> invalid_input`);
    ok(JSON.stringify(readLane()) === beforeStr, `${label} writes nothing`);
  };
  await expectReject({ cadence: { maxPer24h: 0, minGapMinutes: 60 }, actor: 'owner' }, 'maxPer24h:0 (cap can never be disabled)');
  await expectReject({ cadence: { maxPer24h: 3, minGapMinutes: -1 }, actor: 'owner' }, 'minGapMinutes:-1');
  await expectReject({ cadence: { maxPer24h: 2.5, minGapMinutes: 60 }, actor: 'owner' }, 'non-integer maxPer24h');
  await expectReject({ cadence: { maxPer24h: 3, minGapMinutes: 1.5 }, actor: 'owner' }, 'non-integer minGapMinutes');
  await expectReject({ paused: 'yes', actor: 'owner' }, 'paused non-boolean');
  await expectReject({ reason: 42, paused: true, actor: 'owner' }, 'reason non-string');

  // ---- 5. missing/unknown actor -> invalid_input, writes nothing ----------
  await expectReject({ paused: true }, 'missing actor');
  await expectReject({ paused: true, actor: 'unknown' }, "actor 'unknown'");
  await expectReject({ paused: true, actor: '   ' }, 'blank actor');

  // ---- 6. exactly one 'meta-lane-set' activity entry per successful write --
  const laneSets = getActivity(200).filter((e) => e.action === 'meta-lane-set');
  ok(laneSets.length === 3, `exactly one meta-lane-set activity per successful write (3 successes => ${laneSets.length})`);
  const last = laneSets[0];
  ok(last.platform === 'meta' && last.ok === true && last.actor === 'owner',
    "meta-lane-set entry is {platform:'meta', ok:true, actor}");

  // ---- 7. never reads/writes a post.approval field ------------------------
  ok(!JSON.stringify(readLane()).includes('approval'), 'meta-lane.json never carries an approval field');

  console.log(`[meta-lane-set] OK - cadence floor + lane pause WRITE, read-merge-write, 368-independent (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
