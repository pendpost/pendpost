#!/usr/bin/env node
// github-radar.mjs - the GitHub issue + discussion Radar SEARCH engine (Radar 2.0 step 3, spec 54).
//
// For developer audiences: "alternative to", "is there a way" questions in the issues (and, with a
// token, the discussions) of competitor and neighbour repos (Postiz, Mixpost, beancount...). One verb,
// `radar`, emits unscored Signals (source `github`); the seam pre-filters and judges them like every
// engine lane. Search-only, no reply API we hold: answers go the copy-paste path.
//
//   issues       GET https://api.github.com/search/issues?q=<terms> is:issue is:open created:>DATE [repo:o/r ...]
//                Works without a token (10 searches a minute); GITHUB_TOKEN raises that to 30.
//   discussions  GraphQL search(type: DISCUSSION) - GitHub answers GraphQL only with a token, so this
//                half runs only when GITHUB_TOKEN is set.
//
// Each hit carries the author login, the comment count (replyCount) and the repo name (threadTitle
// and community), the context the judge reads. Zero deps: fetch + node builtins. Never throws.
//
// Usage:
//   radar --query <json>   { keywords?:[], label?, githubRepos?:['owner/repo'], lookbackDays? }
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand } from '../lib/mode.mjs';
import { enforceCeremonyClient } from '../lib/cli-client.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
import { readEnv } from '../lib/util.mjs';

export const RUN = { results: [] };
let JSON_MODE = false;

export const GITHUB_API = 'https://api.github.com';
// GitHub search allows at most five AND/OR/NOT operators, so six OR-ed terms is the ceiling.
export const GITHUB_MAX_TERMS = 6;
export const GITHUB_PER_PAGE = 30;
const GITHUB_TIMEOUT_MS = 15_000;
const BODY_MAX = 2500;

const quote = (t) => `"${String(t || '').replace(/"/g, ' ').replace(/\s+/g, ' ').trim()}"`;

// The search terms: the query's keywords (else its label), at most GITHUB_MAX_TERMS.
export function githubTerms(query = {}) {
  const kws = Array.isArray(query.keywords) ? query.keywords.filter((k) => typeof k === 'string' && k.trim()) : [];
  const label = typeof query.label === 'string' ? query.label.trim() : '';
  return (kws.length ? kws : [label]).map((t) => t.trim()).filter(Boolean).slice(0, GITHUB_MAX_TERMS);
}

// YYYY-MM-DD of the lookback floor (default 7 days), for `created:>`.
export function githubSince(lookbackDays, now = Date.now()) {
  const n = Number(lookbackDays);
  const days = Number.isFinite(n) && n > 0 ? n : 7;
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

/** The search string (shared by the issue and discussion halves). */
export function githubSearchQ(query = {}, { now = Date.now(), kind = 'issue' } = {}) {
  const terms = githubTerms(query);
  if (!terms.length) return null;
  const repos = (Array.isArray(query.githubRepos) ? query.githubRepos : []).map((r) => String(r || '').trim()).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)).slice(0, 20);
  const parts = [terms.map(quote).join(' OR ')];
  if (kind === 'issue') parts.push('is:issue', 'is:open');
  parts.push(`created:>${githubSince(query.lookbackDays, now)}`);
  for (const r of repos) parts.push(`repo:${r}`);
  return parts.join(' ');
}

export function githubIssuesUrl(query = {}, opts = {}) {
  const q = githubSearchQ(query, { ...opts, kind: 'issue' });
  if (!q) return null;
  return `${GITHUB_API}/search/issues?${new URLSearchParams({ q, sort: 'created', order: 'desc', per_page: String(GITHUB_PER_PAGE) }).toString()}`;
}

const repoOf = (repositoryUrl) => {
  const m = String(repositoryUrl || '').match(/\/repos\/([^/]+\/[^/]+)$/);
  return m ? m[1] : null;
};

/** One REST search/issues item -> an unscored Signal. */
export function githubIssueToSignal(it) {
  const item = it && typeof it === 'object' ? it : {};
  const repo = repoOf(item.repository_url) || null;
  const title = String(item.title || '').trim();
  const body = String(item.body || '').replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '').trim().slice(0, BODY_MAX);
  return {
    source: 'github',
    externalId: repo && item.number != null ? `${repo}#${item.number}` : String(item.id || ''),
    url: item.html_url || null,
    author: (item.user && item.user.login) || null,
    ...(item.user && item.user.type === 'Bot' ? { bot: true } : {}),
    community: repo,
    ...(repo ? { threadTitle: repo } : {}),
    text: [title, body].filter(Boolean).join('\n\n'),
    ...(Number.isFinite(item.comments) ? { replyCount: item.comments } : {}),
    ts: item.created_at || null,
  };
}

/** One GraphQL Discussion node -> an unscored Signal. */
export function githubDiscussionToSignal(n) {
  const node = n && typeof n === 'object' ? n : {};
  const repo = node.repository && node.repository.nameWithOwner ? node.repository.nameWithOwner : null;
  const title = String(node.title || '').trim();
  const body = String(node.bodyText || '').trim().slice(0, BODY_MAX);
  return {
    source: 'github',
    externalId: repo && node.number != null ? `${repo}/discussions/${node.number}` : String(node.id || ''),
    url: node.url || null,
    author: (node.author && node.author.login) || null,
    community: repo,
    ...(repo ? { threadTitle: repo } : {}),
    text: [title, body].filter(Boolean).join('\n\n'),
    ...(node.comments && Number.isFinite(node.comments.totalCount) ? { replyCount: node.comments.totalCount } : {}),
    ts: node.createdAt || null,
  };
}

