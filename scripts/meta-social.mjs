#!/usr/bin/env node
/**
 * meta-social.mjs - direct Meta (Facebook + Instagram) scheduling, no third-party service.
 *
 * Facebook: native scheduled posts via Graph API (published=false + scheduled_publish_time),
 *           which appear in the Meta Business Suite Planner for review.
 * Instagram: Meta exposes NO scheduling API, so IG entries are published at their due time
 *            by re-running `publish-due` (driven by a one-time Claude scheduled task).
 *
 * ALL media uploads straight from the local render folder (post.path / plan.folder + post.file):
 * FB videos as multipart to graph-video.facebook.com, IG Reels via Meta's resumable upload
 * protocol (rupload.facebook.com). No hosting layer, no Cloudinary.
 *
 * Source of truth: a post-plan.json (see data/plans/<campaign>/post-plan.json).
 *
 * Safety: every WRITE command is gated by a checked-in pause flag
 * (data/plans/meta-lane.json { paused } or env META_PUBLISHING_PAUSED). While
 * paused, writes are clean no-ops (envelope ok:true, paused:true); reads still
 * run. See docs/plans/platform/META-SUSPENSION-RECOVERY.md.
 *
 * Commands:
 *   setup        --token <short-lived-user-token> [--app-id X --app-secret Y] [--page-id P]   (LEGACY personal-token path)
 *   setup-system-user --system-user-token <T> [--page-id P] [--app-id X --app-secret Y]        (DURABLE Business System User identity)
 *   schedule       --plan <post-plan.json> [--only <postId>] [--dry-run]
 *   publish-due    --plan <post-plan.json> [--only <postId>] [--dry-run]
 *   set-thumbnail  --plan <post-plan.json> [--only <postId>] [--dry-run]   (post-hoc FB reel covers; IG is container-creation-only)
 *   insights       --plan <post-plan.json> [--only <postId>] --json          (read-only IG/FB metrics, defensive metric fallback)
 *   status         --plan <post-plan.json>
 *   delete         --id <fbPostId>
 *
 * Credentials live in gitignored .env (same convention as
 * upload-blog-hero.mjs): META_APP_ID, META_APP_SECRET, META_PAGE_ID, META_PAGE_TOKEN,
 * META_IG_USER_ID.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand, platformEnabled } from '../lib/mode.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
import { envPath } from '../lib/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The .env lives in the ACTIVE client subtree, resolved by the shared envPath()
// (lib/util.mjs -> activeRoot()): when the app spawns us it sets PENDPOST_ROOT to
// that client root; a bare CLI run resolves the active client from data/clients.json.
// Either way we read/write the SAME file the app reads - no orphan repo-root .env.
const ENV_PATH = envPath();
const DATA_ROOT = process.env.PENDPOST_ROOT ? path.join(process.env.PENDPOST_ROOT, 'data') : path.resolve(__dirname, '../data');
// The active client's posting config (config.json lives at the client root, the
// same PENDPOST_ROOT the engine is spawned under). Read directly here - the
// engine stays lean and self-rooting, exactly like META_LANE_FILE below.
const CONFIG_PATH = process.env.PENDPOST_ROOT ? path.join(process.env.PENDPOST_ROOT, 'config.json') : path.resolve(__dirname, '../config.json');
function loadClientConfig() {
  try { const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); return c && typeof c === 'object' ? c : {}; } catch { return {}; }
}
// Facebook is DENY-BY-DEFAULT (the 2026-06 Meta-suspension lesson: FB was the
// correlated trigger across three account suspensions). It publishes ONLY when
// the active client explicitly opts in (config.platforms.facebook === true) and
// is not force-disabled by the PENDPOST_DISABLED_PLATFORMS ops hard-lock. This is
// the single gate the three live FB write sites consult; Instagram is unaffected.
function facebookPublishingEnabled() {
  return platformEnabled('facebook', loadClientConfig());
}
const GRAPH = 'https://graph.facebook.com/v24.0';
const GRAPH_VIDEO = 'https://graph-video.facebook.com/v24.0';
const RUPLOAD = 'https://rupload.facebook.com/ig-api-upload/v24.0';
const RUPLOAD_VIDEO = 'https://rupload.facebook.com/video-upload/v24.0';

// ---------- env helpers ----------

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
    // function replacer, NOT a string replacement: a token value containing
    // '$NN' is special in String#replace and would be silently mangled.
    if (new RegExp(`^${k}=`, 'm').test(raw)) {
      raw = raw.replace(new RegExp(`^${k}=.*$`, 'm'), () => `${k}=${v}`);
    } else {
      raw += `${raw.endsWith('\n') || raw === '' ? '' : '\n'}${k}=${v}\n`;
    }
  }
  // Atomic + 0600: a crash mid-write must never truncate the whole .env, which
  // holds every platform secret.
  const tmp = `${ENV_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, raw, { mode: 0o600 });
  fs.renameSync(tmp, ENV_PATH);
}

function requireEnv(name) {
  const v = readEnv(name);
  if (!v) {
    console.error(`[err] ${name} missing in .env - run the setup command first.`);
    process.exit(1);
  }
  return v;
}

// ---------- graph helpers ----------

async function graph(method, pathname, params = {}, { base = GRAPH, form = null } = {}) {
  const url = new URL(`${base}${pathname}`);
  let body;
  if (form) {
    for (const [k, v] of Object.entries(params)) form.append(k, String(v));
    body = form;
  } else if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  } else {
    body = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  }
  const res = await fetch(url, { method, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    const err = new Error(`Graph ${method} ${pathname}: HTTP ${res.status} ${e.type || ''} ${e.code || ''} - ${e.message || JSON.stringify(data)}`);
    // Structured code so callers can branch (368 = action block -> circuit breaker).
    err.fbCode = typeof e.code === 'number' ? e.code : Number(e.code) || null;
    // Capture the named 368 fields the block recorder persists. error_user_msg is
    // the only human-readable lift hint Meta ever returns; error_data /
    // sentry_block_data is deliberately NOT captured (opaque + possibly sensitive).
    err.fbSubcode = e.error_subcode ?? null;
    err.fbUserTitle = e.error_user_title || null;
    err.fbUserMsg = e.error_user_msg || null;
    err.fbTraceId = e.fbtrace_id || null;
    err.httpStatus = res.status;
    throw err;
  }
  return data;
}

// ---------- IG resumable upload (binary straight from local disk) ----------

async function igResumableUpload(containerId, filePath, token) {
  const buf = fs.readFileSync(filePath);
  const res = await fetch(`${RUPLOAD}/${containerId}`, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${token}`,
      offset: '0',
      file_size: String(buf.length),
    },
    body: buf,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || data.success === false) {
    throw new Error(`rupload ${containerId}: HTTP ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

// ---------- FB Reels publish (full-bleed 9:16, 3-phase resumable, straight from local disk) ----------
//
// Unlike POST /{page-id}/videos (which posts a REGULAR video and pillarboxes a 9:16 clip
// into a landscape player), POST /{page-id}/video_reels posts a real full-bleed Reel.
// video_state accepts DRAFT (private, reviewable), PUBLISHED (now), or SCHEDULED
// (+ scheduled_publish_time -> appears in the Planner, Meta-fired).

async function publishFacebookReel(pageId, pageToken, mediaPath, { caption, videoState, scheduledAt }) {
  // Phase 1: start - obtain a video_id + upload_url
  const start = await graph('POST', `/${pageId}/video_reels`, {
    upload_phase: 'start',
    access_token: pageToken,
  });
  const videoId = start.video_id;
  const uploadUrl = start.upload_url || `${RUPLOAD_VIDEO}/${videoId}`;

  // Phase 2: upload the binary straight from local disk
  const buf = fs.readFileSync(mediaPath);
  const upRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${pageToken}`,
      offset: '0',
      file_size: String(buf.length),
    },
    body: buf,
  });
  const upData = await upRes.json().catch(() => ({}));
  if (!upRes.ok || upData.error || upData.success === false) {
    throw new Error(`FB reel rupload ${videoId}: HTTP ${upRes.status} ${JSON.stringify(upData)}`);
  }

  // Phase 3: finish - set the publish state
  const finishParams = {
    upload_phase: 'finish',
    video_id: videoId,
    video_state: videoState,
    access_token: pageToken,
  };
  if (caption) finishParams.description = caption;
  if (videoState === 'SCHEDULED' && scheduledAt) {
    finishParams.scheduled_publish_time = unixSeconds(scheduledAt);
  }
  await graph('POST', `/${pageId}/video_reels`, finishParams);
  return videoId;
}

// Custom reel cover via the classic Video Thumbnails edge - the mechanism the
// Reels Publishing doc itself links for "Add a custom cover photo for your
// reel": POST /{video-id}/thumbnails, multipart `source` file + is_preferred,
// page token. Max 10 MB, same aspect as the video. Works post-publish, so it
// also powers the post-hoc `set-thumbnail` command.
async function setFbReelThumbnail(videoId, jpgPath, pageToken) {
  const form = new FormData();
  form.append('source', new Blob([fs.readFileSync(jpgPath)], { type: 'image/jpeg' }), path.basename(jpgPath));
  form.append('is_preferred', 'true');
  await graph('POST', `/${videoId}/thumbnails`, { access_token: pageToken }, { form });
}

// Cover override materialized by pendpost (lib/covers.mjs):
// post.cover = { source: 'frame'|'file', offsetMs?, path } with a repo-relative
// path to the JPEG. Engines only ever READ it - the field is pendpost-owned.
function resolveCoverPath(post) {
  if (!post.cover?.path) return null;
  const abs = path.resolve(__dirname, '..', post.cover.path);
  return fs.existsSync(abs) ? abs : null;
}

async function pollVideoReady(videoId, pageToken, timeoutMs = 5 * 60 * 1000) {
  const start = Date.now();
  for (;;) {
    const res = await graph('GET', `/${videoId}`, { fields: 'status', access_token: pageToken });
    const vs = res.status?.video_status;
    if (vs === 'ready') return res.status;
    if (vs === 'error') throw new Error(`FB reel ${videoId} processing error: ${JSON.stringify(res.status)}`);
    if (Date.now() - start > timeoutMs) return res.status || { video_status: 'timeout' };
    await new Promise((r) => setTimeout(r, 5000));
  }
}

// ---------- plan helpers ----------
// (lock + field-merge save duplicated verbatim across the three engine
// siblings - self-contained per the sibling pattern, no shared lib)

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

// ---------- Meta lane kill switch (suspension safety) ----------
//
// A checked-in pause flag so no Meta WRITE (schedule / publish / draft upload /
// cover) fires while the account is suspended or being recovered. It travels
// with git, so pulling on the Mac applies it, and it is the ONE place that
// gates every write entry point (the pendpost scheduler still spawns the engine;
// the engine refuses cleanly with envelope { ok:true, paused:true } so the
// scheduler treats it as a no-op, NOT an engine_failure). READS (status /
// insights / probe) are never paused - a read is not an abusive action and the
// owner still needs visibility during recovery.
//
// Precedence: env META_PUBLISHING_PAUSED ("true"/"false") overrides the file;
// otherwise data/plans/meta-lane.json { paused } wins; default = active.
// See docs/plans/platform/META-SUSPENSION-RECOVERY.md.
const META_LANE_FILE = path.join(DATA_ROOT, 'plans', 'meta-lane.json');

// Multi-gate re-enable hardening (a prior post-suspension lesson): when the
// operator has declared a recovery gate set in meta-lane.json `reenableGates`, a
// bare paused:false CANNOT re-open the lane on its own - it resumes only when
// paused===false AND every declared canonical gate is true, forcing a conscious
// confirmation (account reinstated, business verified, migrated to a System User)
// before any Meta write resumes. Gates absent -> the legacy paused-boolean
// behavior, so a fresh checkout / un-recovered tenant is unaffected.
const META_REENABLE_GATES = ['accountReinstated', 'businessVerificationComplete', 'systemUserMigrated'];

function metaLaneState() {
  const envv = readEnv('META_PUBLISHING_PAUSED');
  if (envv != null) {
    const v = String(envv).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(v)) return { paused: true, source: 'env', reason: `META_PUBLISHING_PAUSED=${envv}` };
    if (['false', '0', 'no', 'off'].includes(v)) return { paused: false, source: 'env', reason: null };
  }
  try {
    const f = JSON.parse(fs.readFileSync(META_LANE_FILE, 'utf8'));
    if (f && typeof f === 'object') {
      if (f.reenableGates && typeof f.reenableGates === 'object') {
        if (f.paused !== false) return { paused: true, source: 'file', reason: f.reason || 'Meta lane paused - set paused:false AND every reenableGate true to resume' };
        const unmet = META_REENABLE_GATES.filter((g) => g in f.reenableGates && f.reenableGates[g] !== true);
        if (unmet.length) return { paused: true, source: 'file', reason: `Meta re-enable blocked - unconfirmed: ${unmet.join(', ')} (set true in meta-lane.json reenableGates to resume)` };
        return { paused: false, source: 'file', reason: f.reason || null };
      }
      if (typeof f.paused === 'boolean') return { paused: f.paused, source: 'file', reason: f.reason || null };
    }
  } catch { /* no readable flag file -> lane active */ }
  return { paused: false, source: 'default', reason: null };
}

