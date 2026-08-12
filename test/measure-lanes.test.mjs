#!/usr/bin/env node
// test/measure-lanes.test.mjs - ux-audit 2026-08-04 R3 ("every lane that
// measures, measures"). X, Reddit and Mastodon shipped complete,
// envelope-conformant `insights` verbs (x-social.mjs cmdInsights,
// reddit-social.mjs cmdInsights, mastodon-social.mjs cmdInsights) that the
// daily sweep never spawned - the busiest lanes were the only ones that could
// not be measured, and digest.metrics.none read identically to "the platform
// has no metrics API".
//
// Proves, end-to-end, credential-free through the REAL engine entrypoints +
// the REAL sweep:
//   1. x/reddit/mastodon `insights` in mock mode emit plausible per-post rows
//      whose metric shapes MATCH the live verbs (x: impressions/likes/comments/
//      shares/bookmarks; reddit: score/num_comments/upvote_ratio; mastodon:
//      favourites/reblogs/replies) - mock and live never disagree on shape.
//   2. the sweep (ENGINES/LANES/PLATFORM_LANE/lanesWithEvidence) now spawns all
//      three lanes and stores their per-post rows keyed on the lanes' own
//      minted ids (xPostId / redditPostId / mastodonStatusId).
//   3. getInsights() items carry the resolved mock|live mode for the new lanes
//      (mock rows stay markable) and the METRIC_LABELS envelope registers the
//      new keys (no raw-key leak to REST/MCP consumers).
//   4. every new metric key + the three platform/lane names resolve to
//      localized labels in BOTH locales (en + de-CH, Swiss orthography, no
//      eszett) - no raw-key fallback in the digest.
//   5. the digest renders the three lanes' metrics with localized labels.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-measure-lanes-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'local', path: 'data/plans/local.json', active: true }],
}, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'plans', 'local.json'), JSON.stringify({
  campaign: 'local',
  posts: [
    { id: 'x1', platforms: ['x'], status: 'posted', postedAt: '2026-08-01T00:00:00Z', xPostId: '1811111111111111111', scheduledAt: '2026-08-01T00:00:00Z', caption: 'X post' },
    { id: 'r1', platforms: ['reddit'], status: 'posted', postedAt: '2026-08-01T00:00:00Z', redditPostId: 't3_mockaaa', scheduledAt: '2026-08-01T00:00:00Z', caption: 'Reddit post', title: 'Reddit post' },
    { id: 'm1', platforms: ['mastodon'], status: 'posted', postedAt: '2026-08-01T00:00:00Z', mastodonStatusId: '111222333444555666', scheduledAt: '2026-08-01T00:00:00Z', caption: 'Mastodon post' },
  ],
}, null, 2));

