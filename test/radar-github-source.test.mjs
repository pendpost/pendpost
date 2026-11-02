#!/usr/bin/env node
// test/radar-github-source.test.mjs - Radar 2.0 step 3 (spec 54): GitHub issue + discussion search.
//
// Proofs (in-process, stubbed fetch, zero network):
//   (a) the search string: OR-ed quoted terms (at most 6), is:issue is:open, created:>lookback,
//       repo: filters from githubRepos;
//   (b) an issue maps to a Signal: id owner/repo#n, author login, comment count (replyCount), repo
//       as threadTitle and community, bot accounts flagged, PRs skipped;
//   (c) without a token: no Authorization header and no discussion (GraphQL) call; with a token:
//       Bearer auth and the discussion half, closed discussions skipped;
//   (d) refusals: a spent rate limit -> rate_limited with retryAfter from x-ratelimit-reset, 401 ->
//       needs_scope (GITHUB_TOKEN), 422 -> engine_failure with GitHub's message, a failed discussion
//       half degrades the ok row;
//   (e) the lane is opt-in (sources.github.scan) and the source id is exactly 'github'.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-github-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;

const resp = (body, status = 200, headers = {}) => Promise.resolve({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: () => Promise.resolve(JSON.stringify(body)) });
const issue = (n, extra = {}) => ({ id: 9000 + n, number: n, title: `Is there a way to post to Mastodon? #${n}`, body: 'We moved off Buffer.<!-- template -->', html_url: `https://github.com/gitroomhq/postiz-app/issues/${n}`, repository_url: 'https://api.github.com/repos/gitroomhq/postiz-app', user: { login: `dev${n}`, type: 'User' }, comments: n, created_at: '2026-10-28T08:00:00Z', ...extra });

