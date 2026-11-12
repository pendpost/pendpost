#!/usr/bin/env node
// test/self-update-quiet.test.mjs - the quiet local update (lib/self-update.mjs).
// When only local commits moved and the package version did not change, the server
// applies on its own once HEAD has been stable for a quiet period and nothing is in
// flight, then restarts as usual; health() marks the offer `quiet` so the Studio shows
// no toast. A new version (pull or a version bump on disk), a read-only/mock instance,
// an unsupervised process and PENDPOST_QUIET_UPDATES=0 keep today's explicit offer.
// Clock, scheduler, apply and exit are injected: no git, child process or exit is real.
import assert from 'node:assert';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const { createUpdater, RESTART_EXIT_CODE, QUIET_MS } = await import('../lib/self-update.mjs');

const MIN = 60_000;
const status = (over = {}) => ({ git: true, ahead: 0, branch: 'develop', clean: true, diverged: false, ...over });

function harness(over = {}) {
  const calls = { apply: [], exits: [] };
  const timers = [];
  let applyDone = null;
  let busy = null;
  let t = 0;
  let head = over.head ?? 'new';
  const opts = {
    readStatus: () => status(over.status),
    head: () => head,
    bootHead: 'old',
    runningVersion: '2.10.0',
    diskVersion: () => ('diskVersion' in over ? over.diskVersion : '2.10.0'),
    blocked: () => Boolean(over.blocked),
    supervised: () => over.supervised ?? true,
    busyWith: () => busy,
    runApply: (pull, done) => { calls.apply.push(pull); applyDone = done; },
    exit: (code) => calls.exits.push(code),
    schedule: (fn, ms) => { timers.push({ fn, ms }); },
    now: () => '2026-11-01T12:00:00.000Z',
    clock: () => t,
    quietMs: 10 * MIN,
  };
  if ('quietEnabled' in over) opts.quietEnabled = over.quietEnabled;
  const u = createUpdater(opts);
  const flush = () => { for (const { fn } of timers.splice(0)) fn(); };
  return {
    u, calls, timers, flush,
    at: (min) => { t = min * MIN; },
    setHead: (h) => { head = h; },
    setBusy: (b) => { busy = b; },
    finish: (r) => applyDone(r),
  };
}

