#!/usr/bin/env node
/**
 * pinterest-social.mjs - direct Pinterest pin creation via the Pinterest API v5.
 *
 * Sibling of scripts/yt-social.mjs / x-social.mjs / telegram-social.mjs: the same
 * zero-dep, plan-driven, publish-straight-from-the-plan pattern, with Pinterest's
 * own OAuth2 authorization-code auth model.
 *
 * Pinterest has NO scheduling API in the public v5 surface - entries publish at
 * their due time by re-running `publish-due` (driven by the scheduler tick),
 * exactly like Telegram / X / Instagram. There is no native `schedule` command.
 *
 * AUTH - OAuth2 authorization-code with rotating refresh tokens (mirrors yt-social's
 * loopback ceremony + x-social's expiry tracking):
 *   PINTEREST_APP_ID            the app id from the Pinterest developer portal.
 *   PINTEREST_APP_SECRET        the app secret (used for HTTP Basic on the token URL).
 *   PINTEREST_ACCESS_TOKEN      minted at consent, short-lived (~1h), auto-refreshed.
 *   PINTEREST_REFRESH_TOKEN     durable token used to mint fresh access tokens.
 *   PINTEREST_TOKEN_EXPIRES_AT  epoch ms - when the access token expires.
 *   PINTEREST_BOARD_ID          the destination board IDENTIFIER (where pins land).
 *   PINTEREST_AD_ACCOUNT_ID     the ads advertiser id (needed only for `demographics` - business + ads onboarding).
 * `auth`/`connect` runs a loopback http server on 127.0.0.1:8088, opens the
 * consent screen, captures ?code, exchanges it (Basic auth app_id:secret) and
 * persists the tokens + expiry to the active client's gitignored .env.
 *
 * Pin media is supplied EITHER by a PUBLIC IMAGE URL (post.imageUrl, the image-pin
 * path: media_source.source_type=image_url) OR, for a `type=video` post carrying a
 * local video render (post.path/file), by a native Pinterest VIDEO PIN (spec 17):
 * register -> upload the bytes to the returned S3 url -> poll until processed ->
 * create the pin with source_type=video_id, still requiring a public imageUrl as
 * the REQUIRED cover_image_url (no cover, no video pin - never a silent image
 * fallback). A local-only render with no public URL, on a non-video post, is
 * SKIPPED with a clear [warn] - the image-pin path does not host media. Title/
 * description come from post.pinTitle / post.pinDescription (falling back to
 * post.title / post.caption), the additive per-platform override pattern x uses
 * for xCaption and telegram for tgCaption. post.pinBoardSection (spec 17), when
 * set, targets a specific board section on EITHER pin path.
 *
 * HONESTY - Pinterest "Standard access": a freshly-created Pinterest app starts on
 * TRIAL access, where pins created via the API are CREATOR-ONLY (visible only to
 * the authenticating account, not public, not in search/feeds). PUBLIC pins require
 * the app to pass Pinterest's per-app "Standard access" review. Until that review
 * passes, publish will succeed (a pin id comes back) but the pin is not publicly
 * visible. This is surfaced in the playbook + beta flag for this lane.
 *
 * Commands:
 *   auth | connect   [--app-id X --app-secret Y]   one-time loopback OAuth ceremony
 *   refresh                                          mint a fresh access token from the refresh token
 *   validate         --plan <p> [--only <id>]        side-effect-free preview, never posts
 *   publish-due      --plan <p> [--only <id>] [--dry-run]   publish any due Pinterest entry
 *   board-sections   [--boardId <id>]                 read-only, live-only board-section list (spec 17)
 *   board-list                                         read-only, mockable board list (id/name/privacy/pinCount) (spec 29)
 *   board-create     --name X [--privacy P] [--description D]   create a board (spec 29)
 *   board-update     --id <boardId> [--name] [--privacy] [--description]   rename/retag a board (spec 29)
 *   board-section-create  --board <boardId> --name X    create a board section (spec 29)
 *   board-section-update  --board <boardId> --section <id> --name X   rename a board section (spec 29)
 *   status           --plan <p>                       list Pinterest plan entries
 *   verify           --plan <p> [--only <id>]         read-only liveness (GET pin)
 *   insights         --plan <p> [--only <id>]         per-pin analytics (best-effort)
 *   demographics     --plan <p>                        account-scoped audience age/gender/region breakdown (needs PINTEREST_AD_ACCOUNT_ID)
 *   probe                                              read-only health probe (GET user_account)
 *   delete           --id <pinId>                      delete a pin (cleanup)
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand } from '../lib/mode.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
import { isCarouselPost, carouselItems, carouselBlocker, carouselBlockRow, carouselUnsupported } from '../lib/carousel.mjs';
import { effectivePublicUrl, effectiveSlideUrl } from '../lib/public-media.mjs';
import { envPath } from '../lib/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The .env lives in the ACTIVE client subtree, resolved by the shared envPath()
// (lib/util.mjs -> activeRoot()): the app sets PENDPOST_ROOT to that client root
// when it spawns us; a bare CLI run resolves the active client from data/clients.json.
const ENV_PATH = envPath();
// The active client's posting config (config.json at the client root) - read
// directly, the meta engine's loadClientConfig idiom: the engine stays lean and
// self-rooting. Feeds the public-media seam (spec 39 §4.0 mirror).
const CONFIG_PATH = process.env.PENDPOST_ROOT ? path.join(process.env.PENDPOST_ROOT, 'config.json') : path.resolve(__dirname, '../config.json');
function loadClientConfig() {
  try { const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); return c && typeof c === 'object' ? c : {}; } catch { return {}; }
}

const AUTH_URL = 'https://www.pinterest.com/oauth/';
const TOKEN_URL = 'https://api.pinterest.com/v5/oauth/token';
const API = 'https://api.pinterest.com/v5';
// Spec 17: media:write is NEW (video register/upload). Existing tokens minted
// before this change predate it - POST /v5/media 403s until the operator
// re-runs `auth`/`connect`; image pins + board-sections keep working on the old
// token (P9). See persistTokens/PINTEREST_TOKEN_SCOPE for how a reconnect's
// granted scope is recorded so Setup can show an honest reconnect affordance.
// Spec 29: boards:write is ALSO new (board/section create+update) - the SAME
// precedent as media:write above. A token minted before this spec lacks it and
// every board-create/board-update/board-section-create/board-section-update
// 403s until the operator reconnects; board-list (boards:read) and the existing
// board-sections read keep working unchanged on the old token (P9).
const SCOPES = 'pins:read,pins:write,boards:read,boards:write,media:write';
const DEFAULT_REDIRECT = 'http://127.0.0.1:8088/oauth/pinterest/callback';

// Pinterest pin caps: a title at 100 chars, a description at 800.
const TITLE_LIMIT = 100;
const DESCRIPTION_LIMIT = 800;

// Refresh when the access token expires within this window (it lasts ~1h).
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// redirect uri is a constant overridable by env (mirrors yt-social's redirectUri).
const redirectUri = () => readEnv('PINTEREST_REDIRECT_URI') || DEFAULT_REDIRECT;

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
    // function replacer: token values may contain '$', which is special in a string replacement.
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
    console.error(`[err] ${name} missing in .env - run 'node scripts/pinterest-social.mjs auth' first.`);
    process.exit(1);
  }
  return v;
}

function tokenTail(t) {
  return t ? `...${t.slice(-6)}, length ${t.length}` : '(none)';
}

const boardId = () => readEnv('PINTEREST_BOARD_ID');

// authenticate with HTTP Basic app_id:app_secret on the token endpoint.
function basicAuthHeader() {
  const id = requireEnv('PINTEREST_APP_ID');
  const secret = requireEnv('PINTEREST_APP_SECRET');
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
}

// ---------- oauth ----------

async function tokenExchange(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(),
    },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const hint = data.error === 'invalid_grant'
      ? " - the refresh token is expired/revoked. Re-run 'node scripts/pinterest-social.mjs auth'."
      : '';
    throw new Error(`OAuth ${params.grant_type}: HTTP ${res.status} ${data.error || ''} - ${data.error_description || data.message || JSON.stringify(data)}${hint}`);
  }
  return data;
}

// Persist a token-endpoint response and return the vars written (so the caller can
// log the new expiry). Pinterest returns access_token (+ expires_in) and, on a
// rotating-refresh response, a fresh refresh_token + refresh_token_expires_in.
function persistTokens(data) {
  const vars = {
    PINTEREST_ACCESS_TOKEN: data.access_token,
    PINTEREST_TOKEN_EXPIRES_AT: String(Date.now() + (Number(data.expires_in) || 0) * 1000),
  };
  if (data.refresh_token) vars.PINTEREST_REFRESH_TOKEN = data.refresh_token;
  // Spec 17 (P9): Pinterest's token response carries the GRANTED scope string when
  // present - persist it so Setup can tell an old (pre-media:write) token apart
  // from a fresh reconnect, without ever needing a live probe. Only written when
  // present (mirrors the refresh_token guard above) - an omitted field on a
  // refresh response leaves the last-known scope untouched rather than blanking it.
  if (data.scope) vars.PINTEREST_TOKEN_SCOPE = data.scope;
  writeEnv(vars);
  return vars;
}

// Return a valid access token, refreshing it (rotating the stored refresh token)
// if the current one expires within REFRESH_BUFFER_MS. Throws (never process.exit)
// so main().catch can emit the --json failure envelope and the probe path can catch.
async function ensureFreshToken({ force = false } = {}) {
  const token = readEnv('PINTEREST_ACCESS_TOKEN');
  const expiresAt = Number(readEnv('PINTEREST_TOKEN_EXPIRES_AT') || 0);
  if (!token && !readEnv('PINTEREST_REFRESH_TOKEN')) {
    // Spec 17 review (MINOR-2): tag a never-connected lane distinctly from an
    // auth/refresh failure below - cmdBoardSections reads .code to tell "no
    // credential at all" (not_configured) apart from "a stored credential failed
    // to refresh" (needs_scope) instead of collapsing both into needs_scope.
    const err = new Error("No PINTEREST_ACCESS_TOKEN/PINTEREST_REFRESH_TOKEN - run 'node scripts/pinterest-social.mjs auth' first.");
    err.code = 'not_configured';
    throw err;
  }
  if (token && !force && expiresAt - Date.now() > REFRESH_BUFFER_MS) return token;

  const refreshToken = readEnv('PINTEREST_REFRESH_TOKEN');
  if (!refreshToken) {
    if (token && !force && expiresAt > Date.now()) return token;
    throw new Error("Pinterest access token expired and no refresh token is stored - re-run 'node scripts/pinterest-social.mjs auth'.");
  }

  console.log('[info] Refreshing Pinterest access token...');
  let data;
  try {
    data = await tokenExchange({ grant_type: 'refresh_token', refresh_token: refreshToken });
  } catch (err) {
    throw new Error(`Pinterest token refresh failed (${err.message}). The refresh token likely expired or was revoked - re-run 'node scripts/pinterest-social.mjs auth'.`);
  }
  const vars = persistTokens(data);
  console.log(`[ok] Token refreshed ${tokenTail(data.access_token)}, expires ${new Date(Number(vars.PINTEREST_TOKEN_EXPIRES_AT)).toLocaleString('en-US')}.`);
  return data.access_token;
}

// ---------- pinterest v5 api helper (json GET/POST/DELETE) ----------

async function api(method, pathname, { query, body, token } = {}) {
  const url = new URL(`${API}${pathname}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Pinterest ${method} ${pathname}: HTTP ${res.status} - ${data.message || data.error_description || text || ''}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Fetch the manageable boards for the connected account (v5 GET /boards, paginated
// via the bookmark cursor). Factored out (spec 22 "build-once") so spec 29's board
// picker reuses the SAME read instead of inlining it - discover (22) and boards (29)
// share ONE list. Returns the raw board list [{ id, name, privacy? }]; propagates the
// api() error (the caller maps a 403 to needs_scope). Capped so a huge account cannot
// spin forever.
async function listBoards(token, { pageSize = 100, max = 250 } = {}) {
  const boards = [];
  let bookmark = null;
  do {
    const query = { page_size: pageSize };
    if (bookmark) query.bookmark = bookmark;
    const data = await api('GET', '/boards', { query, token });
    for (const b of data.items || []) boards.push(b);
    bookmark = data.bookmark || null;
  } while (bookmark && boards.length < max);
  return boards;
}

// List a board's sections (v5 GET /boards/{board_id}/sections, spec 17, Pattern
// P3/P4 read verb). Read-only, LIVE-ONLY (left out of MOCKABLE_COMMANDS, like
// probe/discover's board list) - a failed read must never masquerade as an empty
// section list. Mirrors listBoards' pagination shape; returns { id, name }[].
async function listBoardSections(token, boardId, { pageSize = 100, max = 250 } = {}) {
  const sections = [];
  let bookmark = null;
  do {
    const query = { page_size: pageSize };
    if (bookmark) query.bookmark = bookmark;
    const data = await api('GET', `/boards/${encodeURIComponent(boardId)}/sections`, { query, token });
    for (const s of data.items || []) {
      // Drop a junk/id-less entry (an empty string is a falsy-but-non-null id -
      // String(s.id).trim() catches it, unlike a bare `!= null` check).
      if (s && s.id !== undefined && s.id !== null && String(s.id).trim()) {
        sections.push({ id: String(s.id), name: s.name || String(s.id) });
      }
    }
    bookmark = data.bookmark || null;
  } while (bookmark && sections.length < max);
  return sections;
}

// ---------- spec 17: native video pin upload (Pattern P3) ----------
//
// Resolve a post's local media render to an absolute path, copied from
// reddit-social.mjs leaseAndUpload's sibling resolveMediaPath (node built-ins
// only, §H.4) - this engine has never read local media before spec 17 (image
// pins are public-URL-only), so this is the FIRST local-file read pinterest does.
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

// Poll knobs for the media-processing wait (env-overridable so tests run fast,
// mirrors reddit-social.mjs's REDDIT_MEDIA_POLL_TRIES/DELAY_MS).
function mediaPollTries() { const n = Number(process.env.PINTEREST_MEDIA_POLL_TRIES); return Number.isFinite(n) && n > 0 ? n : 20; }
function mediaPollDelayMs() { const n = Number(process.env.PINTEREST_MEDIA_POLL_DELAY_MS); return Number.isFinite(n) && n >= 0 ? n : 3000; }

// Register + upload + poll a local video render, returning the resulting
// media_id once Pinterest reports it `succeeded`. THREE steps (v5 media-create,
// https://developers.pinterest.com/docs/api/v5/media-create/):
//   1. POST /media {media_type:'video'} -> {media_id, upload_url, upload_parameters}.
//   2. hand-built multipart/form-data POST to upload_url: upload_parameters fields
//      + the file bytes LAST (mirrors reddit's leaseAndUpload S3 POST-policy
//      requirement) - node built-ins only, no new dep. S3 returns 204/200.
//   3. poll GET /media/{media_id} ~3s up to a cap until status:'succeeded'
//      ('failed' -> a media_failed error; exhausting the cap -> media_timeout).
// media_id is TRANSIENT - the caller never persists it (a fresh upload per
// publish attempt, so a stale/expired lease is never reused).
async function uploadPinterestVideo(token, absPath) {
  const reg = await api('POST', '/media', { body: { media_type: 'video' }, token });
  const mediaId = reg?.media_id;
  const uploadUrl = reg?.upload_url;
  const uploadParams = reg?.upload_parameters && typeof reg.upload_parameters === 'object' && !Array.isArray(reg.upload_parameters) ? reg.upload_parameters : {};
  if (!mediaId || !uploadUrl) {
    throw new Error(`media register returned no media_id/upload_url: ${JSON.stringify(reg).slice(0, 200)}`);
  }

  // Spec 17 review (NIT-5): strip quote/CR/LF from the basename before it rides
  // the multipart Content-Disposition header - defensive (local render names
  // only today), but an unescaped `"` or newline in a filename would break the
  // header framing.
  const filename = path.basename(absPath).replace(/["\r\n]/g, '');
  const bytes = fs.readFileSync(absPath);
  const boundary = `----pendpost${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const enc = (s) => Buffer.from(s, 'utf8');
  const parts = [];
  for (const [k, v] of Object.entries(uploadParams)) {
    parts.push(enc(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v ?? ''}\r\n`));
  }
  // The file part is LAST (mirrors the S3 POST-policy requirement reddit's
  // leaseAndUpload documents - the `file` field must follow every policy field).
  parts.push(enc(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: video/mp4\r\n\r\n`));
  parts.push(bytes);
  parts.push(enc(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (!uploadRes.ok) {
    const text = await uploadRes.text().catch(() => '');
    throw new Error(`pinterest media upload failed: HTTP ${uploadRes.status} - ${String(text).slice(0, 200)}`);
  }

  const tries = mediaPollTries();
  for (let i = 0; i < tries; i++) {
    let status;
    try {
      status = await api('GET', `/media/${mediaId}`, { token });
    } catch (err) {
      // Spec 17 review (NIT-4): a POLL-step failure (incl. a 403) is never a
      // scope problem - media:write already succeeded at register, or this poll
      // couldn't have been reached. Strip the HTTP status so the caller's
      // register-only 403->needs_scope classification cannot misfire on it; it
      // falls through to engine_failure like any other poll-step error.
      delete err.status;
      throw err;
    }
    if (status?.status === 'succeeded') return mediaId;
    if (status?.status === 'failed') {
      const err = new Error(`pinterest media processing failed: ${JSON.stringify(status).slice(0, 200)}`);
      err.code = 'media_failed';
      throw err;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, mediaPollDelayMs()));
  }
  const timeoutErr = new Error(`pinterest media processing timed out after ${tries} poll(s) (media_id ${mediaId})`);
  timeoutErr.code = 'media_timeout';
  throw timeoutErr;
}

// ---------- plan helpers (same shape as the sibling engines) ----------
// (lock + field-merge save duplicated verbatim across the engine siblings -
// self-contained per the sibling pattern, no shared lib)

function loadPlan(planPath) {
  const abs = path.resolve(planPath);
  return { abs, plan: JSON.parse(fs.readFileSync(abs, 'utf8')) };
}

// Engine-owned fields; everything else (caption, schedule, approval, cover)
// belongs to the owner/pendpost and must survive concurrent edits.
const ENGINE_OWNED_FIELDS = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'xPostId', 'tgMessageId', 'dcMessageId', 'pinId', 'status', 'postedAt', 'attempts'];

// mkdir lockfile next to the plan: retry 5x200ms, steal when stale (>15 min).
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

export const RUN = { results: [] };
let JSON_MODE = false;
let ACTOR = 'cli';

const isPinterest = (post) => (post.platforms || []).includes('pinterest');
const pinTitle = (post) => (post.pinTitle || post.title || '').trim();
const pinDescription = (post) => (post.pinDescription || post.caption || '').trim();
// Media is supplied by a PUBLIC image url - this engine does not host media.
// Spec 39: the pin's public media URL resolves through the shared seam - the
// manual post.imageUrl wins, else the §4.0 mirror derives base + render path.
const pinImageUrl = (post) => effectivePublicUrl(post, loadClientConfig()) || '';

function permalinkFor(post) {
  return post.pinId ? `https://www.pinterest.com/pin/${post.pinId}/` : null;
}

// ---------- commands ----------

async function cmdAuth(args) {
  console.log(`[info] Connecting Pinterest - credentials will be written to ${ENV_PATH}`);
  const appId = args['app-id'] || readEnv('PINTEREST_APP_ID');
  const appSecret = args['app-secret'] || readEnv('PINTEREST_APP_SECRET');
  if (!appId || !appSecret) {
    console.error('[err] Need --app-id and --app-secret (Pinterest developer portal -> your app) on first run, or set PINTEREST_APP_ID / PINTEREST_APP_SECRET in .env.');
    process.exit(2);
  }
  const redirect = redirectUri();
  writeEnv({ PINTEREST_APP_ID: appId, PINTEREST_APP_SECRET: appSecret, PINTEREST_REDIRECT_URI: redirect });

  const u = new URL(redirect);
  const port = Number(u.port || 80);
  const callbackPath = u.pathname || '/oauth/pinterest/callback';
  const state = crypto.randomUUID();
  const authUrl = `${AUTH_URL}?${new URLSearchParams({
    response_type: 'code',
    client_id: appId,
    redirect_uri: redirect,
    scope: SCOPES,
    state,
  }).toString()}`;

  console.log(`\n[action] Make sure ${redirect} is listed as a Redirect URI for this Pinterest app (developer portal -> your app -> Configure).`);
  console.log('[action] Opening the Pinterest consent screen. Sign in with the account that owns your destination board. If it does not open, paste this URL:\n');
  console.log(`  ${authUrl}\n`);

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
          redirect_uri: redirect,
        });
        if (!data.access_token) {
          throw new Error(`No access_token returned: ${JSON.stringify(data).slice(0, 200)}`);
        }
        const vars = persistTokens(data);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>pendpost: Pinterest connected.</h2><p>You can close this tab and return to the terminal.</p>');
        const exp = new Date(Number(vars.PINTEREST_TOKEN_EXPIRES_AT)).toLocaleString('en-US');
        console.log(`\n[ok] Access token stored ${tokenTail(data.access_token)}, expires ${exp}.`);
        console.log(`[ok] Refresh token ${data.refresh_token ? 'stored - rotating-refresh enabled.' : 'NOT issued - re-auth may be needed when the access token expires.'}`);
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
      console.log(`[info] Waiting for the Pinterest consent redirect on ${redirect} ...`);
    });
  });

  // prove the token works and surface the account.
  try {
    const token = await ensureFreshToken();
    const me = await api('GET', '/user_account', { token });
    console.log(`[ok] Pinterest account: ${me.username || me.business_name || '(unknown)'}.`);
    const bid = boardId();
    if (!bid) console.log('[warn] PINTEREST_BOARD_ID is not set - set it to the destination board id before publishing.');
  } catch (err) {
    console.log(`[warn] Could not fetch the account: ${err.message}`);
  }
  console.log('[note] New Pinterest apps start on TRIAL access - API-created pins are CREATOR-ONLY until the app passes Pinterest "Standard access" review (then pins are public).');
  console.log('[done] auth complete.');
}

async function cmdRefresh() {
  const token = await ensureFreshToken({ force: true });
  RUN.results.push({ platform: 'pinterest', action: 'refresh', ok: true, tokenExpiresAt: Number(readEnv('PINTEREST_TOKEN_EXPIRES_AT') || 0) || null });
  console.log(`[ok] Access token ${tokenTail(token)}, expires ${new Date(Number(readEnv('PINTEREST_TOKEN_EXPIRES_AT'))).toLocaleString('en-US')}.`);
}

async function cmdValidate(args) {
  const { plan } = loadPlan(args.plan);
  console.log('================ VALIDATION ONLY - NOTHING WILL BE PUBLISHED ================');
  try {
    const token = await ensureFreshToken();
    const me = await api('GET', '/user_account', { token });
    console.log(`[ok] Token valid - authenticated as ${me.username || me.business_name || '(unknown)'}.`);
  } catch (err) {
    console.log(`[warn] account check failed (${err.message}). Continuing to content preview.`);
  }
  const bid = boardId();
  if (!bid) console.log('[warn] PINTEREST_BOARD_ID is not set - publish-due would skip every entry.');
  const targets = (plan.posts || []).filter((p) => isPinterest(p) && (!args.only || p.id === args.only));
  if (!targets.length) { console.log('[warn] No Pinterest entries match.'); return; }
  for (const post of targets) {
    const title = pinTitle(post);
    const desc = pinDescription(post);
    const url = pinImageUrl(post);
    console.log(`\n----- ${post.id} -----`);
    console.log(`[preview] title (${title.length}/${TITLE_LIMIT}${title.length > TITLE_LIMIT ? ' - OVER LIMIT' : ''}): ${title}`);
    console.log(`[preview] description (${desc.length}/${DESCRIPTION_LIMIT}${desc.length > DESCRIPTION_LIMIT ? ' - OVER LIMIT' : ''}):`);
    console.log(desc);
    // Spec 17: a type=video post takes the native video-pin sub-flow (a local
    // render uploaded + a REQUIRED public cover) instead of the image-pin path.
    if (post.type === 'video') {
      const mediaPath = resolveMediaPath(plan, post);
      console.log('[preview] kind: video pin (register -> upload -> poll -> create)');
      console.log(`[preview] media: ${mediaPath ? path.basename(mediaPath) : '(MISSING - a video pin needs a local render, post.path/file)'}`);
      if (!url) console.log('[warn] no public cover image url (post.imageUrl) - a video pin REQUIRES one as cover_image_url; this entry would be skipped.');
      else console.log(`[preview] cover image url: ${url}`);
    } else {
      console.log('[preview] kind: image pin');
      if (!url) console.log('[warn] no public image url (post.imageUrl) - this entry would be skipped (engine does not host media).');
      else console.log(`[preview] image url: ${url}`);
    }
    if (post.pinBoardSection) console.log(`[preview] board section: ${post.pinBoardSection}`);
  }
  console.log('\n================ VALIDATION COMPLETE ================');
}

async function cmdPublishDue(args) {
  const { abs, plan } = loadPlan(args.plan);
  const bid = boardId();
  if (!bid) throw new Error('PINTEREST_BOARD_ID is not set - cannot publish.');
  const token = await ensureFreshToken();
  const now = Date.now();
  let published = 0;

  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isPinterest(post)) continue;
    if (post.executionMode !== 'fully-scheduled') continue;
    if (post.status !== 'planned') continue;
    if ((post.approval || 'draft') !== 'approved') {
      console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish.`);
      continue;
    }
    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs) || dueMs > now) continue;

    // Specs 05+39: a carousel pin (media_source.multiple_image_urls) - fail-closed
    // BEFORE any call on the count/cap (2..5 slides). Each image slide publishes
    // from its PUBLIC per-slide url (or the §4.0 mirror derivation); a slide that
    // cannot resolve a URL, or a video slide (the v5 carousel is images-only),
    // emits a structured honest ok:false row via the shared carouselUnsupported
    // reason (never a half-post).
    if (isCarouselPost(post)) {
      const blocker = carouselBlocker(post, 'pinterest');
      if (blocker) {
        console.log(`[warn] ${post.id}: ${blocker} - skipping.`);
        RUN.results.push(carouselBlockRow(post, 'pinterest', blocker));
        continue;
      }
      const cfg = loadClientConfig();
      const unsupported = carouselUnsupported(post, 'pinterest', cfg);
      const slideUrls = carouselItems(post).map((it) => effectiveSlideUrl(it, cfg));
      if (unsupported || slideUrls.some((u) => !u)) {
        const reason = unsupported || 'pinterest carousel needs a public image URL per slide (set each slide url, or a public media host in Settings) - or post manually';
        console.log(`[warn] ${post.id}: ${reason} - skipping.`);
        RUN.results.push({ postId: post.id, platform: 'pinterest', action: 'publish', ok: false, errorCode: 'unsupported', errorMessage: reason });
        continue;
      }
      const cTitle = pinTitle(post);
      const cDesc = pinDescription(post);
      if (cTitle.length > TITLE_LIMIT) { console.log(`[warn] ${post.id}: title is ${cTitle.length} chars (> ${TITLE_LIMIT}) - skipping.`); continue; }
      if (cDesc.length > DESCRIPTION_LIMIT) { console.log(`[warn] ${post.id}: description is ${cDesc.length} chars (> ${DESCRIPTION_LIMIT}) - skipping.`); continue; }
      if (args['dry-run']) { console.log(`[dry] ${post.id}: would create a Pinterest carousel pin of ${slideUrls.length} image urls on board ${bid}.`); continue; }
      console.log(`[info] ${post.id}: creating a Pinterest carousel pin (${slideUrls.length} slides) on board ${bid}...`);
      try {
        const body = {
          board_id: bid,
          title: cTitle || undefined,
          description: cDesc || undefined,
          media_source: { source_type: 'multiple_image_urls', items: slideUrls.map((u) => ({ url: u })) },
          ...(post.pinBoardSection ? { board_section_id: post.pinBoardSection } : {}),
          ...(post.altText ? { alt_text: post.altText.slice(0, 500) } : {}),
        };
        const result = await api('POST', '/pins', { body, token });
        const pinId = result?.id;
        if (!pinId) throw new Error(`create-pin returned no id: ${JSON.stringify(result).slice(0, 200)}`);
        post.pinId = String(pinId);
        post.status = 'posted';
        post.postedAt = new Date(now).toISOString();
        appendAttempt(post, { ts: new Date().toISOString(), platform: 'pinterest', action: 'publish', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
        await savePlan(abs, plan, [post.id]);
        RUN.results.push({ postId: post.id, platform: 'pinterest', action: 'publish', ok: true, id: String(pinId) });
        console.log(`[ok] ${post.id}: published on Pinterest (carousel pin ${pinId}).`);
        published += 1;
      } catch (err) {
        appendAttempt(post, { ts: new Date().toISOString(), platform: 'pinterest', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), actor: ACTOR });
        await savePlan(abs, plan, [post.id]);
        RUN.results.push({ postId: post.id, platform: 'pinterest', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
        console.error(`[err] ${post.id}: Pinterest carousel publish failed - ${err.message}`);
      }
      continue;
    }

    const title = pinTitle(post);
    const desc = pinDescription(post);
    if (title.length > TITLE_LIMIT) { console.log(`[warn] ${post.id}: title is ${title.length} chars (> ${TITLE_LIMIT}) - skipping.`); continue; }
    if (desc.length > DESCRIPTION_LIMIT) { console.log(`[warn] ${post.id}: description is ${desc.length} chars (> ${DESCRIPTION_LIMIT}) - skipping.`); continue; }

    // Spec 17: branch on the post carrying a local video render (type=video) vs a
    // public imageUrl. A video pin is a DIFFERENT v5 flow (register -> upload ->
    // poll -> create with media_id) and REQUIRES the public imageUrl as its cover
    // (cover_image_url) - it never falls back to the plain image-pin path, and a
    // missing render/cover is a structured, honest ok:false skip (never a crash,
    // never a silent image fallback). The image-pin path (unchanged) still takes
    // media by public URL only - this engine hosts no media for it.
    const url = pinImageUrl(post);
    const isVideoPin = post.type === 'video';
    let videoPath = null;
    if (isVideoPin) {
      videoPath = resolveMediaPath(plan, post);
      if (!videoPath) {
        console.log(`[warn] ${post.id}: due but no local video render (post.path/file) - a video pin needs bytes to upload - skipping.`);
        RUN.results.push({ postId: post.id, platform: 'pinterest', action: 'publish', ok: false, errorCode: 'media_missing', errorMessage: 'pinterest video pin needs a local video render (post.path/file) to upload' });
        continue;
      }
      if (!url) {
        console.log(`[warn] ${post.id}: due but no public cover image url (post.imageUrl) - a video pin REQUIRES cover_image_url - skipping.`);
        RUN.results.push({ postId: post.id, platform: 'pinterest', action: 'publish', ok: false, errorCode: 'unsupported', errorMessage: 'pinterest video pin needs a public cover image (imageUrl) as cover_image_url' });
        continue;
      }
    } else if (!url) {
      // A local-only render with no public URL cannot become an image pin: v5
      // create-pin takes media by public URL, and this path hosts no media.
      // Unchanged regression behavior (spec 17 §2 acceptance 3): no result row,
      // exactly like before this spec.
      console.log(`[warn] ${post.id}: due but no public image url (post.imageUrl) - skipping (Pinterest engine does not host media; supply a public url).`);
      continue;
    }

    if (args['dry-run']) {
      if (isVideoPin) console.log(`[dry] ${post.id}: would upload + create a Pinterest VIDEO pin on board ${bid} from ${path.basename(videoPath)} (cover ${url}; title ${title.length} / desc ${desc.length} chars).`);
      else console.log(`[dry] ${post.id}: would create a pin on board ${bid} from ${url} (title ${title.length} / desc ${desc.length} chars).`);
      continue;
    }

    console.log(`[info] ${post.id}: ${isVideoPin ? 'uploading + creating a Pinterest video pin' : 'creating a Pinterest pin'} on board ${bid}...`);

    // The video upload (register/upload/poll) is its OWN try/catch, distinct from
    // the pin-create call below: it classifies THREE distinct outcomes (needs_scope
    // on a 403, media_failed/media_timeout from the poll) that the generic
    // engine_failure catch around POST /pins must not swallow into one code.
    let mediaSource;
    if (isVideoPin) {
      try {
        const mediaId = await uploadPinterestVideo(token, videoPath);
        mediaSource = { source_type: 'video_id', media_id: mediaId, cover_image_url: url };
      } catch (uploadErr) {
        const scopeIssue = uploadErr.status === 403;
        const errorCode = scopeIssue ? 'needs_scope' : (uploadErr.code === 'media_failed' || uploadErr.code === 'media_timeout') ? uploadErr.code : 'engine_failure';
        appendAttempt(post, { ts: new Date().toISOString(), platform: 'pinterest', action: 'publish', ok: false, errorCode, errorMessage: uploadErr.message.slice(0, 300), actor: ACTOR });
        await savePlan(abs, plan, [post.id]);
        const row = { postId: post.id, platform: 'pinterest', action: 'publish', ok: false };
        if (scopeIssue) { row.error = 'needs_scope'; row.scope = 'media:write'; } else { row.errorCode = errorCode; row.errorMessage = uploadErr.message.slice(0, 300); }
        RUN.results.push(row);
        if (scopeIssue) console.log(`[warn] ${post.id}: pinterest video upload needs the media:write scope - reconnect (node scripts/pinterest-social.mjs auth) to grant it.`);
        else console.error(`[err] ${post.id}: Pinterest video upload failed - ${uploadErr.message}`);
        continue;
      }
    } else {
      mediaSource = { source_type: 'image_url', url };
    }

    try {
      const body = {
        board_id: bid,
        title: title || undefined,
        description: desc || undefined,
        media_source: mediaSource,
        // Spec 17: an optional board-section target, on EITHER pin path.
        ...(post.pinBoardSection ? { board_section_id: post.pinBoardSection } : {}),
        // Spec 21: alt-text (v5 top-level alt_text, 500-char cap).
        ...(post.altText ? { alt_text: post.altText.slice(0, 500) } : {}),
      };
      const result = await api('POST', '/pins', { body, token });
      const pinId = result?.id;
      if (!pinId) throw new Error(`create-pin returned no id: ${JSON.stringify(result).slice(0, 200)}`);

      post.pinId = String(pinId);
      post.status = 'posted';
      post.postedAt = new Date(now).toISOString();
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'pinterest', action: 'publish', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'pinterest', action: 'publish', ok: true, id: String(pinId) });
      console.log(`[ok] ${post.id}: published on Pinterest (pin ${pinId}).`);
      published += 1;
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'pinterest', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'pinterest', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: Pinterest publish failed - ${err.message}`);
      continue;
    }
  }
  console.log(`[done] publish-due complete - ${published} pin(s) published.`);
}

async function cmdStatus(args) {
  const { plan } = loadPlan(args.plan);
  console.log('[info] Pinterest plan entries:');
  for (const post of (plan.posts || []).filter(isPinterest)) {
    console.log(`  ${post.id.padEnd(18)} ${String(post.status).padEnd(10)} ${post.scheduledAt}  mode=${post.executionMode}${post.pinId ? ` pin=${post.pinId}` : ''}`);
  }
}

// Read-only liveness: GET the stored pin. A 200 means the pin exists; the public
// permalink is derivable from the id (note: the pin is only publicly reachable
// once the app has Pinterest "Standard access").
async function cmdVerify(args) {
  const { plan } = loadPlan(args.plan);
  let token = null;
  try { token = await ensureFreshToken(); } catch { /* surfaced per row */ }
  for (const post of (plan.posts || []).filter(isPinterest)) {
    if (args.only && post.id !== args.only) continue;
    if (!post.pinId) continue;
    if (!token) {
      RUN.results.push({ postId: post.id, platform: 'pinterest', action: 'verify', ok: true, live: false, state: 'unknown', permalink: null, id: post.pinId });
      continue;
    }
    try {
      await api('GET', `/pins/${post.pinId}`, { token });
      RUN.results.push({ postId: post.id, platform: 'pinterest', action: 'verify', ok: true, live: true, state: 'live', permalink: permalinkFor(post), id: post.pinId });
    } catch (err) {
      RUN.results.push({ postId: post.id, platform: 'pinterest', action: 'verify', ok: false, errorCode: 'verify_failed', errorMessage: String(err.message || err).slice(0, 200), live: false, state: 'unknown', id: post.pinId });
    }
  }
}

