#!/usr/bin/env node
/**
 * yt-social.mjs - direct YouTube video / Shorts publishing, no third-party service.
 *
 * Third sibling of scripts/meta-social.mjs (Facebook + Instagram) and
 * scripts/linkedin-social.mjs (LinkedIn company page): same zero-dep, plan-driven,
 * publish-straight-from-the-local-render pattern, with YouTube's own auth + scheduling model.
 *
 * YouTube is the ONLY platform of the three with TRUE native scheduling: videos.insert with
 * status.privacyStatus=private + status.publishAt makes the video auto-go-public at publishAt.
 * So there is NO publish-due command and NO one-time Claude scheduled task here (unlike IG /
 * LinkedIn). Google refresh tokens are durable, so there is also no access-token caching dance
 * (unlike LinkedIn) - a short-lived access token is minted on demand from the refresh token.
 *
 * ALL media uploads straight from the local render folder (post.path / plan.folder + post.file),
 * byte-for-byte, via YouTube's resumable upload protocol. No hosting layer, no Cloudinary.
 *
 * Source of truth: a post-plan.json (see data/plans/<campaign>/post-plan.json).
 *
 * Commands:
 *   auth      [--client-id X --client-secret Y]                     one-time loopback OAuth ceremony
 *   validate  --plan <post-plan.json> [--only <id>] | --file <path> side-effect-free: upload PRIVATE + delete
 *   publish   --file <path> [--title --description --tags --unlisted] immediate upload, PUBLIC (or unlisted)
 *   schedule  --plan <post-plan.json> [--only <id>] [--dry-run]     natively schedule (private + publishAt)
 *   release   --plan <post-plan.json> [--only <id>]                 make a private-overdue scheduled video public now (no re-upload)
 *   status    --plan <post-plan.json>                               per-entry live state
 *   demographics --plan <post-plan.json>                            account-scoped viewer age/gender breakdown (needs yt-analytics.readonly)
 *   delete    --id <videoId>                                        delete a video (cleanup / unschedule)
 *
 * Credentials live in gitignored .env (same convention as the siblings):
 * YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN. YT_REDIRECT_URI is an optional env override
 * for the loopback redirect (default http://localhost:8088/callback).
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand } from '../lib/mode.mjs';
import { enforceCeremonyClient } from '../lib/cli-client.mjs';
import { recordAttempt } from '../lib/publish-hold.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
import { envPath } from '../lib/util.mjs';
import { captionBlocker, captionBlockRow } from '../lib/caption.mjs';
import { avSyncBlocker, avSyncBlockRow } from '../lib/assets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The .env lives in the ACTIVE client subtree, resolved by the shared envPath()
// (lib/util.mjs -> activeRoot()): when the app spawns us it sets PENDPOST_ROOT to
// that client root; a bare CLI run resolves the active client from data/clients.json.
// Either way we read/write the SAME file the app reads - no orphan repo-root .env.
const ENV_PATH = envPath();

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';
const API = 'https://www.googleapis.com/youtube/v3';
// The Analytics API is a SEPARATE host from the Data API (API, above) - account-
// scoped demographics (spec 07) reads reports from here, never videos.list.
const ANALYTICS_API = 'https://youtubeanalytics.googleapis.com/v2';
// youtube.force-ssl is REQUIRED by captions.insert + commentThreads.insert.
// yt-analytics.readonly (spec 07) is REQUIRED by the demographics report. Adding
// either changes the consent scope set: re-run `yt-social.mjs auth` to mint a
// refresh token that carries it, or the corresponding call 403s.
const SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly';
const DEFAULT_REDIRECT = 'http://localhost:8088/callback';
const CATEGORY_EDUCATION = '27';

// redirect uri is a constant overridable by env (mirrors linkedin-social hardcoding its org urn).
const redirectUri = () => readEnv('YT_REDIRECT_URI') || DEFAULT_REDIRECT;

// ---------- env helpers (same shape as meta-social.mjs / linkedin-social.mjs) ----------

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
    console.error(`[err] ${name} missing in .env - run 'node scripts/yt-social.mjs auth' first.`);
    process.exit(1);
  }
  return v;
}

function tokenTail(t) {
  return t ? `...${t.slice(-6)}, length ${t.length}` : '(none)';
}

// ---------- oauth ----------

async function tokenExchange(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const hint = data.error === 'invalid_grant'
      ? " - the refresh token is expired/revoked, or the OAuth consent screen is in Testing mode (which expires refresh tokens after 7 days). Re-run 'node scripts/yt-social.mjs auth'."
      : '';
    throw new Error(`OAuth ${params.grant_type}: HTTP ${res.status} ${data.error || ''} - ${data.error_description || JSON.stringify(data)}${hint}`);
  }
  return data;
}

// Google refresh tokens are durable (published consent screen), so we mint a short-lived access
// token on demand each run rather than caching one. Simpler than LinkedIn's expiry tracking.
async function getAccessToken() {
  const data = await tokenExchange({
    grant_type: 'refresh_token',
    refresh_token: requireEnv('YT_REFRESH_TOKEN'),
    client_id: requireEnv('YT_CLIENT_ID'),
    client_secret: requireEnv('YT_CLIENT_SECRET'),
  });
  return data.access_token;
}

// ---------- youtube data api helper (json GET/POST/DELETE) ----------

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
    const e = data.error || {};
    const reason = e.errors?.[0]?.reason || '';
    const err = new Error(`YouTube ${method} ${pathname}: HTTP ${res.status} ${reason} - ${e.message || text || ''}`);
    // Status AND reason ride the error object (mirrors fetchYtWatchTime's own
    // thrown error below) so a 403 can be classified needs_scope (P9) without
    // re-parsing the message text - the playlist verbs (spec 15) are the first
    // api() callers that need this. reason (the Google error's errors[0].reason,
    // e.g. quotaExceeded/insufficientPermissions) lets ytNeedsScope tell a quota
    // 403 apart from an actual missing-scope 403 (spec-15 quota mislabel fix,
    // spec-28 review NIT-8) - quota exhaustion is NOT "reconnect to authorize".
    err.status = res.status;
    err.reason = reason;
    throw err;
  }
  return data;
}

// ---------- resumable upload (whole file in one PUT, straight from local disk) ----------

async function insertVideo(meta, filePath, token) {
  const buf = fs.readFileSync(filePath);
  // 1) start a resumable session - the body is the metadata JSON; the Location header is the
  //    session URI to which we PUT the bytes.
  const start = await fetch(`${UPLOAD}?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(buf.length),
      'X-Upload-Content-Type': 'video/*',
    },
    body: JSON.stringify(meta),
  });
  if (!start.ok) {
    const t = await start.text().catch(() => '');
    throw new Error(`videos.insert (start session): HTTP ${start.status} ${t}`);
  }
  const sessionUri = start.headers.get('location');
  if (!sessionUri) throw new Error('videos.insert (start session): no Location header for the resumable session.');

  // 2) upload all bytes in a single PUT (files are ~6 MB; no chunking needed).
  const put = await fetch(sessionUri, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/*' },
    body: buf,
  });
  const text = await put.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!put.ok) {
    const e = data.error || {};
    throw new Error(`videos.insert (upload): HTTP ${put.status} ${e.message || text || ''}`);
  }
  return data; // { id, snippet, status, ... }
}

// ---------- plan helpers (same shape as meta-social.mjs / linkedin-social.mjs) ----------
// (lock + field-merge save duplicated verbatim across the three engine
// siblings - self-contained per the sibling pattern, no shared lib)

function loadPlan(planPath) {
  const abs = path.resolve(planPath);
  return { abs, plan: JSON.parse(fs.readFileSync(abs, 'utf8')) };
}

// Engine-owned fields; everything else (caption, schedule, approval, cover)
// belongs to the owner/pendpost and must survive concurrent edits.
// ytPlaylistItems (spec 15): the optional [{playlistId,itemId}] membership echo a
// successful playlist-add writes onto the post, so PostDetail can show "In: Series A"
// with no re-fetch - engine-owned like every other minted id above.
const ENGINE_OWNED_FIELDS = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'ytCaptionId', 'ytCommentId', 'ytPlaylistItems', 'status', 'postedAt', 'attempts', 'publishHold', 'radarReplyState'];

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

// Per-attempt audit trail on the post itself (engine-owned field).
function appendAttempt(post, entry) {
  // Shared recorder (lib/publish-hold.mjs): trims the attempts tail and maintains
  // the publishHold failure cap - the local mirror of the cloud re-fire cap.
  recordAttempt(post, entry);
}

// Machine-readable run envelope for --json mode (consumed by the pendpost scheduler).
// Exported (spec 28, mirrors telegram-social.mjs's RUN) so a profile-edit test can
// read the accumulated result rows after driving cmdProfile in-process.
export const RUN = { results: [], blocked368: false };
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

// Cover override materialized by pendpost (lib/covers.mjs):
// post.cover = { source: 'frame'|'file', offsetMs?, path } with a repo-relative
// path to the JPEG. Engines only ever READ it - the field is pendpost-owned.
function resolveCoverPath(post) {
  if (!post.cover?.path) return null;
  const abs = path.resolve(__dirname, '..', post.cover.path);
  return fs.existsSync(abs) ? abs : null;
}

// Subtitle SRT track: the owner-set post.captionPath (repo-relative or absolute),
// else the convention default = a <media-basename>.<lang>.srt sibling next to the
// render (mirrors the cover-sibling convention). Engines only READ it. Returns an
// absolute path or null. captions.insert applies it post-hoc even on a PRIVATE
// video (unlike a cover it needs no phone verification).
function resolveCaptionPath(post) {
  if (post.captionPath) {
    const abs = path.isAbsolute(post.captionPath) ? post.captionPath : path.resolve(__dirname, '..', post.captionPath);
    return fs.existsSync(abs) ? abs : null;
  }
  const media = post.path && fs.existsSync(post.path) ? path.resolve(post.path) : null;
  if (!media) return null;
  const lang = (post.captionLang || 'en').toLowerCase();
  const guess = media.replace(/\.(mp4|mov)$/i, `.${lang}.srt`);
  return guess !== media && fs.existsSync(guess) ? guess : null;
}

// thumbnails.set is the ONLY thumbnail write path (videos.insert cannot carry
// one) and it is post-hoc-callable any time after upload. Needs the upload
// host + raw binary body - the JSON api() helper cannot do this. 2 MB API cap.
// Channel must be phone-verified or every call 403s; the 403 "forbidden"
// reason is ambiguous (verification vs ownership), so surface the message
// text verbatim. Shorts caveat: the Shorts FEED always shows a video frame -
// the custom thumbnail appears on search/channel surfaces only.
async function setThumbnail(videoId, jpgPath, token) {
  const buf = fs.readFileSync(jpgPath);
  if (buf.length > 2 * 1024 * 1024) {
    throw new Error(`thumbnail exceeds the 2 MB API cap (${(buf.length / 1e6).toFixed(1)} MB) - re-export smaller`);
  }
  const res = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' },
    body: buf,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`thumbnails.set ${videoId}: HTTP ${res.status} ${data.error?.message || text || ''}`);
  }
  return data;
}

// captions.insert - upload an SRT subtitle track. Manual multipart/related so the
// engine stays zero-dep (the JSON api() helper cannot carry a binary part). Soft +
// post-hoc-callable; language/name are params so an EN/DE/FR/IT track is a one-liner
// (no schema change). Needs the youtube.force-ssl scope. isDraft=false publishes the
// track (not forced-on). Applies even on a PRIVATE video.
async function setCaption(videoId, srtPath, { language = 'en', name = 'English', isDraft = false } = {}, token) {
  const srt = fs.readFileSync(srtPath);
  const boundary = `pendpost-${crypto.randomBytes(8).toString('hex')}`;
  const meta = JSON.stringify({ snippet: { videoId, language, name, isDraft } });
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`
    + `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, srt, tail]);
  const res = await fetch('https://www.googleapis.com/upload/youtube/v3/captions?part=snippet&uploadType=multipart', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`captions.insert ${videoId}: HTTP ${res.status} ${data.error?.message || text || ''}`);
  return data; // { id, snippet, ... }
}

// commentThreads.insert - post a top-level comment AS THE CHANNEL. The API cannot
// PIN (no pin endpoint exists) and cannot comment on a PRIVATE video, so at schedule
// time this soft-warns by design; it is the reliable path once the video is public.
async function postComment(videoId, text, token) {
  return api('POST', '/commentThreads', {
    query: { part: 'snippet' },
    body: { snippet: { videoId, topLevelComment: { snippet: { textOriginal: text } } } },
    token,
  }); // { id: threadId, ... }
}

function fmtLocal(iso, tz) {
  return new Date(iso).toLocaleString('en-US', { timeZone: tz || 'UTC' });
}

const isYouTube = (post) => (post.platforms || []).includes('youtube');

function tagsArray(tags) {
  if (Array.isArray(tags)) return tags;
  return String(tags || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// snippet from the plan entry; publishAt only on the real schedule path (never on validation).
// privacy defaults to 'private' so validate/schedule are unchanged; cmdPublish passes
// 'public'/'unlisted' for an immediate, visible upload (compliance-demo / one-off).
function buildMeta(post, { withPublishAt = false, privacy = 'private' } = {}) {
  const status = { privacyStatus: privacy, selfDeclaredMadeForKids: false };
  if (withPublishAt) status.publishAt = new Date(post.scheduledAt).toISOString();
  return {
    snippet: {
      title: post.title || 'pendpost',
      description: post.description || '',
      tags: tagsArray(post.tags),
      categoryId: CATEGORY_EDUCATION,
      defaultLanguage: 'de',
      defaultAudioLanguage: 'de',
    },
    status,
  };
}

// ---------- commands ----------

async function cmdAuth(args) {
  console.log(`[info] Connecting YouTube - credentials will be written to ${ENV_PATH}`);
  const clientId = args['client-id'] || readEnv('YT_CLIENT_ID');
  const clientSecret = args['client-secret'] || readEnv('YT_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    console.error('[err] Need --client-id and --client-secret (GCP Console -> APIs & Services -> Credentials -> the OAuth client) on first run, or set YT_CLIENT_ID / YT_CLIENT_SECRET in .env.');
    process.exit(2);
  }
  const redirect = redirectUri();
  writeEnv({ YT_CLIENT_ID: clientId, YT_CLIENT_SECRET: clientSecret, YT_REDIRECT_URI: redirect });

  const u = new URL(redirect);
  const port = Number(u.port || 80);
  const callbackPath = u.pathname || '/callback';
  const state = crypto.randomUUID();
  const authUrl = `${AUTH_URL}?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent', // force a refresh token even on re-auth
    include_granted_scopes: 'true',
    state,
  }).toString()}`;

  console.log(`\n[action] Make sure ${redirect} is allowed for this OAuth client (Desktop type: any loopback works with no setup; Web type: add it under Authorized redirect URIs).`);
  console.log('[action] Opening the Google consent screen. Sign in with the brand account that owns your YouTube channel. If it does not open, paste this URL:\n');
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
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirect,
        });
        if (!data.refresh_token) {
          throw new Error('No refresh_token returned. Revoke prior access at myaccount.google.com/permissions, then re-run auth (prompt=consent is set, so this is rare).');
        }
        writeEnv({ YT_REFRESH_TOKEN: data.refresh_token });
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>pendpost: YouTube connected.</h2><p>You can close this tab and return to the terminal.</p>');
        console.log(`\n[ok] Refresh token stored (${tokenTail(data.refresh_token)}).`);
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
      console.log(`[info] Waiting for the Google consent redirect on ${redirect} ...`);
    });
  });

  // prove the token works and surface the channel (the youtubeSignupRequired pre-check).
  try {
    const token = await getAccessToken();
    const chan = await api('GET', '/channels', { query: { part: 'snippet,status', mine: 'true' }, token });
    const ch = chan.items?.[0];
    if (ch) {
      console.log(`[ok] YouTube channel: ${ch.snippet?.title} (${ch.id}).`);
    } else {
      console.log('[warn] Token works but this Google account has NO YouTube channel - videos.insert will fail with youtubeSignupRequired. Create a channel at youtube.com first.');
    }
  } catch (err) {
    console.log(`[warn] Could not fetch the channel: ${err.message}`);
  }
  console.log('[done] auth complete.');
}

async function cmdValidate(args) {
  const token = await getAccessToken();
  console.log('================ VALIDATION ONLY - the test video is uploaded PRIVATE then DELETED ================');

  let mediaPath = null;
  let snippetSource = { title: 'pendpost upload test (delete me)', description: 'side-effect-free validation - will be deleted', tags: 'test' };
  if (args.file) {
    mediaPath = path.resolve(args.file);
    if (!fs.existsSync(mediaPath)) { console.error(`[err] --file not found: ${mediaPath}`); process.exit(1); }
  } else if (args.plan) {
    const { plan } = loadPlan(args.plan);
    const targets = (plan.posts || []).filter((p) => isYouTube(p) && (!args.only || p.id === args.only));
    const post = targets[0];
    if (!post) { console.error('[err] No YouTube entry matches in the plan.'); process.exit(1); }
    mediaPath = resolveMediaPath(plan, post);
    if (!mediaPath) { console.error(`[err] media not found for ${post.id} (${post.path || post.file}).`); process.exit(1); }
    snippetSource = post;
    console.log(`[info] Validating with the exact snippet of plan entry "${post.id}".`);
  } else {
    console.error('[err] validate needs --plan <post-plan.json> (optionally --only <id>) or --file <path>.');
    process.exit(2);
  }
  if (!/\.(mp4|mov)$/i.test(mediaPath)) { console.error('[err] not a video file.'); process.exit(1); }

  const meta = buildMeta(snippetSource, { withPublishAt: false }); // private, NO publishAt -> never public
  console.log(`[info] uploading ${path.basename(mediaPath)} (${(fs.statSync(mediaPath).size / 1e6).toFixed(1)} MB) as PRIVATE...`);
  const video = await insertVideo(meta, mediaPath, token);
  console.log(`[ok] uploaded: id=${video.id}, privacyStatus=${video.status?.privacyStatus}, uploadStatus=${video.status?.uploadStatus}.`);
  console.log(`[preview] title:       ${meta.snippet.title}`);
  console.log('[preview] description:');
  console.log(meta.snippet.description);
  console.log(`[preview] tags:        ${JSON.stringify(meta.snippet.tags)}`);
  console.log(`[preview] categoryId:  ${meta.snippet.categoryId} (Education), selfDeclaredMadeForKids=${meta.status.selfDeclaredMadeForKids}`);

  console.log('[info] deleting the test video (side-effect-free)...');
  await api('DELETE', '/videos', { query: { id: video.id }, token });
  console.log(`[ok] deleted ${video.id}.`);
  console.log('================ VALIDATION COMPLETE - nothing remains on the channel. ================');
}

// Immediate single-file upload as PUBLIC (or --unlisted). Same resumable videos.insert path as
// validate/schedule; only privacyStatus differs and there is no publishAt (goes live now). Used
// for one-off uploads and for the YouTube API Services compliance-review screencast, where the
// reviewer must see a real upload land visibly on the channel.
async function cmdPublish(args) {
  if (!args.file) {
    console.error('[err] publish needs --file <path.mp4> [--title "..."] [--description "..."] [--tags "a,b,c"] [--unlisted]');
    process.exit(2);
  }
  const mediaPath = path.resolve(args.file);
  if (!fs.existsSync(mediaPath)) { console.error(`[err] --file not found: ${mediaPath}`); process.exit(1); }
  if (!/\.(mp4|mov)$/i.test(mediaPath)) { console.error('[err] not a video file (.mp4/.mov).'); process.exit(1); }

  const privacy = args.unlisted ? 'unlisted' : 'public';
  const post = {
    title: typeof args.title === 'string' ? args.title : 'pendpost',
    description: typeof args.description === 'string' ? args.description : '',
    tags: typeof args.tags === 'string' ? args.tags : '',
  };
  const token = await getAccessToken();
  const meta = buildMeta(post, { privacy });

  console.log(`[info] uploading ${path.basename(mediaPath)} (${(fs.statSync(mediaPath).size / 1e6).toFixed(1)} MB) as ${privacy.toUpperCase()} via videos.insert (resumable upload, straight from local disk)...`);
  console.log(`[preview] title:       ${meta.snippet.title}`);
  console.log(`[preview] description: ${meta.snippet.description.split('\n')[0] || '(none)'}`);
  console.log(`[preview] tags:        ${JSON.stringify(meta.snippet.tags)}`);
  console.log(`[preview] categoryId:  ${meta.snippet.categoryId} (Education), selfDeclaredMadeForKids=${meta.status.selfDeclaredMadeForKids}`);

  const video = await insertVideo(meta, mediaPath, token);
  console.log(`[ok] uploaded: id=${video.id}, privacyStatus=${video.status?.privacyStatus}, uploadStatus=${video.status?.uploadStatus}.`);
  console.log(`[watch]  https://youtu.be/${video.id}`);
  console.log(`[studio] https://studio.youtube.com/video/${video.id}/edit`);
}

async function cmdSchedule(args) {
  const { abs, plan } = loadPlan(args.plan);
  const token = args['dry-run'] ? null : await getAccessToken();
  const now = Date.now();
  const touched = new Set();
  let scheduled = 0;
  let dirty = false;

  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isYouTube(post)) continue;
    if (post.executionMode !== 'fully-scheduled') continue;
    if (post.status !== 'planned') continue;
    // Publish hold (lib/publish-hold.mjs): the failure cap is spent - never re-fire on
    // its own. Backstop for direct CLI runs; the scheduler's lanesOwed already drops a
    // held post from the fire loop. Reschedule or edit clears the hold.
    if (post.publishHold) {
      console.log(`[skip] ${post.id}: publish hold after repeated failures (${post.publishHold.code ?? post.publishHold.message ?? 'unknown'}) - reschedule or edit the post to retry.`);
      continue;
    }
    // Fail-closed approval (SS-01): missing field = draft = never publish.
    if ((post.approval || 'draft') !== 'approved') {
      console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish.`);
      continue;
    }
    if (post.ytVideoId) { console.log(`[skip] ${post.id}: already has ytVideoId ${post.ytVideoId}.`); continue; }

    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs)) { console.log(`[warn] ${post.id}: unparseable scheduledAt "${post.scheduledAt}" - skipping.`); continue; }
    if (dueMs <= now) { console.log(`[warn] ${post.id}: scheduledAt is in the past - YouTube requires a future publishAt. Reschedule or upload manually.`); continue; }

    const mediaPath = resolveMediaPath(plan, post);
    if (!mediaPath) { console.log(`[warn] ${post.id}: media not found (${post.path || post.file}) - skipping.`); continue; }
    if (!/\.(mp4|mov)$/i.test(mediaPath)) { console.log(`[warn] ${post.id}: not a video file - skipping.`); continue; }
    // Fresh-bytes caption backstop: YouTube caps a description at 5000 chars
    // (lib/caption.mjs). Checks post.description - the field buildMeta actually sends
    // (NOT post.caption) - so the backstop guards the real upload. Refuse an over-cap
    // description before the API rejects it.
    const capBlock = captionBlocker(post.description, 'youtube');
    if (capBlock) {
      console.log(`[warn] ${post.id}: ${capBlock} - skipping.`);
      RUN.results.push(captionBlockRow(post, 'youtube', capBlock));
      continue;
    }
    // Fresh-bytes A/V-sync backstop: probe the actual video bytes about to upload (not
    // the manifest's stale author-time avSyncOk) - a measured desync is a malformed mux
    // YouTube's processing rejects.
    const avBlock = await avSyncBlocker(mediaPath);
    if (avBlock) {
      console.log(`[warn] ${post.id}: ${avBlock} - skipping.`);
      RUN.results.push(avSyncBlockRow(post, 'youtube', avBlock));
      continue;
    }

    const meta = buildMeta(post, { withPublishAt: true });
    if (args['dry-run']) {
      console.log(`\n[dry] ${post.id}: would schedule a PRIVATE YouTube video to auto-publish at ${meta.status.publishAt} (${fmtLocal(post.scheduledAt, plan.timezone)} ${plan.timezone || 'UTC'}):`);
      console.log(`      title:       ${meta.snippet.title}`);
      console.log('      description:');
      console.log(meta.snippet.description.split('\n').map((l) => `        ${l}`).join('\n'));
      console.log(`      tags:        ${JSON.stringify(meta.snippet.tags)}`);
      console.log(`      categoryId:  ${meta.snippet.categoryId} (Education), selfDeclaredMadeForKids=${meta.status.selfDeclaredMadeForKids}`);
      console.log(`      source:      ${mediaPath}`);
      continue;
    }

    console.log(`[info] ${post.id}: uploading ${path.basename(mediaPath)} (${(fs.statSync(mediaPath).size / 1e6).toFixed(1)} MB), private + publishAt ${meta.status.publishAt}...`);
    try {
      const video = await insertVideo(meta, mediaPath, token);
      post.ytVideoId = video.id;
      post.status = 'scheduled';
      dirty = true;
      touched.add(post.id);
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'youtube', action: 'schedule-native', ok: true, errorCode: null, errorMessage: null, lateMin: 0, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'youtube', action: 'schedule-native', ok: true, id: video.id });
      console.log(`[ok] ${post.id}: scheduled (video id ${video.id}, privacyStatus=${video.status?.privacyStatus}, publishAt=${video.status?.publishAt}). Confirm it reads "Scheduled" in YouTube Studio.`);
      scheduled += 1;
      // Cover override: cosmetic + non-fatal - the scheduled upload stands.
      const ytCover = resolveCoverPath(post);
      if (ytCover) {
        try {
          await setThumbnail(video.id, ytCover, token);
          RUN.results.push({ postId: post.id, platform: 'youtube', action: 'set-thumbnail', ok: true, id: video.id });
          console.log(`[ok] ${post.id}: custom thumbnail applied.`);
        } catch (err) {
          RUN.results.push({ postId: post.id, platform: 'youtube', action: 'set-thumbnail', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
          console.log(`[warn] ${post.id}: thumbnail failed (video keeps the default frame) - ${err.message}`);
        }
      }
      // SRT subtitle track: applies even on a PRIVATE/scheduled video (no phone
      // verify). Soft + non-fatal + idempotent (skip once ytCaptionId is set).
      const ytSrt = resolveCaptionPath(post);
      if (ytSrt && !post.ytCaptionId) {
        try {
          const lang = post.captionLang || 'en';
          const cap = await setCaption(video.id, ytSrt, { language: lang, name: lang.toUpperCase(), isDraft: false }, token);
          post.ytCaptionId = cap.id;
          await savePlan(abs, plan, [post.id]);
          RUN.results.push({ postId: post.id, platform: 'youtube', action: 'set-caption', ok: true, id: video.id });
          console.log(`[ok] ${post.id}: ${lang} SRT caption track inserted.`);
        } catch (err) {
          RUN.results.push({ postId: post.id, platform: 'youtube', action: 'set-caption', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
          console.log(`[warn] ${post.id}: caption insert failed - ${err.message}`);
        }
      }
      // First comment: the API posts AS the channel but cannot PIN and cannot
      // comment on a PRIVATE video, so this soft-warns at schedule time by design
      // (the owner pins it post-go-live; `comment` re-tries then). Idempotent.
      if (post.firstComment && !post.ytCommentId) {
        try {
          const thread = await postComment(video.id, post.firstComment, token);
          post.ytCommentId = thread.id;
          await savePlan(abs, plan, [post.id]);
          RUN.results.push({ postId: post.id, platform: 'youtube', action: 'post-comment', ok: true, id: thread.id });
          console.log(`[ok] ${post.id}: first comment posted (pin it manually in YouTube Studio).`);
        } catch (err) {
          RUN.results.push({ postId: post.id, platform: 'youtube', action: 'post-comment', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
          console.log(`[warn] ${post.id}: comment not posted (expected for a private/scheduled video) - ${err.message}`);
        }
      }
    } catch (err) {
      dirty = true;
      touched.add(post.id);
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'youtube', action: 'schedule-native', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), lateMin: 0, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'youtube', action: 'schedule-native', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: YouTube upload failed - ${err.message}`);
      continue;
    }
  }
  if (dirty) await savePlan(abs, plan, [...touched]);
  console.log(`[done] schedule complete - ${scheduled} video(s) scheduled.`);
}

async function cmdStatus(args) {
  const { plan } = loadPlan(args.plan);
  const token = await getAccessToken();
  console.log('[info] YouTube plan entries (live state fetched when ytVideoId is present):');
  for (const post of (plan.posts || []).filter(isYouTube)) {
    let live = '';
    if (post.ytVideoId) {
      try {
        const data = await api('GET', '/videos', { query: { part: 'status,snippet', id: post.ytVideoId }, token });
        const v = data.items?.[0];
        live = v
          ? ` privacy=${v.status?.privacyStatus}${v.status?.publishAt ? ` publishAt=${v.status.publishAt}` : ''}`
          : ' NOT FOUND (deleted?)';
      } catch (err) {
        live = ` lookup failed (${err.message.slice(0, 40)})`;
      }
    }
    console.log(`  ${post.id.padEnd(18)} ${String(post.status).padEnd(10)} ${post.scheduledAt}  mode=${post.executionMode}${post.ytVideoId ? ` yt=${post.ytVideoId}` : ''}${live}`);
  }
}

async function cmdDelete(args) {
  if (!args.id) {
    console.error('Usage: node scripts/yt-social.mjs delete --id <videoId>');
    process.exit(2);
  }
  const token = await getAccessToken();
  await api('DELETE', '/videos', { query: { id: args.id }, token });
  console.log(`[ok] Deleted YouTube video ${args.id}.`);
}

// ---------- main ----------

// Supplementary watch-time time-series (spec 08, Pattern P5): estimatedMinutesWatched
// + averageViewDuration per video via the YouTube Analytics API (the SAME host/scope
// cmdDemographics already uses - yt-analytics.readonly). A wide, fixed start date
// covers a video's whole lifetime regardless of when it published. Returns null on
// any failure (403 = scope not granted, or any other error) - the CALLER folds that
// into "no extra fields, base statistics still stand" (P9), so this never throws
// past itself and never blocks the base metrics.
async function fetchYtWatchTime(token, videoId) {
  const url = new URL(`${ANALYTICS_API}/reports`);
  url.searchParams.set('ids', 'channel==MINE');
  url.searchParams.set('dimensions', 'video');
  url.searchParams.set('metrics', 'estimatedMinutesWatched,averageViewDuration');
  url.searchParams.set('filters', `video==${videoId}`);
  url.searchParams.set('startDate', '2005-01-01');
  url.searchParams.set('endDate', new Date().toISOString().slice(0, 10));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`YouTube Analytics GET /reports: HTTP ${res.status} - ${data.error?.message || text || ''}`);
    err.status = res.status;
    throw err;
  }
  const row = data.rows?.[0];
  if (!row) return null;
  const [, minutesWatched, avgViewDuration] = row;
  return { watchTimeMin: Number(minutesWatched) || 0, avgViewSec: Number(avgViewDuration) || 0 };
}

// Read-only metrics fetch (Phase E): videos.list part=statistics is the one
// stable, quota-cheap (1 unit) metrics surface. One batched call for all ids.
// Writes NOTHING - pendpost stores the envelope in its own state.json.
async function cmdInsights(args) {
  const { plan } = loadPlan(args.plan);
  const token = await getAccessToken();
  const targets = (plan.posts || []).filter((p) => (!args.only || p.id === args.only) && isYouTube(p) && p.ytVideoId);
  if (!targets.length) {
    console.log('[done] insights complete - no posts with a ytVideoId.');
    return;
  }
  let items = [];
  try {
    const data = await api('GET', '/videos', {
      query: { part: 'statistics,status', id: targets.map((p) => p.ytVideoId).join(',') },
      token,
    });
    items = data.items || [];
  } catch (err) {
    for (const post of targets) {
      RUN.results.push({ postId: post.id, platform: 'youtube', action: 'insights', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
    }
    console.error(`[err] videos.list failed - ${err.message}`);
    return;
  }
  for (const post of targets) {
    const v = items.find((i) => i.id === post.ytVideoId);
    if (!v) {
      RUN.results.push({ postId: post.id, platform: 'youtube', action: 'insights', ok: false, errorCode: 'engine_failure', errorMessage: `video ${post.ytVideoId} not found (deleted?)` });
      console.log(`[warn] ${post.id}: ${post.ytVideoId} not found.`);
      continue;
    }
    const s = v.statistics || {};
    const metrics = {
      views: Number(s.viewCount ?? 0),
      likes: Number(s.likeCount ?? 0),
      comments: Number(s.commentCount ?? 0),
      privacyStatus: v.status?.privacyStatus || null,
    };
    // Spec 08: watch-time is a SEPARATE, scope-gated call - a missing
    // yt-analytics.readonly grant (or any other failure) degrades silently
    // (P9): the row stays ok:true and the base statistics above still render.
    try {
      const extra = await fetchYtWatchTime(token, post.ytVideoId);
      if (extra) Object.assign(metrics, extra);
    } catch (err) {
      if (err.status === 403) console.log(`[warn] ${post.id}: watch-time needs yt-analytics.readonly - base stats only.`);
      else console.log(`[warn] ${post.id}: watch-time fetch failed - ${String(err.message || err).slice(0, 200)}`);
    }
    RUN.results.push({ postId: post.id, platform: 'youtube', action: 'insights', ok: true, id: post.ytVideoId, metrics });
    console.log(`[ok] ${post.id}: YT ${JSON.stringify(metrics)}`);
  }
  console.log(`[done] insights complete - ${RUN.results.filter((r) => r.ok).length} fetched.`);
}

// Parse a YouTube Analytics reports() response (rows of [ageGroup, gender,
// viewerPercentage]) into {age:{...}, gender:{...}} - each bucket sums its
// viewerPercentage across the other dimension, so age/gender are independently
// browsable even though the report is jointly dimensioned.
function parseYtDemographics(data) {
  const age = {};
  const gender = {};
  for (const row of data?.rows || []) {
    const [ageGroup, genderVal, pct] = row;
    const v = Number(pct) || 0;
    if (ageGroup) age[ageGroup] = Number(((age[ageGroup] || 0) + v).toFixed(2));
    if (genderVal) gender[genderVal] = Number(((gender[genderVal] || 0) + v).toFixed(2));
  }
  return { age, gender };
}

// Account-scoped channel demographics (spec 07, Pattern P5) - called ONCE per
// evidence campaign by the insights sweep's generic account pass (spec 04). Reads
// the YouTube Analytics API (a DIFFERENT host from the Data API `api()` targets),
// so it has its own fetch here rather than reusing api(). Needs the
// yt-analytics.readonly scope; missing it degrades to the structured needs_scope
// shape (P9), never a throw. Emits ONE account row { postId:null,
// platform:'youtube', action:'demographics', ok, scope:'account', demographics:{} }.
async function cmdDemographics() {
  const accountRow = (extra) => ({ postId: null, platform: 'youtube', action: 'demographics', scope: 'account', ...extra });
  let token;
  try {
    token = await getAccessToken();
  } catch (err) {
    RUN.results.push(accountRow({ ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) }));
    return;
  }
  const end = new Date();
  const start = new Date(end.getTime() - 90 * 24 * 60 * 60 * 1000); // a wide window - demographics change slowly
  const fmt = (d) => d.toISOString().slice(0, 10);
  const url = new URL(`${ANALYTICS_API}/reports`);
  url.searchParams.set('ids', 'channel==MINE');
  url.searchParams.set('dimensions', 'ageGroup,gender');
  url.searchParams.set('metrics', 'viewerPercentage');
  url.searchParams.set('startDate', fmt(start));
  url.searchParams.set('endDate', fmt(end));
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const e = data.error || {};
      const reason = e.errors?.[0]?.reason || '';
      const err = new Error(`YouTube Analytics GET /reports: HTTP ${res.status} ${reason} - ${e.message || text || ''}`);
      err.status = res.status;
      err.reason = reason;
      throw err;
    }
    RUN.results.push(accountRow({ ok: true, demographics: parseYtDemographics(data) }));
    console.log('[ok] demographics fetched.');
  } catch (err) {
    // spec-15 quota mislabel fix: a quota/rate-limit 403 is NOT "reconnect to
    // authorize" (ytNeedsScope excludes it) - it reads engine_failure with the
    // real message instead.
    if (ytNeedsScope(err)) {
      RUN.results.push(accountRow({ ok: false, error: 'needs_scope', scope: 'yt-analytics.readonly' }));
      console.log('[warn] demographics: yt-analytics.readonly scope not granted - no audience data available yet.');
      return;
    }
    RUN.results.push(accountRow({ ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 300) }));
    console.log(`[warn] demographics failed: ${String(err.message || err).slice(0, 200)}`);
  }
}

// Post-hoc thumbnail application for already-uploaded videos (ytVideoId set +
// post.cover materialized). thumbnails.set is re-callable, so this also
// REPLACES an earlier custom thumbnail.
async function cmdSetThumbnail(args) {
  const { abs, plan } = loadPlan(args.plan);
  const token = args['dry-run'] ? null : await getAccessToken();
  let applied = 0;
  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isYouTube(post)) continue;
    const coverPath = resolveCoverPath(post);
    if (!coverPath) {
      if (args.only) console.log(`[skip] ${post.id}: no materialized cover override (set one via pendpost first).`);
      continue;
    }
    if (!post.ytVideoId) {
      if (args.only) console.log(`[skip] ${post.id}: no ytVideoId yet - the thumbnail applies automatically at schedule.`);
      continue;
    }
    if (args['dry-run']) {
      console.log(`[dry] ${post.id}: would set thumbnail of ${post.ytVideoId} from ${coverPath}.`);
      continue;
    }
    try {
      await setThumbnail(post.ytVideoId, coverPath, token);
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'youtube', action: 'set-thumbnail', ok: true, errorCode: null, errorMessage: null, lateMin: 0, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'youtube', action: 'set-thumbnail', ok: true, id: post.ytVideoId });
      console.log(`[ok] ${post.id}: thumbnail of ${post.ytVideoId} updated.`);
      applied += 1;
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'youtube', action: 'set-thumbnail', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), lateMin: 0, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'youtube', action: 'set-thumbnail', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: thumbnail failed - ${err.message}`);
    }
  }
  console.log(`[done] set-thumbnail complete - ${applied} thumbnail(s) applied.`);
}

// Post-hoc / standalone SRT caption insertion (mirrors cmdSetThumbnail). Default
// source is resolveCaptionPath (owner captionPath, else the <media>.<lang>.srt
// sibling); --file overrides for a one-off track (--lang fr --name Francais), which
// records post.ytCaptionId only for the default resolved track. LIVE-only (absent
// from MOCKABLE_COMMANDS).
async function cmdCaption(args) {
  if (resolveMode('youtube') === 'mock') { console.log('[mock] caption is live-only - skipped in mock mode (no real YouTube call).'); return; }
  const { abs, plan } = loadPlan(args.plan);
  const token = args['dry-run'] ? null : await getAccessToken();
  let applied = 0;
  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isYouTube(post)) continue;
    const lang = typeof args.lang === 'string' ? args.lang : (post.captionLang || 'en');
    const name = typeof args.name === 'string' ? args.name : lang.toUpperCase();
    let srtPath;
    if (args.file) {
      srtPath = path.resolve(args.file);
      if (!fs.existsSync(srtPath)) { if (args.only) console.log(`[skip] ${post.id}: --file not found (${srtPath}).`); continue; }
    } else {
      srtPath = resolveCaptionPath(post);
    }
    if (!srtPath) {
      if (args.only) console.log(`[skip] ${post.id}: no SRT (set captionPath or place a <media>.${(post.captionLang || 'en')}.srt sibling next to the media).`);
      continue;
    }
    if (!post.ytVideoId) {
      if (args.only) console.log(`[skip] ${post.id}: no ytVideoId yet - the caption applies automatically at schedule.`);
      continue;
    }
    if (args['dry-run']) {
      console.log(`[dry] ${post.id}: would insert ${lang} caption "${name}" of ${post.ytVideoId} from ${srtPath}.`);
      continue;
    }
    try {
      const cap = await setCaption(post.ytVideoId, srtPath, { language: lang, name }, token);
      if (!args.file) post.ytCaptionId = cap.id;
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'youtube', action: 'set-caption', ok: true, errorCode: null, errorMessage: null, lateMin: 0, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'youtube', action: 'set-caption', ok: true, id: post.ytVideoId });
      console.log(`[ok] ${post.id}: ${lang} caption "${name}" inserted on ${post.ytVideoId}.`);
      applied += 1;
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'youtube', action: 'set-caption', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), lateMin: 0, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'youtube', action: 'set-caption', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: caption insert failed - ${err.message}`);
    }
  }
  console.log(`[done] caption complete - ${applied} caption track(s) inserted.`);
}

// Post-hoc / standalone first-comment posting (the reliable path once the video is
// public). Skips no firstComment / no ytVideoId / already-posted (unless --force).
// The API posts as the channel but CANNOT pin - the owner pins it in YouTube Studio.
// LIVE-only (absent from MOCKABLE_COMMANDS).
async function cmdComment(args) {
  if (resolveMode('youtube') === 'mock') { console.log('[mock] comment is live-only - skipped in mock mode (no real YouTube call).'); return; }
  const { abs, plan } = loadPlan(args.plan);
  const token = args['dry-run'] ? null : await getAccessToken();
  let posted = 0;
  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isYouTube(post)) continue;
    if (!post.firstComment) { if (args.only) console.log(`[skip] ${post.id}: no firstComment set.`); continue; }
    if (!post.ytVideoId) { if (args.only) console.log(`[skip] ${post.id}: no ytVideoId yet.`); continue; }
    if (post.ytCommentId && args.force !== true) {
      if (args.only) console.log(`[skip] ${post.id}: comment already posted (${post.ytCommentId}) - pass --force to post again.`);
      continue;
    }
    if (args['dry-run']) {
      console.log(`[dry] ${post.id}: would post a comment on ${post.ytVideoId}:`);
      console.log(post.firstComment.split('\n').map((l) => `        ${l}`).join('\n'));
      continue;
    }
    try {
      const thread = await postComment(post.ytVideoId, post.firstComment, token);
      post.ytCommentId = thread.id;
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'youtube', action: 'post-comment', ok: true, errorCode: null, errorMessage: null, lateMin: 0, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'youtube', action: 'post-comment', ok: true, id: thread.id });
      console.log(`[ok] ${post.id}: comment posted (${thread.id}) - pin it manually in YouTube Studio.`);
      posted += 1;
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'youtube', action: 'post-comment', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), lateMin: 0, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'youtube', action: 'post-comment', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: comment failed (a private/scheduled video cannot take a comment) - ${err.message}`);
    }
  }
  console.log(`[done] comment complete - ${posted} comment(s) posted.`);
}

// Spec 45: publish-radar - the Radar reply-to-external lane for YouTube. YouTube's `schedule`
// command NATIVELY schedules a VIDEO UPLOAD (fires BEFORE due, requires a media file), so a
// Radar reply - a due-now, media-less top-level COMMENT on an EXTERNAL video - cannot ride it.
// This dedicated command mirrors scripts/bluesky-social.mjs cmdPublishDue: it fires ONLY a post
// carrying post.radarReplyTo (never a general upload), posting a top-level comment via
// commentThreads.insert on rr.externalId (the videoId). The scheduler routes it here through the
// LOCAL-only `youtube-reply` lane (lib/scheduler.mjs). It reached here only after a DISTINCT
// human approved it - YouTube is absent from RADAR_AUTO_REPLY_LANES, so a public comment on a
// stranger's video is NEVER auto-posted. Fail-closed: a gone/404 video (deleted / comments
// disabled) => radar_target_gone (TERMINAL - lanesFor stops firing the lane), 401/403 =>
// needs_scope, anything else => engine_failure. LIVE-only (mock mode is a no-op).
async function cmdPublishRadar(args) {
  if (resolveMode('youtube') === 'mock') { console.log('[mock] publish-radar is live-only - skipped in mock mode (no real YouTube call).'); return; }
  const { abs, plan } = loadPlan(args.plan);
  const now = Date.now();
  let token = null;
  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!post.radarReplyTo) continue; // this lane fires ONLY Radar replies - never a general upload
    const rr = post.radarReplyTo;
    // WRONG-TARGET guard: fire ONLY when the reply's source is this lane. A source<->platform
    // mismatch is rejected at create (validateFieldValues); this is the fire-time backstop.
    if (rr.source !== 'youtube') { RUN.results.push({ postId: post.id, platform: 'youtube', action: 'publish', ok: false, errorCode: 'invalid_input', errorMessage: `radarReplyTo.source '${rr.source}' does not match the youtube lane` }); continue; }
    if (post.executionMode !== 'fully-scheduled') continue;
    if (post.status === 'posted' || post.ytCommentId) continue; // idempotent - a fired reply never re-posts
    if (post.radarReplyState === 'target_gone') continue; // terminal - never re-attempt a dead video
    // Publish hold (lib/publish-hold.mjs): the failure cap is spent - never re-fire on
    // its own. Backstop for direct CLI runs; the scheduler's lanesOwed already drops a
    // held post from the fire loop. Reschedule or edit clears the hold.
    if (post.publishHold) {
      console.log(`[skip] ${post.id}: publish hold after repeated failures (${post.publishHold.code ?? post.publishHold.message ?? 'unknown'}) - reschedule or edit the post to retry.`);
      continue;
    }
    if ((post.approval || 'draft') !== 'approved') { console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish.`); continue; }
    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs) || dueMs > now) continue;
    const body = String(post.caption || '').trim();
    if (!body) { RUN.results.push({ postId: post.id, platform: 'youtube', action: 'publish', ok: false, errorCode: 'invalid_input', errorMessage: 'radar reply needs a caption' }); continue; }
    if (args['dry-run']) { console.log(`[dry] ${post.id}: would comment on video ${rr.externalId} (${body.length} chars).`); continue; }
    if (!token) {
      try { token = await getAccessToken(); }
      catch (err) { RUN.results.push({ postId: post.id, platform: 'youtube', action: 'publish', ok: false, errorCode: 'needs_scope', errorMessage: String(err.message || err).slice(0, 200) }); continue; }
    }
    try {
      // postComment sets snippet.videoId = rr.externalId (the video the comment lands under).
      const thread = await postComment(String(rr.externalId), body, token);
      post.ytCommentId = thread.id;
      post.status = 'posted';
      post.postedAt = new Date(now).toISOString();
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'youtube', action: 'publish', ok: true, errorCode: null, errorMessage: null, lateMin: 0, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'youtube', action: 'publish', ok: true, id: thread.id, radarReply: rr.externalId });
      console.log(`[ok] ${post.id}: commented on YouTube video ${rr.externalId} (${thread.id}).`);
    } catch (err) {
      const status = err && err.status;
      const gone = status === 404; // a deleted video / comments disabled - TERMINAL, never re-fired
      const code = gone ? 'radar_target_gone' : ((status === 401 || status === 403) ? 'needs_scope' : 'engine_failure');
      if (gone) post.radarReplyState = 'target_gone';
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'youtube', action: 'publish', ok: false, errorCode: code, errorMessage: String(err.message || err).slice(0, 300), lateMin: 0, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'youtube', action: 'publish', ok: false, errorCode: code, errorMessage: String(err.message || err).slice(0, 300) });
    }
  }
}

// Shared GET-merge-PUT over channels?part=brandingSettings(,localizations) (spec 28):
// generalizes cmdFeatured's original inline GET-merge-PUT so cmdProfile reuses the
// EXACT same read-merge-write shape instead of duplicating it. `parts` controls which
// parts are requested/written - cmdFeatured only ever touches brandingSettings
// (unchanged behavior); cmdProfile also touches localizations when the operator
// supplies a --localizations override. `mergeFn({brandingSettings, localizations})`
// returns the merged `{brandingSettings, localizations}` to PUT back; only the parts
// named in `parts` are sent, so a caller that never asked for localizations can never
// accidentally clobber it (the Data API only mutates the parts named in the request).
async function updateBranding(token, parts, mergeFn) {
  const partStr = parts.join(',');
  const chan = await api('GET', '/channels', { query: { part: partStr, mine: 'true' }, token });
  const channel = chan.items && chan.items[0];
  if (!channel) throw new Error('no YouTube channel on this account');
  const patch = mergeFn({ brandingSettings: channel.brandingSettings || {}, localizations: channel.localizations || {} });
  const body = { id: channel.id };
  if (parts.includes('brandingSettings')) body.brandingSettings = patch.brandingSettings;
  if (parts.includes('localizations')) body.localizations = patch.localizations;
  await api('PUT', '/channels', { query: { part: partStr }, body, token });
  return channel;
}

// Set the channel's featured video (unsubscribedTrailer, shown on the channel
// homepage to non-subscribers) via channels.update?part=brandingSettings: resolve
// the videoId (--id, else --plan/--only -> post.ytVideoId), GET current branding,
// merge unsubscribedTrailer, PUT it back. The video MUST be public to display.
async function cmdFeatured(args) {
  if (resolveMode('youtube') === 'mock') { console.log('[mock] featured is live-only - skipped in mock mode (no real YouTube call).'); return; }
  let videoId = typeof args.id === 'string' ? args.id : null;
  if (!videoId && args.plan && args.only) {
    const { plan } = loadPlan(args.plan);
    const post = (plan.posts || []).find((p) => p.id === args.only && isYouTube(p));
    videoId = post && post.ytVideoId ? post.ytVideoId : null;
  }
  if (!videoId) {
    console.error('[err] featured requires --id <videoId> (or --plan <p> --only <postId> with a scheduled ytVideoId).');
    process.exit(2);
  }
  if (args['dry-run']) {
    console.log(`[dry] would set the channel trailer (unsubscribedTrailer) to ${videoId}.`);
    return;
  }
  const token = await getAccessToken();
  try {
    const v = await api('GET', '/videos', { query: { part: 'status', id: videoId }, token });
    const privacy = v.items && v.items[0] && v.items[0].status && v.items[0].status.privacyStatus;
    if (!v.items || !v.items.length) console.warn(`[warn] video ${videoId} not found on this channel - setting anyway.`);
    else if (privacy !== 'public') console.warn(`[warn] video ${videoId} is "${privacy}", not public - the channel trailer only displays once it is public.`);
  } catch (err) {
    console.warn(`[warn] could not check video privacy - ${err.message}`);
  }
  const channel = await updateBranding(token, ['brandingSettings'], ({ brandingSettings }) => ({
    brandingSettings: { ...brandingSettings, channel: { ...(brandingSettings.channel || {}), unsubscribedTrailer: videoId } },
  }));
  console.log(`[ok] channel trailer (featured video) set to ${videoId} on channel ${channel.id}.`);
  console.log('     Verify in YouTube Studio -> Customization -> Layout.');
}

// Read-only liveness probe for the pendpost health bar: prove the refresh token
// still mints an access token AND the account still owns a channel. ~1 quota
// unit. Pre-checks env (readEnv, NOT requireEnv) so a missing token returns an
// ok:false envelope row instead of process.exit-ing past the --json envelope.
// Takes no --plan; cannot touch any post.
async function cmdProbe() {
  if (!readEnv('YT_REFRESH_TOKEN') || !readEnv('YT_CLIENT_ID') || !readEnv('YT_CLIENT_SECRET')) {
    RUN.results.push({ platform: 'youtube', action: 'probe', ok: false, detail: 'not connected (credentials missing)' });
    return;
  }
  try {
    const token = await getAccessToken();
    const chan = await api('GET', '/channels', { query: { part: 'id,snippet', mine: 'true' }, token });
    const ch = chan.items?.[0];
    if (ch) RUN.results.push({ platform: 'youtube', action: 'probe', ok: true, detail: `${ch.snippet?.title || 'Channel'} (${ch.id})` });
    else RUN.results.push({ platform: 'youtube', action: 'probe', ok: false, detail: 'Token valid, but no YouTube channel found' });
  } catch (err) {
    RUN.results.push({ platform: 'youtube', action: 'probe', ok: false, detail: String(err.message || err).slice(0, 200) });
  }
}

// ---------- profile editing (spec 28 - the shipped X `profile` pattern, cloned) ----------
//
// YouTube's channel "profile" is brandingSettings (description/keywords/country/
// defaultLanguage) + localizations (per-language description overrides) - NOT
// snippet.title, which channels.update never accepts (the channel display name is
// account-level, set outside the Data API - spec §3). `apply` reuses updateBranding()
// (the GET-merge-PUT cmdFeatured established above) so a partial edit never clobbers
// fields the operator did not touch.

// The SAME 403->needs_scope classification api()'s err.status enables elsewhere
// (spec 15 playlists was the first caller); the `youtube` (write) scope is required
// for channels.update (youtube.readonly cannot write branding).
//
// spec-15 quota mislabel fix (also resolves spec-28 review NIT-8): a 403 can be
// Google's quota/rate-limit signal instead of a genuinely missing OAuth scope -
// reading it as "authorize" tells the owner to reconnect when the real fix is
// "wait" (or raise the quota). EXCLUDE the quota reasons so those read
// engine_failure (with the real message) instead.
const YT_QUOTA_REASONS = new Set(['quotaExceeded', 'rateLimitExceeded', 'dailyLimitExceeded']);
function ytNeedsScope(err) {
  return Boolean(err) && err.status === 403 && !YT_QUOTA_REASONS.has(err.reason);
}

export async function cmdProfile(args) {
  if (!readEnv('YT_REFRESH_TOKEN') || !readEnv('YT_CLIENT_ID') || !readEnv('YT_CLIENT_SECRET')) {
    throw new Error('YouTube profile editing needs YT_CLIENT_ID/YT_CLIENT_SECRET/YT_REFRESH_TOKEN in .env (run `auth` first).');
  }

  // --probe: the STEP 0 access-tier gate. Non-mutating: read the channel identity only.
  if (args.probe) {
    const expected = readEnv('YT_CHANNEL_ID') || null;
    try {
      const token = await getAccessToken();
      const chan = await api('GET', '/channels', { query: { part: 'id,snippet', mine: 'true' }, token });
      const ch = chan.items?.[0];
      if (!ch) { RUN.results.push({ platform: 'youtube', action: 'profile-probe', ok: false, tier: 'error', detail: 'token valid, but no YouTube channel found' }); return; }
      const handleMatches = expected ? expected === ch.id : null;
      RUN.results.push({ platform: 'youtube', action: 'profile-probe', ok: true, tier: 'permitted', channelId: ch.id, expectedChannelId: expected, handleMatches, detail: `${ch.snippet?.title || 'Channel'} (${ch.id})${expected ? ` (expected ${expected}${handleMatches ? '' : ' - MISMATCH'})` : ''}` });
    } catch (err) {
      const tier = ytNeedsScope(err) ? 'blocked' : 'error';
      RUN.results.push({ platform: 'youtube', action: 'profile-probe', ok: false, tier, detail: String(err.message || err).slice(0, 300) });
    }
    return;
  }

  const description = typeof args.description === 'string' ? args.description : null;
  const keywords = typeof args.keywords === 'string' ? args.keywords : null;
  const country = typeof args.country === 'string' ? args.country : null;
  const defaultLanguage = typeof args.defaultLanguage === 'string' ? args.defaultLanguage : null;
  let localizations = null;
  if (typeof args.localizations === 'string' && args.localizations.trim()) {
    try { localizations = JSON.parse(args.localizations); } catch { throw new Error('--localizations must be valid JSON ({"<lang>":{"description":"..."}, ...}).'); }
  }
  if (description == null && keywords == null && country == null && defaultLanguage == null && !localizations) {
    throw new Error('nothing to update - pass at least one of --description --keywords --country --defaultLanguage --localizations (or --probe).');
  }
  if (description != null && description.length > 1000) throw new Error(`--description is ${description.length} chars - YouTube caps the channel description at 1000.`);

  const token = await getAccessToken();

  // Wrong-account guard: never edit a sibling client's channel.
  const expected = readEnv('YT_CHANNEL_ID');
  if (!expected) throw new Error('YT_CHANNEL_ID is not set in .env - refusing to edit a channel I cannot identify (run `discover` first, or set YT_CHANNEL_ID).');
  const identity = await api('GET', '/channels', { query: { part: 'id', mine: 'true' }, token });
  const actualId = identity.items?.[0]?.id;
  if (!actualId) throw new Error('could not read the authenticated channel id - aborting before any profile edit.');
  if (actualId !== expected) throw new Error(`refusing to edit profile: authenticated channel is ${actualId} but .env expects ${expected} (YT_CHANNEL_ID) - wrong account, aborted.`);

  if (args['dry-run']) {
    const changes = [];
    if (description != null) changes.push(`description(${description.length})`);
    if (keywords != null) changes.push(`keywords="${keywords}"`);
    if (country != null) changes.push(`country="${country}"`);
    if (defaultLanguage != null) changes.push(`defaultLanguage="${defaultLanguage}"`);
    if (localizations) changes.push(`localizations(${Object.keys(localizations).length} locale(s))`);
    console.error(`[dry] ${actualId}: would update ${changes.join(', ')}.`);
    RUN.results.push({ platform: 'youtube', action: 'profile-dry-run', ok: true, channelId: actualId, changes });
    return;
  }

  const parts = localizations ? ['brandingSettings', 'localizations'] : ['brandingSettings'];
  try {
    const channel = await updateBranding(token, parts, ({ brandingSettings, localizations: currentLoc }) => {
      const channelBranding = { ...(brandingSettings.channel || {}) };
      if (description != null) channelBranding.description = description;
      if (keywords != null) channelBranding.keywords = keywords;
      if (country != null) channelBranding.country = country;
      if (defaultLanguage != null) channelBranding.defaultLanguage = defaultLanguage;
      const mergedLoc = { ...currentLoc };
      if (localizations) {
        for (const [lang, val] of Object.entries(localizations)) mergedLoc[lang] = { ...(mergedLoc[lang] || {}), ...val };
      }
      return { brandingSettings: { ...brandingSettings, channel: channelBranding }, localizations: mergedLoc };
    });
    RUN.results.push({ platform: 'youtube', action: 'profile-update', ok: true, channelId: channel.id });
    console.error(`[ok] channel ${channel.id}: branding updated.`);
  } catch (err) {
    if (ytNeedsScope(err)) {
      RUN.results.push({ platform: 'youtube', action: 'profile-update', ok: false, error: 'needs_scope', scope: 'youtube', errorMessage: String(err.message || err).slice(0, 300) });
      console.error(`[err] profile update needs the youtube (write) scope - ${err.message}`);
      return;
    }
    RUN.results.push({ platform: 'youtube', action: 'profile-update', ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 300) });
    console.error(`[err] profile-update failed - ${err.message}`);
  }
}

// Connected-account discovery (spec 22, Pattern P3): who does this token
// authenticate as, and which channels can it manage? Reads env creds via readEnv
// (NOT requireEnv) so a missing token degrades to an ok:false row instead of
// process.exit-ing past the --json envelope (models cmdProbe). Reuses the same
// channels.list identity read; a Brand Account may own several channels (mine +
// managedByMe), so it lists them all to pick from. Takes no --plan.
async function cmdDiscover() {
  const { discoverOk, discoverNeedsScope, discoverAuthError, markCurrent } = await import('../lib/discovery.mjs');
  if (!readEnv('YT_REFRESH_TOKEN') || !readEnv('YT_CLIENT_ID') || !readEnv('YT_CLIENT_SECRET')) {
    RUN.results.push(discoverNeedsScope('youtube'));
    return;
  }
  try {
    const token = await getAccessToken();
    const own = await api('GET', '/channels', { query: { part: 'snippet,contentDetails', mine: 'true' }, token });
    const items = [...(own.items || [])];
    try {
      const managed = await api('GET', '/channels', { query: { part: 'snippet,contentDetails', managedByMe: 'true' }, token });
      for (const ch of managed.items || []) if (!items.some((c) => c.id === ch.id)) items.push(ch);
    } catch { /* managedByMe needs a Content Owner credential; ignore when absent */ }
    const sealed = readEnv('YT_CHANNEL_ID') || null;
    if (!items.length) {
      RUN.results.push(discoverOk('youtube', { identity: { id: '', name: 'YouTube' }, assets: [], selected: { ytChannelId: sealed } }));
      return;
    }
    const assets = markCurrent(items.map((ch) => ({
      kind: 'channel', id: ch.id, name: ch.snippet?.title || ch.id,
      meta: ch.snippet?.customUrl ? { handle: ch.snippet.customUrl } : undefined,
    })), sealed);
    const primary = assets.find((a) => a.current) || assets[0];
    const primaryRaw = items.find((ch) => ch.id === primary.id) || items[0];
    RUN.results.push(discoverOk('youtube', {
      identity: { id: primary.id, handle: primaryRaw.snippet?.customUrl || null, name: primary.name, avatarUrl: primaryRaw.snippet?.thumbnails?.default?.url },
      assets,
      selected: { ytChannelId: sealed },
    }));
  } catch (err) {
    RUN.results.push(discoverAuthError('youtube', err.message || err));
  }
}

