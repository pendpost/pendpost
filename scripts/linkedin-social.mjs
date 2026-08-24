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
 *                (also posts firstComment inline right after the share, spec 11)
 *   comment      --plan <post-plan.json> [--only <postId>] [--force] [--dry-run]   post-hoc/retry firstComment (live-only)
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
import { enforceCeremonyClient } from '../lib/cli-client.mjs';
import { resolveCredential } from '../lib/cli-prompt.mjs';
import { recordAttempt } from '../lib/publish-hold.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
import { isPollPost, pollOptions, pollDurationMinutes, pollMultiple, pollBlocker, pollBlockRow, POLL_LANE_LIMITS } from '../lib/poll.mjs';
import { isCarouselPost, carouselItems, carouselBlocker, carouselBlockRow } from '../lib/carousel.mjs';
import { captionBlocker, captionBlockRow } from '../lib/caption.mjs';
import { avSyncBlocker, avSyncBlockRow, findCoverSibling } from '../lib/assets.mjs';
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

// Spec 05: register a LOCAL image file as a LinkedIn digital-media-asset and return its
// urn:li:image, for use as a multiImage carousel slide. Same Images API single-PUT flow
// as uploadArticleThumbnail, but reads the bytes off disk instead of fetching a URL.
async function uploadLocalImage(localPath, token) {
  const bytes = fs.readFileSync(localPath);
  const { data: init } = await api('POST', '/images', {
    query: { action: 'initializeUpload' },
    body: { initializeUploadRequest: { owner: orgUrn() } },
    token,
  });
  const { uploadUrl, image } = init.value || {};
  if (!uploadUrl || !image) throw new Error(`images initializeUpload returned no uploadUrl/image: ${JSON.stringify(init).slice(0, 200)}`);
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: bytes });
  if (!put.ok) throw new Error(`carousel image PUT failed: HTTP ${put.status}`);
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

// Spec 10: map a requested poll duration (minutes) to LinkedIn's fixed duration
// enum (the API accepts only these four). A 5-min/1-hour request rounds UP to the
// shortest supported window (ONE_DAY), so a poll is never silently dropped.
function linkedinPollDuration(minutes) {
  if (minutes <= 1440) return 'ONE_DAY';
  if (minutes <= 4320) return 'THREE_DAYS';
  if (minutes <= 10080) return 'SEVEN_DAYS';
  return 'FOURTEEN_DAYS';
}

