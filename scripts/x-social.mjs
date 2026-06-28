#!/usr/bin/env node
/**
 * x-social.mjs - direct X (Twitter) publishing, no third-party service.
 *
 * Fourth sibling of scripts/meta-social.mjs (Facebook + Instagram),
 * scripts/linkedin-social.mjs (LinkedIn company page) and scripts/yt-social.mjs
 * (YouTube): same zero-dep, plan-driven, publish-straight-from-the-local-render
 * pattern, with X's own auth + posting model.
 *
 * X has NO scheduling API (POST /2/tweets publishes immediately), exactly like
 * Instagram and LinkedIn - so entries are published at their due time by re-running
 * `publish-due` (driven by the scheduler tick / a one-time scheduled task).
 *
 * AUTH - two paths, auto-detected (X_ACCESS_TOKEN_SECRET is the discriminator):
 *
 *   OAuth 1.0a User Context (RECOMMENDED, zero browser): active whenever
 *   X_ACCESS_TOKEN_SECRET is set. Set X_API_KEY + X_API_SECRET (consumer key/secret)
 *   and a portal-generated X_ACCESS_TOKEN + X_ACCESS_TOKEN_SECRET (X dev portal ->
 *   your app -> Keys and tokens -> Access Token and Secret). No redirect, no consent
 *   screen - which sidesteps the ERR_TOO_MANY_REDIRECTS some apps hit on X's OAuth-2
 *   authorize endpoint. Every request is signed HMAC-SHA1 (see lib/x-oauth1.mjs);
 *   media uploads via the legacy v1.1 chunked endpoint, which also takes OAuth 1.0a.
 *
 *   OAuth 2.0 with PKCE (fallback / for apps whose consent flow works): the access
 *   token is SHORT-LIVED (2h) and the refresh token ROTATES on every use, so
 *   `ensureFreshToken` refreshes before each run and persists BOTH the new access
 *   token AND the new refresh token atomically - dropping the rotated refresh token
 *   would brick the next run. Media uploads via X's v2 chunked media upload.
 *
 * ALL media uploads straight from the local render folder (post.path / plan.folder +
 * post.file), byte-for-byte in HD, via X's chunked media upload (INIT/APPEND/
 * FINALIZE/STATUS). No hosting layer, no Cloudinary.
 *
 * Tweet text comes from post.xCaption (capped 280) and falls back to post.caption
 * when xCaption is unset - the additive per-platform override pattern LinkedIn uses
 * for liDescription. A video post is type 'video' (xCaption + the render); a text-only
 * tweet is type 'text' (xCaption / caption, no media).
 *
 * Source of truth: a post-plan.json (see data/plans/<campaign>/post-plan.json).
 *
 * Commands:
 *   auth         [--client-id X --client-secret Y] [--port 8087]   one-time OAuth-2-PKCE ceremony (localhost redirect)
 *   refresh                                                        force a token refresh (verifies the rotating-refresh chain)
 *   validate     --plan <post-plan.json> [--only <postId>]         side-effect-free: confirm auth + preview the tweet text, never posts
 *   publish-due  --plan <post-plan.json> [--only <postId>] [--dry-run]   publish any due X entry
 *   status       --plan <post-plan.json>                           list X plan entries + live tweet state
 *   verify       --plan <post-plan.json> [--only <postId>]         read-only liveness (verify_post / verifySweep)
 *   insights     --plan <post-plan.json> [--only <postId>]         read-only public_metrics
 *   probe                                                          read-only health probe (GET /2/users/me) for the health bar
 *   delete       --id <tweetId>                                    delete a tweet (cleanup)
 *
 * Credentials live in the gitignored .env (same convention as the siblings).
 *   OAuth 2.0 PKCE: X_CLIENT_ID, X_CLIENT_SECRET, X_ACCESS_TOKEN, X_REFRESH_TOKEN,
 *                   X_TOKEN_EXPIRES_AT (epoch ms), X_REDIRECT_URI (default
 *                   http://localhost:8087/callback).
 *   OAuth 1.0a:     X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET.
 *   X_HANDLE (the @handle, for permalinks/public URL) is an optional env override.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand } from '../lib/mode.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
import { oauth1Header } from '../lib/x-oauth1.mjs';
import { envPath } from '../lib/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The .env lives in the ACTIVE client subtree, resolved by the shared envPath()
// (lib/util.mjs -> activeRoot()): when the app spawns us it sets PENDPOST_ROOT to
// that client root; a bare CLI run resolves the active client from data/clients.json.
// Either way we read/write the SAME file the app reads - no orphan repo-root .env.
const ENV_PATH = envPath();

const API = 'https://api.twitter.com/2';
const UPLOAD = 'https://api.twitter.com/2/media/upload';
const UPLOAD_V11 = 'https://upload.twitter.com/1.1/media/upload.json';
// v1.1 account endpoints for profile editing (same OAuth 1.0a context as posting;
// no v2 equivalent exists). update_profile takes signed query params;
// update_profile_image/_banner take a multipart binary (field excluded from the signature).
const ACCOUNT_V11 = 'https://api.twitter.com/1.1/account';
const AUTH_URL = 'https://twitter.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.twitter.com/2/oauth2/token';
// media.write is required for the v2 chunked media upload used by video posts.
const SCOPES = 'tweet.read tweet.write users.read media.write offline.access';
const DEFAULT_PORT = 8087;
const DEFAULT_REDIRECT = 'http://localhost:8087/callback';
const TWEET_LIMIT = 280;
// Refresh when the access token expires within this window (it lasts ~2h).
const REFRESH_BUFFER_MS = 10 * 60 * 1000;
// Per-part chunk for the chunked media upload (X caps a part at 5 MB).
const CHUNK_BYTES = 4 * 1024 * 1024;

// redirect uri is a constant overridable by env (mirrors yt-social hardcoding its redirect).
const redirectUri = () => readEnv('X_REDIRECT_URI') || DEFAULT_REDIRECT;

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
    // function replacer: token values may contain '$' which is special in a string replacement.
    if (new RegExp(`^${k}=`, 'm').test(raw)) {
      raw = raw.replace(new RegExp(`^${k}=.*$`, 'm'), () => `${k}=${v}`);
    } else {
      raw += `${raw.endsWith('\n') || raw === '' ? '' : '\n'}${k}=${v}\n`;
    }
  }
  // Atomic + 0600: a crash mid-write must never truncate the secret-bearing .env.
  const tmp = `${ENV_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, raw, { mode: 0o600 });
  fs.renameSync(tmp, ENV_PATH);
}

function requireEnv(name) {
  const v = readEnv(name);
  if (!v) {
    console.error(`[err] ${name} missing in .env - run 'node scripts/x-social.mjs auth' first.`);
    process.exit(1);
  }
  return v;
}

function tokenTail(t) {
  return t ? `...${t.slice(-6)} (length ${t.length})` : '(none)';
}

// X is a confidential client (it has a client secret), so token-endpoint calls
// authenticate with HTTP Basic client_id:client_secret.
function basicAuthHeader() {
  const id = requireEnv('X_CLIENT_ID');
  const secret = requireEnv('X_CLIENT_SECRET');
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
}

// ---------- OAuth 1.0a (HMAC-SHA1) user-context signing ----------
//
// The RECOMMENDED zero-browser auth path: a portal-generated API key/secret +
// Access Token/Secret needs NO browser redirect, and POST /2/tweets + the v1.1
// chunked media upload both accept OAuth 1.0a User Context. Active whenever
// X_ACCESS_TOKEN_SECRET is set (the discriminator OAuth-2 never has). The signing
// math lives in lib/x-oauth1.mjs (verified offline against X's documented example
// in test/x-oauth1-signing.test.mjs).

const OAUTH1_TOKEN = '__oauth1__';

function oauth1Creds() {
  const consumerKey = readEnv('X_API_KEY');
  const consumerSecret = readEnv('X_API_SECRET');
  const token = readEnv('X_ACCESS_TOKEN');
  const tokenSecret = readEnv('X_ACCESS_TOKEN_SECRET');
  if (consumerKey && consumerSecret && token && tokenSecret) return { consumerKey, consumerSecret, token, tokenSecret };
  return null;
}

// ---------- oauth 2.0 + PKCE / token freshness ----------

async function tokenExchange(params, { auth } = {}) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(auth ? { Authorization: auth } : {}),
    },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`OAuth ${params.grant_type}: HTTP ${res.status} ${data.error || ''} - ${data.error_description || JSON.stringify(data)}`);
  }
  return data;
}

// X ROTATES the refresh token on every refresh, so we ALWAYS persist the new one
// when present - losing it bricks the next run.
function persistTokens(data) {
  const vars = {
    X_ACCESS_TOKEN: data.access_token,
    X_TOKEN_EXPIRES_AT: String(Date.now() + (Number(data.expires_in) || 0) * 1000),
  };
  if (data.refresh_token) vars.X_REFRESH_TOKEN = data.refresh_token;
  writeEnv(vars);
  return vars;
}

// Returns a valid access token, refreshing (and persisting the rotated refresh
// token) if the current one expires within REFRESH_BUFFER_MS. Throws (never
// process.exit) so main().catch can emit the --json failure envelope and the
// probe path can catch.
async function ensureFreshToken({ force = false } = {}) {
  // OAuth 1.0a mode: portal tokens are long-lived (no expiry/refresh). Return a
  // sentinel so callers stay uniform; api()/uploadCommand sign with oauth1Creds().
  if (oauth1Creds()) return OAUTH1_TOKEN;
  const token = readEnv('X_ACCESS_TOKEN');
  const expiresAt = Number(readEnv('X_TOKEN_EXPIRES_AT') || 0);
  if (!token && !readEnv('X_REFRESH_TOKEN')) {
    throw new Error("No X_ACCESS_TOKEN/X_REFRESH_TOKEN - run 'node scripts/x-social.mjs auth' first.");
  }
  if (token && !force && expiresAt - Date.now() > REFRESH_BUFFER_MS) return token;

  const refreshToken = readEnv('X_REFRESH_TOKEN');
  if (!refreshToken) {
    if (token && !force && expiresAt > Date.now()) return token;
    throw new Error("X access token expired and no refresh token is stored - re-run 'node scripts/x-social.mjs auth'.");
  }

  console.log('[info] Refreshing X access token...');
  let data;
  try {
    data = await tokenExchange(
      { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: requireEnv('X_CLIENT_ID') },
      { auth: basicAuthHeader() },
    );
  } catch (err) {
    throw new Error(`X token refresh failed (${err.message}). The refresh token likely expired or was rotated out - re-run 'node scripts/x-social.mjs auth'.`);
  }
  const vars = persistTokens(data);
  console.log(`[ok] Token refreshed ${tokenTail(data.access_token)}, expires ${new Date(Number(vars.X_TOKEN_EXPIRES_AT)).toLocaleString('en-US')}.`);
  return data.access_token;
}

// ---------- v2 REST helper (JSON) ----------

async function api(method, pathname, { query, body, token } = {}) {
  // pathname is a v2-relative path (e.g. /tweets) OR an absolute https URL (the
  // v1.1 account/* profile endpoints, which have no v2 equivalent).
  const url = new URL(/^https?:\/\//.test(pathname) ? pathname : `${API}${pathname}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const o1 = oauth1Creds();
  // OAuth 1.0a signs query params (JSON body is not signed); OAuth 2.0 sends Bearer.
  const headers = {
    Authorization: o1 ? oauth1Header(method, `${url.origin}${url.pathname}`, query || {}, o1) : `Bearer ${token}`,
  };
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const detail = data.detail || data.title || (data.errors && data.errors[0]?.message) || text || '';
    // Attach the HTTP status + v1.1 error code so callers (e.g. the profile
    // access-tier probe) can distinguish tier/permission (403 + 453/87/220) from
    // auth (401 + 32/89) without re-parsing the message string.
    const err = new Error(`X ${method} ${pathname}: HTTP ${res.status} - ${detail}`);
    err.status = res.status;
    err.xCode = (data.errors && data.errors[0]?.code) ?? null;
    throw err;
  }
  return data;
}

// ---------- chunked media upload (straight from local disk, HD byte-for-byte) ----------
//
// OAuth 2.0 routes to the v2 endpoint (api.twitter.com/2/media/upload); OAuth 1.0a
// routes to the legacy v1.1 endpoint (upload.twitter.com/1.1/media/upload.json),
// which accepts OAuth 1.0a. The id field is read defensively (data.id ||
// media_id_string || id) and the FINALIZE/STATUS processing_info contract is handled below.

function mediaCategoryFor(localPath) {
  if (/\.(mp4|mov|m4v)$/i.test(localPath)) return { category: 'tweet_video', mime: 'video/mp4' };
  if (/\.gif$/i.test(localPath)) return { category: 'tweet_gif', mime: 'image/gif' };
  if (/\.png$/i.test(localPath)) return { category: 'tweet_image', mime: 'image/png' };
  return { category: 'tweet_image', mime: 'image/jpeg' };
}

function readMediaId(data) {
  return data?.data?.id || data?.media_id_string || data?.id || null;
}

async function uploadCommand(form, token, endpointOverride = null) {
  const o1 = oauth1Creds();
  // OAuth 1.0a routes media to the v1.1 chunked endpoint (which accepts it); the
  // multipart body is NOT part of the OAuth 1.0a signature, so no params are signed.
  // endpointOverride points at another multipart v1.1 endpoint (profile image/banner),
  // which sign identically (only the oauth_* set enters the signature base string).
  const endpoint = endpointOverride || (o1 ? UPLOAD_V11 : UPLOAD);
  const headers = { Authorization: o1 ? oauth1Header('POST', endpoint, {}, o1) : `Bearer ${token}` };
  const res = await fetch(endpoint, { method: 'POST', headers, body: form });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const detail = data.detail || data.title || (data.errors && data.errors[0]?.message) || text || '';
    throw new Error(`X media upload: HTTP ${res.status} - ${detail}`);
  }
  return data;
}

async function uploadMedia(localPath, token) {
  const buf = fs.readFileSync(localPath);
  const totalBytes = buf.length;
  const { category, mime } = mediaCategoryFor(localPath);
  console.log(`[info]   media INIT (${category}, ${(totalBytes / 1e6).toFixed(1)} MB)...`);

  // INIT
  const initForm = new FormData();
  initForm.append('command', 'INIT');
  initForm.append('total_bytes', String(totalBytes));
  initForm.append('media_type', mime);
  initForm.append('media_category', category);
  const init = await uploadCommand(initForm, token);
  const mediaId = readMediaId(init);
  if (!mediaId) throw new Error(`media INIT returned no media id: ${JSON.stringify(init).slice(0, 200)}`);

  // APPEND (chunked)
  const parts = Math.ceil(totalBytes / CHUNK_BYTES) || 1;
  for (let i = 0; i < parts; i++) {
    const slice = buf.subarray(i * CHUNK_BYTES, Math.min((i + 1) * CHUNK_BYTES, totalBytes));
    const form = new FormData();
    form.append('command', 'APPEND');
    form.append('media_id', String(mediaId));
    form.append('segment_index', String(i));
    form.append('media', new Blob([slice]));
    await uploadCommand(form, token);
    console.log(`[info]   part ${i + 1}/${parts} uploaded (${(slice.length / 1e6).toFixed(1)} MB).`);
  }

  // FINALIZE
  const finForm = new FormData();
  finForm.append('command', 'FINALIZE');
  finForm.append('media_id', String(mediaId));
  const fin = await uploadCommand(finForm, token);
  const proc = fin?.data?.processing_info || fin?.processing_info;
  if (proc && proc.state && proc.state !== 'succeeded') {
    await pollMediaStatus(mediaId, token, proc.check_after_secs || 5);
  }
  console.log(`[ok]   media ready (${mediaId}).`);
  return mediaId;
}

async function pollMediaStatus(mediaId, token, firstWaitSecs, timeoutMs = 5 * 60 * 1000) {
  const start = Date.now();
  let wait = firstWaitSecs;
  const o1 = oauth1Creds();
  const statusBase = o1 ? UPLOAD_V11 : UPLOAD;
  for (;;) {
    await new Promise((r) => setTimeout(r, Math.max(1, wait) * 1000));
    const statusUrl = `${statusBase}?command=STATUS&media_id=${encodeURIComponent(mediaId)}`;
    // For OAuth 1.0a the GET query params (command, media_id) MUST enter the signature.
    const headers = {
      Authorization: o1
        ? oauth1Header('GET', statusBase, { command: 'STATUS', media_id: String(mediaId) }, o1)
        : `Bearer ${token}`,
    };
    const res = await fetch(statusUrl, { headers });
    const data = await res.json().catch(() => ({}));
    const proc = data?.data?.processing_info || data?.processing_info || {};
    if (proc.state === 'succeeded') return;
    if (proc.state === 'failed') throw new Error(`media processing failed: ${proc.error?.message || 'unknown'}`);
    if (Date.now() - start > timeoutMs) throw new Error(`media ${mediaId} not ready after ${timeoutMs / 1000}s (state: ${proc.state || '?'}).`);
    wait = proc.check_after_secs || 5;
  }
}

// ---------- tweet creation ----------

async function createTweet(text, mediaId, token) {
  const body = { text };
  if (mediaId) body.media = { media_ids: [String(mediaId)] };
  const data = await api('POST', '/tweets', { body, token });
  const id = data?.data?.id;
  if (!id) throw new Error(`create tweet returned no id: ${JSON.stringify(data).slice(0, 200)}`);
  return id;
}

// ---------- plan helpers (same shape as the sibling engines) ----------

function loadPlan(planPath) {
  const abs = path.resolve(planPath);
  return { abs, plan: JSON.parse(fs.readFileSync(abs, 'utf8')) };
}

// Engine-owned fields; everything else (caption, xCaption, schedule, approval,
// cover) belongs to the owner/pendpost and must survive concurrent edits.
const ENGINE_OWNED_FIELDS = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'xPostId', 'status', 'postedAt', 'attempts'];

// mkdir lockfile next to the plan: retry 5x200ms, steal when stale (>15 min).
async function withPlanLock(abs, fn) {
  const lockDir = `${abs}.lock.d`;
  for (let i = 0; ; i++) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let ageMs = 0;
      try { ageMs = Date.now() - fs.statSync(lockDir).mtimeMs; } catch { continue; }
      if (ageMs > 15 * 60 * 1000) {
        try { fs.rmdirSync(lockDir); } catch { /* racing steal */ }
        continue;
      }
      if (i >= 5) throw new Error(`plan lock busy: ${lockDir}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    return fn();
  } finally {
    try { fs.rmdirSync(lockDir); } catch { /* already released */ }
  }
}

// Atomic field-merge save: under the lock, re-read the CURRENT file and copy
// only engine-owned fields of the touched posts onto it - a concurrent pendpost
// caption/cover edit is never lost. tmp+rename = no partial writes.
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
          for (const f of ENGINE_OWNED_FIELDS) {
            if (mem[f] !== undefined) target[f] = mem[f];
          }
        }
        out = disk;
      } catch { /* unreadable disk copy - fall back to the in-memory plan */ }
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

// Machine-readable run envelope for --json mode (consumed by the scheduler).
const RUN = { results: [] };
let JSON_MODE = false;
let ACTOR = 'cli';

function resolveMediaPath(plan, post) {
  // Relative paths anchor at the workspace root (PENDPOST_ROOT), NOT process.cwd():
  // the lib spawns engines with cwd=repo root + PENDPOST_ROOT=activeRoot(), so a
  // multi-client tenant's data/media/<f> must resolve under its own subtree.
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

const isX = (post) => (post.platforms || []).includes('x');
const isTextPost = (post) => post.type === 'text';
// Tweet text: the per-platform xCaption override (capped 280) falls back to the
// shared caption - same additive pattern LinkedIn uses for liDescription.
const tweetText = (post) => (post.xCaption || post.caption || '').trim();

// ---------- commands ----------

async function cmdAuth(args) {
  console.log(`[info] Connecting X - credentials will be written to ${ENV_PATH}`);
  const clientId = args['client-id'] || readEnv('X_CLIENT_ID');
  const clientSecret = args['client-secret'] || readEnv('X_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    console.error('[err] Need --client-id and --client-secret (X developer app -> Keys and tokens -> OAuth 2.0 Client ID and Secret) on first run, or set X_CLIENT_ID / X_CLIENT_SECRET in .env. (Tip: OAuth 1.0a needs no browser - set X_API_KEY/X_API_SECRET/X_ACCESS_TOKEN/X_ACCESS_TOKEN_SECRET in .env instead and skip this ceremony.)');
    process.exit(2);
  }
  writeEnv({ X_CLIENT_ID: clientId, X_CLIENT_SECRET: clientSecret });

  const port = Number(args.port || DEFAULT_PORT);
  const redirect = `http://localhost:${port}/callback`;
  const state = crypto.randomUUID();
  // PKCE: a high-entropy verifier and its S256 challenge.
  const codeVerifier = crypto.randomBytes(48).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const authUrl = `${AUTH_URL}?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString()}`;

  console.log(`\n[action] Confirm ${redirect} is a Callback URI in the X app (User authentication settings, OAuth 2.0, Web App / Confidential client), then approve the consent screen.`);
  console.log('[action] Opening the consent screen. If it does not open, paste this URL into your browser:\n');
  console.log(`  ${authUrl}\n`);

  await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, redirect);
      if (u.pathname !== '/callback') { res.writeHead(404); res.end('not found'); return; }
      const error = u.searchParams.get('error');
      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h2>Authorization denied: ${error}</h2><p>${u.searchParams.get('error_description') || ''}</p>`);
        server.close();
        reject(new Error(`Authorization denied: ${error} - ${u.searchParams.get('error_description') || ''}`));
        return;
      }
      const code = u.searchParams.get('code');
      if (!code) { res.writeHead(400); res.end('missing code'); return; }
      if (u.searchParams.get('state') !== state) {
        res.writeHead(400); res.end('state mismatch');
        server.close();
        reject(new Error('OAuth state mismatch - possible CSRF; aborted.'));
        return;
      }
      try {
        const data = await tokenExchange(
          { grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: codeVerifier, client_id: clientId },
          { auth: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
        );
        const vars = persistTokens(data);
        // Resolve + store the authed @handle (for permalinks/public URL). Best-effort.
        try {
          const me = await api('GET', '/users/me', { token: data.access_token });
          if (me?.data?.username) writeEnv({ X_HANDLE: me.data.username });
        } catch { /* non-fatal: permalinks fall back to the handle-less i/web form */ }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>pendpost: X connected.</h2><p>You can close this tab and return to the terminal.</p>');
        const exp = new Date(Number(vars.X_TOKEN_EXPIRES_AT)).toLocaleString('en-US');
        console.log(`\n[ok] Access token stored ${tokenTail(data.access_token)}, expires ${exp}.`);
        console.log(`[ok] Refresh token ${data.refresh_token ? 'stored - rotating-refresh enabled (offline.access granted).' : 'NOT issued - offline.access scope is missing; add it and re-auth.'}`);
        console.log(`[ok] Scopes granted: ${data.scope || SCOPES}`);
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
      console.log(`[info] Waiting for the X consent redirect on ${redirect} ...`);
    });
  });
  console.log('[done] auth complete.');
}

async function cmdRefresh() {
  // OAuth 1.0a tokens are long-lived portal credentials - nothing to refresh.
  if (oauth1Creds()) {
    console.log('[info] OAuth 1.0a mode (X_ACCESS_TOKEN_SECRET set) - tokens are long-lived portal credentials; no refresh needed.');
    return;
  }
  const token = await ensureFreshToken({ force: true });
  console.log(`[ok] Access token ${tokenTail(token)}, expires ${new Date(Number(readEnv('X_TOKEN_EXPIRES_AT'))).toLocaleString('en-US')}.`);
}

async function cmdValidate(args) {
  const { plan } = loadPlan(args.plan);
  const token = await ensureFreshToken();
  console.log('================ VALIDATION ONLY - NOTHING WILL BE PUBLISHED ================');
  try {
    const me = await api('GET', '/users/me', { token });
    console.log(`[ok] Token valid - authenticated as @${me?.data?.username || '?'}.`);
  } catch (err) {
    console.log(`[warn] /users/me check failed (${err.message}). Continuing to caption preview.`);
  }
  const targets = (plan.posts || []).filter((p) => isX(p) && (!args.only || p.id === args.only));
  if (!targets.length) { console.log('[warn] No X entries match.'); return; }
  for (const post of targets) {
    console.log(`\n----- ${post.id} -----`);
    const text = tweetText(post);
    const len = text.length;
    const overLimit = len > TWEET_LIMIT;
    console.log(`[preview] type:    ${post.type}`);
    console.log(`[preview] text (${len}/${TWEET_LIMIT}${overLimit ? ' - OVER LIMIT' : ''}):`);
    console.log(text);
    if (!isTextPost(post)) {
      const mediaPath = resolveMediaPath(plan, post);
      if (!mediaPath) console.log(`[warn] media not found (${post.path || post.file}) - a video tweet needs a local render.`);
      else console.log(`[preview] media:   ${path.basename(mediaPath)} (${(fs.statSync(mediaPath).size / 1e6).toFixed(1)} MB)`);
    }
    if (overLimit) console.log(`[warn] ${post.id}: text is ${len} chars - X caps at ${TWEET_LIMIT}. Set a shorter xCaption.`);
  }
  console.log('\n================ VALIDATION COMPLETE - review the text, then approve publishing. ================');
}

async function cmdPublishDue(args) {
  const { abs, plan } = loadPlan(args.plan);
  const token = await ensureFreshToken();
  const now = Date.now();
  let published = 0;

  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isX(post)) continue;
    if (post.executionMode !== 'fully-scheduled') continue;
    if (post.status !== 'planned') continue;
    // Fail-closed approval (SS-01): missing field = draft = never publish.
    if ((post.approval || 'draft') !== 'approved') {
      console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish.`);
      continue;
    }
    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs) || dueMs > now) continue;

    const text = tweetText(post);
    if (!text) { console.log(`[warn] ${post.id}: due but no tweet text (xCaption/caption) - skipping.`); continue; }
    if (text.length > TWEET_LIMIT) { console.log(`[warn] ${post.id}: text is ${text.length} chars (> ${TWEET_LIMIT}) - set a shorter xCaption; skipping.`); continue; }

    const lateMin = Math.round((now - dueMs) / 60000);
    if (lateMin > 15) console.log(`[warn] ${post.id}: publishing ${lateMin} min late (catch-up).`);

    const textPost = isTextPost(post);
    let mediaPath = null;
    if (!textPost) {
      mediaPath = resolveMediaPath(plan, post);
      if (!mediaPath) { console.log(`[warn] ${post.id}: due but local media not found (${post.path || post.file}) - skipping.`); continue; }
    }

    if (args['dry-run']) {
      console.log(textPost
        ? `[dry] ${post.id}: would create a text tweet (${text.length} chars).`
        : `[dry] ${post.id}: would upload ${path.basename(mediaPath)} + create a video tweet.`);
      continue;
    }

    console.log(`[info] ${post.id}: publishing ${textPost ? 'text tweet' : 'video tweet'} to X...`);
    try {
      const mediaId = textPost ? null : await uploadMedia(mediaPath, token);
      const tweetId = await createTweet(text, mediaId, token);

      post.xPostId = tweetId;
      post.status = 'posted';
      post.postedAt = new Date(now).toISOString();
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'x', action: 'publish', ok: true, errorCode: null, errorMessage: null, lateMin, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'x', action: 'publish', ok: true, id: tweetId });
      console.log(`[ok] ${post.id}: published on X (${tweetId}).`);
      published += 1;
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'x', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), lateMin, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'x', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: X publish failed - ${err.message}`);
      continue;
    }
  }
  console.log(`[done] publish-due complete - ${published} tweet(s) published.`);
}

const permalinkFor = (post) => {
  if (!post.xPostId) return null;
  const handle = readEnv('X_HANDLE');
  return handle ? `https://x.com/${handle}/status/${post.xPostId}` : `https://x.com/i/web/status/${post.xPostId}`;
};