// Returns true (and records a clean no-op) when the lane is paused; callers MUST
// `return` immediately so no Graph write is attempted.
function metaLanePaused(commandName) {
  const s = metaLaneState();
  if (!s.paused) return false;
  RUN.paused = true;
  RUN.results.push({ platform: 'meta', action: commandName, ok: true, skipped: 'lane_paused', reason: s.reason || null });
  console.log(`[paused] Meta lane is PAUSED (${s.source}) - skipping "${commandName}". ${s.reason || ''}`);
  console.log('[paused] Re-enable in data/plans/meta-lane.json (paused:false) or unset META_PUBLISHING_PAUSED, AFTER the account is reinstated + the System User migration is done. See docs/plans/platform/META-SUSPENSION-RECOVERY.md.');
  return true;
}

// 368 circuit breaker: record the action block in pendpost; if pendpost
// is down, leave an atomic sentinel it absorbs on next boot. Never retry-loop.
async function reportMetaBlock(err) {
  // 368 carries NO machine-readable clear time, so blockedUntil is only a
  // "recorded at +24h" display anchor; pendpost keeps the block active until
  // the owner explicitly clears it (it never auto-expires on this timestamp).
  const blockedUntil = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const reason = typeof err === 'string' ? err : (err?.message || 'Meta error 368');
  const payload = {
    blockedUntil,
    reason: String(reason).slice(0, 300),
    userMsg: err?.fbUserMsg ? String(err.fbUserMsg).slice(0, 300) : null,
    subcode: err?.fbSubcode ?? null,
    fbTraceId: err?.fbTraceId || null,
    source: 'meta-social.mjs',
  };
  try {
    const res = await fetch('http://127.0.0.1:8090/api/state/meta-block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log(`[block] Meta action block (368) recorded in pendpost until ${blockedUntil}.`);
  } catch {
    const sentinel = path.join(DATA_ROOT, 'plans', '.meta-block.json');
    const tmp = `${sentinel}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    fs.renameSync(tmp, sentinel);
    console.log(`[block] pendpost unreachable - 368 sentinel written to ${sentinel}.`);
  }
}

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

function unixSeconds(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Unparseable scheduledAt: ${iso}`);
  return Math.floor(ms / 1000);
}

function fmtLocal(iso, tz) {
  return new Date(iso).toLocaleString('en-US', { timeZone: tz || 'UTC' });
}

// ---------- commands ----------

async function cmdSetup(args) {
  console.log(`[info] Connecting Meta (Facebook + Instagram) - credentials will be written to ${ENV_PATH}`);
  if (!args.token) {
    console.error('Usage: node scripts/meta-social.mjs setup --token <short-lived-user-token> [--app-id X --app-secret Y] [--page-id P]');
    process.exit(2);
  }
  const appId = args['app-id'] || readEnv('META_APP_ID');
  const appSecret = args['app-secret'] || readEnv('META_APP_SECRET');
  if (!appId || !appSecret) {
    console.error('[err] Need --app-id and --app-secret (from the Meta app dashboard, Settings > Basic) on first run.');
    process.exit(2);
  }

  console.log('[info] Exchanging for a long-lived user token...');
  const exchanged = await graph('GET', '/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: args.token,
  });
  const userToken = exchanged.access_token;
  console.log(`[ok] Long-lived user token acquired (expires_in: ${exchanged.expires_in || 'n/a'}s).`);

  console.log('[info] Fetching pages...');
  const accounts = await graph('GET', '/me/accounts', { access_token: userToken, fields: 'id,name,access_token' });
  const pages = accounts.data || [];
  if (!pages.length) {
    console.error('[err] No pages on this account. Is the user an admin of your Facebook Page, and did the token include pages_show_list?');
    process.exit(1);
  }
  let page = pages[0];
  if (args['page-id']) page = pages.find((p) => p.id === args['page-id']);
  if (pages.length > 1 && !args['page-id']) {
    console.log('[warn] Multiple pages found - using the first. Re-run with --page-id to pick another:');
    pages.forEach((p) => console.log(`       ${p.id}  ${p.name}`));
  }
  if (!page) {
    console.error(`[err] Page ${args['page-id']} not found among: ${pages.map((p) => `${p.id} (${p.name})`).join(', ')}`);
    process.exit(1);
  }
  console.log(`[ok] Page: ${page.name} (${page.id}). Page token acquired (long-lived, non-expiring).`);

  let igUserId = null;
  try {
    const igRes = await graph('GET', `/${page.id}`, { access_token: page.access_token, fields: 'instagram_business_account' });
    igUserId = igRes.instagram_business_account?.id || null;
  } catch (err) {
    console.log(`[warn] Could not query instagram_business_account: ${err.message}`);
  }
  if (igUserId) {
    console.log(`[ok] Linked Instagram professional account: ${igUserId}`);
  } else {
    console.log('[warn] No Instagram professional account linked to this page. IG publishing will not work until your Instagram account is professional + linked to the page (IG app: Settings > Business tools > Connect a Facebook Page).');
  }

  writeEnv({
    META_APP_ID: appId,
    META_APP_SECRET: appSecret,
    META_PAGE_ID: page.id,
    META_PAGE_TOKEN: page.access_token,
    META_IG_USER_ID: igUserId,
  });
  console.log(`[ok] Credentials written to ${path.relative(process.cwd(), ENV_PATH)}.`);
  console.log('[next] Flip the Meta app to LIVE mode (App dashboard toggle) - development-mode posts are invisible to the public.');
  console.log('[note] This personal-token exchange is the legacy path. The durable identity is a Business System User: assign the Page + IG to a System User, then mint a non-expiring page token from its token into META_PAGE_TOKEN (keep the System User token as META_SYSTEM_USER_TOKEN for re-minting). No App Review needed - owned-asset publishing already works.');
}