// Read-only verification (read-back): confirm whether a handed-off post is
// actually live on YouTube. Pure GET (~1 quota unit, batched), writes NOTHING -
// prints a per-platform envelope pendpost's lib/verify.mjs consumes and
// persists as the post.verify block. pendpost turns the guessed
// 'fired-assumed' (probably published) state into verified fact from this.
async function cmdVerify(args) {
  const { plan } = loadPlan(args.plan);
  const token = await getAccessToken();
  const targets = (plan.posts || []).filter((p) => (!args.only || p.id === args.only) && isYouTube(p) && p.ytVideoId);
  if (!targets.length) { console.log('[done] verify complete - no posts with a ytVideoId.'); return; }
  let items = [];
  try {
    const data = await api('GET', '/videos', { query: { part: 'status', id: targets.map((p) => p.ytVideoId).join(',') }, token });
    items = data.items || [];
  } catch (err) {
    for (const post of targets) RUN.results.push({ postId: post.id, platform: 'youtube', action: 'verify', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
    console.error(`[err] videos.list failed - ${err.message}`);
    return;
  }
  const now = Date.now();
  for (const post of targets) {
    const v = items.find((i) => i.id === post.ytVideoId);
    let state = 'missing';
    let live = false;
    let permalink = null;
    if (v) {
      permalink = `https://youtu.be/${post.ytVideoId}`;
      const privacy = v.status?.privacyStatus;
      const publishAt = v.status?.publishAt ? Date.parse(v.status.publishAt) : NaN;
      if (privacy === 'public') { state = 'public'; live = true; }
      else if (!Number.isNaN(publishAt) && publishAt > now) { state = 'scheduled'; }
      else { state = 'private-overdue'; }
    }
    RUN.results.push({ postId: post.id, platform: 'youtube', action: 'verify', ok: true, id: post.ytVideoId, live, state, permalink });
    console.log(`[ok] ${post.id}: YT verify state=${state} live=${live}`);
  }
  console.log(`[done] verify complete - ${RUN.results.length} checked.`);
}

// Recover a natively-scheduled video YouTube left PRIVATE past its publishAt
// (verify read-back state 'private-overdue'): flip it public via a metadata-only
// videos.update - NEVER a re-upload (the bytes are already on YouTube; re-running
// `schedule` would mint a duplicate). The pendpost scheduler owes this 'release'
// only once the id exists AND the read-back says private-overdue (lib/scheduler.mjs
// lanesFor), so in normal operation the GET-status guard below just confirms the
// state; the guard also keeps a bare CLI `release --plan X` idempotent and safe -
// an already-public video is a no-op, a still-future schedule is left untouched.
async function cmdRelease(args) {
  const { abs, plan } = loadPlan(args.plan);
  const token = await getAccessToken();
  const targets = (plan.posts || []).filter((p) => (!args.only || p.id === args.only) && isYouTube(p) && p.ytVideoId);
  if (!targets.length) { console.log('[done] release complete - no posts with a ytVideoId.'); return; }
  let items = [];
  try {
    const data = await api('GET', '/videos', { query: { part: 'status', id: targets.map((p) => p.ytVideoId).join(',') }, token });
    items = data.items || [];
  } catch (err) {
    for (const post of targets) RUN.results.push({ postId: post.id, platform: 'youtube', action: 'release', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
    console.error(`[err] videos.list failed - ${err.message}`);
    return;
  }
  const now = Date.now();
  for (const post of targets) {
    const v = items.find((i) => i.id === post.ytVideoId);
    const permalink = `https://youtu.be/${post.ytVideoId}`;
    if (!v) {
      RUN.results.push({ postId: post.id, platform: 'youtube', action: 'release', ok: false, errorCode: 'engine_failure', errorMessage: `video ${post.ytVideoId} not found (deleted?)` });
      console.log(`[warn] ${post.id}: video ${post.ytVideoId} missing - cannot release.`);
      continue;
    }
    const privacy = v.status?.privacyStatus;
    const publishAt = v.status?.publishAt ? Date.parse(v.status.publishAt) : NaN;
    if (privacy === 'public') {
      RUN.results.push({ postId: post.id, platform: 'youtube', action: 'release', ok: true, id: post.ytVideoId, live: true, state: 'public', permalink });
      console.log(`[ok] ${post.id}: already public - no action.`);
      continue;
    }
    if (!Number.isNaN(publishAt) && publishAt > now) {
      RUN.results.push({ postId: post.id, platform: 'youtube', action: 'release', ok: false, errorCode: 'invalid_input', errorMessage: `still natively scheduled for ${v.status.publishAt} - not releasing early` });
      console.log(`[skip] ${post.id}: still scheduled (publishAt ${v.status.publishAt}) - not releasing early.`);
      continue;
    }
    // private-overdue: YouTube did NOT auto-publish at publishAt. Make it public now.
    // part=status REPLACES the status part, so selfDeclaredMadeForKids must be re-sent
    // (mirrors buildMeta) and publishAt is omitted to clear the (passed) schedule.
    try {
      await api('PUT', '/videos', { query: { part: 'status' }, body: { id: post.ytVideoId, status: { privacyStatus: 'public', selfDeclaredMadeForKids: false } }, token });
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'youtube', action: 'release', ok: true, errorCode: null, errorMessage: null, lateMin: 0, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'youtube', action: 'release', ok: true, id: post.ytVideoId, live: true, state: 'public', permalink });
      console.log(`[ok] ${post.id}: released - video ${post.ytVideoId} is now public.`);
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'youtube', action: 'release', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), lateMin: 0, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'youtube', action: 'release', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: release failed - ${err.message}`);
    }
  }
  console.log('[done] release complete.');
}

// ---------- edit (spec 12, Pattern P3+P9): push a metadata edit to an already-
// published video, WITHOUT re-uploading bytes ----------
// videos.update part=snippet REPLACES the whole snippet, and categoryId is a
// REQUIRED field on update (mirrors the part=status "must re-send
// selfDeclaredMadeForKids" gotcha at cmdRelease above) - so buildMeta's full
// snippet (it already sets categoryId/title/description/tags/language) is
// re-sent verbatim. Never touches status (privacy/schedule unchanged) and never
// insertVideo (no re-upload). A post with no ytVideoId no-ops with a clear
// result, so a bare CLI run is safe - it never mints/clears an id.
export async function cmdEdit(args) {
  const { abs, plan } = loadPlan(args.plan);
  const targets = (plan.posts || []).filter((p) => (!args.only || p.id === args.only) && isYouTube(p));
  if (!targets.length) { console.log('[done] edit complete - no matching posts.'); return; }
  // Spec 12 review (nit #6): mint the token LAZILY, only once a post that actually
  // NEEDS the API call is reached - not upfront. requireEnv() (inside
  // getAccessToken) hard process.exit(1)s on missing creds, so minting it before
  // the no-minted-id skip check crashed a bare CLI `edit` over unminted posts
  // instead of emitting the clean skip row below.
  let token = null;
  let edited = 0;
  for (const post of targets) {
    if (!post.ytVideoId) {
      RUN.results.push({ postId: post.id, platform: 'youtube', action: 'edit', ok: true, skipped: 'no_minted_id' });
      console.log(`[skip] ${post.id}: no ytVideoId - nothing published to edit yet.`);
      continue;
    }
    if (!token) token = await getAccessToken();
    try {
      const meta = buildMeta(post);
      await api('PUT', '/videos', { query: { part: 'snippet' }, body: { id: post.ytVideoId, snippet: meta.snippet }, token });
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'youtube', action: 'edit', ok: true, errorCode: null, errorMessage: null, lateMin: 0, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'youtube', action: 'edit', ok: true, id: post.ytVideoId });
      console.log(`[ok] ${post.id}: video ${post.ytVideoId} snippet updated.`);
      edited += 1;
    } catch (err) {
      if (ytNeedsScope(err)) {
        RUN.results.push({ postId: post.id, platform: 'youtube', action: 'edit', ok: false, error: 'needs_scope', scope: 'youtube' });
        console.log(`[warn] ${post.id}: edit needs the youtube (or youtube.force-ssl) write scope - reconnect to grant it.`);
        continue;
      }
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'youtube', action: 'edit', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), lateMin: 0, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'youtube', action: 'edit', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: edit failed - ${err.message}`);
    }
  }
  console.log(`[done] edit complete - ${edited} video(s) updated.`);
}