// Per-pin analytics: GET /pins/<id>/analytics. Best-effort - the endpoint requires
// the analytics scope/Standard access and 7 days of data, so failures degrade to an
// honest ok:false row rather than fabricating metrics.
async function cmdInsights(args) {
  const { plan } = loadPlan(args.plan);
  let token = null;
  try { token = await ensureFreshToken(); } catch (err) { console.log(`[warn] insights: ${err.message}`); return; }
  for (const post of (plan.posts || []).filter(isPinterest)) {
    if (args.only && post.id !== args.only) continue;
    if (!post.pinId) continue;
    try {
      const end = new Date();
      const start = new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);
      const fmt = (d) => d.toISOString().slice(0, 10);
      const data = await api('GET', `/pins/${post.pinId}/analytics`, {
        query: { start_date: fmt(start), end_date: fmt(end), metric_types: 'IMPRESSION,PIN_CLICK,SAVE,OUTBOUND_CLICK' },
        token,
      });
      RUN.results.push({ postId: post.id, platform: 'pinterest', action: 'insights', ok: true, metrics: data, id: post.pinId });
    } catch (err) {
      RUN.results.push({ postId: post.id, platform: 'pinterest', action: 'insights', ok: false, errorCode: 'insights_unavailable', errorMessage: String(err.message || err).slice(0, 200), id: post.pinId });
    }
  }
}

