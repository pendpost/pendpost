#!/usr/bin/env node
// test/reject-revive-on-edit.test.mjs - a rejected post rejoins the review queue
// when its content is reworked.
//
// The approvals queue holds only UNDECIDED work: approve and reject BOTH settle a
// post so it leaves "To review". A rejection is not the end of the story, though -
// the reviewer rejects with a note asking for a change, and the rework must bring the
// post BACK for a fresh decision. Mechanism (symmetric with the approved trust gate):
// reject stamps rejectedContentHash; a later CONTENT edit that diverges from it reverts
// approval to 'draft' (undecided) and clears the stale decision metadata, so the post
// re-enters the queue. A SCHEDULING-only edit leaves the rejection standing.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-reject-revive-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));

const { createCampaign, createPost, updatePost, approvePost, rejectPost } = await import('../lib/writes.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');

const CAMP = 'acme';
const getPost = (id) => (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []).find((p) => p.id === id);
const rawPost = (id) => JSON.parse(fs.readFileSync(path.join(WS, 'data', 'plans', CAMP, 'post-plan.json'), 'utf8')).posts.find((x) => x.id === id);

try {
  await createCampaign({ id: CAMP, note: 'reject revive', timezone: 'UTC', actor: 'owner' });
  await createPost({
    campaign: CAMP,
    post: { id: 'p1', type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'first draft the owner will reject' },
    actor: 'agent:claude',
  });

  // ---- reject: settles the post + stamps rejectedContentHash -----------------
  const rej = await rejectPost({ campaign: CAMP, postId: 'p1', actor: 'owner', note: 'tighten the hook' });
  ok(rej.ok, 'owner rejects the agent-created post (not self-approval)');
  let p = getPost('p1');
  ok(p.approval === 'rejected', 'post is rejected');
  ok(p.approvalNote === 'tighten the hook', 'the reject note is stored');
  let raw = rawPost('p1');
  ok(typeof raw.rejectedContentHash === 'string' && raw.rejectedContentHash.length > 0,
    'reject stamps rejectedContentHash on the stored post');
  ok(!raw.approvedContentHash, 'reject does NOT leave an approvedContentHash');

  // ---- SCHEDULING-only edit leaves the rejection standing --------------------
  let r = await updatePost({ campaign: CAMP, postId: 'p1', ifRev: p.rev, fields: { scheduledAt: '2020-03-03T00:00:00Z' }, actor: 'owner' });
  ok(r.ok, 'a scheduling-only edit of a rejected post succeeds');
  p = getPost('p1');
  ok(p.approval === 'rejected', 'a scheduledAt-only edit does NOT revive the rejection (scheduling is not content)');
  ok(rawPost('p1').rejectedContentHash, 'the rejectedContentHash survives a scheduling-only edit');

  // ---- CONTENT edit (the rework) reverts to draft, re-queuing the post --------
  p = getPost('p1');
  r = await updatePost({ campaign: CAMP, postId: 'p1', ifRev: p.rev, fields: { caption: 'reworked hook, much punchier' }, actor: 'agent:claude' });
  ok(r.ok, 'the rework content edit succeeds');
  p = getPost('p1');
  ok(p.approval === 'draft', 'a content edit reverts the rejected post to an undecided draft (back in the queue)');
  raw = rawPost('p1');
  ok(!raw.rejectedContentHash, 'the stale rejectedContentHash is cleared on revert');
  ok(!raw.approvalBy && !raw.approvalAt && !p.approvalNote,
    'the stale decision metadata (who/when/note) is cleared on revert');

  // ---- editing the fresh draft never mis-flags -------------------------------
  p = getPost('p1');
  r = await updatePost({ campaign: CAMP, postId: 'p1', ifRev: p.rev, fields: { caption: 'one more tweak' }, actor: 'agent:claude' });
  ok(r.ok && getPost('p1').approval === 'draft', 'editing the revived draft leaves it an undecided draft');
  ok(!getPost('p1').editedSinceApproval, 'a revived draft never carries editedSinceApproval (it was never approved)');

  // ---- a re-rejected, then reworked post revives again (loop is repeatable) ---
  p = getPost('p1');
  await rejectPost({ campaign: CAMP, postId: 'p1', actor: 'owner', note: 'still not there' });
  ok(getPost('p1').approval === 'rejected', 'the post can be rejected a second time');
  p = getPost('p1');
  r = await updatePost({ campaign: CAMP, postId: 'p1', ifRev: p.rev, fields: { caption: 'third time is the charm' }, actor: 'agent:claude' });
  ok(getPost('p1').approval === 'draft', 'a second rework revives it again (the reject/rework loop is repeatable)');

  // ---- approve after revive still works and clears any rejected stamp ---------
  p = getPost('p1');
  const appr = await approvePost({ campaign: CAMP, postId: 'p1', actor: 'owner' });
  ok(appr.ok && getPost('p1').approval === 'approved', 'the revived-then-reworked post can finally be approved');
  ok(rawPost('p1').approvedContentHash && !rawPost('p1').rejectedContentHash,
    'approve stamps approvedContentHash and leaves no rejectedContentHash');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
