#!/usr/bin/env node
// test/edited-since-approval.test.mjs - the post-approval trust gate.
//
// An edit to an already-approved post's CONTENT must invalidate the meaning of the
// approval: the scheduler would otherwise fire copy the owner never reviewed. Per the
// owner's decision the post STAYS approval:'approved' but gets editedSinceApproval:true
// (an operator-visible flag, not an auto-revert), and the two shared publish fences
// (eligibleDuePosts + buildPublishJob) refuse it until re-approval. A SCHEDULING-only
// edit must NOT trip it; restoring the approved content clears it; re-approval re-stamps.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-edited-approval-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
// A minimal but real MP4 header so the asset scan/media.exists reads true.
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));

const { createCampaign, createPost, updatePost, approvePost } = await import('../lib/writes.mjs');
const { eligibleDuePosts } = await import('../lib/scheduler.mjs');
const { buildPublishJob, PublishJobError } = await import('../lib/publish-job.mjs');
const { loadPlanStore, postContentHash, POST_CONTENT_FIELDS } = await import('../lib/plans.mjs');

const CAMP = 'acme';
const getPost = (id) => (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []).find((p) => p.id === id);

const throwsWith = (fn, code) => {
  try { fn(); } catch (e) { return e instanceof PublishJobError && e.code === code; }
  return false;
};

try {
  // A due (past-scheduled), agent-created post so owner approval is not self-approval.
  await createCampaign({ id: CAMP, note: 'trust gate', timezone: 'UTC', actor: 'owner' });
  await createPost({
    campaign: CAMP,
    post: { id: 'p1', type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'original approved copy' },
    actor: 'agent:claude',
  });

  // ---- POST_CONTENT_FIELDS excludes scheduling; hash is order-independent ------
  ok(!POST_CONTENT_FIELDS.includes('scheduledAt') && !POST_CONTENT_FIELDS.includes('executionMode'),
    'POST_CONTENT_FIELDS excludes scheduledAt + executionMode (scheduling is not content)');
  ok(POST_CONTENT_FIELDS.includes('caption') && POST_CONTENT_FIELDS.includes('platforms'),
    'POST_CONTENT_FIELDS includes caption + platforms (destination is content)');
  ok(postContentHash({ caption: 'a', platforms: ['x'] }) === postContentHash({ platforms: ['x'], caption: 'a' }),
    'postContentHash is independent of the post object key order');
  ok(postContentHash({ caption: 'a' }) !== postContentHash({ caption: 'b' }),
    'postContentHash changes when a content field changes');

  // ---- approve: stamps approvedContentHash, no edited flag --------------------
  const appr = await approvePost({ campaign: CAMP, postId: 'p1', actor: 'owner' });
  ok(appr.ok, 'owner approves the agent-created post (not self-approval)');
  let p = getPost('p1');
  ok(p.approval === 'approved', 'post is approved');
  ok(!p.editedSinceApproval, 'a freshly-approved post is NOT flagged edited-since-approval');

  // The raw stored post carries the stamped hash (read model hides it; that is fine).
  const rawAfterApprove = JSON.parse(fs.readFileSync(path.join(WS, 'data', 'plans', CAMP, 'post-plan.json'), 'utf8')).posts.find((x) => x.id === 'p1');
  ok(typeof rawAfterApprove.approvedContentHash === 'string' && rawAfterApprove.approvedContentHash.length > 0,
    'approve stamps approvedContentHash on the stored post');

  // ---- baseline: approved + due + rendered => eligible + buildable ------------
  const eligibleIds = () => [...eligibleDuePosts(loadPlanStore().campaigns, {})].map((e) => e.post.id);
  ok(eligibleIds().includes('p1'), 'an approved, due, rendered post is eligible to fire');
  ok(buildPublishJob(getPost('p1'), 'meta', { clientId: 'default', campaign: CAMP }).jobId === `default:${CAMP}:p1:meta`,
    'buildPublishJob mints an envelope for the clean approved post');

  // ---- CONTENT edit while approved => flag raised, approval kept --------------
  let r = await updatePost({ campaign: CAMP, postId: 'p1', ifRev: p.rev, fields: { caption: 'sneaky UNREVIEWED edit' }, actor: 'owner' });
  ok(r.ok, 'a content edit to an approved post succeeds');
  p = getPost('p1');
  ok(p.approval === 'approved', 'approval STAYS approved (owner chose the flag over an auto-revert)');
  ok(p.editedSinceApproval === true, 'a content edit raises editedSinceApproval');

  // ---- fail-closed at BOTH shared fences -------------------------------------
  ok(!eligibleIds().includes('p1'), 'eligibleDuePosts EXCLUDES the edited-since-approval post');
  ok(throwsWith(() => buildPublishJob(getPost('p1'), 'meta', { clientId: 'default', campaign: CAMP }), 'edited_since_approval'),
    'buildPublishJob throws edited_since_approval (second fence)');

  // ---- SCHEDULING-only edit does NOT flag ------------------------------------
  // Re-approve to clear, then move only the time.
  await approvePost({ campaign: CAMP, postId: 'p1', actor: 'owner' });
  p = getPost('p1');
  ok(!p.editedSinceApproval, 're-approval clears the flag');
  r = await updatePost({ campaign: CAMP, postId: 'p1', ifRev: p.rev, fields: { scheduledAt: '2020-02-02T00:00:00Z' }, actor: 'owner' });
  ok(r.ok && !getPost('p1').editedSinceApproval, 'a scheduledAt-only edit does NOT flag (scheduling is not content)');
  ok(eligibleIds().includes('p1'), 'the rescheduled-but-unedited post stays eligible');

  // ---- RESTORING the approved content clears the flag ------------------------
  p = getPost('p1');
  const approvedCaption = p.caption; // 'original approved copy'
  r = await updatePost({ campaign: CAMP, postId: 'p1', ifRev: p.rev, fields: { caption: 'temporary change' }, actor: 'owner' });
  ok(getPost('p1').editedSinceApproval === true, 'a content change flags again');
  p = getPost('p1');
  r = await updatePost({ campaign: CAMP, postId: 'p1', ifRev: p.rev, fields: { caption: approvedCaption }, actor: 'owner' });
  ok(r.ok && !getPost('p1').editedSinceApproval, 'restoring the exact approved content CLEARS the flag');
  ok(eligibleIds().includes('p1'), 'the restored post is eligible again with no re-approval needed');

  // ---- an UNapproved (draft) post is never flagged ---------------------------
  await createPost({
    campaign: CAMP,
    post: { id: 'p2', type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'draft copy' },
    actor: 'agent:claude',
  });
  const draft = getPost('p2');
  r = await updatePost({ campaign: CAMP, postId: 'p2', ifRev: draft.rev, fields: { caption: 'edited draft' }, actor: 'owner' });
  ok(r.ok && !getPost('p2').editedSinceApproval, 'editing a draft never sets editedSinceApproval (nothing to invalidate)');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