try {
  const G = await import('../scripts/github-radar.mjs');
  const R = await import('../lib/radar.mjs');
  const now = Date.parse('2026-10-29T12:00:00Z');

  // ---- (a) the search string ----------------------------------------------------------------------
  const q = G.githubSearchQ({ keywords: ['alternative to postiz', 'is there a way'], githubRepos: ['gitroomhq/postiz-app', 'mixpost/mixpost', 'bad repo'], lookbackDays: 3 }, { now });
  ok(q === '"alternative to postiz" OR "is there a way" is:issue is:open created:>2026-10-26 repo:gitroomhq/postiz-app repo:mixpost/mixpost', `issue search string (${q})`);
  ok(G.githubTerms({ keywords: Array.from({ length: 9 }, (_, i) => `k${i}`) }).length === 6, 'at most 6 OR-ed terms (GitHub allows 5 operators)');
  ok(G.githubSearchQ({ label: 'beancount importer' }, { now }).startsWith('"beancount importer" is:issue is:open created:>2026-10-22'), 'no keywords: the label, default 7-day lookback');
  ok(G.githubIssuesUrl({}, { now }) === null, 'nothing to search: no url');
  ok(!/is:issue/.test(G.githubSearchQ({ keywords: ['x'] }, { now, kind: 'discussion' })), 'the discussion search has no is:issue qualifier');

  // ---- (b) mapping ------------------------------------------------------------------------------------
  const s = G.githubIssueToSignal(issue(7));
  ok(s.source === 'github' && s.externalId === 'gitroomhq/postiz-app#7' && s.url === 'https://github.com/gitroomhq/postiz-app/issues/7', `id + url (${s.externalId})`);
  ok(s.author === 'dev7' && s.replyCount === 7 && s.threadTitle === 'gitroomhq/postiz-app' && s.community === 'gitroomhq/postiz-app', 'author login, comment count, repo as threadTitle and community');
  ok(s.text === 'Is there a way to post to Mastodon? #7\n\nWe moved off Buffer.' && s.ts === '2026-10-28T08:00:00Z', 'title + body (template comments removed), created_at');
  ok(G.githubIssueToSignal(issue(1, { user: { login: 'renovate[bot]', type: 'Bot' } })).bot === true, 'a Bot account is flagged (the pre-filter drops bots)');

  // ---- (c) token / no token ---------------------------------------------------------------------------
  let calls = [];
  let answers = [];
  const fetchStub = (url, init = {}) => { calls.push({ url: String(url), init }); const a = answers.shift() || { body: {} }; return resp(a.body, a.status, a.headers); };
  answers = [{ body: { items: [issue(1), issue(2), { ...issue(3), pull_request: {} }] } }];
  let row = await G.githubRadar({ keywords: ['is there a way'] }, { fetch: fetchStub, token: null, now });
  ok(calls.length === 1 && !calls[0].init.headers.Authorization && new URL(calls[0].url).pathname === '/search/issues', 'no token: one REST call, no Authorization, no GraphQL');
  ok(new URL(calls[0].url).searchParams.get('sort') === 'created' && new URL(calls[0].url).searchParams.get('per_page') === '30', 'newest first, 30 per page');
  ok(row.ok === true && row.items.length === 2 && !row.degrade, `PRs skipped, two issues (${row.items.length})`);
  calls = [];
  answers = [{ body: { items: [issue(4)] } }, { body: { data: { search: { nodes: [
    { id: 'D1', number: 12, title: 'Best tool to schedule to Bluesky?', url: 'https://github.com/o/r/discussions/12', bodyText: 'asking', createdAt: '2026-10-28T07:00:00Z', closed: false, author: { login: 'eve' }, repository: { nameWithOwner: 'o/r' }, comments: { totalCount: 0 } },
    { id: 'D2', number: 13, title: 'closed one', url: 'https://github.com/o/r/discussions/13', bodyText: '', createdAt: '2026-10-28T07:00:00Z', closed: true, author: { login: 'zed' }, repository: { nameWithOwner: 'o/r' }, comments: { totalCount: 2 } },
  ] } } } }];
  row = await G.githubRadar({ keywords: ['schedule'] }, { fetch: fetchStub, token: 'ghp_test', now });
  ok(calls.length === 2 && calls[0].init.headers.Authorization === 'Bearer ghp_test' && calls[1].url.endsWith('/graphql') && calls[1].init.method === 'POST', 'with a token: Bearer auth and the GraphQL discussion search');
  const d = row.items.find((x) => x.externalId === 'o/r/discussions/12');
  ok(row.items.length === 2 && d && d.author === 'eve' && d.replyCount === 0 && d.threadTitle === 'o/r', 'an open discussion maps like an issue; a closed one is skipped');

  // ---- (d) refusals ---------------------------------------------------------------------------------------
  answers = [{ status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(now / 1000) + 45) } }];
  row = await G.githubRadar({ keywords: ['x'] }, { fetch: fetchStub, token: null, now });
  ok(row.ok === false && row.error === 'rate_limited' && row.retryAfter === 45, `a spent rate limit -> rate_limited, retryAfter from x-ratelimit-reset (${row.retryAfter})`);
  answers = [{ status: 401, body: { message: 'Bad credentials' } }];
  row = await G.githubRadar({ keywords: ['x'] }, { fetch: fetchStub, token: 'bad', now });
  ok(row.ok === false && row.error === 'needs_scope' && row.scope === 'GITHUB_TOKEN', 'a refused token -> needs_scope naming GITHUB_TOKEN');
  answers = [{ status: 422, body: { message: 'Validation Failed' } }];
  row = await G.githubRadar({ keywords: ['x'] }, { fetch: fetchStub, token: null, now });
  ok(row.ok === false && row.error === 'engine_failure' && /422: Validation Failed/.test(row.detail), `422 -> engine_failure with GitHub's message (${row.detail})`);
  answers = [{ body: { items: [issue(5)] } }, { status: 502, body: { message: 'Bad gateway' } }];
  row = await G.githubRadar({ keywords: ['x'] }, { fetch: fetchStub, token: 't', now });
  ok(row.ok === true && row.items.length === 1 && row.degrade && row.degrade.error === 'engine_failure', 'a failed discussion half keeps the issues and degrades the row');
  row = await G.githubRadar({ keywords: ['x'] }, { fetch: () => Promise.reject(new Error('fetch failed')), token: null, now });
  ok(row.ok === false && row.error === 'engine_failure', 'a network failure never throws');

  // ---- (e) gating + id ---------------------------------------------------------------------------------
  ok(R.RADAR_CAPABILITIES.github && R.RADAR_CAPABILITIES.github.optIn === true && R.RADAR_CAPABILITIES.github.reply === false && R.RADAR_CAPABILITIES.github.copyDraft === true, 'github: opt-in, no reply API, copy-paste answers');
  ok(R.radarOptionalLanes({ keywords: ['x'] }, {}).length === 0 && R.radarOptionalLanes({ keywords: ['x'] }, { sources: { github: { scan: true } } }).join() === 'github', 'the github lane runs only by its switch');
  ok(R.SOURCE_SCRIPT.github === 'scripts/github-radar.mjs' && R.RADAR_CAPABILITIES.github.costNote === 'free_rate_limited' && R.RADAR_CAPABILITIES.github.needs === 'none', 'engine script, cost note, needs none (the token is optional)');
  const bare = await R.runLaneRadar('github', { id: 'q' });
  ok(bare.ok === false && bare.error === 'invalid_input', 'a bare runLaneRadar("github") refuses (only the scan, opting in, spawns it)');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-github-source] OK - ${pass} assertions`);
} catch (err) {
  console.error(`[radar-github-source] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
