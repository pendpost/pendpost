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
 *   status    --plan <post-plan.json>                               per-entry live state
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
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = process.env.PENDPOST_ROOT ? path.join(process.env.PENDPOST_ROOT, '.env') : path.resolve(__dirname, '../.env');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';
const API = 'https://www.googleapis.com/youtube/v3';
// youtube.force-ssl is REQUIRED by captions.insert + commentThreads.insert. Adding
// it changes the consent scope set: re-run `yt-social.mjs auth` to mint a refresh
// token that carries it, or caption/comment writes 403.
const SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.force-ssl';
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
    throw new Error(`YouTube ${method} ${pathname}: HTTP ${res.status} ${reason} - ${e.message || text || ''}`);
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
const ENGINE_OWNED_FIELDS = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'ytCaptionId', 'ytCommentId', 'status', 'postedAt', 'attempts'];

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
  post.attempts = Array.isArray(post.attempts) ? post.attempts : [];
  post.attempts.push(entry);
}

// Machine-readable run envelope for --json mode (consumed by the pendpost scheduler).
const RUN = { results: [], blocked368: false };
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
    RUN.results.push({ postId: post.id, platform: 'youtube', action: 'insights', ok: true, id: post.ytVideoId, metrics });
    console.log(`[ok] ${post.id}: YT ${JSON.stringify(metrics)}`);
  }
  console.log(`[done] insights complete - ${RUN.results.filter((r) => r.ok).length} fetched.`);
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
  const chan = await api('GET', '/channels', { query: { part: 'brandingSettings', mine: 'true' }, token });
  const channel = chan.items && chan.items[0];
  if (!channel) throw new Error('no YouTube channel on this account');
  const branding = channel.brandingSettings || {};
  const merged = { channel: { ...(branding.channel || {}), unsubscribedTrailer: videoId } };
  await api('PUT', '/channels', { query: { part: 'brandingSettings' }, body: { id: channel.id, brandingSettings: merged }, token });
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
  validate: cmdValidate,
  publish: cmdPublish,
  schedule: cmdSchedule,
  status: cmdStatus,
  verify: cmdVerify,
  delete: cmdDelete,
  'set-thumbnail': cmdSetThumbnail,
  caption: cmdCaption,
  comment: cmdComment,
  featured: cmdFeatured,
  insights: cmdInsights,
  probe: cmdProbe,
};

async function main() {
  const args = parseArgs(process.argv);
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
  if (['schedule', 'status', 'set-thumbnail', 'caption', 'comment', 'insights', 'verify'].includes(args._[0]) && !args.plan) {
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
