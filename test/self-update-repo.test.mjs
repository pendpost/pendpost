#!/usr/bin/env node
// test/self-update-repo.test.mjs - the one-click update against a REAL temp git repo
// (bare remote + clone), wiring the real gitCheck/apply (scripts/dashboard-build.mjs)
// and the real status reader into createUpdater (lib/self-update.mjs). Proves:
//   - the offer names what is running and what is on offer (version + commit);
//   - the offer NEVER points at the commit this process already runs, even when the
//     periodic status file is stale (a hand-run `git pull` before a restart);
//   - a successful apply reports its steps in order and leaves nothing on offer once
//     the server has restarted into the new commit.
// Nothing here touches the real checkout, the daemon or the network.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

// Same hook-env scrub as dashboard-gitcheck.test.mjs: under the pre-push hook these pin
// every child git to the real repo.
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR']) delete process.env[k];

const { gitCheck, apply } = await import('../scripts/dashboard-build.mjs');
const { readUpdateStatus, headSha, readPackageVersion } = await import('../lib/dashboard.mjs');
const { createUpdater } = await import('../lib/self-update.mjs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-su-'));
const ID = ['-c', 'user.email=t@e', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];
const g = (args, cwd) => execFileSync('git', [...ID, ...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const writeCommit = (repo, file, body, msg) => { fs.writeFileSync(path.join(repo, file), body); g(['add', '.'], repo); g(['commit', '-m', msg], repo); };
const pkg = (version) => `${JSON.stringify({ name: 'pendpost', version }, null, 2)}\n`;

// An updater wired to repo A exactly like the live one is wired to REPO_ROOT, with the
// boot commit pinned (a restart = a new updater with the then-current HEAD).
function updaterFor(repo, bootHead, over = {}) {
  return createUpdater({
    readStatus: () => readUpdateStatus(repo),
    head: () => headSha(repo),
    bootHead,
    runningVersion: over.runningVersion ?? readPackageVersion(repo),
    diskVersion: () => readPackageVersion(repo),
    blocked: () => false,
    supervised: () => true,
    busyWith: () => null,
    runApply: over.runApply || ((pull, done) => done({ ok: true, step: 'done' })),
    exit: over.exit || (() => {}),
    schedule: (fn) => { fn(); },
  });
}

try {
  const remote = path.join(ROOT, 'remote.git');
  g(['init', '--bare', '-b', 'main', remote], ROOT);
  const A = path.join(ROOT, 'A');
  g(['clone', remote, A], ROOT);
  fs.writeFileSync(path.join(A, '.gitignore'), '.dashboard-update.json\napp/\n');
  writeCommit(A, 'package.json', pkg('2.9.0'), 'c1');
  g(['push', '-u', 'origin', 'main'], A);
  const B = path.join(ROOT, 'B');
  g(['clone', remote, B], ROOT);

  // --- up to date: nothing on offer --------------------------------------
  gitCheck({ repo: A, statusDir: A, fetch: true });
  const boot1 = headSha(A);
  let h = updaterFor(A, boot1).health();
  ok(h.available === false, 'same commit as upstream and as boot -> nothing on offer');
  ok(h.running.version === '2.9.0' && h.running.commit === boot1, 'reports what is running: package version + boot commit');

  // --- upstream ahead with a version bump: names both versions ------------
  writeCommit(B, 'package.json', pkg('2.10.0'), 'bump');
  g(['push'], B);
  const upstream = headSha(B);
  gitCheck({ repo: A, statusDir: A, fetch: true });
  const st = readUpdateStatus(A);
  ok(st.upstreamSha === upstream && st.upstreamVersion === '2.10.0', 'git-check records the upstream commit and its package version');
  h = updaterFor(A, boot1).health();
  ok(h.available === true && h.canApply === true, 'upstream ahead -> offered');
  ok(h.target.commit === upstream && h.target.version === '2.10.0', 'the offer names the version and commit it would install');
  ok(h.id === upstream, 'the offer id is the commit on offer (dismissal is per commit)');

  // --- ROOT CAUSE repro: stale status after a hand-run pull + restart -------
  // The status file still says "1 ahead", but HEAD already IS that commit and the
  // restarted server runs it. The old predicate offered an update to the running commit.
  g(['pull', '--ff-only'], A);
  const boot2 = headSha(A);
  ok(readUpdateStatus(A).ahead === 1, 'precondition: the status file is stale (still says 1 ahead)');
  h = updaterFor(A, boot2).health();
  ok(h.available === false, 'never offers the commit this process already runs, even on a stale status file');

  // --- HEAD moved since boot (commits landed on disk): offers the disk commit
  writeCommit(A, 'f.txt', 'local', 'local work');
  g(['push'], A);
  gitCheck({ repo: A, statusDir: A, fetch: true });
  h = updaterFor(A, boot2).health();
  ok(h.available === true && h.target.commit === headSha(A) && h.target.version === '2.10.0', 'HEAD moved since boot -> offers the commit on disk, with its version');

  // --- a real apply: steps in order, then nothing on offer after restart ----
  writeCommit(B, 'g.txt', 'x', 'more');
  g(['pull', '--rebase'], B);
  g(['push'], B);
  gitCheck({ repo: A, statusDir: A, fetch: true });
  // An app dir whose bundle is current, so apply skips the vite build.
  const appDir = path.join(A, 'app');
  fs.mkdirSync(path.join(appDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'dist', 'index.html'), '<html></html>');
  const steps = [];
  const r = await apply({ pull: true, repo: A, appDir, statusDir: A, onStep: (s) => steps.push(s) });
  ok(r.ok === true, `apply pulls and finishes (${r.reason || 'ok'})`);
  ok(steps.join(',') === 'downloading,installing', 'apply reports its steps in order: downloading, installing');
  ok(headSha(A) === headSha(B), 'the checkout is now at the upstream commit');
  h = updaterFor(A, headSha(A)).health();
  ok(h.available === false && h.running.commit === headSha(B), 'after the restart into the new commit nothing is on offer');

  // --- npm lockfile drift is not an edit: apply restores it and carries on ---
  writeCommit(A, 'package-lock.json', '{"lockfileVersion":3,"libc":["glibc"]}\n', 'lock');
  g(['push'], A);
  fs.writeFileSync(path.join(A, 'package-lock.json'), '{"lockfileVersion":3}\n');
  gitCheck({ repo: A, statusDir: A, fetch: false });
  ok(readUpdateStatus(A).clean === true, 'a lockfile-only drift counts as a clean tree');
  const r2 = await apply({ pull: false, repo: A, appDir, statusDir: A });
  ok(r2.ok === true, `lockfile drift does not block the apply (${r2.reason || 'ok'})`);
  ok(fs.readFileSync(path.join(A, 'package-lock.json'), 'utf8').includes('libc'), 'and the committed lockfile is restored');

  // --- a real edit blocks, and names the file ---------------------------------
  fs.writeFileSync(path.join(A, 'f.txt'), 'work in progress');
  fs.writeFileSync(path.join(A, 'package-lock.json'), '{}\n');
  gitCheck({ repo: A, statusDir: A, fetch: false });
  ok(readUpdateStatus(A).clean === false, 'an edited tracked file counts as dirty');
  const r3 = await apply({ pull: false, repo: A, appDir, statusDir: A });
  ok(r3.ok === false && r3.reason === 'dirty-tree' && r3.dirty.join(',') === 'f.txt', 'apply refuses and names only the real edit, not the lockfile');
  ok(fs.readFileSync(path.join(A, 'f.txt'), 'utf8') === 'work in progress', 'the edit is untouched');

  console.log(`[self-update-repo] OK - versions, running-commit guard, apply steps (${pass} assertions).`);
} catch (err) {
  console.error('FAIL:', err.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}