async function createPost(post, videoUrn, token, thumbnailUrn = null, imageUrns = null) {
  const body = {
    author: orgUrn(),
    commentary: escapeCommentary(post.caption),
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
  if (Array.isArray(imageUrns) && imageUrns.length) {
    // Spec 05: a native multiImage post - 2..20 already-registered image URNs, in order.
    // altText rides each image where the post carries one (single shared string here).
    body.content = { multiImage: { images: imageUrns.map((id) => ({ id, ...(post.altText ? { altText: String(post.altText).slice(0, 4000) } : {}) })) } };
  } else if (isPollPost(post)) {
    // Native poll: the question is the caption; 2..4 options; single/multi vote.
    body.content = {
      poll: {
        question: (post.caption || '').trim(),
        options: pollOptions(post).map((o) => ({ text: o })),
        settings: {
          duration: linkedinPollDuration(pollDurationMinutes(post)),
          voteSelectionType: pollMultiple(post) ? 'MULTIPLE_VOTE' : 'SINGLE_VOTE',
        },
      },
    };
  } else if (videoUrn) {
    // Org video post.
    body.content = { media: { title: post.title || 'pendpost', id: videoUrn } };
  } else if (post.link) {
    // Article share. Setting the title EXPLICITLY bypasses LinkedIn's JS-less
    // preview crawler, which would otherwise read the SPA homepage og:title for
    // any /blog/* URL (the SSR limitation documented in CLAUDE.md). description +
    // thumbnail complete the card so no manual LinkedIn editing is needed.
    // Card description precedence: the dedicated `liDescription` wins (it exists so
    // a LinkedIn+YouTube post can carry a LinkedIn-specific card description without
    // colliding with `description`, the YouTube video description); a LinkedIn-only
    // article falls back to `description` (the original single-field convention that
    // the live blog posts + article-fields.test.mjs still use).
    const cardDescription = post.liDescription || post.description;
    const article = { source: post.link, title: post.title || 'pendpost' };
    if (cardDescription) article.description = cardDescription;
    if (thumbnailUrn) article.thumbnail = thumbnailUrn;
    body.content = { article };
  }
  // else: a plain text-only post (no content); the link, if any, is in the caption.
  const { headers } = await api('POST', '/posts', { body, token });
  return headers.get('x-restli-id');
}

// socialActions/{shareUrn}/comments - post a comment AS THE ORG on its OWN share
// (spec 11: universal self first-comment, mirrors the YT postComment idiom
// yt-social.mjs:369-375). LinkedIn returns the new comment's urn in the
// x-restli-id response header, same convention as createPost above.
async function postComment(shareUrn, text, token) {
  const { headers } = await api('POST', `/socialActions/${encodeURIComponent(shareUrn)}/comments`, {
    body: { actor: orgUrn(), message: { text } },
    token,
  });
  return { id: headers.get('x-restli-id') };
}

// ---------- plan helpers (same shape as meta-social.mjs) ----------

function loadPlan(planPath) {
  const abs = path.resolve(planPath);
  return { abs, plan: JSON.parse(fs.readFileSync(abs, 'utf8')) };
}

// Engine-owned fields; everything else (caption, schedule, approval, cover)
// belongs to the owner/pendpost and must survive concurrent edits.
const ENGINE_OWNED_FIELDS = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'liCommentId', 'ytVideoId', 'status', 'postedAt', 'attempts', 'publishHold', 'publishRetry'];

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

// Cover for a post, in display-parity precedence (exported for the engine tests):
//  1. The explicit post.cover override materialized by pendpost (lib/covers.mjs) -
//     its path is CLIENT-ROOT-relative (covers.mjs writes it relative to
//     activeRoot()), so it anchors at PENDPOST_ROOT exactly like resolveMediaPath.
//  2. Else the render-sibling <base>.jpg next to the media - the SAME JPEG the app
//     shows as the post's cover (plans.mjs findCover), so what pendpost displays is
//     what publishes. A stale override pointer falls through to the sibling,
//     mirroring the read model's overrideExists precedence.
export function resolveCoverPath(post, mediaPath = null) {
  if (post.cover?.path) {
    const root = process.env.PENDPOST_ROOT ? path.resolve(process.env.PENDPOST_ROOT) : path.resolve(__dirname, '..');
    const abs = path.resolve(root, post.cover.path);
    if (fs.existsSync(abs)) return abs;
  }
  return findCoverSibling(mediaPath);
}

const isLinkedIn = (post) => (post.platforms || []).includes('linkedin');

// ---------- commands ----------

