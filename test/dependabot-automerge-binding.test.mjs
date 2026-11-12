#!/usr/bin/env node
// test/dependabot-automerge-binding.test.mjs - security audit 2026-11.
//
// The auto-merge workflow ships to the public mirror (ops/publish-oss.mjs mirrors .github). It used
// to pick the PR to merge with `gh pr list --head <branch>`, which also returns fork PRs with the
// same branch name, newest first, and to decide on the PR title alone. A stranger's fork PR could be
// squash-merged with the job's write token. This test pins the guards in the workflow text:
// private repo only, the PR number from the workflow_run (never a branch-name lookup), dependabot as
// author, same-repo head, the exact CI head SHA, and a merge bound to that SHA.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const wf = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'dependabot-auto-merge.yml'), 'utf8');
try {
  ok(/github\.repository == 'pendpost\/site'/.test(wf), 'the job only runs in the private source repo, never in the public mirror');
  ok(!/gh pr list[^\n]*--head/.test(wf), 'no PR lookup by branch name (it returns fork PRs too)');
  ok(/workflow_run\.pull_requests\[0\]\.number/.test(wf), 'the PR number comes from the workflow_run itself');
  ok(/\$author" != "dependabot\[bot\]"/.test(wf), 'the PR author must be dependabot');
  ok(/\$head_repo" != "\$REPO"/.test(wf), 'the PR head must be this repo, not a fork');
  ok(/\$head_sha" != "\$HEAD_SHA"/.test(wf), 'the PR head must be the exact SHA whose CI passed');
  ok(/gh pr merge[^\n]*--match-head-commit "\$HEAD_SHA"/.test(wf), 'the merge itself is bound to that SHA');
  console.log(`[dependabot-automerge-binding] OK - auto-merge is bound to dependabot's own PR at the CI head (${pass} assertions).`);
} catch (err) {
  console.error(`[dependabot-automerge-binding] FAIL: ${err.message}`);
  process.exitCode = 1;
}
