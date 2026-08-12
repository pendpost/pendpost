#!/usr/bin/env node
// test/autonomy-ledger.test.mjs - the autonomy ledger's two engine seams (ux-audit
// 2026-08-04 R7):
//   - AU5 dry-run (autoApproveDryRun): replay the deterministic autoApproveDecision
//     over the owner's recent authored drafts, so a rung is enabled against evidence.
//   - AU4 revoke-that-unwinds (revokeAutoApprovals): a filtered setApproval sweep that
//     returns not-yet-published policy approvals to review. Owner-gated; de-escalation
//     only. Plus the parity both-faces check (MCP tool + REST route reach the engine fn).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const CLEAN = 'a quiet behind the scenes clip';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-autonomy-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));

const { AUTO_APPROVE_ACTOR } = await import('../lib/auto-approve.mjs');
const { createCampaign, createPost, approvePost, autoApproveDryRun, autonomyStatus, revokeAutoApprovals } = await import('../lib/writes.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');

const CAMP = 'acme';
const getPost = (id) => (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []).find((p) => p.id === id);
let clock = Date.parse('2026-08-01T00:00:00Z');
const draftReel = (id, caption = CLEAN, platforms = ['instagram']) => {
  clock += 60_000; // monotonic createdAt so "recent" ordering is deterministic
  return createPost({
    campaign: CAMP,
    post: { id, type: 'reel', platforms, scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption, createdAt: new Date(clock).toISOString() },
    actor: 'agent:claude',
  });
};

try {
  await createCampaign({ id: CAMP, note: 'autonomy ledger', timezone: 'UTC', actor: 'owner' });

  // ============ AU5: dry-run over recent authored drafts ============
  // Three authored planner drafts, none auto-approved yet (policy still off).
  await draftReel('d-ig-1', CLEAN, ['instagram']);
  await draftReel('d-ig-2', CLEAN, ['instagram']);
  await draftReel('d-li-1', CLEAN, ['linkedin']);

  // No scope yet (default empty platforms) -> the fail-closed B5 behaviour, made legible:
  // an enabled preview with zero trusted platforms matches NOTHING.
  const dry0 = autoApproveDryRun({ limit: 20 });
  ok(dry0.ok && dry0.total === 3, 'dry-run counts the 3 authored drafts as the denominator');
  ok(dry0.matched === 0, 'empty scope matches 0 of 3 (fail-closed empty platforms, B5 made legible)');

  // Owner trusts instagram -> the preview matches the 2 instagram drafts, not the linkedin one.
  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { autoApprove: { platforms: ['instagram'] } } } });
  const dry1 = autoApproveDryRun({ limit: 20 });
  ok(dry1.matched === 2 && dry1.total === 3, 'instagram scope would match 2 of the last 3 drafts (the linkedin one stays out of scope)');

  // The dry-run forces enabled:true, so it previews BEFORE the toggle is flipped on
  // (the policy is still disabled here).
  ok(getConfig().posting.autoApprove.enabled === false, 'the policy is still OFF - the dry-run previewed without enabling anything');

  // The limit caps the denominator to the most-recent N.
  const dryCap = autoApproveDryRun({ limit: 2 });
  ok(dryCap.total === 2 && dryCap.limit === 2, 'limit caps the denominator to the last N drafts');

  // autonomyStatus rolls up the dry-run + the revocable count (0 so far).
  const st0 = autonomyStatus({ limit: 20 });
  ok(st0.ok && st0.dryRun.matched === 2 && st0.revocable === 0, 'autonomyStatus surfaces { dryRun, revocable } - nothing live to revoke yet');

  // ============ AU4: revoke-that-unwinds ============
  // Enable the policy for instagram, then create two in-scope drafts that DO auto-approve,
  // plus one linkedin draft that stays manual.
  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { autoApprove: { enabled: true, platforms: ['instagram'], requireLintClean: true } } } });
  const a1 = await draftReel('a-ig-1', CLEAN, ['instagram']);
  const a2 = await draftReel('a-ig-2', CLEAN, ['instagram']);
  ok(a1.autoApproved === true && a2.autoApproved === true, 'two in-scope drafts auto-approve under the enabled policy');
  const m1 = await draftReel('m-li-1', CLEAN, ['linkedin']);
  ok(m1.autoApproved !== true && getPost('m-li-1').approval === 'draft', 'the out-of-scope draft stays a manual draft');

  // A manually owner-approved post must NEVER be swept (it is not a policy approval).
  await approvePost({ campaign: CAMP, postId: 'm-li-1', actor: 'owner' });
  ok(getPost('m-li-1').approval === 'approved' && getPost('m-li-1').approvalBy === 'owner', 'the owner manually approves the linkedin post (approvalBy owner, not the policy)');

  // Publish ONE of the auto-approved posts so it is off the table for the sweep.
  await runDueExclusive('scheduler', { campaign: CAMP, postId: 'a-ig-1' });
  ok(getPost('a-ig-1').derivedState === 'posted', 'a-ig-1 is published (posted) - the sweep must not touch it');

  const before = autonomyStatus({ limit: 50 });
  ok(before.revocable === 1, 'exactly 1 live policy approval remains to revoke (a-ig-2; a-ig-1 posted, m-li-1 is owner-approved)');

  // Owner-only gate: an agent cannot revoke.
  const denied = await revokeAutoApprovals({ actor: 'agent:claude' });
  ok(denied.code === 'invalid_input' && /owner/i.test(denied.message || denied.error || ''), 'an agent cannot revoke auto-approvals (owner-only gate)');
  ok(getPost('a-ig-2').approval === 'approved', 'the refused agent revoke changed nothing');

  // Owner revokes: the one live policy approval returns to review; the posted + the
  // owner-approved posts are untouched.
  const swept = await revokeAutoApprovals({ actor: 'owner' });
  ok(swept.ok && swept.reverted === 1, 'the owner revoke returns exactly 1 post to review');
  ok(getPost('a-ig-2').approval === 'draft' && getPost('a-ig-2').approvalBy == null, 'a-ig-2 is back to a pending draft (approval + approvalBy cleared)');
  ok(getPost('a-ig-1').derivedState === 'posted', 'the published post is untouched (never returned to review)');
  ok(getPost('m-li-1').approval === 'approved' && getPost('m-li-1').approvalBy === 'owner', 'the owner-approved post is untouched (only POLICY approvals are swept)');

  // Idempotent: a second sweep finds nothing.
  const again = await revokeAutoApprovals({ actor: 'owner' });
  ok(again.ok && again.reverted === 0, 'a second revoke is a clean no-op (idempotent)');
  ok(autonomyStatus({ limit: 50 }).revocable === 0, 'autonomyStatus now reports 0 revocable');

  // ============ parity: both faces reach the same engine verb ============
  const { TOOLS } = await import('../lib/mcp.mjs');
  ok(TOOLS.some((tl) => tl.name === 'autonomy_revoke'), 'the MCP face exists: an autonomy_revoke tool is registered');
  const apiSrc = fs.readFileSync(new URL('../lib/api.mjs', import.meta.url), 'utf8');
  ok(/mcpTool:\s*'autonomy_revoke'/.test(apiSrc), 'the REST face exists: a route names mcpTool autonomy_revoke');
  ok(/path:\s*'\/api\/autonomy',\s*mcpTool:\s*null/.test(apiSrc), 'the ledger read GET /api/autonomy is a UI-facing read (mcpTool null)');

  console.log(`[autonomy-ledger] OK - dry-run replay (empty=0, scoped match, forced-enabled preview, limit), owner-gated revoke sweep (policy-only, posted-safe, idempotent), MCP+REST parity (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
