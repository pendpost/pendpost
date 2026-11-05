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

  // ---- LEGACY approved post (approved before approvedContentHash existed) -----
  // Such a post has approval:'approved' but no stamped hash on disk. The gate must
  // still catch a content edit, by comparing the content BEFORE vs AFTER the edit,
  // and must still let a scheduling-only edit through untouched.
  const planFile = path.join(WS, 'data', 'plans', CAMP, 'post-plan.json');
  const readRaw = (id) => JSON.parse(fs.readFileSync(planFile, 'utf8')).posts.find((x) => x.id === id);
  const makeLegacy = (id, extra = {}) => {
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    const post = plan.posts.find((x) => x.id === id);
    delete post.approvedContentHash;
    delete post.legacyBaselineHash;
    delete post.editedSinceApproval;
    Object.assign(post, extra);
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  };
  const { mintAuthorizations } = await import('../lib/receipts.mjs');
  const mint = (id) => mintAuthorizations({ campaign: CAMP, post: { id }, lane: 'meta', planAbs: planFile, platforms: ['instagram'], clientId: 'default', now: Date.now() });

  await createPost({
    campaign: CAMP,
    post: { id: 'legacy', type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'legacy approved copy' },
    actor: 'agent:claude',
  });
  await approvePost({ campaign: CAMP, postId: 'legacy', actor: 'owner' });
  makeLegacy('legacy');
  ok(getPost('legacy').approval === 'approved' && !readRaw('legacy').approvedContentHash,
    'legacy fixture: approved with no approvedContentHash on disk');
  ok(eligibleIds().includes('legacy'), 'an untouched legacy approved post stays eligible (no behaviour change)');

  // Scheduling-only edit: not re-raised, and the raw post is left without a hash so the
  // receipt path keeps reporting no_fingerprint exactly as before.
  p = getPost('legacy');
  r = await updatePost({ campaign: CAMP, postId: 'legacy', ifRev: p.rev, fields: { scheduledAt: '2020-03-03T00:00:00Z' }, actor: 'owner' });
  ok(r.ok && !getPost('legacy').editedSinceApproval, 'legacy approved + scheduledAt-only edit is NOT re-raised');
  ok(!readRaw('legacy').approvedContentHash, 'a scheduling-only edit stamps no hash on a legacy post');
  ok(eligibleIds().includes('legacy'), 'the rescheduled legacy post stays eligible');
  ok((await mint('legacy')).unattested === 'no_fingerprint', 'receipts: an untouched legacy post still fires unattested (no_fingerprint)');
  p = getPost('legacy');
  r = await updatePost({ campaign: CAMP, postId: 'legacy', ifRev: p.rev, fields: { executionMode: 'parked' }, actor: 'owner' });
  ok(r.ok && !getPost('legacy').editedSinceApproval, 'legacy approved + executionMode-only edit is NOT re-raised');
  p = getPost('legacy');
  await updatePost({ campaign: CAMP, postId: 'legacy', ifRev: p.rev, fields: { executionMode: 'fully-scheduled' }, actor: 'owner' });

  // Caption edit: re-raised, and the PRE-edit content is stamped as the approved baseline.
  const legacyBaseline = postContentHash(readRaw('legacy'));
  p = getPost('legacy');
  r = await updatePost({ campaign: CAMP, postId: 'legacy', ifRev: p.rev, fields: { caption: 'legacy UNREVIEWED edit' }, actor: 'owner' });
  ok(r.ok, 'a caption edit to a legacy approved post succeeds');
  ok(getPost('legacy').approval === 'approved', 'legacy: approval STAYS approved');
  ok(getPost('legacy').editedSinceApproval === true, 'legacy approved + caption edit RE-RAISES editedSinceApproval');
  ok(readRaw('legacy').legacyBaselineHash === legacyBaseline, 'the pre-edit content hash is recorded as legacyBaselineHash');
  ok(!readRaw('legacy').approvedContentHash, 'no approvedContentHash is minted from an edit (only the approve path stamps one)');
  ok(!eligibleIds().includes('legacy'), 'eligibleDuePosts EXCLUDES the edited legacy post');
  ok(throwsWith(() => buildPublishJob(getPost('legacy'), 'meta', { clientId: 'default', campaign: CAMP }), 'edited_since_approval'),
    'buildPublishJob (cloud push) refuses the edited legacy post');
  ok((await mint('legacy')).unattested === 'no_fingerprint', 'receipts: the legacy baseline is never treated as an approval fingerprint');

  // Once stamped, the legacy post converges on the hashed path: a further scheduling
  // edit keeps the flag, restoring the baseline content clears it.
  p = getPost('legacy');
  r = await updatePost({ campaign: CAMP, postId: 'legacy', ifRev: p.rev, fields: { scheduledAt: '2020-04-04T00:00:00Z' }, actor: 'owner' });
  ok(r.ok && getPost('legacy').editedSinceApproval === true, 'a later scheduling edit does not clear the legacy flag');
  p = getPost('legacy');
  r = await updatePost({ campaign: CAMP, postId: 'legacy', ifRev: p.rev, fields: { caption: 'legacy approved copy' }, actor: 'owner' });
  ok(r.ok && !getPost('legacy').editedSinceApproval, 'restoring the legacy approved content clears the flag');
  ok(eligibleIds().includes('legacy'), 'the restored legacy post is eligible again');
  ok((await mint('legacy')).unattested === 'no_fingerprint', 'receipts: an edit + restore does not launder the legacy post into an attested one');

  // Re-approval re-stamps the hash of the current content.
  await updatePost({ campaign: CAMP, postId: 'legacy', ifRev: getPost('legacy').rev, fields: { caption: 'legacy edit two' }, actor: 'owner' });
  await approvePost({ campaign: CAMP, postId: 'legacy', actor: 'owner' });
  ok(!getPost('legacy').editedSinceApproval && readRaw('legacy').approvedContentHash === postContentHash(readRaw('legacy')),
    're-approving the edited legacy post stamps the hash of the current content');
  ok(!('legacyBaselineHash' in readRaw('legacy')), 're-approval drops the legacy baseline');

  // Other content fields on a legacy post: platforms and alsoStory re-raise too.
  for (const [label, fields] of [['platforms', { platforms: ['instagram', 'facebook'] }], ['alsoStory', { alsoStory: true }]]) {
    makeLegacy('legacy');
    p = getPost('legacy');
    r = await updatePost({ campaign: CAMP, postId: 'legacy', ifRev: p.rev, fields, actor: 'owner' });
    ok(r.ok && getPost('legacy').editedSinceApproval === true, `legacy approved + ${label} edit RE-RAISES editedSinceApproval`);
    await updatePost({ campaign: CAMP, postId: 'legacy', ifRev: getPost('legacy').rev, fields: { [label]: label === 'platforms' ? ['instagram'] : null }, actor: 'owner' });
    ok(!getPost('legacy').editedSinceApproval, `undoing the legacy ${label} edit clears the flag`);
  }

  // A legacy post ALREADY flagged (no hash) has no known baseline: stays flagged
  // fail-closed on every later edit, and no hash is invented for it.
  makeLegacy('legacy', { editedSinceApproval: true });
  p = getPost('legacy');
  r = await updatePost({ campaign: CAMP, postId: 'legacy', ifRev: p.rev, fields: { scheduledAt: '2020-05-05T00:00:00Z' }, actor: 'owner' });
  ok(r.ok && getPost('legacy').editedSinceApproval === true, 'an already-flagged legacy post stays flagged on a scheduling edit');
  p = getPost('legacy');
  r = await updatePost({ campaign: CAMP, postId: 'legacy', ifRev: p.rev, fields: { caption: 'yet another edit' }, actor: 'owner' });
  ok(r.ok && getPost('legacy').editedSinceApproval === true && !readRaw('legacy').approvedContentHash && !readRaw('legacy').legacyBaselineHash,
    'an already-flagged legacy post stays flagged on a content edit and gets no invented baseline');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
