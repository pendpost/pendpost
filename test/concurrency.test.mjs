#!/usr/bin/env node
// test/concurrency.test.mjs - WP-1 acceptance: concurrent plan writers never
// lose each other's update.
//
// Exercises lib/planWrite.mjs (pendpost's lock-respecting
// writer) against a CROSS-PROCESS competitor on a tmpdir fixture:
//   1. Writer A holds the lock (async hold, 600ms) and writes engine-style
//      fields; writer B (a spawned child process) edits the caption through
//      the same lock protocol. Both edits must land.
//   2. A stale lock dir (>15 min old) is stolen, not deadlocked on.
//   3. The lock dir is removed after each writer.
// The three engine siblings duplicate the same mkdir-lock + field-merge
// protocol (scripts/*-social.mjs, verbatim block); their live behavior is
// covered by --dry-run runs and the per-phase reviews.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withPlanLock, mutatePlan } from '../lib/planWrite.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-wp1-'));
const planPath = path.join(tmpDir, 'post-plan.json');
const planWriteUrl = new URL('../lib/planWrite.mjs', import.meta.url).href;

function writeFixture() {
  fs.writeFileSync(planPath, `${JSON.stringify({
    campaign: 'wp1-fixture',
    posts: [{ id: 'p1', caption: 'original', status: 'planned', platforms: ['instagram'] }],
  }, null, 2)}\n`);
}

function readPlan() {
  return JSON.parse(fs.readFileSync(planPath, 'utf8'));
}

// A lock-respecting caption edit in a SEPARATE process (what pendpost's
// composer / an agent session does while an engine is mid-save).
function childCaptionEdit(caption) {
  return new Promise((resolve, reject) => {
    const code = `
      const { mutatePlan } = await import(${JSON.stringify(planWriteUrl)});
      await mutatePlan(${JSON.stringify(planPath)}, (plan) => {
        plan.posts[0].caption = ${JSON.stringify(caption)};
      });
      console.log('child-done');
    `;
    execFile('node', ['--input-type=module', '-e', code], { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`child failed: ${stderr || err.message}`));
      else resolve(stdout.trim());
    });
  });
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL - ${name}: ${err.message}`);
  }
}

// --- 1. concurrent cross-process writers, no lost update -------------------
writeFixture();
const childPromise = (async () => {
  await new Promise((r) => setTimeout(r, 150)); // let the parent take the lock first
  return childCaptionEdit('edited-by-child');
})();
await withPlanLock(planPath, async () => {
  // Engine-style critical section: re-read, merge own fields, hold, write.
  const plan = readPlan();
  plan.posts[0].status = 'posted';
  plan.posts[0].attempts = [{ ok: true, actor: 'wp1-test' }];
  await new Promise((r) => setTimeout(r, 600)); // child must WAIT, not clobber
  const tmp = `${planPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(plan, null, 2)}\n`);
  fs.renameSync(tmp, planPath);
});
await childPromise;

const merged = readPlan();
check('engine-style field write landed', () => assert.equal(merged.posts[0].status, 'posted'));
check('attempts write landed', () => assert.equal(merged.posts[0].attempts?.[0]?.actor, 'wp1-test'));
check('concurrent caption edit landed (no lost update)', () => assert.equal(merged.posts[0].caption, 'edited-by-child'));
check('lock released', () => assert.ok(!fs.existsSync(`${planPath}.lock.d`)));

// --- 2. a held lock makes the second writer WAIT (serialization order) -----
writeFixture();
const order = [];
await Promise.all([
  withPlanLock(planPath, async () => {
    order.push('A-in');
    await new Promise((r) => setTimeout(r, 300));
    order.push('A-out');
  }),
  (async () => {
    await new Promise((r) => setTimeout(r, 50));
    await mutatePlan(planPath, (plan) => {
      plan.posts[0].caption = 'B';
    });
    order.push('B-done');
  })(),
]);
check('second writer waited for the lock', () => assert.deepEqual(order, ['A-in', 'A-out', 'B-done']));
check('waiting writer applied after release', () => assert.equal(readPlan().posts[0].caption, 'B'));

// --- 3. stale lock (>15 min) is stolen ---------------------------------------
writeFixture();
const staleLock = `${planPath}.lock.d`;
fs.mkdirSync(staleLock);
const past = new Date(Date.now() - 16 * 60 * 1000);
fs.utimesSync(staleLock, past, past);
await mutatePlan(planPath, (plan) => {
  plan.posts[0].caption = 'after-steal';
});
check('stale lock stolen, write went through', () => assert.equal(readPlan().posts[0].caption, 'after-steal'));
check('stolen lock released', () => assert.ok(!fs.existsSync(staleLock)));

fs.rmSync(tmpDir, { recursive: true, force: true });
if (failures) {
  console.error(`[wp1] FAIL - ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('[wp1] OK - no lost updates under concurrent writers.');
