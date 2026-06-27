#!/usr/bin/env node
// test/example-plan-freshness.test.mjs - A3 (US-ONB-03): the shipped Acme
// example campaign must not open a fresh checkout on a red "Overdue" alert.
//
// deriveState (lib/plans.mjs) classifies an approved, past-due post with a
// still-pending platform lane as 'overdue' (App.jsx overdueCount -> the
// Sidebar red alert). On the original seed the `teaser` post (scheduledAt
// 2026-06-13, approved, instagram lane pending) derives 'overdue' the moment
// real time passes its date. This test pins the example: with a plausible
// checkout date all three posts are still in the future, so NONE derive
// 'overdue', while >=1 draft + exactly 1 approved keep the approval-gate demo
// intact and every createdAt/approvalAt stays chronologically before its
// scheduledAt.
//
// CAVEAT (see A3 Risks): the example uses STATIC absolute dates, so it will
// re-stale once real time passes them again. This test therefore pins `now` to
// a FIXED absolute timestamp (NOT the runtime clock) so it cannot self-stale
// into a maintenance trap. The durable fix - relative-at-load seeding of the
// shipped example - touches lib/ runtime and is deferred out of this data-only
// item.
//
// Zero-dep node:assert, run as a plain script by `npm run check`. PENDPOST_ROOT
// is pinned to the repo root BEFORE importing lib (lib binds WORKSPACE_ROOT at
// import) so activeRoot() resolves the example's relative media/plan paths to
// the shipped files. We assert on the SHIPPED data/plans JSON read via fs, not a
// temp fixture - the point is to guard the example that actually ships.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// Repo root = parent of test/. Pin PENDPOST_ROOT here BEFORE importing lib so
// the legacy single-workspace activeRoot() fallback resolves the shipped files.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.PENDPOST_ROOT = REPO_ROOT;

const { normalizePost } = await import('../lib/plans.mjs');

// FIXED 'now' - a plausible first-checkout instant. Chosen deliberately AFTER
// the original teaser date (2026-06-13) so the test FAILS on HEAD before the
// reschedule (teaser overdue) and passes once every post is pushed past it.
// Hard-coded literal, never Date.now(), to avoid an evergreen self-staling test.
const NOW = Date.parse('2026-06-17T00:00:00Z');

const PLAN_PATH = path.join(REPO_ROOT, 'data', 'plans', 'acme-launch', 'post-plan.json');
const MANIFEST_PATH = path.join(REPO_ROOT, 'data', 'plans', 'active-plans.json');

const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const entry = manifest.plans.find((p) => p.id === 'acme-launch');

// normalizePost(planEntry, plan, post, now) -> { derivedState, approval, ... }.
const normalized = plan.posts.map((p) => normalizePost(entry || { id: 'acme-launch' }, plan, p, NOW));

try {
  // (0) the manifest still ships acme-launch as the single active demo campaign.
  ok(entry && entry.active === true, 'manifest keeps acme-launch active:true (single live demo)');

  // (1) ids + platforms unchanged (data-only date edit must not touch identity).
  const byId = Object.fromEntries(normalized.map((p) => [p.id, p]));
  ok(['welcome', 'launch-reel', 'teaser'].every((id) => byId[id]), 'post ids welcome, launch-reel, teaser all present');
  ok(JSON.stringify(byId.welcome.platforms) === JSON.stringify(['linkedin']), 'welcome platforms unchanged (linkedin)');
  ok(JSON.stringify(byId['launch-reel'].platforms) === JSON.stringify(['instagram', 'facebook']), 'launch-reel platforms unchanged (instagram, facebook)');
  ok(JSON.stringify(byId.teaser.platforms) === JSON.stringify(['instagram']), 'teaser platforms unchanged (instagram)');

  // (2) THE GUARD: with the pinned checkout date, NO post derives 'overdue'.
  // FAILS on HEAD - teaser (2026-06-13, approved, instagram pending) is overdue.
  const overdue = normalized.filter((p) => p.derivedState === 'overdue');
  ok(overdue.length === 0, `no post derives 'overdue' at the pinned checkout date (overdue: ${overdue.map((p) => p.id).join(', ') || 'none'})`);

  // (3) approval gate still demoable: >=1 draft AND exactly 1 approved.
  const drafts = plan.posts.filter((p) => p.approval === 'draft');
  const approved = plan.posts.filter((p) => p.approval === 'approved');
  ok(drafts.length >= 1, `at least one post stays a draft (drafts: ${drafts.map((p) => p.id).join(', ') || 'none'})`);
  ok(approved.length === 1, `exactly one post stays approved (approved: ${approved.map((p) => p.id).join(', ') || 'none'})`);

  // (4) the single approved post carries its approval provenance.
  const appr = approved[0];
  ok(appr && appr.approvalBy && appr.approvalAt, `the approved post carries approvalBy + approvalAt (${appr ? appr.id : 'none'})`);

  // (5) every timestamp stays chronologically before its post's scheduledAt.
  for (const p of plan.posts) {
    const sched = Date.parse(p.scheduledAt);
    assert.ok(!Number.isNaN(sched), `${p.id}: scheduledAt parseable`);
    ok(Date.parse(p.createdAt) < sched, `${p.id}: createdAt (${p.createdAt}) before scheduledAt (${p.scheduledAt})`);
    if (p.approvalAt) {
      ok(Date.parse(p.approvalAt) < sched, `${p.id}: approvalAt (${p.approvalAt}) before scheduledAt (${p.scheduledAt})`);
    }
  }

  // (6) and every post's scheduledAt is in the FUTURE of the pinned checkout
  // date - the structural reason none can be overdue on first run.
  for (const p of normalized) {
    ok(Date.parse(p.scheduledAt) > NOW, `${p.id}: scheduledAt (${p.scheduledAt}) is future of the pinned checkout date`);
  }

  console.log(`[example-plan-freshness] OK - shipped Acme example opens with no Overdue alert; gate demo (>=1 draft + 1 approved) and timestamp ordering preserved (${pass} assertions).`);
} catch (err) {
  console.error(`[example-plan-freshness] FAIL - ${err.message}`);
  throw err;
}