// Normalize the ad-account audience_insights response into {age, gender, region}
// percentage/count maps - the exact response shape is undocumented in detail
// (Pinterest ships it under the ads surface), so this reads defensively across
// the plausible field-name variants rather than assuming one.
function parsePinterestDemographics(data) {
  // Reject arrays (an array passes typeof==='object' but would yield garbage
  // '0'/'1' index buckets) and keep only finite numeric values, so a
  // non-map-shaped or dirty payload omits a category rather than fabricating
  // zero rows.
  const pick = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const num = Number(v);
      if (Number.isFinite(num)) out[k] = num;
    }
    return out;
  };
  return {
    age: pick(data?.age_bucket || data?.age),
    gender: pick(data?.gender),
    region: pick(data?.region || data?.geo),
  };
}

// Account-scoped audience demographics (spec 07, Pattern P5) - called ONCE per
// evidence campaign by the insights sweep's generic account pass (spec 04). Needs
// an ads-scoped token + advertiser/ad-account id (business + ads onboarding);
// either gap degrades to a structured degrade (not_configured / needs_scope, P9),
// never a throw. Emits ONE account row { postId:null, platform:'pinterest',
// action:'demographics', ok, scope:'account', demographics:{...} }.
async function cmdDemographics() {
  const accountRow = (extra) => ({ postId: null, platform: 'pinterest', action: 'demographics', scope: 'account', ...extra });
  const adAccountId = readEnv('PINTEREST_AD_ACCOUNT_ID');
  if (!adAccountId) {
    RUN.results.push(accountRow({ ok: false, errorCode: 'not_configured', errorMessage: 'PINTEREST_AD_ACCOUNT_ID is not set' }));
    return;
  }
  let token;
  try {
    token = await ensureFreshToken();
  } catch (err) {
    RUN.results.push(accountRow({ ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 200) }));
    return;
  }
  try {
    const data = await api('GET', `/ad_accounts/${adAccountId}/audience_insights`, { token });
    RUN.results.push(accountRow({ ok: true, demographics: parsePinterestDemographics(data) }));
  } catch (err) {
    if (err.status === 403) {
      RUN.results.push(accountRow({ ok: false, error: 'needs_scope', scope: 'ads:read' }));
      console.log('[warn] demographics: Pinterest ads/business access (ads:read) not granted - no audience data available yet.');
      return;
    }
    RUN.results.push(accountRow({ ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 200) }));
    console.log(`[warn] demographics failed: ${String(err.message || err).slice(0, 200)}`);
  }
}

