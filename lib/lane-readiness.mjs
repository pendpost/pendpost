// lane-readiness.mjs - the pure account-warmth publish ADVISORY judge (spec 37).
//
// Reddit is the reference "handle-with-care" lane (spec 36): the free Data API is
// non-commercial, subreddits gate on karma/age/flair, and a cold or norm-violating account
// can have its post removed. This module screens each Reddit post and surfaces the concerns
// as display-only ADVISORIES.
//
// Owner decision (spec 37, RECORDED - reversed 2026-07-13, do not re-litigate): pendpost's
// integration posts to Reddit safely using account-warmth screening, so an approved Reddit
// post AUTO-EXECUTES via publish-due for EVERY case - warm or cold, organic or promotional
// (owner: "promo auto-publishes too", "warn and allow" a cold account). The earlier Tier-0
// manual copy-paste handoff (Offene Aktionen) is RETIRED. This judge therefore no longer
// ROUTES; it returns { advisories: [{code, params}] } that the app renders as warnings
// (promo / cold / subRequirements) beside the approval and the post still publishes.
//
// CRITICAL - the fence is UNCHANGED and load-bearing: auto-APPROVE is ALWAYS forbidden for a
// MANUAL_LANE (lib/auto-approve.mjs) - a DISTINCT human must approve EVERY reddit post. The
// advisories only decide what the operator SEES before approving; approval always leads to
// auto-publish. No cadence/rate-limit engine (spec 36 §4, kept).
//
// The advisories are DERIVED, never stored. They ACCUMULATE (a post can be promo AND cold):
//   - promo           : the post is (or may be) promotional (ABSENCE of isPromo === promo).
//   - cold            : the account is new/low-karma (age<30 || karma<100; missing = cold).
//   - subRequirements : the subreddit's post requirements are not (proven) met.
//
// The engine emits { code, params } ONLY (NO prose - the app localizes). A MIRROR twin lives
// in app/src/lib/format.js for display; ONE shared fixture (READINESS_CASES, below) guards
// that the engine judge and the app twin stay in lockstep. ZERO deps (node built-ins only).

// The SINGLE source of truth for which lanes are HUMAN-APPROVAL-REQUIRED and therefore
// EXCLUDED from policy auto-approve (the fence). Imported by the auto-approve guard
// (lib/auto-approve.mjs) and mirrored in app/src/lib/format.js for the Settings platform
// picker filter (the browser bundle cannot import lib/ - the mirror is guarded by the shared
// fixture test, the same browser-boundary pattern as format.js#postNeedsMedia). NOTE: this
// name means "human-approval-required lane", NOT "manual-execution lane" - after the 2026-07-13
// reversal a MANUAL_LANE still auto-EXECUTES after approval; it just cannot auto-APPROVE.
export const MANUAL_LANES = new Set(['reddit']);

// The account-warmth thresholds below which a Reddit post gets a `cold` advisory. Deliberately
// lean - no cadence/rate-limit engine (spec 37 keeps spec 36 §4's "no cadence engine").
export const WARMTH_MIN_AGE_DAYS = 30;
export const WARMTH_MIN_KARMA = 100;

// laneReadiness(lane, { accountAgeDays, linkKarma, commentKarma, subRequirementsMet, isPromo })
//   -> { advisories: [{ code, params }] }
// A non-manual lane is never screened (empty advisories). For a manual lane the concerns above
// are collected (ALL that apply), fail-closed (a missing input yields the safe-side advisory).
export function laneReadiness(lane, inputs = {}) {
  if (!MANUAL_LANES.has(lane)) return { advisories: [] };
  const { accountAgeDays, linkKarma, commentKarma, subRequirementsMet, isPromo } = inputs || {};
  const advisories = [];

  // Promotional (or unknown) -> warn. ABSENCE = promo (the safe default): a legacy reddit post
  // with no isPromo warns as promotional. It still publishes (owner: promo auto-publishes too).
  if (isPromo !== false) advisories.push({ code: 'promo', params: {} });

  // Cold account -> warn. A missing/NaN warmth input is fail-closed to cold (never a crash). The
  // computed age/karma ride the advisory so the app can render the exact numbers.
  const age = Number(accountAgeDays);
  const lk = Number(linkKarma);
  const ck = Number(commentKarma);
  const karmaKnown = Number.isFinite(lk) && Number.isFinite(ck);
  const karma = karmaKnown ? lk + ck : null;
  if (!Number.isFinite(age) || !karmaKnown || age < WARMTH_MIN_AGE_DAYS || karma < WARMTH_MIN_KARMA) {
    advisories.push({ code: 'cold', params: { ageDays: Number.isFinite(age) ? age : null, karma } });
  }

  // Subreddit requirements not (proven) met -> warn. Undefined is fail-closed. A genuinely
  // unmet requirement (e.g. flair-required) still publishes; if the sub rejects it, that
  // surfaces as an ordinary publish failure (no account-standing harm from one removed post).
  if (subRequirementsMet !== true) advisories.push({ code: 'subRequirements', params: {} });

  return { advisories };
}

