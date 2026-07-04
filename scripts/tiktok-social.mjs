#!/usr/bin/env node
/**
 * tiktok-social.mjs - direct TikTok publishing via the Content Posting API.
 *
 * Sibling of scripts/telegram-social.mjs / x-social.mjs / yt-social.mjs: the same
 * zero-dep, plan-driven, publish-straight-from-the-local-render pattern, with
 * TikTok's OAuth2 (Login Kit) auth and its multi-step direct-post upload flow.
 *
 * THIS IS THE RISKIEST LANE. TikTok publishing is a THREE-step dance with no
 * single "post" call: INIT (reserve a publish_id + upload_url) -> UPLOAD (PUT the
 * raw bytes) -> POLL (status/fetch until PUBLISH_COMPLETE | FAILED). Every step
 * can return a partial / shape-shifted payload, so this engine is defensive about
 * missing fields everywhere and bounds the poll loop.
 *
 * ============================================================================
 *  HONESTY / BETA: unaudited apps can ONLY post privately (SELF_ONLY).
 * ============================================================================
 * TikTok's Content Posting API gates PUBLIC posting behind a per-app content
 * audit (typically a 2-6 week review). Until your TikTok app passes that audit it
 * is "unaudited": every post is forced to privacy_level SELF_ONLY (visible only
 * to the posting account) and is rate-limited to a handful of posts per 24h for a
 * small set of explicitly-allowlisted target users. We therefore DEFAULT
 * privacy_level to 'SELF_ONLY' (see PRIVACY_LEVEL below) and never silently
 * publish public content. Treat this lane as BETA until your app is audited; flip
 * to a public privacy level (e.g. via post.ttPrivacy) only once TikTok has
 * approved your app for public posting.
 * ============================================================================
 *
 * TikTok has NO native scheduling API, so entries publish at their due time by
 * re-running `publish-due` (driven by the scheduler tick), exactly like Telegram
 * / Instagram / X. `schedule` is intentionally unsupported.
 *
 * TikTok requires MEDIA: this lane publishes VIDEO posts only (a video render in
 * the local plan folder). Text-only posts are not a TikTok concept and are skipped.
 *
 * AUTH - TikTok Login Kit OAuth2 (loopback authorize-code + refresh):
 *   TIKTOK_CLIENT_KEY      the app's client key   (TikTok for Developers console)
 *   TIKTOK_CLIENT_SECRET   the app's client secret
 *   Persisted after `auth`:
 *   TIKTOK_ACCESS_TOKEN    short-lived (~24h) bearer token
 *   TIKTOK_REFRESH_TOKEN   long-lived (~365d) refresh token
 *   TIKTOK_TOKEN_EXPIRES_AT epoch ms when the access token expires
 *   Redirect: http://127.0.0.1:8088/oauth/tiktok/callback (loopback, like yt-social).
 *
 * Commands:
 *   auth | connect   one-time loopback OAuth ceremony; writes client + tokens
 *   refresh          mint a fresh access token from the refresh token
 *   validate         --plan <p> [--only <id>]   side-effect-free preview, never posts
 *   publish-due      --plan <p> [--only <id>] [--dry-run]   publish any due TikTok video
 *   status           --plan <p>                 list TikTok plan entries
 *   verify           --plan <p> [--only <id>]   read-only liveness (best-effort)
 *   insights         --plan <p> [--only <id>]   honest no-op (no per-post metrics here)
 *   delete           --id <publishId>           no-op (the API cannot delete a post)
 *   probe                                        read-only health probe (user/info)
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand } from '../lib/mode.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
import { envPath } from '../lib/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = envPath();

// ---------- TikTok endpoints ----------
const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/video/init/';
const STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';
// user/info REQUIRES an explicit ?fields= list, or it 400s with invalid_params.
const USERINFO_URL = 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,display_name';

// video.publish + video.upload are the Content Posting API scopes; user.info.basic
// powers `probe`. Space-separated per the OAuth2 spec; comma-joined for TikTok's
// authorize endpoint (it expects a comma list there).
const SCOPES = ['user.info.basic', 'video.upload', 'video.publish'];
const DEFAULT_REDIRECT = 'http://127.0.0.1:8088/oauth/tiktok/callback';

// PRIVACY: unaudited apps cannot post public. We DEFAULT to SELF_ONLY (private to
// the posting account); a post may request a wider level via post.ttPrivacy, but
// TikTok enforces the audit requirement server-side - a wider level on an un-audited
// app is rejected at publish, the engine does not gate it. Do NOT change this default.
const PRIVACY_LEVEL = 'SELF_ONLY';

// Caption cap: TikTok titles/descriptions accept up to 2200 chars.
const CAPTION_LIMIT = 2200;

// Status-poll bounds: TikTok processing is async; poll with linear backoff.
const POLL_MAX_TRIES = 10;
const POLL_BASE_MS = 3000;

// Refresh the access token when it expires within this window.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

const redirectUri = () => readEnv('TIKTOK_REDIRECT_URI') || DEFAULT_REDIRECT;

// ---------- env helpers (same shape as the sibling engines) ----------

function readEnvRaw() {
  return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
}
function readEnv(name) {
  const m = readEnvRaw().match(new RegExp(`^${name}=(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}
function writeEnv(vars) {
  let raw = readEnvRaw();
  for (const [k, v] of Object.entries(vars)) {
    if (v == null) continue;
    // function replacer: token values may contain '$', special in a string replace.
    if (new RegExp(`^${k}=`, 'm').test(raw)) {
      raw = raw.replace(new RegExp(`^${k}=.*$`, 'm'), () => `${k}=${v}`);
    } else {
      raw += `${raw.endsWith('\n') || raw === '' ? '' : '\n'}${k}=${v}\n`;
    }
  }
  const tmp = `${ENV_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, raw, { mode: 0o600 });
  fs.renameSync(tmp, ENV_PATH);
}
function requireEnv(name) {
  const v = readEnv(name);
  if (!v) {
    console.error(`[err] ${name} missing in .env - run 'node scripts/tiktok-social.mjs auth' first.`);
    process.exit(1);
  }
  return v;
}
function tokenTail(t) {
  return t ? `...${t.slice(-6)}, length ${t.length}` : '(none)';
}

// ---------- oauth ----------

// TikTok's token endpoint is x-www-form-urlencoded; errors arrive as either a
// flat {error, error_description} or nested {error:{code,message}} - handle both.
async function tokenExchange(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  const errCode = typeof data.error === 'object' ? data.error?.code : data.error;
  const errMsg = typeof data.error === 'object'
    ? data.error?.message
    : (data.error_description || data.raw || text);
  if (!res.ok || (errCode && errCode !== 'ok')) {
    const hint = errCode === 'invalid_grant'
      ? " - the refresh token is expired/revoked. Re-run 'node scripts/tiktok-social.mjs auth'."
      : '';
    throw new Error(`TikTok OAuth ${params.grant_type}: HTTP ${res.status} ${errCode || ''} - ${errMsg || 'unknown'}${hint}`);
  }
  return data;
}

// Persist the token triple from a token response, defensively (the response may
// nest fields or omit a refresh token on a refresh-grant that rotates lazily).
function persistTokens(data) {
  const access = data.access_token;
  const refresh = data.refresh_token;
  const expiresIn = Number(data.expires_in) || 0;
  const vars = {};
  if (access) vars.TIKTOK_ACCESS_TOKEN = access;
  if (refresh) vars.TIKTOK_REFRESH_TOKEN = refresh;
  if (access) vars.TIKTOK_TOKEN_EXPIRES_AT = String(Date.now() + expiresIn * 1000);
  if (Object.keys(vars).length) writeEnv(vars);
  return vars;
}

// Return a valid access token, refreshing if it expires within the buffer (or is
// already gone). Throws (never returns a stale token) so callers fail loud.
async function getAccessToken(force = false) {
  const token = readEnv('TIKTOK_ACCESS_TOKEN');
  const expiresAt = Number(readEnv('TIKTOK_TOKEN_EXPIRES_AT') || 0);
  if (token && !force && expiresAt - Date.now() > REFRESH_BUFFER_MS) return token;

  const refresh = readEnv('TIKTOK_REFRESH_TOKEN');
  if (!refresh) {
    // No refresh token yet but an unexpired access token exists -> use it.
    if (token && expiresAt > Date.now()) return token;
    console.error("[err] TIKTOK_REFRESH_TOKEN missing - run 'node scripts/tiktok-social.mjs auth' first.");
    process.exit(1);
  }
  const data = await tokenExchange({
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_key: requireEnv('TIKTOK_CLIENT_KEY'),
    client_secret: requireEnv('TIKTOK_CLIENT_SECRET'),
  });
  const vars = persistTokens(data);
  if (!vars.TIKTOK_ACCESS_TOKEN) throw new Error('refresh returned no access_token.');
  return vars.TIKTOK_ACCESS_TOKEN;
}

// ---------- Content Posting API helper (bearer JSON POST) ----------

async function ttPost(url, body, token) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  // TikTok wraps responses in { data, error:{ code, message, log_id } }. code 'ok'
  // means success; anything else (or a non-2xx) is a failure.
  const err = data.error || {};
  if (!res.ok || (err.code && err.code !== 'ok')) {
    throw new Error(`TikTok ${new URL(url).pathname}: HTTP ${res.status} ${err.code || ''} - ${err.message || data.raw || text || 'unknown'}`);
  }
  return data;
}

async function ttGet(url, token) {
  const res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  const err = data.error || {};
  if (!res.ok || (err.code && err.code !== 'ok')) {
    throw new Error(`TikTok ${new URL(url).pathname}: HTTP ${res.status} ${err.code || ''} - ${err.message || data.raw || text || 'unknown'}`);
  }
  return data;
}

// ---------- plan helpers (same shape as the sibling engines) ----------

function loadPlan(planPath) {
  const abs = path.resolve(planPath);
  return { abs, plan: JSON.parse(fs.readFileSync(abs, 'utf8')) };
}

const ENGINE_OWNED_FIELDS = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'xPostId', 'tgMessageId', 'dcMessageId', 'tiktokVideoId', 'status', 'postedAt', 'attempts'];

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

const isTikTok = (post) => (post.platforms || []).includes('tiktok');
const isVideo = (localPath) => /\.(mp4|mov|m4v)$/i.test(localPath || '');
const captionText = (post) => (post.ttCaption || post.caption || '').trim();

// Privacy level for a post: SELF_ONLY by default (unaudited-safe). A post may
// request a wider level via post.ttPrivacy; TikTok enforces the audit requirement
// server-side (a wider level on an un-audited app fails at publish, not here).
function privacyFor(post) {
  const wanted = (post.ttPrivacy || '').toString().trim().toUpperCase();
  const allowed = ['SELF_ONLY', 'PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR'];
  return allowed.includes(wanted) ? wanted : PRIVACY_LEVEL;
}

// ---------- the three-step direct-post upload ----------

// 1) INIT: reserve a publish_id + upload_url for a single-chunk FILE_UPLOAD.
async function initUpload(post, mediaPath, token) {
  const size = fs.statSync(mediaPath).size;
  const body = {
    post_info: {
      title: captionText(post).slice(0, CAPTION_LIMIT),
      privacy_level: privacyFor(post),
    },
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: size,
      chunk_size: size, // single chunk
      total_chunk_count: 1,
    },
  };
  const res = await ttPost(INIT_URL, body, token);
  const publishId = res?.data?.publish_id;
  const uploadUrl = res?.data?.upload_url;
  if (!publishId || !uploadUrl) {
    throw new Error(`init returned no publish_id/upload_url: ${JSON.stringify(res?.data || res).slice(0, 200)}`);
  }
  return { publishId, uploadUrl, size };
}

// 2) UPLOAD: PUT the whole file as a single content range. TikTok expects the
//    byte-exact Content-Range (the dance is unforgiving about an off-by-one).
async function uploadBytes(uploadUrl, mediaPath, size) {
  const buf = fs.readFileSync(mediaPath);
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes 0-${size - 1}/${size}`,
      'Content-Length': String(size),
    },
    body: buf,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`upload PUT: HTTP ${res.status} - ${t.slice(0, 200) || 'unknown'}`);
  }
}

// 3) POLL: status/fetch until PUBLISH_COMPLETE | FAILED, bounded with backoff.
//    Returns { status, videoId } where videoId is best-effort (TikTok does not
//    always surface a post id here).
async function pollStatus(publishId, token) {
  let last = null;
  for (let i = 0; i < POLL_MAX_TRIES; i++) {
    await new Promise((r) => setTimeout(r, POLL_BASE_MS * (i + 1)));
    let res;
    try {
      res = await ttPost(STATUS_URL, { publish_id: publishId }, token);
    } catch (err) {
      last = { error: err.message };
      continue; // transient status read - keep trying within the bound
    }
    const d = res?.data || {};
    const status = d.status || d.publish_status || '';
    last = d;
    if (status === 'PUBLISH_COMPLETE') {
      // publicly_available_post_id is an array on success in some API versions.
      const videoId = Array.isArray(d.publicly_available_post_id)
        ? d.publicly_available_post_id[0]
        : (d.publicly_available_post_id || d.post_id || null);
      return { status, videoId: videoId ? String(videoId) : null };
    }
    if (status === 'FAILED') {
      const reason = d.fail_reason || d.failure_reason || 'unknown';
      throw new Error(`TikTok processing FAILED: ${reason}`);
    }
    // PROCESSING_UPLOAD / PROCESSING_DOWNLOAD / SEND_TO_USER_INBOX -> keep polling.
  }
  // Bounded out without a terminal state. The post may still complete async; we
  // return the publish_id so the operator can verify later rather than erroring.
  const seen = last && typeof last === 'object' ? (last.status || last.publish_status || 'unknown') : 'unknown';
  return { status: `PENDING (last seen: ${seen})`, videoId: null };
}

// ---------- commands ----------

async function cmdAuth(args) {
  console.log(`[info] Connecting TikTok - credentials will be written to ${ENV_PATH}`);
  const clientKey = args['client-key'] || args['client-id'] || readEnv('TIKTOK_CLIENT_KEY');
  const clientSecret = args['client-secret'] || readEnv('TIKTOK_CLIENT_SECRET');
  if (!clientKey || !clientSecret) {
    console.error('[err] Need --client-key and --client-secret (TikTok for Developers -> your app -> credentials) on first run, or set TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET in .env.');
    process.exit(2);
  }
  const redirect = redirectUri();
  writeEnv({ TIKTOK_CLIENT_KEY: clientKey, TIKTOK_CLIENT_SECRET: clientSecret, TIKTOK_REDIRECT_URI: redirect });

  const u = new URL(redirect);
  const port = Number(u.port || 80);
  const callbackPath = u.pathname || '/oauth/tiktok/callback';
  const state = crypto.randomUUID();
  const authUrl = `${AUTH_URL}?${new URLSearchParams({
    client_key: clientKey,
    response_type: 'code',
    scope: SCOPES.join(','),
    redirect_uri: redirect,
    state,
  }).toString()}`;

  console.log(`\n[action] Make sure ${redirect} is registered as a Redirect URI for this TikTok app (TikTok for Developers -> Login Kit -> Redirect URI).`);
  console.log('[action] Opening the TikTok consent screen. Sign in with the account that will publish. If it does not open, paste this URL:\n');
  console.log(`  ${authUrl}\n`);
  console.log('[note] Unaudited apps can only post privately (SELF_ONLY) to a few allowlisted users; public posting requires a per-app content audit (2-6 weeks).');

  await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const ru = new URL(req.url, redirect);
      if (ru.pathname !== callbackPath) { res.writeHead(404); res.end('not found'); return; }

      const error = ru.searchParams.get('error');
      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h2>Authorization denied: ${error}</h2><p>${ru.searchParams.get('error_description') || ''}</p>`);
        server.close();
        reject(new Error(`Authorization denied: ${error} - ${ru.searchParams.get('error_description') || ''}`));
        return;
      }
      const code = ru.searchParams.get('code');
      if (!code) { res.writeHead(400); res.end('missing code'); return; }
      if (ru.searchParams.get('state') !== state) {
        res.writeHead(400); res.end('state mismatch');
        server.close();
        reject(new Error('OAuth state mismatch - possible CSRF; aborted.'));
        return;
      }
      try {
        const data = await tokenExchange({
          grant_type: 'authorization_code',
          code,
          client_key: clientKey,
          client_secret: clientSecret,
          redirect_uri: redirect,
        });
        const vars = persistTokens(data);
        if (!vars.TIKTOK_ACCESS_TOKEN) throw new Error('token exchange returned no access_token.');
        if (!vars.TIKTOK_REFRESH_TOKEN) console.error('[warn] No refresh_token returned - re-auth will be needed when the access token expires.');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>pendpost: TikTok connected.</h2><p>You can close this tab and return to the terminal.</p>');
        console.log(`\n[ok] Access token stored (${tokenTail(vars.TIKTOK_ACCESS_TOKEN)}).`);
        if (vars.TIKTOK_REFRESH_TOKEN) console.log(`[ok] Refresh token stored (${tokenTail(vars.TIKTOK_REFRESH_TOKEN)}).`);
        if (vars.TIKTOK_TOKEN_EXPIRES_AT) console.log(`[ok] Access token expires ${new Date(Number(vars.TIKTOK_TOKEN_EXPIRES_AT)).toLocaleString('en-US')}.`);
        server.close();
        resolve();
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h2>Token exchange failed</h2><pre>${err.message}</pre>`);
        server.close();
        reject(err);
      }
    });
    server.on('error', reject);
    server.listen(port, () => {
      execFile('open', [authUrl], () => {}); // best-effort browser open on macOS (no shell -> no injection)
      console.log(`[info] Waiting for the TikTok consent redirect on ${redirect} ...`);
    });
  });

  RUN.results.push({ platform: 'tiktok', action: 'auth', ok: true, detail: 'tokens stored', tokenExpiresAt: Number(readEnv('TIKTOK_TOKEN_EXPIRES_AT')) || null });
}

async function cmdRefresh() {
  const token = await getAccessToken(true);
  const expiresAt = Number(readEnv('TIKTOK_TOKEN_EXPIRES_AT')) || null;
  console.log(`[ok] Access token refreshed ${tokenTail(token)}${expiresAt ? `, expires ${new Date(expiresAt).toLocaleString('en-US')}` : ''}.`);
  RUN.results.push({ platform: 'tiktok', action: 'refresh', ok: true, tokenExpiresAt: expiresAt });
}

async function cmdValidate(args) {
  const { plan } = loadPlan(args.plan);
  console.log('================ VALIDATION ONLY - NOTHING WILL BE PUBLISHED ================');
  try {
    const token = await getAccessToken();
    const info = await ttGet(USERINFO_URL, token);
    const name = info?.data?.user?.display_name || info?.data?.user?.union_id || 'connected';
    console.log(`[ok] Token valid - authenticated as ${name}.`);
  } catch (err) {
    console.log(`[warn] auth/probe failed (${err.message}). Continuing to caption preview.`);
  }
  const targets = (plan.posts || []).filter((p) => isTikTok(p) && (!args.only || p.id === args.only));
  if (!targets.length) { console.log('[warn] No TikTok entries match.'); return; }
  for (const post of targets) {
    const text = captionText(post);
    console.log(`\n----- ${post.id} -----`);
    console.log(`[preview] type:    ${post.type}`);
    console.log(`[preview] privacy: ${privacyFor(post)}${privacyFor(post) === PRIVACY_LEVEL ? ' (default - unaudited-safe)' : ''}`);
    console.log(`[preview] caption (${text.length}/${CAPTION_LIMIT}${text.length > CAPTION_LIMIT ? ' - OVER LIMIT' : ''}):`);
    console.log(text);
    const mediaPath = resolveMediaPath(plan, post);
    if (!mediaPath) console.log(`[warn] media not found (${post.path || post.file}) - TikTok requires a video.`);
    else if (!isVideo(mediaPath)) console.log(`[warn] media ${path.basename(mediaPath)} is not a video - TikTok publishes video only.`);
    else console.log(`[preview] video:   ${path.basename(mediaPath)} (${(fs.statSync(mediaPath).size / 1e6).toFixed(1)} MB)`);
  }
  console.log('\n================ VALIDATION COMPLETE ================');
}

async function cmdPublishDue(args) {
  const { abs, plan } = loadPlan(args.plan);
  const now = Date.now();
  let published = 0;

  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isTikTok(post)) continue;
    if (post.executionMode !== 'fully-scheduled') continue;
    if (post.status !== 'planned') continue;
    if ((post.approval || 'draft') !== 'approved') {
      console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish.`);
      continue;
    }
    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs) || dueMs > now) continue;

    const text = captionText(post);
    if (text.length > CAPTION_LIMIT) { console.log(`[warn] ${post.id}: caption is ${text.length} chars (> ${CAPTION_LIMIT}) - skipping.`); continue; }

    // TikTok requires a video render - text-only posts are not publishable here.
    const mediaPath = resolveMediaPath(plan, post);
    if (!mediaPath) { console.log(`[warn] ${post.id}: due but local media not found (${post.path || post.file}) - skipping.`); continue; }
    if (!isVideo(mediaPath)) { console.log(`[warn] ${post.id}: media ${path.basename(mediaPath)} is not a video - TikTok publishes video only; skipping.`); continue; }

    if (args['dry-run']) {
      console.log(`[dry] ${post.id}: would init+upload ${path.basename(mediaPath)} and post privacy=${privacyFor(post)}.`);
      continue;
    }

    console.log(`[info] ${post.id}: publishing video to TikTok (privacy=${privacyFor(post)})...`);
    try {
      const token = await getAccessToken();
      const { publishId, uploadUrl, size } = await initUpload(post, mediaPath, token);
      // Store the publish_id immediately - if upload/poll fails we still know the
      // reservation that was made (recovery + dedupe), per the assignment.
      post.tiktokVideoId = String(publishId);
      await savePlan(abs, plan, [post.id]);

      await uploadBytes(uploadUrl, mediaPath, size);
      const { status, videoId } = await pollStatus(publishId, token);

      if (videoId) post.tiktokVideoId = String(videoId);
      post.status = 'posted';
      post.postedAt = new Date(now).toISOString();
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'tiktok', action: 'publish', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'tiktok', action: 'publish', ok: true, id: String(videoId || publishId), detail: status });
      console.log(`[ok] ${post.id}: published on TikTok (publish_id ${publishId}${videoId ? `, video ${videoId}` : ''}) - ${status}.`);
      published += 1;
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'tiktok', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'tiktok', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: TikTok publish failed - ${err.message}`);
      continue;
    }
  }
  console.log(`[done] publish-due complete - ${published} video(s) published.`);
}

async function cmdStatus(args) {
  const { plan } = loadPlan(args.plan);
  console.log('[info] TikTok plan entries:');
  for (const post of (plan.posts || []).filter(isTikTok)) {
    console.log(`  ${post.id.padEnd(18)} ${String(post.status).padEnd(10)} ${post.scheduledAt}  mode=${post.executionMode}${post.tiktokVideoId ? ` tt=${post.tiktokVideoId}` : ''}`);
  }
}

// Best-effort liveness: re-fetch the publish status for any stored publish_id.
// TikTok exposes no public "get post" by id to the posting app, so a stored id +
// a reachable account is our liveness signal.
async function cmdVerify(args) {
  const { plan } = loadPlan(args.plan);
  let token = null;
  try { token = await getAccessToken(); } catch { /* surfaced per row */ }
  for (const post of (plan.posts || []).filter(isTikTok)) {
    if (args.only && post.id !== args.only) continue;
    if (!post.tiktokVideoId) continue;
    let live = false;
    let state = 'unknown';
    if (token) {
      try {
        const res = await ttPost(STATUS_URL, { publish_id: post.tiktokVideoId }, token);
        state = res?.data?.status || res?.data?.publish_status || 'unknown';
        live = state === 'PUBLISH_COMPLETE';
      } catch { /* the id may already be a final video id, not a publish_id */ }
    }
    RUN.results.push({ postId: post.id, platform: 'tiktok', action: 'verify', ok: true, live, state, permalink: null, id: post.tiktokVideoId });
  }
}

