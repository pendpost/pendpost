// radar-prompt-quality.test.mjs - the WHERE TO LOOK block of the agent scan brief (Wave 3 Q2).
//
// The gap this closes: the child was told WHICH lanes to research but not HOW to reach them, so
// a "search the web" for youtube or quora came back as SEO listicles and vendor pages - none of
// which is a person asking anything. The block pins three things:
//   1. a per-lane search operator, emitted ONLY for lanes in this brief's scope (a lane the
//      child was not briefed on gets no operator, so nothing invites it to wander);
//   2. one explicit rejection line - SEO posts, listicles, roundups, vendor pages, press releases
//      are never signals; only a person asking, complaining or comparing in a thread counts;
//   3. one language fence - German, French, Italian or English only.
// Plus the house rule that the brief carries no em dash anywhere.
//
// Zero-dep node:assert; pure function, no workspace needed.
import assert from 'node:assert';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

try {
  const { radarScanPrompt } = await import('../lib/radar-prompt.mjs');
  const Q = [{ id: 'coach-software-platform', label: 'Coaching software (EN)', keywords: ['coaching software', 'coaching platform'], competitors: ['CoachAccountable'] }];
  const AGENT_LANES = ['x', 'youtube', 'nostr', 'linkedin', 'instagram', 'quora'];

  // ---- (1) operators per lane, scoped ---------------------------------------
  const full = radarScanPrompt(Q, 20, 'bondigoo', AGENT_LANES, null, 'de-CH', { facts: 'A Swiss coaching marketplace.' }, 90, 5 * 60_000);
  ok(/\nWHERE TO LOOK\n/.test(full), 'the brief carries a WHERE TO LOOK block');
  ok(/site:quora\.com/.test(full), 'quora in scope -> site:quora.com');
  ok(/site:youtube\.com\/watch \(the video page and its comments\)/.test(full), 'youtube in scope -> site:youtube.com/watch, naming the watch page AND its comments');
  ok(/site:x\.com/.test(full), 'x in scope -> site:x.com');
  ok(/site:linkedin\.com\/posts/.test(full), 'linkedin in scope -> site:linkedin.com/posts (the operator that was already in the source notes is now also in the lane list)');
  ok(!/site:reddit\.com/.test(full), 'reddit NOT in scope (the engine owns it) -> no site:reddit.com operator, nothing invites the child onto reddit');

  const linkedinOnly = radarScanPrompt(Q, 20, 'bondigoo', ['linkedin'], null, null, null, 90, 5 * 60_000);
  ok(/site:linkedin\.com\/posts/.test(linkedinOnly) && !/site:quora\.com/.test(linkedinOnly) && !/site:youtube\.com/.test(linkedinOnly) && !/site:x\.com/.test(linkedinOnly),
    'a one-lane brief carries exactly that lane\'s operator - the operator list follows the scope, never the capability table');

  const legacy = radarScanPrompt(Q, 20, 'bondigoo');
  ok(/site:reddit\.com \(read-only discovery; report the thread, never post\)/.test(legacy),
    'an older caller passing no scope (full capability set) gets the reddit operator, marked read-only discovery');

  // ---- (2) the rejection line ---------------------------------------------
  for (const p of [full, linkedinOnly, legacy]) {
    ok(/Never a signal: SEO blog posts, listicles, "best tools" roundups, vendor pages and press releases\./.test(p),
      'the rejection line names SEO posts, listicles, roundups, vendor pages and press releases as never-signals');
    ok(/Only a person asking, complaining or comparing in a thread counts\./.test(p),
      'and states the positive test: a person asking, complaining or comparing in a thread');
    // ---- (3) the language fence --------------------------------------------
    ok(/Only threads in German, French, Italian or English\./.test(p), 'the language fence names exactly German, French, Italian, English');
    ok(!/—|–/.test(p), 'no em dash / en dash anywhere in the brief');
  }

  // ---- the block sits between the queries and HOW TO REPORT ------------------
  ok(full.indexOf('queryId: coach-software-platform') < full.indexOf('WHERE TO LOOK') && full.indexOf('WHERE TO LOOK') < full.indexOf('HOW TO REPORT'),
    'WHERE TO LOOK renders after the query blocks and before HOW TO REPORT');
  const added = full.slice(full.indexOf('WHERE TO LOOK'), full.indexOf('HOW TO REPORT')).trim().split('\n').length;
  ok(added <= 8, `the block stays short (${added} lines, cap 8) - it is a fence, not a second brief`);

  // ---- lane-bound hints follow the lane -------------------------------------
  const QS = [{ id: 'coach-get-clients-de', label: 'Coach Kunden (DE)', keywords: ['Coach Kunden finden'], subreddits: ['r/Coaching', 'r/Selbststaendig'], instances: ['mastodon.social'] }];
  const noReddit = radarScanPrompt(QS, 30, 'bondigoo', AGENT_LANES);
  ok(!noReddit.includes('subreddits:'), 'a query\'s saved subreddits are NOT printed when reddit is out of scope (a skipped lane gets no invitation)');
  ok(!noReddit.includes('instances:'), 'a query\'s saved mastodon instances are NOT printed when mastodon is out of scope');
  const withReddit = radarScanPrompt(QS, 30, 'bondigoo', ['reddit', 'mastodon', ...AGENT_LANES]);
  ok(withReddit.includes('subreddits: r/Coaching, r/Selbststaendig'), 'the same subreddits ARE printed once reddit is in scope');
  ok(withReddit.includes('instances: mastodon.social'), 'the same instances ARE printed once mastodon is in scope');

  // ---- out-of-scope fence ------------------------------------------------------
  const fenced = radarScanPrompt(QS, 30, 'bondigoo', AGENT_LANES);
  ok(/Out of scope for this run: [^\n]*\breddit\b/.test(fenced), 'the brief names reddit as OUT OF SCOPE when the lane is skipped (the query brief no longer speaks louder than the scope)');
  ok(/Out of scope for this run: [^\n]*\bbluesky\b/.test(fenced) && /\bmastodon\b/.test(fenced.slice(fenced.indexOf('Out of scope'))), 'bluesky and mastodon are fenced out too');
  const unfenced = radarScanPrompt(QS, 30, 'bondigoo', ['reddit', 'bluesky', 'mastodon', 'hackernews', ...AGENT_LANES]);
  ok(!unfenced.includes('Out of scope for this run'), 'no fence line when every lane is in scope');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-prompt-quality] OK - per-lane operators follow the scope, the rejection line and the language fence are pinned (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-prompt-quality] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
}
