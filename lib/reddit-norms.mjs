// reddit-norms.mjs - the subreddit-RULE-TEXT classifier + the Reddit composition doctrine.
// Zero-dep, pure, no I/O. Sibling of lib/lane-readiness.mjs in every respect, and it lives in
// lib/ for the same reason that one does: the classifier runs inside the reddit-social.mjs
// SUBPROCESS while the doctrine is read by lib/mcp.mjs and lib/radar-prompt.mjs in the SERVER
// process, so it has to sit on the boundary both can import.
//
// WHY THIS EXISTS. Until now pendpost read only the MACHINE-readable submission gates:
// /api/v1/<sub>/post_requirements (flair-required, title rules) and /r/<sub>/about
// (subreddit_type, submission_type). Those are the rules Reddit can enforce for you. The rules
// that actually get a post REMOVED are written in prose in /r/<sub>/about/rules - "No AI
// generated slop", "Use showcase tag to share your work", "self-promotion only on Saturdays" -
// and pendpost was blind to every one of them. A launch post went into r/mcp with no flair
// against a rule that asks for one, because is_flair_required was false and nothing else looked.
//
// WHAT THIS IS NOT. It is not a moderation engine and it never blocks: classifySubRules returns
// display-only WARNINGS in the presubmit channel's existing { code, text } shape. Owner decision
// (spec 37, reversed 2026-07-13, do not re-litigate): an approved reddit post auto-publishes,
// warm or cold, organic or promotional. These warnings tell the operator what the room expects
// BEFORE they approve. They never touch `ready`, never reach problems[], never gate anything.
//
// The matching is deliberately COARSE. A rule list is human prose in any wording, so a keyword
// classifier will miss cases and occasionally over-fire. That is the right trade for an advisory:
// a missed rule costs what pendpost already costs today (nothing), and a false positive costs one
// extra amber line the operator can read past. Nothing here is precise enough to gate on, which
// is exactly why nothing here gates.

// The classifier table. Order is display order; the FIRST rule matching a code wins (a sub with
// three self-promo rules produces one selfPromoRestricted warning, not three).
//
// Exported as data so test/reddit-norms.test.mjs can iterate it, the same fixture discipline
// READINESS_CASES uses. Each entry: { code, re } where re is tested against the rule's
// short_name + description, lowercased and whitespace-collapsed.
export const NORM_PATTERNS = [
  {
    code: 'aiContentRestricted',
    re: /\b(ai[ -]?(generated|written|slop|content)|llm[ -]?(generated|written)|chatgpt|gpt[ -]?\d|bot[ -]?(generated|post)|low[ -]?effort|slop)\b/,
  },
  {
    code: 'selfPromoRestricted',
    re: /(self[ -]?promo|selfpromo|promotion|advertis|\bshill|\byour own (project|product|tool|app|startup|blog|content)|\b9\s*[:/]\s*1\b|\b1\s*[:/]\s*9\b|\bastroturf)/,
  },
  {
    code: 'flairExpected',
    re: /(\bflair|\btag your\b|\bshowcase\b|\bproper tag|\bpost tag)/,
  },
  {
    code: 'postingWindow',
    re: /(only on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\b(weekly|monthly|daily) (thread|post)|\bmegathread|\bsticky (thread|post)|\bself[ -]?promo(tion)? (day|thread))/,
  },
  {
    code: 'participationRequired',
    re: /(\bactive (member|participant|contributor)|\bparticipat|\bcontribut(e|ing|or)\b|\blurk|\bcomment (first|history)|\bkarma\b|\baccount age\b)/,
  },
  {
    code: 'noWaitlist',
    re: /(\bwait[ -]?list|\bearly access\b|\bsign[ -]?up (required|wall)|\bbeta invite|\bpaywall)/,
  },
];

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Classify one subreddit's prose rules into presubmit warnings.
 *
 * @param {object} input
 *   rules        - the /r/<sub>/about/rules `rules` array ([{ short_name, description, ... }]).
 *                  Anything non-array is treated as "no rules read" (zero warnings), so a failed
 *                  or unparseable read degrades to silence rather than a false all-clear claim
 *                  dressed up as a check.
 *   submitText   - about.submit_text, the "read this before posting" sticky. Scanned as one more
 *                  pseudo-rule because subs routinely put the real expectations there and not in
 *                  the rule list.
 *   flairRequired- the post_requirements is_flair_required boolean. When TRUE the flair gate is
 *                  already a BLOCKING problem upstream (evaluateSubProblems), so flairExpected
 *                  would be a duplicate row and is suppressed.
 *   hasFlair     - whether the post already carries a redditFlairId. A post with a flair picked
 *                  does not need to be told the sub wants one.
 * @returns {{code: string, text: string}[]} presubmit warnings, in NORM_PATTERNS order.
 *   `text` is the rule's own short_name so the operator sees WHICH rule fired; the app localizes
 *   `blockers.presubmit.<code>` and interpolates {text}. This is the { code, text } shape the
 *   presubmit channel already uses (presubmitNeedsScope), NOT the { code, params } advisory shape.
 */
