// comments-reply.test.mjs - the inbound-engagement (inbox) seam (spec 02, Pattern
// P6) run end-to-end through the REAL engine entrypoints, credential-free.
//
// Three proofs per lane, no network:
//   1. mock `comments` returns a normalized items[] ({ kind, commentId, author,
//      text, ts, postId }) - the canonical Comment shape every lane shares.
//   2. mock `reply` returns { ok:true, id } and a results[] reply row.
//   3. an ungranted lane degrades to { ok:false, error:'needs_scope', scope } on
//      BOTH verbs (P9) - via the mock ungranted signal AND, for a couple of lanes,
//      via the LIVE path with no credentials (a real needs_scope, still no network).
//
// The real-network paths (once scopes are granted) are proven separately per lane's
// live-verify checklist; this test never touches the network.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sortNewestFirst, normalizeComment } from '../lib/comments.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

// The ten comment-capable lanes (spec 02 §4): script + the raw plan id field the
// engine resolves its object id from.
const LANES = {
  meta: { script: 'scripts/meta-social.mjs', idField: 'igMediaId' },
  youtube: { script: 'scripts/yt-social.mjs', idField: 'ytVideoId' },
  linkedin: { script: 'scripts/linkedin-social.mjs', idField: 'liPostId' },
  wordpress: { script: 'scripts/wordpress-social.mjs', idField: 'wordpressPostId' },
  reddit: { script: 'scripts/reddit-social.mjs', idField: 'redditPostId' },
  tiktok: { script: 'scripts/tiktok-social.mjs', idField: 'tiktokVideoId' },
  telegram: { script: 'scripts/telegram-social.mjs', idField: 'tgMessageId' },
  mastodon: { script: 'scripts/mastodon-social.mjs', idField: 'mastodonStatusId' },
  nostr: { script: 'scripts/nostr-social.mjs', idField: 'nostrEventId' },
  discord: { script: 'scripts/discord-social.mjs', idField: 'dcMessageId' },
};

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-comments-'));

function runEngine(script, args, extraEnv = {}) {
  const out = execFileSync(process.execPath, [path.join(REPO, script), ...args], {
    cwd: REPO,
    env: { ...process.env, PENDPOST_ROOT: WS, ...extraEnv },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}

// A normalized Comment carries the canonical fields + a kind discriminator.
function isComment(c) {
  return c && typeof c === 'object'
    && typeof c.commentId === 'string' && c.commentId
    && typeof c.author === 'string'
    && typeof c.text === 'string'
    && (c.kind === 'comment' || c.kind === 'review');
}

try {
  for (const [lane, def] of Object.entries(LANES)) {
    // A posted post the lane can resolve an object id from.
    const planPath = path.join(WS, `${lane}-plan.json`);
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: `inbox-${lane}`,
      posts: [{ id: 'p1', platforms: [lane === 'meta' ? 'instagram' : lane], status: 'posted', [def.idField]: `obj_${lane}_1` }],
    }, null, 2));

    // 1. mock comments -> normalized items[]
    const com = runEngine(def.script, ['comments', '--plan', planPath, '--only', 'p1', '--json'], { PENDPOST_MODE: 'mock' });
    ok(com.ok === true && Array.isArray(com.items) && com.items.length > 0, `${lane}: mock comments returns a non-empty items[]`);
    ok((com.items || []).every(isComment), `${lane}: every item is a normalized Comment { kind, commentId, author, text }`);
    ok(com.platform === lane && typeof com.postId === 'string', `${lane}: comments envelope carries platform + postId`);

    // 2. mock reply -> { ok, id } + a reply results row carrying the documented
    // { postId, platform, action, ok, id } shape (spec §C / P3).
    const rep = runEngine(def.script, ['reply', '--comment-id', 'c-abc', '--text', 'thanks for the note!', '--only', 'p1', '--json', '--actor', 'owner'], { PENDPOST_MODE: 'mock' });
    ok(rep.ok === true && typeof rep.id === 'string' && rep.id, `${lane}: mock reply returns { ok:true, id }`);
    const repRow = (rep.results || []).find((r) => r.action === 'reply' && r.ok === true);
    ok(repRow && repRow.postId === 'p1' && repRow.platform === lane, `${lane}: reply row carries { postId, platform, action, ok, id }`);

    // 3a. ungranted (mock signal) -> needs_scope on BOTH verbs, never a throw
    const comU = runEngine(def.script, ['comments', '--id', 'x1', '--json'], { PENDPOST_MODE: 'mock', PENDPOST_MOCK_UNGRANTED: lane });
    ok(comU.ok === false && comU.error === 'needs_scope' && typeof comU.scope === 'string', `${lane}: ungranted comments degrades to needs_scope (P9)`);
    const repU = runEngine(def.script, ['reply', '--comment-id', 'c1', '--text', 'hi', '--json', '--actor', 'owner'], { PENDPOST_MODE: 'mock', PENDPOST_MOCK_UNGRANTED: lane });
    ok(repU.ok === false && repU.error === 'needs_scope', `${lane}: ungranted reply degrades to needs_scope (P9)`);
  }

  // 3b. LIVE path (no PENDPOST_MODE) with NO credentials in the workspace .env:
  // the engine hits the shared REST helper, finds no token, and returns a REAL
  // needs_scope - a genuine degrade proof that still touches no network.
  for (const lane of ['mastodon', 'wordpress', 'meta']) {
    const def = LANES[lane];
    const live = runEngine(def.script, ['comments', '--id', 'obj-1', '--json']);
    ok(live.ok === false && live.error === 'needs_scope' && typeof live.scope === 'string', `${lane}: LIVE comments with no creds degrades to needs_scope (no network)`);
    const liveR = runEngine(def.script, ['reply', '--comment-id', 'c1', '--text', 'hi', '--id', 'obj-1', '--json', '--actor', 'owner']);
    ok(liveR.ok === false && liveR.error === 'needs_scope', `${lane}: LIVE reply with no creds degrades to needs_scope (no network)`);
  }

  // Normalization boundary: sortNewestFirst orders by ts DESCENDING (spec §2
  // "newest-first"), applied by runLaneComments so every lane is consistent
  // regardless of the platform API's default order. Missing ts sorts last.
  const sorted = sortNewestFirst([
    normalizeComment({ commentId: 'old', text: 'oldest', ts: '2020-01-01T00:00:00Z' }),
    normalizeComment({ commentId: 'new', text: 'newest', ts: '2026-01-01T00:00:00Z' }),
    normalizeComment({ commentId: 'mid', text: 'middle', ts: '2023-01-01T00:00:00Z' }),
    normalizeComment({ commentId: 'none', text: 'no ts' }),
  ]);
  ok(sorted.map((c) => c.commentId).join(',') === 'new,mid,old,none', 'sortNewestFirst orders comments newest-first by ts (missing ts last)');

  // Guard: missing target is a clean invalid_input, never a crash.
  const noTarget = runEngine(LANES.telegram.script, ['comments', '--json']);
  ok(noTarget.ok === false && noTarget.code === 'invalid_input', 'comments with no --id/--plan is a clean invalid_input');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[comments-reply] OK - the inbox seam reads + replies (normalized shape) and degrades cleanly across all ten lanes (${pass} assertions).`);
} catch (err) {
  console.error(`[comments-reply] FAIL - ${err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
