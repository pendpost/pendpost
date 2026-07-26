#!/usr/bin/env node
// test/reddit-presubmit.test.mjs - spec 36 (Reddit per-post subreddit targeting +
// submission advisories). Drives the REAL cmdPresubmit / cmdPublishDue in-process
// with a stubbed global.fetch (no network), mirroring the "LIVE media submit"
// section of test/reddit-media-submit.test.mjs. Asserts:
//   1. a post's redditSubreddit overrides the connection default -> the submit form
//      carries sr=<postSub>;
//   2. posts group by resolved sub -> post_requirements is fetched ONCE per unique
//      sub (two subs = two fetches; two posts on ONE sub = one fetch);
//   3. is_flair_required with no redditFlairId is a BLOCKING problem (not a warning),
//      ready:false; setting redditFlairId clears it;
//   4. a post carrying its OWN redditSubreddit publishes even when REDDIT_SUBREDDIT is
//      unset in .env (the demoted throw);
//   5. the plan_create_post AND presubmit_check tool DESCRIPTIONS contain the Reddit
//      ToS-limit advisory prose (description-contains).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-reddit-presub-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans', 'rd-camp'), { recursive: true });

// Guarded entrypoint (no main() on import): the real engine verbs + the exported RUN
// drain are importable without running the CLI.
const { cmdPresubmit, cmdPublishDue, RUN } = await import('../scripts/reddit-social.mjs');
const { TOOLS } = await import('../lib/mcp.mjs');

const planPath = path.join(WS, 'data', 'plans', 'rd-camp', 'post-plan.json');
// Spec 37 (reversed 2026-07-13): EVERY approved + due reddit post PUBLISHES - there is no
// fire-time tier re-check or manual defer. Warmth screening is display-only advisory. Posts
// default ORGANIC + warm; the cold/promo/unmet cases prove they publish anyway (warn-and-allow).
const approved = { approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: '2020-01-01T00:00:00Z', platforms: ['reddit'], type: 'text', isPromo: false };
// A warm account: created ~10 years ago with 5000 combined karma. A cold one: 5 days old,
// 10 karma. computeWarmth reads created_utc (UNIX seconds) + link_karma + comment_karma.
const WARM_ME = { name: 'botuser', created_utc: 1300000000, link_karma: 3000, comment_karma: 2000 };
const COLD_ME = { name: 'botuser', created_utc: Math.floor(Date.now() / 1000) - 5 * 86400, link_karma: 5, comment_karma: 5 };
function mkPlan(posts) { fs.writeFileSync(planPath, JSON.stringify({ campaign: 'rd-camp', posts }, null, 2)); }
function drain() { const r = RUN.results.slice(); RUN.results.length = 0; return r; }
const presubmitRow = (rows, id) => rows.find((r) => r.postId === id && r.action === 'presubmit');
const hasCode = (list, code) => Array.isArray(list) && list.some((r) => r && r.code === code);

// Router: flags is_flair_required per sub; records every fetched URL so a case can
// count post_requirements calls per sub and capture the submit form's sr.
const realFetch = global.fetch;
const stub = (body, { httpOk = true, status = 200 } = {}) => Promise.resolve({ ok: httpOk, status, text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)) });
function install({ flairRequiredSubs = [], me = WARM_ME } = {}) {
  const calls = [];
  global.fetch = (url, init = {}) => {
    const u = String(url); const method = (init.method || 'GET').toUpperCase();
    calls.push({ u, method, body: init.body ? String(init.body) : '' });
    if (u.includes('/api/v1/access_token')) return stub({ access_token: 'tok' });
    if (u.includes('/post_requirements')) {
      const sr = (u.match(/\/api\/v1\/([^/]+)\/post_requirements/) || [])[1] || '';
      return stub({ is_flair_required: flairRequiredSubs.includes(sr) });
    }
    if (u.includes('/about')) return stub({ data: { subreddit_type: 'public', submission_type: 'any' } });
    if (u.includes('/api/submit')) {
      const form = new URLSearchParams(init.body || '');
      const sr = form.get('sr') || '';
      return stub({ json: { errors: [], data: { name: `t3_${sr}`, id: sr, url: `https://www.reddit.com/r/${sr}/comments/${sr}/x/` } } });
    }
    if (u.includes('/api/v1/me')) return stub(me);
    return stub({}, { httpOk: false, status: 404 });
  };
  return calls;
}
const reqFetches = (calls, sr) => calls.filter((c) => c.u.includes(`/api/v1/${sr}/post_requirements`)).length;
const submitFor = (calls, id) => calls.filter((c) => c.u.includes('/api/submit') && c.method === 'POST');
const diskPost = (id) => JSON.parse(fs.readFileSync(planPath, 'utf8')).posts.find((p) => p.id === id);