function runEngine(script, args) {
  const out = execFileSync(process.execPath, [path.join(REPO, 'scripts', script), ...args], {
    cwd: REPO,
    env: { ...process.env, PENDPOST_ROOT: WS },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const { fetchInsights, getInsights, generateDigest } = await import('../lib/insights.mjs');
const { loadState } = await import('../lib/state.mjs');
const { makeT } = await import('../lib/i18n.mjs');

try {
  const planArg = ['--plan', path.join(WS, 'data', 'plans', 'local.json'), '--json', '--actor', 'pendpost'];

  // ---- 1. the three engines emit plausible mock rows in the LIVE shape --------
  const x = runEngine('x-social.mjs', ['insights', ...planArg]);
  ok(x.ok === true && x.results.length === 1, 'x insights (mock) emits one row');
  const xm = x.results[0].metrics || {};
  for (const k of ['impressions', 'likes', 'comments', 'shares', 'bookmarks']) {
    ok(typeof xm[k] === 'number', `x mock metrics carries a numeric ${k} (live cmdInsights shape)`);
  }

  const rd = runEngine('reddit-social.mjs', ['insights', ...planArg]);
  ok(rd.ok === true && rd.results.length === 1, 'reddit insights (mock) emits one row');
  const rdm = rd.results[0].metrics || {};
  ok(typeof rdm.score === 'number', 'reddit mock metrics carries a numeric score');
  ok(typeof rdm.num_comments === 'number', 'reddit mock metrics carries a numeric num_comments (live cmdInsights shape)');
  ok(typeof rdm.upvote_ratio === 'number' && rdm.upvote_ratio >= 0 && rdm.upvote_ratio <= 1, 'reddit mock metrics carries an upvote_ratio rate in [0,1] (live cmdInsights shape)');

  const ma = runEngine('mastodon-social.mjs', ['insights', ...planArg]);
  ok(ma.ok === true && ma.results.length === 1, 'mastodon insights (mock) emits one row');
  const mam = ma.results[0].metrics || {};
  for (const k of ['favourites', 'reblogs', 'replies']) {
    ok(typeof mam[k] === 'number', `mastodon mock metrics carries a numeric ${k} (live cmdInsights shape)`);
  }

  // ---- 2. the REAL sweep spawns + stores all three lanes ----------------------
  const sw = await fetchInsights();
  ok(sw.ok, 'sweep returns ok');
  const state = loadState();
  ok(Boolean(state.insights?.data?.['local/x1/x']), 'sweep stores the x per-post row (newly swept lane)');
  ok(Boolean(state.insights?.data?.['local/r1/reddit']), 'sweep stores the reddit per-post row (newly swept lane)');
  ok(Boolean(state.insights?.data?.['local/m1/mastodon']), 'sweep stores the mastodon per-post row (newly swept lane)');
  ok(typeof state.insights.data['local/x1/x'].metrics.bookmarks === 'number', 'the stored x row keeps the bookmarks field');
  ok(typeof state.insights.data['local/r1/reddit'].metrics.upvote_ratio === 'number', 'the stored reddit row keeps the upvote_ratio field');

  // ---- 3. getInsights(): mode markable + METRIC_LABELS registered -------------
  const env = getInsights();
  for (const [pid, platform] of [['x1', 'x'], ['r1', 'reddit'], ['m1', 'mastodon']]) {
    const item = env.items.find((i) => i.postId === pid);
    ok(item && item.platform === platform && item.mode === 'mock', `getInsights() item ${pid} (${platform}) carries mode:mock (mock rows stay markable)`);
  }
  for (const k of ['bookmarks', 'score', 'num_comments', 'upvote_ratio', 'favourites', 'reblogs', 'replies']) {
    ok(typeof env.metricLabels[k] === 'string' && env.metricLabels[k] !== k, `METRIC_LABELS registers ${k} (stable English reference, no raw-key leak)`);
  }

  // ---- 4. locale coverage: metric keys + platform/lane names, both locales ----
  const tEn = makeT('en');
  const tDe = makeT('de-CH');
  for (const k of ['bookmarks', 'score', 'num_comments', 'upvote_ratio', 'favourites', 'reblogs', 'replies']) {
    ok(tEn(`metric.${k}`) !== `metric.${k}`, `en: metric.${k} resolves to a localized label`);
    ok(tDe(`metric.${k}`) !== `metric.${k}`, `de-CH: metric.${k} resolves to a localized label`);
    ok(!/ß/.test(tDe(`metric.${k}`)), `de-CH: metric.${k} label stays eszett-free`);
  }
  for (const name of ['x', 'reddit', 'mastodon']) {
    ok(tEn(`platform.${name}`) !== `platform.${name}` && tDe(`platform.${name}`) !== `platform.${name}`, `platform.${name} resolves in both locales`);
    ok(tEn(`lane.${name}`) !== `lane.${name}` && tDe(`lane.${name}`) !== `lane.${name}`, `lane.${name} resolves in both locales`);
  }

  // ---- 5. the digest renders the three lanes with localized labels ------------
  const dEn = generateDigest({ locale: 'en' });
  ok(dEn.ok, 'generateDigest() succeeds with the three new lanes in play');
  ok(!dEn.digest.includes('no metrics fetched yet'), 'no lane in this plan is left unmeasured (the "never asked" dead row is retired)');
  ok(/Bookmarks \d+/.test(dEn.digest), 'EN digest renders the x bookmarks metric with its label');
  ok(/Upvote ratio/.test(dEn.digest), 'EN digest renders the reddit upvote_ratio metric with its label');
  ok(dEn.mode && dEn.mode.x === 'mock' && dEn.mode.reddit === 'mock' && dEn.mode.mastodon === 'mock', 'the digest mode map covers the three new lanes');
  const dDe = generateDigest({ locale: 'de-CH' });
  ok(!/ß/.test(dDe.digest), 'de-CH digest stays eszett-free with the new lanes rendered');
  ok(!/metric\./.test(dEn.digest) && !/metric\./.test(dDe.digest), 'no raw metric.* key leaks into either digest');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[measure-lanes] OK - x/reddit/mastodon mock rows in live shape, sweep wiring, mode marking, METRIC_LABELS + locale coverage, digest rendering (${pass} assertions).`);
} catch (err) {
  console.error(`[measure-lanes] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
