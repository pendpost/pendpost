#!/usr/bin/env node
// test/gate-refinements.test.mjs - the two opt-in publish-gate refinements (R6a,
// ux-audit 2026-08-04 dim-1 proposals 3+5): approval expiry + slot slip.
//
// Both are OWNER-ONLY and DEFAULT OFF, and both are fail-closed BY CONSTRUCTION:
// the expiry sweep can only send an aged approval back to DRAFT (re-ask the human),
// the slip sweep can only MOVE an unapproved post's slot forward. Neither can ever
// publish, approve, or widen anything. This suite pins exactly that: off = a no-op,
// on = revert / move + one activity row each, radar's approve-then-fire path is
// untouched, and the post NEVER reaches status 'posted' through either sweep.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-gate-refine-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
// A minimal real MP4 header so media.exists reads true (an image/reel post is eligible).
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));

const { createCampaign, createPost, approvePost, sweepApprovalExpiry, sweepSlotSlip, slotSlipMessage } = await import('../lib/writes.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { loadState } = await import('../lib/state.mjs');

const CAMP = 'acme';
const getPost = (id) => (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []).find((p) => p.id === id);
const planFile = path.join(WS, 'data', 'plans', CAMP, 'post-plan.json');
const readRaw = () => JSON.parse(fs.readFileSync(planFile, 'utf8'));
const writeRaw = (plan) => fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
const patchPost = (id, patch) => { const plan = readRaw(); Object.assign(plan.posts.find((p) => p.id === id), patch); writeRaw(plan); };
const rowsFor = (id, action) => (loadState().activity || []).filter((e) => e.campaign === CAMP && e.postId === id && e.action === action);
const setPosting = (set) => setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: set } });
const isoIn = (ms) => new Date(Date.now() + ms).toISOString();