async function cmdAuth(args) {
  console.log(`[info] Connecting LinkedIn - credentials will be written to ${ENV_PATH}`);
  const clientId = await resolveCredential({ value: args['client-id'] || readEnv('LINKEDIN_CLIENT_ID'), hint: 'Paste your LinkedIn OAuth Client ID (LinkedIn app > Auth tab): ' });
  const clientSecret = await resolveCredential({ value: args['client-secret'] || readEnv('LINKEDIN_CLIENT_SECRET'), secret: true, hint: 'Paste your LinkedIn Client secret (hidden; Auth tab): ' });
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
      // Same precedence the real create uses: liDescription (LinkedIn-specific) else description.
      const cardDescription = post.liDescription || post.description;
      if (cardDescription) console.log(`[preview] description:  ${cardDescription}`);
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
    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs) || dueMs > now) continue;

    const lateMin = Math.round((now - dueMs) / 60000);
    if (lateMin > 15) console.log(`[warn] ${post.id}: publishing ${lateMin} min late (catch-up).`);

    // Fresh-bytes caption backstop: LinkedIn caps share commentary at 3000 chars
    // (lib/caption.mjs). platformValidate enforces it at author time, but a stale-queued
    // cloud job (singletonKey dedupe) can carry a clean verdict past a later edit - so
    // refuse an over-cap commentary here BEFORE the API rejects it. Commentary is the
    // shared caption on every LinkedIn shape (a poll's question is its caption too).
    const capBlock = captionBlocker(post.caption, 'linkedin');
    if (capBlock) {
      console.log(`[warn] ${post.id}: ${capBlock} - skipping.`);
      RUN.results.push(captionBlockRow(post, 'linkedin', capBlock));
      continue;
    }

    const textPost = isTextPost(post);
    // Spec 10: a native poll org post - the question is the caption; carries no media.
    const pollPost = isPollPost(post);
    if (pollPost) {
      const blocker = pollBlocker(post, post.caption, POLL_LANE_LIMITS.linkedin);
      if (blocker) {
        console.log(`[warn] ${post.id}: ${blocker} - skipping.`);
        RUN.results.push(pollBlockRow(post, 'linkedin', blocker));
        continue;
      }
    }
    // Spec 05: a native multiImage post - 2..20 images, in order. Fail-closed BEFORE any
    // upload (count/cap + slides-on-disk) so no half-registered image set is created.
    const carouselPost = isCarouselPost(post);
    let carouselPaths = [];
    if (carouselPost) {
      carouselPaths = carouselItems(post).map((it) => resolveMediaPath(plan, { file: it.file, path: it.path }));
      const blocker = carouselBlocker(post, 'linkedin', carouselPaths.map((p) => ({ exists: Boolean(p) })));
      if (blocker) {
        console.log(`[warn] ${post.id}: ${blocker} - skipping.`);
        RUN.results.push(carouselBlockRow(post, 'linkedin', blocker));
        continue;
      }
    }
    let mediaPath = null;
    if (!textPost && !pollPost && !carouselPost) {
      mediaPath = resolveMediaPath(plan, post);
      if (!mediaPath) { console.log(`[warn] ${post.id}: due but local media not found (${post.path || post.file}) - skipping.`); continue; }
      if (!/\.(mp4|mov)$/i.test(mediaPath)) { console.log(`[warn] ${post.id}: not a video file - skipping (this script posts org videos).`); continue; }
      // Fresh-bytes A/V-sync backstop: probe the actual bytes about to upload (not the
      // manifest's stale author-time avSyncOk) - a measured desync is a malformed mux.
      const avBlock = await avSyncBlocker(mediaPath);
      if (avBlock) {
        console.log(`[warn] ${post.id}: ${avBlock} - skipping.`);
        RUN.results.push(avSyncBlockRow(post, 'linkedin', avBlock));
        continue;
      }
    }

    if (args['dry-run']) {
      if (pollPost) console.log(`[dry] ${post.id}: would create a PUBLISHED poll org post for ${orgUrn()} (${pollOptions(post).length} options).`);
      else if (carouselPost) console.log(`[dry] ${post.id}: would upload ${carouselPaths.length} images + create a PUBLISHED multiImage org post for ${orgUrn()}.`);
      else console.log(textPost
        ? `[dry] ${post.id}: would create a PUBLISHED text/article org post for ${orgUrn()}${post.image ? ` with thumbnail ${post.image}` : ' (no thumbnail)'}${post.description ? ' + card description' : ''}.`
        : `[dry] ${post.id}: would upload ${path.basename(mediaPath)} + create a PUBLISHED org post for ${orgUrn()}.`);
      continue;
    }

    console.log(`[info] ${post.id}: publishing ${pollPost ? 'poll post' : (carouselPost ? 'multiImage post' : (textPost ? 'text/article post' : 'HD render'))} to ${orgUrn()}...`);
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
      const videoUrn = (textPost || pollPost || carouselPost) ? null : await uploadVideo(mediaPath, token, resolveCoverPath(post, mediaPath));
      // Spec 05: register each carousel slide IN ORDER; a slide failure throws -> the
      // catch below pushes a structured ok:false row and NO post is created (fail-closed).
      let imageUrns = null;
      if (carouselPost) {
        imageUrns = [];
        for (const slide of carouselPaths) imageUrns.push(await uploadLocalImage(slide, token));
      }
      const postUrn = await createPost(post, videoUrn, token, thumbnailUrn, imageUrns);

      post.liPostId = postUrn;
      post.status = 'posted';
      post.postedAt = new Date(now).toISOString();
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'linkedin', action: 'publish', ok: true, errorCode: null, errorMessage: null, lateMin, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'linkedin', action: 'publish', ok: true, id: postUrn });
      console.log(`[ok] ${post.id}: published on LinkedIn (${postUrn}).`);
      published += 1;

      // Spec 11: universal self first-comment - reuses pendpost's generic
      // firstComment field, now extended to LinkedIn (mirrors the YT idiom,
      // yt-social.mjs:665-676). Fail-soft: a comment failure never fails the
      // already-published share; idempotent via liCommentId (a re-run - or the
      // `comment` recovery verb - posts nothing new once it is set).
      if (post.firstComment && !post.liCommentId) {
        try {
          const c = await postComment(postUrn, post.firstComment, token);
          post.liCommentId = c.id;
          await savePlan(abs, plan, [post.id]);
          RUN.results.push({ postId: post.id, platform: 'linkedin', action: 'post-comment', ok: true, id: c.id });
          console.log(`[ok] ${post.id}: first comment posted (${c.id}).`);
        } catch (err) {
          RUN.results.push({ postId: post.id, platform: 'linkedin', action: 'post-comment', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
          console.log(`[warn] ${post.id}: first comment failed - ${err.message}`);
        }
      }
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

// Post-hoc / standalone first-comment posting (optional retry path, spec 11) -
// modeled exactly on YT's cmdComment (yt-social.mjs:865-900). Skips no
// firstComment / no liPostId / already-posted (unless --force). LIVE-only
// (absent from MOCKABLE_COMMANDS, so main()'s mock-mode routing never reaches
// it - guard it here too, mirroring the YT precedent).
async function cmdComment(args) {
  if (resolveMode('linkedin') === 'mock') { console.log('[mock] comment is live-only - skipped in mock mode (no real LinkedIn call).'); return; }
  const { abs, plan } = loadPlan(args.plan);
  const token = args['dry-run'] ? null : await ensureFreshToken();
  let posted = 0;
  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isLinkedIn(post)) continue;
    if (!post.firstComment) { if (args.only) console.log(`[skip] ${post.id}: no firstComment set.`); continue; }
    if (!post.liPostId) { if (args.only) console.log(`[skip] ${post.id}: no liPostId yet.`); continue; }
    if (post.liCommentId && args.force !== true) {
      if (args.only) console.log(`[skip] ${post.id}: comment already posted (${post.liCommentId}) - pass --force to post again.`);
      continue;
    }
    if (args['dry-run']) {
      console.log(`[dry] ${post.id}: would post a comment on ${post.liPostId}:`);
      console.log(post.firstComment.split('\n').map((l) => `        ${l}`).join('\n'));
      continue;
    }
    try {
      const c = await postComment(post.liPostId, post.firstComment, token);
      post.liCommentId = c.id;
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'linkedin', action: 'post-comment', ok: true, errorCode: null, errorMessage: null, lateMin: 0, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'linkedin', action: 'post-comment', ok: true, id: c.id });
      console.log(`[ok] ${post.id}: comment posted (${c.id}).`);
      posted += 1;
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'linkedin', action: 'post-comment', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), lateMin: 0, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'linkedin', action: 'post-comment', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: comment failed - ${err.message}`);
    }
  }
  console.log(`[done] comment complete - ${posted} comment(s) posted.`);
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
        // Spec 08: two more fields the SAME totalShareStatistics response already
        // carries - no second call, no new scope beyond the existing org read.
        reach: s.uniqueImpressionsCount ?? null,
        engagement: s.engagement ?? null,
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

// A follower-statistics urn (e.g. urn:li:seniority:9) has no human label without
// a further lookup - the tail segment is the stable, honest bucket key.
const urnTail = (urn) => String(urn || '').split(':').pop();
const followerCount = (fc) => Number(fc?.organicFollowerCount || 0) + Number(fc?.paidFollowerCount || 0);

// Parse one organizationalEntityFollowerStatistics element into
// {seniority:{...}, function:{...}, industry:{...}, region:{...}} - the four
// breakdowns the Community Management follower-statistics surface returns
// alongside associationType/staffCountRange (not mapped here - out of scope).
function parseLiDemographics(el) {
  const mapBy = (rows, keyField) => {
    const out = {};
    for (const row of rows || []) {
      const key = urnTail(row?.[keyField]);
      if (key) out[key] = followerCount(row.followerCounts);
    }
    return out;
  };
  return {
    seniority: mapBy(el.followerCountsBySeniority, 'seniority'),
    function: mapBy(el.followerCountsByFunction, 'function'),
    industry: mapBy(el.followerCountsByIndustry, 'industry'),
    region: mapBy(el.followerCountsByRegion, 'geo'),
  };
}

// Account-scoped follower demographics (spec 07, Pattern P5) - called ONCE per
// evidence campaign by the insights sweep's generic account pass (spec 04). Needs
// the Community Management API's rw_organization_admin (ADMINISTRATOR role);
// missing it degrades to the structured needs_scope shape (P9), never a throw.
// Emits ONE account row { postId:null, platform:'linkedin', action:'demographics',
// ok, scope:'account', demographics:{...} }.
async function cmdDemographics() {
  const accountRow = (extra) => ({ postId: null, platform: 'linkedin', action: 'demographics', scope: 'account', ...extra });
  let token;
  try {
    token = await ensureFreshToken();
  } catch (err) {
    RUN.results.push(accountRow({ ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 300) }));
    return;
  }
  try {
    const { data } = await api('GET', `/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(orgUrn())}`, { token });
    const el = data.elements?.[0];
    if (!el) throw new Error('no organizationalEntityFollowerStatistics element in response');
    RUN.results.push(accountRow({ ok: true, demographics: parseLiDemographics(el) }));
    console.log('[ok] demographics fetched.');
  } catch (err) {
    if (/HTTP 403/.test(String(err.message || ''))) {
      RUN.results.push(accountRow({ ok: false, error: 'needs_scope', scope: 'rw_organization_admin' }));
      console.log('[warn] demographics: rw_organization_admin (Community Management API) not granted - no audience data available yet.');
      return;
    }
    RUN.results.push(accountRow({ ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 300) }));
    console.log(`[warn] demographics failed: ${err.message}`);
  }
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

// The inbound-engagement seam (spec 02, Pattern P6): read + reply to inbound
// comments on this lane's own posts. Thin wrappers over the shared, source-agnostic
// REST in lib/comments.mjs (dynamic import so the publish hot path's module graph is
// untouched). The result is merged onto RUN so main() emits the normalized
// { items } / { id } envelope; a needs_scope degrade sets ok:false (P9).
async function cmdComments(args) {
  const { runLaneComments } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneComments('linkedin', args));
}
async function cmdReply(args) {
  const { runLaneReply } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneReply('linkedin', args));
}
async function cmdModerate(args) {
  const { runLaneModerate } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneModerate('linkedin', args));
}
async function cmdReact(args) {
  const { runLaneReact } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneReact('linkedin', args));
}

// Connected-account discovery (spec 22, Pattern P3): which Organization Pages does
// this member ADMINISTER? Reads LINKEDIN_ACCESS_TOKEN directly via readEnv (NOT
// ensureFreshToken, which can process.exit on an expired token) so a missing/expired
// credential degrades to an ok:false row, never a crash. Lists only orgs where the
// member is an APPROVED ADMINISTRATOR (rw_organization_admin); picking one writes
// linkedinOrgUrn. Takes no --plan.
async function cmdDiscover() {
  const { discoverOk, discoverNeedsScope, discoverAuthError, markCurrent } = await import('../lib/discovery.mjs');
  const token = readEnv('LINKEDIN_ACCESS_TOKEN');
  if (!token) { RUN.results.push(discoverNeedsScope('linkedin')); return; }
  const sealed = readEnv('LINKEDIN_ORG_URN') || null;
  // Read IDENTITY FIRST (OpenID userinfo) so a later organizationAcls 403 - the common
  // "member connected but Pages scope not yet granted" case - still returns a needs_scope
  // row that CARRIES the identity (spec §2: "identity still shows on scope-not-granted").
  let identity = { id: 'linkedin', handle: null, name: 'LinkedIn' };
  try {
    const res = await fetch('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) { const info = await res.json(); identity = { id: info.sub || 'linkedin', handle: null, name: info.name || 'LinkedIn', avatarUrl: info.picture }; }
  } catch { /* userinfo needs the openid scope; the generic identity stands in */ }
  try {
    const { data: acls } = await api('GET', '/organizationAcls', { query: { q: 'roleAssignee', role: 'ADMINISTRATOR', state: 'APPROVED' }, token });
    const urns = (acls.elements || []).map((e) => e.organization).filter(Boolean);
    const assets = [];
    for (const urn of urns) {
      const numId = String(urn).split(':').pop();
      let name = urn;
      try {
        const { data: org } = await api('GET', `/organizations/${numId}`, { token });
        name = org.localizedName || org.vanityName || urn;
      } catch { /* org name is best-effort - the urn still identifies the Page */ }
      assets.push({ kind: 'page', id: urn, name });
    }
    const marked = markCurrent(assets, sealed);
    // If userinfo was unavailable, derive the identity name from the first managed Page.
    if (identity.name === 'LinkedIn' && marked.length) identity = { ...identity, name: marked[0].name };
    RUN.results.push(discoverOk('linkedin', { identity, assets: marked, selected: { linkedinOrgUrn: sealed } }));
  } catch (err) {
    const msg = String(err.message || err);
    // Scope 403 on the ACLs read: degrade to needs_scope but STILL carry the identity.
    if (/HTTP 403/.test(msg)) { RUN.results.push(discoverNeedsScope('linkedin', null, identity)); return; }
    RUN.results.push(discoverAuthError('linkedin', msg));
  }
}

const COMMANDS = {
  auth: cmdAuth,
  comments: cmdComments,
  reply: cmdReply,
  moderate: cmdModerate,
  react: cmdReact,
  refresh: cmdRefresh,
  validate: cmdValidate,
  'publish-due': cmdPublishDue,
  comment: cmdComment,
  status: cmdStatus,
  verify: cmdVerify,
  insights: cmdInsights,
  demographics: cmdDemographics,
  probe: cmdProbe,
  discover: cmdDiscover,
};

async function main() {
  const args = parseArgs(process.argv);
  await enforceCeremonyClient({ argv: args, command: args._[0], lane: 'linkedin', scriptUrl: import.meta.url });
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
      // spec 06: the moderate verb carries its action so the mock can branch per-lane.
      action: typeof args.action === 'string' ? args.action : null,
      // spec 24: the react verb carries its reaction/emoji/remove so the mock can branch per-lane.
      reaction: typeof args.reaction === 'string' ? args.reaction : null,
      emoji: typeof args.emoji === 'string' ? args.emoji : null,
      remove: args.remove === true,
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
  if (['validate', 'publish-due', 'status', 'insights', 'verify', 'comment', 'demographics'].includes(args._[0]) && !args.plan) {
    console.error(`[err] ${args._[0]} requires --plan <post-plan.json>`);
    process.exit(2);
  }
  await cmd(args);
  if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: true, ...RUN })}\n`);
}

// Run the CLI only when invoked directly (same guard as meta-social/yt-social) -
// an in-process test import must not execute main().
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (err) => {
    console.error('[err]', err.message || err);
    if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: false, error: String(err.message || err).slice(0, 300), ...RUN })}\n`);
    process.exit(1);
  });
}
