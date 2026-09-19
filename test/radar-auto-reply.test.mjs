#!/usr/bin/env node
// test/radar-auto-reply.test.mjs - opt-in auto-reply, decided by the auto-approve trust scope,
// broad fence untouched.
//
// Owner Q2: the arming moved into the auto-approve object the owner knows, as its own sub-scope
// autoApprove.radarReplies - NOT the platforms/campaigns/types axes (trusting a platform for your
// own feed must never silently arm stranger-replies). The decision still lives at the END of
// queueRadarReply, the one place with full context, decided by the pure radarReplyAutoApproveDecision:
//   1. inAutoApproveScope runs INSIDE createPost, and queueRadarReply then flips approval to
//      'pending' - demoting any approval it just granted.
//   2. inAutoApproveScope's radarReplyTo/MANUAL_LANES guards REFUSE every radar reply on the
//      createPost path (the broad fence), and stay BYTE-UNCHANGED.
//   3. radarReplies is decoupled from autoApprove.enabled/platforms, so arming replies works while
//      the normal-post policy is off (its default), and turning the normal-post policy on never
//      arms replies.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-auto-reply-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { createCampaign, queueRadarReply } = await import('../lib/writes.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { inAutoApproveScope, AUTO_APPROVE_ACTOR } = await import('../lib/auto-approve.mjs');

const CAMP = 'radar';
const getPost = (id) => (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []).find((p) => p.id === id);
const setRadar = (radar, actor = 'owner') => setConfig({ ifRev: getConfig().rev, actor, set: { posting: { radar } } });
const setAutoApprove = (v, actor = 'owner') => setConfig({ ifRev: getConfig().rev, actor, set: { posting: { autoApprove: v } } });
// The auto-reply TRUST scope now lives in the auto-approve object (owner Q2): autoApprove.radarReplies.
const setRadarReplies = (rr, actor = 'owner') => setAutoApprove({ radarReplies: rr }, actor);

let n = 0;
const queue = async (source, text = 'A genuinely useful answer to the question asked.') => {
  n += 1;
  const res = await queueRadarReply({
    campaign: CAMP,
    signalUrl: `https://example.com/thread/${n}`,
    source,
    externalId: `ext-${n}`,
    text,
    actor: 'agent:claude',
    confirm: true,
  });
  return res;
};