async function cmdStatus(args) {
  const { plan } = loadPlan(args.plan);
  const token = await ensureFreshToken();
  console.log('[info] X plan entries (live state fetched when xPostId is present):');
  for (const post of (plan.posts || []).filter(isX)) {
    let live = '';
    if (post.xPostId) {
      try {
        await api('GET', `/tweets/${encodeURIComponent(post.xPostId)}`, { token });
        live = ' live=yes';
      } catch (err) {
        live = ` live=NOT FOUND (${err.message.slice(0, 40)})`;
      }
    }
    console.log(`  ${post.id.padEnd(18)} ${String(post.status).padEnd(10)} ${post.scheduledAt}  mode=${post.executionMode}${post.xPostId ? ` x=${post.xPostId}` : ''}${live}`);
  }
}

// Read-only publish VERIFICATION (verify_post / verifySweep). Confirms the tweet
// is live. Emits the normalized { live, state, permalink } row lib/verify.mjs
// parses. Writes NOTHING.
async function cmdVerify(args) {
  const { plan } = loadPlan(args.plan);
  const token = await ensureFreshToken();
  for (const post of (plan.posts || []).filter(isX)) {
    if (args.only && post.id !== args.only) continue;
    if (!post.xPostId) continue;
    try {
      const data = await api('GET', `/tweets/${encodeURIComponent(post.xPostId)}`, { token });
      const live = Boolean(data?.data?.id);
      RUN.results.push({ postId: post.id, platform: 'x', action: 'verify', ok: true, live, state: live ? 'published' : 'unknown', permalink: live ? permalinkFor(post) : null, id: post.xPostId });
    } catch (err) {
      const missing = /404|not found|no .*found/i.test(err.message || '');
      RUN.results.push({ postId: post.id, platform: 'x', action: 'verify', ok: true, live: false, state: missing ? 'missing' : 'unknown', permalink: null, id: post.xPostId, errorMessage: String(err.message).slice(0, 200) });
    }
  }
}