async function cmdDelete(args) {
  if (!args.id) { console.error('[err] delete requires --id <pinId>'); process.exit(2); }
  const token = await ensureFreshToken();
  await api('DELETE', `/pins/${args.id}`, { token });
  RUN.results.push({ platform: 'pinterest', action: 'delete', ok: true, id: String(args.id) });
  console.log(`[ok] deleted Pinterest pin ${args.id}.`);
}

async function cmdProbe() {
  if (!readEnv('PINTEREST_ACCESS_TOKEN') && !readEnv('PINTEREST_REFRESH_TOKEN')) {
    RUN.results.push({ platform: 'pinterest', action: 'probe', ok: false, detail: 'not configured (PINTEREST_ACCESS_TOKEN/PINTEREST_REFRESH_TOKEN missing)' });
    return;
  }
  try {
    const token = await ensureFreshToken();
    const me = await api('GET', '/user_account', { token });
    const expiresAt = Number(readEnv('PINTEREST_TOKEN_EXPIRES_AT') || 0) || null;
    RUN.results.push({ platform: 'pinterest', action: 'probe', ok: true, detail: `connected as ${me.username || me.business_name || '?'}`, tokenExpiresAt: expiresAt });
  } catch (err) {
    RUN.results.push({ platform: 'pinterest', action: 'probe', ok: false, detail: String(err.message || err).slice(0, 200) });
  }
}

