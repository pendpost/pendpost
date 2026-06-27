#!/usr/bin/env node
// test/auto-approve.test.mjs - the opt-in, owner-configured auto-approve policy.
//
// Two layers:
//   1. The PURE decision (lib/auto-approve.mjs): enabled + scope + the optional
//      brand-lint gate. brandLint reads no disk for a (text, platform) pair, so
//      the decision is deterministic and unit-testable here.
//   2. The full AUTONOMOUS LOOP in mock mode: with the policy enabled, an agent
//      draft is auto-approved (by the distinct policy actor, never the agent
//      itself) and the scheduler publishes it with no human approve call. Plus
//      the owner-only enablement gate, the killer safety control.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const CLEAN = 'a quiet behind the scenes clip';
const DIRTY = 'watch the demo https:// today'; // bare scheme -> broken-link (error severity)

// A throwaway workspace, set BEFORE importing lib (util freezes WORKSPACE_ROOT
// from PENDPOST_ROOT at load), so the test never touches the shipped seed.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-autoapprove-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));

const { autoApproveDecision, inAutoApproveScope, AUTO_APPROVE_ACTOR } = await import('../lib/auto-approve.mjs');
const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');

const CAMP = 'acme';
const getPost = (id) => (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []).find((p) => p.id === id);
const draftReel = (id, caption, platforms = ['instagram']) => createPost({
  campaign: CAMP,
  post: { id, type: 'reel', platforms, scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption },
  actor: 'agent:claude',
});

try {
  // ============ layer 1: pure decision ============
  ok(AUTO_APPROVE_ACTOR === 'policy:auto-approve', 'the policy actor is a distinct, reserved string');
  ok(AUTO_APPROVE_ACTOR !== 'owner', 'the policy actor is NOT owner (so it is never the exempt self-approver)');

  const reel = { type: 'reel', platforms: ['instagram'], caption: CLEAN };
  ok(autoApproveDecision(reel, { enabled: false }, 'acme').approve === false, 'disabled policy never auto-approves');
  ok(autoApproveDecision(reel, null, 'acme').approve === false, 'missing policy never auto-approves');
  ok(autoApproveDecision(reel, { enabled: true }, 'acme').approve === true, 'enabled + empty scope + clean caption auto-approves');
  ok(autoApproveDecision(reel, { enabled: true, platforms: ['linkedin'] }, 'acme').approve === false, 'a post on an untrusted platform stays manual');
  ok(autoApproveDecision({ ...reel, platforms: ['instagram', 'facebook'] }, { enabled: true, platforms: ['instagram'] }, 'acme').approve === false, 'auto-approved only if ALL platforms are trusted (subset rule)');
  ok(autoApproveDecision(reel, { enabled: true, platforms: ['instagram', 'facebook'] }, 'acme').approve === true, 'a subset of the trusted platforms auto-approves');
  ok(autoApproveDecision(reel, { enabled: true, types: ['text'] }, 'acme').approve === false, 'a type outside the policy types stays manual');
  ok(autoApproveDecision(reel, { enabled: true, types: ['reel'] }, 'acme').approve === true, 'a type inside the policy types auto-approves');
  ok(autoApproveDecision(reel, { enabled: true, campaigns: ['other'] }, 'acme').approve === false, 'a campaign outside the policy stays manual');
  ok(autoApproveDecision(reel, { enabled: true, campaigns: ['acme'] }, 'acme').approve === true, 'a campaign inside the policy auto-approves');
  ok(autoApproveDecision({ ...reel, caption: DIRTY }, { enabled: true, requireLintClean: true }, 'acme').approve === false, 'requireLintClean blocks an error-severity caption');
  ok(autoApproveDecision({ ...reel, caption: DIRTY }, { enabled: true, requireLintClean: false }, 'acme').approve === true, 'requireLintClean off lets a lint-failing caption auto-approve');
  ok(inAutoApproveScope(reel, { enabled: true }, 'acme').match === true, 'inAutoApproveScope is the pure scope half');

  // ============ layer 2: config gate + autonomous loop ============
  await createCampaign({ id: CAMP, note: 'auto-approve loop', timezone: 'UTC', actor: 'owner' });

  // owner-only enablement gate: an AGENT cannot turn autonomy on.
  const rev0 = getConfig().rev;
  const denied = setConfig({ ifRev: rev0, actor: 'agent:claude', set: { posting: { autoApprove: { enabled: true } } } });
  ok(denied.code === 'invalid_input', 'an agent cannot enable the auto-approve policy (owner-only gate)');
  ok(/owner/i.test(denied.error || denied.message || ''), 'the refusal explains autonomy is owner-authorized');
  ok(getConfig().posting.autoApprove.enabled === false, 'the policy is unchanged after the refused agent write (still fail-closed)');

  // owner enables it, scoped to instagram, lint-clean required.
  const owned = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { autoApprove: { enabled: true, platforms: ['instagram'], requireLintClean: true } } } });
  ok(owned.ok && owned.posting.autoApprove.enabled === true, 'the owner can enable the auto-approve policy');

  // the autonomous loop: agent drafts -> policy auto-approves -> scheduler publishes, no human click.
  const created = await draftReel('reel-auto', CLEAN);
  ok(created.ok && created.autoApproved === true, 'an in-scope agent draft is auto-approved at creation');
  ok(getPost('reel-auto').approval === 'approved', 'the auto-approved post is in the approved state');
  ok(getPost('reel-auto').approvalBy === AUTO_APPROVE_ACTOR, 'approval is recorded under the policy actor, NOT the agent (no self-approval)');
  ok(getPost('reel-auto').createdBy === 'agent:claude' && getPost('reel-auto').createdBy !== getPost('reel-auto').approvalBy, 'creator and approver are distinct actors');

  await runDueExclusive('scheduler', { campaign: CAMP, postId: 'reel-auto' });
  ok(Boolean(getPost('reel-auto').ids.igMediaId), 'the scheduler published the auto-approved post with NO human approve call');

  // requireLintClean: a lint-failing caption is NOT auto-approved (stays a visible draft).
  const dirty = await draftReel('reel-dirty', DIRTY);
  ok(dirty.ok && dirty.autoApproved !== true, 'a lint-failing draft is not auto-approved');
  ok(getPost('reel-dirty').approval === 'draft', 'the lint-failing post stays a draft for the owner to fix');

  // scope: a post on an untrusted platform stays manual.
  const off = await draftReel('reel-li', CLEAN, ['linkedin']);
  ok(off.ok && off.autoApproved !== true && getPost('reel-li').approval === 'draft', 'an out-of-scope (untrusted platform) draft stays manual');

  // disabling the policy restores pure fail-closed: a new draft is NOT auto-approved.
  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { autoApprove: { enabled: false } } } });
  const afterOff = await draftReel('reel-off', CLEAN);
  ok(afterOff.autoApproved !== true && getPost('reel-off').approval === 'draft', 'with the policy disabled, drafts stay drafts (fail-closed default intact)');

  // the bedrock invariant still holds: the agent cannot directly approve its own draft.
  const self = await approvePost({ campaign: CAMP, postId: 'reel-off', actor: 'agent:claude' });
  ok(self.code === 'invalid_input', 'the drafting agent still cannot approve its own post (no-self-approval intact)');

  console.log(`[auto-approve] OK - pure decision + owner-gate + autonomous loop in mock mode (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
