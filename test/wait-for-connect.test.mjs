#!/usr/bin/env node
// test/wait-for-connect.test.mjs - approve before connect: publishing WAITS for the lane.
//
// Owner decision 2 (2026-11-12): a new user approves a post before connecting anything. In
// live mode the scheduler used to fire the lane's engine anyway; with no credential it failed,
// recorded a credential failure and parked the post as "needs you". Now a lane with no stored
// credential is not dispatched at all: the post stays approved and due, records no attempt,
// no hold and no failure, and goes out on the first tick after the lane is connected.
// posting.waitForConnect:false restores the old fire-and-fail path.
//
// A fake engine (PENDPOST_TELEGRAM_ENGINE, the documented engine override) stands in for the
// real one and only records that it was spawned, so nothing ever reaches a network.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-wait-connect-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE; // LIVE
delete process.env.PENDPOST_DEV_READONLY;
delete process.env.TELEGRAM_BOT_TOKEN;

const MARK = path.join(WS, 'engine-spawned.log');
const FAKE = path.join(WS, 'fake-telegram-engine.mjs');
fs.writeFileSync(FAKE, `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(MARK)}, process.argv.slice(2).join(' ') + '\\n');\nconsole.log(JSON.stringify({ ok: true, results: [] }));\n`);
process.env.PENDPOST_TELEGRAM_ENGINE = FAKE;

fs.mkdirSync(path.join(WS, 'data', 'plans', 'launch'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'launch', path: 'data/plans/launch/post-plan.json', active: true }],
}, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'plans', 'launch', 'post-plan.json'), JSON.stringify({
  campaign: 'Launch', timezone: 'UTC',
  posts: [{
    id: 'hello', type: 'text', platforms: ['telegram'], scheduledAt: '2020-01-01T00:00:00Z',
    caption: 'Hello channel', status: 'planned', approval: 'approved', executionMode: 'fully-scheduled',
    createdBy: 'agent:claude', approvalBy: 'owner', approvalAt: '2026-11-01T10:00:00Z',
  }],
}, null, 2));

const { runDueExclusive } = await import('../lib/scheduler.mjs');
const readPost = () => JSON.parse(fs.readFileSync(path.join(WS, 'data', 'plans', 'launch', 'post-plan.json'), 'utf8')).posts[0];
const spawns = () => (fs.existsSync(MARK) ? fs.readFileSync(MARK, 'utf8').trim().split('\n').filter(Boolean).length : 0);

try {
  // ---- not connected: three ticks, no spawn, no attempt, no hold -----------------------
  for (let i = 0; i < 3; i += 1) await runDueExclusive('scheduler', {}); // eslint-disable-line no-await-in-loop
  ok(spawns() === 0, 'an approved due post on a lane with no credential never spawns its engine');
  const waiting = readPost();
  ok(waiting.approval === 'approved' && waiting.status === 'planned', 'the post stays approved and planned (it waits)');
  ok(!(waiting.attempts || []).length, 'no failed attempt is recorded (no retry storm, nothing to cap)');
  ok(!waiting.publishHold, 'no publish hold: the post is not parked as a failure');

  // ---- connected: the next tick dispatches it --------------------------------------------
  fs.writeFileSync(path.join(WS, '.env'), 'TELEGRAM_BOT_TOKEN=test-token\nTELEGRAM_CHANNEL_ID=@test\n', { mode: 0o600 });
  await runDueExclusive('scheduler', {});
  ok(spawns() === 1, 'once the lane is connected the next tick dispatches the engine');

  // ---- owner opt-out: fire-and-fail as before ------------------------------------------
  fs.rmSync(path.join(WS, '.env'));
  fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ waitForConnect: false }, null, 2));
  const before = spawns();
  await runDueExclusive('scheduler', {});
  ok(spawns() === before + 1, 'posting.waitForConnect:false dispatches the unconnected lane (old behaviour)');

  console.log(`\n# wait-for-connect: ${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