// ---------- playlists (spec 15, Pattern P3+P4+P9) ----------
// pendpost publishes videos but never files them into a playlist - the operator
// used to open YouTube Studio after every upload to do that by hand. These three
// verbs (list/create/add) close that gap with zero new deps, riding the SAME
// getAccessToken()/api() the rest of the engine uses. A 403 (a token minted before
// this feature shipped, with only youtube.upload) degrades to the structured
// needs_scope shape (P9), never a throw - a reconnect grants the fuller scope.

// GET /playlists - this channel's playlists (paged). contentDetails is requested
// ALONGSIDE the spec's literal snippet,status (itemCount lives only in
// contentDetails - snippet/status alone cannot produce it).
async function cmdPlaylistsList() {
  const token = await getAccessToken();
  try {
    const playlists = [];
    let pageToken;
    do {
      const data = await api('GET', '/playlists', {
        query: { part: 'snippet,status,contentDetails', mine: 'true', maxResults: 50, ...(pageToken ? { pageToken } : {}) },
        token,
      });
      for (const p of data.items || []) {
        playlists.push({ id: p.id, title: p.snippet?.title || p.id, privacy: p.status?.privacyStatus || null, itemCount: p.contentDetails?.itemCount ?? 0 });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    RUN.results.push({ platform: 'youtube', action: 'playlists-list', ok: true, playlists });
    console.log(`[ok] playlists-list: ${playlists.length} playlist(s).`);
  } catch (err) {
    if (ytNeedsScope(err)) {
      RUN.results.push({ platform: 'youtube', action: 'playlists-list', ok: false, error: 'needs_scope', scope: 'youtube' });
      console.log('[warn] playlists-list: needs the youtube (or youtube.force-ssl) scope - reconnect to grant it.');
      return;
    }
    RUN.results.push({ platform: 'youtube', action: 'playlists-list', ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 300) });
    console.error(`[err] playlists-list failed - ${err.message}`);
  }
}

// POST /playlists - create a playlist. Takes --title (NOT --plan), like probe/
// featured - deliberately NOT added to the plan-required guard in main().
async function cmdPlaylistCreate(args) {
  if (typeof args.title !== 'string' || !args.title.trim()) {
    console.error('[err] playlist-create requires --title "..." [--description "..."] [--privacy public|unlisted|private]');
    process.exit(2);
  }
  const token = await getAccessToken();
  const privacyStatus = typeof args.privacy === 'string' && args.privacy.trim() ? args.privacy.trim() : 'private';
  try {
    const data = await api('POST', '/playlists', {
      query: { part: 'snippet,status' },
      body: {
        snippet: { title: args.title, description: typeof args.description === 'string' ? args.description : '' },
        status: { privacyStatus },
      },
      token,
    });
    RUN.results.push({ platform: 'youtube', action: 'playlist-create', ok: true, id: data.id, title: data.snippet?.title || args.title });
    console.log(`[ok] playlist-create: "${data.snippet?.title || args.title}" (${data.id}).`);
  } catch (err) {
    if (ytNeedsScope(err)) {
      RUN.results.push({ platform: 'youtube', action: 'playlist-create', ok: false, error: 'needs_scope', scope: 'youtube' });
      console.log('[warn] playlist-create: needs the youtube (or youtube.force-ssl) write scope - reconnect to grant it.');
      return;
    }
    RUN.results.push({ platform: 'youtube', action: 'playlist-create', ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 300) });
    console.error(`[err] playlist-create failed - ${err.message}`);
  }
}