try {
  await createCampaign({ id: CAMP, note: 'gate refinements', timezone: 'UTC', actor: 'owner' });

  // ============================ OWNER-GATE + DEFAULTS ===========================
  ok(getConfig().posting.approvalExpiryHours === null && getConfig().posting.slotSlipMinutes === null,
    'both refinements default to null (off)');
  const denied = setConfig({ ifRev: getConfig().rev, actor: 'agent:claude', set: { posting: { approvalExpiryHours: 24 } } });
  ok(denied.code === 'invalid_input', 'an agent CANNOT set approvalExpiryHours (owner-gated)');
  const deniedSlip = setConfig({ ifRev: getConfig().rev, actor: 'agent:claude', set: { posting: { slotSlipMinutes: 30 } } });
  ok(deniedSlip.code === 'invalid_input', 'an agent CANNOT set slotSlipMinutes (owner-gated)');
  const bad = setPosting({ approvalExpiryHours: 0 });
  ok(bad.code === 'invalid_input', 'approvalExpiryHours = 0 is rejected (must be >= 1 or null)');

  // ======================= OFF BY DEFAULT = A NO-OP ============================
  // An agent-created, owner-approved (not self-approval), long-aged post + a due
  // unapproved post. With both fields null the sweeps must touch NOTHING.
  await createPost({ campaign: CAMP, post: { id: 'aged', type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'aged approved' }, actor: 'agent:claude' });
  await approvePost({ campaign: CAMP, postId: 'aged', actor: 'owner' });
  patchPost('aged', { approvalAt: '2020-01-01T00:00:00Z' }); // approved 6 years ago
  await createPost({ campaign: CAMP, post: { id: 'duep', type: 'reel', platforms: ['instagram'], scheduledAt: isoIn(60 * 1000), path: 'data/media/clip.mp4', caption: 'due unapproved' }, actor: 'agent:claude' });

  const offExp = await sweepApprovalExpiry({ actor: 'pendpost' });
  const offSlip = await sweepSlotSlip({ actor: 'pendpost' });
  ok(offExp.enabled === false && offExp.reverted === 0, 'expiry sweep is a no-op while approvalExpiryHours is null');
  ok(offSlip.enabled === false && offSlip.moved === 0, 'slip sweep is a no-op while slotSlipMinutes is null');
  ok(getPost('aged').approval === 'approved', 'the aged approved post is untouched while expiry is off');
  ok(rowsFor('aged', 'approval-expired').length === 0 && rowsFor('duep', 'slot-slip').length === 0, 'no activity rows written while both are off');

  // ============================ APPROVAL EXPIRY ON ============================
  setPosting({ approvalExpiryHours: 24 });
  // A FRESH approval (well inside the window) must survive - the sweep only ages
  // OUT, it never reverts a still-current approval.
  await createPost({ campaign: CAMP, post: { id: 'fresh', type: 'reel', platforms: ['instagram'], scheduledAt: isoIn(3600 * 1000), path: 'data/media/clip.mp4', caption: 'fresh approved' }, actor: 'agent:claude' });
  await approvePost({ campaign: CAMP, postId: 'fresh', actor: 'owner' });

  const exp = await sweepApprovalExpiry({ actor: 'pendpost' });
  ok(exp.enabled === true && exp.reverted === 1, 'expiry sweep reverts exactly the one aged approval');
  const aged = getPost('aged');
  ok(aged.approval === 'draft', 'the aged post reverted to draft (the human gate re-asks)');
  ok(aged.status !== 'posted', 'the reverted post was NOT published (fail-closed - expiry only revokes)');
  ok(typeof aged.approvalNote === 'string' && /aged out/i.test(aged.approvalNote), 'the reverted post carries an "aged out" approvalNote for the review queue');
  ok(getPost('fresh').approval === 'approved', 'a still-current approval is NOT aged out');
  const expRows = rowsFor('aged', 'approval-expired');
  ok(expRows.length === 1 && expRows[0].ok === true, 'exactly one approval-expired activity row is logged');

  // Re-running the sweep does not re-log (the post is draft now, nothing to age).
  await sweepApprovalExpiry({ actor: 'pendpost' });
  ok(rowsFor('aged', 'approval-expired').length === 1, 'a second expiry sweep does not double-log (idempotent)');

  // Radar's approve-then-fire path is untouched: a freshly-approved radar reply
  // (scheduledAt = now) is NOT aged out by the sweep - it publishes normally.
  await createPost({ campaign: CAMP, post: { id: 'reply', type: 'text', platforms: ['mastodon'], scheduledAt: isoIn(-1000), caption: 'radar reply' }, actor: 'agent:claude' });
  patchPost('reply', { radarReplyTo: { platform: 'mastodon', id: 'x1' } });
  await approvePost({ campaign: CAMP, postId: 'reply', actor: 'owner' });
  await sweepApprovalExpiry({ actor: 'pendpost' });
  ok(getPost('reply').approval === 'approved', 'a freshly-approved radar reply is unaffected by approval expiry');

  // ============================== SLOT SLIP ON ===============================
  setPosting({ approvalExpiryHours: null, slotSlipMinutes: 30 }); // expiry off, isolate slip
  // Push the earlier draft fixtures far past the 30min window so they don't confound
  // the slip-count assertion (they would each legitimately slip - proven separately).
  patchPost('aged', { scheduledAt: isoIn(10 * 24 * 3600 * 1000) });
  patchPost('duep', { scheduledAt: isoIn(10 * 24 * 3600 * 1000) });
  const dueAt = isoIn(10 * 60 * 1000); // due in 10min, inside the 30min slip window
  await createPost({ campaign: CAMP, post: { id: 'slip', type: 'reel', platforms: ['instagram'], scheduledAt: dueAt, path: 'data/media/clip.mp4', caption: 'unapproved near slot' }, actor: 'agent:claude' });

  const slip = await sweepSlotSlip({ actor: 'pendpost' });
  ok(slip.enabled === true && slip.moved === 1, 'slip sweep moves the one unapproved near-slot post');
  const slipped = getPost('slip');
  const expected = new Date(Date.parse(dueAt) + 24 * 3600 * 1000).toISOString();
  ok(slipped.scheduledAt === expected, 'the slot moved to the next same-time occurrence (+24h)');
  ok(slipped.approval !== 'approved' && slipped.status !== 'posted', 'the slipped post was NOT approved or published (fail-closed - slip only moves time)');
  const slipRows = rowsFor('slip', 'slot-slip');
  ok(slipRows.length === 1 && slipRows[0].errorMessage === slotSlipMessage(expected), 'exactly one slot-slip row naming the new time');

  // De-dupe: a raced re-entry at the SAME target time writes no second row and
  // does not move again (media-missing-defer standing-de-dupe pattern).
  patchPost('slip', { scheduledAt: dueAt }); // pretend a race reset it to the near-slot time
  const slip2 = await sweepSlotSlip({ actor: 'pendpost' });
  ok(slip2.moved === 0, 'a re-entry computing the SAME target time is de-duped (no second move)');
  ok(rowsFor('slip', 'slot-slip').length === 1, 'the slot-slip row is not duplicated');

  // Slip skips a radar reply (no red-overdue alarm to prevent -> never slips).
  await createPost({ campaign: CAMP, post: { id: 'slipreply', type: 'text', platforms: ['mastodon'], scheduledAt: isoIn(5 * 60 * 1000), caption: 'reply near slot' }, actor: 'agent:claude' });
  patchPost('slipreply', { radarReplyTo: { platform: 'mastodon', id: 'x2' } });
  const before = getPost('slipreply').scheduledAt;
  await sweepSlotSlip({ actor: 'pendpost' });
  ok(getPost('slipreply').scheduledAt === before, 'a radar reply is never slipped (approve-then-fire-promptly untouched)');

  // An APPROVED, unedited near-slot post is not slipped (it will fire on time).
  await createPost({ campaign: CAMP, post: { id: 'okpost', type: 'reel', platforms: ['instagram'], scheduledAt: isoIn(5 * 60 * 1000), path: 'data/media/clip.mp4', caption: 'approved near slot' }, actor: 'agent:claude' });
  await approvePost({ campaign: CAMP, postId: 'okpost', actor: 'owner' });
  const okBefore = getPost('okpost').scheduledAt;
  await sweepSlotSlip({ actor: 'pendpost' });
  ok(getPost('okpost').scheduledAt === okBefore, 'an approved unedited post is not slipped (nothing to move)');

  // Slip off = a no-op even for a due unapproved post.
  setPosting({ slotSlipMinutes: null });
  await createPost({ campaign: CAMP, post: { id: 'offdue', type: 'reel', platforms: ['instagram'], scheduledAt: isoIn(60 * 1000), path: 'data/media/clip.mp4', caption: 'due unapproved, slip off' }, actor: 'agent:claude' });
  const dueBefore = getPost('offdue').scheduledAt;
  const offSlip2 = await sweepSlotSlip({ actor: 'pendpost' });
  ok(offSlip2.enabled === false && getPost('offdue').scheduledAt === dueBefore, 'slip is a no-op once slotSlipMinutes is null again');

  console.log(`\n${pass} assertions passed`);
} catch (e) {
  console.error('FAIL:', e.stack || e.message);
  process.exit(1);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
