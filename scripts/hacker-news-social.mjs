#!/usr/bin/env node
// hacker-news-social.mjs - the Hacker News Radar (beta) SEARCH engine (spec 33).
//
// HN is a SEARCH-ONLY Radar source: the public Algolia index (no auth, no write API),
// so this engine ships exactly ONE verb - `radar` - and NOTHING else (no publish /
// schedule / insights / reply). It is registered as a search-only lane in
// lib/drivers/interface.mjs#SEARCH_ONLY_LANES and is DELIBERATELY absent from
// BUILTIN_LANES / BUILTIN_PLATFORMS / CLOUD_LANES, so it can never become a publish
// target (the Composer picker, Setup connect cards and post-platform validation never
// see it). RADAR_CAPABILITIES.hackernews.reply is false, so the seam marks HN signals
// copy-paste-only (no queue-reply). Zero-dep: fetch + node builtins only.
//
// Usage:
//   radar --query <json>   run a RadarQuery against HN Algolia; emits { action:'radar',
//                          ok:true, items:[Signal(unscored)] } on RUN.results.
//
// Mock: `radar` is in MOCKABLE_COMMANDS, so `main()` routes it to the mock driver's
// handleRadar (credential-free) exactly like every other mockable verb - the seam's
// mock scan spawns this engine and gets the canned Signal fixture.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand } from '../lib/mode.mjs';
import { enforceCeremonyClient } from '../lib/cli-client.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';

export const RUN = { results: [] };
let JSON_MODE = false;

// The Algolia request for ONE keyword (2026-09-30). Unquoted, Algolia fuzzes a term with typo
// tolerance and prefix matching: "bexio" returned 1196 hits (Benioff, Texio), "accounting" matched
// "counting", a product name matched "bookshops". So each keyword goes out as ONE quoted phrase with
// advancedSyntax on (the quotes mean "this exact phrase") and typoTolerance off. Exported so a
// test can assert the request without a network.
// `sinceSec` (Radar 2.0 step 1): the lookback as a unix-seconds floor, sent as Algolia's
// numericFilters=created_at_i>N, so the 25 hits per term are spent on posts inside the window
// instead of years-old threads the seam would drop as stale anyway. Absent = no time filter.
export function hnSearchUrl(term, { sinceSec = null } = {}) {
  const phrase = String(term || '').replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
  const params = { query: `"${phrase}"`, tags: '(story,comment)', hitsPerPage: '25', advancedSyntax: 'true', typoTolerance: 'false' };
  if (Number.isFinite(sinceSec) && sinceSec > 0) params.numericFilters = `created_at_i>${Math.floor(sinceSec)}`;
  return `https://hn.algolia.com/api/v1/search_by_date?${new URLSearchParams(params).toString()}`;
}

// The unix-seconds floor for a lookback in days, or null when none is set.
export function hnSinceSec(lookbackDays, now = Date.now()) {
  const n = Number(lookbackDays);
  return Number.isFinite(n) && n > 0 ? Math.floor(now / 1000 - n * 86_400) : null;
}