// The ONE shared fixture that guards the engine judge (this module) AND the app twin
// (app/src/lib/format.js#laneReadiness) stay in lockstep. Both the node test
// (test/lane-readiness.test.mjs) and the app twin test
// (app/src/lib/__tests__/lane-readiness-twin.test.js) iterate these cases and assert an
// identical verdict. Deep-equal on the whole { advisories } shape (codes AND params).
export const READINESS_CASES = [
  // --- advisories present (warnings, but the post still auto-publishes after approval) -------
  { name: 'promo explicit', lane: 'reddit', inputs: { isPromo: true, accountAgeDays: 400, linkKarma: 900, commentKarma: 900, subRequirementsMet: true }, expect: { advisories: [{ code: 'promo', params: {} }] } },
  { name: 'promo by absence (undefined isPromo)', lane: 'reddit', inputs: { accountAgeDays: 400, linkKarma: 900, commentKarma: 900, subRequirementsMet: true }, expect: { advisories: [{ code: 'promo', params: {} }] } },
  { name: 'cold by age', lane: 'reddit', inputs: { isPromo: false, accountAgeDays: 12, linkKarma: 90, commentKarma: 90, subRequirementsMet: true }, expect: { advisories: [{ code: 'cold', params: { ageDays: 12, karma: 180 } }] } },
  { name: 'cold by karma', lane: 'reddit', inputs: { isPromo: false, accountAgeDays: 400, linkKarma: 40, commentKarma: 20, subRequirementsMet: true }, expect: { advisories: [{ code: 'cold', params: { ageDays: 400, karma: 60 } }] } },
  { name: 'cold by missing warmth (fail-closed)', lane: 'reddit', inputs: { isPromo: false, subRequirementsMet: true }, expect: { advisories: [{ code: 'cold', params: { ageDays: null, karma: null } }] } },
  { name: 'cold by partial warmth (age only)', lane: 'reddit', inputs: { isPromo: false, accountAgeDays: 400, subRequirementsMet: true }, expect: { advisories: [{ code: 'cold', params: { ageDays: 400, karma: null } }] } },
  { name: 'warm+organic but sub-requirements unmet', lane: 'reddit', inputs: { isPromo: false, accountAgeDays: 400, linkKarma: 900, commentKarma: 900, subRequirementsMet: false }, expect: { advisories: [{ code: 'subRequirements', params: {} }] } },
  { name: 'warm+organic but sub-requirements unknown (fail-closed)', lane: 'reddit', inputs: { isPromo: false, accountAgeDays: 400, linkKarma: 900, commentKarma: 900 }, expect: { advisories: [{ code: 'subRequirements', params: {} }] } },
  { name: 'everything missing -> all advisories accumulate', lane: 'reddit', inputs: {}, expect: { advisories: [{ code: 'promo', params: {} }, { code: 'cold', params: { ageDays: null, karma: null } }, { code: 'subRequirements', params: {} }] } },
  // Boundary: exactly at the thresholds is WARM (>=30 days, >=100 karma) -> no cold advisory.
  { name: 'boundary cold (29d)', lane: 'reddit', inputs: { isPromo: false, accountAgeDays: 29, linkKarma: 900, commentKarma: 900, subRequirementsMet: true }, expect: { advisories: [{ code: 'cold', params: { ageDays: 29, karma: 1800 } }] } },
  // --- no advisories (warm + organic + requirements-met) -------------------------------------
  { name: 'boundary warm (exactly 30d / 100 karma)', lane: 'reddit', inputs: { isPromo: false, accountAgeDays: 30, linkKarma: 60, commentKarma: 40, subRequirementsMet: true }, expect: { advisories: [] } },
  { name: 'warm + organic + requirements-met', lane: 'reddit', inputs: { isPromo: false, accountAgeDays: 400, linkKarma: 900, commentKarma: 900, subRequirementsMet: true }, expect: { advisories: [] } },
  // --- non-manual lane -> never screened ----------------------------------------------------
  { name: 'non-manual lane is never screened (bluesky, promo)', lane: 'bluesky', inputs: { isPromo: true }, expect: { advisories: [] } },
  { name: 'non-manual lane is never screened (mastodon, cold)', lane: 'mastodon', inputs: { isPromo: false, accountAgeDays: 1, linkKarma: 0, commentKarma: 0 }, expect: { advisories: [] } },
];
