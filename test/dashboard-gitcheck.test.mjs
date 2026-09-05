#!/usr/bin/env node
// test/dashboard-gitcheck.test.mjs - exercises gitCheck() against a REAL temp git
// repo + bare remote, so the ahead / diverged / clean / branch computation (the
// riskiest, network-touching part of the updater) is validated end-to-end rather
// than only by the pure updateDecision rule. No real remote / network involved.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const { gitCheck } = await import('../scripts/dashboard-build.mjs');
const { readUpdateStatus } = await import('../lib/dashboard.mjs');

// Scrub the git env that git exports to hooks (GIT_DIR/GIT_WORK_TREE/
// GIT_INDEX_FILE/GIT_PREFIX/GIT_COMMON_DIR). When this test runs under the
// pre-push hook (via ops/engine-check.mjs) those pin every child git to the
// REAL site repo, so `cwd` is ignored: the temp-repo commands here — AND the
// git that gitCheck() shells out to — hit the site repo instead of the tmp
// repos, red-blocking every guarded push. Deleting them from this process's
// env makes both the g() helper and gitCheck() resolve the repo from `cwd`,
// in-hook and standalone alike. Safe: this is a throwaway test process.
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR']) delete process.env[k];

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-gc-'));
// Per-repo identity + no signing, so the test never depends on global git config.
const ID = ['-c', 'user.email=t@e', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];
const g = (args, cwd) => execFileSync('git', [...ID, ...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const writeCommit = (repo, file, body, msg) => { fs.writeFileSync(path.join(repo, file), body); g(['add', '.'], repo); g(['commit', '-m', msg], repo); };

try {
  // bare remote + a clone (A) with an initial pushed commit -> A is up to date.
  const remote = path.join(ROOT, 'remote.git');
  g(['init', '--bare', '-b', 'main', remote], ROOT);
  const A = path.join(ROOT, 'A');
  g(['clone', remote, A], ROOT);
  writeCommit(A, 'f.txt', '1', 'c1');
  g(['push', '-u', 'origin', 'main'], A);

  // up to date: no upstream commits, clean tree, on main
  gitCheck({ repo: A, statusDir: A, fetch: true });
  let st = readUpdateStatus(A);
  ok(st.git === true, 'real repo -> git:true');
  ok(st.branch === 'main', 'reports the current branch');
  ok(st.ahead === 0 && st.diverged === false, 'up to date -> ahead 0, not diverged');
  ok(st.clean === true, 'committed tree -> clean');

  // a second clone pushes a commit -> A is now BEHIND by one (fast-forwardable)
  const B = path.join(ROOT, 'B');
  g(['clone', remote, B], ROOT);
  writeCommit(B, 'f.txt', '2', 'c2');
  g(['push'], B);
  gitCheck({ repo: A, statusDir: A, fetch: true });
  st = readUpdateStatus(A);
  ok(st.ahead === 1 && st.diverged === false, 'upstream ahead by 1, clean ff -> ahead 1, not diverged');

  // a LOCAL-only commit in A while upstream is ahead -> DIVERGED (no fast-forward)
  writeCommit(A, 'g.txt', 'x', 'c3-local');
  gitCheck({ repo: A, statusDir: A, fetch: false });
  st = readUpdateStatus(A);
  ok(st.ahead === 1 && st.diverged === true, 'local commit + upstream ahead -> diverged');

  // an untracked file -> tree no longer clean
  fs.writeFileSync(path.join(A, 'dirty.txt'), 'uncommitted');
  gitCheck({ repo: A, statusDir: A, fetch: false });
  ok(readUpdateStatus(A).clean === false, 'untracked file -> clean:false');

  // a non-git directory -> git:false, never offers an update
  const plain = path.join(ROOT, 'plain');
  fs.mkdirSync(plain);
  gitCheck({ repo: plain, statusDir: plain, fetch: false });
  ok(readUpdateStatus(plain).git === false, 'non-git dir -> git:false');

  console.log(`[dashboard-gitcheck] OK - real git ahead/diverged/clean/branch semantics (${pass} assertions).`);
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}