const DISCUSSION_GQL = `query($q: String!) { search(query: $q, type: DISCUSSION, first: 20) { nodes { ... on Discussion {
  id number title url bodyText createdAt closed author { login } repository { nameWithOwner } comments { totalCount } } } } }`;

async function ghFetch(fetchImpl, url, init) {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch { json = null; }
    const h = (k) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(k) : null);
    return { ok: res.ok, status: res.status, json, remaining: h('x-ratelimit-remaining'), reset: h('x-ratelimit-reset'), retryAfter: h('retry-after') };
  } catch (err) {
    return { ok: false, status: 0, json: null, error: String((err && err.message) || err).slice(0, 200) };
  }
}

// A refused search: rate limited (403/429 with the limit spent), a token GitHub rejects, or other.
function classify(r, now = Date.now()) {
  if (r.status === 429 || (r.status === 403 && (r.remaining === '0' || r.retryAfter != null))) {
    const reset = Number(r.reset);
    const ra = r.retryAfter != null && Number.isFinite(Number(r.retryAfter)) ? Number(r.retryAfter)
      : (Number.isFinite(reset) ? Math.max(1, Math.round(reset - now / 1000)) : null);
    return { kind: 'rate_limited', retryAfter: ra };
  }
  if (r.status === 401) return { kind: 'needs_scope', detail: 'GitHub refused GITHUB_TOKEN (HTTP 401)' };
  const msg = r.json && typeof r.json.message === 'string' ? r.json.message : (r.error || '');
  return { kind: 'error', detail: `GitHub search HTTP ${r.status}${msg ? `: ${msg}` : ''}`.slice(0, 200) };
}

/**
 * Run the search for one query. Returns the RUN row. `opts`: { fetch, token, now } test seams.
 */
export async function githubRadar(query = {}, { fetch: fetchImpl = globalThis.fetch, token = readEnv('GITHUB_TOKEN'), now = Date.now() } = {}) {
  const { radarOkRow, radarRateLimitedRow, radarErrorRow, radarNeedsScopeRow } = await import('../lib/radar.mjs');
  const url = githubIssuesUrl(query, { now });
  if (!url) return radarOkRow('github', []);
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'pendpost-radar' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const items = [];
  const seen = new Set();
  const push = (s) => { if (s.externalId && !seen.has(s.externalId)) { seen.add(s.externalId); items.push(s); } };
  const r = await ghFetch(fetchImpl, url, { headers });
  if (!r.ok) {
    const c = classify(r, now);
    if (c.kind === 'rate_limited') return radarRateLimitedRow('github', c.retryAfter);
    if (c.kind === 'needs_scope') return radarNeedsScopeRow('github', 'GITHUB_TOKEN', c.detail);
    return { ...radarErrorRow('github', c.detail), detail: c.detail };
  }
  for (const it of (r.json && Array.isArray(r.json.items) ? r.json.items : [])) {
    if (it && it.pull_request) continue; // is:issue already excludes PRs; belt and braces
    push(githubIssueToSignal(it));
  }
  // Discussions need GraphQL, and GraphQL needs a token: without one this half is skipped quietly.
  let degrade = null;
  if (token) {
    const q = githubSearchQ(query, { now, kind: 'discussion' });
    const d = await ghFetch(fetchImpl, `${GITHUB_API}/graphql`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: DISCUSSION_GQL, variables: { q } }) });
    if (d.ok && d.json && d.json.data && d.json.data.search) {
      for (const n of d.json.data.search.nodes || []) if (n && n.closed !== true) push(githubDiscussionToSignal(n));
    } else {
      const c = d.ok ? { kind: 'error', detail: 'GitHub discussion search returned no data' } : classify(d, now);
      degrade = { error: c.kind === 'rate_limited' ? 'rate_limited' : c.kind === 'needs_scope' ? 'needs_scope' : 'engine_failure', ...(c.retryAfter != null ? { retryAfter: c.retryAfter } : {}), ...(c.detail ? { detail: c.detail } : {}) };
    }
  }
  const row = radarOkRow('github', items);
  if (degrade) row.degrade = degrade;
  return row;
}

export async function cmdRadar(args) {
  let query = {};
  try { query = args.query ? JSON.parse(String(args.query)) : {}; } catch { query = {}; }
  RUN.results.push(await githubRadar(query));
}

const COMMANDS = { radar: cmdRadar };

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else args[key] = argv[++i];
    } else args._.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  await enforceCeremonyClient({ argv: args, command: args._[0], lane: 'github', scriptUrl: import.meta.url });
  JSON_MODE = Boolean(args.json);
  if (JSON_MODE) console.log = (...a) => console.error(...a);
  const commandName = args._[0];
  if (resolveMode('github') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({ platform: 'github', command: commandName, query: typeof args.query === 'string' ? args.query : null });
    if (JSON_MODE) process.stdout.write(`${JSON.stringify(envelope)}\n`);
    else console.error(`[mock] github ${commandName}: ${(envelope.results || []).length} result(s)`);
    return;
  }
  const cmd = COMMANDS[commandName];
  if (!cmd) {
    console.error(`Usage: node scripts/github-radar.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
    process.exit(2);
  }
  await cmd(args);
  if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: true, ...RUN })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[err]', err.message || err);
    if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: false, error: String(err.message || err).slice(0, 300), ...RUN })}\n`);
    process.exit(1);
  });
}