// POST /playlistItems - add a PUBLISHED video to a playlist. videoId resolves
// --id, else --plan/--only -> post.ytVideoId (cmdFeatured's exact pattern above).
// Pre-lists the playlist for a dup check (YouTube allows duplicate items; report
// honestly rather than double-adding). On a fresh add against a plan entry, echoes
// post.ytPlaylistItems (engine-owned, ENGINE_OWNED_FIELDS) so a concurrent
// caption/cover save never loses the membership record.
async function cmdPlaylistAdd(args) {
  const playlistId = typeof args['playlist-id'] === 'string' ? args['playlist-id'] : null;
  let videoId = typeof args.id === 'string' ? args.id : null;
  let abs = null;
  let plan = null;
  let post = null;
  if (args.plan) {
    ({ abs, plan } = loadPlan(args.plan));
    if (args.only) {
      post = (plan.posts || []).find((p) => p.id === args.only && isYouTube(p));
      if (!videoId && post && post.ytVideoId) videoId = post.ytVideoId;
    }
  }
  if (!playlistId || !videoId) {
    console.error('[err] playlist-add requires --playlist-id <id> and --id <videoId> (or --plan <p> --only <postId> with a scheduled ytVideoId).');
    process.exit(2);
  }
  const token = await getAccessToken();
  try {
    let existingItemId = null;
    let pageToken;
    do {
      const data = await api('GET', '/playlistItems', {
        query: { part: 'snippet', playlistId, maxResults: 50, ...(pageToken ? { pageToken } : {}) },
        token,
      });
      const hit = (data.items || []).find((it) => it.snippet?.resourceId?.videoId === videoId);
      if (hit) { existingItemId = hit.id; break; }
      pageToken = data.nextPageToken;
    } while (pageToken);

    if (existingItemId) {
      RUN.results.push({ platform: 'youtube', action: 'playlist-add', ok: true, id: existingItemId, playlistId, videoId, duplicate: true });
      console.log(`[ok] playlist-add: ${videoId} already in playlist ${playlistId} (item ${existingItemId}) - not re-added.`);
      return;
    }

    const item = await api('POST', '/playlistItems', {
      query: { part: 'snippet' },
      body: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } },
      token,
    });
    RUN.results.push({ platform: 'youtube', action: 'playlist-add', ok: true, id: item.id, playlistId, videoId });
    console.log(`[ok] playlist-add: ${videoId} added to playlist ${playlistId} (item ${item.id}).`);

    // Echo the membership ONLY when the resolved video actually IS this post's
    // published video. An explicit --id override for a DIFFERENT video is an ad-hoc
    // add; recording it on this post's ytPlaylistItems would be a false membership
    // (the post's own video was never added). So guard on post.ytVideoId === videoId.
    if (post && abs && post.ytVideoId === videoId) {
      post.ytPlaylistItems = Array.isArray(post.ytPlaylistItems) ? post.ytPlaylistItems : [];
      post.ytPlaylistItems.push({ playlistId, itemId: item.id });
      await savePlan(abs, plan, [post.id]);
    }
  } catch (err) {
    if (ytNeedsScope(err)) {
      RUN.results.push({ platform: 'youtube', action: 'playlist-add', ok: false, error: 'needs_scope', scope: 'youtube' });
      console.log('[warn] playlist-add: needs the youtube (or youtube.force-ssl) write scope - reconnect to grant it.');
      return;
    }
    RUN.results.push({ platform: 'youtube', action: 'playlist-add', ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 300) });
    console.error(`[err] playlist-add failed - ${err.message}`);
  }
}

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