// Read-only metrics fetch: public_metrics per published tweet. Writes NOTHING.
async function cmdInsights(args) {
  const { plan } = loadPlan(args.plan);
  const token = await ensureFreshToken();
  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isX(post) || !post.xPostId) continue;
    try {
      const data = await api('GET', `/tweets/${encodeURIComponent(post.xPostId)}`, { token, query: { 'tweet.fields': 'public_metrics' } });
      const m = data?.data?.public_metrics;
      if (!m) throw new Error('no public_metrics in response');
      const metrics = {
        impressions: m.impression_count ?? null,
        likes: m.like_count ?? null,
        comments: m.reply_count ?? null,
        shares: (m.retweet_count ?? 0) + (m.quote_count ?? 0),
        bookmarks: m.bookmark_count ?? null,
      };
      RUN.results.push({ postId: post.id, platform: 'x', action: 'insights', ok: true, id: post.xPostId, metrics });
      console.log(`[ok] ${post.id}: X ${JSON.stringify(metrics)}`);
    } catch (err) {
      RUN.results.push({ postId: post.id, platform: 'x', action: 'insights', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.log(`[warn] ${post.id}: X insights failed - ${err.message}`);
    }
  }
  console.log(`[done] insights complete - ${RUN.results.filter((r) => r.ok).length} fetched.`);
}