try {
  // ---- 1 + 4: PUBLISH honours the per-post sub, and publishes with NO global default ----
  {
    // .env carries creds but NO REDDIT_SUBREDDIT - the post's own sub must still publish.
    fs.writeFileSync(path.join(WS, '.env'), 'REDDIT_CLIENT_ID=cid\nREDDIT_CLIENT_SECRET=sec\nREDDIT_USERNAME=botuser\nREDDIT_PASSWORD=pw\n');
    mkPlan([{ id: 'p_own', title: 'Own sub', caption: 'body', redditSubreddit: 'mcp', ...approved }]);
    const calls = install();
    await cmdPublishDue({ plan: planPath, only: 'p_own' });
    drain();
    const submits = submitFor(calls);
    ok(submits.length === 1, 'a post with its OWN redditSubreddit publishes even when REDDIT_SUBREDDIT is unset (demoted throw)');
    const form = new URLSearchParams(submits[0].body);
    ok(form.get('sr') === 'mcp', 'the submit form targets the per-post subreddit (sr=mcp), not the global default');
    ok(diskPost('p_own').status === 'posted', 'the self-sub post converges to posted');
  }

  // A leading r/ on the per-post sub is stripped before it reaches the API.
  {
    mkPlan([{ id: 'p_rslash', title: 'r-prefixed', caption: 'body', redditSubreddit: 'r/test', ...approved }]);
    const calls = install();
    await cmdPublishDue({ plan: planPath, only: 'p_rslash' });
    drain();
    const form = new URLSearchParams(submitFor(calls)[0].body);
    ok(form.get('sr') === 'test', 'a leading r/ on redditSubreddit is stripped before submit (sr=test)');
  }

  // The connection default still applies when the post carries no per-post sub.
  {
    fs.writeFileSync(path.join(WS, '.env'), 'REDDIT_CLIENT_ID=cid\nREDDIT_CLIENT_SECRET=sec\nREDDIT_USERNAME=botuser\nREDDIT_PASSWORD=pw\nREDDIT_SUBREDDIT=fallbacksub\n');
    mkPlan([{ id: 'p_fallback', title: 'No sub', caption: 'body', ...approved }]);
    const calls = install();
    await cmdPublishDue({ plan: planPath, only: 'p_fallback' });
    drain();
    const form = new URLSearchParams(submitFor(calls)[0].body);
    ok(form.get('sr') === 'fallbacksub', 'a post with no redditSubreddit falls back to the connection default (unchanged)');
  }

  // ---- 2: presubmit groups by sub - one post_requirements fetch per UNIQUE sub ----
  {
    mkPlan([
      { id: 'a', title: 'A', caption: 'b', redditSubreddit: 'subone', ...approved },
      { id: 'b', title: 'B', caption: 'b', redditSubreddit: 'subtwo', ...approved },
      { id: 'c', title: 'C', caption: 'b', redditSubreddit: 'subone', ...approved },
    ]);
    const calls = install();
    await cmdPresubmit({ plan: planPath });
    drain();
    ok(reqFetches(calls, 'subone') === 1, 'two posts on the SAME sub fetch post_requirements ONCE (grouped)');
    ok(reqFetches(calls, 'subtwo') === 1, 'a second unique sub fetches post_requirements once (one fetch per unique sub)');
  }

  // ---- 3: flair-required with no flair is a BLOCKING problem; a flair clears it ----
  {
    mkPlan([
      { id: 'noflair', title: 'Needs flair', caption: 'b', redditSubreddit: 'flairsub', ...approved },
      { id: 'hasflair', title: 'Has flair', caption: 'b', redditSubreddit: 'flairsub', redditFlairId: 'flair-1', ...approved },
    ]);
    const calls = install({ flairRequiredSubs: ['flairsub'] });
    await cmdPresubmit({ plan: planPath });
    const rows = drain();
    const noflair = presubmitRow(rows, 'noflair');
    ok(hasCode(noflair.problems, 'flairRequired'), 'flair-required + no redditFlairId is a BLOCKING problem (spec 36, not a warning)');
    ok(!hasCode(noflair.warnings, 'flairRequired'), 'flair-required is NOT emitted as a warning any more');
    ok(noflair.ready === false, 'a flair-required-but-flairless post is ready:false');
    const hasflair = presubmitRow(rows, 'hasflair');
    ok(!hasCode(hasflair.problems, 'flairRequired'), 'a post that carries a redditFlairId clears the flair problem');
    ok(hasflair.ready === true, 'the flaired post on the same sub is ready:true');
    ok(reqFetches(calls, 'flairsub') === 1, 'both posts on flairsub share ONE post_requirements fetch');
  }

  // A post that resolves to NO sub degrades per-post (needsScope), never all posts.
  {
    fs.writeFileSync(path.join(WS, '.env'), 'REDDIT_CLIENT_ID=cid\nREDDIT_CLIENT_SECRET=sec\nREDDIT_USERNAME=botuser\nREDDIT_PASSWORD=pw\n'); // no default
    mkPlan([
      { id: 'withsub', title: 'Has sub', caption: 'b', redditSubreddit: 'realsub', ...approved },
      { id: 'nosub', title: 'No sub at all', caption: 'b', ...approved },
    ]);
    install();
    await cmdPresubmit({ plan: planPath });
    const rows = drain();
    ok(hasCode(presubmitRow(rows, 'nosub').warnings, 'needsScope'), 'a post resolving to NO sub degrades to needsScope (per-post)');
    ok(presubmitRow(rows, 'withsub').ok === true && presubmitRow(rows, 'withsub').ready === true, 'the sibling post with a sub is still checked (only the sub-less post degrades)');
  }

  // ---- spec 37: presubmit attaches { warmth, advisories } ADDITIVELY (display-only) ----
  {
    // Warm account + organic + requirements-met -> no advisories.
    mkPlan([{ id: 'warm_org', title: 'Organic', caption: 'b', redditSubreddit: 'okaysub', ...approved }]);
    install({ me: WARM_ME });
    await cmdPresubmit({ plan: planPath });
    const warmRow = presubmitRow(drain(), 'warm_org');
    ok(warmRow.warmth && warmRow.warmth.karma === 5000, 'presubmit attaches the account warmth (karma = link + comment)');
    ok(Array.isArray(warmRow.advisories) && warmRow.advisories.length === 0, 'a warm + organic + requirements-met post carries NO advisories');

    // A COLD account adds a `cold` advisory to the SAME post - display only, `ready` unchanged.
    install({ me: COLD_ME });
    await cmdPresubmit({ plan: planPath });
    const coldRow = presubmitRow(drain(), 'warm_org');
    ok(hasCode(coldRow.advisories, 'cold'), 'a cold account adds a `cold` advisory to the same post');
    ok(coldRow.ready === true, 'the presubmit READY verdict is unchanged (advisories are additive, never a gate on ready)');

    // A PROMOTIONAL post (isPromo unset -> absence = promo) carries a `promo` advisory.
    mkPlan([{ id: 'promo', title: 'Promo', caption: 'b', redditSubreddit: 'okaysub', approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: '2020-01-01T00:00:00Z', platforms: ['reddit'], type: 'text' }]);
    install({ me: WARM_ME });
    await cmdPresubmit({ plan: planPath });
    const promoRow = presubmitRow(drain(), 'promo');
    ok(hasCode(promoRow.advisories, 'promo'), 'a promo post (isPromo absent) carries a `promo` advisory even on a warm account');
  }

  // ---- spec 37 (reversed): publish-due AUTO-PUBLISHES every approved post (no defer) ----
  {
    // A gone-cold account no longer defers: warn-and-allow means it publishes at fire time.
    mkPlan([{ id: 'gonecold', title: 'Was warm', caption: 'b', redditSubreddit: 'okaysub', ...approved }]);
    const coldCalls = install({ me: COLD_ME });
    await cmdPublishDue({ plan: planPath, only: 'gonecold' });
    const coldRows = drain();
    ok(submitFor(coldCalls).length === 1, 'a cold account still PUBLISHES at fire time (warn-and-allow, no defer)');
    ok(!coldRows.some((r) => r.action === 'defer-manual'), 'no defer-manual row is ever emitted (the manual path is retired)');
    ok(diskPost('gonecold').status === 'posted', 'the cold post converges to posted');

    // A warm + organic post submits exactly as spec 16 (unchanged happy path).
    mkPlan([{ id: 'stillwarm', title: 'Warm now', caption: 'b', redditSubreddit: 'okaysub', ...approved }]);
    const warmCalls = install({ me: WARM_ME });
    await cmdPublishDue({ plan: planPath, only: 'stillwarm' });
    drain();
    ok(submitFor(warmCalls).length === 1, 'a warm + organic post submits at fire time (unchanged spec-16 path)');
    ok(diskPost('stillwarm').status === 'posted', 'the warm organic post converges to posted');

    // A PROMO post (isPromo absent) now ALSO publishes (owner: promo auto-publishes too).
    mkPlan([{ id: 'firepromo', title: 'Promo', caption: 'b', redditSubreddit: 'okaysub', approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: '2020-01-01T00:00:00Z', platforms: ['reddit'], type: 'text' }]);
    const promoCalls = install({ me: WARM_ME });
    await cmdPublishDue({ plan: planPath, only: 'firepromo' });
    drain();
    ok(submitFor(promoCalls).length === 1, 'a promo post auto-publishes at fire time (no manual defer)');
    ok(diskPost('firepromo').status === 'posted', 'the promo post converges to posted');
  }

  // ---- spec 37 (reversed): a dry-run never submits and never mutates the plan ----
  {
    mkPlan([{ id: 'drypromo', title: 'Promo', caption: 'b', redditSubreddit: 'okaysub', approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: '2020-01-01T00:00:00Z', platforms: ['reddit'], type: 'text' }]);
    const calls = install({ me: WARM_ME });
    await cmdPublishDue({ plan: planPath, only: 'drypromo', 'dry-run': true });
    drain();
    ok(submitFor(calls).length === 0, 'a dry-run never submits');
    ok(diskPost('drypromo').status !== 'posted', 'a dry-run does NOT mutate the plan (post stays un-posted)');
  }

  // ---- 5: description-contains - the ToS advisories live in the tool DESCRIPTIONS ----
  {
    const create = TOOLS.find((t) => t.name === 'plan_create_post');
    const presub = TOOLS.find((t) => t.name === 'presubmit_check');
    const phrases = ['self-promotion', 'karma', 'account age', 'non-commercial', 'human', 'auto-publishes'];
    for (const p of phrases) {
      ok(create.description.includes(p), `plan_create_post description contains the advisory phrase "${p}"`);
      ok(presub.description.includes(p), `presubmit_check description contains the advisory phrase "${p}"`);
    }
    ok(create.description.includes('redditSubreddit'), 'plan_create_post description documents redditSubreddit (per-post target)');
    ok(create.inputSchema.properties.post.properties.redditSubreddit, 'plan_create_post inputSchema exposes the redditSubreddit property');
  }

  console.log(`\n${pass} checks passed`);
} finally {
  global.fetch = realFetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