// The inbound-engagement seam (spec 02, Pattern P6): read + reply to inbound
// comments on this lane's own posts. Thin wrappers over the shared, source-agnostic
// REST in lib/comments.mjs (dynamic import so the publish hot path's module graph is
// untouched). The result is merged onto RUN so main() emits the normalized
// { items } / { id } envelope; a needs_scope degrade sets ok:false (P9). Distinct
// from the existing `comment` verb (the YouTube first-comment-on-publish).
async function cmdComments(args) {
  const { runLaneComments } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneComments('youtube', args));
}
async function cmdReply(args) {
  const { runLaneReply } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneReply('youtube', args));
}
async function cmdModerate(args) {
  const { runLaneModerate } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneModerate('youtube', args));
}

const COMMANDS = {
  auth: cmdAuth,
  comments: cmdComments,
  reply: cmdReply,
  moderate: cmdModerate,
  validate: cmdValidate,
  publish: cmdPublish,
  schedule: cmdSchedule,
  'publish-radar': cmdPublishRadar,
  release: cmdRelease,
  edit: cmdEdit,
  status: cmdStatus,
  verify: cmdVerify,
  delete: cmdDelete,
  'set-thumbnail': cmdSetThumbnail,
  caption: cmdCaption,
  comment: cmdComment,
  featured: cmdFeatured,
  insights: cmdInsights,
  demographics: cmdDemographics,
  probe: cmdProbe,
  profile: cmdProfile,
  discover: cmdDiscover,
  'playlists-list': cmdPlaylistsList,
  'playlist-create': cmdPlaylistCreate,
  'playlist-add': cmdPlaylistAdd,
};