// Connected-account discovery (spec 22, Pattern P3): who is connected + which boards
// can it manage? Reads creds via readEnv so a missing token degrades to an ok:false
// row, never process.exit past the envelope. Reuses the /user_account identity read +
// the shared listBoards() (spec 29 rides the same read); picking one writes
// pinterestBoardId. Takes no --plan.
async function cmdDiscover() {
  const { discoverOk, discoverNeedsScope, discoverAuthError, markCurrent } = await import('../lib/discovery.mjs');
  if (!readEnv('PINTEREST_ACCESS_TOKEN') && !readEnv('PINTEREST_REFRESH_TOKEN')) {
    RUN.results.push(discoverNeedsScope('pinterest'));
    return;
  }
  try {
    const token = await ensureFreshToken();
    const me = await api('GET', '/user_account', { token });
    let boards = [];
    try {
      boards = await listBoards(token);
    } catch (err) {
      if (err.status === 403) { RUN.results.push(discoverNeedsScope('pinterest')); return; }
      throw err;
    }
    const sealed = readEnv('PINTEREST_BOARD_ID') || null;
    const assets = markCurrent(boards.map((b) => ({
      kind: 'board', id: String(b.id), name: b.name || String(b.id),
      meta: b.privacy ? { privacy: b.privacy } : undefined,
    })), sealed);
    RUN.results.push(discoverOk('pinterest', {
      identity: { id: me.username || me.business_name || '', handle: me.username || null, name: me.business_name || me.username || 'Pinterest account', avatarUrl: me.profile_image },
      assets,
      selected: { pinterestBoardId: sealed },
    }));
  } catch (err) {
    RUN.results.push(discoverAuthError('pinterest', err.message || err));
  }
}

