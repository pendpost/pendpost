#!/usr/bin/env node
/**
 * reddit-social.mjs - direct Reddit submission via the OAuth2 API.
 *
 * Sibling of scripts/telegram-social.mjs / discord-social.mjs: the same zero-dep,
 * plan-driven, publish-straight-from-the-local-render pattern, with Reddit's own
 * (script-app, password-grant) auth + posting model.
 *
 * Reddit, like Telegram, is a STATIC-credential lane: there is NO browser OAuth
 * dance and NO long-lived refresh token to persist. A short-lived bearer token is
 * minted on demand per run from a "script" app's client id/secret + the bot
 * account's username/password (OAuth2 password grant), used, and thrown away.
 * `connect`/`auth` therefore only VALIDATES the static creds - it writes nothing.
 *
 * Reddit has NO scheduling API, so entries publish at their due time by re-running
 * `publish-due` (driven by the scheduler tick), exactly like Telegram / Discord.
 *
 * HONESTY / RISK (surfaced as a 'beta' flag + in the playbook):
 *   - Reddit's FREE data API is licensed for NON-COMMERCIAL use only. A commercial
 *     auto-posting workload may require a paid/commercial agreement with Reddit.
 *   - Automated submitting is COMMUNITY-NORM sensitive: most subreddits dislike or
 *     ban bot/cross-posted content, many enforce rate limits, karma/age gates, and
 *     per-subreddit rules. Always post only where you have permission, sparingly,
 *     and to a subreddit whose rules allow it (REDDIT_SUBREDDIT, e.g. "test").
 *   - Reddit BANS default/blank User-Agents - every request sends a descriptive UA.
 *
 * AUTH - a "script" app (https://www.reddit.com/prefs/apps), no browser:
 *   REDDIT_CLIENT_ID      the script app's client id (under the app name).
 *   REDDIT_CLIENT_SECRET  the script app's secret.
 *   REDDIT_USERNAME       the bot account's username (no leading u/).
 *   REDDIT_PASSWORD       the bot account's password.
 *   REDDIT_SUBREDDIT      the destination subreddit identifier (non-secret), e.g.
 *                         "test". The account must be allowed to submit there.
 *
 * Text comes from post.redditText (falls back to post.caption); the title from
 * post.title (falls back to the first non-empty line of the caption) - the
 * additive per-platform override pattern x uses for xCaption.
 *
 * Commands:
 *   auth | connect   mint a token + GET /api/v1/me; report the username; writes nothing
 *   refresh          no-op (token is minted per run, never persisted) - sibling parity
 *   validate         --plan <p> [--only <id>]   side-effect-free preview, never posts
 *   publish-due      --plan <p> [--only <id>] [--dry-run]   publish any due Reddit entry
 *   status           --plan <p>                 list Reddit plan entries
 *   verify           --plan <p> [--only <id>]   read-only liveness (best-effort)
 *   insights         --plan <p> [--only <id>]   minimal honest metrics (score/comments)
 *   probe                                        read-only health probe (token + /me)
 *   delete           --id <fullname>             delete a submission (t3_...) cleanup
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand } from '../lib/mode.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
import { envPath } from '../lib/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = envPath();

// Reddit caps: a self-post title at 300 chars, a self-post body at 40000.
const TITLE_LIMIT = 300;
const TEXT_LIMIT = 40000;

// ---------- env helpers (same shape as the sibling engines) ----------

function readEnvRaw() {
  return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
}
function readEnv(name) {
  const m = readEnvRaw().match(new RegExp(`^${name}=(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

const subreddit = () => readEnv('REDDIT_SUBREDDIT');

// Reddit BANS default/blank User-Agents - send a descriptive UA on EVERY request.
function userAgent() {
  const u = readEnv('REDDIT_USERNAME') || 'unknown';
  return `pendpost/1.0 (by /u/${u})`;
}

// ---------- OAuth2 (password grant, minted on demand, never persisted) ----------

async function mintToken() {
  const clientId = readEnv('REDDIT_CLIENT_ID');
  const clientSecret = readEnv('REDDIT_CLIENT_SECRET');
  const username = readEnv('REDDIT_USERNAME');
  const password = readEnv('REDDIT_PASSWORD');
  const missing = [];
  if (!clientId) missing.push('REDDIT_CLIENT_ID');
  if (!clientSecret) missing.push('REDDIT_CLIENT_SECRET');
  if (!username) missing.push('REDDIT_USERNAME');
  if (!password) missing.push('REDDIT_PASSWORD');
  if (missing.length) throw new Error(`Reddit credentials missing in .env: ${missing.join(', ')}`);

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'password', username, password }).toString();
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent(),
    },
    body,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok || !data.access_token) {
    // Never echo the password/secret - only Reddit's own error string.
    throw new Error(`Reddit token mint failed: HTTP ${res.status} - ${data.error || data.message || data.raw || 'unknown'}`);
  }
  return data.access_token;
}

// Authenticated call against the oauth.reddit.com host.
async function reddit(token, method, pathname, { body, form } = {}) {
  const url = `https://oauth.reddit.com${pathname}`;
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': userAgent() };
  let init = { method, headers };
  if (form) {
    init.body = new URLSearchParams(form).toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`Reddit ${method} ${pathname}: HTTP ${res.status} - ${data.message || data.raw || text || 'unknown'}`);
  }
  return data;
}

// ---------- plan helpers (same shape as the sibling engines) ----------

function loadPlan(planPath) {
  const abs = path.resolve(planPath);
  return { abs, plan: JSON.parse(fs.readFileSync(abs, 'utf8')) };
}

const ENGINE_OWNED_FIELDS = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'xPostId', 'tgMessageId', 'dcMessageId', 'redditPostId', 'status', 'postedAt', 'attempts'];

async function withPlanLock(abs, fn) {
  const lockDir = `${abs}.lock.d`;
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(lockDir); break; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let ageMs = 0;
      try { ageMs = Date.now() - fs.statSync(lockDir).mtimeMs; } catch { continue; }
      if (ageMs > 15 * 60 * 1000) { try { fs.rmdirSync(lockDir); } catch { /* racing steal */ } continue; }
      if (i >= 5) throw new Error(`plan lock busy: ${lockDir}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lockDir); } catch { /* released */ } }
}

async function savePlan(abs, plan, touchedIds = null) {
  await withPlanLock(abs, () => {
    let out = plan;
    if (Array.isArray(touchedIds)) {
      try {
        const disk = JSON.parse(fs.readFileSync(abs, 'utf8'));
        for (const id of touchedIds) {
          const mem = (plan.posts || []).find((p) => p.id === id);
          const target = (disk.posts || []).find((p) => p.id === id);
          if (!mem || !target) continue;
          for (const f of ENGINE_OWNED_FIELDS) if (mem[f] !== undefined) target[f] = mem[f];
        }
        out = disk;
      } catch { /* unreadable disk copy - fall back to in-memory plan */ }
    }
    const tmp = `${abs}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
    fs.renameSync(tmp, abs);
  });
}