async function cmdDelete(args) {
  if (!args.id) { console.error('[err] delete requires --id <tweetId>'); process.exit(2); }
  const token = await ensureFreshToken();
  await api('DELETE', `/tweets/${encodeURIComponent(args.id)}`, { token });
  RUN.results.push({ platform: 'x', action: 'delete', ok: true, id: args.id });
  console.log(`[ok] deleted tweet ${args.id}.`);
}

// Read-only liveness probe for the health bar (GET /2/users/me). Refreshes the
// token (and persists the rotated refresh token) like the publish path; throws
// are caught here so it never process.exits. Takes no --plan.
async function cmdProbe() {
  const o1 = oauth1Creds();
  if (!o1 && (!readEnv('X_CLIENT_ID') || !readEnv('X_CLIENT_SECRET'))) {
    RUN.results.push({ platform: 'x', action: 'probe', ok: false, detail: 'not configured (client credentials missing)' });
    return;
  }
  if (!o1 && !readEnv('X_REFRESH_TOKEN') && !readEnv('X_ACCESS_TOKEN')) {
    RUN.results.push({ platform: 'x', action: 'probe', ok: false, detail: 'not connected (no token)' });
    return;
  }
  try {
    const token = await ensureFreshToken();
    const me = await api('GET', '/users/me', { token });
    const expiresAt = Number(readEnv('X_TOKEN_EXPIRES_AT') || 0) || null;
    RUN.results.push({ platform: 'x', action: 'probe', ok: true, detail: `connected as @${me?.data?.username || '?'}`, tokenExpiresAt: expiresAt });
  } catch (err) {
    RUN.results.push({ platform: 'x', action: 'probe', ok: false, detail: String(err.message || err).slice(0, 200) });
  }
}