// Durable identity for automated publishing (the path the legacy cmdSetup note
// points at). A Business System User OWNS the publishing - it does NOT ride a
// human's personal account, which is exactly what Meta expects for API posting
// and the single biggest lever against the suspension/368 pattern. The System
// User token is minted in Business Settings (never-expiring), your Page
// + IG are assigned to it, and the page token derived from it is non-expiring
// while that assignment stands.
async function cmdSetupSystemUser(args) {
  console.log(`[info] Connecting Meta (Facebook + Instagram) - credentials will be written to ${ENV_PATH}`);
  const token = args['system-user-token'] || args.token;
  if (!token) {
    console.error('Usage: node scripts/meta-social.mjs setup-system-user --system-user-token <SYSTEM_USER_TOKEN> [--page-id P] [--app-id X --app-secret Y]');
    console.error('  Mint it in Business Settings > Users > System users > (an ADMIN system user) > Generate new token,');
    console.error('  with your Meta app selected, "Token never expires" ON, and scopes: pages_show_list,');
    console.error('  pages_manage_posts, pages_read_engagement, business_management, instagram_basic, instagram_content_publish.');
    console.error('  The Page + linked IG professional account must be ASSIGNED to that System User (Assign assets).');
    process.exit(2);
  }
  // Optional debug_token check: confirm it really never expires (defensive, non-fatal).
  const appId = args['app-id'] || readEnv('META_APP_ID');
  const appSecret = args['app-secret'] || readEnv('META_APP_SECRET');
  if (appId && appSecret) {
    try {
      const info = await graph('GET', '/debug_token', { input_token: token, access_token: `${appId}|${appSecret}` });
      const d = info.data || {};
      const exp = d.expires_at === 0 ? 'never' : (d.expires_at ? new Date(d.expires_at * 1000).toISOString() : 'unknown');
      console.log(`[info] Token type=${d.type || '?'} app=${d.app_id || '?'} valid=${d.is_valid} expires=${exp}`);
      if (d.expires_at && d.expires_at !== 0) {
        console.log('[warn] This token EXPIRES. Regenerate the System User token with "Token never expires" ON for a durable identity.');
      }
    } catch (err) {
      console.log(`[warn] debug_token check skipped: ${err.message}`);
    }
  }

  console.log('[info] Fetching pages assigned to this System User...');
  const accounts = await graph('GET', '/me/accounts', { access_token: token, fields: 'id,name,access_token' });
  const pages = accounts.data || [];
  if (!pages.length) {
    console.error('[err] No pages visible to this System User. Assign your Facebook Page to it in Business Settings > Users > System users > Assign assets (with full content/Manage Page tasks).');
    process.exit(1);
  }
  let page = pages[0];
  if (args['page-id']) page = pages.find((p) => p.id === args['page-id']);
  if (pages.length > 1 && !args['page-id']) {
    console.log('[warn] Multiple pages assigned - using the first. Re-run with --page-id to pick another:');
    pages.forEach((p) => console.log(`       ${p.id}  ${p.name}`));
  }
  if (!page) {
    console.error(`[err] Page ${args['page-id']} not found among: ${pages.map((p) => `${p.id} (${p.name})`).join(', ')}`);
    process.exit(1);
  }
  console.log(`[ok] Page: ${page.name} (${page.id}). Page token derived from the System User (non-expiring while the assignment stands).`);

  let igUserId = null;
  try {
    const igRes = await graph('GET', `/${page.id}`, { access_token: page.access_token, fields: 'instagram_business_account' });
    igUserId = igRes.instagram_business_account?.id || null;
  } catch (err) {
    console.log(`[warn] Could not query instagram_business_account: ${err.message}`);
  }
  if (igUserId) console.log(`[ok] Linked Instagram professional account: ${igUserId}`);
  else console.log('[warn] No IG professional account linked + assigned - IG publishing stays off until it is.');

  writeEnv({
    ...(appId ? { META_APP_ID: appId } : {}),
    ...(appSecret ? { META_APP_SECRET: appSecret } : {}),
    META_PAGE_ID: page.id,
    META_PAGE_TOKEN: page.access_token,
    META_IG_USER_ID: igUserId,
    META_SYSTEM_USER_TOKEN: token,
  });
  console.log(`[ok] Credentials written to ${path.relative(process.cwd(), ENV_PATH)} - META_PAGE_TOKEN now derives from the System User; META_SYSTEM_USER_TOKEN stored for re-minting.`);
  console.log('[note] Keep the Meta lane PAUSED (data/plans/meta-lane.json) until Business Verification is complete AND Meta has reinstated the account. The System User identity is necessary but not sufficient on its own - the account must be healthy first.');
}