// List a board's sections for the Composer picker (spec 17, Pattern P4 read verb).
// READ-ONLY, LIVE-ONLY (left OUT of MOCKABLE_COMMANDS, like probe/discover's raw
// board list) - a failed read must NEVER masquerade as an empty section list, so a
// missing board/credential or a 403 degrades to a structured ok:false row (P9),
// never a false-empty { ok:true, items:[] }. Takes an optional --boardId (falls
// back to PINTEREST_BOARD_ID). No --plan.
async function cmdBoardSections(args) {
  const bid = (typeof args.boardId === 'string' && args.boardId.trim()) ? args.boardId.trim() : boardId();
  if (!bid) {
    RUN.results.push({ platform: 'pinterest', action: 'board-sections', ok: false, error: 'not_configured', message: 'no board id (--boardId / PINTEREST_BOARD_ID)', boardId: null, items: [] });
    return;
  }
  let token;
  try {
    token = await ensureFreshToken();
  } catch (err) {
    // Spec 17 review (MINOR-2): a never-connected lane (no token/refresh token
    // stored at all, err.code='not_configured' from ensureFreshToken) reads
    // "not configured", not "reconnect" - only a stored-but-broken credential
    // (an expired refresh token, etc.) is a genuine needs_scope.
    const error = err.code === 'not_configured' ? 'not_configured' : 'needs_scope';
    RUN.results.push({ platform: 'pinterest', action: 'board-sections', ok: false, error, message: String(err.message || err).slice(0, 200), boardId: bid, items: [] });
    return;
  }
  try {
    const items = await listBoardSections(token, bid);
    RUN.results.push({ platform: 'pinterest', action: 'board-sections', ok: true, boardId: bid, items });
  } catch (err) {
    const error = err.status === 403 ? 'needs_scope' : 'engine_failure';
    RUN.results.push({ platform: 'pinterest', action: 'board-sections', ok: false, error, message: String(err.message || err).slice(0, 200), boardId: bid, items: [] });
  }
}

