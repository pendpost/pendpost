#!/usr/bin/env node
// test/shipped-workspace-empty.test.mjs - pendpost ships no campaign.
//
// Up to 2.13.0 an example "Acme Launch" campaign shipped in data/plans and
// data/clients/default/data/plans, and one of its Instagram posts was already
// approved with a past date. A fresh install that connected a real Instagram
// account could have published it without anyone approving it. The owner chose
// to remove the example (2026-11-12). This test keeps it out: both shipped
// manifests list no plan, no campaign folder ships, and no plan file anywhere
// under data/ carries an approved post.
//
// Zero-dep node:assert, run as a plain script by `npm run check`.
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Read what git tracks (the index), never the working tree: a developer's own
// workspace under data/ holds real campaigns and is not what ships.
const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });
const tracked = git('ls-files', '-z', 'data').split('\0').filter(Boolean);

for (const rel of ['data/plans', 'data/clients/default/data/plans']) {
  const manifest = JSON.parse(git('show', `:${rel}/active-plans.json`));
  ok(Array.isArray(manifest.plans) && manifest.plans.length === 0, `${rel}/active-plans.json lists no plan`);
  const inside = tracked.filter((f) => f.startsWith(`${rel}/`) && f.slice(rel.length + 1).includes('/'));
  ok(inside.length === 0, `${rel} ships no campaign folder (found: ${inside.join(', ') || 'none'})`);
}

const plans = tracked.filter((f) => f.endsWith('post-plan.json'));
ok(plans.length === 0, `no post-plan.json is tracked under data/ (found: ${plans.join(', ') || 'none'})`);

console.log(`\n[shipped-workspace-empty] OK - ${pass} assertions.`);
