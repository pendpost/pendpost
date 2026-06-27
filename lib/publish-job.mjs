// publish-job.mjs - the cloud-ready publish-job seam (PURE, no I/O).
//
// buildPublishJob() turns ONE approved, due post plus ONE engine lane into a
// frozen "publish-job/1" envelope: the complete, self-contained description the
// always-on runtime needs to fire that one lane. It is the contract the
// proprietary pendpost-cloud worker consumes (docs/specs/cloud-integration-contract.md);
// the MIT core ships exactly one consumer of it (the local scheduler, whose
// publish behavior stays byte-identical to before this seam existed).
//
// Two properties make this safe to ship in the open core:
//   1. It is a pure function - no disk, no network, no env reads. Everything it
//      needs arrives via the post and the ctx, so it is trivially testable and
//      can never have a side effect on the publish path.
//   2. It is a SECOND, independent approval fence. The scheduler already filters
//      to approval === 'approved' before it calls this; buildPublishJob refuses,
//      a second time, to describe a publish for an unapproved or self-approved
//      post, mirroring the no-self-approval rule enforced in lib/writes.mjs
//      (setApproval). A job can therefore never describe a publish the approval
//      gate would forbid - in either repo.
//
// The firing actor (e.g. 'scheduler') is a runtime credential, NOT data, so it is
// deliberately absent from the envelope; it stays a dispatch-time argument.

import { NATIVE_SCHEDULING_PLATFORMS } from './plans.mjs';

export const PUBLISH_JOB_VERSION = 'publish-job/1';

// The engine lanes the seam knows about. Mirrors lib/scheduler.mjs ENGINES plus
// the credential-gated bluesky lane; an unknown lane is refused rather than
// silently described.
const KNOWN_LANES = new Set(['meta', 'linkedin', 'x', 'youtube', 'bluesky']);

export class PublishJobError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PublishJobError';
    this.code = code;
  }
}

// The no-self-approval predicate, byte-for-byte the rule enforced at
// lib/writes.mjs setApproval: the creator may never be the approver UNLESS the
// approver is the owner (the platform's sole approval authority, exempt so
// composer-created posts can be approved at all). Exported so the validator and
// the cloud worker reuse the exact same predicate.
export function isSelfApproved(createdBy, approvedBy) {
  return Boolean(createdBy) && createdBy === approvedBy && approvedBy !== 'owner';
}

// A lane delivers 'native' only when EVERY platform it publishes schedules
// natively (Facebook scheduled_publish_time, YouTube publishAt) and therefore
// survives the machine being off. A mixed meta lane (instagram + facebook) holds
// a live lane (instagram), so it is 'live'. An empty set is 'live' (a runtime is
// needed) - never silently native.
function deliveryModeFor(lanePlatforms) {
  const allNative = Array.isArray(lanePlatforms)
    && lanePlatforms.length > 0
    && lanePlatforms.every((p) => NATIVE_SCHEDULING_PLATFORMS.has(p));
  return allNative ? 'native' : 'live';
}

