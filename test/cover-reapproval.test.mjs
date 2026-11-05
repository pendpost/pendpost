#!/usr/bin/env node
// test/cover-reapproval.test.mjs - a post-approval COVER change re-trips approval.
//
// A cover is a publishable content decision like the caption: changing it after the
// owner approved means the owner never reviewed what will actually go out. `cover` is
// deliberately excluded from POST_CONTENT_FIELDS (the content fingerprint), so a cover
// swap does NOT move postContentHash - the hash-comparison path in updatePost cannot
// catch it. setCover therefore raises editedSinceApproval directly whenever the post is
// currently approved, so the two shared publish fences (eligibleDuePosts + buildPublishJob)
// refuse it until re-approval, consistent with every other content edit. A cover set on a
// still-unapproved draft has nothing to invalidate and must NOT flag.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-cover-reapproval-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
// A minimal but real MP4 header so the asset scan/media.exists reads true.
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));

const { createCampaign, createPost, updatePost, approvePost } = await import('../lib/writes.mjs');
const { setCover, clearCover } = await import('../lib/covers.mjs');
const { eligibleDuePosts } = await import('../lib/scheduler.mjs');
const { buildPublishJob, PublishJobError } = await import('../lib/publish-job.mjs');
const { loadPlanStore, loadManifest } = await import('../lib/plans.mjs');

const CAMP = 'acme';
const getPost = (id) => (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []).find((p) => p.id === id);
const rawPost = (id) => {
  const rel = loadManifest().plans.find((p) => p.id === CAMP).path;
  return JSON.parse(fs.readFileSync(path.resolve(WS, rel), 'utf8')).posts.find((p) => p.id === id);
};
const eligibleIds = () => [...eligibleDuePosts(loadPlanStore().campaigns, {})].map((e) => e.post.id);
const throwsWith = (fn, code) => {
  try { fn(); } catch (e) { return e instanceof PublishJobError && e.code === code; }
  return false;
};