async function scheduleFacebookPost(post, pageId, pageToken, mediaPath, dryRun) {
  const publishAt = unixSeconds(post.scheduledAt);
  const nowSec = Math.floor(Date.now() / 1000);
  if (publishAt < nowSec + 10 * 60) {
    console.log(`[warn] ${post.id}: scheduledAt is less than 10 min out (FB minimum) - skipping FB half. Reschedule or post manually.`);
    return null;
  }
  if (publishAt > nowSec + 30 * 24 * 3600) {
    console.log(`[warn] ${post.id}: scheduledAt is more than 30 days out (FB maximum) - skipping FB half.`);
    return null;
  }
  const caption = post.caption || post.title || '';
  if (dryRun) {
    console.log(`[dry] ${post.id}: would schedule FB ${mediaPath ? 'video' : 'text'} post for ${post.scheduledAt}`);
    return null;
  }
  if (mediaPath) {
    const buf = fs.readFileSync(mediaPath);
    const form = new FormData();
    form.append('source', new Blob([buf], { type: 'video/mp4' }), path.basename(mediaPath));
    const res = await graph('POST', `/${pageId}/videos`, {
      description: caption,
      published: 'false',
      scheduled_publish_time: publishAt,
      access_token: pageToken,
    }, { base: GRAPH_VIDEO, form });
    return res.id;
  }
  const res = await graph('POST', `/${pageId}/feed`, {
    message: caption,
    ...(post.link ? { link: post.link } : {}),
    published: 'false',
    scheduled_publish_time: publishAt,
    access_token: pageToken,
  });
  return res.id;
}

