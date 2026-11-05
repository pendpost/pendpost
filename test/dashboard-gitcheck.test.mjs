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

const { gitCheck, apply } = await import('../scripts/dashboard-build.mjs');
const { readUpdateStatus, headSha } = await import('../lib/dashboard.mjs');

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

  // an untracked file (a backup tarball) does NOT dirty the tree; an edit to a
  // tracked file does. (The status above was written into A and committed by
  // writeCommit's `git add .`, so settle it and keep this status outside A.)
  g(['commit', '-qam', 'settle status'], A);
  const sA = path.join(ROOT, 'statusA');
  fs.writeFileSync(path.join(A, 'backup.tgz'), 'untracked');
  gitCheck({ repo: A, statusDir: sA, fetch: false });
  ok(readUpdateStatus(sA).clean === true, 'untracked file -> still clean');
  fs.appendFileSync(path.join(A, 'g.txt'), 'edited');
  gitCheck({ repo: A, statusDir: sA, fetch: false });
  ok(readUpdateStatus(sA).clean === false, 'edited tracked file -> clean:false');

  // headSha reads .git directly and must agree with git itself.
  ok(headSha(A) === g(['rev-parse', 'HEAD'], A), 'headSha matches git rev-parse HEAD (loose ref)');
  g(['pack-refs', '--all'], A);
  ok(headSha(A) === g(['rev-parse', 'HEAD'], A), 'headSha matches git rev-parse HEAD (packed ref)');

  // apply(): a fresh clone D, upstream one commit ahead. The status file lives
  // outside D (in the real repo data/ is gitignored) so it never dirties the tree.
  const D = path.join(ROOT, 'D');
  g(['clone', remote, D], ROOT);
  const E = path.join(ROOT, 'E');
  g(['clone', remote, E], ROOT);
  writeCommit(E, 'n.txt', 'new', 'upstream');
  g(['push'], E);
  const appDir = path.join(ROOT, 'app');
  fs.mkdirSync(path.join(appDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'dist', 'index.html'), '<html></html>'); // no inputs -> not stale, no vite
  const statusDir = path.join(ROOT, 'status');

  const tracked = g(['ls-files'], D).split('\n')[0];
  const original = fs.readFileSync(path.join(D, tracked), 'utf8');
  fs.appendFileSync(path.join(D, tracked), 'uncommitted');
  let r = await apply({ pull: true, repo: D, appDir, statusDir });
  ok(r.ok === false && r.step === 'check' && r.reason === 'dirty-tree', 'apply refuses an edited tracked file before pulling');
  ok(!fs.existsSync(path.join(D, 'n.txt')), 'dirty refusal pulled nothing');
  fs.writeFileSync(path.join(D, tracked), original);
  // the real-world case: a stray untracked backup must not block the update
  fs.writeFileSync(path.join(D, 'backup.tgz'), 'untracked');

  g(['fetch'], D);
  r = await apply({ pull: true, repo: D, appDir, statusDir });
  ok(r.ok === true && r.step === 'done', 'clean + fast-forwardable -> apply ok');
  ok(fs.existsSync(path.join(D, 'n.txt')), 'apply fast-forwarded the upstream commit');
  ok(fs.existsSync(path.join(D, 'backup.tgz')), 'the untracked backup is left in place');
  ok(readUpdateStatus(statusDir).ahead === 0, 'apply refreshed the status: nothing left ahead');

  writeCommit(D, 'local.txt', 'mine', 'local only');
  writeCommit(E, 'n2.txt', 'newer', 'upstream 2');
  g(['push'], E);
  g(['fetch'], D);
  const before = g(['rev-parse', 'HEAD'], D);
  r = await apply({ pull: true, repo: D, appDir, statusDir });
  ok(r.ok === false && r.step === 'pull', 'diverged -> ff-only pull fails, reported as the pull step');
  ok(g(['rev-parse', 'HEAD'], D) === before, 'a failed pull leaves local history untouched');

  // a non-git directory -> git:false, never offers an update
  const plain = path.join(ROOT, 'plain');
  fs.mkdirSync(plain);
  gitCheck({ repo: plain, statusDir: plain, fetch: false });
  ok(readUpdateStatus(plain).git === false, 'non-git dir -> git:false');

  console.log(`[dashboard-gitcheck] OK - real git ahead/diverged/clean/branch semantics (${pass} assertions).`);
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}
