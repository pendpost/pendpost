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
  const mapHit = (h) => ({
    source: 'hackernews',
    externalId: String(h.objectID || ''),
    url: h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : null,
    author: h.author || null,
    community: 'news.ycombinator.com',
    text: h.title || h.comment_text || h.story_title || '',
    ts: Number.isFinite(h.created_at_i) ? new Date(h.created_at_i * 1000).toISOString() : (h.created_at || null),
  });
  // ONE Algolia query per keyword. Algolia treats a space-joined `query` as AND, so the old
  // `keywords.join(' ')` returned ~nothing for any multi-keyword query. One search per term
  // gives OR semantics (what reddit-social.mjs gets from its ` OR `-join); a local Set dedupes
  // a hit two terms both matched. Capped at 10 terms so a wide query stays bounded.
  const items = [];
  const seenIds = new Set();
  let lastError = null; // transient/other search failure (5xx etc.)
  let anySearchOk = false;
  for (const q of terms) {
    const url = `https://hn.algolia.com/api/v1/search_by_date?${new URLSearchParams({ query: q, tags: '(story,comment)', hitsPerPage: '25' }).toString()}`;
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