// ---------- profile editing (v1.1 account/*, OAuth 1.0a only) ----------
//
// The same OAuth 1.0a User Context that posts can also EDIT the connected profile
// via X's legacy v1.1 account endpoints (there is no v2 equivalent). update_profile
// takes signed query params; update_profile_image/_banner take a multipart binary
// (the image/banner field is NOT signed, exactly like the chunked media upload).
// These endpoints are access-tier gated on some apps (Elevated/paid) - `profile
// --probe` reports that WITHOUT mutating anything (a no-op update_profile call).

const PROFILE_MAX = { name: 50, description: 160, location: 30 };

// Read-only identity check: who does this credential actually authenticate as?
// Returns the live screen_name (handle, no @). v1.1 returns the user object directly.
async function verifyCredentials() {
  const data = await api('GET', `${ACCOUNT_V11}/verify_credentials.json`, { query: { skip_status: 'true', include_entities: 'false' } });
  return { screenName: data?.screen_name || null, raw: data };
}

// The wrong-account guard: refuse to mutate unless the LIVE account matches the
// X_HANDLE this client's .env expects. The active client can flip (desktop app) and
// creds are PENDPOST_ROOT-scoped, so this proves we are editing the intended account
// and never a sibling client's (e.g. acme). Throws on mismatch / unset handle.
async function assertSelf() {
  const expected = (readEnv('X_HANDLE') || '').replace(/^@/, '').trim().toLowerCase();
  if (!expected) throw new Error('X_HANDLE is not set in .env - refusing to edit a profile I cannot identify (set X_HANDLE to the expected @handle).');
  const { screenName } = await verifyCredentials();
  const actual = (screenName || '').replace(/^@/, '').trim().toLowerCase();
  if (!actual) throw new Error('could not read the authenticated screen_name from verify_credentials - aborting before any profile edit.');
  if (actual !== expected) throw new Error(`refusing to edit profile: authenticated as @${actual} but .env expects @${expected} (X_HANDLE) - wrong account, aborted.`);
  return screenName;
}