try {
  // A due (past-scheduled), agent-created reel so owner approval is not self-approval.
  await createCampaign({ id: CAMP, note: 'cover trust gate', timezone: 'UTC', actor: 'owner' });
  await createPost({
    campaign: CAMP,
    post: { id: 'p1', type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'approved copy' },
    actor: 'agent:claude',
  });

  // ---- approve, then baseline: approved + due => eligible + buildable ----------
  const appr = await approvePost({ campaign: CAMP, postId: 'p1', actor: 'owner' });
  ok(appr.ok, 'owner approves the agent-created post (not self-approval)');
  let p = getPost('p1');
  ok(p.approval === 'approved' && !p.editedSinceApproval, 'freshly-approved post is not flagged edited-since-approval');
  ok(eligibleIds().includes('p1'), 'the approved, due post is eligible to fire');
  ok(buildPublishJob(getPost('p1'), 'meta', { clientId: 'default', campaign: CAMP }).jobId === `default:${CAMP}:p1:meta`,
    'buildPublishJob mints an envelope for the clean approved post');

  // ---- change the cover AFTER approval => flag raised, approval kept -----------
  const cov = await setCover({ campaign: CAMP, postId: 'p1', coverUrl: 'https://example.com/title-card.jpg' });
  ok(cov.ok, 'setCover succeeds on the approved post');
  p = getPost('p1');
  ok(p.cover && p.cover.source === 'url', 'the new cover is stored');
  ok(p.approval === 'approved', 'approval STAYS approved (flag, not auto-revert - mirrors a content edit)');
  ok(p.editedSinceApproval === true, 'a post-approval cover change raises editedSinceApproval');

  // ---- fail-closed at BOTH shared publish fences -----------------------------
  ok(!eligibleIds().includes('p1'), 'eligibleDuePosts EXCLUDES the post whose cover changed after approval');
  ok(throwsWith(() => buildPublishJob(getPost('p1'), 'meta', { clientId: 'default', campaign: CAMP }), 'edited_since_approval'),
    'buildPublishJob throws edited_since_approval (second fence)');

  // ---- re-approval clears it, and it fires again ------------------------------
  await approvePost({ campaign: CAMP, postId: 'p1', actor: 'owner' });
  ok(!getPost('p1').editedSinceApproval, 're-approval clears the flag');
  ok(eligibleIds().includes('p1'), 'the re-approved post is eligible again');

  // ---- CLEARING an approved post's cover is also a cover change ---------------
  // Removing the cover changes what publishes (e.g. IG falls back to a frame), so the
  // same trust gate applies - clearing must NOT be a bypass around setCover.
  const cleared = await clearCover({ campaign: CAMP, postId: 'p1' });
  ok(cleared.ok, 'clearCover succeeds on the approved post');
  p = getPost('p1');
  ok(!p.cover, 'the cover is removed');
  ok(p.approval === 'approved' && p.editedSinceApproval === true, 'clearing an approved cover raises editedSinceApproval');
  ok(!eligibleIds().includes('p1'), 'the cover-cleared post is fenced until re-approval');
  await approvePost({ campaign: CAMP, postId: 'p1', actor: 'owner' });
  ok(eligibleIds().includes('p1'), 're-approval re-arms it after the clear');

  // ---- clearing a cover on an approved post that HAS none is a no-op ----------
  await createPost({
    campaign: CAMP,
    post: { id: 'p3', type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'no-cover copy' },
    actor: 'agent:claude',
  });
  await approvePost({ campaign: CAMP, postId: 'p3', actor: 'owner' });
  const noop = await clearCover({ campaign: CAMP, postId: 'p3' });
  ok(noop.ok && !getPost('p3').editedSinceApproval, 'clearing a cover that was never set does NOT flag (nothing changed)');

  // ---- a cover-raised flag is STICKY: no later edit can clear it --------------
  // The cover never moves postContentHash, so the hash comparison in updatePost cannot
  // tell a cover-raised flag from a stale one. Before the fix a scheduling-only edit
  // found "content hash == approved hash" and deleted the flag, and the UNREVIEWED cover
  // published. Only a re-approval may release a flag raised for a non-hashed reason.
  await createPost({
    campaign: CAMP,
    post: { id: 'p4', type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'p4 approved copy' },
    actor: 'agent:claude',
  });
  await approvePost({ campaign: CAMP, postId: 'p4', actor: 'owner' });
  await setCover({ campaign: CAMP, postId: 'p4', coverUrl: 'https://example.com/p4-card.jpg' });
  ok(getPost('p4').editedSinceApproval === true, 'p4: set_cover on the approved post raises the flag');
  ok(rawPost('p4').stickyEditReason === 'cover', 'p4: the flag records WHY it was raised (stickyEditReason: cover)');

  let r = await updatePost({ campaign: CAMP, postId: 'p4', ifRev: getPost('p4').rev, fields: { scheduledAt: '2020-02-02T00:00:00Z' }, actor: 'owner' });
  ok(r.ok, 'p4: a reschedule-only edit succeeds');
  ok(getPost('p4').editedSinceApproval === true, 'p4: a reschedule-only edit does NOT clear a cover-raised flag');
  ok(!eligibleIds().includes('p4'), 'p4: the unreviewed cover stays fenced at eligibleDuePosts after the reschedule');
  ok(throwsWith(() => buildPublishJob(getPost('p4'), 'meta', { clientId: 'default', campaign: CAMP }), 'edited_since_approval'),
    'p4: buildPublishJob still refuses after the reschedule');

  r = await updatePost({ campaign: CAMP, postId: 'p4', ifRev: getPost('p4').rev, fields: { executionMode: 'fully-scheduled' }, actor: 'owner' });
  ok(r.ok && getPost('p4').editedSinceApproval === true, 'p4: an executionMode-only edit does NOT clear it either');

  // A hashed edit and its exact restore normally clear the flag; here the cover is still
  // unreviewed, so the restore must leave it raised.
  r = await updatePost({ campaign: CAMP, postId: 'p4', ifRev: getPost('p4').rev, fields: { caption: 'p4 temporary' }, actor: 'owner' });
  ok(r.ok && getPost('p4').editedSinceApproval === true, 'p4: a caption edit on top keeps it flagged');
  r = await updatePost({ campaign: CAMP, postId: 'p4', ifRev: getPost('p4').rev, fields: { caption: 'p4 approved copy' }, actor: 'owner' });
  ok(r.ok && getPost('p4').editedSinceApproval === true, 'p4: restoring the approved caption does NOT clear a cover-raised flag');
  ok(!eligibleIds().includes('p4'), 'p4: still fenced after the caption round trip');

  // Decision: set_cover then clear_cover is NOT treated as a restore. The cover has no
  // approved fingerprint to compare against, so any cover change on an approved post
  // holds it for the owner until re-approval (fail closed).
  await clearCover({ campaign: CAMP, postId: 'p4' });
  ok(!getPost('p4').cover && getPost('p4').editedSinceApproval === true,
    'p4: clearing the cover again (back to what was approved) still needs re-approval');
  ok(!eligibleIds().includes('p4'), 'p4: fenced after set_cover + clear_cover');

  // Re-approval releases everything, and the hash gate works normally afterwards.
  await approvePost({ campaign: CAMP, postId: 'p4', actor: 'owner' });
  ok(!getPost('p4').editedSinceApproval && rawPost('p4').stickyEditReason === undefined,
    'p4: re-approval clears the flag AND its sticky reason');
  ok(eligibleIds().includes('p4'), 'p4: the re-approved post is eligible again');
  r = await updatePost({ campaign: CAMP, postId: 'p4', ifRev: getPost('p4').rev, fields: { caption: 'p4 later edit' }, actor: 'owner' });
  ok(r.ok && getPost('p4').editedSinceApproval === true, 'p4: after re-approval a caption edit raises the flag (hash path)');
  r = await updatePost({ campaign: CAMP, postId: 'p4', ifRev: getPost('p4').rev, fields: { caption: 'p4 approved copy' }, actor: 'owner' });
  ok(r.ok && !getPost('p4').editedSinceApproval, 'p4: and restoring the approved caption clears a hash-raised flag again');

  // ---- a cover set on an UNapproved draft is never flagged --------------------
  await createPost({
    campaign: CAMP,
    post: { id: 'p2', type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'draft copy' },
    actor: 'agent:claude',
  });
  const cov2 = await setCover({ campaign: CAMP, postId: 'p2', coverUrl: 'https://example.com/draft-card.jpg' });
  ok(cov2.ok && !getPost('p2').editedSinceApproval, 'setting a cover on a draft never sets editedSinceApproval (nothing to invalidate)');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
