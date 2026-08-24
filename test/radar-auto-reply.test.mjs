#!/usr/bin/env node
// test/radar-auto-reply.test.mjs - opt-in auto-reply, decided by Radar, fence untouched.
//
// Spec 40 6.7. The naive design (relax inAutoApproveScope) cannot work, for three reasons
// this file pins down so nobody "simplifies" it back:
//   1. auto-approve runs INSIDE createPost, and queueRadarReply then flips approval to
//      'pending' - demoting any approval it just granted.
//   2. inAutoApproveScope is PURE; its policy arg is posting.autoApprove. It has no access
//      to posting.radar.autoReply, and reading config inside it would break determinism.
//   3. Even relaxed, it would still require posting.autoApprove.enabled AND the lane to
//      pass autoApprove.platforms - so an operator enabling radar.autoReply while global
//      auto-approve is off (the default) would silently get nothing.
//
// So the decision lives at the END of queueRadarReply, the one place with full context,
// and the fence stays BYTE-UNCHANGED: it keeps refusing every radar reply on the
// createPost path, for every post type, exactly as before.
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
const setAutoApprove = (v) => setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { autoApprove: v } } });

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
  setRadar({ autoReply: { enabled: true, lanes: ['mastodon'], requireLintClean: true } });
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
  ok(r.approval === 'pending', 'a lane OUTSIDE autoReply.lanes stays pending (reddit needs a human here)');

  // ---- reddit is permitted only when explicitly listed ------------------------
  setRadar({ autoReply: { enabled: true, lanes: ['reddit'], requireLintClean: true } });
  r = await queue('reddit');
  ok(r.approval === 'approved', 'reddit auto-replies ONLY when the owner explicitly lists it');
  ok(getPost(r.postId).approvalBy === AUTO_APPROVE_ACTOR, 'reddit reply also approves under the policy actor');

  // ---- INDEPENDENT of the global auto-approve policy --------------------------
  // The hidden coupling that killed the naive design: global autoApprove is OFF by
  // default, so a radar-own decision that depended on it would silently do nothing.
  ok(getConfig().posting.autoApprove.enabled === false, 'global auto-approve is OFF (the default)');
  setRadar({ autoReply: { enabled: true, lanes: ['mastodon'], requireLintClean: true } });
  r = await queue('mastodon');
  ok(r.approval === 'approved', 'auto-reply works with global autoApprove DISABLED (no hidden coupling)');

  // ...and an unrelated global policy cannot switch radar auto-reply on by itself.
  setRadar({ autoReply: { enabled: false, lanes: ['mastodon'], requireLintClean: true } });
  setAutoApprove({ enabled: true, platforms: ['mastodon'], requireLintClean: false });
  r = await queue('mastodon');
  ok(r.approval === 'pending',
    'global auto-approve ON does NOT auto-approve a radar reply while radar.autoReply is off');
  setAutoApprove({ enabled: false });

  // ---- the lint gate ---------------------------------------------------------
  // A broken link is the rules.json 'error' severity (the only hard rule today), and it
  // is exactly the kind of thing that must never auto-post into a stranger's thread.
  // Warn-level slop does NOT block: that mirrors autoApproveDecision, which also gates on
  // error-severity only, so the two autonomy paths cannot disagree about what "clean" means.
  setRadar({ autoReply: { enabled: true, lanes: ['mastodon'], requireLintClean: true } });
  const dirty = 'We built something for this, see [our guide]() for the details.';
  r = await queue('mastodon', dirty);
  ok(r.approval === 'pending', 'requireLintClean: a draft with an error-severity finding (broken link) stays pending');

  setRadar({ autoReply: { enabled: true, lanes: ['mastodon'], requireLintClean: false } });
  r = await queue('mastodon', dirty);
  ok(r.approval === 'approved', 'with requireLintClean off, the same draft auto-approves');

  // Warn-level slop is advisory everywhere else, so it must not silently block here either.
  setRadar({ autoReply: { enabled: true, lanes: ['mastodon'], requireLintClean: true } });
  r = await queue('mastodon', 'Check out this game-changer!!! '.repeat(3));
  ok(r.approval === 'approved', 'a WARN-only draft still auto-approves (parity with autoApproveDecision)');

  // ---- the draft-for-review hold (the "Auto-Antwort aktiv" tap) ---------------
  // A drafting child spawned FOR the operator's review runs with the fence armed
  // holdApproval: the target fence still admits exactly its signal, but the policy
  // stands down - the draft the human asked to READ lands pending with every gate green.
  {
    const { beginDraftFence, endDraftFence } = await import('../lib/agent-runner.mjs');
    setRadar({ enabled: true, autoReply: { enabled: true, lanes: ['mastodon'], requireLintClean: false } });
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
  const agentTry = setRadar({ autoReply: { enabled: true, lanes: ['reddit'] } }, 'agent:claude');
  ok(agentTry && agentTry.code === 'invalid_input', 'an AGENT cannot enable autoReply (owner-gated)');
  ok(setRadar({ autoReply: { lanes: ['myspace'] } }).code === 'invalid_input',
    'autoReply.lanes must be reply-capable Radar lanes');
  ok(setRadar({ autoReply: { enabled: 'yes' } }).code === 'invalid_input', 'autoReply.enabled must be a boolean');
  ok(setRadar({ autoReply: { command: 'rm -rf /' } }).code === 'invalid_input', 'autoReply refuses an unknown key');
  // Radar off entirely = nothing autonomous, whatever autoReply says.
  setRadar({ enabled: false, autoReply: { enabled: true, lanes: ['mastodon'], requireLintClean: false } });
  r = await queue('mastodon');
  ok(r.approval === 'pending', 'Radar disabled: no auto-reply (the beta gate wins)');

  console.log(`\nradar-auto-reply: ${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