async function cmdSchedule(args) {
  if (metaLanePaused('schedule')) return;
  const { abs, plan } = loadPlan(args.plan);
  const pageId = requireEnv('META_PAGE_ID');
  const pageToken = requireEnv('META_PAGE_TOKEN');
  const fbEnabled = facebookPublishingEnabled();
  const igTasks = [];
  const touched = new Set();
  let dirty = false;

  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (post.executionMode !== 'fully-scheduled') continue;
    if (post.status !== 'planned') continue;
    // Fail-closed approval (SS-01): missing field = draft = never publish.
    if ((post.approval || 'draft') !== 'approved') {
      console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish.`);
      continue;
    }
    const platforms = post.platforms || [];
    const mediaPath = resolveMediaPath(plan, post);
    if (post.file && !mediaPath) {
      console.log(`[warn] ${post.id}: media file not found (${post.path || post.file}) - skipping.`);
      continue;
    }

    if (platforms.includes('facebook') && !post.fbPostId && !fbEnabled) {
      console.log(`[skip] ${post.id}: facebook publishing is disabled by platform policy (instagram unaffected). Enable via config.platforms.facebook=true on a healthy Page.`);
    } else if (platforms.includes('facebook') && !post.fbPostId) {
      console.log(`[info] ${post.id}: scheduling FB post for ${fmtLocal(post.scheduledAt, plan.timezone)}...`);
      try {
        const fbPostId = await scheduleFacebookPost(post, pageId, pageToken, mediaPath, args['dry-run']);
        if (fbPostId) {
          post.fbPostId = fbPostId;
          appendAttempt(post, { ts: new Date().toISOString(), platform: 'facebook', action: 'schedule-native', ok: true, errorCode: null, errorMessage: null, lateMin: 0, actor: ACTOR });
          dirty = true;
          touched.add(post.id);
          RUN.results.push({ postId: post.id, platform: 'facebook', action: 'schedule-native', ok: true, id: fbPostId });
          console.log(`[ok] ${post.id}: FB scheduled (post id ${fbPostId}) - review it in the Meta Business Suite Planner.`);
        }
      } catch (err) {
        appendAttempt(post, { ts: new Date().toISOString(), platform: 'facebook', action: 'schedule-native', ok: false, errorCode: err.fbCode || 'engine_failure', errorMessage: err.message.slice(0, 300), lateMin: 0, actor: ACTOR });
        dirty = true;
        touched.add(post.id);
        RUN.results.push({ postId: post.id, platform: 'facebook', action: 'schedule-native', ok: false, errorCode: err.fbCode || 'engine_failure', errorMessage: err.message.slice(0, 300) });
        console.error(`[err] ${post.id}: FB scheduling failed - ${err.message}`);
        if (err.fbCode === 368) {
          RUN.blocked368 = true;
          await savePlan(abs, plan, [...touched]);
          await reportMetaBlock(err);
          break;
        }
      }
    }

    if (platforms.includes('instagram')) {
      igTasks.push(post);
    }

    if (platforms.includes('facebook') && !platforms.includes('instagram') && post.fbPostId) {
      post.status = 'scheduled';
      dirty = true;
      touched.add(post.id);
    }
  }

  if (dirty) await savePlan(abs, plan, [...touched]);

  if (igTasks.length) {
    console.log('\n[next] Instagram has no scheduling API - create ONE-TIME Claude scheduled tasks at these times:');
    for (const post of igTasks) {
      console.log(`  - ${post.scheduledAt}  (${post.id}): node scripts/meta-social.mjs publish-due --plan ${path.relative(process.cwd(), abs)}`);
    }
  }
  console.log('[done] schedule complete.');
}

async function pollContainer(containerId, igToken, timeoutMs = 5 * 60 * 1000) {
  const start = Date.now();
  for (;;) {
    const res = await graph('GET', `/${containerId}`, { fields: 'status_code', access_token: igToken });
    if (res.status_code === 'FINISHED') return;
    if (res.status_code === 'ERROR' || res.status_code === 'EXPIRED') {
      throw new Error(`IG container ${containerId} status: ${res.status_code}`);
    }
    if (Date.now() - start > timeoutMs) throw new Error(`IG container ${containerId} not ready after ${timeoutMs / 1000}s`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function cmdPublishDue(args) {
  if (metaLanePaused('publish-due')) return;
  const { abs, plan } = loadPlan(args.plan);
  const pageId = requireEnv('META_PAGE_ID');
  const pageToken = requireEnv('META_PAGE_TOKEN');
  const igUserId = requireEnv('META_IG_USER_ID');
  const fbEnabled = facebookPublishingEnabled();
  const now = Date.now();
  let published = 0;

  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (post.executionMode !== 'fully-scheduled') continue;
    if (post.status !== 'planned') continue;
    // Fail-closed approval (SS-01): missing field = draft = never publish.
    if ((post.approval || 'draft') !== 'approved') {
      console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish.`);
      continue;
    }
    const platforms = post.platforms || [];
    // FB only publishes full-bleed reels here (video_reels); IG publishes reels + stories.
    // FB is gated by the per-client platform policy (deny-by-default); a disabled
    // FB target is skipped while IG still publishes.
    const fbTargeted = platforms.includes('facebook') && post.type === 'reel';
    if (fbTargeted && !fbEnabled) console.log(`[skip] ${post.id}: facebook publishing is disabled by platform policy (instagram unaffected).`);
    const wantsFb = fbTargeted && fbEnabled;
    const wantsIg = platforms.includes('instagram');
    if (!wantsFb && !wantsIg) continue;
    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs) || dueMs > now) continue;

    const lateMin = Math.round((now - dueMs) / 60000);
    if (lateMin > 15) console.log(`[warn] ${post.id}: publishing ${lateMin} min late (catch-up).`);

    const mediaPath = resolveMediaPath(plan, post);
    if (!mediaPath) {
      console.log(`[warn] ${post.id}: due but local media not found (${post.path || post.file}) - skipping.`);
      continue;
    }
    if (!/\.(mp4|mov)$/i.test(mediaPath)) {
      console.log(`[warn] ${post.id}: image posts are not supported in local-file mode (API requires a public image_url) - post manually.`);
      continue;
    }

    if (args['dry-run']) {
      const targets = [
        wantsFb && !post.fbReelId ? 'FB-reel' : null,
        wantsIg && !post.igMediaId ? `IG-${post.type}` : null,
      ].filter(Boolean).join(' + ');
      console.log(`[dry] ${post.id}: would publish ${targets || '(nothing - already done)'} from ${mediaPath}`);
      continue;
    }

    // Facebook full-bleed Reel (POST /video_reels, PUBLISHED). Per-platform idempotent via fbReelId.
    if (wantsFb && !post.fbReelId) {
      console.log(`[info] ${post.id}: publishing full-bleed FB Reel...`);
      try {
        const vid = await publishFacebookReel(pageId, pageToken, mediaPath, { caption: post.caption || '', videoState: 'PUBLISHED' });
        await pollVideoReady(vid, pageToken);
        post.fbReelId = vid;
        appendAttempt(post, { ts: new Date().toISOString(), platform: 'facebook', action: 'publish-reel', ok: true, errorCode: null, errorMessage: null, lateMin, actor: ACTOR });
        await savePlan(abs, plan, [post.id]);
        RUN.results.push({ postId: post.id, platform: 'facebook', action: 'publish-reel', ok: true, id: vid });
        console.log(`[ok] ${post.id}: published on Facebook (reel ${vid}).`);
        // Cover override: cosmetic + non-fatal - the publish stands either way.
        const fbCover = resolveCoverPath(post);
        if (fbCover) {
          try {
            await setFbReelThumbnail(vid, fbCover, pageToken);
            RUN.results.push({ postId: post.id, platform: 'facebook', action: 'set-thumbnail', ok: true, id: vid });
            console.log(`[ok] ${post.id}: custom FB cover applied.`);
          } catch (err) {
            RUN.results.push({ postId: post.id, platform: 'facebook', action: 'set-thumbnail', ok: false, errorCode: err.fbCode || 'engine_failure', errorMessage: err.message.slice(0, 300) });
            console.log(`[warn] ${post.id}: FB cover failed (reel keeps the default cover) - ${err.message}`);
          }
        }
      } catch (err) {
        appendAttempt(post, { ts: new Date().toISOString(), platform: 'facebook', action: 'publish-reel', ok: false, errorCode: err.fbCode || 'engine_failure', errorMessage: err.message.slice(0, 300), lateMin, actor: ACTOR });
        await savePlan(abs, plan, [post.id]);
        RUN.results.push({ postId: post.id, platform: 'facebook', action: 'publish-reel', ok: false, errorCode: err.fbCode || 'engine_failure', errorMessage: err.message.slice(0, 300) });
        console.error(`[err] ${post.id}: FB Reel failed - ${err.message}`);
        if (err.fbCode === 368) {
          RUN.blocked368 = true;
          await reportMetaBlock(err);
          break;
        }
      }
    }

    // Instagram Reel or Story. Stories take NO caption/share_to_feed/firstComment (API ignores them).
    if (wantsIg && !post.igMediaId) {
      const isStory = post.type === 'story';
      try {
        console.log(`[info] ${post.id}: creating IG resumable ${isStory ? 'STORIES' : 'REELS'} container...`);
        const containerParams = { media_type: isStory ? 'STORIES' : 'REELS', upload_type: 'resumable', access_token: pageToken };
        if (!isStory) {
          containerParams.caption = post.caption || '';
          containerParams.share_to_feed = 'true';
          // IG cover control exists ONLY at container creation and ONLY as a
          // frame offset (thumb_offset, milliseconds) - cover_url needs public
          // hosting (none in this pipeline), and stories have no cover at all.
          if (post.cover?.source === 'frame' && Number.isFinite(post.cover.offsetMs)) {
            containerParams.thumb_offset = String(Math.max(0, Math.round(post.cover.offsetMs)));
            console.log(`[info] ${post.id}: IG cover frame at ${containerParams.thumb_offset} ms (thumb_offset).`);
          } else if (post.cover) {
            console.log(`[warn] ${post.id}: IG accepts only FRAME covers (thumb_offset) - the file cover is not applied on IG.`);
          } else {
            // No explicit cover: default the reel thumbnail ~1s in so IG never
            // falls back to frame 0 (often a black/blank first frame). Reels are
            // >= 3s, so 1000 ms is always within bounds - no probe needed.
            containerParams.thumb_offset = '1000';
            console.log(`[info] ${post.id}: IG cover defaulted to 1000 ms (no explicit cover; avoids a blank first-frame cover).`);
          }
        }
        const container = await graph('POST', `/${igUserId}/media`, containerParams);
        console.log(`[info] ${post.id}: uploading ${(fs.statSync(mediaPath).size / 1e6).toFixed(1)} MB from ${mediaPath}...`);
        await igResumableUpload(container.id, mediaPath, pageToken);
        await pollContainer(container.id, pageToken);
        const media = await graph('POST', `/${igUserId}/media_publish`, { creation_id: container.id, access_token: pageToken });
        post.igMediaId = media.id;
        appendAttempt(post, { ts: new Date().toISOString(), platform: 'instagram', action: isStory ? 'publish-story' : 'publish-reel', ok: true, errorCode: null, errorMessage: null, lateMin, actor: ACTOR });
        await savePlan(abs, plan, [post.id]);
        RUN.results.push({ postId: post.id, platform: 'instagram', action: isStory ? 'publish-story' : 'publish-reel', ok: true, id: media.id });
        console.log(`[ok] ${post.id}: published on Instagram (media id ${media.id}).`);

        if (!isStory && post.firstComment) {
          try {
            await graph('POST', `/${media.id}/comments`, { message: post.firstComment, access_token: pageToken });
            console.log(`[ok] ${post.id}: first comment added.`);
          } catch (err) {
            console.log(`[warn] ${post.id}: first comment failed - ${err.message}`);
          }
        }
      } catch (err) {
        appendAttempt(post, { ts: new Date().toISOString(), platform: 'instagram', action: isStory ? 'publish-story' : 'publish-reel', ok: false, errorCode: err.fbCode || 'engine_failure', errorMessage: err.message.slice(0, 300), lateMin, actor: ACTOR });
        await savePlan(abs, plan, [post.id]);
        RUN.results.push({ postId: post.id, platform: 'instagram', action: isStory ? 'publish-story' : 'publish-reel', ok: false, errorCode: err.fbCode || 'engine_failure', errorMessage: err.message.slice(0, 300) });
        console.error(`[err] ${post.id}: IG publish failed - ${err.message}`);
        if (err.fbCode === 368) {
          RUN.blocked368 = true;
          await reportMetaBlock(err);
          break;
        }
      }
    }

    // Mark posted only when every required platform succeeded (mid-failure leaves it planned to retry).
    const fbDone = !wantsFb || post.fbReelId;
    const igDone = !wantsIg || post.igMediaId;
    if (fbDone && igDone) {
      post.status = 'posted';
      post.postedAt = new Date(now).toISOString();
      await savePlan(abs, plan, [post.id]);
      published += 1;
    }
  }

  console.log(`[done] publish-due complete - ${published} post(s) published.`);
}

