// writes.mjs - the Phase D write matrix (MCP-4): post CRUD, approval,
// scheduling moves, campaign CRUD, token refresh, health.
//
// Every plan mutation goes through planWrite.mjs#mutatePlan (shared mkdir
// lockfile + atomic write - the same protocol the engines use), re-reads the
// post from disk INSIDE the lock and enforces ifRev there, so a 409 can never
// race an engine save. Approval is fail-closed end to end: plan_create_post
// forces approval:'draft'; plan_update_post refuses approval fields outright;
// only approve_post/reject_post (required actor, no self-approval) flip it.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { REPO_ROOT, errorBody, atomicWriteJson, logLine } from './util.mjs';
import { activeRoot, withClient } from './context.mjs';
import { clientRoot, readRegistry } from './multi-client.mjs';
import { listClients } from './clients.mjs';
import { loadManifest, loadPlanStore, postRev, resolveMediaPath, postNeedsMedia } from './plans.mjs';
import { mutatePlan, withPlanLock } from './planWrite.mjs';
import { inFlight, appendActivity } from './scheduler.mjs';
import { probeMedia, specChecks, rendersDir, sanitizeAssetName } from './assets.mjs';
import { extractDefaultCover } from './covers.mjs';
import { accountStatus } from './accounts.mjs';
import { loadState, isMetaBlocked } from './state.mjs';
import { allPostPlatforms, allLanes } from './drivers/interface.mjs';
import { resolveMode, platformEnabled } from './mode.mjs';
import { getPosting } from './config.mjs';
import { setupStatus } from './setup.mjs';
import { autoApproveDecision, AUTO_APPROVE_ACTOR } from './auto-approve.mjs';

const ID_RE = /^[a-zA-Z0-9_-]+$/;
// The four built-in post platforms PLUS any platform a registered lane owns
// (drivers/registry.json, extensibility-sdk.md #3), resolved at call time so a
// dropped-in driver is accepted without a restart. Absent registry -> the four.
const PLATFORMS = () => allPostPlatforms();
// 'text' is a media-less LinkedIn text/article post (carries an optional `link`);
// the LinkedIn engine posts commentary + an article share with no upload.
const TYPES = ['reel', 'story', 'video', 'text', 'youtube-short', 'youtube-longform'];
// The manifest lives under the ACTIVE client's data/ (activeRoot()), resolved at
// call time so withClient()/the active client are honored; the legacy fallback
// (no clients.json) resolves to DATA_ROOT exactly as before.
function manifestPath() {
  return path.join(activeRoot(), 'data', 'plans', 'active-plans.json');
}

// Owner-editable fields plan_update_post may touch. NEVER approval fields
// (approve_post/reject_post own those), never engine-owned publish results,
// never cover (set_cover/clear_cover own that).
const UPDATABLE_FIELDS = ['caption', 'firstComment', 'title', 'scheduledAt', 'platforms', 'type', 'file', 'path', 'executionMode', 'link', 'image', 'description', 'liDescription', 'xCaption', 'tags', 'blogSlug', 'audience', 'interactiveStory', 'hashtags', 'captionPath', 'captionLang'];

// The seven Instagram story sticker kinds (US-FR-04). Per ../platform-constraints.md
// every kind except 'mention' is preview-only via the Graph API: pendpost models +
// previews them, but NEVER claims it applies them automatically (mention is the only
// programmatically-eligible kind, IG-only). The data model captures intent; the
// publish path/checklist surfaces the honesty - it does not over-promise the API.
const STICKER_KINDS = ['poll', 'question', 'link', 'mention', 'location', 'hashtag', 'music'];

export function execScript(script, args, timeoutMs) {
  return new Promise((resolve) => {
    // process.execPath, never bare 'node' (launchd PATH lacks Homebrew/nvm).
    // The engines self-root on PENDPOST_ROOT; point them at the ACTIVE client
    // subtree so refresh/insights operate inside that client's data/ + .env.
    execFile(process.execPath, [script, ...args], { cwd: REPO_ROOT, env: { ...process.env, PENDPOST_ROOT: activeRoot() }, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      let envelope = null;
      try {
        envelope = JSON.parse(String(stdout).trim().split('\n').pop());
      } catch { /* script died before printing an envelope */ }
      resolve({ err, envelope, stderrTail: String(stderr).slice(-400) });
    });
  });
}

function findPlanEntry(campaignId) {
  const { plans, error } = loadManifest();
  if (error) return { error: errorBody('manifest_error', error) };
  const entry = plans.find((p) => p.id === campaignId);
  if (!entry) return { error: errorBody('unknown_campaign', `unknown campaign: ${campaignId}`) };
  return { entry, absPlan: path.resolve(activeRoot(), entry.path) };
}

function requireIds(campaign, postId = undefined) {
  if (typeof campaign !== 'string' || !ID_RE.test(campaign)) {
    return errorBody('invalid_input', 'campaign must be a [a-zA-Z0-9_-]+ id');
  }
  if (postId !== undefined && (typeof postId !== 'string' || !ID_RE.test(postId))) {
    return errorBody('invalid_input', 'postId must be a [a-zA-Z0-9_-]+ id');
  }
  return null;
}

function requireActor(actor) {
  if (typeof actor !== 'string' || !actor.trim() || actor.trim().toLowerCase() === 'unknown') {
    return errorBody('invalid_input', 'actor is required (who is doing this - e.g. "owner", "agent:claude")');
  }
  return null;
}

function inFlightGuard(campaign, postId) {
  if (inFlight.has(`${campaign}/${postId}`)) {
    return errorBody('in_flight', `${campaign}/${postId} is being published right now`, { retryAfter: 60 });
  }
  return null;
}

export function validateFieldValues(fields) {
  if (fields.type !== undefined && !TYPES.includes(fields.type)) {
    return errorBody('invalid_input', `type must be one of ${TYPES.join('|')}`);
  }
  if (fields.platforms !== undefined) {
    const allowed = PLATFORMS();
    if (!Array.isArray(fields.platforms) || !fields.platforms.length || fields.platforms.some((p) => !allowed.includes(p))) {
      return errorBody('invalid_input', `platforms must be a non-empty array out of ${allowed.join('|')}`);
    }
  }
  if (fields.scheduledAt !== undefined && fields.scheduledAt !== null && Number.isNaN(Date.parse(fields.scheduledAt))) {
    return errorBody('invalid_input', 'scheduledAt must be an ISO-8601 datetime (or null)');
  }
  if (fields.executionMode !== undefined && !['fully-scheduled', 'parked'].includes(fields.executionMode)) {
    return errorBody('invalid_input', 'executionMode must be fully-scheduled|parked');
  }
  for (const k of ['caption', 'firstComment', 'title', 'file', 'path', 'link', 'image', 'description', 'liDescription', 'xCaption', 'tags', 'blogSlug', 'audience', 'captionPath', 'captionLang']) {
    if (fields[k] !== undefined && fields[k] !== null && typeof fields[k] !== 'string') {
      return errorBody('invalid_input', `${k} must be a string`);
    }
  }
  // link (article URL) and image (article-card thumbnail URL) are both absolute http(s) URLs.
  for (const k of ['link', 'image']) {
    if (fields[k] !== undefined && fields[k] !== null && !/^https?:\/\//.test(fields[k])) {
      return errorBody('invalid_input', `${k} must be an absolute http(s) URL`);
    }
  }
  // hashtags: per-post override of the global posting.hashtagPresets - an array of
  // strings, null clears it back to "inherit global" (handled by the create/update seam).
  if (fields.hashtags !== undefined && fields.hashtags !== null) {
    if (!Array.isArray(fields.hashtags) || fields.hashtags.some((t) => typeof t !== 'string')) {
      return errorBody('invalid_input', 'hashtags must be an array of strings');
    }
  }
  // interactiveStory: { stickers: [ { kind, ...fields, x?, y? } ] }; null clears it.
  // Validate the envelope + each sticker's kind + optional 0..1 x/y layout, NOT every
  // per-kind field (the kinds carry free-form authoring fields the composer owns).
  if (fields.interactiveStory !== undefined && fields.interactiveStory !== null) {
    const is = fields.interactiveStory;
    if (typeof is !== 'object' || Array.isArray(is)) {
      return errorBody('invalid_input', 'interactiveStory must be an object { stickers: [...] } (or null)');
    }
    if (is.stickers !== undefined) {
      if (!Array.isArray(is.stickers)) {
        return errorBody('invalid_input', 'interactiveStory.stickers must be an array');
      }
      for (const s of is.stickers) {
        if (!s || typeof s !== 'object' || Array.isArray(s)) {
          return errorBody('invalid_input', 'each interactiveStory sticker must be an object');
        }
        if (!STICKER_KINDS.includes(s.kind)) {
          return errorBody('invalid_input', `sticker kind must be one of ${STICKER_KINDS.join('|')}`);
        }
        for (const axis of ['x', 'y']) {
          if (s[axis] !== undefined && (typeof s[axis] !== 'number' || s[axis] < 0 || s[axis] > 1)) {
            return errorBody('invalid_input', `sticker ${axis} must be a number between 0 and 1`);
          }
        }
      }
    }
  }
  return null;
}