// ---------- spec 29: board + board-section CRUD (Pattern P3/P4/P9) ----------
//
// pendpost has always pinned to ONE hard-coded PINTEREST_BOARD_ID with no way to
// see what boards exist, spin up a fresh one, or organize pins into sections from
// inside pendpost - the operator had to leave and hand-copy an id back into Setup.
// board-list is the READ (shares listBoards() with spec 22 discover - one source,
// no drift); board-create/board-update/board-section-create/board-section-update
// are the WRITEs, riding the NEW boards:write scope (SCOPES, above) - a token
// minted before this spec 403s on every write until the operator reconnects,
// exactly like spec 17's media:write precedent. Section LISTING is unchanged
// (cmdBoardSections above, spec 17) - this spec only adds section CRUD.

const BOARD_PRIVACY = new Set(['PUBLIC', 'PROTECTED', 'SECRET']);

// Classify a thrown api() error into the shared P9 error/message shape every
// write below returns: a 401 or 403 is ALWAYS an auth problem - missing
// boards:write, OR (spec 29 review NIT-6) a token revoked mid-flight - never a
// content problem; any other 4xx is the caller's fault (a name clash, a
// rejected field) - invalid_input with detail; anything else is a genuine
// engine_failure. Centralized so the four write verbs can never classify the
// same status two different ways.
function classifyBoardWriteError(err) {
  if (err.status === 401 || err.status === 403) return { error: 'needs_scope', scope: 'boards:write', message: String(err.message || err).slice(0, 200) };
  if (err.status >= 400 && err.status < 500) return { error: 'invalid_input', message: String(err.message || err).slice(0, 200) };
  return { error: 'engine_failure', message: String(err.message || err).slice(0, 200) };
}

// Resolve a fresh token OR push the not_configured/needs_scope row + return null
// so every verb below shares the exact ensureFreshToken degrade cmdBoardSections
// already established (spec 17 review MINOR-2's not_configured-vs-needs_scope split).
async function boardToken(action, extra = {}) {
  try {
    return await ensureFreshToken();
  } catch (err) {
    const error = err.code === 'not_configured' ? 'not_configured' : 'needs_scope';
    RUN.results.push({ platform: 'pinterest', action, ok: false, error, message: String(err.message || err).slice(0, 200), ...extra });
    return null;
  }
}

// board-list (read, MOCKABLE - unlike board-sections, Setup's BoardManager needs
// to render offline/in tests). Shares the SAME listBoards() read spec 22 discover
// uses (single source, no drift); adds privacy/pinCount, which discover's generic
// asset shape does not carry. A failed read is a structured ok:false row (never a
// false-empty boards:[]), mirroring cmdBoardSections' contract exactly.
async function cmdBoardList() {
  const token = await boardToken('board-list', { boards: [], current: null });
  if (!token) return;
  try {
    const raw = await listBoards(token);
    const boards = raw.map((b) => ({
      id: String(b.id), name: b.name || String(b.id),
      privacy: b.privacy || null,
      pinCount: Number.isFinite(b.pin_count) ? b.pin_count : 0,
    }));
    RUN.results.push({ platform: 'pinterest', action: 'board-list', ok: true, boards, current: boardId() });
  } catch (err) {
    const error = err.status === 403 ? 'needs_scope' : 'engine_failure';
    RUN.results.push({ platform: 'pinterest', action: 'board-list', ok: false, error, message: String(err.message || err).slice(0, 200), boards: [], current: null });
  }
}

// board-create (write): POST /v5/boards. NOT idempotent (mirrors yt-social's
// playlist-create) - repeated calls each mint a NEW board.
async function cmdBoardCreate(args) {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) {
    RUN.results.push({ platform: 'pinterest', action: 'board-create', ok: false, error: 'invalid_input', message: '--name is required' });
    return;
  }
  const privacy = typeof args.privacy === 'string' ? args.privacy.trim().toUpperCase() : '';
  if (privacy && !BOARD_PRIVACY.has(privacy)) {
    RUN.results.push({ platform: 'pinterest', action: 'board-create', ok: false, error: 'invalid_input', message: `--privacy must be one of ${[...BOARD_PRIVACY].join('|')}` });
    return;
  }
  const token = await boardToken('board-create');
  if (!token) return;
  try {
    const body = { name };
    if (typeof args.description === 'string' && args.description.trim()) body.description = args.description.trim();
    if (privacy) body.privacy = privacy;
    const data = await api('POST', '/boards', { body, token });
    if (!data || data.id == null) throw new Error(`board-create returned no id: ${JSON.stringify(data).slice(0, 200)}`);
    RUN.results.push({ platform: 'pinterest', action: 'board-create', ok: true, id: String(data.id), name: data.name || name });
  } catch (err) {
    RUN.results.push({ platform: 'pinterest', action: 'board-create', ok: false, ...classifyBoardWriteError(err) });
  }
}

