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
// The radar-reply trust sub-scope (spec: merge radar auto-reply arming into the auto-approve
// object the owner already knows). DELIBERATELY its own allow-list, NOT the platforms/campaigns/
// types axes: a radar reply posts into a STRANGER's thread, a categorically narrower trust grant
// than posting to your own feed, so trusting mastodon for your own posts must never silently arm
// stranger-replies. lanes is clamped to RADAR_AUTO_REPLY_LANES by the validator (config.mjs), so
// a copy-only / non-reply lane can never be armed. Fail-closed: off, no lanes. This is the
// relocated shape of the retired posting.radar.autoReply door.
export const AUTO_APPROVE_RADAR_REPLY_DEFAULTS = Object.freeze({
  enabled: false,
  lanes: [],
  minScore: null,
  requireLintClean: true,
});

export const AUTO_APPROVE_DEFAULTS = Object.freeze({
  enabled: false,
  platforms: [],
  campaigns: [],
  types: [],
  requireLintClean: true,
  radarReplies: { ...AUTO_APPROVE_RADAR_REPLY_DEFAULTS },
});

function norm(policy) {
  return { ...AUTO_APPROVE_DEFAULTS, ...(policy && typeof policy === 'object' ? policy : {}) };
}

function normRadarReplies(policy) {
  const rr = policy && typeof policy === 'object' ? policy.radarReplies : null;
  return { ...AUTO_APPROVE_RADAR_REPLY_DEFAULTS, ...(rr && typeof rr === 'object' && !Array.isArray(rr) ? rr : {}) };
}

// The PURE radar-reply auto-approve decision. Deliberately SEPARATE from inAutoApproveScope/
// autoApproveDecision above: it reads its OWN allow-list (policy.radarReplies.lanes) and has NO
// MANUAL_LANES / radarReplyTo refusal - reddit is allowed here because the owner named it
// explicitly, the one narrower door the owner opens on purpose. The broad-policy fence above stays
// byte-unchanged and keeps refusing every radar reply on the createPost path. Still not
// self-approval: the caller approves under AUTO_APPROVE_ACTOR (setApproval, the single enforcement
// point). The foreign-link fence, the draft-review hold and the radar.enabled precondition are
// config/state-coupled and stay in queueRadarReply; this pure half handles
// enabled + lane + xEnterprise + score + lint.
// ctx: { lane, scoredBy, intentScore, xEnterprise }. lane is the reply's single target lane.
export function radarReplyAutoApproveDecision(post, policy, ctx = {}) {
  const rr = normRadarReplies(policy);
  if (rr.enabled !== true) return { approve: false, reason: 'disabled' };
  const lane = ctx.lane || (Array.isArray(post?.platforms) ? post.platforms[0] : undefined);
  if (!lane || !Array.isArray(rr.lanes) || !rr.lanes.includes(lane)) {
    return { approve: false, reason: 'lane out of scope' };
  }
  // x replies are lane-eligible ONLY under the owner-declared Enterprise tier (the API refuses a
  // stranger reply otherwise); a stale lanes:['x'] without it fails closed, never fires into a 403.
  if (lane === 'x' && ctx.xEnterprise !== true) {
    return { approve: false, reason: 'x_needs_enterprise' };
  }
  // The score threshold (spec C): with minScore set, only a signal the AGENT scored at/above it
  // auto-posts. A regex match and an agent score are incommensurable, so an engine-scored or
  // uncached signal (scoredBy !== 'agent') fails closed. Absent minScore = enabled + lane + lint.
  if (Number.isFinite(rr.minScore)) {
    if (ctx.scoredBy !== 'agent' || !(Number(ctx.intentScore) >= rr.minScore)) {
      return { approve: false, reason: 'below_score' };
    }
  }
  // The brand-lint gate (default on), mirroring autoApproveDecision: any error-severity finding
  // keeps the reply a visible pending draft. brandLint is pure for a given (text, platform).
  if (rr.requireLintClean !== false) {
    const res = brandLint({ text: String(post?.caption || ''), platform: lane });
    if (res && res.ok && res.clean === false) {
      return { approve: false, reason: `brand_lint error (${lane})` };
    }
  }
  return { approve: true, reason: 'in scope' };
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