try {
  ok(QUIET_MS === 10 * MIN, 'the default quiet period is 10 minutes');

  // --- the decision --------------------------------------------------------
  let h = harness();
  let hl = h.u.health();
  ok(hl.quiet === true && hl.available === true, 'only local commits, same version -> a quiet offer (the SPA shows no toast)');

  h = harness({ diskVersion: '2.11.0' });
  ok(h.u.health().quiet === false && h.u.health().available === true, 'a version change on disk -> the explicit offer, not quiet');

  h = harness({ head: 'old', status: { ahead: 2, upstreamSha: 'up', upstreamVersion: '2.10.0' } });
  ok(h.u.health().quiet === false && h.u.health().available === true, 'a pull from upstream -> the explicit offer, even with the same version');

  h = harness({ diskVersion: null });
  ok(h.u.health().quiet === false, 'an unreadable disk version is never treated as unchanged');

  h = harness({ head: 'old' });
  ok(h.u.health().quiet === false && h.u.health().available === false, 'nothing moved -> neither offered nor quiet');

  h = harness({ blocked: true });
  ok(h.u.health().quiet === false, 'a read-only dev / mock instance is never quiet');

  h = harness({ supervised: false });
  ok(h.u.health().quiet === false && h.u.health().available === true, 'an unsupervised process keeps the explicit offer (it cannot restart itself)');

  h = harness({ quietEnabled: () => false });
  ok(h.u.health().quiet === false && h.u.health().available === true, 'switched off -> the explicit offer as before');

  const saved = process.env.PENDPOST_QUIET_UPDATES;
  process.env.PENDPOST_QUIET_UPDATES = '0';
  h = harness();
  ok(h.u.health().quiet === false, 'PENDPOST_QUIET_UPDATES=0 switches the quiet update off');
  process.env.PENDPOST_QUIET_UPDATES = '1';
  h = harness();
  ok(h.u.health().quiet === true, 'any other value leaves it on');
  if (saved === undefined) delete process.env.PENDPOST_QUIET_UPDATES; else process.env.PENDPOST_QUIET_UPDATES = saved;

  // --- the debounce --------------------------------------------------------
  h = harness();
  h.at(0); h.u.quietTick();
  h.at(9); h.u.quietTick();
  ok(h.calls.apply.length === 0, 'HEAD stable for less than the quiet period -> nothing applied yet');
  h.setHead('newer'); // another merge lands
  h.at(12); h.u.quietTick();
  h.at(21); h.u.quietTick();
  ok(h.calls.apply.length === 0, 'a new merge restarts the quiet period');
  h.at(22); h.u.quietTick();
  ok(h.calls.apply.length === 1 && h.calls.apply[0] === false, 'HEAD stable for 10 minutes -> applied once, WITHOUT --pull');
  hl = h.u.health();
  ok(hl.state === 'installing' && hl.quiet === true, 'the state walks as today and stays marked quiet');
  h.at(30); h.u.quietTick();
  ok(h.calls.apply.length === 1, 'no second apply while one runs');
  h.finish({ ok: true, step: 'done' });
  ok(h.u.health().state === 'restarting' && h.u.health().quiet === true, 'applied and idle -> restarting, still quiet');
  h.flush();
  ok(h.calls.exits[0] === RESTART_EXIT_CODE, 'then the existing restart (exit for launchd)');

  // --- idle only -----------------------------------------------------------
  h = harness();
  h.at(0); h.u.quietTick();
  h.setBusy('publishing');
  h.at(11); h.u.quietTick();
  ok(h.calls.apply.length === 0, 'a publish run in flight -> the quiet apply waits');
  h.setBusy('agent');
  h.at(12); h.u.quietTick();
  ok(h.calls.apply.length === 0, 'an agent job in flight -> the quiet apply waits');
  h.setBusy(null);
  h.at(13); h.u.quietTick();
  ok(h.calls.apply.length === 1, 'idle again -> applied');
  h.setBusy('agent');
  h.finish({ ok: true, step: 'done' });
  ok(h.u.health().state === 'waiting' && h.calls.exits.length === 0, 'an agent job started meanwhile -> the existing idle wait before the restart');

  // --- open edits: the quiet apply waits for them, silently -----------------
  h = harness({ status: { clean: false } });
  h.at(0); h.u.quietTick();
  h.at(10); h.u.quietTick();
  ok(h.calls.apply.length === 1, 'a dirty tree does not stop a quiet apply from starting');
  h.finish({ ok: false, step: 'check', reason: 'dirty-tree', dirty: ['lib/x.mjs'] });
  hl = h.u.health();
  ok(hl.state === 'waiting' && hl.waitingFor === 'edits' && hl.quiet === true && hl.lastRun === null, 'open edits -> a quiet wait, no failure the Studio could show');
  h.flush();
  ok(h.calls.apply.length === 2, 'it looks again a minute later, without waiting for a new commit');
  h.finish({ ok: true, step: 'done' });
  h.flush();
  ok(h.calls.exits[0] === RESTART_EXIT_CODE, 'clean now -> applied and restarted');

  // --- a failed apply (build) waits for the next HEAD change -----------------
  h = harness();
  h.at(0); h.u.quietTick();
  h.at(10); h.u.quietTick();
  h.finish({ ok: false, step: 'build', reason: 'build-failed' });
  hl = h.u.health();
  ok(hl.state === null && hl.lastRun.ok === false && hl.lastRun.quiet === true && hl.quiet === true, 'build failed -> nothing restarts, the failure is marked quiet');
  h.at(20); h.u.quietTick();
  h.at(60); h.u.quietTick();
  ok(h.calls.apply.length === 1, 'no retry for the same HEAD (no spam)');
  h.setHead('newer');
  h.at(61); h.u.quietTick();
  h.at(70); h.u.quietTick();
  ok(h.calls.apply.length === 1, 'the next HEAD settles first');
  h.at(71); h.u.quietTick();
  ok(h.calls.apply.length === 2, 'then it is tried once more');

  // --- never quiet-applies -------------------------------------------------
  for (const [label, over] of [
    ['a version change on disk', { diskVersion: '2.11.0' }],
    ['a pull from upstream', { head: 'old', status: { ahead: 2, upstreamSha: 'up', upstreamVersion: '2.10.0' } }],
    ['a read-only dev / mock instance', { blocked: true }],
    ['an unsupervised process', { supervised: false }],
    ['the switch set to off', { quietEnabled: () => false }],
  ]) {
    h = harness(over);
    for (const m of [0, 11, 30, 120]) { h.at(m); h.u.quietTick(); }
    ok(h.calls.apply.length === 0, `${label} -> never applied quietly`);
  }

  // An owner click on a quiet-eligible offer is a normal apply, not a quiet one.
  h = harness();
  h.u.request();
  ok(h.u.health().state === 'installing' && h.u.health().quiet === false, 'an owner-started apply shows its progress (not quiet)');

  // --- the loop ------------------------------------------------------------
  h = harness();
  h.u.start();
  h.u.start();
  ok(h.timers.length === 1, 'start() schedules one loop, and only once');
  h.at(0); h.flush();
  h.at(11); h.flush();
  ok(h.calls.apply.length === 1 && h.timers.length === 1, 'the loop ticks on its own and keeps itself scheduled');

  h = harness({ blocked: true });
  h.u.start();
  ok(h.timers.length === 0, 'a read-only dev / mock instance never starts the loop');

  console.log(`[self-update-quiet] OK - decision, debounce, idle, refusal, switches, loop (${pass} assertions).`);
} catch (err) {
  console.error('FAIL:', err.message);
  process.exit(1);
}
