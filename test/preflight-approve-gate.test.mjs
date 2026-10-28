#!/usr/bin/env node
// test/preflight-approve-gate.test.mjs - the enforced pre-flight gate at APPROVE time.
//
// Until now platform_validate computed a per-lane {ready, problems[]} verdict that
// nothing in the approve->publish path read: a post whose caption is over the platform
// cap approved cleanly and only failed (silently) at the scheduled fire. This gate makes
// setApproval refuse a post that carries a CONTENT-INTEGRITY blocker on any targeted lane
// (the platform WILL reject it), surfacing the reason at approve time. The owner can pass
// force:true to approve anyway (the publish fence is the fail-closed backstop). A lane that
// is merely NOT CONNECTED (needsSetup) is environment state, not a content fault, and must
// NOT block approval - laneBlockers excludes it.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-preflight-approve-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
// Connect the X lane so its needsSetup does NOT mask the over-cap content blocker under
// test (accountStatus reads these from the active client's .env). Telegram is left
// UNCONNECTED on purpose so the setup-only case has a genuinely needsSetup lane.
fs.writeFileSync(path.join(WS, '.env'), 'X_CLIENT_ID=id\nX_CLIENT_SECRET=secret\nX_REFRESH_TOKEN=tok\nX_HANDLE=pendpost\nMASTODON_INSTANCE_URL=https://masto.example\nMASTODON_ACCESS_TOKEN=tok\n', { mode: 0o600 });

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');

const CAMP = 'acme';
const getPost = (id) => (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []).find((p) => p.id === id);
const OVER_X = 'a'.repeat(300); // > 280, no URLs/lint tells -> a pure caption-cap blocker

try {
  await createCampaign({ id: CAMP, note: 'preflight gate', timezone: 'UTC', actor: 'owner' });

  // ---- 1. a CONTENT blocker (X over 280) refuses approval, naming the lane ----------
  await createPost({
    campaign: CAMP,
    post: { id: 'over', type: 'text', platforms: ['x'], scheduledAt: '2020-01-01T00:00:00Z', caption: OVER_X },
    actor: 'agent:claude',
  });
  const refused = await approvePost({ campaign: CAMP, postId: 'over', actor: 'owner' });
  ok(refused.ok !== true, 'approve is REFUSED for an over-cap X caption (not the old silent pass)');
  ok(refused.code === 'not_ready', 'the refusal code is not_ready');
  ok(Array.isArray(refused.blocked) && refused.blocked.some((b) => b.platform === 'x'),
    'the refusal names the x lane in blocked[]');
  ok(getPost('over').approval !== 'approved', 'the post stays unapproved after the refusal');
  // Round-2 contract: each blocked lane carries problemCodes 1:1 with problems, so the
  // Studio can render its localized sentence and pick the recovery (fix: edit|setup|wait).
  const xb = refused.blocked.find((b) => b.platform === 'x');
  ok(Array.isArray(xb.problemCodes) && xb.problemCodes.length === xb.problems.length && xb.problemCodes.every((c) => c && c.code && c.fix),
    `not_ready blocked[] carries problemCodes with code + fix (got ${JSON.stringify(xb)})`);
  ok(xb.problemCodes.some((c) => c.code === 'validate.xTooLong' && c.fix === 'edit'), 'the over-cap X caption is coded xTooLong, fixed in the editor');

  // ---- 2. force:true overrides a content blocker ------------------------------------
  // Issue #40: the X 280 cap is ALSO a brand-lint error (caption-hard-cap), and force never
  // overrides brand-lint (owner decision 2026-10-28) - the publish fence would drop that
  // lane anyway. So the override is proven on a Mastodon body over its 500 cap, which is a
  // pre-flight blocker but only a lint warning.
  const forcedX = await approvePost({ campaign: CAMP, postId: 'over', actor: 'owner', force: true });
  ok(forcedX.code === 'lint_blocked', 'force:true does NOT push an over-280 X caption through (brand-lint error, issue #40)');
  await createPost({
    campaign: CAMP,
    post: { id: 'overm', type: 'text', platforms: ['mastodon'], scheduledAt: '2020-01-01T00:00:00Z', caption: 'b'.repeat(600) },
    actor: 'agent:claude',
  });
  const refusedM = await approvePost({ campaign: CAMP, postId: 'overm', actor: 'owner' });
  ok(refusedM.code === 'not_ready' && refusedM.blocked.some((b) => b.platform === 'mastodon'), 'an over-cap Mastodon body is refused as not_ready');
  const forced = await approvePost({ campaign: CAMP, postId: 'overm', actor: 'owner', force: true });
  ok(forced.ok === true, 'force:true approves the over-cap post (owner override)');
  ok(getPost('overm').approval === 'approved', 'the forced post is now approved');

  // ---- 3. a setup-only lane (Telegram, unconnected) does NOT block approval ----------
  await createPost({
    campaign: CAMP,
    post: { id: 'setup', type: 'text', platforms: ['telegram'], scheduledAt: '2020-01-01T00:00:00Z', caption: 'a short, valid message' },
    actor: 'agent:claude',
  });
  const setupAppr = await approvePost({ campaign: CAMP, postId: 'setup', actor: 'owner' });
  ok(setupAppr.ok === true, 'a post on an unconnected (needsSetup) lane approves cleanly - setup is not a content fault');
  ok(getPost('setup').approval === 'approved', 'the setup-only post is approved');

  // ---- 4. a clean, connected post approves normally (no false positive) --------------
  await createPost({
    campaign: CAMP,
    post: { id: 'clean', type: 'text', platforms: ['x'], scheduledAt: '2020-01-01T00:00:00Z', caption: 'short and within cap' },
    actor: 'agent:claude',
  });
  const cleanAppr = await approvePost({ campaign: CAMP, postId: 'clean', actor: 'owner' });
  ok(cleanAppr.ok === true, 'a within-cap X post approves without force');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