// TikTok exposes no per-post metrics to a content-posting app - honest no-op.
async function cmdInsights(args) {
  const { plan } = loadPlan(args.plan);
  void plan;
  console.log('[info] TikTok Content Posting API exposes no per-post metrics - insights is a no-op.');
}

// The Content Posting API cannot delete a published post programmatically.
async function cmdDelete(args) {
  void args;
  console.log('[info] TikTok provides no delete API for published posts - delete is a no-op (remove the post in the TikTok app).');
  RUN.results.push({ platform: 'tiktok', action: 'delete', ok: false, errorCode: 'unsupported', errorMessage: 'TikTok has no delete-post API' });
}

async function cmdProbe() {
  if (!readEnv('TIKTOK_ACCESS_TOKEN') && !readEnv('TIKTOK_REFRESH_TOKEN')) {
    RUN.results.push({ platform: 'tiktok', action: 'probe', ok: false, detail: 'not configured (run auth)' });
    return;
  }
  try {
    const token = await getAccessToken();
    const info = await ttGet(USERINFO_URL, token);
    const name = info?.data?.user?.display_name || info?.data?.user?.union_id || 'connected';
    const expiresAt = Number(readEnv('TIKTOK_TOKEN_EXPIRES_AT') || 0) || null;
    RUN.results.push({ platform: 'tiktok', action: 'probe', ok: true, detail: `connected as ${name}`, tokenExpiresAt: expiresAt });
  } catch (err) {
    RUN.results.push({ platform: 'tiktok', action: 'probe', ok: false, detail: String(err.message || err).slice(0, 200) });
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
  if (resolveMode('tiktok') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'tiktok', command: commandName,
      planPath: typeof args.plan === 'string' ? path.resolve(String(args.plan)) : null,
      only: typeof args.only === 'string' ? args.only : null,
    });
    if (JSON_MODE) process.stdout.write(`${JSON.stringify(envelope)}\n`);
    else console.error(`[mock] tiktok ${commandName}: ${envelope.results.length} result(s)`);
    return;
  }
  const cmd = COMMANDS[commandName];
  if (!cmd) {
    console.error(`Usage: node scripts/tiktok-social.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
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