// ---------- post CRUD ----------

export async function createPost({ campaign, post, actor } = {}) {
  const idErr = requireIds(campaign) || requireActor(actor);
  if (idErr) return idErr;
  if (!post || typeof post !== 'object' || Array.isArray(post)) {
    return errorBody('invalid_input', 'post must be an object');
  }
  if (typeof post.id !== 'string' || !ID_RE.test(post.id)) {
    return errorBody('invalid_input', 'post.id must be a [a-zA-Z0-9_-]+ id');
  }
  const fieldErr = validateFieldValues(post);
  if (fieldErr) return fieldErr;
  if (!post.type || !Array.isArray(post.platforms)) {
    return errorBody('invalid_input', 'post.type and post.platforms are required');
  }
  const found = findPlanEntry(campaign);
  if (found.error) return found.error;
  try {
    const created = await mutatePlan(found.absPlan, (plan) => {
      plan.posts = plan.posts || [];
      if (plan.posts.some((p) => p.id === post.id)) {
        throw Object.assign(new Error(`post ${post.id} already exists in ${campaign}`), { code: 'invalid_input' });
      }
      const fresh = {
        id: post.id,
        type: post.type,
        platforms: post.platforms,
        scheduledAt: post.scheduledAt || null,
        caption: post.caption || '',
        firstComment: post.firstComment || '',
        title: post.title || undefined,
        link: post.link || undefined,
        image: post.image || undefined,
        description: post.description || undefined,
        liDescription: post.liDescription || undefined,
        xCaption: post.xCaption || undefined,
        tags: post.tags || undefined,
        blogSlug: post.blogSlug || undefined,
        audience: post.audience || undefined,
        // FR4: interactive-story intent + per-post hashtag override. Both optional;
        // absent -> stripped below, then normalizePost defaults them (null / []).
        interactiveStory: post.interactiveStory || undefined,
        hashtags: Array.isArray(post.hashtags) && post.hashtags.length ? post.hashtags : undefined,
        file: post.file || undefined,
        path: post.path || undefined,
        executionMode: post.executionMode || 'fully-scheduled',
        status: 'planned',
        // Fail-closed (SS-01): EVERY created post is a draft, no exceptions -
        // approval only ever flips via approve_post with a distinct actor.
        approval: 'draft',
        createdBy: actor.trim(),
        createdAt: new Date().toISOString(),
      };
      Object.keys(fresh).forEach((k) => fresh[k] === undefined && delete fresh[k]);
      plan.posts.push(fresh);
      return fresh;
    });
    appendActivity({ campaign, postId: post.id, platform: null, action: 'post-create', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
    // Opt-in progressive autonomy: if the OWNER has enabled an auto-approve
    // policy that this post matches, approve it now via setApproval under the
    // distinct policy actor. The drafting agent never approves its own post -
    // setApproval stays the single no-self-approval enforcement point, and since
    // the approver (policy:auto-approve) differs from the creator and is not
    // 'owner', isSelfApproved() is false. Best-effort: a policy/lint hiccup must
    // never block creation, so the post simply stays a draft on any failure.
    // Every publish-time gate (lint, breaker, cadence, due-time) still applies.
    let autoApproved = false;
    let finalRev = postRev(created);
    try {
      const policy = getPosting().autoApprove;
      if (policy && policy.enabled && created.createdBy !== AUTO_APPROVE_ACTOR && autoApproveDecision(created, policy, campaign).approve) {
        const appr = await setApproval({ campaign, postId: post.id, actor: AUTO_APPROVE_ACTOR, note: 'auto-approved by policy', verdict: 'approved' });
        if (appr && appr.ok) {
          created.approval = 'approved';
          created.approvalBy = AUTO_APPROVE_ACTOR;
          created.approvalAt = appr.post.approvalAt;
          if (appr.post.approvalNote) created.approvalNote = appr.post.approvalNote;
          autoApproved = true;
          finalRev = appr.rev;
        }
      }
    } catch { /* leave the post a draft - never block creation on the policy */ }
    return { ok: true, post: created, autoApproved, rev: finalRev };
  } catch (err) {
    return errorBody(err.code || 'engine_failure', err.message);
  }
}

export async function updatePost({ campaign, postId, ifRev, fields, actor } = {}) {
  const idErr = requireIds(campaign, postId) || requireActor(actor);
  if (idErr) return idErr;
  if (typeof ifRev !== 'string' || !ifRev) {
    return errorBody('invalid_input', 'ifRev is required - read the post (plan_get) and echo its rev');
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return errorBody('invalid_input', 'fields must be an object');
  }
  const offered = Object.keys(fields);
  const illegal = offered.filter((k) => !UPDATABLE_FIELDS.includes(k));
  if (illegal.length) {
    return errorBody('invalid_input', `field(s) not updatable: ${illegal.join(', ')} (approval has its own tools; cover has set_cover)`);
  }
  if (!offered.length) return errorBody('invalid_input', 'fields is empty');
  const fieldErr = validateFieldValues(fields);
  if (fieldErr) return fieldErr;
  const found = findPlanEntry(campaign);
  if (found.error) return found.error;
  const flightErr = inFlightGuard(campaign, postId);
  if (flightErr) return flightErr;
  try {
    const updated = await mutatePlan(found.absPlan, (plan) => {
      const post = (plan.posts || []).find((p) => p.id === postId);
      if (!post) throw Object.assign(new Error(`unknown post ${postId} in ${campaign}`), { code: 'unknown_post' });
      const rev = postRev(post);
      if (rev !== ifRev) {
        throw Object.assign(new Error(`rev mismatch: post is at ${rev}, you sent ${ifRev} - re-read, merge, retry once`), { code: 'stale_write' });
      }
      for (const k of offered) {
        if (fields[k] === null) delete post[k];
        else post[k] = fields[k];
      }
      return post;
    });
    appendActivity({ campaign, postId, platform: null, action: 'post-update', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
    return { ok: true, post: updated, rev: postRev(updated) };
  } catch (err) {
    return errorBody(err.code || 'engine_failure', err.message);
  }
}

export async function deletePost({ campaign, postId, force, actor } = {}) {
  const idErr = requireIds(campaign, postId) || requireActor(actor);
  if (idErr) return idErr;
  const found = findPlanEntry(campaign);
  if (found.error) return found.error;
  const flightErr = inFlightGuard(campaign, postId);
  if (flightErr) return flightErr;
  try {
    const removed = await mutatePlan(found.absPlan, (plan) => {
      const idx = (plan.posts || []).findIndex((p) => p.id === postId);
      if (idx < 0) throw Object.assign(new Error(`unknown post ${postId} in ${campaign}`), { code: 'unknown_post' });
      const post = plan.posts[idx];
      const evidence = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'xPostId'].filter((k) => post[k]);
      if ((post.status === 'posted' || evidence.length) && force !== true) {
        throw Object.assign(
          new Error(`post has publish evidence (${post.status === 'posted' ? 'posted' : evidence.join(', ')}) - deleting the plan row does NOT remove anything from the platforms; pass force: true if you really mean it`),
          { code: 'invalid_input' },
        );
      }
      plan.posts.splice(idx, 1);
      return post;
    });
    appendActivity({ campaign, postId, platform: null, action: 'post-delete', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
    return { ok: true, deleted: { id: removed.id } };
  } catch (err) {
    return errorBody(err.code || 'engine_failure', err.message);
  }
}

// ---------- approval (ships on MCP) ----------

async function setApproval({ campaign, postId, actor, note, verdict }) {
  const idErr = requireIds(campaign, postId) || requireActor(actor);
  if (idErr) return idErr;
  const found = findPlanEntry(campaign);
  if (found.error) return found.error;
  try {
    const result = await mutatePlan(found.absPlan, (plan) => {
      const post = (plan.posts || []).find((p) => p.id === postId);
      if (!post) throw Object.assign(new Error(`unknown post ${postId} in ${campaign}`), { code: 'unknown_post' });
      // No self-approval: whoever created/submitted a post never flips its
      // approval - the rule exists so an AGENT can never bless its own draft.
      // The owner is the platform's approval authority and is exempt
      // (otherwise composer-created posts could never be approved at all).
      if (post.createdBy && post.createdBy === actor.trim() && actor.trim() !== 'owner') {
        throw Object.assign(new Error(`${actor.trim()} created this post and cannot ${verdict === 'approved' ? 'approve' : 'reject'} it (no self-approval)`), { code: 'invalid_input' });
      }
      post.approval = verdict;
      post.approvalBy = actor.trim();
      post.approvalAt = new Date().toISOString();
      if (note) post.approvalNote = String(note);
      else delete post.approvalNote;
      return post;
    });
    appendActivity({ campaign, postId, platform: null, action: verdict === 'approved' ? 'approve' : 'reject', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
    return { ok: true, post: { id: result.id, approval: result.approval, approvalBy: result.approvalBy, approvalAt: result.approvalAt, approvalNote: result.approvalNote || null }, rev: postRev(result) };
  } catch (err) {
    return errorBody(err.code || 'engine_failure', err.message);
  }
}

export function approvePost(args = {}) {
  return setApproval({ ...args, verdict: 'approved' });
}

export function rejectPost(args = {}) {
  return setApproval({ ...args, verdict: 'rejected' });
}

// ---------- scheduling moves (native-vs-due mechanics hidden) ----------

// A post is natively handed off when a platform already holds a scheduled
// object for it: FB scheduled post (fbPostId, status scheduled) or YouTube
// private+publishAt video (ytVideoId, status scheduled). Moving/cancelling
// those means DELETING the platform object via the engine CLIs - a real
// platform mutation, hence confirm: true.
function nativeHandoff(post) {
  if (post.status !== 'scheduled') return null;
  if (post.ytVideoId) return { lane: 'youtube', script: 'scripts/yt-social.mjs', id: post.ytVideoId, field: 'ytVideoId' };
  if (post.fbPostId) return { lane: 'facebook', script: 'scripts/meta-social.mjs', id: post.fbPostId, field: 'fbPostId' };
  return null;
}

async function cancelNative(handoff, actor) {
  const { err, envelope, stderrTail } = await execScript(handoff.script, ['delete', '--id', handoff.id, '--json', '--actor', actor], 120_000);
  if (err || envelope?.ok === false) {
    return errorBody('engine_failure', `native cancel failed on ${handoff.lane}: ${String(envelope?.error || stderrTail || err?.message).slice(0, 300)}`);
  }
  return null;
}

export async function unschedulePost({ campaign, postId, confirm, actor } = {}) {
  const idErr = requireIds(campaign, postId) || requireActor(actor);
  if (idErr) return idErr;
  const found = findPlanEntry(campaign);
  if (found.error) return found.error;
  const flightErr = inFlightGuard(campaign, postId);
  if (flightErr) return flightErr;
  try {
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(found.absPlan, 'utf8'));
    } catch (err) {
      return errorBody('manifest_error', `plan file unreadable: ${err.message}`);
    }
    const post = (plan.posts || []).find((p) => p.id === postId);
    if (!post) return errorBody('unknown_post', `unknown post ${postId} in ${campaign}`);
    if (post.status === 'posted') return errorBody('invalid_input', 'post is already published - unschedule cannot unpublish');

    const handoff = nativeHandoff(post);
    if (handoff) {
      if (confirm !== true) {
        return errorBody('needs_confirm', `This post is natively scheduled on ${handoff.lane} - parking it will delete the platform object (${handoff.id}).`);
      }
      const cancelErr = await cancelNative(handoff, actor.trim());
      if (cancelErr) return cancelErr;
    }
    const updated = await mutatePlan(found.absPlan, (freshPlan) => {
      const p = (freshPlan.posts || []).find((x) => x.id === postId);
      if (!p) throw Object.assign(new Error(`post ${postId} vanished mid-write`), { code: 'unknown_post' });
      if (handoff) delete p[handoff.field];
      p.status = 'planned';
      p.executionMode = 'parked';
      return p;
    });
    appendActivity({ campaign, postId, platform: handoff?.lane || null, action: 'unschedule', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
    return { ok: true, post: { id: updated.id, executionMode: updated.executionMode, status: updated.status }, nativeCancelled: handoff ? handoff.lane : null, rev: postRev(updated) };
  } catch (err) {
    return errorBody(err.code || 'engine_failure', err.message);
  }
}

export async function reschedulePost({ campaign, postId, scheduledAt, confirm, actor } = {}) {
  const idErr = requireIds(campaign, postId) || requireActor(actor);
  if (idErr) return idErr;
  if (typeof scheduledAt !== 'string' || Number.isNaN(Date.parse(scheduledAt))) {
    return errorBody('invalid_input', 'scheduledAt must be an ISO-8601 datetime');
  }
  const found = findPlanEntry(campaign);
  if (found.error) return found.error;
  const flightErr = inFlightGuard(campaign, postId);
  if (flightErr) return flightErr;
  try {
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(found.absPlan, 'utf8'));
    } catch (err) {
      return errorBody('manifest_error', `plan file unreadable: ${err.message}`);
    }
    const post = (plan.posts || []).find((p) => p.id === postId);
    if (!post) return errorBody('unknown_post', `unknown post ${postId} in ${campaign}`);
    if (post.status === 'posted') return errorBody('invalid_input', 'post is already published - reschedule cannot move it');

    const handoff = nativeHandoff(post);
    if (handoff) {
      if (confirm !== true) {
        return errorBody('needs_confirm', `This post is natively scheduled on ${handoff.lane} - rescheduling will delete the platform object (${handoff.id}) and re-schedule it.`);
      }
      const cancelErr = await cancelNative(handoff, actor.trim());
      if (cancelErr) return cancelErr;
    }
    const updated = await mutatePlan(found.absPlan, (freshPlan) => {
      const p = (freshPlan.posts || []).find((x) => x.id === postId);
      if (!p) throw Object.assign(new Error(`post ${postId} vanished mid-write`), { code: 'unknown_post' });
      if (handoff) delete p[handoff.field];
      p.scheduledAt = scheduledAt;
      if (handoff) p.status = 'planned';
      return p;
    });
    appendActivity({ campaign, postId, platform: handoff?.lane || null, action: 'reschedule', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
    return {
      ok: true,
      post: { id: updated.id, scheduledAt: updated.scheduledAt, status: updated.status, executionMode: updated.executionMode },
      nativeCancelled: handoff ? handoff.lane : null,
      note: handoff ? `${handoff.lane} native schedule cancelled - the post re-queues for the new time (scheduler or next engine run re-hands it off)` : null,
      rev: postRev(updated),
    };
  } catch (err) {
    return errorBody(err.code || 'engine_failure', err.message);
  }
}

// ---------- mark posted (owner published natively, outside pendpost) ----------

// A controlled terminal transition (like approve/unschedule, NOT a raw field
// edit - status is engine-owned, so it is deliberately absent from
// UPDATABLE_FIELDS). Sets status:'posted' so deriveState excludes it from
// publish-due and the insights sweep skips it (no platform id is ever minted -
// a fake id would later send fetch_insights chasing a post that does not exist).
export async function markPosted({ campaign, postId, actor, externalUrl } = {}) {
  const idErr = requireIds(campaign, postId) || requireActor(actor);
  if (idErr) return idErr;
  if (externalUrl !== undefined && externalUrl !== null && (typeof externalUrl !== 'string' || !/^https?:\/\//.test(externalUrl))) {
    return errorBody('invalid_input', 'externalUrl must be an absolute http(s) URL');
  }
  const found = findPlanEntry(campaign);
  if (found.error) return found.error;
  const flightErr = inFlightGuard(campaign, postId);
  if (flightErr) return flightErr;
  try {
    const updated = await mutatePlan(found.absPlan, (plan) => {
      const post = (plan.posts || []).find((p) => p.id === postId);
      if (!post) throw Object.assign(new Error(`unknown post ${postId} in ${campaign}`), { code: 'unknown_post' });
      if (post.status === 'posted') throw Object.assign(new Error(`post ${postId} is already marked posted`), { code: 'invalid_input' });
      post.status = 'posted';
      post.postedAt = new Date().toISOString();
      post.publishedVia = 'manual';
      if (externalUrl) post.externalUrl = String(externalUrl);
      return post;
    });
    appendActivity({ campaign, postId, platform: null, action: 'mark-posted', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
    return { ok: true, post: { id: updated.id, status: updated.status, postedAt: updated.postedAt, publishedVia: updated.publishedVia, externalUrl: updated.externalUrl || null }, rev: postRev(updated) };
  } catch (err) {
    return errorBody(err.code || 'engine_failure', err.message);
  }
}

// ---------- campaign CRUD (manifest) ----------

// Manifest writes MUST round-trip the WHOLE manifest object - writing a bare
// { plans } would silently drop sibling keys (the top-level note, anything a
// future phase adds). Caught live on the first write-matrix probe.
function readManifestRaw() {
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
    if (!Array.isArray(data.plans)) return { error: `manifest has no "plans" array` };
    return { manifest: data };
  } catch (err) {
    return { error: `manifest unreadable: ${err.message}` };
  }
}

export async function createCampaign({ id, note, timezone, folder, actor } = {}) {
  const idErr = requireIds(id) || requireActor(actor);
  if (idErr) return idErr;
  try {
    const root = activeRoot();
    return await withPlanLock(manifestPath(), () => {
      const { manifest, error } = readManifestRaw();
      if (error) return errorBody('manifest_error', error);
      if (manifest.plans.some((p) => p.id === id)) return errorBody('invalid_input', `campaign ${id} already exists`);
      const dir = path.join(root, 'data', 'plans', id);
      const planPath = path.join(dir, 'post-plan.json');
      if (fs.existsSync(planPath)) return errorBody('invalid_input', `${path.relative(root, planPath)} already exists on disk`);
      fs.mkdirSync(dir, { recursive: true });
      atomicWriteJson(planPath, {
        campaign: id,
        note: note || undefined,
        timezone: timezone || 'UTC',
        folder: folder || undefined,
        posts: [],
      });
      manifest.plans.push({ id, path: path.relative(root, planPath), active: true });
      atomicWriteJson(manifestPath(), manifest);
      appendActivity({ campaign: id, postId: null, platform: null, action: 'campaign-create', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
      return { ok: true, campaign: { id, path: path.relative(root, planPath), active: true } };
    });
  } catch (err) {
    return errorBody('engine_failure', err.message);
  }
}

// Park (on deactivate) or restore (on reactivate) a campaign's posts so the
// scheduler stops/resumes publishing them. NON-DESTRUCTIVE: it flips ONLY the
// executionMode field - it never calls nativeHandoff/cancelNative, so an
// already-scheduled native (YouTube) object is left untouched on the platform
// (unlike unschedulePost, which deletes it). Reversible via the internal
// parkedByDeactivation marker: reactivation restores ONLY posts this mechanism
// parked, leaving hand-parked posts (no marker) parked. Idempotent - re-running
// for the same target state is a no-op. Returns the count of posts changed.
async function sweepCampaignParking(absPlan, active) {
  return mutatePlan(absPlan, (plan) => {
    let n = 0;
    for (const p of plan.posts || []) {
      if (active === false) {
        // Deactivate: park every still-publishable post; skip posted and
        // already-parked (manual parks have no marker and stay as-is).
        if (p.executionMode === 'fully-scheduled' && p.status !== 'posted') {
          p.executionMode = 'parked';
          p.parkedByDeactivation = true;
          n += 1;
        }
      } else if (p.parkedByDeactivation === true) {
        // Reactivate: restore only what we auto-parked.
        p.executionMode = 'fully-scheduled';
        delete p.parkedByDeactivation;
        n += 1;
      }
    }
    return n;
  });
}

export async function setCampaignActive({ id, active, actor } = {}) {
  const idErr = requireIds(id) || requireActor(actor);
  if (idErr) return idErr;
  if (typeof active !== 'boolean') return errorBody('invalid_input', 'active must be a boolean');
  try {
    const found = findPlanEntry(id);
    if (found.error) return found.error;

    // On DEACTIVATE, park BEFORE flipping the manifest: the scheduler ignores the
    // active flag (approval is the sole gate), so executionMode='parked' is the
    // only thing that actually stops a publish. Parking first closes the window
    // where a tick could fire a still-fully-scheduled post mid-toggle.
    let changed = 0;
    if (active === false) changed = await sweepCampaignParking(found.absPlan, false);

    const flip = await withPlanLock(manifestPath(), () => {
      const { manifest, error } = readManifestRaw();
      if (error) return errorBody('manifest_error', error);
      const entry = manifest.plans.find((p) => p.id === id);
      if (!entry) return errorBody('unknown_campaign', `unknown campaign: ${id}`);
      entry.active = active;
      atomicWriteJson(manifestPath(), manifest);
      appendActivity({ campaign: id, postId: null, platform: null, action: active ? 'campaign-activate' : 'campaign-deactivate', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
      return { ok: true };
    });
    if (!flip.ok) return flip;

    // On REACTIVATE, restore auto-parked posts AFTER the campaign is active.
    if (active === true) changed = await sweepCampaignParking(found.absPlan, true);

    if (changed > 0) {
      appendActivity({
        campaign: id, postId: null, platform: null,
        action: active ? 'auto-unpark' : 'auto-park', ok: true, errorCode: null,
        errorMessage: active
          ? `${changed} post(s) restored on reactivation`
          : `${changed} scheduled post(s) parked by deactivation`,
        lateMin: null, actor: actor.trim(),
      });
    }

    return { ok: true, campaign: { id, active }, ...(active ? { autoUnparked: changed } : { autoParked: changed }) };
  } catch (err) {
    return errorBody('engine_failure', err.message);
  }
}

// ---------- Meta publishing lane: cadence + pause/resume (C1) ----------

// data/plans/meta-lane.json carries BOTH the anti-ban cadence cap (read by the
// scheduler's loadMetaCadence) AND the pause/reason kill switch (read by the
// engine's metaLaneState). They share one file, so a write MUST read-merge-write
// the WHOLE object - a naive whole-file overwrite would drop the sibling key
// (cadence when writing paused, or vice-versa). The whole-object round-trip
// mirrors the manifest write rule above. The file lives under the ACTIVE client
// root (activeRoot()), resolved per call; the read-merge-write runs inside
// withPlanLock so a scheduler tick reading cadence never races a half-written
// file. NEVER reads/writes post.approval, and resuming (paused:false) NEVER
// clears a recorded Meta-368 - isMetaBlocked stays independent of this lane flag.
function metaLanePath() {
  return path.join(activeRoot(), 'data', 'plans', 'meta-lane.json');
}

function isCount(n, min) {
  return Number.isInteger(n) && n >= min;
}

export async function setMetaLane({ cadence, paused, reason, actor } = {}) {
  const actErr = requireActor(actor);
  if (actErr) return actErr;
  // Validate every supplied field BEFORE acquiring the lock so a rejected call
  // writes nothing. cadence is an anti-ban FLOOR: maxPer24h>=1 (the cap can never
  // be disabled), minGapMinutes>=0, both integers.
  if (cadence !== undefined) {
    if (!cadence || typeof cadence !== 'object' || Array.isArray(cadence)) {
      return errorBody('invalid_input', 'cadence must be an object { maxPer24h, minGapMinutes }');
    }
    if (!isCount(cadence.maxPer24h, 1)) {
      return errorBody('invalid_input', 'cadence.maxPer24h must be an integer >= 1 (the anti-ban cap can never be disabled)');
    }
    if (!isCount(cadence.minGapMinutes, 0)) {
      return errorBody('invalid_input', 'cadence.minGapMinutes must be an integer >= 0');
    }
  }
  if (paused !== undefined && typeof paused !== 'boolean') {
    return errorBody('invalid_input', 'paused must be a boolean');
  }
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    return errorBody('invalid_input', 'reason must be a string or null');
  }
  if (cadence === undefined && paused === undefined && reason === undefined) {
    return errorBody('invalid_input', 'nothing to set: pass cadence and/or paused (with an optional reason)');
  }
  try {
    return await withPlanLock(metaLanePath(), () => {
      // Read-merge-write the WHOLE file so the sibling key survives.
      let lane = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(metaLanePath(), 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) lane = parsed;
      } catch { /* no file yet -> start from {} */ }
      if (cadence !== undefined) {
        lane.cadence = { maxPer24h: cadence.maxPer24h, minGapMinutes: cadence.minGapMinutes };
      }
      if (paused !== undefined) lane.paused = paused;
      if (reason !== undefined) lane.reason = reason;
      fs.mkdirSync(path.dirname(metaLanePath()), { recursive: true });
      atomicWriteJson(metaLanePath(), lane);
      appendActivity({ campaign: null, postId: null, platform: 'meta', action: 'meta-lane-set', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
      return { ok: true, lane: { cadence: lane.cadence || null, paused: Boolean(lane.paused), reason: lane.paused ? (lane.reason ?? null) : null } };
    });
  } catch (err) {
    return errorBody('engine_failure', err.message);
  }
}

// ---------- token refresh ----------

const REFRESH_ENGINES = { linkedin: 'scripts/linkedin-social.mjs', x: 'scripts/x-social.mjs' };

export async function tokenRefresh({ platform } = {}) {
  const script = REFRESH_ENGINES[platform];
  if (!script) {
    return errorBody('invalid_input', 'only platform: "linkedin" or "x" has a programmatic refresh (Meta uses a long-lived page token; YouTube refreshes per call)');
  }
  const { err, envelope, stderrTail } = await execScript(script, ['refresh', '--json'], 60_000);
  if (err || envelope?.ok === false) {
    return errorBody('engine_failure', `${platform} refresh failed: ${String(envelope?.error || stderrTail || err?.message).slice(0, 300)}`, {
      hint: `if the refresh token itself expired, re-auth interactively: node ${script} auth`,
    });
  }
  appendActivity({ campaign: null, postId: null, platform, action: 'token-refresh', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: 'pendpost' });
  return { ok: true, platform, refreshed: true };
}

// ---------- X profile edit (account-level, not a post) ----------

// Edits the connected X profile (name/bio/url/location/image/banner) via the X
// engine's v1.1 account/* path (OAuth 1.0a). Account-level, so no campaign/post:
// it execScripts x-social.mjs `profile`, which is PENDPOST_ROOT-scoped to the active
// (or per-call clientId) client and self-guards the target account
// (screen_name === X_HANDLE) before any mutation. probe:true runs the read-only
// access-tier gate (STEP 0) and mutates nothing. image/banner are LOCAL file paths
// (mirroring set_cover's filePath); the engine reads them under PENDPOST_ROOT.
export async function xUpdateProfile({ name, bio, url, location, image, banner, probe, actor } = {}) {
  const actErr = requireActor(actor);
  if (actErr) return actErr;
  const argv = ['profile', '--json', '--actor', actor.trim()];
  if (probe === true) argv.push('--probe');
  for (const [flag, val] of [['--name', name], ['--bio', bio], ['--url', url], ['--location', location], ['--image', image], ['--banner', banner]]) {
    if (typeof val === 'string') argv.push(flag, val);
  }
  if (probe !== true && argv.length === 4) {
    return errorBody('invalid_input', 'nothing to update - pass at least one of name, bio, url, location, image, banner (or probe:true)');
  }
  const { err, envelope, stderrTail } = await execScript('scripts/x-social.mjs', argv, 120_000);
  if (err || envelope?.ok === false) {
    return errorBody('engine_failure', `x profile ${probe === true ? 'probe' : 'update'} failed: ${String(envelope?.error || stderrTail || err?.message).slice(0, 300)}`);
  }
  appendActivity({ campaign: null, postId: null, platform: 'x', action: probe === true ? 'profile-probe' : 'profile-update', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
  return { ok: true, ...envelope };
}

// ---------- media + platform validation ----------

export async function validateMedia({ campaign, postId } = {}) {
  const idErr = requireIds(campaign, postId);
  if (idErr) return idErr;
  const found = findPlanEntry(campaign);
  if (found.error) return found.error;
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(found.absPlan, 'utf8'));
  } catch (err) {
    return errorBody('manifest_error', `plan file unreadable: ${err.message}`);
  }
  const post = (plan.posts || []).find((p) => p.id === postId);
  if (!post) return errorBody('unknown_post', `unknown post ${postId} in ${campaign}`);
  const mediaPath = resolveMediaPath(plan, post);
  if (!mediaPath) return errorBody('media_missing', `no local media for ${postId} (${post.path || post.file || 'no file set'})`);
  const probe = await probeMedia(mediaPath);
  return {
    ok: true,
    media: { path: mediaPath, bytes: fs.statSync(mediaPath).size },
    probe,
    checks: specChecks(probe),
  };
}

// Caption/data limits that silently truncate or hard-fail at publish time.
const CAPTION_LIMITS = { instagram: 2200, facebook: 63206, linkedin: 3000, youtube: 5000 };
// X caps a tweet at 280 chars, but the effective tweet text is the per-platform
// xCaption override when set (else the shared caption) - so X's cap is checked in
// the platform loop against that effective text, not via the generic caption cap.
const X_TWEET_LIMIT = 280;
// YouTube snippet limits (scripts/yt-social.mjs buildMeta uploads description + tags).
const YT_LIMITS = { description: 5000, tags: 500 };

export async function platformValidate({ campaign, postId } = {}) {
  const idErr = requireIds(campaign, postId);
  if (idErr) return idErr;
  const { campaigns, manifestError } = loadPlanStore();
  if (manifestError) return errorBody('manifest_error', manifestError);
  const c = campaigns.find((x) => x.id === campaign);
  if (!c) return errorBody('unknown_campaign', `unknown campaign: ${campaign}`);
  const post = (c.posts || []).find((p) => p.id === postId);
  if (!post) return errorBody('unknown_post', `unknown post ${postId} in ${campaign}`);

  const accounts = accountStatus();
  const state = loadState();
  const now = Date.now();
  const metaBlocked = isMetaBlocked(state);
  const captionLen = (post.caption || '').length;
  const result = {};

  for (const platform of post.platforms || []) {
    const problems = [];
    // Advisory-only: surfaced in pendpost but never affects `ready` (a post may
    // legitimately ship without the optional thing the warning is about).
    const warnings = [];
    // True when the blocking problem is that the lane isn't connected/credentialed,
    // i.e. the fix lives on the Setup page (which holds the per-lane connect action).
    // The GUI turns this into one "Set up <lane>" link instead of raw auth jargon;
    // additive sibling of problems[] so the platform_validate contract is unchanged.
    let needsSetup = false;
    // Text/article posts (LinkedIn) carry no media; only media-backed types need a file.
    if (postNeedsMedia(post) && !post.media.exists) problems.push('local media file is missing');
    if (captionLen > (CAPTION_LIMITS[platform] || Infinity)) {
      problems.push(`caption is ${captionLen} chars - ${platform} caps at ${CAPTION_LIMITS[platform]}`);
    }
    if (platform === 'facebook' || platform === 'instagram') {
      if (!accounts.meta?.configured) { problems.push('Meta credentials not configured'); needsSetup = true; }
      if (metaBlocked) problems.push(`Meta action block active (recorded ${state.meta.blockedUntil}; clear it manually once Meta lifts it)`);
      if (platform === 'facebook' && post.type !== 'reel') problems.push('the FB lane publishes full-bleed reels only (type=reel)');
      // Facebook is deny-by-default (per-client platform policy); never ready unless opted in.
      if (platform === 'facebook' && !platformEnabled('facebook', getPosting())) {
        problems.push('facebook publishing is disabled by platform policy (instagram unaffected) - enable via config.platforms.facebook=true on a healthy Page');
      }
    }
    if (platform === 'linkedin') {
      // The publish gate is the usable token (authenticated); the app credentials
      // only decide the WORDING - no credentials at all reads "nicht eingerichtet",
      // credentials present but no token yet reads "nicht verbunden" (no jargon).
      if (!accounts.linkedin?.authenticated) {
        problems.push(accounts.linkedin?.configured ? 'LinkedIn ist nicht verbunden' : 'LinkedIn ist nicht eingerichtet');
        needsSetup = true;
      }
      // A LinkedIn article share with no image gets the JS-less preview crawl (blank
      // for our SPA /blog/* URLs). Warn, never block - the owner may want a text share.
      if (post.type === 'text' && !(post.image || '').trim()) {
        warnings.push('no image set - the LinkedIn article card will have no thumbnail (set post.image to the Cloudinary hero URL)');
      }
    }
    if (platform === 'youtube') {
      if (!accounts.youtube?.authenticated) { problems.push('YouTube not authenticated'); needsSetup = true; }
      if (!(post.title || '').trim()) problems.push('YouTube needs a title');
      const descLen = (post.description || '').length;
      if (!descLen) problems.push('YouTube needs a description (yt-social uploads it as the video description)');
      else if (descLen > YT_LIMITS.description) problems.push(`description is ${descLen} chars - YouTube caps at ${YT_LIMITS.description}`);
      const tagsLen = (post.tags || '').length;
      if (tagsLen > YT_LIMITS.tags) problems.push(`tags total ${tagsLen} chars - YouTube caps at ${YT_LIMITS.tags}`);
      const due = Date.parse(post.scheduledAt || '');
      if (post.executionMode === 'fully-scheduled' && !post.ids.ytVideoId && !Number.isNaN(due) && due <= now) {
        problems.push('scheduledAt is in the past - YouTube needs a FUTURE publishAt (reschedule first)');
      }
    }
    if (platform === 'x') {
      if (!accounts.x?.authenticated) { problems.push('X not authenticated (token_refresh or re-auth)'); needsSetup = true; }
      // Tweet text is the per-platform xCaption override when set, else the shared
      // caption; cap the EFFECTIVE text so a long shared caption with a short
      // xCaption override is never falsely flagged.
      const xText = (post.xCaption || post.caption || '').trim();
      if (xText.length > X_TWEET_LIMIT) problems.push(`tweet text is ${xText.length} chars - X caps at ${X_TWEET_LIMIT} (set a shorter xCaption)`);
    }
    // Approval is NOT a per-platform problem: a draft/pending/rejected post is the
    // normal pre-publish state (shown by the post-level Entwurf badge), not a fault
    // to flag on every lane. It still gates `ready` below, and publishPreview re-adds
    // the dry-run blocker - but it never pollutes problems[] / the GUI panel.
    const approved = post.approval === 'approved';
    // `ready` needs both: approved AND no platform problems. `warnings` is advisory.
    result[platform] = { ready: approved && !problems.length, problems, warnings, needsSetup };
  }
  // `approval` rides at the top level so publishPreview can re-add the dry-run
  // approval blocker without re-reading the post (additive; problems[] shape intact).
  return { ok: true, postId, approval: post.approval, platforms: result };
}

// ---------- pendpost health (SS-10) ----------

// Human label for a validation state, used as the C2 blocker reason when the
// last probe carried no detail string (e.g. an unproven lane never probed yet).
const STATE_LABEL = {
  live: 'live', failed: 'failed', unproven: 'not yet proven', skipped: 'skipped', blocked: 'action block active',
};

export function pendpostHealth({ horizon = 5, includeSetup = true } = {}) {
  const { campaigns, manifestError } = loadPlanStore();
  const state = loadState();
  // Compute the setup signal once: its per-platform `validation` drives the C2
  // credential/liveness blockers below AND is embedded verbatim when includeSetup.
  const setup = setupStatus();
  const blockers = [];
  // blockerCodes: machine codes (+ params) kept PARALLEL (1:1, same order) to the
  // English blockers[], so the SPA localizes the readiness panel via t(code) while
  // REST/MCP keep stable, locale-INDEPENDENT bytes. Additive - blockers[] is the
  // unchanged English face (agent prose + clientsOverview's /overdue/i detection).
  const blockerCodes = [];
  if (manifestError) {
    blockers.push(`manifest: ${manifestError}`);
    blockerCodes.push({ code: 'blocker.manifest', params: { error: manifestError } });
  }
  // C2: one UNIQUE blocker per lane that is neither PROVEN live nor explicitly
  // skipped - the verbatim ASCII string ReadinessChecklist renders. Keyed by the
  // platform label so each lane gets its own row (never a single merged line).
  for (const p of setup.platforms) {
    if (p.validation.state === 'live' || p.status === 'skipped') continue;
    const reason = p.validation.detail || STATE_LABEL[p.validation.state] || p.validation.state;
    blockers.push(`${p.label}: ${reason} - ${p.validation.fix}. Open Setup.`);
    // The lane's code is its validation state; a never-connected lane and a probed
    // failure get distinct keys (different owner action). cmd is the connectAction
    // CLI - locale-independent; the SPA's de-CH string interpolates it.
    const laneCode = p.validation.state === 'blocked' ? 'blocker.lane.blocked'
      : p.validation.state === 'failed' ? 'blocker.lane.failed'
        : p.connected ? 'blocker.lane.unproven'
          : 'blocker.lane.notConnected';
    blockerCodes.push({ code: laneCode, params: { label: p.label, cmd: p.connectAction } });
  }

  const upcoming = campaigns
    .filter((c) => c.active && !c.error)
    .flatMap((c) => (c.posts || []).map((p) => ({ ...p, campaign: c.id })))
    .filter((p) => p.derivedState === 'waiting-due' || p.derivedState === 'overdue')
    .sort((a, b) => Date.parse(a.scheduledAt || 0) - Date.parse(b.scheduledAt || 0))
    .slice(0, Math.min(Math.max(horizon, 1), 20))
    .map((p) => {
      const postBlockers = [];
      // Parallel machine codes, pushed in lockstep with postBlockers (see above).
      const postBlockerCodes = [];
      if (p.approval !== 'approved') {
        postBlockers.push(`approval: ${p.approval}`);
        postBlockerCodes.push({ code: 'blocker.approval', params: { state: p.approval } });
      }
      if (postNeedsMedia(p) && !p.media.exists) {
        postBlockers.push('media missing');
        postBlockerCodes.push({ code: 'blocker.mediaMissing' });
      }
      if (p.derivedState === 'overdue') {
        postBlockers.push('overdue - due time already passed');
        postBlockerCodes.push({ code: 'blocker.overdue' });
      }
      // Mandate B: forward the fields a content-rich readiness card needs (type,
      // caption, a slim media {cover,url}, and the image fallback for type:text).
      // normalizePost already computed these on `p`; this is a pure READ payload
      // enrichment, so MCP pendpost_health and REST /api/pendpost-health inherit it
      // identically (no new write capability, parity untouched).
      return {
        campaign: p.campaign,
        postId: p.id,
        scheduledAt: p.scheduledAt,
        platforms: p.platforms,
        blockers: postBlockers,
        blockerCodes: postBlockerCodes,
        type: p.type,
        caption: p.caption || '',
        media: { cover: p.media?.cover || null, url: p.media?.url || null },
        image: p.image || null,
      };
    });

  const schedulerRunning = state.scheduler?.enabled === true;
  if (!schedulerRunning && upcoming.length) {
    blockers.push('scheduler is OFF - waiting-due posts will not publish (C5 activation order applies)');
    blockerCodes.push({ code: 'blocker.schedulerOff' });
  }
  // Silent-overdue guard: an APPROVED post past its due time by > grace and still not
  // posted is the cloud-managed silent failure the incident exposed (every signal green,
  // the post never published). Surface it as a TOP-LEVEL blocker (ready:false) naming the
  // post and, when reconcile cached WHY the cloud fire failed, the sanitized reason - so
  // "silently overdue forever" is impossible regardless of cause (never pushed, worker
  // down, or a real key issue). Only meaningful when the scheduler runs (an OFF scheduler
  // is already surfaced above). Scans ALL posts, not the horizon slice.
  if (schedulerRunning) {
    const OVERDUE_GRACE_MS = 10 * 60_000;
    const cloudFailures = state.cloudFailures || {};
    const nowMs = Date.now();
    for (const c of campaigns) {
      if (!c.active || c.error) continue;
      for (const p of c.posts || []) {
        if (p.approval !== 'approved' || p.derivedState !== 'overdue' || p.status === 'posted') continue;
        const t = Date.parse(p.scheduledAt || '');
        if (!Number.isFinite(t) || nowMs - t <= OVERDUE_GRACE_MS) continue;
        const fail = cloudFailures[`${c.id}:${p.id}`];
        const reason = fail && fail.message ? ` - cloud fire failed: ${fail.message}` : '';
        blockers.push(`overdue: ${c.id}/${p.id} is approved and past due but not published${reason}`);
        blockerCodes.push({ code: 'blocker.overdueUnpublished', params: { campaign: c.id, postId: p.id, reason: (fail && fail.message) || null } });
      }
    }
  }
  return {
    ok: true,
    ready: blockers.length === 0,
    schedulerRunning,
    blockers,
    blockerCodes,
    nextDue: upcoming,
    // Machine-readable setup-completeness breakdown (per-platform status +
    // validation + missing inputs + next action), read by the agent (pendpost_health)
    // and the dashboard Setup page. Already computed above to drive the C2 blockers;
    // omitted in the cross-client overview roll-up (includeSetup:false) where only
    // the counts are used.
    ...(includeSetup ? { setup } : {}),
  };
}

// ---------- cross-client overview (C4) ----------

// READ-ONLY cross-client roll-up. Iterates the client registry (listClients)
// and reads each client's metrics under that client's OWN
// withClient(clientRoot(id), ...) scope - one client per scope, assembled
// SYNCHRONOUSLY (no concurrency) so AsyncLocalStorage bindings never overlap and
// no read crosses into another client's secrets/plans. Each row carries booleans
// + counts only (never the 368's blockedUntil/reason/fbTraceId, never a secret).
//
// Per-row metrics, reusing pendpostHealth() with an EXPLICIT horizon so the
// pending/overdue counts are well-defined and never silently truncated:
//   ready             - pendpostHealth.ready (per-client readiness)
//   schedulerRunning  - pendpostHealth.schedulerRunning (per-client state flag)
//   pending           - count of due posts in the horizon (waiting-due + overdue)
//   overdue           - count of those that are past due
//   metaBlocked       - isMetaBlocked(loadState()) - the 368 breaker, READ ONLY
//   nextDue           - the soonest due post's scheduledAt (ISO string), or null
//
// FAIL-SOFT: a corrupt/unreadable client subtree turns into a row that carries an
// `error` marker while every sibling row still resolves - the roll-up never
// throws / 500s for the whole set. It NEVER auto-retries or pokes a 368: it only
// reads metaBlocked. ZERO writes anywhere.
export function clientsOverview({ horizon = 20 } = {}) {
  const { activeClientId, clients } = listClients();
  const rows = clients.map((c) => {
    const base = { id: c.id, displayName: c.displayName, status: c.status };
    try {
      return withClient(clientRoot(c.id), () => {
        // A corrupt/unreadable manifest is the per-client subtree corruption
        // case: loadPlanStore() reports it as manifestError (it does not throw),
        // so detect it HERE and mark the row's error while siblings still
        // resolve. pendpostHealth still returns (ready:false) so the row stays
        // shaped, but error takes precedence as the incident signal.
        const { manifestError } = loadPlanStore({ includePosts: false });
        const health = pendpostHealth({ horizon, includeSetup: false });
        const due = health.nextDue || [];
        const overdue = due.filter((p) => (p.blockers || []).some((b) => /overdue/i.test(b))).length;
        const metaBlocked = isMetaBlocked(loadState());
        return {
          ...base,
          ready: health.ready,
          schedulerRunning: health.schedulerRunning,
          pending: due.length,
          overdue,
          metaBlocked,
          nextDue: due.length ? (due[0].scheduledAt || null) : null,
          error: manifestError ? { code: 'manifest_error', message: manifestError } : null,
        };
      });
    } catch (err) {
      // Fail-soft per row: a corrupt subtree (unreadable manifest/state) is
      // marked, not fatal. Counts degrade to nulls; siblings still resolve.
      return {
        ...base,
        ready: null,
        schedulerRunning: null,
        pending: null,
        overdue: null,
        metaBlocked: null,
        nextDue: null,
        error: { code: err.code || 'manifest_error', message: err.message },
      };
    }
  });
  return { activeClientId, clients: rows };
}

// ---------- publish preview / dry-run (C3) ----------

// The publishing LANE that owns a post platform - NOT the post platform itself.
// facebook AND instagram both publish through the 'meta' lane, so resolveMode
// must be called with the lane key or mock/live is wrong (the one easy C3 bug).
// Built-in + registered lanes (allLanes) are searched so a dropped-in driver's
// platform maps to its own lane; an unknown platform falls back to itself.
function laneForPlatform(platform) {
  for (const [lane, entry] of Object.entries(allLanes())) {
    if (entry.platforms.includes(platform)) return lane;
  }
  return platform;
}

// STRICTLY READ-ONLY dry-run: describe, for each due post in the horizon, which
// posts would fire, on which lanes, in which mode ('mock'|'live'), and with what
// blockers. It NEVER spawns an engine (no execScript/execFile) and NEVER mutates
// (no plan/state/activity write). It only stitches existing reads:
//   pendpostHealth   -> the due-post horizon + global readiness/schedulerRunning,
//   platformValidate -> per-platform ready + problems (approval, media, 368, ...),
//   resolveMode(LANE) -> the same mock|live derivation ModeBadge shows.
// A recorded Meta-368 surfaces as a per-platform blocker (inherited from
// platformValidate) and the preview STILL returns ok:true - it describes, never
// pokes the blocked lane.
export async function publishPreview({ horizon = 5, campaign = null } = {}) {
  // Same clamp as pendpostHealth (1..20, default 5); pendpostHealth re-clamps too.
  const h = Math.min(Math.max(Number.isFinite(horizon) ? horizon : 5, 1), 20);
  const health = pendpostHealth({ horizon: h, includeSetup: false });
  const due = (health.nextDue || []).filter((p) => !campaign || p.campaign === campaign);

  const posts = [];
  for (const p of due) {
    // platformValidate re-reads the post from the manifest and returns per-platform
    // { ready, problems[], warnings[] }; warnings are advisory and never block.
    const validation = await platformValidate({ campaign: p.campaign, postId: p.postId });
    const perPlatform = (validation && validation.ok && validation.platforms) || {};
    // platformValidate no longer lists approval in problems[] (it's the post-level
    // Entwurf state, not a per-lane fault). The dry-run preview, however, must still
    // explain WHY an unapproved post won't fire, so re-add it as the first blocker.
    const unapproved = validation?.ok && validation.approval !== 'approved';
    const platforms = (p.platforms || []).map((platform) => {
      const lane = laneForPlatform(platform);
      const entry = perPlatform[platform] || { ready: false, problems: [] };
      const blockers = Array.isArray(entry.problems) ? [...entry.problems] : [];
      if (unapproved) blockers.unshift(`approval is "${validation.approval}" - only approved posts publish`);
      return {
        platform,
        lane,
        // resolveMode is called with the LANE key (meta for fb/ig), not the
        // platform, so the dry-run's mock|live matches the engine + ModeBadge.
        mode: resolveMode(lane),
        ready: entry.ready === true,
        blockers,
      };
    });
    posts.push({ campaign: p.campaign, postId: p.postId, scheduledAt: p.scheduledAt, platforms });
  }

  return {
    ok: true,
    ready: health.ready,
    schedulerRunning: health.schedulerRunning,
    posts,
  };
}

// Ingest a new media file into data/media. Bytes arrive one of three ways:
// a raw Buffer (the HTTP upload route hands the readBodyRaw buffer straight
// through - no base64 round-trip), base64 (MCP back-compat), or a repo-local
// filePath (the MCP face - an agent points at a render to copy in).
// Refuses overwrite, validates the name (no traversal, allowed extensions),
// writes atomically (tmp + rename), and logs one asset-upload activity entry.
export async function uploadAsset({ filename, filePath = null, base64 = null, bytes = null, actor } = {}, extract = extractDefaultCover) {
  const actErr = requireActor(actor);
  if (actErr) return actErr;
  let safe;
  try {
    safe = sanitizeAssetName(filename);
  } catch (err) {
    return errorBody('invalid_input', err.message);
  }
  const RENDERS_DIR = rendersDir();
  const dest = path.join(RENDERS_DIR, safe);
  if (fs.existsSync(dest)) {
    return errorBody('invalid_input', `a file named ${safe} already exists in data/media - rename or delete it first`);
  }
  let buf;
  try {
    if (bytes != null) {
      // Raw Buffer from the HTTP upload route (readBodyRaw) - used as-is, no
      // base64 encode/decode round-trip.
      buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    } else if (base64 != null) {
      buf = Buffer.from(String(base64), 'base64');
    } else if (filePath != null) {
      const abs = path.resolve(String(filePath));
      if (!fs.existsSync(abs)) return errorBody('invalid_input', `source file not found: ${filePath}`);
      buf = fs.readFileSync(abs);
    } else {
      return errorBody('invalid_input', 'provide bytes/base64 (HTTP upload) or filePath (a repo-local source)');
    }
  } catch (err) {
    return errorBody('invalid_input', `could not read the upload: ${err.message}`);
  }
  if (!buf.length) return errorBody('invalid_input', 'the upload is empty');
  try {
    fs.mkdirSync(RENDERS_DIR, { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
  } catch (err) {
    return errorBody('engine_failure', `could not write the asset: ${err.message}`);
  }
  const stat = fs.statSync(dest);
  // US-ASSET-13 follow-up: a freshly ingested VIDEO gets its default cover JPEG
  // sibling auto-extracted right here (best-effort, at the 20% frame), so
  // scanAssets()/the Library + Composer always have a real preview and never need
  // a client-side <video>. A still image has no cover concept and is left alone.
  const cover = await autoCoverFor(dest, extract);
  appendActivity({ campaign: null, postId: null, platform: null, action: 'asset-upload', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
  return { ok: true, file: safe, bytes: stat.size, cover, dir: RENDERS_DIR };
}

// Which plan posts reference the asset at `targetAbs`? Keyed on post.media.path -
// the EXACT same abs-path key scanAssets()/the Library use (resolveMediaPath in
// normalizePost). This MUST run BEFORE any fs mutation: resolveMediaPath returns
// null once the file is gone, so a post-delete scan would always read "unused"
// (the TOCTOU the in-use guard exists to close). Returns [{campaign, postId}].
function usingPosts(targetAbs) {
  const { campaigns } = loadPlanStore();
  const hits = [];
  for (const campaign of campaigns) {
    for (const post of campaign.posts || []) {
      if (post.media && post.media.path === targetAbs) {
        hits.push({ campaign: campaign.id, postId: post.id });
      }
    }
  }
  return hits;
}

// "campaign/postId, campaign/postId" - a stable, human + agent readable list of
// the posts that reference an asset, for the needs_confirm message.
function namePosts(hits) {
  return hits.map((h) => `${h.campaign}/${h.postId}`).join(', ');
}

// The render-sibling cover for a media file (same basename, .jpg). uploadAsset
// does not manage covers; set_cover/clear_cover own override JPEGs - here we only
// ever touch the EXACT <base>.jpg sibling so cover ownership stays clean.
function coverSibling(absPath) {
  return absPath.replace(/\.(mp4|mov)$/i, '.jpg');
}

// Best-effort: generate the <base>.jpg default cover for a freshly written VIDEO
// via the SAME ffmpeg frame extraction set_cover uses (covers.mjs). The default
// frame is taken at 20% of the clip (extractDefaultCover) - past blank intros, so
// the thumbnail shows real content. A still image has no cover concept
// (coverSibling === the file itself) and is skipped, as is a video that somehow
// already has a sibling. NEVER throws - a missing cover must not fail an
// otherwise-good upload; the client paints a frame itself in that rare case.
// `extract` is injectable (tests) and defaults to covers.extractDefaultCover.
// Returns whether a cover landed.
async function autoCoverFor(absMedia, extract) {
  const cover = coverSibling(absMedia);
  if (cover === absMedia) return false; // not a video (.jpg/.png have no cover)
  if (fs.existsSync(cover)) return false; // already covered - never clobber
  try {
    await extract(absMedia, cover);
    return fs.existsSync(cover);
  } catch {
    return false;
  }
}

// One-time, best-effort backfill: extract a default cover (20% frame) for every
// cover-less VIDEO in the active client's data/media so EXISTING libraries get
// real previews without a client-side <video>. Idempotent (videos that already
// have a <base>.jpg sibling are skipped) and failure-isolated (one ffmpeg error
// is counted, never aborts the sweep). Additive maintenance run from boot - NOT a
// REST route or MCP tool, so the API/MCP parity surface is untouched (44/38).
// Returns { scanned, created, skipped, failed }.
export async function backfillCovers(extract = extractDefaultCover) {
  const RENDERS_DIR = rendersDir();
  let files;
  try {
    files = fs.readdirSync(RENDERS_DIR).filter((f) => /\.(mp4|mov)$/i.test(f)).sort();
  } catch {
    return { scanned: 0, created: 0, skipped: 0, failed: 0 };
  }
  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const file of files) {
    const abs = path.join(RENDERS_DIR, file);
    const cover = coverSibling(abs);
    if (fs.existsSync(cover)) { skipped += 1; continue; }
    try {
      // eslint-disable-next-line no-await-in-loop -- serial on purpose: a one-time
      // boot sweep must NOT spawn an ffmpeg-per-video storm (cf. assets.scanAssets).
      await extract(abs, cover);
      if (fs.existsSync(cover)) created += 1; else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { scanned: files.length, created, skipped, failed };
}

// The active clients to backfill at boot. Mirrors scheduler.activeClientIds:
// null = the legacy single-workspace fallback (run unscoped, activeRoot() already
// resolves the right data/). Otherwise every active client gets its own scope.
function backfillClientIds() {
  const registry = readRegistry();
  if (!registry || !Array.isArray(registry.clients)) return [null];
  const ids = registry.clients.filter((c) => c && c.status === 'active' && typeof c.id === 'string').map((c) => c.id);
  return ids.length ? ids : [null];
}

// Boot hook: backfill covers for EVERY active client, each scoped inside its own
// withClient(clientRoot(id)) so it reads that client's data/media. Fire-and-forget
// from server boot (never blocks listen); a per-client failure is logged, never
// thrown. One-time by nature - already-covered videos are skipped on every boot.
export async function bootCoverBackfill() {
  for (const id of backfillClientIds()) {
    const run = async () => {
      try {
        const r = await backfillCovers();
        if (r.created || r.failed) {
          logLine(r.failed ? 'warn' : 'ok', `cover-backfill: ${r.created} generated, ${r.skipped} present, ${r.failed} failed (${r.scanned} videos)`);
        }
      } catch (err) {
        logLine('err', `cover-backfill failed: ${err.message}`);
      }
    };
    // eslint-disable-next-line no-await-in-loop -- one client at a time: never
    // overlap withClient scopes (AsyncLocalStorage), same posture as the scheduler.
    if (id === null) await run();
    else await withClient(clientRoot(id), run);
  }
}

// Delete one asset from data/media (C2). Confirm-gated + in-use-protected:
// refuses with needs_confirm (naming the using post(s)) when any plan post
// references it, unless confirm:true. The paired .jpg cover sibling is removed
// alongside the media. Mirrors deletePost's force posture: with confirm:true the
// plan rows are intentionally left dangling, not auto-rewritten.
export async function deleteAsset({ file, actor, confirm = false } = {}) {
  const actErr = requireActor(actor);
  if (actErr) return actErr;
  let safe;
  try {
    safe = sanitizeAssetName(file);
  } catch (err) {
    return errorBody('invalid_input', err.message);
  }
  const RENDERS_DIR = rendersDir();
  const abs = path.join(RENDERS_DIR, safe);
  if (!fs.existsSync(abs)) {
    return errorBody('invalid_input', `no file named ${safe} in data/media`);
  }
  // In-use scan BEFORE the fs mutation (TOCTOU): resolveMediaPath returns null
  // once the file is gone, so this must precede the unlink.
  const hits = usingPosts(abs);
  if (hits.length && confirm !== true) {
    return errorBody('needs_confirm', `${safe} is used by ${hits.length} post(s) (${namePosts(hits)}); deleting it leaves those posts pointing at a missing render. Pass confirm: true to delete anyway.`, { usedBy: hits });
  }
  let coverRemoved = false;
  try {
    fs.unlinkSync(abs);
  } catch (err) {
    return errorBody('engine_failure', `could not delete the asset: ${err.message}`);
  }
  // Best-effort cover removal AFTER the media is gone - a failure here is a
  // partial state (media deleted, cover orphaned) reported honestly, never a
  // silent half-state.
  const cover = coverSibling(abs);
  let coverError = null;
  if (cover !== abs && fs.existsSync(cover)) {
    try {
      fs.unlinkSync(cover);
      coverRemoved = true;
    } catch (err) {
      coverError = err.message;
    }
  }
  appendActivity({ campaign: null, postId: null, platform: null, action: 'asset-delete', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
  const result = { ok: true, deleted: { file: safe, cover: coverRemoved }, dir: RENDERS_DIR };
  if (coverError) result.partial = `media deleted but the cover sibling could not be removed: ${coverError}`;
  return result;
}

// Rename one asset within data/media (C2). sanitizeAssetName runs on BOTH names
// (reject traversal/leading-dot/bad-charset/disallowed-ext), the extension may
// not change (a rename never re-types the asset), the target must not already
// exist (never an overwrite, same posture as uploadAsset), and an in-use asset
// is confirm-gated (renaming breaks the post.file/path reference). The .jpg
// cover sibling is renamed to match - media first, then best-effort the cover.
export async function renameAsset({ file, toName, actor, confirm = false } = {}) {
  const actErr = requireActor(actor);
  if (actErr) return actErr;
  let from;
  let to;
  try {
    from = sanitizeAssetName(file);
  } catch (err) {
    return errorBody('invalid_input', err.message);
  }
  try {
    to = sanitizeAssetName(toName);
  } catch (err) {
    return errorBody('invalid_input', err.message);
  }
  const fromExt = path.extname(from).toLowerCase();
  const toExt = path.extname(to).toLowerCase();
  if (fromExt !== toExt) {
    return errorBody('invalid_input', `rename cannot change the extension (${fromExt} -> ${toExt}); a rename never re-types the asset`);
  }
  if (from === to) {
    return errorBody('invalid_input', 'the new name is identical to the current one');
  }
  const RENDERS_DIR = rendersDir();
  const fromAbs = path.join(RENDERS_DIR, from);
  const toAbs = path.join(RENDERS_DIR, to);
  if (!fs.existsSync(fromAbs)) {
    return errorBody('invalid_input', `no file named ${from} in data/media`);
  }
  if (fs.existsSync(toAbs)) {
    return errorBody('invalid_input', `a file named ${to} already exists in data/media - rename or delete it first`);
  }
  // In-use scan BEFORE the fs mutation (TOCTOU).
  const hits = usingPosts(fromAbs);
  if (hits.length && confirm !== true) {
    return errorBody('needs_confirm', `${from} is used by ${hits.length} post(s) (${namePosts(hits)}); renaming it breaks those posts' media reference. Pass confirm: true to rename anyway.`, { usedBy: hits });
  }
  try {
    fs.renameSync(fromAbs, toAbs);
  } catch (err) {
    return errorBody('engine_failure', `could not rename the asset: ${err.message}`);
  }
  // Best-effort cover rename AFTER the media is moved. A failure here is a
  // partial state (media renamed, cover stranded) reported honestly.
  let coverRenamed = false;
  let coverError = null;
  const fromCover = coverSibling(fromAbs);
  const toCover = coverSibling(toAbs);
  if (fromCover !== fromAbs && fs.existsSync(fromCover)) {
    if (fs.existsSync(toCover)) {
      coverError = `the cover sibling ${path.basename(toCover)} already exists; left ${path.basename(fromCover)} in place`;
    } else {
      try {
        fs.renameSync(fromCover, toCover);
        coverRenamed = true;
      } catch (err) {
        coverError = err.message;
      }
    }
  }
  appendActivity({ campaign: null, postId: null, platform: null, action: 'asset-rename', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
  const result = { ok: true, renamed: { from, to, cover: coverRenamed }, dir: RENDERS_DIR };
  if (coverError) result.partial = `media renamed but the cover sibling was not moved: ${coverError}`;
  return result;
}