function appendAttempt(post, entry) {
  post.attempts = Array.isArray(post.attempts) ? post.attempts : [];
  post.attempts.push(entry);
}

const RUN = { results: [] };
let JSON_MODE = false;
let ACTOR = 'cli';

function resolveMediaPath(plan, post) {
  const root = process.env.PENDPOST_ROOT ? path.resolve(process.env.PENDPOST_ROOT) : path.resolve(__dirname, '..');
  if (post.path) {
    const abs = path.isAbsolute(post.path) ? post.path : path.resolve(root, post.path);
    if (fs.existsSync(abs)) return abs;
  }
  if (post.file) {
    const rel = path.join(plan.folder || '', post.file);
    const abs = path.isAbsolute(rel) ? rel : path.resolve(root, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

const isReddit = (post) => (post.platforms || []).includes('reddit');
const bodyText = (post) => (post.redditText || post.caption || '').trim();

// Title: explicit per-platform/post title, else the first non-empty caption line.
function titleFor(post) {
  if (post.title && String(post.title).trim()) return String(post.title).trim().slice(0, TITLE_LIMIT);
  const firstLine = (post.caption || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return firstLine.slice(0, TITLE_LIMIT);
}

// A public/external media URL turns the submission into a `link` post; otherwise
// it is a `self` (text) post. We never host media for Reddit (no upload layer).
function externalUrl(post) {
  const u = post.redditUrl || post.externalUrl || post.url || post.link || '';
  return typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : null;
}

// Reddit fullnames look like t3_abc; bare ids are the part after the underscore.
function bareId(name) {
  if (!name) return null;
  const s = String(name);
  return s.includes('_') ? s.split('_').pop() : s;
}

function permalinkFor(post) {
  if (!post.redditPostId) return null;
  if (post.redditPermalink) return `https://www.reddit.com${post.redditPermalink}`;
  const id = bareId(post.redditPostId);
  return id ? `https://redd.it/${id}` : null;
}

// ---------- commands ----------

async function cmdAuth() {
  const token = await mintToken();
  const me = await reddit(token, 'GET', '/api/v1/me');
  console.log(`[ok] Reddit credentials valid - authenticated as u/${me.name}.`);
  const sr = subreddit();
  if (!sr) console.log('[warn] REDDIT_SUBREDDIT is not set - publish-due will have no destination.');
  else console.log(`[ok] Destination subreddit: r/${sr}. Confirm the account may submit there and the subreddit allows bot posts.`);
  RUN.results.push({ platform: 'reddit', action: 'auth', ok: true, detail: `u/${me.name}${sr ? ` -> r/${sr}` : ''}` });
}

async function cmdRefresh() {
  console.log('[info] Reddit tokens are minted per run from the password grant (no persisted refresh token).');
}

async function cmdValidate(args) {
  const { plan } = loadPlan(args.plan);
  console.log('================ VALIDATION ONLY - NOTHING WILL BE PUBLISHED ================');
  let token = null;
  try {
    token = await mintToken();
    const me = await reddit(token, 'GET', '/api/v1/me');
    console.log(`[ok] Credentials valid - authenticated as u/${me.name}.`);
  } catch (err) {
    console.log(`[warn] auth check failed (${err.message}). Continuing to content preview.`);
  }
  const sr = subreddit();
  console.log(`[info] Destination subreddit: ${sr ? `r/${sr}` : '(REDDIT_SUBREDDIT not set)'}`);
  const targets = (plan.posts || []).filter((p) => isReddit(p) && (!args.only || p.id === args.only));
  if (!targets.length) { console.log('[warn] No Reddit entries match.'); return; }
  for (const post of targets) {
    const title = titleFor(post);
    const ext = externalUrl(post);
    const text = bodyText(post);
    console.log(`\n----- ${post.id} -----`);
    console.log(`[preview] kind:    ${ext ? 'link' : 'self'}`);
    console.log(`[preview] title (${title.length}/${TITLE_LIMIT}${title.length > TITLE_LIMIT ? ' - OVER LIMIT' : ''}): ${title || '(MISSING - required)'}`);
    if (ext) {
      console.log(`[preview] url:     ${ext}`);
    } else {
      console.log(`[preview] text (${text.length}/${TEXT_LIMIT}${text.length > TEXT_LIMIT ? ' - OVER LIMIT' : ''}):`);
      console.log(text);
    }
    if (post.type !== 'text' && !ext) {
      const mediaPath = resolveMediaPath(plan, post);
      if (mediaPath) console.log(`[note] local media ${path.basename(mediaPath)} present, but Reddit has no upload layer here - set a public redditUrl for a link post.`);
    }
  }
  console.log('\n================ VALIDATION COMPLETE ================');
}

async function cmdPublishDue(args) {
  const { abs, plan } = loadPlan(args.plan);
  const sr = subreddit();
  if (!sr) throw new Error('REDDIT_SUBREDDIT is not set - cannot publish.');
  const now = Date.now();
  let published = 0;
  let token = null;

  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isReddit(post)) continue;
    if (post.executionMode !== 'fully-scheduled') continue;
    if (post.status !== 'planned') continue;
    if ((post.approval || 'draft') !== 'approved') {
      console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish.`);
      continue;
    }
    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs) || dueMs > now) continue;

    const title = titleFor(post);
    if (!title) { console.log(`[warn] ${post.id}: due but no title (post.title / first caption line) - skipping.`); continue; }
    if (title.length > TITLE_LIMIT) { console.log(`[warn] ${post.id}: title is ${title.length} chars (> ${TITLE_LIMIT}) - skipping.`); continue; }

    const ext = externalUrl(post);
    const text = bodyText(post);
    if (!ext && text.length > TEXT_LIMIT) { console.log(`[warn] ${post.id}: text is ${text.length} chars (> ${TEXT_LIMIT}) - skipping.`); continue; }

    if (args['dry-run']) {
      console.log(ext ? `[dry] ${post.id}: would submit a link post -> ${ext}` : `[dry] ${post.id}: would submit a self (text) post (${text.length} chars).`);
      continue;
    }

    if (!token) {
      try { token = await mintToken(); } catch (err) { throw new Error(`cannot mint Reddit token: ${err.message}`); }
    }

    console.log(`[info] ${post.id}: submitting ${ext ? 'link' : 'self'} post to r/${sr}...`);
    try {
      const form = ext
        ? { api_type: 'json', sr, title, kind: 'link', url: ext }
        : { api_type: 'json', sr, title, kind: 'self', text };
      const data = await reddit(token, 'POST', '/api/submit', { form });
      const errs = data?.json?.errors;
      if (Array.isArray(errs) && errs.length) {
        throw new Error(`submit rejected: ${errs.map((e) => (Array.isArray(e) ? e.join(' ') : String(e))).join('; ').slice(0, 200)}`);
      }
      const d = data?.json?.data || {};
      const name = d.name || (d.id ? `t3_${bareId(d.id)}` : null);
      if (!name) throw new Error(`submit returned no id: ${JSON.stringify(data).slice(0, 200)}`);

      post.redditPostId = String(name);
      if (typeof d.url === 'string') post.redditPermalink = d.url.replace(/^https?:\/\/(www\.)?reddit\.com/i, '') || post.redditPermalink;
      post.status = 'posted';
      post.postedAt = new Date(now).toISOString();
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'reddit', action: 'publish', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'reddit', action: 'publish', ok: true, id: String(name) });
      console.log(`[ok] ${post.id}: submitted to r/${sr} (${name}).`);
      published += 1;
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'reddit', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'reddit', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: Reddit submit failed - ${err.message}`);
      continue;
    }
  }
  console.log(`[done] publish-due complete - ${published} submission(s) published.`);
}

async function cmdStatus(args) {
  const { plan } = loadPlan(args.plan);
  console.log('[info] Reddit plan entries:');
  for (const post of (plan.posts || []).filter(isReddit)) {
    console.log(`  ${post.id.padEnd(18)} ${String(post.status).padEnd(10)} ${post.scheduledAt}  mode=${post.executionMode}${post.redditPostId ? ` reddit=${post.redditPostId}` : ''}`);
  }
}

// Best-effort liveness: GET /api/info?id=<fullname> and report whether the
// submission still exists + its public permalink.
async function cmdVerify(args) {
  const { plan } = loadPlan(args.plan);
  let token = null;
  try { token = await mintToken(); } catch { /* surfaced per row */ }
  for (const post of (plan.posts || []).filter(isReddit)) {
    if (args.only && post.id !== args.only) continue;
    if (!post.redditPostId) continue;
    if (!token) {
      RUN.results.push({ postId: post.id, platform: 'reddit', action: 'verify', ok: true, live: false, state: 'unknown', permalink: permalinkFor(post), id: post.redditPostId });
      continue;
    }
    try {
      const data = await reddit(token, 'GET', `/api/info?id=${encodeURIComponent(post.redditPostId)}`);
      const child = data?.data?.children?.[0]?.data;
      const live = Boolean(child) && !child.removed && !child.removed_by_category;
      const permalink = child?.permalink ? `https://www.reddit.com${child.permalink}` : permalinkFor(post);
      RUN.results.push({ postId: post.id, platform: 'reddit', action: 'verify', ok: true, live, state: live ? 'submitted' : 'removed', permalink, id: post.redditPostId });
    } catch (err) {
      RUN.results.push({ postId: post.id, platform: 'reddit', action: 'verify', ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 200), id: post.redditPostId });
    }
  }
}