export function classifySubRules({ rules, submitText, flairRequired = false, hasFlair = false } = {}) {
  const entries = (Array.isArray(rules) ? rules : []).map((r) => ({
    label: String(r?.short_name || r?.violation_reason || 'rule').slice(0, 80),
    text: norm(`${r?.short_name || ''} ${r?.violation_reason || ''} ${r?.description || ''}`),
  }));
  const sticky = norm(submitText);
  if (sticky) entries.push({ label: 'posting guidelines', text: sticky });

  const out = [];
  for (const { code, re } of NORM_PATTERNS) {
    if (code === 'flairExpected' && (flairRequired || hasFlair)) continue;
    const hit = entries.find((e) => re.test(e.text));
    if (hit) out.push({ code, text: hit.label });
  }
  return out;
}

// The composition doctrine handed to whatever writes a Reddit submission (the drafting agent via
// plan_create_post, and radarDraftPrompt when a batch touches reddit). It is prose, not policy:
// nothing enforces it, and that is the point. The three brand-lint matchers catch the mechanical
// tells after the fact; this is what stops them being written in the first place.
//
// Written under the owner's standing rules: zero dash characters, no puffery, no rule-of-three.
export const REDDIT_POST_DOCTRINE = `HOW A REDDIT SUBMISSION HAS TO BE WRITTEN
Reddit removes launch announcements, and its readers downvote what survives. A post that reads
like a press release is the single most common way this lane fails. Write it like this instead:
- The title is the READER'S problem, never your product. Someone scanning should recognise their
  own situation in it. "Built an X that does Y" is a headline. "Anyone else not want their agent
  posting unsupervised?" is a thread.
- One idea per post. Cut the platform list. Cut the stack list. A post that explains one thing
  well collects comments; a post that explains nine gets scrolled past.
- First person, past tense, concrete friction. What actually went wrong that made you build it.
  Specifics are the only thing that reads as human, and they cannot be faked from a spec sheet.
- Name the product once, late, in a single clause. Never in the title.
- No link in the body, and never the phrase "in comments". That is bait, readers treat it as bait,
  and on a new account the spam filter does too. Let someone ask for it.
- Ask one thing you genuinely do not know the answer to. A question that presents both options and
  implies the answer reads as engagement farming. A real question invites correction, and
  correction is what Reddit rewards.
- Disclosure is casual and inline ("I wrote it, so grain of salt"), never a formal
  "Disclosure: I built it." line, which reads as compliance boilerplate.
- Match the room. A protocol subreddit wants design tradeoffs. A self-hosting subreddit wants
  deployment reality: what it costs to run, how it updates, what breaks.
- Earn the post. On a new or low-karma account, comment usefully for a week before submitting
  anything at all. Reddit's filter measures reciprocity and no wording substitutes for it.`;
