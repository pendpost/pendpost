#!/usr/bin/env node
/**
 * linkedin-social.mjs - direct LinkedIn company-page publishing, no third-party service.
 *
 * Sibling of scripts/meta-social.mjs (same zero-dep, plan-driven, publish-from-local-render
 * pattern) but with LinkedIn's own auth model: 3-legged OAuth, a 60-day access token, and a
 * 365-day refresh token with programmatic refresh.
 *
 * LinkedIn has NO scheduling API (like Instagram), so entries are published at their due time
 * by re-running `publish-due` (driven by a one-time Claude scheduled task). The Posts API only
 * creates PUBLISHED posts (no DRAFT/scheduled state on create), so `validate` mirrors the IG
 * "unpublished container" trick instead: it uploads the HD video (an asset, never a public post)
 * and previews the exact caption, without creating any post.
 *
 * ALL media uploads straight from the local render folder (post.path / plan.folder + post.file),
 * byte-for-byte in HD, via LinkedIn's multipart Videos API. No hosting layer, no Cloudinary.
 *
 * Author org: configured via LINKEDIN_ORG_URN (urn:li:organization:<digits>).
 * Source of truth: a post-plan.json (see data/plans/<campaign>/post-plan.json).
 *
 * Commands:
 *   auth         [--client-id X --client-secret Y] [--port 8089]   one-time OAuth ceremony (localhost redirect)
 *   refresh                                                          force a token refresh (verifies programmatic refresh)
 *   validate     --plan <post-plan.json> [--only <postId>]          side-effect-free: upload HD video + preview caption, never posts
 *   publish-due  --plan <post-plan.json> [--only <postId>] [--dry-run]   publish any due LinkedIn entry
 *   status       --plan <post-plan.json>                            list LinkedIn plan entries + live post state
 *
 * Credentials live in gitignored .env (same convention as meta-social.mjs):
 * LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, LINKEDIN_ACCESS_TOKEN, LINKEDIN_REFRESH_TOKEN,
 * LINKEDIN_TOKEN_EXPIRES_AT (epoch ms). LINKEDIN_ORG_URN and LINKEDIN_API_VERSION are optional
 * env overrides for the constants below.
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
// The .env lives in the ACTIVE client subtree, resolved by the shared envPath()
// (lib/util.mjs -> activeRoot()): when the app spawns us it sets PENDPOST_ROOT to
// that client root; a bare CLI run resolves the active client from data/clients.json.
// Either way we read/write the SAME file the app reads - no orphan repo-root .env.
const ENV_PATH = envPath();

const REST = 'https://api.linkedin.com/rest';
const OAUTH = 'https://www.linkedin.com/oauth/v2';
const SCOPES = 'w_organization_social r_organization_social';
const DEFAULT_PORT = 8089;
const DEFAULT_ORG_URN = '';
const DEFAULT_API_VERSION = '202605'; // YYYYMM; LinkedIn ships monthly, supported >= 1 year

// org urn + api version are constants, overridable by env (mirrors meta-social hardcoding GRAPH).
const orgUrn = () => readEnv('LINKEDIN_ORG_URN') || DEFAULT_ORG_URN;
const apiVersion = () => readEnv('LINKEDIN_API_VERSION') || DEFAULT_API_VERSION;

// ---------- env helpers (same shape as meta-social.mjs) ----------

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
    console.error(`[err] ${name} missing in .env - run 'node scripts/linkedin-social.mjs auth' first.`);
    process.exit(1);
  }
  return v;
}

// ---------- oauth / token freshness ----------

async function tokenExchange(params) {
  const res = await fetch(`${OAUTH}/accessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`OAuth ${params.grant_type}: HTTP ${res.status} ${data.error || ''} - ${data.error_description || JSON.stringify(data)}`);
  }
  return data;
}

function persistTokens(data) {
  const vars = {
    LINKEDIN_ACCESS_TOKEN: data.access_token,
    LINKEDIN_TOKEN_EXPIRES_AT: String(Date.now() + (Number(data.expires_in) || 0) * 1000),
  };
  if (data.refresh_token) vars.LINKEDIN_REFRESH_TOKEN = data.refresh_token;
  writeEnv(vars);
  return vars;
}

function tokenTail(t) {
  return t ? `...${t.slice(-6)} (length ${t.length})` : '(none)';
}

// Returns a valid access token, refreshing if it expires within 5 days. This IS the
// "programmatic refresh". If the app was never granted refresh tokens, refresh_token is simply
// absent and the 60-day re-auth is the documented fallback.
async function ensureFreshToken({ force = false } = {}) {
  const token = readEnv('LINKEDIN_ACCESS_TOKEN');
  const expiresAt = Number(readEnv('LINKEDIN_TOKEN_EXPIRES_AT') || 0);
  if (!token) {
    // throw (not process.exit) so main().catch can emit the --json failure envelope.
    throw new Error("No LINKEDIN_ACCESS_TOKEN - run 'node scripts/linkedin-social.mjs auth' first.");
  }
  const fiveDays = 5 * 24 * 3600 * 1000;
  if (!force && expiresAt - Date.now() > fiveDays) return token;

  const refreshToken = readEnv('LINKEDIN_REFRESH_TOKEN');
  if (!refreshToken) {
    if (!force && expiresAt > Date.now()) return token; // no refresh capability, token still valid
    console.error("[err] Access token expired and no refresh token was issued - re-run 'node scripts/linkedin-social.mjs auth'.");
    process.exit(1);
  }

  console.log('[info] Refreshing access token...');
  let data;
  try {
    data = await tokenExchange({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: requireEnv('LINKEDIN_CLIENT_ID'),
      client_secret: requireEnv('LINKEDIN_CLIENT_SECRET'),
    });
  } catch (err) {
    console.error(`[err] Refresh failed (${err.message}). The refresh token is likely expired or revoked - re-run 'node scripts/linkedin-social.mjs auth'.`);
    process.exit(1);
  }
  const vars = persistTokens(data);
  console.log(`[ok] Token refreshed ${tokenTail(data.access_token)}, expires ${new Date(Number(vars.LINKEDIN_TOKEN_EXPIRES_AT)).toLocaleString('en-US')}.`);
  return data.access_token;
}

// ---------- versioned REST helper ----------

async function api(method, pathname, { query, body, token, extraHeaders } = {}) {
  const url = new URL(`${REST}${pathname}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const headers = {
    Authorization: `Bearer ${token}`,
    'LinkedIn-Version': apiVersion(),
    'X-Restli-Protocol-Version': '2.0.0',
    ...(extraHeaders || {}),
  };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`LinkedIn ${method} ${pathname}: HTTP ${res.status} ${data.code || ''} - ${data.message || text || ''}`);
  }
  return { data, headers: res.headers };
}

// ---------- video upload (multipart, straight from local disk, HD byte-for-byte) ----------

async function uploadVideo(localPath, token, thumbnailPath = null) {
  const buf = fs.readFileSync(localPath);
  const fileSizeBytes = buf.length;

  const { data: init } = await api('POST', '/videos', {
    query: { action: 'initializeUpload' },
    body: { initializeUploadRequest: { owner: orgUrn(), fileSizeBytes, uploadCaptions: false, uploadThumbnail: Boolean(thumbnailPath) } },
    token,
  });
  const { video, uploadInstructions, uploadToken, thumbnailUploadUrl } = init.value || {};
  if (!video || !Array.isArray(uploadInstructions) || !uploadInstructions.length) {
    throw new Error(`initializeUpload returned no upload instructions: ${JSON.stringify(init)}`);
  }
  console.log(`[info]   init ok (${video}); ${uploadInstructions.length} part(s), ${(fileSizeBytes / 1e6).toFixed(1)} MB HD source.`);

  const uploadedPartIds = [];
  for (let i = 0; i < uploadInstructions.length; i++) {
    const { uploadUrl, firstByte, lastByte } = uploadInstructions[i];
    const slice = buf.subarray(firstByte, lastByte + 1); // byte ranges are inclusive
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' }, // pre-signed DMS url: NO Authorization
      body: slice,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`video part ${i + 1}/${uploadInstructions.length} PUT failed: HTTP ${res.status} ${t}`);
    }
    let etag = res.headers.get('etag') || '';
    etag = etag.replace(/^"|"$/g, ''); // strip surrounding quotes if the stack added them
    if (!etag) throw new Error(`video part ${i + 1} returned no ETag header (needed for finalize).`);
    uploadedPartIds.push(etag);
    console.log(`[info]   part ${i + 1}/${uploadInstructions.length} uploaded (${(slice.length / 1e6).toFixed(1)} MB).`);
  }

  // Thumbnail upload sits between the video parts and finalize (the only
  // documented window - LinkedIn has NO post-hoc thumbnail API). The URL is a
  // pre-signed DMS URL like the part uploadUrls: NO Authorization header,
  // but it DOES require media-type-family: STILLIMAGE. Non-fatal: an organic
  // feed video serves fine with the system-generated thumbnail.
  if (thumbnailPath && thumbnailUploadUrl) {
    try {
      const tRes = await fetch(thumbnailUploadUrl, {
        method: 'PUT',
        headers: { 'media-type-family': 'STILLIMAGE', 'Content-Type': 'application/octet-stream' },
        body: fs.readFileSync(thumbnailPath),
      });
      if (!tRes.ok) throw new Error(`HTTP ${tRes.status}`);
      console.log('[info]   custom thumbnail uploaded.');
    } catch (err) {
      console.log(`[warn]   thumbnail upload failed (video keeps the default cover) - ${err.message}`);
    }
  } else if (thumbnailPath) {
    console.log('[warn]   initializeUpload returned no thumbnailUploadUrl - thumbnail skipped.');
  }

  await api('POST', '/videos', {
    query: { action: 'finalizeUpload' },
    body: { finalizeUploadRequest: { video, uploadToken: uploadToken || '', uploadedPartIds } },
    token,
  });
  console.log('[info]   finalize ok - waiting for processing...');
  await pollVideo(video, token);
  return video;
}

async function pollVideo(videoUrn, token, timeoutMs = 5 * 60 * 1000) {
  const start = Date.now();
  const enc = encodeURIComponent(videoUrn);
  for (;;) {
    const { data } = await api('GET', `/videos/${enc}`, { token });
    if (data.status === 'AVAILABLE') { console.log('[ok]   video AVAILABLE.'); return; }
    if (data.status === 'PROCESSING_FAILED') {
      throw new Error(`video processing failed: ${data.processingFailureReason || 'unknown'}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`video ${videoUrn} not AVAILABLE after ${timeoutMs / 1000}s (status: ${data.status}).`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

// ---------- article-card thumbnail upload (Images API, remote URL -> digital-media-asset) ----------

// Register a remote image (the article's Cloudinary hero, post.image) as a
// LinkedIn digital-media-asset and return its urn:li:image for use as the
// article-card thumbnail. The Images API is a single PUT (simpler than the
// multipart Videos flow). The CALLER wraps this in try/catch and posts the
// share without a thumbnail on any failure - a missing/broken hero must never
// block the article post (LinkedIn then falls back to its JS-less crawl, which
// is blank for our SPA /blog/* URLs, but the title still renders explicitly).
async function uploadArticleThumbnail(imageUrl, token) {
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`thumbnail download HTTP ${imgRes.status} (${imageUrl})`);
  const bytes = Buffer.from(await imgRes.arrayBuffer());

  const { data: init } = await api('POST', '/images', {
    query: { action: 'initializeUpload' },
    body: { initializeUploadRequest: { owner: orgUrn() } },
    token,
  });
  const { uploadUrl, image } = init.value || {};
  if (!uploadUrl || !image) throw new Error(`images initializeUpload returned no uploadUrl/image: ${JSON.stringify(init).slice(0, 200)}`);

  // The Images mediaUpload URL (api.linkedin.com/mediaUpload/...) DOES require
  // the bearer header - unlike the Videos DMS part URLs, which are pre-signed.
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: bytes });
  if (!put.ok) throw new Error(`thumbnail PUT failed: HTTP ${put.status}`);
  return image;
}

// ---------- post creation ----------

// LinkedIn "little text format": the commentary field treats \ | { } @ [ ] ( ) < > * _ ~ # as
// reserved. Our captions carry UTM URLs with underscores (utm_source/utm_medium/utm_campaign)
// that an unescaped parser mis-pairs into italics and mangles. Escape everything reserved EXCEPT
// '#' so #Hashtags stay clickable.
function escapeCommentary(text) {
  return String(text || '').replace(/[\\@[\]{}()<>|*_~]/g, (c) => `\\${c}`);
}

// A post is a text/article post (no media) when type === 'text'. Such posts
// carry an optional `link` (article URL); the URL also lives in the caption so
// it stays clickable even on the plain text-only path.
const isTextPost = (post) => post.type === 'text';

async function createPost(post, videoUrn, token, thumbnailUrn = null) {
  const body = {
    author: orgUrn(),
    commentary: escapeCommentary(post.caption),
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
  if (videoUrn) {
    // Org video post.
    body.content = { media: { title: post.title || 'pendpost', id: videoUrn } };
  } else if (post.link) {
    // Article share. Setting the title EXPLICITLY bypasses LinkedIn's JS-less
    // preview crawler, which would otherwise read the SPA homepage og:title for
    // any /blog/* URL (the SSR limitation documented in CLAUDE.md). description +
    // thumbnail complete the card so no manual LinkedIn editing is needed.
    const article = { source: post.link, title: post.title || 'pendpost' };
    if (post.description) article.description = post.description;
    if (thumbnailUrn) article.thumbnail = thumbnailUrn;
    body.content = { article };
  }
  // else: a plain text-only post (no content); the link, if any, is in the caption.
  const { headers } = await api('POST', '/posts', { body, token });
  return headers.get('x-restli-id');
}

// ---------- plan helpers (same shape as meta-social.mjs) ----------

function loadPlan(planPath) {
  const abs = path.resolve(planPath);
  return { abs, plan: JSON.parse(fs.readFileSync(abs, 'utf8')) };
}

// Engine-owned fields; everything else (caption, schedule, approval, cover)
// belongs to the owner/pendpost and must survive concurrent edits.
const ENGINE_OWNED_FIELDS = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'status', 'postedAt', 'attempts'];

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

const isLinkedIn = (post) => (post.platforms || []).includes('linkedin');

// ---------- commands ----------

async function cmdAuth(args) {
  console.log(`[info] Connecting LinkedIn - credentials will be written to ${ENV_PATH}`);
  const clientId = args['client-id'] || readEnv('LINKEDIN_CLIENT_ID');
  const clientSecret = args['client-secret'] || readEnv('LINKEDIN_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    console.error('[err] Need --client-id and --client-secret (LinkedIn app -> Auth tab) on first run, or set LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET in .env.');
    process.exit(2);
  }
  writeEnv({ LINKEDIN_CLIENT_ID: clientId, LINKEDIN_CLIENT_SECRET: clientSecret });

  const port = Number(args.port || DEFAULT_PORT);
  const redirectUri = `http://localhost:${port}/callback`;
  const state = crypto.randomUUID();
  const authUrl = `${OAUTH}/authorization?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: SCOPES,
  }).toString()}`;

  console.log(`\n[action] Confirm ${redirectUri} is an Authorized redirect URL in the LinkedIn app (Auth tab), then approve the consent screen.`);
  console.log('[action] Opening the consent screen. If it does not open, paste this URL into your browser:\n');
  console.log(`  ${authUrl}\n`);

  await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, redirectUri);
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
        const data = await tokenExchange({
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        });
        const vars = persistTokens(data);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>pendpost: LinkedIn connected.</h2><p>You can close this tab and return to the terminal.</p>');
        const exp = new Date(Number(vars.LINKEDIN_TOKEN_EXPIRES_AT)).toLocaleString('en-US');
        console.log(`\n[ok] Access token stored ${tokenTail(data.access_token)}, expires ${exp}.`);
        console.log(`[ok] Refresh token ${data.refresh_token ? 'stored - programmatic refresh enabled.' : 'NOT issued by the app - the 60-day token will need a manual re-auth on expiry.'}`);
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
      console.log(`[info] Waiting for the LinkedIn consent redirect on ${redirectUri} ...`);
    });
  });
  console.log('[done] auth complete.');
}

async function cmdRefresh() {
  const token = await ensureFreshToken({ force: true });
  console.log(`[ok] Access token ${tokenTail(token)}, expires ${new Date(Number(readEnv('LINKEDIN_TOKEN_EXPIRES_AT'))).toLocaleString('en-US')}.`);
}

async function cmdValidate(args) {
  const { plan } = loadPlan(args.plan);
  const token = await ensureFreshToken();
  console.log('================ VALIDATION ONLY - NOTHING WILL BE PUBLISHED ================');

  // 1. token + org read access (needs r_organization_social; non-fatal so the publish path can
  //    still be validated if only w_organization_social was granted).
  try {
    await api('GET', '/posts', {
      query: { author: orgUrn(), q: 'author', count: 1 },
      token,
      extraHeaders: { 'X-RestLi-Method': 'FINDER' },
    });
    console.log(`[ok] Token valid + org read access confirmed for ${orgUrn()}.`);
  } catch (err) {
    console.log(`[warn] Org read check failed (${err.message}). r_organization_social may be missing - 'status' will not work, but publishing only needs w_organization_social. Continuing.`);
  }

  // 2. per LinkedIn entry: upload the HD video to AVAILABLE (an asset, never a public post) and
  //    preview the exact caption. LinkedIn GCs unreferenced assets; nothing is posted.
  const targets = (plan.posts || []).filter((p) => isLinkedIn(p) && (!args.only || p.id === args.only));
  if (!targets.length) { console.log('[warn] No LinkedIn entries match.'); return; }

  for (const post of targets) {
    console.log(`\n----- ${post.id} -----`);
    if (isTextPost(post)) {
      console.log('[info] text/article post - no media upload needed.');
      console.log(`[preview] author:       ${orgUrn()}`);
      if (post.link) console.log(`[preview] article:      ${post.link} (title: ${post.title || 'pendpost'})`);
      console.log(`[preview] thumbnail:    ${post.image || '(none - the article card will have no image)'}`);
      if (post.description) console.log(`[preview] description:  ${post.description}`);
      console.log('[preview] commentary (RAW):');
      console.log(post.caption || '');
      console.log('\n[preview] commentary (ESCAPED little-text - exactly what gets POSTed; # stays a hashtag):');
      console.log(escapeCommentary(post.caption));
      continue;
    }
    const mediaPath = resolveMediaPath(plan, post);
    if (!mediaPath) { console.log(`[warn] media not found (${post.path || post.file}) - skipping.`); continue; }
    if (!/\.(mp4|mov)$/i.test(mediaPath)) { console.log('[warn] not a video file - this script only handles org video posts.'); continue; }

    console.log(`[info] uploading HD render ${path.basename(mediaPath)} to validate the upload chain (asset only, not public)...`);
    const videoUrn = await uploadVideo(mediaPath, token);
    console.log(`[ok] ${post.id}: HD video uploaded + AVAILABLE (${videoUrn}). Not a post; LinkedIn garbage-collects unreferenced assets.`);
    console.log(`[preview] author:       ${orgUrn()}`);
    console.log(`[preview] media title:  ${post.title || 'pendpost'}`);
    console.log('[preview] commentary (RAW):');
    console.log(post.caption || '');
    console.log('\n[preview] commentary (ESCAPED little-text - exactly what gets POSTed; # stays a hashtag):');
    console.log(escapeCommentary(post.caption));
  }
  console.log('\n================ VALIDATION COMPLETE - review the captions, then approve publishing. ================');
}

async function cmdPublishDue(args) {
  const { abs, plan } = loadPlan(args.plan);
  const token = await ensureFreshToken();
  const now = Date.now();
  let published = 0;

  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isLinkedIn(post)) continue;
    if (post.executionMode !== 'fully-scheduled') continue;
    if (post.status !== 'planned') continue;
    // Fail-closed approval (SS-01): missing field = draft = never publish.
    if ((post.approval || 'draft') !== 'approved') {
      console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish.`);
      continue;
    }
    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs) || dueMs > now) continue;

    const lateMin = Math.round((now - dueMs) / 60000);
    if (lateMin > 15) console.log(`[warn] ${post.id}: publishing ${lateMin} min late (catch-up).`);

    const textPost = isTextPost(post);
    let mediaPath = null;
    if (!textPost) {
      mediaPath = resolveMediaPath(plan, post);
      if (!mediaPath) { console.log(`[warn] ${post.id}: due but local media not found (${post.path || post.file}) - skipping.`); continue; }
      if (!/\.(mp4|mov)$/i.test(mediaPath)) { console.log(`[warn] ${post.id}: not a video file - skipping (this script posts org videos).`); continue; }
    }

    if (args['dry-run']) {
      console.log(textPost
        ? `[dry] ${post.id}: would create a PUBLISHED text/article org post for ${orgUrn()}${post.image ? ` with thumbnail ${post.image}` : ' (no thumbnail)'}${post.description ? ' + card description' : ''}.`
        : `[dry] ${post.id}: would upload ${path.basename(mediaPath)} + create a PUBLISHED org post for ${orgUrn()}.`);
      continue;
    }

    console.log(`[info] ${post.id}: publishing ${textPost ? 'text/article post' : 'HD render'} to ${orgUrn()}...`);
    try {
      // Article-card thumbnail: download the remote hero (post.image) + register it
      // as a LinkedIn image asset. Fail-soft - on any error the share still posts,
      // just without a thumbnail.
      let thumbnailUrn = null;
      if (textPost && post.image) {
        try {
          thumbnailUrn = await uploadArticleThumbnail(post.image, token);
          console.log(`[info]   article thumbnail registered (${thumbnailUrn}).`);
        } catch (thumbErr) {
          console.log(`[warn] ${post.id}: thumbnail upload failed (${thumbErr.message}) - posting article share without a thumbnail.`);
        }
      }
      const videoUrn = textPost ? null : await uploadVideo(mediaPath, token, resolveCoverPath(post));
      const postUrn = await createPost(post, videoUrn, token, thumbnailUrn);

      post.liPostId = postUrn;
      post.status = 'posted';
      post.postedAt = new Date(now).toISOString();
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'linkedin', action: 'publish', ok: true, errorCode: null, errorMessage: null, lateMin, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'linkedin', action: 'publish', ok: true, id: postUrn });
      console.log(`[ok] ${post.id}: published on LinkedIn (${postUrn}).`);
      published += 1;
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'linkedin', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), lateMin, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'linkedin', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: LinkedIn publish failed - ${err.message}`);
      continue;
    }
  }
  console.log(`[done] publish-due complete - ${published} post(s) published.`);
}

async function cmdStatus(args) {
  const { plan } = loadPlan(args.plan);
  const token = await ensureFreshToken();
  console.log('[info] LinkedIn plan entries (live state fetched when liPostId is present):');
  for (const post of (plan.posts || []).filter(isLinkedIn)) {
    let live = '';
    if (post.liPostId) {
      try {
        const { data } = await api('GET', `/posts/${encodeURIComponent(post.liPostId)}`, { query: { viewContext: 'AUTHOR' }, token });
        live = ` live=${data.lifecycleState || '?'}`;
      } catch (err) {
        live = ` live=NOT FOUND (${err.message.slice(0, 40)})`;
      }
    }
    console.log(`  ${post.id.padEnd(18)} ${String(post.status).padEnd(10)} ${post.scheduledAt}  mode=${post.executionMode}${post.liPostId ? ` li=${post.liPostId}` : ''}${live}`);
  }
}

// Read-only verification (read-back): confirm whether a handed-off post is
// actually live on LinkedIn. Pure GET, writes NOTHING - prints the envelope the
// pendpost's lib/verify.mjs persists as the post.verify block.
async function cmdVerify(args) {
  const { plan } = loadPlan(args.plan);
  const token = await ensureFreshToken();
  const missingRe = /404|not found|doesn'?t exist|does not exist/i;
  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isLinkedIn(post) || !post.liPostId) continue;
    try {
      const { data } = await api('GET', `/posts/${encodeURIComponent(post.liPostId)}`, { query: { viewContext: 'AUTHOR' }, token });
      const lifecycle = data.lifecycleState || null;
      const live = lifecycle === 'PUBLISHED';
      RUN.results.push({ postId: post.id, platform: 'linkedin', action: 'verify', ok: true, id: post.liPostId, live, state: live ? 'published' : (lifecycle ? 'draft' : 'unknown'), permalink: `https://www.linkedin.com/feed/update/${post.liPostId}` });
      console.log(`[ok] ${post.id}: LI verify state=${lifecycle}`);
    } catch (err) {
      if (missingRe.test(err.message || '')) {
        RUN.results.push({ postId: post.id, platform: 'linkedin', action: 'verify', ok: true, id: post.liPostId, live: false, state: 'missing', permalink: null });
      } else {
        RUN.results.push({ postId: post.id, platform: 'linkedin', action: 'verify', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      }
      console.log(`[warn] ${post.id}: LI verify - ${err.message}`);
    }
  }
  console.log(`[done] verify complete - ${RUN.results.length} checked.`);
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

// Read-only metrics fetch (Phase E): organizationalEntityShareStatistics per
// published post. Needs r_organization_social on the token - the engine
// attempts the call and reports an honest ok:false otherwise (no fake
// metrics). Restli List() syntax must NOT be double-encoded, so the query is
// built inline on the pathname. Writes NOTHING.
async function cmdInsights(args) {
  const { plan } = loadPlan(args.plan);
  const token = await ensureFreshToken();
  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isLinkedIn(post) || !post.liPostId) continue;
    const param = post.liPostId.includes('ugcPost') ? 'ugcPosts' : 'shares';
    const pathname = `/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(orgUrn())}&${param}=List(${encodeURIComponent(post.liPostId)})`;
    try {
      const { data } = await api('GET', pathname, { token });
      const s = data.elements?.[0]?.totalShareStatistics;
      if (!s) throw new Error('no totalShareStatistics in response');
      const metrics = {
        impressions: s.impressionCount ?? null,
        likes: s.likeCount ?? null,
        comments: s.commentCount ?? null,
        shares: s.shareCount ?? null,
        clicks: s.clickCount ?? null,
      };
      RUN.results.push({ postId: post.id, platform: 'linkedin', action: 'insights', ok: true, id: post.liPostId, metrics });
      console.log(`[ok] ${post.id}: LI ${JSON.stringify(metrics)}`);
    } catch (err) {
      RUN.results.push({ postId: post.id, platform: 'linkedin', action: 'insights', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.log(`[warn] ${post.id}: LI insights failed - ${err.message}`);
    }
  }
  console.log(`[done] insights complete - ${RUN.results.filter((r) => r.ok).length} fetched.`);
}

// Read-only liveness probe for the pendpost health bar. Token introspection is the
// ONLY read that works with zero token scopes and zero product approval (the CMA
// product is pending), so it is correct even while r_organization_social reads
// would 403. It is authenticated by the app's OWN client_id+secret, not the
// token. NEVER call ensureFreshToken (it writes env + can process.exit) and NEVER
// log the request body (it carries client_secret + the token). Takes no --plan.
async function cmdProbe() {
  const clientId = readEnv('LINKEDIN_CLIENT_ID');
  const clientSecret = readEnv('LINKEDIN_CLIENT_SECRET');
  const token = readEnv('LINKEDIN_ACCESS_TOKEN');
  if (!clientId || !clientSecret) {
    RUN.results.push({ platform: 'linkedin', action: 'probe', ok: false, detail: 'not configured (client credentials missing)' });
    return;
  }
  if (!token) {
    RUN.results.push({ platform: 'linkedin', action: 'probe', ok: false, detail: 'not connected (no access token)' });
    return;
  }
  try {
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, token });
    const res = await fetch(`${OAUTH}/introspectToken`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      RUN.results.push({ platform: 'linkedin', action: 'probe', ok: false, detail: `introspect HTTP ${res.status}` });
      return;
    }
    const active = data.active === true || data.status === 'active';
    RUN.results.push({
      platform: 'linkedin',
      action: 'probe',
      ok: active,
      detail: active ? `Token active${data.scope ? ` (${data.scope})` : ''}` : `Token ${data.status || 'inactive'}`,
      tokenExpiresAt: data.expires_at ? data.expires_at * 1000 : null,
    });
  } catch (err) {
    RUN.results.push({ platform: 'linkedin', action: 'probe', ok: false, detail: String(err.message || err).slice(0, 200) });
  }
}

const COMMANDS = {
  auth: cmdAuth,
  refresh: cmdRefresh,
  validate: cmdValidate,
  'publish-due': cmdPublishDue,
  status: cmdStatus,
  verify: cmdVerify,
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
  // Mock mode: publish/read commands never touch LinkedIn - delegate to the
  // shared mock driver. Credential commands (auth) still run for real.
  if (resolveMode('linkedin') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'linkedin', command: commandName,
      planPath: typeof args.plan === 'string' ? path.resolve(String(args.plan)) : null,
      only: typeof args.only === 'string' ? args.only : null,
    });
    if (JSON_MODE) process.stdout.write(`${JSON.stringify(envelope)}\n`);
    else console.error(`[mock] linkedin ${commandName}: ${envelope.results.length} result(s)`);
    return;
  }
  const cmd = COMMANDS[commandName];
  if (!cmd) {
    console.error(`Usage: node scripts/linkedin-social.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
    process.exit(2);
  }
  if (['validate', 'publish-due', 'status', 'insights', 'verify'].includes(args._[0]) && !args.plan) {
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
