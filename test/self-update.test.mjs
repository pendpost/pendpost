#!/usr/bin/env node
// test/self-update.test.mjs - the one-click update state machine (lib/self-update.mjs):
// offer when HEAD moved since boot or upstream is ahead, apply via the script, then
// restart ONLY when idle and supervised. Every side effect is injected, so no git,
// child process or exit is real here.
import assert from 'node:assert';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const { createUpdater, parseApplyResult, parseProgressLine, RESTART_EXIT_CODE } = await import('../lib/self-update.mjs');

const status = (over = {}) => ({ git: true, ahead: 0, branch: 'develop', clean: true, diverged: false, ...over });

function harness(over = {}) {
  const calls = { apply: [], exits: [] };
  const timers = [];
  let applyDone = null;
  let applyStep = null;
  let busy = null;
  const u = createUpdater({
    readStatus: () => status(over.status),
    head: () => over.head ?? 'new',
    bootHead: over.bootHead ?? 'old',
    runningVersion: '2.9.0',
    diskVersion: () => over.diskVersion ?? '2.9.0',
    blocked: () => Boolean(over.blocked),
    supervised: () => over.supervised ?? true,
    busyWith: () => busy,
    runApply: (pull, done, onStep) => { calls.apply.push(pull); applyDone = done; applyStep = onStep; },
    exit: (code) => calls.exits.push(code),
    schedule: (fn) => { timers.push(fn); },
    now: () => '2026-10-29T12:00:00.000Z',
  });
  // One round: a tick that re-schedules itself while busy runs again on the next flush.
  const flush = () => { for (const fn of timers.splice(0)) fn(); };
  return { u, calls, finish: (r) => applyDone(r), step: (s) => applyStep(s), setBusy: (b) => { busy = b; }, flush };
}