// Reddit exposes only coarse public counters to a bot - honest, minimal metrics
// (score + comment count) pulled from /api/info, never engagement breakdowns.
async function cmdInsights(args) {
  const { plan } = loadPlan(args.plan);
  let token = null;
  try { token = await mintToken(); } catch { console.log('[info] Reddit insights: could not authenticate - skipping.'); return; }
  for (const post of (plan.posts || []).filter(isReddit)) {
    if (args.only && post.id !== args.only) continue;
    if (!post.redditPostId) continue;
    try {
      const data = await reddit(token, 'GET', `/api/info?id=${encodeURIComponent(post.redditPostId)}`);
      const child = data?.data?.children?.[0]?.data;
      if (!child) { RUN.results.push({ postId: post.id, platform: 'reddit', action: 'insights', ok: true, metrics: {} }); continue; }
      RUN.results.push({ postId: post.id, platform: 'reddit', action: 'insights', ok: true, metrics: { score: child.score ?? 0, num_comments: child.num_comments ?? 0, upvote_ratio: child.upvote_ratio ?? null } });
    } catch (err) {
      RUN.results.push({ postId: post.id, platform: 'reddit', action: 'insights', ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 200) });
    }
  }
}

async function cmdDelete(args) {
  if (!args.id) { console.error('[err] delete requires --id <fullname> (e.g. t3_abc123)'); process.exit(2); }
  const token = await mintToken();
  await reddit(token, 'POST', '/api/del', { form: { id: String(args.id) } });
  RUN.results.push({ platform: 'reddit', action: 'delete', ok: true, id: String(args.id) });
  console.log(`[ok] deleted Reddit submission ${args.id}.`);
}

