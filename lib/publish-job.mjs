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
// 'bluesky', a contract-reserved lane name (docs/specs/cloud-integration-contract.md,
// pendpost-cloud LANE_CAPABILITIES) with NO engine on either side yet - it stays a
// valid envelope word but is never owed (lanesOwed) and never cloud-deferred
// (CLOUD_LANES), so no job is ever built for it. Plus the native-scheduling recovery
// lanes (mastodon-resolve, wordpress-release, ghost-release). An unknown lane is
// refused rather than silently described.
const KNOWN_LANES = new Set(['meta', 'linkedin', 'x', 'youtube', 'youtube-release', 'youtube-reply', 'bluesky', 'telegram', 'discord', 'reddit', 'pinterest', 'tiktok', 'mastodon', 'mastodon-resolve', 'wordpress', 'wordpress-release', 'ghost', 'ghost-release', 'nostr', 'nostr-reply', 'gbp']);

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
// natively (NATIVE_SCHEDULING_PLATFORMS: FB/YouTube/Mastodon/WordPress/Ghost) and
// therefore survives the machine being off. A mixed meta lane (instagram +
// facebook) holds a live lane (instagram), so it is 'live'. An empty set is
// 'live' (a runtime is needed) - never silently native.
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
  // Second fence for the trust gate: an approved post edited after approval is
  // treated as unapproved until re-approved (the copy diverges from what the owner
  // blessed). The scheduler's eligibleDuePosts already skips it; this refusal guards
  // any other caller and keeps a stale-approved envelope from ever being minted.
  if (post.editedSinceApproval) {
    throw new PublishJobError('edited_since_approval', `post ${post.id} was edited after approval and must be re-approved`);
  }
  if (isSelfApproved(post.createdBy, post.approvalBy)) {
    throw new PublishJobError('self_approved', `post ${post.id} was approved by its creator '${post.createdBy}' (no self-approval)`);
  }
  // The client sign-off fence (spec 48 R10, W4), byte-for-byte the editedSinceApproval
  // precedent above: under two-step mode an operator/owner approve is only a "send for
  // sign-off" - the post is publishable ONLY once a NAMED reviewer (reviewer:*) signs it.
  // Stays a PURE function: the caller passes the per-client review.required through ctx
  // (the scheduler resolves it once), so the builder itself never reads config. The
  // scheduler's eligibleDuePosts already skips these; this is the independent second
  // fence for any other envelope builder (a malformed path can never envelope an
  // unsigned post).
  if (ctx.reviewRequired === true && !/^reviewer:/.test(post.approvalBy || '')) {
    throw new PublishJobError('awaiting_client_signoff', `post ${post.id} awaits client sign-off (review.required is on and it is not yet approved by a reviewer)`);
  }
  // Enforced pre-flight fence, independent second gate (byte-for-byte the editedSince /
  // signoff precedent above): the caller resolves the per-lane readiness verdict once and
  // passes it via ctx.preflight, so this pure builder never reads config/accounts. When the
  // verdict is not ready, no envelope is minted - a malformed path can never queue a post
  // that fails a platform's content check. Dormant unless a caller supplies ctx.preflight
  // (the scheduler drops blocked lanes before it gets here; the cloud push stamps the
  // verdict for the cloud recheck). The verdict also rides in the envelope below.
  if (ctx.preflight && ctx.preflight.ok === false) {
    const first = Array.isArray(ctx.preflight.blockers) && ctx.preflight.blockers[0];
    const where = first ? ` (${first.platform || 'lane'})` : '';
    throw new PublishJobError('not_ready', `post ${post.id} has an unresolved pre-flight blocker${where} and must be fixed and re-approved`);
  }

  const {
    clientId = 'default', campaign = null, planPath = null,
    command = null, timeoutMs = null, lanePlatforms = null, now = Date.now(),
    expectedAccounts = null, preflight = null,
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
      // Thread chain: the sibling POST id this post replies to (X threads). A
      // REFERENCE the dispatcher resolves at FIRE TIME - the parent's minted
      // tweet id cannot exist at enqueue time, so a per-job plan snapshot can
      // never carry it (the 2026-07-08 launch-thread incident). A consumer that
      // fires per-post jobs resolves the parent's live id (cloud: from the
      // parent job's result; local: from the live plan) and injects it via the
      // engine's --reply-to-id override instead of trusting a frozen snapshot.
      xReplyTo: post.xReplyTo || null,
      // Spec 34: reply-to-EXTERNAL target ({ url, source, externalId, resolvedId? }) - the
      // Radar signal thread this post replies to. ADDITIVE + non-breaking (null for every
      // non-Radar-reply post), so publish-job/N is NOT bumped. UNLIKE xReplyTo the target
      // already exists (an external thread), so the dispatcher needs no fire-time id
      // resolution - the engine reads it from the plan and replies to that exact thread.
      radarReplyTo: post.radarReplyTo || null,
      // Spec 10: the native-poll structure a poll TYPE fires. ADDITIVE + non-breaking
      // (a null for every non-poll post) so publish-job/N is NOT bumped. The cloud
      // worker's x/linkedin/telegram/discord/nostr publishers read this to assemble
      // the lane's native poll and re-validate the option/duration caps server-side
      // (the REQUIRED pendpost-cloud companion change, docs/specs/cloud-integration-contract.md).
      // The question stays the caption (captionPresent), never inlined here.
      poll: post.poll
        ? Object.freeze({
          options: Object.freeze(Array.isArray(post.poll.options) ? [...post.poll.options] : []),
          durationMinutes: post.poll.durationMinutes || null,
          multiple: post.poll.multiple === true,
        })
        : null,
      // The platform ACCOUNT this post is approved to land on, per platform, read by
      // the CALLER from the owning client's own .env (lib/cloud-client.mjs
      // expectedAccountsFor -> PLATFORM_ACCOUNT_IDS). This module stays PURE, so the
      // values arrive via ctx and are never read from env here.
      //
      // The second, independent destination fence: an executor that resolves a
      // different account for a platform must REFUSE rather than publish. On
      // 2026-07-25 a bondigoo post published onto the pendpost Instagram account
      // because nothing downstream could tell that the credential belonged to another
      // brand; with this present it can.
      //
      // ADDITIVE + non-breaking (null for any caller that does not supply it), so
      // publish-job/N is NOT bumped - the same treatment as radarReplyTo and poll.
      // Deliberately NOT retrofittable: a job already queued in the cloud keeps its
      // frozen envelope (a re-push hits onConflictDoNothing and never updates a queued
      // row), so those jobs rely on brand-scoped credential resolution instead.
      expectedAccounts: expectedAccounts && typeof expectedAccounts === 'object'
        ? Object.freeze({ ...expectedAccounts })
        : null,
      // Current per-platform publish evidence so a consumer can skip an
      // already-fired lane.
      ids: Object.freeze({
        fbPostId: ids.fbPostId || null,
        fbReelId: ids.fbReelId || null,
        igMediaId: ids.igMediaId || null,
        liPostId: ids.liPostId || null,
        ytVideoId: ids.ytVideoId || null,
        xPostId: ids.xPostId || null,
        tgMessageId: ids.tgMessageId || null,
        dcMessageId: ids.dcMessageId || null,
        redditPostId: ids.redditPostId || null,
        pinId: ids.pinId || null,
        tiktokVideoId: ids.tiktokVideoId || null,
        mastodonStatusId: ids.mastodonStatusId || null,
        mastodonScheduledId: ids.mastodonScheduledId || null,
        wordpressPostId: ids.wordpressPostId || null,
        ghostPostId: ids.ghostPostId || null,
        nostrEventId: ids.nostrEventId || null,
        gbpPostId: ids.gbpPostId || null,
      }),
    }),
    // The pre-flight readiness verdict the CALLER resolved for this lane
    // ({ ok, blockers:[{platform, problems}] }), stamped so the cloud can refuse a
    // not-ready envelope at INGEST (defense in depth). The builder stays PURE - the
    // verdict arrives via ctx, never computed from config here. ADDITIVE + non-breaking
    // (null for any caller that does not supply it), so publish-job/N is NOT bumped -
    // same treatment as expectedAccounts. NOT authoritative at FIRE time: a re-pushed
    // edit can leave a stale verdict on the queued message, so the worker rechecks the
    // fresh staged bytes instead of trusting this. See the cloud contract.
    preflight: preflight && typeof preflight === 'object'
      ? Object.freeze({ ok: preflight.ok !== false, blockers: Object.freeze(Array.isArray(preflight.blockers) ? [...preflight.blockers] : []) })
      : null,
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
