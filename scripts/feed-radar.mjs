#!/usr/bin/env node
// feed-radar.mjs - the generic feed Radar SEARCH engine (Radar 2.0 step 3, spec 54).
//
// One verb, `radar`: read every RSS 2.0 / Atom / JSON Feed URL the query lists in `feeds` and emit
// the items as unscored Signals (source `feed`). The seam (lib/writes.mjs runRadarScan) runs them
// through the same pre-filters and judge as every other engine lane. Like hacker-news-social.mjs
// it is search-only: no publish, no reply, no lane to connect. Parsing and the SSRF fence live in
// lib/radar-feed.mjs. Zero deps: fetch + node builtins.
//
// The query carries `feedAllowPrivate` (posting.radar.feedAllowPrivate, set by the seam from the
// owner-only config, never from the query itself): the private hosts a feed may reach.
//
// Usage:
//   radar --query <json>   { feeds:[url], feedAllowPrivate?:[host] } -> { action:'radar', ok, items }
//
// Mock: `radar` is in MOCKABLE_COMMANDS, so main() routes it to the mock driver (no network).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand } from '../lib/mode.mjs';
import { enforceCeremonyClient } from '../lib/cli-client.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
import { fetchFeed, parseFeed } from '../lib/radar-feed.mjs';

export const RUN = { results: [] };
let JSON_MODE = false;
export const FEED_MAX_PER_QUERY = 20;

/**
 * Read the query's feeds. Returns the RUN row: an ok row with items (and a `degrade` when some
 * feeds failed), a rate_limited row when every feed answered 429, or an engine_failure row with the
 * reasons when no feed could be read. `opts` are the test seams (get, resolve) of lib/radar-feed.mjs fetchFeed.
 */
export async function feedRadar(query = {}, opts = {}) {
  const { radarOkRow, radarRateLimitedRow, radarErrorRow } = await import('../lib/radar.mjs');
  const feeds = (Array.isArray(query.feeds) ? query.feeds : []).filter((u) => typeof u === 'string' && u.trim()).slice(0, FEED_MAX_PER_QUERY);
  if (!feeds.length) return radarOkRow('feed', []);
  const allowPrivate = Array.isArray(query.feedAllowPrivate) ? query.feedAllowPrivate : [];
  const items = [];
  const seen = new Set();
  const failures = [];
  let limited = 0;
  let retryAfter = null;
  for (const feedUrl of feeds) {
    const res = await fetchFeed(feedUrl, { allowPrivate, ...opts });
    if (!res.ok) {
      if (res.error === 'rate_limited') { limited += 1; if (res.retryAfter != null) retryAfter = res.retryAfter; }
      let host = feedUrl;
      try { host = new URL(feedUrl).host; } catch { /* keep the raw string */ }
      failures.push(`${host}: ${res.detail || res.error}`);
      continue;
    }
    const parsed = parseFeed(res.body, feedUrl);
    if (!parsed.format) { failures.push(`${new URL(feedUrl).host}: not a feed`); continue; }
    for (const it of parsed.items) {
      if (seen.has(it.externalId)) continue;
      seen.add(it.externalId);
      items.push(it);
    }
  }
  const detail = failures.length ? failures.join('; ').slice(0, 300) : null;
  if (!items.length && failures.length === feeds.length) {
    if (limited === feeds.length) return radarRateLimitedRow('feed', retryAfter);
    return { ...radarErrorRow('feed', detail), detail };
  }
  const row = radarOkRow('feed', items);
  if (failures.length) row.degrade = { error: 'engine_failure', detail };
  return row;
}

export async function cmdRadar(args) {
  let query = {};
  try { query = args.query ? JSON.parse(String(args.query)) : {}; } catch { query = {}; }
  RUN.results.push(await feedRadar(query));
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
  await enforceCeremonyClient({ argv: args, command: args._[0], lane: 'feed', scriptUrl: import.meta.url });
  JSON_MODE = Boolean(args.json);
  if (JSON_MODE) console.log = (...a) => console.error(...a);
  const commandName = args._[0];
  if (resolveMode('feed') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({ platform: 'feed', command: commandName, query: typeof args.query === 'string' ? args.query : null });
    if (JSON_MODE) process.stdout.write(`${JSON.stringify(envelope)}\n`);
    else console.error(`[mock] feed ${commandName}: ${(envelope.results || []).length} result(s)`);
    return;
  }
  const cmd = COMMANDS[commandName];
  if (!cmd) {
    console.error(`Usage: node scripts/feed-radar.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
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