// Algolia returns story_text / comment_text as HN's HTML (<p>, <a>, <i>, entities). The feed and
// the scorer want the words: paragraphs become blank lines, tags go, the common entities decode.
const HN_NAMED_ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' });
export function hnPlainText(html) {
  return String(html || '')
    .replace(/<\s*(?:p|br)\s*\/?>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => HN_NAMED_ENTITIES[n.toLowerCase()] ?? m)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// One Algolia hit -> an unscored Signal. A STORY keeps its title AND its body (story_text: the
// question of an Ask HN, the pitch of a Show HN), title first because the scorer reads the opening.
// A COMMENT keeps its own words as text and carries the title of the story it sits under as
// `threadTitle` (Algolia's story_title), so the pre-filter can tell a comment under someone else's
// Show HN from one in an Ask HN thread, and a reader sees what the comment answers.
export function hnHitToSignal(h) {
  const hit = h && typeof h === 'object' ? h : {};
  const tags = Array.isArray(hit._tags) ? hit._tags : [];
  const isComment = tags.includes('comment') || (!hit.title && Boolean(hit.comment_text));
  const body = hnPlainText(isComment ? hit.comment_text : hit.story_text);
  const title = String(hit.title || '').trim();
  const text = isComment ? body : [title, body].filter(Boolean).join('\n\n');
  const threadTitle = isComment && typeof hit.story_title === 'string' && hit.story_title.trim() ? hit.story_title.trim() : null;
  return {
    source: 'hackernews',
    externalId: String(hit.objectID || ''),
    url: hit.objectID ? `https://news.ycombinator.com/item?id=${hit.objectID}` : null,
    author: hit.author || null,
    community: 'news.ycombinator.com',
    text: text || String(hit.story_title || ''),
    ...(threadTitle ? { threadTitle } : {}),
    // Radar 2.0 step 2: a story's comment count rides the same Algolia hit (no extra call), so the
    // judge and the inbox rank know how crowded the thread already is. Comments carry none.
    ...(!isComment && Number.isFinite(hit.num_comments) ? { replyCount: hit.num_comments } : {}),
    ts: Number.isFinite(hit.created_at_i) ? new Date(hit.created_at_i * 1000).toISOString() : (hit.created_at || null),
  };
}

// The Radar (beta) SEARCH verb (spec 33, Pattern P3 read). Algolia search_by_date over
// stories + comments (newest-first). No auth (public index) - so no needs_scope on creds;
// only a 429 degrades to rate_limited, any other transport error to engine_failure. Never
// throws (P9). Mock mode NEVER reaches here (main() routes `radar` to the mock driver).
export async function cmdRadar(args) {
  const { radarOkRow, radarRateLimitedRow, radarErrorRow, radarHttp } = await import('../lib/radar.mjs');
  let query = {};
  try { query = args.query ? JSON.parse(String(args.query)) : {}; } catch { query = {}; }
  const keywords = Array.isArray(query.keywords) ? query.keywords.filter((k) => typeof k === 'string' && k.trim()) : [];
  const label = typeof query.label === 'string' ? query.label.trim() : '';
  const terms = (keywords.length ? keywords : [label]).map((t) => t.trim()).filter(Boolean).slice(0, 10);
  if (!terms.length) { RUN.results.push(radarOkRow('hackernews', [])); return; }
  const mapHit = hnHitToSignal;
  const sinceSec = hnSinceSec(query.lookbackDays);
  // ONE Algolia query per keyword. Algolia treats a space-joined `query` as AND, so the old
  // `keywords.join(' ')` returned ~nothing for any multi-keyword query. One search per term
  // gives OR semantics (what reddit-social.mjs gets from its ` OR `-join); a local Set dedupes
  // a hit two terms both matched. Capped at 10 terms so a wide query stays bounded.
  const items = [];
  const seenIds = new Set();
  let lastError = null; // transient/other search failure (5xx etc.)
  let anySearchOk = false;
  for (const q of terms) {
    const url = hnSearchUrl(q, { sinceSec });
    const { ok, status, json, retryAfter, error } = await radarHttp(url);
    if (!ok) {
      // A rate-limit only aborts if we have nothing yet; otherwise keep the collected items.
      if (status === 429) { if (!items.length) { RUN.results.push(radarRateLimitedRow('hackernews', retryAfter)); return; } break; }
      lastError = error || `HTTP ${status}`;
      continue;
    }
    anySearchOk = true;
    for (const h of (json?.hits || [])) {
      const row = mapHit(h);
      if (seenIds.has(row.externalId)) continue;
      seenIds.add(row.externalId);
      items.push(row);
    }
  }
  if (items.length) { RUN.results.push(radarOkRow('hackernews', items)); return; }
  if (lastError && !anySearchOk) { RUN.results.push(radarErrorRow('hackernews', lastError)); return; } // every term errored
  RUN.results.push(radarOkRow('hackernews', [])); // a genuine empty result (search worked, no hits)
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
  await enforceCeremonyClient({ argv: args, command: args._[0], lane: 'hacker-news', scriptUrl: import.meta.url });
  JSON_MODE = Boolean(args.json);
  if (JSON_MODE) console.log = (...a) => console.error(...a);
  const commandName = args._[0];
  if (resolveMode('hackernews') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'hackernews', command: commandName,
      query: typeof args.query === 'string' ? args.query : null,
    });
    if (JSON_MODE) process.stdout.write(`${JSON.stringify(envelope)}\n`);
    else console.error(`[mock] hackernews ${commandName}: ${(envelope.results || []).length} result(s)`);
    return;
  }
  const cmd = COMMANDS[commandName];
  if (!cmd) {
    console.error(`Usage: node scripts/hacker-news-social.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
    process.exit(2);
  }
  await cmd(args);
  if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: true, ...RUN })}\n`);
}

// Guard main() so the pure helpers are importable by tests without running the CLI
// (mirrors reddit-social.mjs / mastodon-social.mjs).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[err]', err.message || err);
    if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: false, error: String(err.message || err).slice(0, 300), ...RUN })}\n`);
    process.exit(1);
  });
}
