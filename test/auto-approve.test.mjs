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
const { createCampaign, createPost, approvePost, queueRadarReply } = await import('../lib/writes.mjs');
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
  ok(autoApproveDecision(reel, { enabled: true, platforms: ['linkedin'] }, 'acme').approve === false, 'a post on an untrusted platform stays manual');
  ok(autoApproveDecision({ ...reel, platforms: ['instagram', 'facebook'] }, { enabled: true, platforms: ['instagram'] }, 'acme').approve === false, 'auto-approved only if ALL platforms are trusted (subset rule)');
  ok(autoApproveDecision(reel, { enabled: true, platforms: ['instagram', 'facebook'] }, 'acme').approve === true, 'a subset of the trusted platforms auto-approves');
  ok(autoApproveDecision(reel, { enabled: true, platforms: ['instagram'], types: ['text'] }, 'acme').approve === false, 'a type outside the policy types stays manual');
  ok(autoApproveDecision(reel, { enabled: true, platforms: ['instagram'], types: ['reel'] }, 'acme').approve === true, 'a type inside the policy types auto-approves');
  ok(autoApproveDecision(reel, { enabled: true, platforms: ['instagram'], campaigns: ['other'] }, 'acme').approve === false, 'a campaign outside the policy stays manual');
  ok(autoApproveDecision(reel, { enabled: true, platforms: ['instagram'], campaigns: ['acme'] }, 'acme').approve === true, 'a campaign inside the policy auto-approves');
  ok(autoApproveDecision({ ...reel, caption: DIRTY }, { enabled: true, platforms: ['instagram'], requireLintClean: true }, 'acme').approve === false, 'requireLintClean blocks an error-severity caption');
  ok(autoApproveDecision({ ...reel, caption: DIRTY }, { enabled: true, platforms: ['instagram'], requireLintClean: false }, 'acme').approve === true, 'requireLintClean off lets a lint-failing caption auto-approve');
  ok(inAutoApproveScope(reel, { enabled: true, platforms: ['instagram'] }, 'acme').match === true, 'inAutoApproveScope is the pure scope half');

  // ============ layer 1a: EMPTY platforms = approves NOTHING (ux-audit 2026-08-04 P1) ============
  // The platforms axis is FAIL-CLOSED: an enabled policy with zero trusted platforms is
  // inert. Before this fix an empty list meant match-ALL, silently granting maximum scope
  // the moment the toggle went on, while the Settings hint claimed the opposite. Both
  // autonomy policies now agree that empty = off (the sibling radar.autoReply already
  // treated lanes:[] as nothing-fires).
  ok(autoApproveDecision(reel, { enabled: true }, 'acme').approve === false, 'enabled + EMPTY platforms auto-approves NOTHING (empty = off, fail-closed)');
  const emptyScope = inAutoApproveScope(reel, { enabled: true, platforms: [] }, 'acme');
  ok(emptyScope.match === false && emptyScope.reason === 'no platforms trusted', 'the legacy enabled+platforms:[] shape (previously match-all) fails closed with a legible reason');
  ok(autoApproveDecision(reel, { enabled: true, campaigns: ['acme'], types: ['reel'], requireLintClean: false }, 'acme').approve === false, 'matching campaigns/types cannot rescue an empty platforms list (a trusted platform is required)');
  // campaigns/types keep their empty-list = no-constraint semantics, UNCHANGED.
  ok(autoApproveDecision(reel, { enabled: true, platforms: ['instagram'], campaigns: [], types: [] }, 'acme').approve === true, 'empty campaigns/types still mean no constraint on those axes (unchanged)');

  // ============ layer 1b: a Radar reply NEVER auto-approves (spec 34 SAFETY invariant) ============
  // The one hard guarantee: a post carrying radarReplyTo can never be auto-approved under
  // ANY policy shape - it is a FIELD exclusion, so no enabled/scope/lint combination matches.
  const radarReply = { type: 'text', platforms: ['reddit'], caption: CLEAN, radarReplyTo: { url: 'https://reddit.com/r/x/comments/abc', source: 'reddit', externalId: 't3_abc' } };
  const POLICY_SHAPES = [
    ['enabled + empty platforms (matches nothing since the P1 fix)', { enabled: true }],
    ['enabled + matching platform', { enabled: true, platforms: ['reddit'] }],
    ['enabled + matching campaign', { enabled: true, campaigns: ['acme'] }],
    ['enabled + matching type text', { enabled: true, types: ['text'] }],
    ['enabled + lint off', { enabled: true, requireLintClean: false }],
    ['enabled + EVERY axis matching', { enabled: true, platforms: ['reddit'], campaigns: ['acme'], types: ['text'], requireLintClean: false }],
    ['disabled', { enabled: false }],
    ['null policy', null],
  ];
  for (const [label, policy] of POLICY_SHAPES) {
    ok(autoApproveDecision(radarReply, policy, 'acme').approve === false, `Radar reply is NEVER auto-approved (${label})`);
    const scope = inAutoApproveScope(radarReply, policy, 'acme');
    ok(scope.match === false && scope.reason === 'radar_reply_human_only', `inAutoApproveScope refuses a Radar reply with radar_reply_human_only, before any policy check (${label})`);
  }
  // Control: an x text post WITHOUT radarReplyTo DOES auto-approve under a matching policy -
  // proving the radarReplyTo FIELD (not the type) is the discriminator. (x is a NON-manual
  // lane; reddit is now excluded by MANUAL_LANES below, so the control moved off reddit.)
  const plainX = { type: 'text', platforms: ['x'], caption: CLEAN };
  ok(autoApproveDecision(plainX, { enabled: true, platforms: ['x'] }, 'acme').approve === true, 'an x text post WITHOUT radarReplyTo auto-approves (radarReplyTo is the discriminator)');
  ok(autoApproveDecision({ ...plainX, radarReplyTo: { url: 'https://x.com/x', source: 'x', externalId: '1' } }, { enabled: true, platforms: ['x'] }, 'acme').approve === false, 'the SAME x post WITH radarReplyTo does not auto-approve');
  // Also on bluesky/mastodon (the other reply-capable sources).
  ok(autoApproveDecision({ ...radarReply, platforms: ['bluesky'], radarReplyTo: { url: 'https://bsky.app/x', source: 'bluesky', externalId: 'at://x' } }, { enabled: true }, 'acme').approve === false, 'a bluesky Radar reply is never auto-approved');
  ok(autoApproveDecision({ ...radarReply, platforms: ['mastodon'], radarReplyTo: { url: 'https://m.example/x', source: 'mastodon', externalId: '123' } }, { enabled: true }, 'acme').approve === false, 'a mastodon Radar reply is never auto-approved');

  // ============ layer 1c: a MANUAL-LANE post NEVER auto-approves (spec 37 SAFETY invariant) ============
  // Reddit is a MANUAL lane (spec 36/37): every reddit post needs a distinct human approval
  // (the warmth tier only decides what happens AFTER approval). This is a LANE exclusion on
  // post.platforms - additive, precedes every policy check, and holds even WITHOUT
  // radarReplyTo (unlike the radar exclusion above). It STRENGTHENS the fence, never weakens.
  const redditPlain = { type: 'text', platforms: ['reddit'], caption: CLEAN, isPromo: false };
  for (const [label, policy] of POLICY_SHAPES) {
    ok(autoApproveDecision(redditPlain, policy, 'acme').approve === false, `a reddit post is NEVER auto-approved (${label})`);
    const scope = inAutoApproveScope(redditPlain, policy, 'acme');
    ok(scope.match === false && scope.reason === 'manual_lane_human_only', `inAutoApproveScope refuses a reddit post with manual_lane_human_only, before any policy check (${label})`);
  }
  // Even a warm, organic, requirements-met reddit post (a Tier-1 auto-EXECUTE post) still
  // requires a human APPROVAL - the tier never bypasses the approval fence.
  ok(autoApproveDecision({ ...redditPlain, isPromo: false }, { enabled: true, platforms: ['reddit'], requireLintClean: false }, 'acme').approve === false, 'a warm/organic reddit post STILL needs a human approval (auto-approve forbidden)');
  // A MULTI-lane post touching reddit is also excluded (subset/any-target rule).
  ok(autoApproveDecision({ type: 'text', platforms: ['x', 'reddit'], caption: CLEAN }, { enabled: true }, 'acme').approve === false, 'a multi-lane post that includes reddit is never auto-approved');

  // ============ layer 2: config gate + autonomous loop ============
  await createCampaign({ id: CAMP, note: 'auto-approve loop', timezone: 'UTC', actor: 'owner' });

  // owner-only enablement gate: an AGENT cannot turn autonomy on.
  const rev0 = getConfig().rev;
  const denied = setConfig({ ifRev: rev0, actor: 'agent:claude', set: { posting: { autoApprove: { enabled: true } } } });
  ok(denied.code === 'invalid_input', 'an agent cannot enable the auto-approve policy (owner-only gate)');
  ok(/owner/i.test(denied.error || denied.message || ''), 'the refusal explains autonomy is owner-authorized');
  ok(getConfig().posting.autoApprove.enabled === false, 'the policy is unchanged after the refused agent write (still fail-closed)');

  // the enabled + zero-platforms shape (the pre-fix default the toggle used to store, and
  // any legacy stored config) is VALID config but INERT at the loop level: nothing approves.
  const inert = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { autoApprove: { enabled: true, platforms: [] } } } });
  ok(inert.ok === true, 'the owner can store the enabled+no-platforms shape (valid config, just inert)');
  const inertDraft = await draftReel('reel-inert', CLEAN);
  ok(inertDraft.ok && inertDraft.autoApproved !== true && getPost('reel-inert').approval === 'draft', 'with zero platforms selected the enabled policy approves NOTHING (legacy match-all is gone)');

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

  // ============ layer 3: a queued Radar reply through the REAL create path (spec 34) ============
  // Re-enable a BROAD auto-approve policy (every reply-capable platform trusted, lint off) -
  // the most permissive matching shape now that empty platforms means match-NOTHING - to
  // PROVE that even so a queued Radar reply is NEVER auto-approved.
  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { autoApprove: { enabled: true, platforms: ['reddit', 'mastodon', 'bluesky', 'x', 'instagram'], requireLintClean: false } } } });
  const q = await queueRadarReply({ campaign: CAMP, signalUrl: 'https://reddit.com/r/x/comments/abc', source: 'reddit', externalId: 't3_abc', text: 'happy to help - here is how we handle that', actor: 'agent:radar', confirm: true });
  ok(q.ok && q.approval === 'pending', 'queueRadarReply seeds a PENDING reply-post (not posted, not approved)');
  const rr = getPost(q.postId);
  ok(rr && rr.approval === 'pending', 'the queued reply is PENDING even under the most permissive enabled auto-approve policy (never auto-approved)');
  ok(rr.approvalBy == null || rr.approvalBy !== AUTO_APPROVE_ACTOR, 'the queued reply was NOT blessed by the auto-approve policy actor');
  ok(rr.createdBy === 'agent:radar' && rr.radarReplyTo && rr.radarReplyTo.externalId === 't3_abc', 'the queued reply carries createdBy=agent:radar + the radarReplyTo target');
  // confirm gate: no confirm -> needs_confirm (never queues).
  const noConfirm = await queueRadarReply({ campaign: CAMP, signalUrl: 'https://reddit.com/x', source: 'reddit', externalId: 't3_y', text: 'hi', actor: 'agent:radar' });
  ok(noConfirm.code === 'needs_confirm', 'queueRadarReply without confirm:true returns needs_confirm (never queues)');
  // HN is surface-only: it can never be a reply source.
  const hn = await queueRadarReply({ campaign: CAMP, signalUrl: 'https://news.ycombinator.com/item?id=1', source: 'hackernews', externalId: '1', text: 'hi', actor: 'agent:radar', confirm: true });
  ok(hn.code === 'invalid_input', 'queueRadarReply rejects hacker-news (surface-only, no reply write-API)');
  // no self-approval: the CREATOR (agent:radar) cannot approve its own queued reply.
  const selfRadar = await approvePost({ campaign: CAMP, postId: q.postId, actor: 'agent:radar' });
  ok(selfRadar.code === 'invalid_input', 'agent:radar cannot approve its OWN queued reply (no-self-approval holds for Radar replies)');
  // a DISTINCT actor (owner) CAN approve it - and only then is it approved.
  const dist = await approvePost({ campaign: CAMP, postId: q.postId, actor: 'owner' });
  ok(dist.ok && getPost(q.postId).approval === 'approved', 'a DISTINCT actor (owner) approves the queued reply - the only path to approval');

  console.log(`[auto-approve] OK - pure decision + owner-gate + autonomous loop + Radar-reply never-auto-approve/no-self-approve in mock mode (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