// Build one publish-job envelope. THROWS PublishJobError for an unknown lane, a
// non-object post, an unapproved post (code 'not_approved'), or a self-approved
// post (code 'self_approved'). The scheduler's approval filter means it never
// throws in normal operation; the throw is the second fence for any future caller.
//
// post: a normalized post (lib/plans.mjs normalizePost) - post.ids.*,
//       post.approval/createdBy/approvalBy/approvalAt, post.media.path, post.caption.
// ctx: { clientId, campaign, planPath, command, timeoutMs, lanePlatforms, now }.
export function buildPublishJob(post, lane, ctx = {}) {
  if (!KNOWN_LANES.has(lane)) {
    throw new PublishJobError('unknown_lane', `unknown engine lane '${lane}'`);
  }
  if (!post || typeof post !== 'object') {
    throw new PublishJobError('invalid_input', 'post must be an object');
  }
  if (post.approval !== 'approved') {
    throw new PublishJobError('not_approved', `post ${post.id} is not approved (approval='${post.approval || 'draft'}')`);
  }
  if (isSelfApproved(post.createdBy, post.approvalBy)) {
    throw new PublishJobError('self_approved', `post ${post.id} was approved by its creator '${post.createdBy}' (no self-approval)`);
  }

  const {
    clientId = 'default', campaign = null, planPath = null,
    command = null, timeoutMs = null, lanePlatforms = null, now = Date.now(),
  } = ctx;
  const platforms = Array.isArray(post.platforms) ? post.platforms : [];
  // Fall back to the post's own platforms when the caller did not pre-compute the
  // lane's owned subset (keeps the builder usable outside the scheduler).
  const lanePlats = Array.isArray(lanePlatforms) && lanePlatforms.length ? lanePlatforms : platforms;
  const mode = deliveryModeFor(lanePlats);
  const ids = (post.ids && typeof post.ids === 'object') ? post.ids : {};

  return Object.freeze({
    version: PUBLISH_JOB_VERSION,
    // Deterministic, idempotent identity: the same (client, campaign, post, lane)
    // always yields the same jobId, so a consumer can dedupe re-sends.
    jobId: `${clientId}:${campaign}:${post.id}:${lane}`,
    issuedAt: new Date(now).toISOString(),
    identity: Object.freeze({
      clientId,
      campaign,
      postId: post.id,
      // Relative to the client root: the cloud re-resolves it under its own root;
      // the local dispatcher resolves it against activeRoot() (see scheduler).
      planPath,
    }),
    lane,
    engine: Object.freeze({ command, timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : null }),
    delivery: Object.freeze({
      mode,
      scheduledAt: post.scheduledAt || null,
      // true => the platform's own scheduler fires it (survives power-off);
      // false => the runtime must publish it at fire-time.
      survivesPowerOff: mode === 'native',
    }),
    // The approval PROOF, copied from the post, never recomputed downstream.
    approval: Object.freeze({
      state: 'approved',
      approvedBy: post.approvalBy || null,
      approvedAt: post.approvalAt || null,
      createdBy: post.createdBy || null,
      selfApproved: false, // proven false by the guard above
    }),
    // A REFERENCE, never the bytes: no caption text, no tokens, no media payload
    // ever travels in the envelope, so it is safe to persist and log structurally.
    payloadRef: Object.freeze({
      type: post.type || null,
      platforms: Object.freeze([...platforms]),
      lanePlatforms: Object.freeze([...lanePlats]),
      mediaPath: (post.media && post.media.path) || null,
      captionPresent: Boolean(post.caption),
      // Current per-platform publish evidence so a consumer can skip an
      // already-fired lane.
      ids: Object.freeze({
        fbPostId: ids.fbPostId || null,
        fbReelId: ids.fbReelId || null,
        igMediaId: ids.igMediaId || null,
        liPostId: ids.liPostId || null,
        ytVideoId: ids.ytVideoId || null,
        xPostId: ids.xPostId || null,
      }),
    }),
  });
}

// validatePublishJob: the verdict form the always-on runtime re-runs server-side
// before it fires a job (defense in depth: an envelope could be stale or forged).
// PURE; never throws. Returns { ok:true, job } or { ok:false, code, message }.
// Re-checks the version AND the approval invariant (state approved, not
// self-approved), so a job can never describe a publish the gate would forbid.
export function validatePublishJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, code: 'invalid_input', message: 'job must be an object' };
  if (job.version !== PUBLISH_JOB_VERSION) return { ok: false, code: 'unknown_version', message: `unsupported version '${job.version}'` };
  if (!KNOWN_LANES.has(job.lane)) return { ok: false, code: 'unknown_lane', message: `unknown lane '${job.lane}'` };
  if (!job.identity || !job.identity.postId) return { ok: false, code: 'invalid_input', message: 'job.identity.postId is required' };
  const a = job.approval || {};
  if (a.state !== 'approved') return { ok: false, code: 'not_approved', message: 'job approval.state is not approved' };
  if (a.selfApproved === true || isSelfApproved(a.createdBy, a.approvedBy)) {
    return { ok: false, code: 'self_approved', message: 'job was self-approved (creator approved their own post)' };
  }
  return { ok: true, job };
}