async function main() {
  const args = parseArgs(process.argv);
  await enforceCeremonyClient({ argv: args, command: args._[0], lane: 'youtube', scriptUrl: import.meta.url });
  // --json: human logs move to stderr; stdout carries exactly one JSON line
  // (the run envelope) for the pendpost scheduler. --actor tags attempts[].
  JSON_MODE = Boolean(args.json);
  ACTOR = typeof args.actor === 'string' ? args.actor : 'cli';
  if (JSON_MODE) console.log = (...a) => console.error(...a);
  const commandName = args._[0];
  // Mock mode: publish/read commands never touch YouTube - delegate to the
  // shared mock driver. Credential commands (auth) still run for real.
  if (resolveMode('youtube') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'youtube', command: commandName,
      planPath: typeof args.plan === 'string' ? path.resolve(String(args.plan)) : null,
      only: typeof args.only === 'string' ? args.only : null,
      // Spec 15 (playlists): playlist-create/playlist-add take extra flags the
      // shared plan/only pair cannot carry - forwarded here (every OTHER lane's
      // command ignores these, so this is harmless everywhere else).
      title: typeof args.title === 'string' ? args.title : null,
      description: typeof args.description === 'string' ? args.description : null,
      privacy: typeof args.privacy === 'string' ? args.privacy : null,
      playlistId: typeof args['playlist-id'] === 'string' ? args['playlist-id'] : null,
      videoId: typeof args.id === 'string' ? args.id : null,
      // spec 06: the moderate verb carries its action so the mock can branch per-lane.
      action: typeof args.action === 'string' ? args.action : null,
      // spec 28 review: the profile verb's --probe flag, so mock mode can
      // distinguish a probe (read-only tier check) from an apply.
      probe: args.probe === true,
    });
    if (JSON_MODE) process.stdout.write(`${JSON.stringify(envelope)}\n`);
    else console.error(`[mock] youtube ${commandName}: ${envelope.results.length} result(s)`);
    return;
  }
  const cmd = COMMANDS[commandName];
  if (!cmd) {
    console.error(`Usage: node scripts/yt-social.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
    process.exit(2);
  }
  if (['schedule', 'publish-radar', 'release', 'edit', 'status', 'set-thumbnail', 'caption', 'comment', 'insights', 'verify', 'demographics'].includes(args._[0]) && !args.plan) {
    console.error(`[err] ${args._[0]} requires --plan <post-plan.json>`);
    process.exit(2);
  }
  await cmd(args);
  if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: true, ...RUN })}\n`);
}

// CLI entry - only when executed directly, never when imported (spec 28: a
// profile-edit test drives cmdProfile in-process against a stubbed global.fetch,
// mirroring nostr-social.mjs/telegram-social.mjs/x-social.mjs/discord-social.mjs's
// identical guard - importing this file must never race main() against the
// importing process's own argv).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (err) => {
    console.error('[err]', err.message || err);
    if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: false, error: String(err.message || err).slice(0, 300), ...RUN })}\n`);
    process.exit(1);
  });
}

// Test-only export (spec 45): postComment is pure over its (videoId, text, token) inputs +
// globalThis.fetch (via api()), so a stubbed-fetch test can prove a Radar reply's externalId
// (the video id) lands as snippet.videoId in the real commentThreads.insert body without
// spawning the CLI or the real Data API - YouTube's API host is a hardcoded literal (not
// env-overridable), so a live-local-server proof (like the Mastodon lane) is not feasible here.
export { postComment };
