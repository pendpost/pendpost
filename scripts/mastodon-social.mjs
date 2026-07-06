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
 *                           (scopes: read write:statuses write:media).
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
import { envPath } from '../lib/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = envPath();

// Mastodon caps a status at 500 chars by default (per-instance configurable; we
// enforce the conservative default so a plan ports across instances).
const TEXT_LIMIT = 500;

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
    throw new Error(`Mastodon ${method} ${apiPath}: HTTP ${res.status} - ${data.error || data.raw || text || 'unknown'}`);
  }
  return { status: res.status, data };
}

// ---------- plan helpers (same shape as the sibling engines) ----------

function loadPlan(planPath) {
  const abs = path.resolve(planPath);
  return { abs, plan: JSON.parse(fs.readFileSync(abs, 'utf8')) };
}

const ENGINE_OWNED_FIELDS = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'xPostId', 'tgMessageId', 'dcMessageId', 'redditPostId', 'pinId', 'tiktokVideoId', 'mastodonStatusId', 'mastodonScheduledId', 'wordpressPostId', 'ghostPostId', 'nostrEventId', 'gbpPostId', 'status', 'postedAt', 'attempts'];

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

// Upload local media via v2/media. A 202 means the instance is still processing
// (video transcode): poll v1/media/:id until it settles at 200 with a url.
async function uploadMedia(mediaPath, post) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(mediaPath)]), path.basename(mediaPath));
  // Best-effort alt text: post.title is the only short human descriptor in the plan schema.
  const alt = (post.title || '').trim();
  if (alt) form.append('description', alt);
  const up = await masto('POST', '/api/v2/media', { form });
  const mediaId = up.data?.id;
  if (!mediaId) throw new Error(`media upload returned no id: ${JSON.stringify(up.data).slice(0, 200)}`);
  if (up.status === 202) {
    const deadline = Date.now() + MEDIA_POLL_CAP_MS;
    for (;;) {
      await new Promise((r) => setTimeout(r, MEDIA_POLL_MS));
      const poll = await masto('GET', `/api/v1/media/${encodeURIComponent(mediaId)}`);
      if (poll.status === 200 && poll.data?.url) break;
      if (Date.now() > deadline) throw new Error(`media ${mediaId} still processing after ${MEDIA_POLL_CAP_MS / 1000}s`);
    }
  }
  return String(mediaId);
}

// One immediate publish - shared by publish-due and schedule's past-due
// fallback: upload media when present, create the status, mint the fields.
// The caller saves the plan and records the attempt/envelope rows.
async function publishNow(plan, post, { text, mediaPath, now }) {
  let mediaId = null;
  if (mediaPath) mediaId = await uploadMedia(mediaPath, post);
  // Idempotency-Key: a retried tick after a lost response must not double-post.
  const { data: resp } = await masto('POST', '/api/v1/statuses', {
    body: { status: text, ...(mediaId ? { media_ids: [mediaId] } : {}), visibility: 'public' },
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
    console.log(`[preview] text (${text.length}/${TEXT_LIMIT}${text.length > TEXT_LIMIT ? ' - OVER LIMIT' : ''}):`);
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
    if (textPost && !text) { console.log(`[warn] ${post.id}: due but no text (mastodonCaption/caption) - skipping.`); continue; }
    if (text.length > TEXT_LIMIT) { console.log(`[warn] ${post.id}: text is ${text.length} chars (> ${TEXT_LIMIT}) - skipping.`); continue; }

    let mediaPath = null;
    if (!textPost) {
      mediaPath = resolveMediaPath(plan, post);
      if (!mediaPath) { console.log(`[warn] ${post.id}: due but local media not found (${post.path || post.file}) - skipping.`); continue; }
    }

    if (args['dry-run']) {
      console.log(textPost ? `[dry] ${post.id}: would post a text status (${text.length} chars).` : `[dry] ${post.id}: would upload ${path.basename(mediaPath)} + status.`);
      continue;
    }

    console.log(`[info] ${post.id}: publishing ${textPost ? 'text status' : 'media'} to Mastodon...`);
    try {
      const resp = await publishNow(plan, post, { text, mediaPath, now });
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

    const text = statusText(post);
    const textPost = isTextPost(post);
    if (textPost && !text) { console.log(`[warn] ${post.id}: no text (mastodonCaption/caption) - skipping.`); continue; }
    if (text.length > TEXT_LIMIT) { console.log(`[warn] ${post.id}: text is ${text.length} chars (> ${TEXT_LIMIT}) - skipping.`); continue; }
    let mediaPath = null;
    if (!textPost) {
      mediaPath = resolveMediaPath(plan, post);
      if (!mediaPath) { console.log(`[warn] ${post.id}: local media not found (${post.path || post.file}) - skipping.`); continue; }
    }

    if (dueMs <= now) {
      if (args['dry-run']) { console.log(`[dry] ${post.id}: past due - would publish immediately.`); continue; }
      console.log(`[info] ${post.id}: past due - publishing immediately (native window gone)...`);
      try {
        const resp = await publishNow(plan, post, { text, mediaPath, now });
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
      console.log(`[dry] ${post.id}: would natively schedule a ${textPost ? 'text status' : 'media status'} for ${new Date(dueMs).toISOString()}.`);
      continue;
    }
    console.log(`[info] ${post.id}: natively scheduling for ${new Date(dueMs).toISOString()}...`);
    try {
      let mediaId = null;
      if (!textPost) mediaId = await uploadMedia(mediaPath, post);
      // ':native' keys this apart from an immediate publish, so a later past-due
      // fallback is never swallowed by the idempotency cache of a failed schedule.
      const { data: resp } = await masto('POST', '/api/v1/statuses', {
        body: { status: text, ...(mediaId ? { media_ids: [mediaId] } : {}), visibility: 'public', scheduled_at: new Date(dueMs).toISOString() },
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
        const mediaPath = isTextPost(post) ? null : resolveMediaPath(plan, post);
        const resp = await publishNow(plan, post, { text, mediaPath, now });
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
  schedule: cmdSchedule,
  resolve: cmdResolve,
  'publish-due': cmdPublishDue,
  status: cmdStatus,
  verify: cmdVerify,
  insights: cmdInsights,
  delete: cmdDelete,
  unschedule: cmdUnschedule,
  probe: cmdProbe,
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

main().catch(async (err) => {
  console.error('[err]', err.message || err);
  if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: false, error: String(err.message || err).slice(0, 300), ...RUN })}\n`);
  process.exit(1);
});