async function cmdStatus(args) {
  const pageId = requireEnv('META_PAGE_ID');
  const pageToken = requireEnv('META_PAGE_TOKEN');
  console.log('[info] FB scheduled posts on the page (these are what the Planner shows):');
  const res = await graph('GET', `/${pageId}/scheduled_posts`, {
    fields: 'id,message,scheduled_publish_time',
    access_token: pageToken,
  });
  const rows = res.data || [];
  if (!rows.length) console.log('  (none)');
  for (const p of rows) {
    const when = new Date(p.scheduled_publish_time * 1000).toISOString();
    console.log(`  ${p.id}  ${when}  ${(p.message || '').slice(0, 60).replace(/\n/g, ' ')}`);
  }
  if (args.plan) {
    const { plan } = loadPlan(args.plan);
    console.log('\n[info] Plan entries (fb state fetched live - scheduled VIDEOS are hidden from the list edges above until they publish):');
    for (const post of plan.posts || []) {
      let fbState = '';
      if (post.fbPostId) {
        try {
          const v = await graph('GET', `/${post.fbPostId}`, { fields: 'scheduled_publish_time,published', access_token: pageToken });
          fbState = v.published ? ` fb=${post.fbPostId} PUBLISHED` : ` fb=${post.fbPostId} scheduled for ${v.scheduled_publish_time}`;
        } catch (err) {
          fbState = ` fb=${post.fbPostId} NOT FOUND (deleted?)`;
        }
      }
      console.log(`  ${post.id.padEnd(18)} ${post.status.padEnd(10)} ${post.scheduledAt}  mode=${post.executionMode}${fbState}${post.igMediaId ? ` ig=${post.igMediaId}` : ''}`);
    }
  }
}

async function cmdDelete(args) {
  if (!args.id) {
    console.error('Usage: node scripts/meta-social.mjs delete --id <fbPostId>');
    process.exit(2);
  }
  const pageToken = requireEnv('META_PAGE_TOKEN');
  await graph('DELETE', `/${args.id}`, { access_token: pageToken });
  console.log(`[ok] Deleted FB post ${args.id}.`);
}