try {
  // --- offer ---------------------------------------------------------------
  let h = harness({ head: 'old', bootHead: 'old' });
  ok(h.u.health().available === false && h.u.health().reason === 'up-to-date', 'same HEAD as boot, nothing upstream -> no offer');

  h = harness();
  let hl = h.u.health();
  ok(hl.available && hl.canApply && hl.id === 'new', 'HEAD moved since boot -> offered, the id is the commit on offer (dismissal is per commit)');
  ok(hl.running.version === '2.9.0' && hl.running.commit === 'old', 'names what runs: package version + boot commit');
  ok(hl.target.version === '2.9.0' && hl.target.commit === 'new', 'names what it would start: disk version + HEAD');

  h = harness({ diskVersion: '2.10.0' });
  ok(h.u.health().target.version === '2.10.0', 'a version bump on disk shows as the new version');

  h = harness({ head: 'old', status: { ahead: 3, upstreamSha: 'up', upstreamVersion: '3.0.0' } });
  hl = h.u.health();
  ok(hl.target.commit === 'up' && hl.target.version === '3.0.0' && hl.id === 'up', 'upstream ahead -> offers the upstream commit and version');

  // A stale status file (still "ahead") whose upstream commit is already running.
  h = harness({ head: 'old', status: { ahead: 2, upstreamSha: 'old' } });
  hl = h.u.health();
  ok(hl.available === false && hl.target === null && hl.reason === 'up-to-date', 'never offers the commit this process already runs');
  ok(h.u.request().body.started === false && h.calls.apply.length === 0, 'and a POST for it spawns nothing');
  h = harness({ head: 'new', status: { ahead: 2, upstreamSha: 'new' } });
  ok(h.u.health().target.commit === 'new' && h.calls.apply.length === 0, 'upstream commit already pulled by hand -> offered as a restart, not a pull');
  h.u.request();
  ok(h.calls.apply[0] === false, 'and applied WITHOUT --pull');

  h = harness({ blocked: true });
  ok(h.u.health().available === false, 'read-only dev / mock instance never offers');
  ok(h.u.request().status === 409, 'read-only dev / mock instance refuses the POST');

  h = harness({ head: 'old', status: { ahead: 2, clean: false } });
  ok(h.u.request().status === 400 && h.calls.apply.length === 0, 'upstream ahead on a dirty tree -> refused, nothing spawned');

  // --- happy path: apply, wait for idle, restart ----------------------------
  h = harness({ head: 'old', status: { ahead: 2 } });
  let r = h.u.request();
  ok(r.body.started === true && h.calls.apply[0] === true, 'upstream ahead + clean -> apply spawned WITH --pull');
  ok(h.u.health().state === 'downloading', 'state is downloading while the pull runs');
  h.step('installing');
  ok(h.u.health().state === 'installing', 'the script reports installing -> state follows');
  h.step('downloading');
  ok(h.u.health().state === 'installing', 'progress never moves backwards');
  ok(h.u.request().body.started === false && h.calls.apply.length === 1, 'a second click while applying spawns nothing');

  h.setBusy('agent');
  h.finish({ ok: true, step: 'done' });
  hl = h.u.health();
  ok(hl.state === 'waiting' && hl.waitingFor === 'agent' && h.calls.exits.length === 0, 'applied while an agent job runs -> waits, no restart');
  h.setBusy('publishing');
  h.flush();
  ok(h.u.health().waitingFor === 'publishing' && h.calls.exits.length === 0, 'still waiting while a publish is in flight');
  h.setBusy(null);
  h.flush(); // idle tick schedules the exit a beat later
  ok(h.u.health().state === 'restarting' && h.calls.exits.length === 0, 'idle -> state restarting, a beat before the exit');
  h.flush();
  ok(h.calls.exits[0] === RESTART_EXIT_CODE, 'idle -> exits non-zero so launchd restarts the new code');

  // local-only change: no pull
  h = harness();
  h.u.request();
  ok(h.calls.apply[0] === false && h.u.health().state === 'installing', 'HEAD moved since boot -> apply WITHOUT --pull, straight to installing');

  // --- failure -------------------------------------------------------------
  h = harness();
  h.u.request();
  h.finish({ ok: false, step: 'build', reason: 'build-failed' });
  hl = h.u.health();
  ok(hl.state === null && hl.lastRun.ok === false && hl.lastRun.step === 'build' && h.calls.exits.length === 0,
    'build failed -> no restart, the failing step is reported');
  ok(hl.lastRun.target === 'new', 'the failure names the commit it tried to install');
  ok(hl.available === true, 'after a failure the update is still on offer (Try again)');
  h.u.request();
  ok(h.u.health().lastRun === null && h.calls.apply.length === 2, 'retry clears the old failure and spawns again');

  // --- unsupervised --------------------------------------------------------
  h = harness({ supervised: false });
  h.u.request();
  h.finish({ ok: true, step: 'done' });
  hl = h.u.health();
  ok(hl.state === 'manual' && hl.available === false && h.calls.exits.length === 0, 'not under launchd -> asks for a manual restart, never exits');

  // --- apply result parsing ------------------------------------------------
  ok(parseApplyResult('vite log\n{"ok":false,"step":"pull","reason":"pull-failed"}\n', true).step === 'pull', 'parses the last JSON line');
  ok(parseApplyResult('Segmentation fault', true).ok === false, 'no JSON + non-zero exit -> failed');
  ok(parseApplyResult('', false).ok === true, 'no JSON + zero exit -> ok');
  ok(parseApplyResult('{"progress":"installing"}', true).ok === false, 'a trailing progress line is not a result');
  ok(parseProgressLine('{"progress":"downloading"}') === 'downloading', 'parses a progress line');
  ok(parseProgressLine('vite v7 building') === null && parseProgressLine('{"progress":"rm -rf"}') === null, 'ignores anything that is not a known step');

  console.log(`[self-update] OK - offer, apply, idle wait, restart, failure (${pass} assertions).`);
} catch (err) {
  console.error('FAIL:', err.message);
  process.exit(1);
}
