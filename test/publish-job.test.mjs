#!/usr/bin/env node
// test/publish-job.test.mjs - the cloud-ready publish-job seam (lib/publish-job.mjs).
//
// Locks the publish-job/1 envelope shape, the approval invariant (the SECOND
// fence: an unapproved or self-approved post can never be described), the
// no-secret guarantee (no caption/token/media bytes in the envelope, no firing
// actor), and the validator the cloud worker re-runs server-side.
//
// Zero-dep node:assert. A deliberately bogus PENDPOST_ROOT proves the builder is
// pure - it never reads the filesystem, so the wrong root cannot affect it.
import assert from 'node:assert';

process.env.PENDPOST_ROOT = '/nonexistent/bogus-root-proves-purity';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const { buildPublishJob, validatePublishJob, PublishJobError, PUBLISH_JOB_VERSION, isSelfApproved } =
  await import('../lib/publish-job.mjs');

// A normalized post (lib/plans.mjs normalizePost shape) that is approved, due, and
// not self-approved (creator is an agent, approver is the owner).
const SECRET = 'do-not-leak-this-caption-text';
const basePost = {
  id: 'p1',
  platforms: ['instagram', 'facebook'],
  type: 'reel',
  scheduledAt: '2026-06-20T10:00:00.000Z',
  approval: 'approved',
  createdBy: 'agent:claude',
  approvalBy: 'owner',
  approvalAt: '2026-06-20T09:00:00.000Z',
  caption: SECRET,
  media: { exists: true, path: '/abs/data/clients/default/renders/p1.mp4' },
  ids: { fbPostId: null, fbReelId: null, igMediaId: null, liPostId: null, ytVideoId: null, xPostId: null },
};
const metaCtx = {
  clientId: 'default', campaign: 'c1', planPath: 'data/plans/c1.json',
  command: 'publish-due', timeoutMs: 300_000, lanePlatforms: ['instagram', 'facebook'],
  now: Date.parse('2026-06-20T10:00:01.000Z'),
};

const throwsWith = (fn, code) => {
  try { fn(); } catch (e) {
    return e instanceof PublishJobError && e.code === code;
  }
  return false;
};