async function cmdProbe() {
  if (!readEnv('REDDIT_CLIENT_ID') || !readEnv('REDDIT_USERNAME')) {
    RUN.results.push({ platform: 'reddit', action: 'probe', ok: false, detail: 'not configured (REDDIT_CLIENT_ID / REDDIT_USERNAME missing)' });
    return;
  }
  try {
    const token = await mintToken();
    const me = await reddit(token, 'GET', '/api/v1/me');
    RUN.results.push({ platform: 'reddit', action: 'probe', ok: true, detail: `connected as u/${me.name}`, tokenExpiresAt: null });
  } catch (err) {
    RUN.results.push({ platform: 'reddit', action: 'probe', ok: false, detail: String(err.message || err).slice(0, 200) });
  }
}

// ---------- main ----------

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

const COMMANDS = {
  auth: cmdAuth,
  connect: cmdAuth,
  refresh: cmdRefresh,
  validate: cmdValidate,
  'publish-due': cmdPublishDue,
  status: cmdStatus,
  verify: cmdVerify,
  insights: cmdInsights,
  delete: cmdDelete,
  probe: cmdProbe,
};

async function main() {
  const args = parseArgs(process.argv);
  JSON_MODE = Boolean(args.json);
  ACTOR = typeof args.actor === 'string' ? args.actor : 'cli';
  if (JSON_MODE) console.log = (...a) => console.error(...a);
  const commandName = args._[0];
  if (resolveMode('reddit') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'reddit', command: commandName,
      planPath: typeof args.plan === 'string' ? path.resolve(String(args.plan)) : null,
      only: typeof args.only === 'string' ? args.only : null,
    });
    if (JSON_MODE) process.stdout.write(`${JSON.stringify(envelope)}\n`);
    else console.error(`[mock] reddit ${commandName}: ${envelope.results.length} result(s)`);
    return;
  }
  const cmd = COMMANDS[commandName];
  if (!cmd) {
    console.error(`Usage: node scripts/reddit-social.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
    process.exit(2);
  }
  if (['validate', 'publish-due', 'status', 'verify', 'insights'].includes(commandName) && !args.plan) {
    console.error(`[err] ${commandName} requires --plan <post-plan.json>`);
    process.exit(2);
  }
  await cmd(args);
  if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: true, ...RUN })}\n`);
}

main().catch(async (err) => {
  console.error('[err]', err.message || err);
  if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: false, error: String(err.message || err).slice(0, 300), ...RUN })}\n`);
  process.exit(1);
});