// board-update (write): PATCH /v5/boards/{board_id}. IDEMPOTENT (a PATCH upsert -
// the same fields resolve to the same end state, mirrors gbp_attributes_set).
async function cmdBoardUpdate(args) {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) {
    RUN.results.push({ platform: 'pinterest', action: 'board-update', ok: false, error: 'invalid_input', message: '--id (board id) is required' });
    return;
  }
  const body = {};
  if (typeof args.name === 'string' && args.name.trim()) body.name = args.name.trim();
  if (typeof args.description === 'string') body.description = args.description.trim();
  if (typeof args.privacy === 'string' && args.privacy.trim()) {
    const privacy = args.privacy.trim().toUpperCase();
    if (!BOARD_PRIVACY.has(privacy)) {
      RUN.results.push({ platform: 'pinterest', action: 'board-update', ok: false, error: 'invalid_input', message: `--privacy must be one of ${[...BOARD_PRIVACY].join('|')}` });
      return;
    }
    body.privacy = privacy;
  }
  if (!Object.keys(body).length) {
    RUN.results.push({ platform: 'pinterest', action: 'board-update', ok: false, error: 'invalid_input', message: 'at least one of --name/--description/--privacy is required' });
    return;
  }
  const token = await boardToken('board-update', { id });
  if (!token) return;
  try {
    const data = await api('PATCH', `/boards/${encodeURIComponent(id)}`, { body, token });
    RUN.results.push({ platform: 'pinterest', action: 'board-update', ok: true, id: String((data && data.id) || id), name: (data && data.name) || body.name || null });
  } catch (err) {
    RUN.results.push({ platform: 'pinterest', action: 'board-update', ok: false, id, ...classifyBoardWriteError(err) });
  }
}

// board-section-create (write): POST /v5/boards/{board_id}/sections. NOT
// idempotent - repeated calls each mint a new section (mirrors board-create).
async function cmdBoardSectionCreate(args) {
  const targetBoardId = typeof args.board === 'string' ? args.board.trim() : '';
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!targetBoardId || !name) {
    RUN.results.push({ platform: 'pinterest', action: 'board-section-create', ok: false, error: 'invalid_input', message: '--board and --name are required' });
    return;
  }
  const token = await boardToken('board-section-create', { boardId: targetBoardId });
  if (!token) return;
  try {
    const data = await api('POST', `/boards/${encodeURIComponent(targetBoardId)}/sections`, { body: { name }, token });
    if (!data || data.id == null) throw new Error(`board-section-create returned no id: ${JSON.stringify(data).slice(0, 200)}`);
    RUN.results.push({ platform: 'pinterest', action: 'board-section-create', ok: true, boardId: targetBoardId, id: String(data.id), name: data.name || name });
  } catch (err) {
    RUN.results.push({ platform: 'pinterest', action: 'board-section-create', ok: false, boardId: targetBoardId, ...classifyBoardWriteError(err) });
  }
}

// board-section-update (write): PATCH /v5/boards/{board_id}/sections/{section_id}.
// IDEMPOTENT (mirrors board-update).
async function cmdBoardSectionUpdate(args) {
  const targetBoardId = typeof args.board === 'string' ? args.board.trim() : '';
  const sectionId = typeof args.section === 'string' ? args.section.trim() : '';
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!targetBoardId || !sectionId || !name) {
    RUN.results.push({ platform: 'pinterest', action: 'board-section-update', ok: false, error: 'invalid_input', message: '--board, --section and --name are required' });
    return;
  }
  const token = await boardToken('board-section-update', { boardId: targetBoardId, id: sectionId });
  if (!token) return;
  try {
    const data = await api('PATCH', `/boards/${encodeURIComponent(targetBoardId)}/sections/${encodeURIComponent(sectionId)}`, { body: { name }, token });
    RUN.results.push({ platform: 'pinterest', action: 'board-section-update', ok: true, boardId: targetBoardId, id: String((data && data.id) || sectionId), name: (data && data.name) || name });
  } catch (err) {
    RUN.results.push({ platform: 'pinterest', action: 'board-section-update', ok: false, boardId: targetBoardId, id: sectionId, ...classifyBoardWriteError(err) });
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
  demographics: cmdDemographics,
  delete: cmdDelete,
  probe: cmdProbe,
  discover: cmdDiscover,
  'board-sections': cmdBoardSections,
  'board-list': cmdBoardList,
  'board-create': cmdBoardCreate,
  'board-update': cmdBoardUpdate,
  'board-section-create': cmdBoardSectionCreate,
  'board-section-update': cmdBoardSectionUpdate,
};

async function main() {
  const args = parseArgs(process.argv);
  JSON_MODE = Boolean(args.json);
  ACTOR = typeof args.actor === 'string' ? args.actor : 'cli';
  if (JSON_MODE) console.log = (...a) => console.error(...a);
  const commandName = args._[0];
  if (resolveMode('pinterest') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'pinterest', command: commandName,
      planPath: typeof args.plan === 'string' ? path.resolve(String(args.plan)) : null,
      only: typeof args.only === 'string' ? args.only : null,
      // Spec 29: board/section CRUD flags the shared plan/only pair cannot carry -
      // forwarded here (every OTHER mock command ignores these, so this is
      // harmless everywhere else, mirrors yt-social.mjs's playlist flag forwarding).
      name: typeof args.name === 'string' ? args.name : null,
      description: typeof args.description === 'string' ? args.description : null,
      privacy: typeof args.privacy === 'string' ? args.privacy : null,
      boardId: typeof args.board === 'string' ? args.board : (typeof args.id === 'string' ? args.id : null),
      sectionId: typeof args.section === 'string' ? args.section : null,
    });
    if (JSON_MODE) process.stdout.write(`${JSON.stringify(envelope)}\n`);
    else console.error(`[mock] pinterest ${commandName}: ${envelope.results.length} result(s)`);
    return;
  }
  const cmd = COMMANDS[commandName];
  if (!cmd) {
    console.error(`Usage: node scripts/pinterest-social.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
    process.exit(2);
  }
  if (['validate', 'publish-due', 'status', 'verify', 'insights', 'demographics'].includes(commandName) && !args.plan) {
    console.error(`[err] ${commandName} requires --plan <post-plan.json>`);
    process.exit(2);
  }
  await cmd(args);
  if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: true, ...RUN })}\n`);
}

// CLI entry - only when executed directly, never when imported (unit tests reach
// parsePinterestDemographics this way). Mirrors scripts/x-social.mjs's identical guard.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (err) => {
    console.error('[err]', err.message || err);
    if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: false, error: String(err.message || err).slice(0, 300), ...RUN })}\n`);
    process.exit(1);
  });
}

// Test-only exports: parsePinterestDemographics (spec 07) is pure over its
// audience_insights response object, so a unit test can prove an array-shaped or
// dirty payload yields empty/omitted buckets (never fabricated zero rows) without
// spawning the CLI or the live ads API. cmdPublishDue and cmdBoardSections
// (spec 17) let a test drive the real video-pin register/upload/poll/create
// sequence and the board-sections read with a stubbed global.fetch (no network) -
// mirrors reddit-social.mjs's identical guarded exports. cmdBoardList/
// cmdBoardCreate/cmdBoardUpdate/cmdBoardSectionCreate/cmdBoardSectionUpdate
// (spec 29) let a test drive the board/section CRUD verbs the same way.
export {
  parsePinterestDemographics, cmdPublishDue, cmdBoardSections,
  cmdBoardList, cmdBoardCreate, cmdBoardUpdate, cmdBoardSectionCreate, cmdBoardSectionUpdate,
};
