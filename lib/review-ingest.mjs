// review-ingest.mjs - a client review decision, ingested through the EXISTING
// approval chokepoint (spec 48 §9.3, W3).
//
// A reviewer decision NEVER writes a parallel approval store: the decision IS the
// setApproval write. This module validates the POST body, applies a stale-content
// hash guard IN FRONT of the chokepoint (so a reviewer can never approve copy they
// did not see), refuses a decision on an already-published post, mints the actor
// SERVER-SIDE from the authenticated reviewer (never the request body), and calls
// the existing approvePost / rejectPost (lib/writes.mjs). Everything downstream -
// no-self-approval (now against a REAL second identity), approvedContentHash /
// rejectedContentHash stamping, the editedSinceApproval fence, the activity row,
// the radar reschedule nudge - is INHERITED, not reimplemented.
import fs from 'node:fs';
import path from 'node:path';
import { errorBody } from './util.mjs';
import { withClient, activeRoot } from './context.mjs';
import { clientRoot } from './multi-client.mjs';
import { loadManifest, postContentHash, ALL_PLATFORM_ID_FIELDS } from './plans.mjs';
import { approvePost, rejectPost } from './writes.mjs';
import { REVIEWER_TRUST } from './reviewers.mjs';

// Read the CURRENT raw post (not the normalized/derived view) so the content hash
// we compare against is byte-for-byte the same fingerprint setApproval will stamp,
// and the same one the review bundle advertised.
function currentPost(campaign, postId) {
  const { plans, error } = loadManifest();
  if (error) return { error: errorBody('manifest_error', error) };
  const entry = plans.find((p) => p.id === campaign);
  if (!entry) return { error: errorBody('unknown_campaign', `unknown campaign: ${campaign}`) };
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(path.resolve(activeRoot(), entry.path), 'utf8'));
  } catch (err) {
    return { error: errorBody('manifest_error', `plan file unreadable: ${err.message}`) };
  }
  const post = (plan.posts || []).find((p) => p.id === postId);
  if (!post) return { error: errorBody('unknown_post', `unknown post ${postId} in ${campaign}`) };
  return { post };
}

function isPublished(post) {
  return post.status === 'posted' || ALL_PLATFORM_ID_FIELDS.some((k) => post[k]);
}

// Ingest one decision. `reviewer` is the AUTHENTICATED reviewer record resolved by
// verifyToken (never trusted from the body); `clientId` is the token's client.
// Returns the setApproval result envelope or a { code, message } error body.
export async function ingestDecision({ clientId, reviewer, body } = {}) {
  if (!reviewer || typeof reviewer.id !== 'string') {
    return errorBody('invalid_input', 'missing authenticated reviewer');
  }
  if (!body || typeof body !== 'object') {
    return errorBody('invalid_input', 'a decision body is required');
  }
  const { campaign, postId, verdict, note, contentHash } = body;
  if (typeof campaign !== 'string' || !campaign) return errorBody('invalid_input', 'campaign is required');
  if (typeof postId !== 'string' || !postId) return errorBody('invalid_input', 'postId is required');
  if (verdict !== 'approved' && verdict !== 'rejected') {
    return errorBody('invalid_input', "verdict must be 'approved' or 'rejected'");
  }
  if (typeof contentHash !== 'string' || !contentHash) return errorBody('invalid_input', 'contentHash is required');
  if (note != null && typeof note !== 'string') return errorBody('invalid_input', 'note must be a string');

  let root;
  try { root = clientRoot(clientId); } catch (err) { return errorBody('invalid_input', err.message); }

  // Bind the token's client for the whole write subtree, so the single-resolver
  // isolation rule holds: this decision can only ever touch clientId's plans.
  return withClient(root, async () => {
    const { post, error } = currentPost(campaign, postId);
    if (error) return error;
    // Re-decide is allowed only while pending + unpublished (owner decision O1); a
    // published post's decision can no longer change.
    if (isPublished(post)) {
      return errorBody('invalid_input', 'this post has already been published; the decision can no longer be changed');
    }
    // Stale-content guard IN FRONT of the chokepoint (matrix row 7).
    if (postContentHash(post) !== contentHash) {
      return errorBody('stale_content', 'this post changed since you loaded it; reload the current version and decide again');
    }
    // The actor is minted SERVER-SIDE from the authenticated token - never the body.
    const actor = `reviewer:${clientId}/${reviewer.id}`;
    const args = { campaign, postId, actor, note: note || undefined, [REVIEWER_TRUST]: true };
    return verdict === 'approved' ? approvePost(args) : rejectPost(args);
  });
}