async function cmdFbReel(args) {
  if (metaLanePaused('fbreel')) return;
  // Facebook deny-by-default: refuse EVERY fbreel invocation (incl. DRAFT, which
  // still POSTs to graph-video.facebook.com against the Page) unless the active
  // client opts in. This is the last direct FB Graph path in the engine.
  if (!facebookPublishingEnabled()) {
    RUN.results.push({ platform: 'facebook', action: 'fbreel', ok: true, skipped: 'facebook_disabled' });
    console.log('[skip] facebook publishing is disabled by platform policy - fbreel is a no-op. Enable via config.platforms.facebook=true on a healthy Page.');
    return;
  }
  const pageId = requireEnv('META_PAGE_ID');
  const pageToken = requireEnv('META_PAGE_TOKEN');
  const state = (args.state || 'DRAFT').toUpperCase();
  let mediaPath = args.file || null;
  let caption = args.caption || '';
  let scheduledAt = args.at || null;
  if (args.plan && args.only) {
    const { plan } = loadPlan(args.plan);
    const post = (plan.posts || []).find((p) => p.id === args.only);
    if (!post) { console.error(`[err] post ${args.only} not found in plan`); process.exit(1); }
    // Fail-closed approval (SS-01) for anything that goes live; DRAFT uploads
    // stay allowed - they ARE the owner's quality-review path.
    if (state !== 'DRAFT' && (post.approval || 'draft') !== 'approved') {
      console.error(`[err] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish (DRAFT uploads are exempt).`);
      process.exit(1);
    }
    mediaPath = resolveMediaPath(plan, post);
    caption = post.caption || '';
    scheduledAt = post.scheduledAt;
  }
  if (!mediaPath || !fs.existsSync(mediaPath)) { console.error(`[err] media not found: ${mediaPath}`); process.exit(1); }
  console.log(`[info] FB Reel ${state}: uploading ${(fs.statSync(mediaPath).size / 1e6).toFixed(1)} MB from ${mediaPath}...`);
  const videoId = await publishFacebookReel(pageId, pageToken, mediaPath, { caption, videoState: state, scheduledAt });
  console.log(`[ok] FB Reel created (video_id ${videoId}, state ${state}). Polling processing...`);
  const status = await pollVideoReady(videoId, pageToken);
  console.log(`[info] processing status: ${JSON.stringify(status)}`);
  try {
    const v = await graph('GET', `/${videoId}`, { fields: 'permalink_url,length,published,source,format', access_token: pageToken });
    console.log(`[info] permalink: ${v.permalink_url || '(draft - none yet)'}  length: ${v.length || '?'}s  published: ${v.published}`);
    if (Array.isArray(v.format)) {
      console.log('[info] renditions:');
      for (const f of v.format) console.log(`   ${f.filter}: ${f.width}x${f.height}`);
    }
    if (v.source) console.log(`[info] source URL present (HD master): ${v.source.slice(0, 90)}...`);
    console.log(`=RESULT=${JSON.stringify({ videoId, state, permalink: v.permalink_url || null, format: v.format || null, hasSource: Boolean(v.source) })}`);
  } catch (err) {
    console.log(`[warn] rendition query failed (often expected for DRAFT): ${err.message}`);
    console.log(`=RESULT=${JSON.stringify({ videoId, state, note: 'rendition fields unavailable for this state' })}`);
  }
}

// ---------- main ----------