try {
  // ---- (1) shape + deterministic jobId ---------------------------------------
  const job = buildPublishJob(basePost, 'meta', metaCtx);
  ok(job.version === PUBLISH_JOB_VERSION && job.version === 'publish-job/1', 'envelope carries version "publish-job/1"');
  ok(job.jobId === 'default:c1:p1:meta', 'jobId is deterministic: clientId:campaign:postId:lane');
  ok(buildPublishJob(basePost, 'meta', metaCtx).jobId === job.jobId, 'the same inputs always yield the same jobId (idempotent)');
  for (const k of ['identity', 'lane', 'engine', 'delivery', 'approval', 'payloadRef']) {
    ok(Object.prototype.hasOwnProperty.call(job, k), `envelope has the required top-level key '${k}'`);
  }
  ok(job.identity.postId === 'p1' && job.identity.campaign === 'c1' && job.identity.planPath === 'data/plans/c1.json', 'identity carries postId, campaign, and the RELATIVE planPath');

  // ---- (2) engine fidelity (verbatim from ENGINES via ctx) -------------------
  ok(job.engine.command === 'publish-due' && job.engine.timeoutMs === 300_000, 'meta engine command/timeout pass through verbatim');
  const ytJob = buildPublishJob({ ...basePost, platforms: ['youtube'] }, 'youtube', {
    ...metaCtx, command: 'schedule', timeoutMs: 600_000, lanePlatforms: ['youtube'],
    now: Date.parse('2026-06-19T10:00:00.000Z'), scheduledAt: '2026-06-20T10:00:00.000Z',
  });
  ok(ytJob.engine.command === 'schedule' && ytJob.engine.timeoutMs === 600_000, 'youtube engine command/timeout pass through verbatim');

  // ---- (3) delivery mode: native survives power-off, live needs the runtime --
  ok(job.delivery.mode === 'live' && job.delivery.survivesPowerOff === false, 'a meta lane with instagram is live (needs the runtime), not power-off-safe');
  const fbOnly = buildPublishJob({ ...basePost, platforms: ['facebook'] }, 'meta', { ...metaCtx, lanePlatforms: ['facebook'] });
  ok(fbOnly.delivery.mode === 'native' && fbOnly.delivery.survivesPowerOff === true, 'a facebook-only meta lane is native (scheduled_publish_time), power-off-safe');
  ok(ytJob.delivery.mode === 'native' && ytJob.delivery.survivesPowerOff === true, 'a youtube lane is native (publishAt), power-off-safe');
  const liJob = buildPublishJob({ ...basePost, platforms: ['linkedin'] }, 'linkedin', { ...metaCtx, command: 'publish-due', timeoutMs: 180_000, lanePlatforms: ['linkedin'] });
  ok(liJob.delivery.mode === 'live' && liJob.delivery.survivesPowerOff === false, 'a linkedin lane is live (needs the runtime), not power-off-safe');

  // ---- (4) no-secret guarantee + no firing actor -----------------------------
  const serialized = JSON.stringify(job);
  ok(!serialized.includes(SECRET), 'the caption text never appears in the envelope (captionPresent is a boolean)');
  ok(job.payloadRef.captionPresent === true, 'payloadRef.captionPresent reflects a present caption without inlining it');
  ok(job.payloadRef.mediaPath === '/abs/data/clients/default/renders/p1.mp4', 'payloadRef.mediaPath is a path reference, never the media bytes');
  ok(!serialized.includes('scheduler') && !('actor' in job), 'the firing actor is NOT part of the envelope (a runtime credential, not data)');
  ok(job.payloadRef.ids && 'igMediaId' in job.payloadRef.ids, 'payloadRef carries the per-platform publish-evidence ids');

  // ---- (4b) thread chain reference (fire-time resolution seam) ---------------
  ok(job.payloadRef.xReplyTo === null, 'payloadRef.xReplyTo defaults to null for a non-reply post');
  const replyJob = buildPublishJob({ ...basePost, platforms: ['x'], xReplyTo: 'p0' }, 'x', { ...metaCtx, lanePlatforms: ['x'] });
  ok(replyJob.payloadRef.xReplyTo === 'p0', 'payloadRef.xReplyTo carries the sibling POST id (a reference for fire-time resolution, never a tweet id)');

  // ---- (5) approval invariant: unapproved is refused -------------------------
  ok(throwsWith(() => buildPublishJob({ ...basePost, approval: 'draft' }, 'meta', metaCtx), 'not_approved'), 'a draft post is refused (code not_approved)');
  ok(throwsWith(() => buildPublishJob({ ...basePost, approval: 'pending' }, 'meta', metaCtx), 'not_approved'), 'a pending post is refused (code not_approved)');
  ok(throwsWith(() => buildPublishJob({ ...basePost, approval: 'rejected' }, 'meta', metaCtx), 'not_approved'), 'a rejected post is refused (code not_approved)');

  // ---- (5b) trust gate: an approved-but-edited post is refused (second fence) -
  ok(throwsWith(() => buildPublishJob({ ...basePost, editedSinceApproval: true }, 'meta', metaCtx), 'edited_since_approval'), 'an approved post edited after approval is refused (code edited_since_approval)');
  ok(buildPublishJob({ ...basePost, editedSinceApproval: false }, 'meta', metaCtx).jobId === 'default:c1:p1:meta', 'editedSinceApproval:false does not block a clean approved post');

  // ---- (6) approval invariant: self-approval is refused, owner is exempt -----
  ok(throwsWith(() => buildPublishJob({ ...basePost, createdBy: 'agent:claude', approvalBy: 'agent:claude' }, 'meta', metaCtx), 'self_approved'), 'a post approved by its own creator is refused (code self_approved)');
  const ownerApproved = buildPublishJob({ ...basePost, createdBy: 'owner', approvalBy: 'owner' }, 'meta', metaCtx);
  ok(ownerApproved.approval.approvedBy === 'owner' && ownerApproved.approval.selfApproved === false, 'the owner is the exempt approval authority: owner-created + owner-approved builds');
  ok(isSelfApproved('agent:claude', 'agent:claude') === true && isSelfApproved('agent:claude', 'owner') === false && isSelfApproved(null, null) === false, 'isSelfApproved mirrors lib/writes.mjs: creator==approver and approver!=owner');

  // ---- (7) unknown lane is refused -------------------------------------------
  ok(throwsWith(() => buildPublishJob(basePost, 'acmesocial', metaCtx), 'unknown_lane'), 'an unknown lane is refused (code unknown_lane)');

  // ---- (8) validator parity (the cloud re-check) -----------------------------
  ok(validatePublishJob(job).ok === true, 'validatePublishJob accepts a well-formed approved job');
  ok(validatePublishJob({ ...job, version: 'publish-job/99' }).code === 'unknown_version', 'validatePublishJob rejects an unknown version');
  ok(validatePublishJob({ ...job, approval: { ...job.approval, state: 'draft' } }).code === 'not_approved', 'validatePublishJob rejects a non-approved state');
  ok(validatePublishJob({ ...job, approval: { ...job.approval, selfApproved: true } }).code === 'self_approved', 'validatePublishJob rejects a self-approved flag');
  ok(validatePublishJob({ ...job, approval: { state: 'approved', createdBy: 'x', approvedBy: 'x' } }).code === 'self_approved', 'validatePublishJob re-derives self-approval from createdBy/approvedBy');
  ok(validatePublishJob(null).code === 'invalid_input', 'validatePublishJob rejects a non-object');

  // ---- (9) purity: the bogus PENDPOST_ROOT never mattered --------------------
  ok(Object.isFrozen(job) && Object.isFrozen(job.identity) && Object.isFrozen(job.payloadRef.ids), 'the envelope is deeply frozen (immutable contract)');
  ok(buildPublishJob(basePost, 'meta', { ...metaCtx, clientId: 'acme' }).jobId === 'acme:c1:p1:meta', 'the builder read no disk: a bogus PENDPOST_ROOT had no effect on the pure result');

  console.log(`[publish-job] OK - publish-job/1 envelope shape, approval fence (unapproved + self-approval refused), no-secret + no-actor guarantee, validator parity, purity (${pass} assertions).`);
} catch (err) {
  console.error(`[publish-job] FAIL: ${err.message}`);
  process.exitCode = 1;
}
