// auto-approve.mjs - the opt-in, owner-configured auto-approve policy.
//
// pendpost is fail-closed by default: every created post is a draft and stays
// one until a DISTINCT actor approves it (lib/writes.mjs setApproval). This
// module is the progressive-autonomy seam: an OWNER may pre-authorize, via a
// policy (config.posting.autoApprove, owner-only to set - lib/config.mjs), that
// posts matching a scope are approved automatically. Two safety facts hold no
// matter what this returns:
//   - The drafting agent never approves its own post. createPost approves via
//     setApproval under AUTO_APPROVE_ACTOR (distinct from the creator and from
//     'owner'), so the no-self-approval rule still governs the single approval
//     path and isSelfApproved() stays false.
//   - Only the owner can enable the policy, so an agent cannot grant itself
//     autonomy and self-publish.
// All publish-time gates (brand-lint, Meta-368 breaker, cadence cap, due-time,
// cloud-managed pause) still apply downstream, independent of this decision.
import { brandLint } from './lint.mjs';

// The approval authority recorded for a policy auto-approval. Distinct from any
// agent creator AND from 'owner', so the audit trail shows the post was blessed
// by the owner's policy (not the agent), and isSelfApproved() is always false.
export const AUTO_APPROVE_ACTOR = 'policy:auto-approve';

// The shape stored at config.posting.autoApprove. enabled defaults false
// (fail-closed). Empty scope list = match all; a non-empty list narrows it.
export const AUTO_APPROVE_DEFAULTS = Object.freeze({
  enabled: false,
  platforms: [],
  campaigns: [],
  types: [],
  requireLintClean: true,
});

function norm(policy) {
  return { ...AUTO_APPROVE_DEFAULTS, ...(policy && typeof policy === 'object' ? policy : {}) };
}

// The PURE scope half: enabled + membership. A post is in scope only if EVERY
// one of its target platforms is trusted (subset rule), so a post touching any
// untrusted lane stays manual. Empty policy list = no constraint on that axis.
export function inAutoApproveScope(post, policy, campaign) {
  const p = norm(policy);
  if (!p.enabled) return { match: false, reason: 'disabled' };
  const platforms = Array.isArray(post?.platforms) ? post.platforms : [];
  if (p.platforms.length && !platforms.every((x) => p.platforms.includes(x))) {
    return { match: false, reason: 'platform out of scope' };
  }
  if (p.campaigns.length && !p.campaigns.includes(campaign)) {
    return { match: false, reason: 'campaign out of scope' };
  }
  if (p.types.length && !p.types.includes(post?.type)) {
    return { match: false, reason: 'type out of scope' };
  }
  return { match: true, reason: 'in scope' };
}

// The full decision: scope + the optional brand-lint gate. brandLint reads no
// disk for a given (text, platform), so this stays deterministic. When
// requireLintClean is on, a caption with ANY error-severity finding on ANY
// target platform is refused (it stays a visible draft for the owner to fix),
// mirroring the scheduler's publish-time lint block.
export function autoApproveDecision(post, policy, campaign) {
  const scope = inAutoApproveScope(post, policy, campaign);
  if (!scope.match) return { approve: false, reason: scope.reason };
  const p = norm(policy);
  if (p.requireLintClean) {
    const caption = String(post?.caption || '');
    const platforms = Array.isArray(post?.platforms) && post.platforms.length ? post.platforms : [null];
    for (const platform of platforms) {
      const res = brandLint({ text: caption, platform: platform || undefined });
      if (res && res.ok && res.clean === false) {
        return { approve: false, reason: `brand_lint error (${platform || 'default'})` };
      }
    }
  }
  return { approve: true, reason: scope.reason };
}