try {
  await createCampaign({ id: CAMP, note: 'radar replies', timezone: 'UTC', actor: 'owner' });
  setRadar({ enabled: true });

  // ---- default: human-gated, exactly as before -------------------------------
  let r = await queue('mastodon');
  ok(r.ok === true && r.approval === 'pending', 'DEFAULT: a queued reply is pending (auto-reply is opt-in, default off)');
  ok(getPost(r.postId).approval === 'pending', 'the persisted post is pending');

  // ---- the fence is BYTE-UNCHANGED -------------------------------------------
  // Whatever we do below, the createPost-path fence must keep refusing radar replies.
  const replyPost = getPost(r.postId);
  for (const policy of [{ enabled: true }, { enabled: true, platforms: ['mastodon'] }, {}]) {
    const scope = inAutoApproveScope(replyPost, policy, CAMP);
    ok(scope.match === false && scope.reason === 'radar_reply_human_only',
      `inAutoApproveScope still refuses a radar reply (policy ${JSON.stringify(policy)})`);
  }

  // ---- opt-in, per lane ------------------------------------------------------
  setRadarReplies({ enabled: true, lanes: ['mastodon'], requireLintClean: true });
  r = await queue('mastodon');
  ok(r.approval === 'approved', 'ENABLED + lane allowed: the reply auto-approves');
  const auto = getPost(r.postId);
  ok(auto.approval === 'approved', 'the persisted reply is approved');
  ok(auto.approvalBy === AUTO_APPROVE_ACTOR,
    'approved under the POLICY actor, never the drafting agent (no-self-approval holds)');
  ok(auto.createdBy !== auto.approvalBy, 'creator and approver are distinct actors');
  ok(auto.executionMode === 'fully-scheduled',
    'the reply stays fully-scheduled so eligibleDuePosts can actually fire it (never parked)');

  // ---- a lane NOT on the allow-list stays human-gated -------------------------
  r = await queue('reddit');
  ok(r.approval === 'pending', 'a lane OUTSIDE radarReplies.lanes stays pending (reddit needs a human here)');

  // ---- reddit is permitted only when explicitly listed ------------------------
  // The whole point of a separate radarReplies.lanes allow-list: reddit is a MANUAL_LANE the broad
  // auto-approve policy always refuses, but the owner's explicit radar-reply grant opens it.
  setRadarReplies({ enabled: true, lanes: ['reddit'], requireLintClean: true });
  r = await queue('reddit');
  ok(r.approval === 'approved', 'reddit auto-replies ONLY when the owner explicitly lists it (the narrower door)');
  ok(getPost(r.postId).approvalBy === AUTO_APPROVE_ACTOR, 'reddit reply also approves under the policy actor');

  // ---- INDEPENDENT of the NORMAL-POST auto-approve axes -----------------------
  // radarReplies is its OWN allow-list, decoupled from autoApprove.enabled/platforms: trusting a
  // platform for your own feed must never silently arm stranger-replies, and arming replies must
  // work while the normal-post policy is off (its default).
  ok(getConfig().posting.autoApprove.enabled === false, 'the normal-post auto-approve is OFF (the default)');
  setRadarReplies({ enabled: true, lanes: ['mastodon'], requireLintClean: true });
  r = await queue('mastodon');
  ok(r.approval === 'approved', 'auto-reply works while the normal-post autoApprove is DISABLED (no coupling)');

  // ...and turning the NORMAL-POST policy on (with mastodon trusted) cannot switch radar replies on.
  setRadarReplies({ enabled: false, lanes: ['mastodon'], requireLintClean: true });
  setAutoApprove({ enabled: true, platforms: ['mastodon'], requireLintClean: false });
  r = await queue('mastodon');
  ok(r.approval === 'pending',
    'the normal-post auto-approve ON (mastodon trusted) does NOT auto-approve a radar reply - the footgun the sub-scope avoids');
  setAutoApprove({ enabled: false });

  // ---- the lint gate ---------------------------------------------------------
  // A broken link is the rules.json 'error' severity (the only hard rule today), and it
  // is exactly the kind of thing that must never auto-post into a stranger's thread.
  // Warn-level slop does NOT block: that mirrors autoApproveDecision, which also gates on
  // error-severity only, so the two autonomy paths cannot disagree about what "clean" means.
  setRadarReplies({ enabled: true, lanes: ['mastodon'], requireLintClean: true });
  const dirty = 'We built something for this, see [our guide]() for the details.';
  r = await queue('mastodon', dirty);
  ok(r.approval === 'pending', 'requireLintClean: a draft with an error-severity finding (broken link) stays pending');

  setRadarReplies({ enabled: true, lanes: ['mastodon'], requireLintClean: false });
  r = await queue('mastodon', dirty);
  ok(r.approval === 'approved', 'with requireLintClean off, the same draft auto-approves');

  // Warn-level slop is advisory everywhere else, so it must not silently block here either.
  setRadarReplies({ enabled: true, lanes: ['mastodon'], requireLintClean: true });
  r = await queue('mastodon', 'Check out this game-changer!!! '.repeat(3));
  ok(r.approval === 'approved', 'a WARN-only draft still auto-approves (parity with autoApproveDecision)');

  // ---- the draft-for-review hold (the "Auto-Antwort aktiv" tap) ---------------
  // A drafting child spawned FOR the operator's review runs with the fence armed
  // holdApproval: the target fence still admits exactly its signal, but the policy
  // stands down - the draft the human asked to READ lands pending with every gate green.
  {
    const { beginDraftFence, endDraftFence } = await import('../lib/agent-runner.mjs');
    setRadar({ enabled: true });
    setRadarReplies({ enabled: true, lanes: ['mastodon'], requireLintClean: false });
    beginDraftFence(['mastodon hold-1'], { holdApproval: true });
    let held;
    try {
      held = await queueRadarReply({ campaign: CAMP, signalUrl: 'https://example.com/thread/hold', source: 'mastodon', externalId: 'hold-1', text: 'A genuinely useful answer to the question asked.', actor: 'agent:claude', confirm: true });
    } finally { endDraftFence(); }
    ok(held.ok === true && held.approval === 'pending', 'holdApproval fence: the auto-reply policy stands down - the operator-requested draft stays PENDING');
    ok(getPost(held.postId).approval === 'pending', 'the persisted held draft is pending');
    // The plain fence (no hold) keeps its existing meaning byte-for-byte: auto-approve fires.
    beginDraftFence(['mastodon hold-2']);
    let auto2;
    try {
      auto2 = await queueRadarReply({ campaign: CAMP, signalUrl: 'https://example.com/thread/hold2', source: 'mastodon', externalId: 'hold-2', text: 'A genuinely useful answer to the question asked.', actor: 'agent:claude', confirm: true });
    } finally { endDraftFence(); }
    ok(auto2.approval === 'approved', 'a plain fence (no hold) leaves the auto-reply policy in force');
  }

  // ---- config: owner-gated + typed -------------------------------------------
  const agentTry = setRadarReplies({ enabled: true, lanes: ['reddit'] }, 'agent:claude');
  ok(agentTry && agentTry.code === 'invalid_input', 'an AGENT cannot arm radarReplies (autoApprove is owner-gated)');
  ok(setRadarReplies({ lanes: ['myspace'] }).code === 'invalid_input',
    'radarReplies.lanes must be reply-capable Radar lanes');
  ok(setRadarReplies({ enabled: 'yes' }).code === 'invalid_input', 'radarReplies.enabled must be a boolean');
  ok(setRadarReplies({ command: 'rm -rf /' }).code === 'invalid_input', 'radarReplies refuses an unknown key');
  // The retired posting.radar.autoReply key is refused outright now (migrated on read; see
  // radar-config-hygiene for the strip). An agent/older client writing it gets invalid_input.
  ok(setRadar({ autoReply: { enabled: true, lanes: ['mastodon'] } }).code === 'invalid_input',
    'the retired posting.radar.autoReply key is refused (arming moved to autoApprove.radarReplies)');
  // Radar off entirely = nothing autonomous, whatever radarReplies says.
  setRadar({ enabled: false });
  setRadarReplies({ enabled: true, lanes: ['mastodon'], requireLintClean: false });
  r = await queue('mastodon');
  ok(r.approval === 'pending', 'Radar disabled: no auto-reply (the beta gate wins)');

  console.log(`\nradar-auto-reply: ${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