// Post-hoc cover application for already-published FB reels (fbReelId set +
// post.cover materialized). IG has NO post-hoc cover API (container-creation
// only), so IG-only posts are skipped with an honest log line.
async function cmdSetThumbnail(args) {
  if (metaLanePaused('set-thumbnail')) return;
  const { abs, plan } = loadPlan(args.plan);
  const pageToken = requireEnv('META_PAGE_TOKEN');
  let applied = 0;
  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    const coverPath = resolveCoverPath(post);
    if (!coverPath) {
      if (args.only) console.log(`[skip] ${post.id}: no materialized cover override (set one via pendpost first).`);
      continue;
    }
    if (!post.fbReelId) {
      if (post.igMediaId) console.log(`[skip] ${post.id}: IG has no post-hoc cover API (thumb_offset is container-creation-only) - cannot re-cover a published IG post.`);
      else if (args.only) console.log(`[skip] ${post.id}: no fbReelId yet - the cover applies automatically at publish.`);
      continue;
    }
    if (args['dry-run']) {
      console.log(`[dry] ${post.id}: would set FB reel ${post.fbReelId} cover from ${coverPath}.`);
      continue;
    }
    try {
      await setFbReelThumbnail(post.fbReelId, coverPath, pageToken);
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'facebook', action: 'set-thumbnail', ok: true, errorCode: null, errorMessage: null, lateMin: 0, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'facebook', action: 'set-thumbnail', ok: true, id: post.fbReelId });
      console.log(`[ok] ${post.id}: FB reel ${post.fbReelId} cover updated.`);
      applied += 1;
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'facebook', action: 'set-thumbnail', ok: false, errorCode: err.fbCode || 'engine_failure', errorMessage: err.message.slice(0, 300), lateMin: 0, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'facebook', action: 'set-thumbnail', ok: false, errorCode: err.fbCode || 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: FB cover failed - ${err.message}`);
      if (err.fbCode === 368) {
        RUN.blocked368 = true;
        await reportMetaBlock(err);
        break;
      }
    }
  }
  console.log(`[done] set-thumbnail complete - ${applied} cover(s) applied.`);
}

// Read-only metrics fetch (Phase E). Metric names on the Graph API churn
// across versions, so each surface tries a DESCENDING list of metric sets and
// falls back to plain count fields - whatever succeeds is reported, a total
// miss is an honest ok:false entry. Writes NOTHING (pendpost stores the
// envelope in its own state.json; plan files stay metric-free).
const IG_METRIC_SETS = [
  'views,reach,likes,comments,shares,saved,total_interactions',
  'reach,likes,comments,shares,saved',
  'plays,reach,likes,comments',
];
const FB_REEL_METRIC_SETS = [
  'blue_reels_play_count,post_impressions_unique',
  'total_video_views',
];

function insightsToMetrics(data) {
  const metrics = {};
  for (const row of data?.data || []) {
    const value = row.values?.[0]?.value ?? row.total_value?.value;
    if (typeof value === 'number') metrics[row.name] = value;
  }
  return metrics;
}

async function fetchIgInsights(mediaId, token) {
  for (const metric of IG_METRIC_SETS) {
    try {
      const metrics = insightsToMetrics(await graph('GET', `/${mediaId}/insights`, { metric, access_token: token }));
      if (Object.keys(metrics).length) return metrics;
    } catch { /* metric set not supported for this media - try the next */ }
  }
  // Plain count fields exist on every media object - the floor, never empty.
  const media = await graph('GET', `/${mediaId}`, { fields: 'like_count,comments_count', access_token: token });
  return { likes: media.like_count ?? null, comments: media.comments_count ?? null };
}

async function fetchFbReelInsights(videoId, token) {
  for (const metric of FB_REEL_METRIC_SETS) {
    try {
      const metrics = insightsToMetrics(await graph('GET', `/${videoId}/video_insights`, { metric, access_token: token }));
      if (Object.keys(metrics).length) return metrics;
    } catch { /* try the next set */ }
  }
  throw new Error(`no supported video_insights metric set for ${videoId}`);
}

async function cmdInsights(args) {
  const { plan } = loadPlan(args.plan);
  const pageToken = requireEnv('META_PAGE_TOKEN');
  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (post.igMediaId) {
      try {
        const metrics = await fetchIgInsights(post.igMediaId, pageToken);
        RUN.results.push({ postId: post.id, platform: 'instagram', action: 'insights', ok: true, id: post.igMediaId, metrics });
        console.log(`[ok] ${post.id}: IG ${JSON.stringify(metrics)}`);
      } catch (err) {
        RUN.results.push({ postId: post.id, platform: 'instagram', action: 'insights', ok: false, errorCode: err.fbCode || 'engine_failure', errorMessage: err.message.slice(0, 300) });
        console.log(`[warn] ${post.id}: IG insights failed - ${err.message}`);
      }
    }
    if (post.fbReelId) {
      try {
        const metrics = await fetchFbReelInsights(post.fbReelId, pageToken);
        RUN.results.push({ postId: post.id, platform: 'facebook', action: 'insights', ok: true, id: post.fbReelId, metrics });
        console.log(`[ok] ${post.id}: FB ${JSON.stringify(metrics)}`);
      } catch (err) {
        RUN.results.push({ postId: post.id, platform: 'facebook', action: 'insights', ok: false, errorCode: err.fbCode || 'engine_failure', errorMessage: err.message.slice(0, 300) });
        console.log(`[warn] ${post.id}: FB insights failed - ${err.message}`);
      }
    }
  }
  console.log(`[done] insights complete - ${RUN.results.filter((r) => r.ok).length} fetched.`);
}

// Read-only verification (read-back): confirm whether a handed-off post is
// actually live on Facebook/Instagram. Pure GET - NOT a write, so it is
// deliberately NOT in META_WRITE_COMMANDS and never gated by the lane-pause kill
// switch (pendpost's background sweep skips Meta when paused; the manual path
// always reads). Writes NOTHING - prints the envelope lib/verify.mjs persists.
async function cmdVerify(args) {
  const { plan } = loadPlan(args.plan);
  const pageToken = requireEnv('META_PAGE_TOKEN');
  const isMeta = (p) => { const pl = p.platforms || []; return pl.includes('facebook') || pl.includes('instagram'); };
  const missingRe = /does not exist|nonexisting|Unsupported get request|cannot be loaded/i;
  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isMeta(post)) continue;
    const platforms = post.platforms || [];
    const fbId = post.fbReelId || post.fbPostId;
    if (platforms.includes('facebook') && fbId) {
      try {
        const v = await graph('GET', `/${fbId}`, { fields: 'permalink_url,published', access_token: pageToken });
        const live = Boolean(v.published);
        RUN.results.push({ postId: post.id, platform: 'facebook', action: 'verify', ok: true, id: fbId, live, state: live ? 'published' : 'scheduled', permalink: v.permalink_url || null });
        console.log(`[ok] ${post.id}: FB verify live=${live}`);
      } catch (err) {
        if (missingRe.test(err.message || '')) {
          RUN.results.push({ postId: post.id, platform: 'facebook', action: 'verify', ok: true, id: fbId, live: false, state: 'missing', permalink: null });
        } else {
          RUN.results.push({ postId: post.id, platform: 'facebook', action: 'verify', ok: false, errorCode: err.fbCode || 'engine_failure', errorMessage: err.message.slice(0, 300) });
        }
        console.log(`[warn] ${post.id}: FB verify - ${err.message}`);
      }
    }
    if (platforms.includes('instagram') && post.igMediaId) {
      try {
        const v = await graph('GET', `/${post.igMediaId}`, { fields: 'permalink', access_token: pageToken });
        RUN.results.push({ postId: post.id, platform: 'instagram', action: 'verify', ok: true, id: post.igMediaId, live: true, state: 'published', permalink: v.permalink || null });
        console.log(`[ok] ${post.id}: IG verify live=true`);
      } catch (err) {
        if (missingRe.test(err.message || '')) {
          RUN.results.push({ postId: post.id, platform: 'instagram', action: 'verify', ok: true, id: post.igMediaId, live: false, state: 'missing', permalink: null });
        } else {
          RUN.results.push({ postId: post.id, platform: 'instagram', action: 'verify', ok: false, errorCode: err.fbCode || 'engine_failure', errorMessage: err.message.slice(0, 300) });
        }
        console.log(`[warn] ${post.id}: IG verify - ${err.message}`);
      }
    }
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

// Read-only liveness probe for the pendpost health bar. GET /me?fields=id,name
// proves the PAGE TOKEN is valid (id must equal META_PAGE_ID); it says NOTHING
// about a 368 action block (a read is not a blocked action). pendpost MUST gate
// this behind isMetaBlocked and never spawn it while blocked, both to keep the
// block tile honest and to send zero Graph traffic during a block. Takes no --plan.
async function cmdProbe() {
  const pageToken = readEnv('META_PAGE_TOKEN');
  const pageId = readEnv('META_PAGE_ID');
  if (!pageToken || !pageId) {
    RUN.results.push({ platform: 'meta', action: 'probe', ok: false, detail: 'not configured (Page token/Page ID missing)' });
    return;
  }
  try {
    const me = await graph('GET', '/me', { fields: 'id,name', access_token: pageToken });
    const ok = String(me.id) === String(pageId);
    RUN.results.push({ platform: 'meta', action: 'probe', ok, detail: ok ? `${me.name || 'Page'} (${me.id})` : `Token belongs to ${me.id}, expected ${pageId}` });
  } catch (err) {
    RUN.results.push({ platform: 'meta', action: 'probe', ok: false, detail: String(err.message || err).slice(0, 200) });
  }
}

const COMMANDS = {
  setup: cmdSetup,
  'setup-system-user': cmdSetupSystemUser,
  schedule: cmdSchedule,
  'publish-due': cmdPublishDue,
  status: cmdStatus,
  verify: cmdVerify,
  delete: cmdDelete,
  fbreel: cmdFbReel,
  'set-thumbnail': cmdSetThumbnail,
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
  // The lane-pause kill switch (NFR-ANTIBAN-03) is mode-INDEPENDENT: a paused
  // lane must never publish, even in mock mode. The mock dispatch below would
  // otherwise mint fake ids and bypass the brake, so the pause check runs FIRST
  // for WRITE commands. Reads (insights/probe/validate) are never paused. A
  // paused write emits the clean { ok:true, paused:true } no-op the scheduler
  // treats as a no-op, NOT an engine_failure.
  const META_WRITE_COMMANDS = new Set(['schedule', 'publish-due', 'publish', 'fbreel', 'set-thumbnail']);
  if (META_WRITE_COMMANDS.has(commandName) && metaLanePaused(commandName)) {
    const envelope = { ok: true, ...RUN };
    if (JSON_MODE) process.stdout.write(`${JSON.stringify(envelope)}\n`);
    else console.error(`[paused] meta ${commandName}: lane paused, no-op`);
    return;
  }
  // Mock mode: publish/read commands never touch Graph - delegate to the shared
  // mock driver and emit its envelope. Credential commands still run for real.
  if (resolveMode('meta') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'meta', command: commandName,
      planPath: typeof args.plan === 'string' ? path.resolve(String(args.plan)) : null,
      only: typeof args.only === 'string' ? args.only : null,
    });
    if (JSON_MODE) process.stdout.write(`${JSON.stringify(envelope)}\n`);
    else console.error(`[mock] meta ${commandName}: ${envelope.results.length} result(s)`);
    return;
  }
  const cmd = COMMANDS[commandName];
  if (!cmd) {
    console.error(`Usage: node scripts/meta-social.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
    process.exit(2);
  }
  if (['schedule', 'publish-due', 'set-thumbnail', 'insights', 'verify'].includes(args._[0]) && !args.plan) {
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
