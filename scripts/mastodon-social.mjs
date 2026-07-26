#!/usr/bin/env node
/**
 * mastodon-social.mjs - direct Mastodon status publishing via the instance REST API.
 *
 * Sibling of scripts/telegram-social.mjs / discord-social.mjs: the same zero-dep,
 * plan-driven, publish-straight-from-the-local-render pattern, with Mastodon's
 * (pleasantly boring) static-token auth + posting model.
 *
 * NATIVE SCHEDULING (owner decision 2026-07-05, reversing the earlier
 * publish-at-due-time choice): `schedule` hands an approved entry to the INSTANCE
 * ahead of its due time (POST /statuses with scheduled_at), so it fires on time
 * even when this machine is off - the same survives-power-off model as
 * yt-social.mjs (private + publishAt). The plan stays the source of truth via a
 * full reconcile story, not by refusing the remote queue:
 *   - the scheduled object is REMEMBERED (post.mastodonScheduledId) and
 *     CANCELLABLE: `unschedule --id` deletes it (DELETE /scheduled_statuses/:id);
 *     lib/writes.mjs nativeHandoff drives that on unschedule/reschedule/edit.
 *   - the fired status has a NEW id (Mastodon mints one at fire time; the
 *     scheduled-status id dies), so `resolve` closes the loop after the due
 *     minute: it reads the queue, finds the fired status on the account timeline
 *     (text match) and records post.mastodonStatusId + posted. If the instance
 *     never fired (queue entry still parked well past due), resolve cancels it
 *     and publishes immediately.
 * Constraints: the instance rejects a scheduled_at less than ~5 minutes out
 * (MIN_SCHEDULE_LEAD_MS guards it - an entry inside that window just publishes AT
 * due time via the past-due fallback), and media must upload at schedule time.
 * `publish-due` is kept for manual/late runs - `schedule` falls back to the same
 * immediate publish when an entry is already past due.
 *
 * AUTH - a single static access token, no ceremony:
 *   MASTODON_INSTANCE_URL   the home instance (e.g. https://mastodon.social);
 *                           trailing slashes are stripped on read.
 *   MASTODON_ACCESS_TOKEN   an app token from the instance's own
 *                           Preferences -> Development -> New application
 *                           (scopes: read write:statuses write:media
 *                           write:accounts write:follows - the last two cover
 *                           pin/unpin (spec 31), follow/unfollow (spec 31) and
 *                           profile editing (spec 28); a token minted before
 *                           spec 31 lacks them and degrades to needs_scope
 *                           until it is reconnected).
 * `connect`/`auth` here is a validation handshake (verify_credentials): there is
 * no token to mint, so it only confirms the static creds actually authenticate,
 * then persists MASTODON_HANDLE (the acct) to .env for display.
 *
 * Media uploads stream straight from the local render folder (post.path /
 * plan.folder + post.file) as a v2/media multipart upload - no hosting layer.
 * A 202 from v2/media means the instance is still transcoding: we poll
 * GET /api/v1/media/:id until it settles (200 + url) before creating the status.
 * Text comes from post.mastodonCaption (falls back to post.caption), the additive
 * per-platform override pattern x uses for xCaption. Statuses are capped at the
 * default instance limit of 500 chars (instances can raise it; we enforce the
 * conservative default). The permalink comes back on the status object (`url`).
 *
 * Commands:
 *   auth | connect   validate the static creds (verify_credentials); persists MASTODON_HANDLE
 *   refresh          no-op (access tokens are static) - kept for sibling parity
 *   validate         --plan <p> [--only <id>]   side-effect-free preview, never posts
 *   schedule         --plan <p> [--only <id>] [--dry-run]   natively schedule (scheduled_at); publishes NOW when past due
 *   resolve          --plan <p> [--only <id>]   post-due reconcile: record the fired status id (or republish a parked queue entry)
 *   publish-due      --plan <p> [--only <id>] [--dry-run]   publish any due Mastodon entry (manual/late path)
 *   status           --plan <p>                 list Mastodon plan entries
 *   verify           --plan <p> [--only <id>]   read-only liveness (GET the status / the scheduled queue entry)
 *   insights         --plan <p> [--only <id>]   real metrics (favourites/reblogs/replies)
 *   probe                                        read-only health probe (verify_credentials)
 *   delete           --id <statusId>             delete a LIVE status (cleanup)
 *   unschedule       --id <scheduledId>          cancel a natively-scheduled queue entry
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand } from '../lib/mode.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
import { isPollPost, pollOptions, pollDurationMinutes, pollMultiple, pollBlocker, pollBlockRow, POLL_LANE_LIMITS } from '../lib/poll.mjs';
import { isCarouselPost, carouselItems, carouselBlocker, carouselBlockRow, carouselUnsupported } from '../lib/carousel.mjs';
import { envPath } from '../lib/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = envPath();

// Mastodon caps a status at 500 chars by default (per-instance configurable; we
// enforce the conservative default so a plan ports across instances).
const TEXT_LIMIT = 500;

// Spec 28 (profile edit): Mastodon's own default caps on account/update_credentials
// (per-instance configurable; the conservative shipped default, mirrors TEXT_LIMIT's
// reasoning so a profile edit ports across instances).
const PROFILE_MAX = { name: 30, bio: 500 };

// Async media processing: poll every 2s, give up after ~60s.
const MEDIA_POLL_MS = 2000;
const MEDIA_POLL_CAP_MS = 60 * 1000;

// The instance rejects a scheduled_at less than ~5 minutes in the future (422).
// 7 minutes keeps clear of that floor plus the media-upload/poll time; an entry
// already inside the window is NOT scheduled early - it publishes AT due time.
const MIN_SCHEDULE_LEAD_MS = 7 * 60 * 1000;

// resolve: a queue entry still parked this long PAST due means the instance is
// not going to fire it - cancel it and publish immediately instead.
const RESOLVE_REPUBLISH_GRACE_MS = 10 * 60 * 1000;

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

// Trailing slashes stripped so `${instance}/api/...` never double-slashes.
const instanceUrl = () => (readEnv('MASTODON_INSTANCE_URL') || '').trim().replace(/\/+$/, '');
const accessToken = () => readEnv('MASTODON_ACCESS_TOKEN');

// ---------- Mastodon API helper ----------

// Returns { status, data } (not bare data like the telegram helper) because the
// v2/media handshake is status-driven: 202 = still processing, and the poll loop
// needs to distinguish 200 (done) from 206 (partial/processing) without throwing.
async function masto(method, apiPath, { body, form, headers } = {}) {
  const url = `${instanceUrl()}${apiPath}`;
  const init = { method, headers: { Authorization: `Bearer ${accessToken()}`, ...(headers || {}) } };
  if (form) init.body = form;
  else if (body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(url, init);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Mastodon ${method} ${apiPath}: HTTP ${res.status} - ${data.error || data.raw || text || 'unknown'}`);
    // Status rides the error object (mirrors yt-social.mjs api()'s err.status) so a
    // 403 (missing OAuth scope) can be classified as needs_scope without re-parsing
    // the message text - the profile-probe/profile-update verb is the first masto()
    // caller that needs this.
    err.status = res.status;
    throw err;
  }
  return { status: res.status, data };
}

// ---------- plan helpers (same shape as the sibling engines) ----------

function loadPlan(planPath) {
  const abs = path.resolve(planPath);
  return { abs, plan: JSON.parse(fs.readFileSync(abs, 'utf8')) };
}

// Spec 31: mastodonPinned rides the SAME plan-lock save protocol as every other
// engine-owned field (post.ids.mastodonPinned in the client DTO, lib/plans.mjs) -
// the optional echo cmdPin/cmdUnpin write so PostDetail's "Pin to profile"/"Unpin"
// toggle renders the current state without a re-fetch.
const ENGINE_OWNED_FIELDS = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'xPostId', 'tgMessageId', 'dcMessageId', 'redditPostId', 'pinId', 'tiktokVideoId', 'mastodonStatusId', 'mastodonScheduledId', 'mastodonPinned', 'wordpressPostId', 'ghostPostId', 'nostrEventId', 'gbpPostId', 'status', 'postedAt', 'attempts', 'radarReplyState', 'radarFollowup'];

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

const isMastodon = (post) => (post.platforms || []).includes('mastodon');
const isTextPost = (post) => post.type === 'text';
const statusText = (post) => (post.mastodonCaption || post.caption || '').trim();
// Spec 25: Mastodon counts spoiler_text (the content warning) toward the SAME
// 500-char status limit as the body (status_length_validator combines them), so
// the pre-publish gate must measure the combined length or the instance 422s at
// fire time on a body that fits alone but overflows once the CW is added.
const combinedLen = (post, text) => text.length + (post.spoilerText || '').length;

// Spec 10: the Mastodon poll param for POST /api/v1/statuses. { poll: { options,
// expires_in (seconds), multiple } }; a status carries EITHER a poll OR media, never
// both, so a poll post uploads nothing. Empty object for a non-poll post so the body
// stays byte-identical to before this feature.
function mastoPollBody(post) {
  if (!isPollPost(post)) return {};
  return { poll: { options: pollOptions(post), expires_in: pollDurationMinutes(post) * 60, multiple: pollMultiple(post) } };
}

// Upload local media via v2/media. A 202 means the instance is still processing
// (video transcode): poll v1/media/:id until it settles at 200 with a url.
async function uploadMedia(mediaPath, post, deadline = null) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(mediaPath)]), path.basename(mediaPath));
  // Best-effort alt text: post.title is the only short human descriptor in the plan schema.
  // Spec 05 follow-up: this makes every slide of an album share ONE alt string, which is
  // wrong for a real album but is the honest state of the schema today (there is no
  // mediaItems[].alt field). Flagged, not fixed here.
  const alt = (post.title || '').trim();
  if (alt) form.append('description', alt);
  const up = await masto('POST', '/api/v2/media', { form });
  const mediaId = up.data?.id;
  if (!mediaId) throw new Error(`media upload returned no id: ${JSON.stringify(up.data).slice(0, 200)}`);
  if (up.status === 202) {
    // E2: `deadline` is the ALBUM's shared budget, passed by uploadAlbum. Per-slide
    // deadlines would let four slides stack four full poll caps and blow the lane
    // timeout; one shared deadline bounds the whole album instead.
    const until = deadline ?? (Date.now() + MEDIA_POLL_CAP_MS);
    for (;;) {
      await new Promise((r) => setTimeout(r, MEDIA_POLL_MS));
      const poll = await masto('GET', `/api/v1/media/${encodeURIComponent(mediaId)}`);
      if (poll.status === 200 && poll.data?.url) break;
      if (Date.now() > until) throw new Error(`media ${mediaId} still processing at the album deadline`);
    }
  }
  return String(mediaId);
}

// E2: upload an album's slides in authored ORDER and return the media_ids in that order,
// because the order is what publishes. Sequential, not parallel: the instance rate-limits
// media uploads, and a partial album is never posted anyway (a throw here aborts before
// the status create).
async function uploadAlbum(paths, post) {
  const deadline = Date.now() + MEDIA_POLL_CAP_MS;
  const ids = [];
  for (const p of paths) ids.push(await uploadMedia(p, post, deadline));
  return ids;
}

// One immediate publish - shared by publish-due and schedule's past-due
// fallback: upload media when present, create the status, mint the fields.
// The caller saves the plan and records the attempt/envelope rows.
async function publishNow(plan, post, { text, mediaPath, carouselPaths = null, now }) {
  // E2: an album uploads every slide in order; a single-media post keeps its one upload.
  let mediaIds = [];
  if (carouselPaths && carouselPaths.length) mediaIds = await uploadAlbum(carouselPaths, post);
  else if (mediaPath) mediaIds = [await uploadMedia(mediaPath, post)];
  // Idempotency-Key: a retried tick after a lost response must not double-post.
  const { data: resp } = await masto('POST', '/api/v1/statuses', {
    // Spec 25: a content warning (post.spoilerText) rides spoiler_text and marks
    // the status sensitive:true so it renders behind the CW until expanded;
    // unset -> neither field is sent, byte-identical to today.
    // Spec 10: a native poll (mastoPollBody) rides the same create call (mutually
    // exclusive with media, which a poll never carries).
    body: { status: text, ...(mediaIds.length ? { media_ids: mediaIds } : {}), visibility: 'public', ...(post.spoilerText ? { spoiler_text: post.spoilerText, sensitive: true } : {}), ...mastoPollBody(post) },
    headers: { 'Idempotency-Key': `${plan.campaign || 'plan'}:${post.id}` },
  });
  const statusId = resp?.id;
  if (!statusId) throw new Error(`status create returned no id: ${JSON.stringify(resp).slice(0, 200)}`);
  post.mastodonStatusId = String(statusId);
  post.status = 'posted';
  post.postedAt = new Date(now).toISOString();
  return resp;
}

// The instance wraps a status in HTML (<p>, <br>, anchors); strip it down to
// comparable plain text. resolve's timeline match is text-based BECAUSE the
// scheduled-status id is not the fired status id (Mastodon mints a new one).
function statusPlainText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const matchKey = (s) => statusPlainText(s).slice(0, 80);

// ---------- commands ----------

async function cmdAuth() {
  if (!instanceUrl()) { console.error('[err] MASTODON_INSTANCE_URL missing in .env (your home instance, e.g. https://mastodon.social).'); process.exit(2); }
  if (!accessToken()) { console.error('[err] MASTODON_ACCESS_TOKEN missing in .env (Preferences -> Development -> New application; scopes read write:statuses write:media).'); process.exit(2); }
  const { data: me } = await masto('GET', '/api/v1/accounts/verify_credentials');
  writeEnv({ MASTODON_HANDLE: me.acct });
  console.log(`[ok] authenticated as @${me.acct} on ${instanceUrl()}`);
  RUN.results.push({ platform: 'mastodon', action: 'auth', ok: true, detail: `@${me.acct} on ${instanceUrl()}` });
}

async function cmdRefresh() {
  console.log('[info] Mastodon access tokens are static (no refresh).');
}

async function cmdValidate(args) {
  const { plan } = loadPlan(args.plan);
  console.log('================ VALIDATION ONLY - NOTHING WILL BE PUBLISHED ================');
  try {
    const { data: me } = await masto('GET', '/api/v1/accounts/verify_credentials');
    console.log(`[ok] Token valid - authenticated as @${me.acct}.`);
  } catch (err) {
    console.log(`[warn] verify_credentials failed (${err.message}). Continuing to caption preview.`);
  }
  const targets = (plan.posts || []).filter((p) => isMastodon(p) && (!args.only || p.id === args.only));
  if (!targets.length) { console.log('[warn] No Mastodon entries match.'); return; }
  for (const post of targets) {
    const text = statusText(post);
    console.log(`\n----- ${post.id} -----`);
    console.log(`[preview] type:    ${post.type}`);
    console.log(`[preview] text (${combinedLen(post, text)}/${TEXT_LIMIT}${combinedLen(post, text) > TEXT_LIMIT ? ' - OVER LIMIT (incl. content warning)' : ''}):`);
    console.log(text);
    if (!isTextPost(post)) {
      const mediaPath = resolveMediaPath(plan, post);
      if (!mediaPath) console.log(`[warn] media not found (${post.path || post.file}).`);
      else console.log(`[preview] media:   ${path.basename(mediaPath)} (${(fs.statSync(mediaPath).size / 1e6).toFixed(1)} MB)`);
    }
  }
  console.log('\n================ VALIDATION COMPLETE ================');
}

async function cmdPublishDue(args) {
  const { abs, plan } = loadPlan(args.plan);
  if (!instanceUrl() || !accessToken()) throw new Error('MASTODON_INSTANCE_URL / MASTODON_ACCESS_TOKEN not set - cannot publish.');
  const now = Date.now();
  let published = 0;

  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isMastodon(post)) continue;
    if (post.executionMode !== 'fully-scheduled') continue;
    if (post.status !== 'planned') continue;
    if ((post.approval || 'draft') !== 'approved') {
      console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish.`);
      continue;
    }
    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs) || dueMs > now) continue;

    const text = statusText(post);
    const textPost = isTextPost(post);
    // Spec 10: a native poll status - the question is the caption; carries no media.
    const pollPost = isPollPost(post);
    if ((textPost || pollPost) && !text) { console.log(`[warn] ${post.id}: due but no ${pollPost ? 'poll question' : 'text'} (mastodonCaption/caption) - skipping.`); continue; }
    if (pollPost) {
      const blocker = pollBlocker(post, text, POLL_LANE_LIMITS.mastodon);
      if (blocker) {
        console.log(`[warn] ${post.id}: ${blocker} - skipping.`);
        RUN.results.push(pollBlockRow(post, 'mastodon', blocker));
        continue;
      }
    }
    if (combinedLen(post, text) > TEXT_LIMIT) { console.log(`[warn] ${post.id}: text${post.spoilerText ? ' + content warning' : ''} is ${combinedLen(post, text)} chars (> ${TEXT_LIMIT}) - skipping.`); continue; }

    // E2 (spec 05): a native album of up to 4 attachments. Fail-closed BEFORE any remote
    // call (count/cap/mix + slides-on-disk), and refuse the shapes the instance rejects
    // outright (any video slide), never a half-posted status. Mirrors the discord lane.
    const carouselPost = isCarouselPost(post);
    let carouselPaths = [];
    if (carouselPost) {
      carouselPaths = carouselItems(post).map((it) => resolveMediaPath(plan, { file: it.file, path: it.path }));
      const blocker = carouselBlocker(post, 'mastodon', carouselPaths.map((x) => ({ exists: Boolean(x) })))
        || carouselUnsupported(post, 'mastodon');
      if (blocker) {
        console.log(`[warn] ${post.id}: ${blocker} - skipping.`);
        RUN.results.push(carouselBlockRow(post, 'mastodon', blocker));
        continue;
      }
    }
    let mediaPath = null;
    if (!textPost && !pollPost && !carouselPost) {
      mediaPath = resolveMediaPath(plan, post);
      if (!mediaPath) { console.log(`[warn] ${post.id}: due but local media not found (${post.path || post.file}) - skipping.`); continue; }
    }

    if (args['dry-run']) {
      if (pollPost) console.log(`[dry] ${post.id}: would post a poll status (${pollOptions(post).length} options).`);
      else if (carouselPost) console.log(`[dry] ${post.id}: would upload ${carouselPaths.length} slides + one status (album).`);
      else console.log(textPost ? `[dry] ${post.id}: would post a text status (${text.length} chars).` : `[dry] ${post.id}: would upload ${path.basename(mediaPath)} + status.`);
      continue;
    }

    console.log(`[info] ${post.id}: publishing ${pollPost ? 'poll status' : (textPost ? 'text status' : 'media')} to Mastodon...`);
    try {
      const resp = await publishNow(plan, post, { text, mediaPath, carouselPaths, now });
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'mastodon', action: 'publish', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'publish', ok: true, id: post.mastodonStatusId });
      console.log(`[ok] ${post.id}: published on Mastodon (status ${post.mastodonStatusId}${resp.url ? ` - ${resp.url}` : ''}).`);
      published += 1;
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'mastodon', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: Mastodon publish failed - ${err.message}`);
      continue;
    }
  }
  console.log(`[done] publish-due complete - ${published} status(es) published.`);
}

// Native scheduling: hand every approved future entry to the instance (POST
// /statuses with scheduled_at) so it fires with this machine off. Media uploads
// NOW (schedule time). A past-due entry publishes immediately instead - the
// native window is gone and stranding it would regress the old publish-due
// behavior; an entry inside the ~5-minute minimum lead just waits for that
// fallback (never posts early).
async function cmdSchedule(args) {
  const { abs, plan } = loadPlan(args.plan);
  if (!instanceUrl() || !accessToken()) throw new Error('MASTODON_INSTANCE_URL / MASTODON_ACCESS_TOKEN not set - cannot schedule.');
  const now = Date.now();
  let scheduled = 0;
  let published = 0;

  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isMastodon(post)) continue;
    if (post.executionMode !== 'fully-scheduled') continue;
    if (post.status !== 'planned') continue;
    if ((post.approval || 'draft') !== 'approved') {
      console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish.`);
      continue;
    }
    if (post.mastodonStatusId || post.mastodonScheduledId) {
      console.log(`[skip] ${post.id}: already ${post.mastodonStatusId ? 'published' : 'natively scheduled'}.`);
      continue;
    }
    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs)) { console.log(`[warn] ${post.id}: unparseable scheduledAt "${post.scheduledAt}" - skipping.`); continue; }

    // Spec 34: a Radar reply-to-external post replies to the signal's status
    // (in_reply_to_id) instead of publishing a NEW status. It reached here only after a
    // DISTINCT human approved it (never auto-approved). A reply is not natively scheduled -
    // it posts immediately. Fail-closed: a 404 target => radar_target_gone.
    if (post.radarReplyTo) {
      const rr = post.radarReplyTo;
      // WRONG-TARGET guard (safety review #3b): fire ONLY when the reply's source is this lane.
      if (rr.source !== 'mastodon') { RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'publish', ok: false, errorCode: 'invalid_input', errorMessage: `radarReplyTo.source '${rr.source}' does not match the mastodon lane` }); continue; }
      // EARLY-FIRE guard (safety review #4): mastodon is a native-anytime lane (dispatched
      // ahead of due), but a REPLY must not post before its scheduledAt. Skip until due -
      // an operator who reschedules an approved reply to tomorrow is honored.
      if (dueMs > now) { console.log(`[skip] ${post.id}: radar reply not due yet (${post.scheduledAt}).`); continue; }
      const body = statusText(post);
      if (!body) { RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'publish', ok: false, errorCode: 'invalid_input', errorMessage: 'radar reply needs a caption' }); continue; }
      const { radarHttp } = await import('../lib/radar.mjs');
      const { ok, status, json } = await radarHttp(`${instanceUrl()}/api/v1/statuses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: body, in_reply_to_id: String(rr.externalId) }),
      });
      if (!ok || !json?.id) {
        const gone = status === 404;
        const code = gone ? 'radar_target_gone' : (status === 401 || status === 403 ? 'needs_scope' : 'engine_failure');
        // TERMINAL target-gone (safety review #5): stop owing the lane so it never re-fires.
        if (gone) { post.radarReplyState = 'target_gone'; await savePlan(abs, plan, [post.id]); }
        RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'publish', ok: false, errorCode: code, errorMessage: `mastodon reply HTTP ${status}` });
        continue;
      }
      post.mastodonStatusId = String(json.id);
      post.status = 'posted';
      post.postedAt = new Date().toISOString();
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'publish', ok: true, id: post.mastodonStatusId, radarReply: rr.externalId });
      published += 1;
      continue;
    }

    const text = statusText(post);
    const textPost = isTextPost(post);
    // Spec 10: a native poll rides the same native-schedule path as a text status.
    const pollPost = isPollPost(post);
    if ((textPost || pollPost) && !text) { console.log(`[warn] ${post.id}: no ${pollPost ? 'poll question' : 'text'} (mastodonCaption/caption) - skipping.`); continue; }
    if (pollPost) {
      const blocker = pollBlocker(post, text, POLL_LANE_LIMITS.mastodon);
      if (blocker) {
        console.log(`[warn] ${post.id}: ${blocker} - skipping.`);
        RUN.results.push(pollBlockRow(post, 'mastodon', blocker));
        continue;
      }
    }
    if (combinedLen(post, text) > TEXT_LIMIT) { console.log(`[warn] ${post.id}: text${post.spoilerText ? ' + content warning' : ''} is ${combinedLen(post, text)} chars (> ${TEXT_LIMIT}) - skipping.`); continue; }
    // E2 (spec 05): a native album of up to 4 attachments. Fail-closed BEFORE any remote
    // call (count/cap/mix + slides-on-disk), and refuse the shapes the instance rejects
    // outright (any video slide), never a half-posted status. Mirrors the discord lane.
    const carouselPost = isCarouselPost(post);
    let carouselPaths = [];
    if (carouselPost) {
      carouselPaths = carouselItems(post).map((it) => resolveMediaPath(plan, { file: it.file, path: it.path }));
      const blocker = carouselBlocker(post, 'mastodon', carouselPaths.map((x) => ({ exists: Boolean(x) })))
        || carouselUnsupported(post, 'mastodon');
      if (blocker) {
        console.log(`[warn] ${post.id}: ${blocker} - skipping.`);
        RUN.results.push(carouselBlockRow(post, 'mastodon', blocker));
        continue;
      }
    }
    let mediaPath = null;
    if (!textPost && !pollPost && !carouselPost) {
      mediaPath = resolveMediaPath(plan, post);
      if (!mediaPath) { console.log(`[warn] ${post.id}: local media not found (${post.path || post.file}) - skipping.`); continue; }
    }

    if (dueMs <= now) {
      if (args['dry-run']) { console.log(`[dry] ${post.id}: past due - would publish immediately.`); continue; }
      console.log(`[info] ${post.id}: past due - publishing immediately (native window gone)...`);
      try {
        const resp = await publishNow(plan, post, { text, mediaPath, carouselPaths, now });
        appendAttempt(post, { ts: new Date().toISOString(), platform: 'mastodon', action: 'publish', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
        await savePlan(abs, plan, [post.id]);
        RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'publish', ok: true, id: post.mastodonStatusId });
        console.log(`[ok] ${post.id}: published on Mastodon (status ${post.mastodonStatusId}${resp.url ? ` - ${resp.url}` : ''}).`);
        published += 1;
      } catch (err) {
        appendAttempt(post, { ts: new Date().toISOString(), platform: 'mastodon', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), actor: ACTOR });
        await savePlan(abs, plan, [post.id]);
        RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
        console.error(`[err] ${post.id}: Mastodon publish failed - ${err.message}`);
      }
      continue;
    }
    if (dueMs <= now + MIN_SCHEDULE_LEAD_MS) {
      console.log(`[skip] ${post.id}: due in <${Math.ceil(MIN_SCHEDULE_LEAD_MS / 60000)}m - inside the instance's minimum scheduling lead; it publishes AT due time instead.`);
      continue;
    }

    if (args['dry-run']) {
      console.log(`[dry] ${post.id}: would natively schedule a ${pollPost ? 'poll status' : (textPost ? 'text status' : 'media status')} for ${new Date(dueMs).toISOString()}.`);
      continue;
    }
    console.log(`[info] ${post.id}: natively scheduling for ${new Date(dueMs).toISOString()}...`);
    try {
      let mediaIds = [];
      if (carouselPost) mediaIds = await uploadAlbum(carouselPaths, post);
      else if (!textPost && !pollPost) mediaIds = [await uploadMedia(mediaPath, post)];
      // ':native' keys this apart from an immediate publish, so a later past-due
      // fallback is never swallowed by the idempotency cache of a failed schedule.
      const { data: resp } = await masto('POST', '/api/v1/statuses', {
        // Spec 25: same content-warning rule as the immediate publish above.
        // Spec 10: a native poll rides the scheduled create too (mastoPollBody).
        body: { status: text, ...(mediaIds.length ? { media_ids: mediaIds } : {}), visibility: 'public', scheduled_at: new Date(dueMs).toISOString(), ...(post.spoilerText ? { spoiler_text: post.spoilerText, sensitive: true } : {}), ...mastoPollBody(post) },
        headers: { 'Idempotency-Key': `${plan.campaign || 'plan'}:${post.id}:native` },
      });
      const schedId = resp?.id;
      if (!schedId) throw new Error(`scheduled status create returned no id: ${JSON.stringify(resp).slice(0, 200)}`);
      post.mastodonScheduledId = String(schedId);
      post.status = 'scheduled';
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'mastodon', action: 'schedule-native', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'schedule-native', ok: true, id: String(schedId) });
      console.log(`[ok] ${post.id}: natively scheduled (queue entry ${schedId}, fires ${resp.scheduled_at || new Date(dueMs).toISOString()}).`);
      scheduled += 1;
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'mastodon', action: 'schedule-native', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'schedule-native', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: Mastodon schedule failed - ${err.message}`);
    }
  }
  console.log(`[done] schedule complete - ${scheduled} natively scheduled, ${published} published (past due).`);
}

// Post-due reconcile (the analog of yt-social's release lane): the scheduled-
// status id DIES when the instance fires it and the live status gets a NEW id,
// so this records post.mastodonStatusId once the queue entry is gone - matched
// by text on the account timeline. A queue entry still parked well past due is
// cancelled and published immediately (the instance provably did not fire it).
async function cmdResolve(args) {
  const { abs, plan } = loadPlan(args.plan);
  const now = Date.now();

  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isMastodon(post)) continue;
    if (!post.mastodonScheduledId || post.mastodonStatusId) continue;
    if (post.status === 'posted') continue;
    const dueMs = Date.parse(post.scheduledAt);

    let queued = null;
    try {
      const { data } = await masto('GET', `/api/v1/scheduled_statuses/${encodeURIComponent(post.mastodonScheduledId)}`);
      queued = data;
    } catch (err) {
      if (!/HTTP 404/i.test(err.message || '')) {
        RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'resolve', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
        console.error(`[err] ${post.id}: scheduled-status lookup failed - ${err.message}`);
        continue;
      }
    }

    if (queued) {
      // Still parked. Before due (or briefly past it) that is the healthy state;
      // well past due the instance is not going to fire it - take it back.
      if (Number.isNaN(dueMs) || now <= dueMs + RESOLVE_REPUBLISH_GRACE_MS) {
        console.log(`[skip] ${post.id}: still queued on the instance (fires ${queued.scheduled_at || post.scheduledAt}).`);
        continue;
      }
      console.log(`[warn] ${post.id}: queue entry ${post.mastodonScheduledId} still parked ${Math.round((now - dueMs) / 60000)}m past due - cancelling and publishing now.`);
      try {
        await masto('DELETE', `/api/v1/scheduled_statuses/${encodeURIComponent(post.mastodonScheduledId)}`);
        const text = statusText(post);
        // E2: an album taken back from the queue must republish as an ALBUM. Resolving
        // only the single path here would have published a 4-slide post as a bare
        // caption, which is silent data loss rather than a visible failure.
        const albumPaths = isCarouselPost(post)
          ? carouselItems(post).map((it) => resolveMediaPath(plan, { file: it.file, path: it.path }))
          : [];
        if (isCarouselPost(post) && albumPaths.some((x) => !x)) {
          throw new Error('a slide is missing on disk - refusing to republish a partial album');
        }
        const mediaPath = (isTextPost(post) || isCarouselPost(post)) ? null : resolveMediaPath(plan, post);
        const resp = await publishNow(plan, post, { text, mediaPath, carouselPaths: albumPaths, now });
        appendAttempt(post, { ts: new Date().toISOString(), platform: 'mastodon', action: 'resolve-republish', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
        await savePlan(abs, plan, [post.id]);
        RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'resolve-republish', ok: true, id: post.mastodonStatusId, permalink: resp.url || null });
        console.log(`[ok] ${post.id}: republished as status ${post.mastodonStatusId}.`);
      } catch (err) {
        appendAttempt(post, { ts: new Date().toISOString(), platform: 'mastodon', action: 'resolve-republish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), actor: ACTOR });
        await savePlan(abs, plan, [post.id]);
        RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'resolve-republish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
        console.error(`[err] ${post.id}: republish failed - ${err.message}`);
      }
      continue;
    }

    // Queue entry gone = the instance fired it. Find the live status by text on
    // the account's own timeline (created around the due minute).
    try {
      const { data: me } = await masto('GET', '/api/v1/accounts/verify_credentials');
      const { data: statuses } = await masto('GET', `/api/v1/accounts/${encodeURIComponent(me.id)}/statuses?limit=40&exclude_replies=true&exclude_reblogs=true`);
      const want = matchKey(statusText(post));
      const hit = (Array.isArray(statuses) ? statuses : []).find((s) => {
        const createdMs = Date.parse(s.created_at || '');
        const nearDue = Number.isNaN(dueMs) || (Number.isFinite(createdMs) && createdMs >= dueMs - 30 * 60 * 1000);
        return nearDue && matchKey(s.content) === want;
      });
      if (hit) {
        post.mastodonStatusId = String(hit.id);
        post.status = 'posted';
        post.postedAt = hit.created_at || new Date(now).toISOString();
        appendAttempt(post, { ts: new Date().toISOString(), platform: 'mastodon', action: 'resolve', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
        await savePlan(abs, plan, [post.id]);
        RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'resolve', ok: true, id: String(hit.id), permalink: hit.url || null });
        console.log(`[ok] ${post.id}: fired natively - resolved to status ${hit.id}${hit.url ? ` (${hit.url})` : ''}.`);
      } else {
        // The queue entry is gone, so the instance DID publish it - the text just
        // no longer matches (edited platform-side / timeline paging). Mark posted
        // honestly rather than re-publishing a duplicate; the id stays unresolved.
        post.status = 'posted';
        post.postedAt = new Date(now).toISOString();
        appendAttempt(post, { ts: new Date().toISOString(), platform: 'mastodon', action: 'resolve', ok: true, errorCode: null, errorMessage: 'fired natively but the live status id could not be matched', actor: ACTOR });
        await savePlan(abs, plan, [post.id]);
        RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'resolve', ok: true, id: null, detail: 'fired natively; live status id unresolved (no timeline match)' });
        console.log(`[warn] ${post.id}: queue entry fired but no timeline match - marked posted without a status id.`);
      }
    } catch (err) {
      RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'resolve', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: resolve failed - ${err.message}`);
    }
  }
  console.log('[done] resolve complete.');
}

async function cmdUnschedule(args) {
  if (!args.id) { console.error('[err] unschedule requires --id <scheduledId>'); process.exit(2); }
  await masto('DELETE', `/api/v1/scheduled_statuses/${encodeURIComponent(args.id)}`);
  RUN.results.push({ platform: 'mastodon', action: 'unschedule', ok: true, id: String(args.id) });
  console.log(`[ok] cancelled Mastodon scheduled status ${args.id}.`);
}

async function cmdStatus(args) {
  const { plan } = loadPlan(args.plan);
  console.log('[info] Mastodon plan entries:');
  for (const post of (plan.posts || []).filter(isMastodon)) {
    console.log(`  ${post.id.padEnd(18)} ${String(post.status).padEnd(10)} ${post.scheduledAt}  mode=${post.executionMode}${post.mastodonStatusId ? ` masto=${post.mastodonStatusId}` : ''}${post.mastodonScheduledId ? ` sched=${post.mastodonScheduledId}` : ''}`);
  }
}

// Read-only liveness: GET the status back; its `url` is the public permalink.
// A natively-scheduled entry (queue id, no status id yet) reads the queue
// instead: 'scheduled' while parked, 'pending-resolve' once the instance fired
// it (neither live nor failed - the resolve lane closes that gap).
// Writes nothing - lib/verify.mjs owns post.verify.
async function cmdVerify(args) {
  const { plan } = loadPlan(args.plan);
  for (const post of (plan.posts || []).filter(isMastodon)) {
    if (args.only && post.id !== args.only) continue;
    if (!post.mastodonStatusId && post.mastodonScheduledId) {
      try {
        await masto('GET', `/api/v1/scheduled_statuses/${encodeURIComponent(post.mastodonScheduledId)}`);
        RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'verify', ok: true, live: false, state: 'scheduled', permalink: null, id: post.mastodonScheduledId });
      } catch (err) {
        const missing = /HTTP 404/i.test(err.message || '');
        RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'verify', ok: true, live: false, state: missing ? 'pending-resolve' : 'unknown', permalink: null, id: post.mastodonScheduledId, ...(missing ? {} : { errorMessage: String(err.message).slice(0, 200) }) });
      }
      continue;
    }
    if (!post.mastodonStatusId) continue;
    try {
      const { data } = await masto('GET', `/api/v1/statuses/${encodeURIComponent(post.mastodonStatusId)}`);
      RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'verify', ok: true, live: true, state: 'published', permalink: data.url || null, id: post.mastodonStatusId });
    } catch (err) {
      const missing = /HTTP 404|not found/i.test(err.message || '');
      RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'verify', ok: true, live: false, state: missing ? 'missing' : 'unknown', permalink: null, id: post.mastodonStatusId, errorMessage: String(err.message).slice(0, 200) });
    }
  }
}

// Real metrics (unlike telegram/discord): the status object carries its own counts.
async function cmdInsights(args) {
  const { plan } = loadPlan(args.plan);
  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isMastodon(post) || !post.mastodonStatusId) continue;
    try {
      const { data } = await masto('GET', `/api/v1/statuses/${encodeURIComponent(post.mastodonStatusId)}`);
      const metrics = {
        favourites: data.favourites_count ?? 0,
        reblogs: data.reblogs_count ?? 0,
        replies: data.replies_count ?? 0,
      };
      RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'insights', ok: true, id: post.mastodonStatusId, metrics });
      console.log(`[ok] ${post.id}: Mastodon ${JSON.stringify(metrics)}`);
    } catch (err) {
      RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'insights', ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 300) });
      console.log(`[warn] ${post.id}: Mastodon insights failed - ${err.message}`);
    }
  }
  console.log(`[done] insights complete - ${RUN.results.filter((r) => r.ok).length} fetched.`);
}

async function cmdDelete(args) {
  if (!args.id) { console.error('[err] delete requires --id <statusId>'); process.exit(2); }
  await masto('DELETE', `/api/v1/statuses/${encodeURIComponent(args.id)}`);
  RUN.results.push({ platform: 'mastodon', action: 'delete', ok: true, id: String(args.id) });
  console.log(`[ok] deleted Mastodon status ${args.id}.`);
}

async function cmdProbe() {
  if (!accessToken()) {
    RUN.results.push({ platform: 'mastodon', action: 'probe', ok: false, detail: 'not configured (MASTODON_ACCESS_TOKEN missing)' });
    return;
  }
  if (!instanceUrl()) {
    RUN.results.push({ platform: 'mastodon', action: 'probe', ok: false, detail: 'not configured (MASTODON_INSTANCE_URL missing)' });
    return;
  }
  try {
    const { data: me } = await masto('GET', '/api/v1/accounts/verify_credentials');
    RUN.results.push({ platform: 'mastodon', action: 'probe', ok: true, detail: `connected as @${me.acct}`, tokenExpiresAt: null });
  } catch (err) {
    RUN.results.push({ platform: 'mastodon', action: 'probe', ok: false, detail: String(err.message || err).slice(0, 200) });
  }
}

// ---------- social-graph verbs (spec 31 - pin/unpin + follow/unfollow) ----------
//
// Housekeeping account-level actions, not a scheduled publish: no approval fence,
// no lanesOwed/CLOUD_LANES involvement. pin/unpin resolve the status id from
// --id, else --plan/--only pointing at a post that already carries
// mastodonStatusId; follow/unfollow resolve --acct via accounts/search.

// Spec 31: resolve the pin/unpin target - an explicit --id wins, else the first
// --plan (optionally --only <postId>) Mastodon post that already published
// (carries mastodonStatusId). Returns { abs, plan, post, statusId } - `abs`/
// `plan`/`post` are null when there is nothing to persist mastodonPinned onto
// (a bare --id call, or no plan match).
function resolvePinTarget(args) {
  if (typeof args.id === 'string' && args.id.trim()) {
    return { abs: null, plan: null, post: null, statusId: args.id.trim() };
  }
  if (!args.plan) return { abs: null, plan: null, post: null, statusId: null };
  let abs;
  let plan;
  try { ({ abs, plan } = loadPlan(args.plan)); } catch { return { abs: null, plan: null, post: null, statusId: null }; }
  const post = (plan.posts || []).find((p) => (args.only ? p.id === args.only : true) && isMastodon(p) && p.mastodonStatusId);
  return { abs, plan, post, statusId: post ? post.mastodonStatusId : null };
}

// pin/unpin (spec 31): POST /api/v1/statuses/:id/pin | /unpin. IDEMPOTENT - the
// CURRENT pinned state is read back first (GET the status, which carries `pinned`
// for the authenticated account's own statuses) so a re-pin/re-unpin is reported
// honestly as alreadyPinned/alreadyUnpinned instead of a spurious second write.
async function pinUnpin(args, pin) {
  const action = pin ? 'pin' : 'unpin';
  const { abs, plan, post, statusId } = resolvePinTarget(args);
  const postId = post ? post.id : null;
  if (!statusId) {
    RUN.results.push({ postId, platform: 'mastodon', action, ok: false, error: 'invalid_input', errorMessage: 'no status id resolved (--id, or --plan [--only <id>] pointing at a published Mastodon post)' });
    return;
  }
  try {
    const { data } = await masto('GET', `/api/v1/statuses/${encodeURIComponent(statusId)}`);
    // `pinned` only rides the payload for the AUTHENTICATED account's OWN statuses -
    // a foreign status (someone else's, reached via an explicit --id) omits the field
    // entirely (review NIT-6). Strict-equality both ways: already-pinned is ONLY
    // `pinned === true`, already-unpinned is ONLY `pinned === false` - an absent/
    // unknown `pinned` never short-circuits either branch, so the write call always
    // fires and lets the API surface the real result (e.g. a 422 on a foreign status)
    // instead of a false success.
    const already = pin ? data.pinned === true : data.pinned === false;
    if (!already) await masto('POST', `/api/v1/statuses/${encodeURIComponent(statusId)}/${action}`);
    if (post) {
      post.mastodonPinned = pin;
      await savePlan(abs, plan, [post.id]);
    }
    RUN.results.push({ postId, platform: 'mastodon', action, ok: true, id: statusId, ...(already ? (pin ? { alreadyPinned: true } : { alreadyUnpinned: true }) : {}) });
    console.log(`[ok] ${action} ${statusId}${already ? ' (already there - no-op)' : ''}.`);
  } catch (err) {
    if (err.status === 403) {
      RUN.results.push({ postId, platform: 'mastodon', action, ok: false, error: 'needs_scope', scope: 'write:accounts' });
      console.error(`[err] ${action} needs the write:accounts scope - ${err.message}`);
      return;
    }
    RUN.results.push({ postId, platform: 'mastodon', action, ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 300) });
    console.error(`[err] ${action} failed - ${err.message}`);
  }
}
async function cmdPin(args) { return pinUnpin(args, true); }
async function cmdUnpin(args) { return pinUnpin(args, false); }

// Resolve an --acct ("user", "@user", "user@remote.tld" or "@user@remote.tld") to
// its Mastodon account id via accounts/search (resolve:true forces a webfinger
// lookup for a remote account this instance has not seen before). Matched by the
// hit's OWN acct, stripped of a leading '@' only (a remote acct legitimately
// keeps its @domain suffix - unlike normalizeAcct, which is for the wrong-account
// self-check and deliberately drops the domain).
async function resolveAccountId(acctRaw) {
  const want = String(acctRaw || '').trim().toLowerCase().replace(/^@/, '');
  if (!want) return null;
  const { data } = await masto('GET', `/api/v1/accounts/search?q=${encodeURIComponent(acctRaw.trim())}&resolve=true&limit=5`);
  const hit = Array.isArray(data) ? data.find((a) => String(a.acct || '').toLowerCase() === want) : null;
  return hit ? hit.id : null;
}

// follow/unfollow (spec 31): POST /api/v1/accounts/:id/follow | /unfollow. Both
// are idempotent by the platform's OWN semantics (re-following an already-
// followed account just returns the unchanged relationship, no error) - no
// read-before-write needed, unlike pin/unpin.
async function followUnfollow(args, follow) {
  const action = follow ? 'follow' : 'unfollow';
  const acctRaw = typeof args.acct === 'string' ? args.acct.trim() : '';
  if (!acctRaw) {
    RUN.results.push({ platform: 'mastodon', action, ok: false, error: 'invalid_input', errorMessage: '--acct is required' });
    return;
  }
  try {
    const accountId = await resolveAccountId(acctRaw);
    if (!accountId) {
      RUN.results.push({ platform: 'mastodon', action, ok: false, error: 'invalid_input', errorMessage: `could not resolve @${acctRaw}` });
      console.error(`[err] ${action}: could not resolve @${acctRaw}.`);
      return;
    }
    const { data } = await masto('POST', `/api/v1/accounts/${encodeURIComponent(accountId)}/${action}`);
    RUN.results.push({ platform: 'mastodon', action, ok: true, id: accountId, acct: acctRaw, following: data.following === true });
    console.log(`[ok] ${action} @${acctRaw} (${accountId}).`);
  } catch (err) {
    if (err.status === 403) {
      RUN.results.push({ platform: 'mastodon', action, ok: false, error: 'needs_scope', scope: 'write:follows' });
      console.error(`[err] ${action} needs the write:follows scope - ${err.message}`);
      return;
    }
    RUN.results.push({ platform: 'mastodon', action, ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 300) });
    console.error(`[err] ${action} failed - ${err.message}`);
  }
}
async function cmdFollow(args) { return followUnfollow(args, true); }
async function cmdUnfollow(args) { return followUnfollow(args, false); }

// ---------- profile editing (spec 28 - the shipped X `profile` pattern, cloned) ----------
//
// Mastodon's account/*-equivalent is PATCH /api/v1/accounts/update_credentials
// (write:accounts scope): a SINGLE multipart call carries display_name/note/
// avatar/header/fields_attributes[] together (unlike X's three separate v1.1
// endpoints), so `apply` below makes ONE masto() call and derives per-field
// result rows from its one outcome. --url has no dedicated update_credentials
// param - it rides fields_attributes[] as a custom profile field (the only real
// way Mastodon exposes a link on the profile). CRITICALLY, fields_attributes is a
// FULL-REPLACE, not a patch - Mastodon deletes every custom field not resubmitted,
// so --url MERGES onto the operator's existing fields (read via assertSelf's
// verify_credentials) rather than submitting fields_attributes[0] alone (spec 28
// review, BLOCKER-1: the earlier shape silently wiped every other custom field).

function tierFor(status) {
  return status === 403 ? 'blocked' : status === 401 ? 'auth_error' : status === 429 ? 'rate_limited' : 'error';
}

// Mastodon's verify_credentials.acct for the TOKEN'S OWN account is always the
// BARE local username (no @instance suffix - that suffix only ever appears on a
// REMOTE account as seen by this instance). A hand-set MASTODON_HANDLE may carry a
// leading '@' or a trailing '@instance' (copied straight from the UI), so strip
// both sides down to the bare local part before comparing - otherwise "@owner" or
// "owner@instance" false-refuses every edit (spec 28 review, MAJOR-4). Mirrors
// x-social.mjs's '@'-strip on both sides + lib/accounts.mjs's '@'-strip precedent.
function normalizeAcct(raw) {
  return String(raw || '').trim().toLowerCase().replace(/^@/, '').split('@')[0];
}

// The wrong-account guard: refuse to mutate unless the LIVE account matches the
// MASTODON_HANDLE this client's .env expects (mirrors x-social.mjs assertSelf).
// Throws on mismatch/unset handle/unreadable acct - never edits a sibling client's
// account. Returns the FULL verify_credentials payload (not just .acct) so cmdProfile
// can read me.source.fields for the custom-fields merge (spec 28 review, BLOCKER-1).
async function assertSelf() {
  const expectedRaw = (readEnv('MASTODON_HANDLE') || '').trim();
  if (!expectedRaw) throw new Error('MASTODON_HANDLE is not set in .env - refusing to edit a profile I cannot identify (run `auth` first, or set MASTODON_HANDLE to the expected @acct).');
  const { data: me } = await masto('GET', '/api/v1/accounts/verify_credentials');
  const actual = normalizeAcct(me.acct);
  if (!actual) throw new Error('could not read the authenticated acct from verify_credentials - aborting before any profile edit.');
  if (actual !== normalizeAcct(expectedRaw)) throw new Error(`refusing to edit profile: authenticated as @${me.acct} but .env expects @${expectedRaw} (MASTODON_HANDLE) - wrong account, aborted.`);
  return me;
}

async function cmdProfile(args) {
  if (!accessToken() || !instanceUrl()) {
    throw new Error('Mastodon profile editing needs MASTODON_INSTANCE_URL + MASTODON_ACCESS_TOKEN in .env (write:accounts scope).');
  }

  // --probe: the STEP 0 access-tier gate. Non-mutating: verify_credentials (read)
  // only - never calls update_credentials (unlike X, whose v1.1 endpoint has no
  // side-effect-free way to prove the write tier; Mastodon's OAuth scope is
  // provable from the token response alone via a 403 on the real PATCH, so probe
  // here reports READ success and lets `apply` surface a needs_scope 403 honestly).
  if (args.probe) {
    const expectedRaw = (readEnv('MASTODON_HANDLE') || '').trim() || null;
    try {
      const { data: me } = await masto('GET', '/api/v1/accounts/verify_credentials');
      const handleMatches = expectedRaw ? normalizeAcct(expectedRaw) === normalizeAcct(me.acct) : null;
      RUN.results.push({ platform: 'mastodon', action: 'profile-probe', ok: true, tier: 'permitted', handle: me.acct, expectedHandle: expectedRaw, handleMatches, detail: `authenticated as @${me.acct}${expectedRaw ? ` (expected @${expectedRaw}${handleMatches ? '' : ' - MISMATCH'})` : ''}` });
    } catch (err) {
      const tier = tierFor(err.status);
      RUN.results.push({ platform: 'mastodon', action: 'profile-probe', ok: false, tier, detail: String(err.message || err).slice(0, 300) });
    }
    return;
  }

  const name = typeof args.name === 'string' ? args.name : null;
  const bio = typeof args.bio === 'string' ? args.bio : null;
  const url = typeof args.url === 'string' ? args.url : null;
  const image = typeof args.image === 'string' ? args.image : null;
  const banner = typeof args.banner === 'string' ? args.banner : null;
  if (name == null && bio == null && url == null && !image && !banner) {
    throw new Error('nothing to update - pass at least one of --name --bio --url --image --banner (or --probe).');
  }
  if (name != null && (!name.trim() || name.length > PROFILE_MAX.name)) throw new Error(`--name must be 1..${PROFILE_MAX.name} chars (got ${name.length}).`);
  if (bio != null && bio.length > PROFILE_MAX.bio) throw new Error(`--bio is ${bio.length} chars - Mastodon caps the default note at ${PROFILE_MAX.bio}.`);
  for (const [flag, p] of [['--image', image], ['--banner', banner]]) {
    if (!p) continue;
    if (!fs.existsSync(p)) throw new Error(`${flag} file not found: ${p}`);
  }

  // Wrong-account guard (shared verify_credentials): never edit a sibling client's account.
  const me = await assertSelf();
  const acct = me.acct;

  if (args['dry-run']) {
    const changes = [];
    if (name != null) changes.push(`name="${name}"`);
    if (bio != null) changes.push(`bio(${bio.length})`);
    if (url != null) changes.push(`url="${url}"`);
    if (image) changes.push(`image=${path.basename(image)}`);
    if (banner) changes.push(`banner=${path.basename(banner)}`);
    console.error(`[dry] @${acct}: would update ${changes.join(', ')}.`);
    RUN.results.push({ platform: 'mastodon', action: 'profile-dry-run', ok: true, handle: acct, changes });
    return;
  }

  // ONE multipart PATCH carries every provided field (Mastodon's update_credentials
  // is atomic, unlike X's three separate v1.1 calls) - derive per-field result rows
  // from its single outcome so the Studio/tests get X's familiar row granularity.
  const form = new FormData();
  if (name != null) form.append('display_name', name);
  if (bio != null) form.append('note', bio);
  if (url != null) {
    // BLOCKER (spec 28 review): Mastodon treats a submitted fields_attributes as the
    // FULL replacement set - every custom field NOT resubmitted here is DELETED
    // (including the operator's OTHER links + their link-verification checkmarks,
    // unrecoverable). MERGE: reuse me.source.fields (the raw existing rows
    // verify_credentials already fetched in assertSelf) and update-or-append the URL
    // onto them, so a --url edit never wipes an unrelated field. Update-or-append,
    // matched by NAME only: reuse an existing field whose NAME reads as a
    // link/website label, else add a new row. Deliberately NOT matched by an
    // existing field's VALUE looking like a URL - an operator's other custom fields
    // (GitHub, LinkedIn, a portfolio link, ...) legitimately hold URLs too, and
    // "whichever field happens to hold a URL" would silently clobber the WRONG one.
    // When REPLACING, keep the existing field's own name rather than overwriting it
    // with a hardcoded English "Website" (a de-CH profile may have labelled it
    // "Webseite"/"Lien"/anything); a brand-new row gets the neutral, non-English-
    // specific label "URL" instead.
    const existingFields = (Array.isArray(me.source?.fields) ? me.source.fields : [])
      .map((f) => ({ name: String(f?.name || ''), value: String(f?.value || '') }));
    const linkNameIdx = existingFields.findIndex((f) => /^(website|webseite|url|link|lien|site|web)$/i.test(f.name.trim()));
    const mergedFields = [...existingFields];
    if (linkNameIdx >= 0) mergedFields[linkNameIdx] = { name: mergedFields[linkNameIdx].name, value: url };
    else mergedFields.push({ name: 'URL', value: url });
    mergedFields.forEach((f, i) => {
      form.append(`fields_attributes[${i}][name]`, f.name);
      form.append(`fields_attributes[${i}][value]`, f.value);
    });
  }
  if (image) form.append('avatar', new Blob([fs.readFileSync(image)]), path.basename(image));
  if (banner) form.append('header', new Blob([fs.readFileSync(banner)]), path.basename(banner));

  try {
    await masto('PATCH', '/api/v1/accounts/update_credentials', { form });
  } catch (err) {
    if (err.status === 403) {
      RUN.results.push({ platform: 'mastodon', action: 'profile-update', ok: false, error: 'needs_scope', scope: 'write:accounts', errorMessage: String(err.message || err).slice(0, 300) });
      console.error(`[err] profile update needs the write:accounts scope - ${err.message}`);
      return;
    }
    RUN.results.push({ platform: 'mastodon', action: 'profile-update', ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 300) });
    console.error(`[err] profile-update failed - ${err.message}`);
    return;
  }
  if (name != null || bio != null || url != null) {
    RUN.results.push({ platform: 'mastodon', action: 'profile-update', ok: true, handle: acct });
    console.error(`[ok] @${acct}: profile fields updated.`);
  }
  if (image) { RUN.results.push({ platform: 'mastodon', action: 'profile-image', ok: true, handle: acct }); console.error(`[ok] @${acct}: profile image updated.`); }
  if (banner) { RUN.results.push({ platform: 'mastodon', action: 'profile-header', ok: true, handle: acct }); console.error(`[ok] @${acct}: profile header updated.`); }
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

// The inbound-engagement seam (spec 02, Pattern P6): read + reply to inbound
// comments on this lane's own posts. Thin wrappers over the shared, source-agnostic
// REST in lib/comments.mjs (dynamic import so the publish hot path's module graph is
// untouched). The result is merged onto RUN so main() emits the normalized
// { items } / { id } envelope; a needs_scope degrade sets ok:false (P9).
async function cmdComments(args) {
  const { runLaneComments } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneComments('mastodon', args));
}
async function cmdReply(args) {
  const { runLaneReply } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneReply('mastodon', args));
}
async function cmdModerate(args) {
  const { runLaneModerate } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneModerate('mastodon', args));
}
async function cmdReact(args) {
  const { runLaneReact } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneReact('mastodon', args));
}

// The Radar (beta) SEARCH verb (spec 33, Pattern P3 read + P9). Runs a RadarQuery
// (--query <json>) against the instance's search: /api/v2/search?type=statuses for
// keywords AND /api/v1/timelines/tag/{tag} for query.hashtags. Maps statuses to UNSCORED
// Signal rows { source, externalId, url, author, text, community, ts } - the seam scores
// them. READ-ONLY; the sealed token via readEnv (never requireEnv). Full-text search is
// INSTANCE-DEPENDENT (needs the instance's search backend): a 401/403/422 on the v2
// search with no hashtag fallback degrades to { needs_scope, scope:'mastodon_fulltext' }
// (the panel hints "use hashtags"), never a crash. A 429 degrades to rate_limited. Mock
// mode NEVER reaches here (main() routes `radar` to the mock driver via MOCKABLE_COMMANDS).
async function cmdRadar(args) {
  const { radarOkRow, radarNeedsScopeRow, radarRateLimitedRow, radarErrorRow, radarHttp } = await import('../lib/radar.mjs');
  let query = {};
  try { query = args.query ? JSON.parse(String(args.query)) : {}; } catch { query = {}; }
  const base = instanceUrl();
  const token = accessToken();
  if (!base || !token) { RUN.results.push(radarNeedsScopeRow('mastodon', 'read:search')); return; }
  const headers = { Authorization: `Bearer ${token}` };
  const keywords = Array.isArray(query.keywords) ? query.keywords.filter((k) => typeof k === 'string' && k.trim()) : [];
  const hashtags = Array.isArray(query.hashtags) ? query.hashtags.map((h) => String(h).replace(/^#/, '').trim()).filter(Boolean) : [];
  const mapStatus = (s, community) => ({ source: 'mastodon', externalId: String(s.id || ''), url: s.url || s.uri || null, author: s.account?.acct || null, text: statusPlainText(s.content || ''), community: community || null, ts: s.created_at || null });
  const items = [];
  let fulltextUnavailable = false; // 422: the instance ships no full-text search backend
  let authFailed = false;          // 401/403: revoked/insufficient token -> reconnect, NOT a "use hashtags" hint
  let keywordError = null;         // transient/other keyword-search failure (5xx etc.)
  if (keywords.length) {
    const q = keywords.join(' ');
    const url = `${base}/api/v2/search?${new URLSearchParams({ type: 'statuses', resolve: 'false', limit: '20', q }).toString()}`;
    const r = await radarHttp(url, { headers });
    if (r.ok) { for (const s of (r.json?.statuses || [])) items.push(mapStatus(s, null)); }
    else if (r.status === 429) { RUN.results.push(radarRateLimitedRow('mastodon', r.retryAfter)); return; }
    else if (r.status === 401 || r.status === 403) { authFailed = true; }
    else if (r.status === 422) { fulltextUnavailable = true; }
    // Any other keyword-search error is transient: record it but STILL try the (public) hashtag timelines.
    else { keywordError = r.error || `HTTP ${r.status}`; }
  }
  for (const tag of hashtags) {
    const url = `${base}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=20`;
    const r = await radarHttp(url, { headers });
    if (r.ok) { for (const s of (Array.isArray(r.json) ? r.json : [])) items.push(mapStatus(s, `#${tag}`)); }
    // A rate-limit only aborts if we have nothing yet; otherwise keep the collected items.
    else if (r.status === 429 && !items.length) { RUN.results.push(radarRateLimitedRow('mastodon', r.retryAfter)); return; }
    // A single tag's error is otherwise non-fatal (skip it); other tags + keyword items still return.
  }
  if (items.length) { RUN.results.push(radarOkRow('mastodon', items)); return; }
  // Nothing matched — pick the HONEST degrade in priority order.
  if (authFailed) { RUN.results.push(radarNeedsScopeRow('mastodon', 'read:search')); return; }         // reconnect
  if (fulltextUnavailable) { RUN.results.push(radarNeedsScopeRow('mastodon', 'mastodon_fulltext')); return; } // use hashtags
  if (keywordError) { RUN.results.push(radarErrorRow('mastodon', keywordError)); return; }
  RUN.results.push(radarOkRow('mastodon', [])); // a genuine empty result (search worked, no hits)
}

// Spec 44 (READ-only): did the thread's original author reply back to our posted status?
// GET the status context and let the pure parser find a DIRECT descendant by the buyer
// author. NEVER writes; NEVER re-attempts a terminal post.
export async function cmdRadarFollowup(args) {
  const { abs, plan } = loadPlan(args.plan);
  const { parseMastodonFollowup, stampFollowup, needsFollowupCheck } = await import('../lib/radar.mjs');
  const nowIso = new Date().toISOString();
  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    const rr = post.radarReplyTo;
    if (!rr || rr.source !== 'mastodon' || !needsFollowupCheck(post) || !post.mastodonStatusId) continue;
    try {
      const { data } = await masto('GET', `/api/v1/statuses/${encodeURIComponent(post.mastodonStatusId)}/context`);
      const hit = parseMastodonFollowup(data, { author: rr.author, ourId: post.mastodonStatusId, sinceTs: Date.parse(post.postedAt) });
      stampFollowup(post, hit, nowIso);
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'radar-followup', ok: true, authorReplied: Boolean(hit) });
    } catch (err) {
      const gone = err && (err.status === 404 || err.status === 410);
      if (gone) { post.radarReplyState = 'target_gone'; }
      stampFollowup(post, null, nowIso);
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'mastodon', action: 'radar-followup', ok: false, errorCode: gone ? 'radar_target_gone' : (err && (err.status === 401 || err.status === 403) ? 'needs_scope' : 'engine_failure'), errorMessage: String(err && err.message || err).slice(0, 200) });
    }
  }
}

const COMMANDS = {
  auth: cmdAuth,
  connect: cmdAuth,
  comments: cmdComments,
  reply: cmdReply,
  moderate: cmdModerate,
  react: cmdReact,
  refresh: cmdRefresh,
  validate: cmdValidate,
  schedule: cmdSchedule,
  resolve: cmdResolve,
  'publish-due': cmdPublishDue,
  status: cmdStatus,
  verify: cmdVerify,
  insights: cmdInsights,
  delete: cmdDelete,
  unschedule: cmdUnschedule,
  probe: cmdProbe,
  profile: cmdProfile,
  // Social-graph housekeeping (spec 31): pin/unpin a status to the profile,
  // follow/unfollow an account.
  pin: cmdPin,
  unpin: cmdUnpin,
  follow: cmdFollow,
  unfollow: cmdUnfollow,
  radar: cmdRadar,
  'radar-followup': cmdRadarFollowup,
};

async function main() {
  const args = parseArgs(process.argv);
  JSON_MODE = Boolean(args.json);
  ACTOR = typeof args.actor === 'string' ? args.actor : 'cli';
  if (JSON_MODE) console.log = (...a) => console.error(...a);
  const commandName = args._[0];
  if (resolveMode('mastodon') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'mastodon', command: commandName,
      planPath: typeof args.plan === 'string' ? path.resolve(String(args.plan)) : null,
      only: typeof args.only === 'string' ? args.only : null,
      // spec 06: the moderate verb carries its action so the mock can branch per-lane.
      action: typeof args.action === 'string' ? args.action : null,
      // spec 24: the react verb carries its reaction/emoji/remove so the mock can branch per-lane.
      reaction: typeof args.reaction === 'string' ? args.reaction : null,
      emoji: typeof args.emoji === 'string' ? args.emoji : null,
      remove: args.remove === true,
      // spec 28 review: the profile verb's --probe flag, so mock mode can
      // distinguish a probe (read-only tier check) from an apply.
      probe: args.probe === true,
      // spec 31: pin/unpin's explicit status --id override + follow/unfollow's --acct.
      id: typeof args.id === 'string' ? args.id : null,
      acct: typeof args.acct === 'string' ? args.acct : null,
      // spec 33: the radar verb carries its --query (RadarQuery JSON).
      query: typeof args.query === 'string' ? args.query : null,
    });
    if (JSON_MODE) process.stdout.write(`${JSON.stringify(envelope)}\n`);
    else console.error(`[mock] mastodon ${commandName}: ${envelope.results.length} result(s)`);
    return;
  }
  const cmd = COMMANDS[commandName];
  if (!cmd) {
    console.error(`Usage: node scripts/mastodon-social.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
    process.exit(2);
  }
  if (['validate', 'schedule', 'resolve', 'publish-due', 'status', 'verify', 'insights'].includes(commandName) && !args.plan) {
    console.error(`[err] ${commandName} requires --plan <post-plan.json>`);
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

// Test-only export (spec 28): cmdProfile + RUN are exported so a profile-edit test
// can drive the real probe/wrong-account/apply logic in-process against a stubbed
// global.fetch, with no network/credentials/subprocess - mirrors telegram-social.mjs's
// cmdEdit export (test/edit-after-publish.test.mjs). Spec 31: cmdPin/cmdUnpin/
// cmdFollow/cmdUnfollow are exported the SAME way so test/social-graph.test.mjs
// drives the real GET-before-write pin/unpin idempotency + accounts/search follow
// resolution against a stubbed global.fetch, with no live credentials/subprocess.
export { cmdProfile, RUN, cmdPin, cmdUnpin, cmdFollow, cmdUnfollow };
