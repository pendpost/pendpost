#!/usr/bin/env node
// test/reddit-norms.test.mjs - the subreddit PROSE-rule classifier + the Reddit shape lint.
//
// What this guards: pendpost used to read only the machine-readable submission gates, so the
// rules that actually get a post removed ("No AI generated slop", "Use showcase tag") were
// invisible and a flairless launch post passed presubmit as ready:true. These assertions pin
// the two halves of the fix: the classifier emits the right advisory codes in the right SHAPE
// ({ code, text }, what the presubmit channel and its localizer already speak), and the three
// brand-lint matchers fire on the copy that died while staying silent on every other lane.
// Zero-dep node:assert, same discipline as test/lane-readiness.test.mjs.
// HERMETIC workspace: brandLint loads the ACTIVE client's rules.json
// (activeRoot()), so an unpinned run silently follows whatever client the live
// Studio last activated (a client pack without the reddit-* shape rules fails
// this suite with zero code changes - same fragility fixed in humanize.test.mjs
// on 2026-07-22). Pin an empty temp root so the repo's own rules.json loads.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PENDPOST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-reddit-norms-'));
const { classifySubRules, NORM_PATTERNS, REDDIT_POST_DOCTRINE } = await import('../lib/reddit-norms.mjs');
const { brandLint } = await import('../lib/lint.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); console.log(`  ok - ${msg}`); pass += 1; };

const codes = (out) => out.map((w) => w.code);

// ---------------------------------------------------------------------------------------
// 1. One representative rule per pattern. This is the fixture-driven half: every code in
//    NORM_PATTERNS must have a case here, so adding a pattern without a case fails the test.
// ---------------------------------------------------------------------------------------
const CASES = [
  { code: 'aiContentRestricted', rule: { short_name: 'No AI generated slop', description: 'Low effort AI generated posts are removed.' } },
  { code: 'selfPromoRestricted', rule: { short_name: 'No astroturfing', description: 'Do not promote your own product without disclosure.' } },
  { code: 'flairExpected', rule: { short_name: 'Use showcase tag to share your work', description: 'Tag your post correctly.' } },
  { code: 'postingWindow', rule: { short_name: 'Self promo day', description: 'Project posts only on Saturday, use the weekly thread otherwise.' } },
  { code: 'participationRequired', rule: { short_name: 'Be a member first', description: 'You must be an active participant before posting your own work.' } },
  { code: 'noWaitlist', rule: { short_name: 'No waitlists', description: 'No early access signup posts.' } },
];
for (const c of CASES) {
  const out = classifySubRules({ rules: [c.rule] });
  ok(codes(out).includes(c.code), `rule "${c.rule.short_name}" classifies as ${c.code}`);
}
ok(
  NORM_PATTERNS.every((p) => CASES.some((c) => c.code === p.code)),
  'every NORM_PATTERNS code has a fixture case (a new pattern cannot land untested)',
);

// 2. The warning SHAPE is the presubmit channel's { code, text } - NOT the { code, params }
//    advisory shape. app/src/components/ui.jsx interpolates a single {text}; the wrong shape
//    would render an empty parenthesis to the operator and pass every other test silently.
const shaped = classifySubRules({ rules: [{ short_name: 'No AI generated slop', description: '' }] });
eq(shaped, [{ code: 'aiContentRestricted', text: 'No AI generated slop' }], 'a warning is { code, text } carrying the rule short_name');

// 3. Silence is the default. A benign rule list, an empty list, a failed read (non-array) and
//    a missing argument all produce zero warnings - never a fabricated all-clear, never a throw.
eq(classifySubRules({ rules: [{ short_name: 'Be civil', description: 'No personal attacks.' }] }), [], 'a benign rule list produces no warnings');
eq(classifySubRules({ rules: [] }), [], 'an empty rule list produces no warnings');
eq(classifySubRules({ rules: null }), [], 'a failed rules read (null) degrades to no warnings');
eq(classifySubRules({}), [], 'no arguments at all is not a crash');

// 4. flairExpected is suppressed where it would be a duplicate or a lie: when the API already
//    requires a flair (that is a BLOCKING flairRequired problem upstream), and when the post
//    already carries one. This is the r/mcp case: rule 4 asks for a showcase tag while
//    is_flair_required is false, which is exactly why the check had to exist at all.
const flairRule = [{ short_name: 'Use showcase tag', description: 'Flair your post.' }];
ok(codes(classifySubRules({ rules: flairRule })).includes('flairExpected'), 'flairExpected fires when the API does not require a flair and none is picked');
ok(!codes(classifySubRules({ rules: flairRule, flairRequired: true })).includes('flairExpected'), 'flairExpected is suppressed when the API already requires a flair (no duplicate row)');
ok(!codes(classifySubRules({ rules: flairRule, hasFlair: true })).includes('flairExpected'), 'flairExpected is suppressed once the post carries a flair');

// 5. submit_text (the "read before posting" sticky) is scanned as one more rule - subs
//    routinely put the real expectation there rather than in the rule list.
const sticky = classifySubRules({ rules: [], submitText: 'Please do not post AI generated content here.' });
eq(sticky, [{ code: 'aiContentRestricted', text: 'posting guidelines' }], 'submit_text is classified too, labelled as the posting guidelines');

// 6. One warning per code, whatever the rule count. Three self-promo rules is still one row.
const many = classifySubRules({ rules: [
  { short_name: 'No self promo', description: '' },
  { short_name: 'Advertising banned', description: '' },
  { short_name: 'No shilling', description: '' },
] });
eq(many, [{ code: 'selfPromoRestricted', text: 'No self promo' }], 'repeated rules of one kind collapse to a single warning');

// 7. The doctrine exists, is substantive, and obeys the owner's standing no-dash rule (it is
//    injected verbatim into the plan_create_post tool description, so it is outward-facing).
ok(REDDIT_POST_DOCTRINE.length > 400, 'REDDIT_POST_DOCTRINE carries actual guidance');
ok(!/[–—]/.test(REDDIT_POST_DOCTRINE), 'REDDIT_POST_DOCTRINE contains no em or en dashes');

// ---------------------------------------------------------------------------------------
// 8. The shape lint, against the copy that actually died in r/mcp (verbatim from
//    launch-oss-2026-07). Each matcher must fire on the real draft, not just a synthetic.
// ---------------------------------------------------------------------------------------
const DEAD_DRAFT = [
  'Built an MCP server for social media with a human approval gate you control',
  'I wanted an agent to schedule my posts but not to post unsupervised, so I built pendpost.',
  'It is zero-dep, serves MCP over JSON-RPC, and now also speaks stdio so the Claude Desktop bundle is one click.',
  'Repo + .mcpb in comments.',
  'Disclosure: I built it.',
].join('\n');

const firedOn = (text, platform) => brandLint({ text, platform }).findings.filter((f) => f.rule.startsWith('reddit-')).map((f) => f.rule);
const dead = firedOn(DEAD_DRAFT, 'reddit');
for (const rule of ['reddit-launch-shape', 'reddit-spec-dump', 'reddit-bait-phrase']) {
  ok(dead.includes(rule), `${rule} fires on the r/mcp draft that Reddit filtered`);
}

// 9. Platform gating. The SAME text on any other lane fires none of them: the launch-post
//    shape is only a removal risk in the room that removes posts for it, and a LinkedIn
//    caption must not inherit Reddit's norms.
for (const p of ['linkedin', 'x', 'instagram', undefined]) {
  eq(firedOn(DEAD_DRAFT, p), [], `the reddit shape rules stay silent on platform=${p || 'none'}`);
}

// 10. A post written to the doctrine is clean: problem first, no stack list, no bait, the
//     product named once and late. This is the rewrite target, so it has to actually pass.
const GOOD_DRAFT = [
  'How much history should an agent see before it drafts in your voice?',
  'I kept a scheduling agent on a short leash for a month because I did not trust it to publish unread.',
  'The part I keep going back and forth on is memory. Stateless drafts are safe but generic.',
  'What have you settled on? I run a small approval gate called pendpost, so grain of salt.',
].join('\n');
eq(firedOn(GOOD_DRAFT, 'reddit'), [], 'a post written to the doctrine trips none of the reddit shape rules');

console.log(`\nreddit-norms: ${pass} assertions passed`);
