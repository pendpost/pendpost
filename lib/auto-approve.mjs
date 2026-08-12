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
import { MANUAL_LANES } from './lane-readiness.mjs';

// The approval authority recorded for a policy auto-approval. Distinct from any
// agent creator AND from 'owner', so the audit trail shows the post was blessed
// by the owner's policy (not the agent), and isSelfApproved() is always false.
export const AUTO_APPROVE_ACTOR = 'policy:auto-approve';

// The shape stored at config.posting.autoApprove. enabled defaults false
// (fail-closed). Per-axis empty-list semantics (ux-audit 2026-08-04 P1):
//   - platforms: [] trusts NOTHING - an enabled policy with zero platforms is
//     inert (fail-closed, and what the Settings hint has always promised). Both
//     autonomy policies now agree that empty = off (radar.autoReply's lanes:[]
//     already meant nothing fires).
//   - campaigns / types: [] = no constraint on that axis (a pure narrowing
//     filter over the already-trusted platforms).
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
// untrusted lane stays manual. platforms: [] trusts nothing (the policy is
// inert until the owner names at least one platform); campaigns/types: [] = no
// constraint on that axis.
export function inAutoApproveScope(post, policy, campaign) {
  // HARD SAFETY EXCLUSION (spec 34): a Radar reply-to-external post can NEVER be
  // auto-approved BY THIS POLICY. Replying into someone else's thread is the one action
  // Radar must never take on the strength of a general "auto-approve my posts" setting
  // (auto-posting promotional replies violates community norms and torches the brand).
  // This is a FIELD check (radarReplyTo), NOT a post `type` exclusion, because a Radar
  // reply is an ordinary text post - a type-based rule would not hold. It is ADDITIVE and
  // precedes every other check, so NO policy shape (enabled / empty-scope / matching
  // platforms / campaigns / types / lint-clean) can ever match a Radar reply.
  //
  // It does NOT mean a reply is human-approved in every case, and it never did guarantee
  // that on its own: spec 40 6.7 added an opt-in, owner-authorized, default-off, per-lane
  // auto-reply, decided inside queueRadarReply AFTER this function has already refused.
  // That is deliberate - it is a separate, narrower, explicitly-granted decision rather
  // than a widening of this policy, which is why this guard stays exactly as it is.
  if (post?.radarReplyTo) return { match: false, reason: 'radar_reply_human_only' };
  // HARD SAFETY EXCLUSION (spec 37): a post targeting a MANUAL lane (reddit) can NEVER be
  // auto-approved BY THIS POLICY. Reddit's karma/age/self-promotion norms make an unread
  // post the expensive kind of mistake, so a general "auto-approve my posts" setting must
  // never reach it. This generalizes the radarReplyTo pattern above to a LANE check (any
  // target platform in MANUAL_LANES), keyed on post.platforms - a FIELD/lane check, NOT a
  // post `type`. ADDITIVE and precedes every policy check, so NO policy shape (enabled /
  // empty-scope / matching platforms/campaigns/types / lint-clean) can match a reddit post.
  // STRENGTHENS §H.2 (the approval fence) - it only ever REFUSES, never approves.
  //
  // It does NOT mean every reddit post is human-approved, and this comment used to say it
  // did ("a distinct human must approve EVERY reddit post ... it stays pending until a
  // distinct human approves"). That was an overclaim on a safety boundary, which is the
  // worst place for one: spec 40 6.7's opt-in, owner-authorized, default-off auto-reply
  // includes reddit in RADAR_AUTO_REPLY_LANES and is decided inside queueRadarReply, AFTER
  // this function has already refused - exactly as described for radarReplyTo above. Two
  // doors, deliberately: this one is the broad policy and stays shut; that one is narrow,
  // per-lane, and only the owner can open it. Read this guard as what it is - the fence
  // around THIS policy - not as a property of the system.
  //
  // (Spec 37's warmth tiers decided what happened AFTER approval and were REVERSED on
  // 2026-07-13: an approved reddit post now auto-executes via publish-due in every case,
  // warm or cold or promo, and the Tier-0 "Offene Aktionen" hand-off this comment used to
  // cite no longer exists. The warmth judge is display-only advisories now.)
  const targets = Array.isArray(post?.platforms) ? post.platforms : [];
  if (targets.some((x) => MANUAL_LANES.has(x))) return { match: false, reason: 'manual_lane_human_only' };
  const p = norm(policy);
  if (!p.enabled) return { match: false, reason: 'disabled' };
  // FAIL-CLOSED PLATFORMS AXIS (ux-audit 2026-08-04 P1): an empty platforms list
  // trusts NOTHING. It used to mean match-ALL, so flipping the toggle without
  // ticking a single box silently granted maximum scope while the Settings hint
  // ("auto-approved only if every platform it targets is selected") promised the
  // opposite. A legacy stored { enabled: true, platforms: [] } therefore now
  // refuses instead of matching everything - deliberate: on an ambiguous
  // autonomy grant, fail closed. The Settings card surfaces the inert state.
  if (!p.platforms.length) return { match: false, reason: 'no platforms trusted' };
  const platforms = Array.isArray(post?.platforms) ? post.platforms : [];
  if (!platforms.every((x) => p.platforms.includes(x))) {
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