async function updateProfileFields({ name, bio, url, location }) {
  const query = { skip_status: 'true', include_entities: 'false' };
  if (name != null) query.name = name;
  if (bio != null) query.description = bio;
  if (url != null) query.url = url;
  if (location != null) query.location = location;
  return api('POST', `${ACCOUNT_V11}/update_profile.json`, { query });
}

async function updateProfileImage(localPath) {
  const form = new FormData();
  form.append('image', new Blob([fs.readFileSync(localPath)]));
  return uploadCommand(form, null, `${ACCOUNT_V11}/update_profile_image.json`);
}

async function updateProfileBanner(localPath) {
  const form = new FormData();
  form.append('banner', new Blob([fs.readFileSync(localPath)]));
  // Banner returns an empty 200/201 body on success - uploadCommand's parse tolerates that.
  return uploadCommand(form, null, `${ACCOUNT_V11}/update_profile_banner.json`);
}

function tierFor(status) {
  return status === 403 ? 'blocked' : status === 401 ? 'auth_error' : status === 429 ? 'rate_limited' : 'error';
}

async function cmdProfile(args) {
  if (!oauth1Creds()) {
    throw new Error('X profile editing needs OAuth 1.0a (set X_API_KEY/X_API_SECRET/X_ACCESS_TOKEN/X_ACCESS_TOKEN_SECRET in .env). The v1.1 account endpoints have no OAuth 2.0 path.');
  }

  // --probe: the STEP 0 access-tier gate. Non-mutating: verify_credentials (read) +
  // a no-op update_profile (no fields = no change) that proves the WRITE tier.
  if (args.probe) {
    const expected = (readEnv('X_HANDLE') || '').replace(/^@/, '') || null;
    let screenName = null;
    try {
      screenName = (await verifyCredentials()).screenName;
    } catch (err) {
      const tier = tierFor(err.status);
      RUN.results.push({ platform: 'x', action: 'profile-probe', ok: false, tier, code: err.xCode ?? null, detail: err.message.slice(0, 300) });
      console.error(`[probe] verify_credentials failed (${tier}, code ${err.xCode ?? '?'}): ${err.message}`);
      return;
    }
    try {
      await updateProfileFields({}); // no fields -> no-op; proves the account-write tier
      const handleMatches = expected ? expected.toLowerCase() === String(screenName).toLowerCase() : null;
      RUN.results.push({ platform: 'x', action: 'profile-probe', ok: true, tier: 'permitted', screenName, expectedHandle: expected, handleMatches, detail: `v1.1 account write tier permitted; authenticated as @${screenName}` });
      console.error(`[probe] OK - v1.1 account write tier permitted; authenticated as @${screenName}${expected ? ` (expected @${expected}${handleMatches ? '' : ' - MISMATCH'})` : ''}.`);
    } catch (err) {
      const tier = tierFor(err.status);
      RUN.results.push({ platform: 'x', action: 'profile-probe', ok: false, tier, code: err.xCode ?? null, screenName, detail: err.message.slice(0, 300) });
      console.error(`[probe] account write ${tier} (code ${err.xCode ?? '?'}): ${err.message}`);
    }
    return;
  }

  const name = typeof args.name === 'string' ? args.name : null;
  const bio = typeof args.bio === 'string' ? args.bio : null;
  const url = typeof args.url === 'string' ? args.url : null;
  const location = typeof args.location === 'string' ? args.location : null;
  const image = typeof args.image === 'string' ? args.image : null;
  const banner = typeof args.banner === 'string' ? args.banner : null;
  if (name == null && bio == null && url == null && location == null && !image && !banner) {
    throw new Error('nothing to update - pass at least one of --name --bio --url --location --image --banner (or --probe).');
  }
  if (name != null && (!name.trim() || name.length > PROFILE_MAX.name)) throw new Error(`--name must be 1..${PROFILE_MAX.name} chars (got ${name.length}).`);
  if (bio != null && bio.length > PROFILE_MAX.description) throw new Error(`--bio is ${bio.length} chars - X caps the bio at ${PROFILE_MAX.description}.`);
  if (location != null && location.length > PROFILE_MAX.location) throw new Error(`--location is ${location.length} chars - X caps at ${PROFILE_MAX.location}.`);
  for (const [flag, p] of [['--image', image], ['--banner', banner]]) {
    if (!p) continue;
    if (!fs.existsSync(p)) throw new Error(`${flag} file not found: ${p}`);
    if (mediaCategoryFor(p).category === 'tweet_video') throw new Error(`${flag} must be an image (png/jpg/gif), not a video: ${p}`);
  }

  // Wrong-account guard (shared verify_credentials): never edit a sibling client's account.
  const screenName = await assertSelf();

  if (args['dry-run']) {
    const changes = [];
    if (name != null) changes.push(`name="${name}"`);
    if (bio != null) changes.push(`bio(${bio.length})`);
    if (url != null) changes.push(`url="${url}"`);
    if (location != null) changes.push(`location="${location}"`);
    if (image) changes.push(`image=${path.basename(image)}`);
    if (banner) changes.push(`banner=${path.basename(banner)}`);
    console.error(`[dry] @${screenName}: would update ${changes.join(', ')}.`);
    RUN.results.push({ platform: 'x', action: 'profile-dry-run', ok: true, screenName, changes });
    return;
  }

  // Apply in order: fields -> image -> banner. Independent, non-atomic calls; record
  // each and continue on a sub-failure so partial success is reported honestly.
  const run = async (action, fn, okMsg) => {
    try {
      await fn();
      RUN.results.push({ platform: 'x', action, ok: true, screenName });
      console.error(`[ok] @${screenName}: ${okMsg}.`);
    } catch (err) {
      RUN.results.push({ platform: 'x', action, ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${action} failed - ${err.message}`);
    }
  };
  if (name != null || bio != null || url != null || location != null) {
    await run('profile-update', () => updateProfileFields({ name, bio, url, location }), 'profile fields updated');
  }
  if (image) await run('profile-image', () => updateProfileImage(image), 'profile image updated');
  if (banner) await run('profile-banner', () => updateProfileBanner(banner), 'profile banner updated');
  const rows = RUN.results.filter((r) => typeof r.action === 'string' && r.action.startsWith('profile-'));
  console.error(`[done] profile update - ${rows.filter((r) => r.ok).length} ok, ${rows.filter((r) => r.ok === false).length} failed.`);
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
    } else {
      args._.push(a);
    }
  }
  return args;
}

const COMMANDS = {
  auth: cmdAuth,
  refresh: cmdRefresh,
  validate: cmdValidate,
  'publish-due': cmdPublishDue,
  status: cmdStatus,
  verify: cmdVerify,
  insights: cmdInsights,
  delete: cmdDelete,
  probe: cmdProbe,
  profile: cmdProfile,
};

async function main() {
  const args = parseArgs(process.argv);
  // --json: human logs move to stderr; stdout carries exactly one JSON line
  // (the run envelope) for the scheduler. --actor tags attempts[].
  JSON_MODE = Boolean(args.json);
  ACTOR = typeof args.actor === 'string' ? args.actor : 'cli';
  if (JSON_MODE) console.log = (...a) => console.error(...a);
  const commandName = args._[0];
  // Mock mode: publish/read commands never touch X - delegate to the shared mock
  // driver. Credential commands (auth/refresh) still run for real.
  if (resolveMode('x') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'x', command: commandName,
      planPath: typeof args.plan === 'string' ? path.resolve(String(args.plan)) : null,
      only: typeof args.only === 'string' ? args.only : null,
    });
    if (JSON_MODE) process.stdout.write(`${JSON.stringify(envelope)}\n`);
    else console.error(`[mock] x ${commandName}: ${envelope.results.length} result(s)`);
    return;
  }
  const cmd = COMMANDS[commandName];
  if (!cmd) {
    console.error(`Usage: node scripts/x-social.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
    process.exit(2);
  }
  if (['validate', 'publish-due', 'status', 'verify', 'insights'].includes(args._[0]) && !args.plan) {
    console.error(`[err] ${args._[0]} requires --plan <post-plan.json>`);
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
