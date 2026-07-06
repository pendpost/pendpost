#!/usr/bin/env node
/**
 * ghost-social.mjs - direct Ghost blog + newsletter publishing via the Admin API.
 *
 * Sibling of scripts/telegram-social.mjs / x-social.mjs / linkedin-social.mjs:
 * the same zero-dep, plan-driven, publish-straight-from-the-local-render pattern,
 * but for pendpost's LONG-FORM lane - a Ghost entry is a full blog post (title +
 * markdown body rendered to HTML) with an optional newsletter email, not a caption.
 *
 * AUTH - a custom integration Admin API key, no browser OAuth:
 *   GHOST_SITE_URL       the Ghost site root (e.g. https://blog.example.com);
 *                        any trailing slash is stripped. API base is
 *                        <site>/ghost/api/admin.
 *   GHOST_ADMIN_API_KEY  `<id>:<hexsecret>` from Settings -> Integrations ->
 *                        Custom integrations -> Admin API key.
 * The key itself is NEVER sent over the wire. Each run mints a short-lived HS256
 * JWT locally from it (header kid = key id, aud '/admin/', 5-minute exp) and sends
 * `Authorization: Ghost <jwt>`. Every call pins `Accept-Version: v5.0`, so a Ghost
 * major bump degrades loudly instead of silently. `refresh` is a no-op: there is
 * no long-lived token to rotate - a fresh JWT is minted per request batch.
 *
 * PUBLISH IS TWO-STEP (draft -> published OR draft -> scheduled) ON PURPOSE.
 * Ghost hangs the newsletter email on the draft->published/scheduled transition,
 * and only when that transition carries `?newsletter=<slug>`. Creating the post
 * as `published` directly would forfeit the email forever (there is no "email it
 * later" API). VERIFIED against the v5 Admin API docs (docs.ghost.org, 2026-07-05):
 * "the `newsletter` query parameter must be passed when publishing OR SCHEDULING
 * the post", and a scheduled post's "email newsletters will be sent (if
 * applicable)" when Ghost's own scheduler fires at published_at - so native
 * scheduling does NOT forfeit the email. ghostEmail false/absent NEVER emails
 * anyone, and a missing active newsletter downgrades honestly to a web-only
 * publish with a warning.
 *
 * NATIVE SCHEDULING (owner decision 2026-07-05, reversing the earlier
 * publish-at-due-time choice): `schedule` runs the same two steps ahead of the
 * due time - create the draft, then flip it to status 'scheduled' + published_at
 * (carrying `?newsletter=` on THAT transition, per the verified semantics above) -
 * so Ghost's own scheduler publishes and emails with this machine off, the same
 * survives-power-off model as yt-social.mjs. The plan stays the source of truth
 * via a full reconcile story: the post KEEPS ITS ID across scheduled->published,
 * so it is findable, verifiable (GET /posts/<id>/ reads 'scheduled' vs
 * 'published'; past-due 'scheduled' reads 'scheduled-overdue') and cancellable
 * (`delete --id`; lib/writes.mjs nativeHandoff drives that on unschedule/
 * reschedule/edit). The scheduler's ghost-release lane flips a scheduled-overdue
 * post live (`release` - e.g. the site was down at the publish minute); the
 * newsletter attached at schedule time rides along on that transition.
 * Ghost refuses a published_at less than ~2 minutes out, so `schedule` keeps a
 * small lead (MIN_SCHEDULE_LEAD_MS); an entry inside the window publishes AT due
 * time via the past-due fallback, and `publish-due` stays for manual/late runs.
 *
 * LONG-FORM mapping (raw plan post fields):
 *   post.title         REQUIRED - Ghost posts need one; a due entry without it
 *                      warn-skips instead of publishing an untitled stub.
 *   post.body|caption  markdown -> HTML via lib/markdown.mjs (the deliberate
 *                      subset), sent through `?source=html` so Ghost converts it
 *                      to its native Lexical format server-side.
 *   post.excerpt       optional custom_excerpt (Ghost caps it at 300 chars -
 *                      longer text is truncated with a log line, never rejected).
 *   post.canonicalUrl  optional canonical_url (syndication-friendly).
 *   post.tags          comma-separated names -> [{ name }].
 *   post.image         an absolute URL used verbatim as feature_image; ELSE the
 *                      local render (post.path / plan.folder + post.file), when it
 *                      is an image (jpg/png/webp/gif), is uploaded to
 *                      /images/upload/ first and the returned URL is used.
 *   post.ghostEmail    true -> also email the post to the active newsletter's
 *                      subscribers on the publish transition (see above).
 *
 * Commands:
 *   auth | connect   validate the key against GET /site/; writes nothing
 *   refresh          no-op (the Admin API key is static; JWTs are minted per run)
 *   validate         --plan <p> [--only <id>]   side-effect-free preview, never posts
 *   schedule         --plan <p> [--only <id>] [--dry-run]   natively schedule (draft -> scheduled + published_at); publishes NOW when past due
 *   release          --plan <p> [--only <id>]   flip a scheduled-overdue post live (Ghost-scheduler backstop)
 *   publish-due      --plan <p> [--only <id>] [--dry-run]   publish any due Ghost entry (manual/late path)
 *   status           --plan <p>                 list Ghost plan entries
 *   verify           --plan <p> [--only <id>]   read-only liveness (GET /posts/<id>/; 'scheduled' reads scheduled/scheduled-overdue)
 *   insights         --plan <p> [--only <id>]   no-op (Admin API exposes no analytics)
 *   probe                                        read-only health probe (GET /site/)
 *   delete           --id <postId>               delete a Ghost post (cleanup; also cancels a scheduled one)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand } from '../lib/mode.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
import { envPath } from '../lib/util.mjs';
import { mdToHtml } from '../lib/markdown.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = envPath();

// Ghost caps custom_excerpt at 300 chars (validation error beyond that).
const EXCERPT_LIMIT = 300;

// Ghost refuses a published_at less than ~2 minutes in the future
// (cannotScheduleAPostBeforeInMinutes). 5 minutes keeps clear of that floor plus
// the draft-create round-trip; an entry already inside the window is NOT
// scheduled early - it publishes AT due time via the past-due fallback.
const MIN_SCHEDULE_LEAD_MS = 5 * 60 * 1000;

// ---------- env helpers (same shape as the sibling engines) ----------

function readEnvRaw() {
  return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
}
function readEnv(name) {
  const m = readEnvRaw().match(new RegExp(`^${name}=(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

const siteUrl = () => (readEnv('GHOST_SITE_URL') || '').trim().replace(/\/+$/, '');
const apiBase = () => `${siteUrl()}/ghost/api/admin`;

// ---------- Admin API auth + helper ----------

// Ghost Admin API auth: a short-lived HS256 JWT minted from the static key.
// kid = the key id (before the colon), secret = the hex half (after it).
function ghostJwt() {
  const key = readEnv('GHOST_ADMIN_API_KEY') || '';
  const [id, secret] = key.split(':');
  if (!id || !secret) throw new Error('GHOST_ADMIN_API_KEY must look like "<id>:<hexsecret>" (Settings -> Integrations -> Custom).');
  const now = Math.floor(Date.now() / 1000);
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64u({ alg: 'HS256', typ: 'JWT', kid: id });
  const body = b64u({ iat: now, exp: now + 300, aud: '/admin/' });
  const sig = crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

async function ghost(method, apiPath, { body, form } = {}) {
  const url = `${apiBase()}${apiPath}`;
  const headers = { Authorization: `Ghost ${ghostJwt()}`, 'Accept-Version': 'v5.0' };
  const init = { method, headers };
  if (form) init.body = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(url, init);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const detail = (Array.isArray(data.errors) && data.errors[0]?.message) || data.raw || text || 'unknown';
    const err = new Error(`Ghost ${method} ${apiPath}: HTTP ${res.status} - ${detail}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- plan helpers (same shape as the sibling engines) ----------

function loadPlan(planPath) {
  const abs = path.resolve(planPath);
  return { abs, plan: JSON.parse(fs.readFileSync(abs, 'utf8')) };
}

const ENGINE_OWNED_FIELDS = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'xPostId', 'tgMessageId', 'dcMessageId', 'redditPostId', 'pinId', 'tiktokVideoId', 'mastodonStatusId', 'wordpressPostId', 'ghostPostId', 'nostrEventId', 'gbpPostId', 'status', 'postedAt', 'attempts'];

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

const isGhost = (post) => (post.platforms || []).includes('ghost');
const postTitle = (post) => (post.title || '').trim();
const postHtml = (post) => mdToHtml(post.body || post.caption || '');

// Ghost's feature_image must be an image; the upload endpoint enforces mimetype.
function imageMime(localPath) {
  const ext = path.extname(localPath).toLowerCase();
  return { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || null;
}

// custom_excerpt is hard-capped at 300 chars by Ghost - truncate, never reject.
function excerptFor(post) {
  const raw = typeof post.excerpt === 'string' ? post.excerpt.trim() : '';
  if (!raw) return null;
  if (raw.length <= EXCERPT_LIMIT) return raw;
  console.log(`[info] ${post.id}: excerpt is ${raw.length} chars - truncating to Ghost's ${EXCERPT_LIMIT}.`);
  return raw.slice(0, EXCERPT_LIMIT);
}

function tagsFor(post) {
  const raw = Array.isArray(post.tags) ? post.tags.join(',') : String(post.tags || '');
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return names.length ? names.map((name) => ({ name })) : null;
}

async function uploadFeatureImage(localPath) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(localPath)], { type: imageMime(localPath) }), path.basename(localPath));
  const data = await ghost('POST', '/images/upload/', { form });
  const url = data.images?.[0]?.url;
  if (!url) throw new Error(`image upload returned no url: ${JSON.stringify(data).slice(0, 200)}`);
  return url;
}

// Shared draft assembly for publish-due and schedule: feature image (absolute
// URL wins, else the local image render uploads), excerpt/canonical/tags - the
// step-1 payload both paths create before their status transition.
async function buildDraftPayload(plan, post, { title, html }) {
  let featureImage = post.image || null;
  if (!featureImage) {
    const mediaPath = resolveMediaPath(plan, post);
    if (mediaPath && imageMime(mediaPath)) {
      featureImage = await uploadFeatureImage(mediaPath);
      console.log(`[ok] ${post.id}: uploaded ${path.basename(mediaPath)} -> ${featureImage}`);
    } else if (post.path || post.file) {
      console.log(`[info] ${post.id}: no usable local image (${post.path || post.file}) - publishing without a feature image.`);
    }
  }
  const payload = { title, html, status: 'draft' };
  const excerpt = excerptFor(post);
  if (excerpt) payload.custom_excerpt = excerpt;
  if (post.canonicalUrl) payload.canonical_url = post.canonicalUrl;
  const tags = tagsFor(post);
  if (tags) payload.tags = tags;
  if (featureImage) payload.feature_image = featureImage;
  return payload;
}

// The `?newsletter=<slug>` for a publish/schedule transition: the first ACTIVE
// newsletter when the entry opts in (ghostEmail === true), else null (web-only).
async function newsletterSlugFor(post) {
  if (post.ghostEmail !== true) return null;
  const newsletters = (await ghost('GET', '/newsletters/')).newsletters || [];
  const active = newsletters.find((n) => n.status === 'active');
  if (!active) console.log(`[warn] ${post.id}: ghostEmail requested but no ACTIVE newsletter exists - publishing WITHOUT email.`);
  return active ? active.slug : null;
}

// ---------- commands ----------

async function cmdAuth() {
  if (!readEnv('GHOST_SITE_URL')) { console.error('[err] GHOST_SITE_URL missing in .env (the Ghost site root, e.g. https://blog.example.com).'); process.exit(2); }
  if (!readEnv('GHOST_ADMIN_API_KEY')) { console.error('[err] GHOST_ADMIN_API_KEY missing in .env (Settings -> Integrations -> Custom integrations -> Admin API key).'); process.exit(2); }
  let site;
  try {
    site = (await ghost('GET', '/site/')).site || {};
  } catch (err) {
    console.error(`[err] Ghost auth failed - ${err.message}`);
    process.exit(2);
  }
  console.log(`[ok] connected to "${site.title}" (Ghost ${site.version}) at ${siteUrl()}`);
  RUN.results.push({ platform: 'ghost', action: 'auth', ok: true, detail: `"${site.title}" (Ghost ${site.version})` });
}

async function cmdRefresh() {
  console.log('[info] Ghost Admin API keys are static - a fresh JWT is minted per run (no refresh).');
}

async function cmdValidate(args) {
  const { plan } = loadPlan(args.plan);
  console.log('================ VALIDATION ONLY - NOTHING WILL BE PUBLISHED ================');
  try {
    const site = (await ghost('GET', '/site/')).site || {};
    console.log(`[ok] Site reachable - "${site.title}" (Ghost ${site.version}).`);
  } catch (err) {
    console.log(`[warn] GET /site/ failed (${err.message}). Continuing to content preview.`);
  }
  const targets = (plan.posts || []).filter((p) => isGhost(p) && (!args.only || p.id === args.only));
  if (!targets.length) { console.log('[warn] No Ghost entries match.'); return; }
  for (const post of targets) {
    console.log(`\n----- ${post.id} -----`);
    const title = postTitle(post);
    if (!title) console.log('[warn] title missing - REQUIRED for Ghost, this entry will be skipped at publish.');
    else console.log(`[preview] title:   ${title}`);
    const html = postHtml(post);
    if (!html) console.log('[warn] body/caption empty - nothing to render, this entry will be skipped at publish.');
    else console.log(`[preview] html:    ${html.length} chars (markdown from ${post.body ? 'body' : 'caption'})`);
    if (typeof post.excerpt === 'string' && post.excerpt.trim()) {
      const len = post.excerpt.trim().length;
      console.log(`[preview] excerpt: ${len}/${EXCERPT_LIMIT} chars${len > EXCERPT_LIMIT ? ` - will be TRUNCATED to ${EXCERPT_LIMIT}` : ''}`);
    }
    if (post.canonicalUrl) console.log(`[preview] canonical: ${post.canonicalUrl}`);
    const tags = tagsFor(post);
    if (tags) console.log(`[preview] tags:    ${tags.map((t) => t.name).join(', ')}`);
    if (post.image) {
      console.log(`[preview] image:   ${post.image} (used verbatim as feature_image)`);
    } else {
      const mediaPath = resolveMediaPath(plan, post);
      if (mediaPath && imageMime(mediaPath)) console.log(`[preview] image:   ${path.basename(mediaPath)} (${(fs.statSync(mediaPath).size / 1e6).toFixed(1)} MB) - will upload as feature_image`);
      else if (mediaPath) console.log(`[info] local media ${path.basename(mediaPath)} is not an image - feature_image will be omitted.`);
      else if (post.path || post.file) console.log(`[warn] media not found (${post.path || post.file}) - feature_image will be omitted.`);
    }
    console.log(`[preview] email:   ${post.ghostEmail === true ? 'newsletter email WILL be sent on publish' : 'web-only (no newsletter email)'}`);
  }
  console.log('\n================ VALIDATION COMPLETE ================');
}

async function cmdPublishDue(args) {
  const { abs, plan } = loadPlan(args.plan);
  if (!siteUrl()) throw new Error('GHOST_SITE_URL is not set - cannot publish.');
  if (!readEnv('GHOST_ADMIN_API_KEY')) throw new Error('GHOST_ADMIN_API_KEY is not set - cannot publish.');
  const now = Date.now();
  let published = 0;

  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isGhost(post)) continue;
    if (post.executionMode !== 'fully-scheduled') continue;
    if (post.status !== 'planned') continue;
    if ((post.approval || 'draft') !== 'approved') {
      console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish.`);
      continue;
    }
    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs) || dueMs > now) continue;

    const title = postTitle(post);
    if (!title) { console.log(`[warn] ${post.id}: due but no title - Ghost requires one - skipping.`); continue; }
    const html = postHtml(post);
    if (!html) { console.log(`[warn] ${post.id}: due but no body/caption to render - skipping.`); continue; }
    const wantsEmail = post.ghostEmail === true;

    if (args['dry-run']) {
      console.log(`[dry] ${post.id}: would create draft "${title}" (${html.length} chars html) then publish${wantsEmail ? ' + newsletter email' : ' (web-only)'}.`);
      continue;
    }

    console.log(`[info] ${post.id}: publishing "${title}" to Ghost...`);
    try {
      // Step 1: create the DRAFT. Publishing directly would skip the
      // draft->published transition Ghost hangs the newsletter email on.
      const payload = await buildDraftPayload(plan, post, { title, html });
      const draft = (await ghost('POST', '/posts/?source=html', { body: { posts: [payload] } })).posts?.[0];
      if (!draft?.id) throw new Error('draft create returned no post id');

      // Step 2: flip draft -> published; ?newsletter=<slug> on THIS transition is
      // what makes Ghost email subscribers. No active newsletter -> web-only.
      const newsletterSlug = wantsEmail ? await newsletterSlugFor(post) : null;
      const publishPath = `/posts/${draft.id}/?source=html${newsletterSlug ? `&newsletter=${encodeURIComponent(newsletterSlug)}` : ''}`;
      const liv = (await ghost('PUT', publishPath, { body: { posts: [{ status: 'published', updated_at: draft.updated_at }] } })).posts?.[0];

      post.ghostPostId = String(draft.id);
      post.status = 'posted';
      post.postedAt = new Date(now).toISOString();
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'ghost', action: 'publish', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'ghost', action: 'publish', ok: true, id: String(draft.id) });
      console.log(`[ok] ${post.id}: published on Ghost - ${liv?.url || '(no url returned)'}${newsletterSlug ? ` (newsletter "${newsletterSlug}" emailed)` : ' (web-only, no email)'}`);
      published += 1;
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'ghost', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'ghost', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: Ghost publish failed - ${err.message}`);
      continue;
    }
  }
  console.log(`[done] publish-due complete - ${published} post(s) published.`);
}

// Native scheduling: the same two steps as publish-due, run AHEAD of the due
// time - create the draft, then flip it draft->SCHEDULED with published_at,
// carrying `?newsletter=` on that transition (verified v5 semantics: the email
// sends when Ghost's own scheduler publishes at published_at). The post id is
// minted at schedule time and survives scheduled->published, so verify/release/
// delete all address the same object. A past-due entry publishes immediately
// instead; an entry inside Ghost's ~2-minute minimum lead waits for that fallback.
async function cmdSchedule(args) {
  const { abs, plan } = loadPlan(args.plan);
  if (!siteUrl()) throw new Error('GHOST_SITE_URL is not set - cannot schedule.');
  if (!readEnv('GHOST_ADMIN_API_KEY')) throw new Error('GHOST_ADMIN_API_KEY is not set - cannot schedule.');
  const now = Date.now();
  let scheduled = 0;
  let published = 0;

  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isGhost(post)) continue;
    if (post.executionMode !== 'fully-scheduled') continue;
    if (post.status !== 'planned') continue;
    if ((post.approval || 'draft') !== 'approved') {
      console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish.`);
      continue;
    }
    if (post.ghostPostId) { console.log(`[skip] ${post.id}: already has ghostPostId ${post.ghostPostId}.`); continue; }
    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs)) { console.log(`[warn] ${post.id}: unparseable scheduledAt "${post.scheduledAt}" - skipping.`); continue; }

    const title = postTitle(post);
    if (!title) { console.log(`[warn] ${post.id}: no title - Ghost requires one - skipping.`); continue; }
    const html = postHtml(post);
    if (!html) { console.log(`[warn] ${post.id}: no body/caption to render - skipping.`); continue; }
    const wantsEmail = post.ghostEmail === true;
    const pastDue = dueMs <= now;

    if (!pastDue && dueMs <= now + MIN_SCHEDULE_LEAD_MS) {
      console.log(`[skip] ${post.id}: due in <${Math.ceil(MIN_SCHEDULE_LEAD_MS / 60000)}m - inside Ghost's minimum scheduling lead; it publishes AT due time instead.`);
      continue;
    }
    if (args['dry-run']) {
      console.log(pastDue
        ? `[dry] ${post.id}: past due - would create draft "${title}" then publish immediately${wantsEmail ? ' + newsletter email' : ' (web-only)'}.`
        : `[dry] ${post.id}: would create draft "${title}" then natively schedule it for ${new Date(dueMs).toISOString()}${wantsEmail ? ' + newsletter email at publish' : ' (web-only)'}.`);
      continue;
    }

    console.log(pastDue
      ? `[info] ${post.id}: past due - publishing "${title}" to Ghost immediately...`
      : `[info] ${post.id}: natively scheduling "${title}" on Ghost for ${new Date(dueMs).toISOString()}...`);
    try {
      // Step 1: the DRAFT (the transition Ghost hangs the email on needs one).
      const payload = await buildDraftPayload(plan, post, { title, html });
      const draft = (await ghost('POST', '/posts/?source=html', { body: { posts: [payload] } })).posts?.[0];
      if (!draft?.id) throw new Error('draft create returned no post id');

      // Step 2: draft -> published (past due) or draft -> scheduled + published_at.
      // ?newsletter= on THIS transition binds the email either way.
      const newsletterSlug = wantsEmail ? await newsletterSlugFor(post) : null;
      const targetStatus = pastDue ? 'published' : 'scheduled';
      const body = { status: targetStatus, updated_at: draft.updated_at };
      if (!pastDue) body.published_at = new Date(dueMs).toISOString();
      const flipPath = `/posts/${draft.id}/?source=html${newsletterSlug ? `&newsletter=${encodeURIComponent(newsletterSlug)}` : ''}`;
      const liv = (await ghost('PUT', flipPath, { body: { posts: [body] } })).posts?.[0];

      post.ghostPostId = String(draft.id);
      if (pastDue) {
        post.status = 'posted';
        post.postedAt = new Date(now).toISOString();
        appendAttempt(post, { ts: new Date().toISOString(), platform: 'ghost', action: 'publish', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
        await savePlan(abs, plan, [post.id]);
        RUN.results.push({ postId: post.id, platform: 'ghost', action: 'publish', ok: true, id: String(draft.id) });
        console.log(`[ok] ${post.id}: published on Ghost - ${liv?.url || '(no url returned)'}${newsletterSlug ? ` (newsletter "${newsletterSlug}" emailed)` : ' (web-only, no email)'}`);
        published += 1;
      } else {
        post.status = 'scheduled';
        appendAttempt(post, { ts: new Date().toISOString(), platform: 'ghost', action: 'schedule-native', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
        await savePlan(abs, plan, [post.id]);
        RUN.results.push({ postId: post.id, platform: 'ghost', action: 'schedule-native', ok: true, id: String(draft.id) });
        console.log(`[ok] ${post.id}: natively scheduled (post ${draft.id}, publishes ${liv?.published_at || new Date(dueMs).toISOString()}${newsletterSlug ? `, newsletter "${newsletterSlug}" emails at publish` : ', web-only'}).`);
        scheduled += 1;
      }
    } catch (err) {
      const action = pastDue ? 'publish' : 'schedule-native';
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'ghost', action, ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'ghost', action, ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: Ghost ${pastDue ? 'publish' : 'schedule'} failed - ${err.message}`);
    }
  }
  console.log(`[done] schedule complete - ${scheduled} natively scheduled, ${published} published (past due).`);
}

// Recover a natively-scheduled post Ghost left 'scheduled' past its published_at
// (verify read-back 'scheduled-overdue' - e.g. the site was down/restarting at
// the publish minute): flip it live with a one-field status update - NEVER a
// re-create. The newsletter attached at schedule time rides along on this
// scheduled->published transition. Idempotent and safe on a bare CLI run: an
// already-published post is a no-op, a still-future schedule is left untouched.
async function cmdRelease(args) {
  const { abs, plan } = loadPlan(args.plan);
  const now = Date.now();
  for (const post of (plan.posts || []).filter(isGhost)) {
    if (args.only && post.id !== args.only) continue;
    if (!post.ghostPostId) continue;
    try {
      const gp = (await ghost('GET', `/posts/${post.ghostPostId}/`)).posts?.[0];
      if (!gp) throw new Error(`post ${post.ghostPostId} lookup returned no post`);
      if (gp.status === 'published') {
        RUN.results.push({ postId: post.id, platform: 'ghost', action: 'release', ok: true, id: post.ghostPostId, live: true, state: 'published', permalink: gp.url || null });
        console.log(`[ok] ${post.id}: already published - no action.`);
        continue;
      }
      if (gp.status !== 'scheduled') {
        RUN.results.push({ postId: post.id, platform: 'ghost', action: 'release', ok: false, errorCode: 'invalid_input', errorMessage: `post ${post.ghostPostId} is '${gp.status}' - release only flips a 'scheduled' post` });
        console.log(`[skip] ${post.id}: post is '${gp.status}' - nothing to release.`);
        continue;
      }
      const fireMs = Date.parse(gp.published_at || '');
      if (Number.isFinite(fireMs) && fireMs > now) {
        RUN.results.push({ postId: post.id, platform: 'ghost', action: 'release', ok: false, errorCode: 'invalid_input', errorMessage: `still natively scheduled for ${gp.published_at} - not releasing early` });
        console.log(`[skip] ${post.id}: still scheduled (${gp.published_at}) - not releasing early.`);
        continue;
      }
      const liv = (await ghost('PUT', `/posts/${post.ghostPostId}/`, { body: { posts: [{ status: 'published', updated_at: gp.updated_at }] } })).posts?.[0];
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'ghost', action: 'release', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'ghost', action: 'release', ok: true, id: post.ghostPostId, live: true, state: 'published', permalink: liv?.url || null });
      console.log(`[ok] ${post.id}: released - post ${post.ghostPostId} is now published.`);
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'ghost', action: 'release', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'ghost', action: 'release', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: release failed - ${err.message}`);
    }
  }
  console.log('[done] release complete.');
}

async function cmdStatus(args) {
  const { plan } = loadPlan(args.plan);
  console.log('[info] Ghost plan entries:');
  for (const post of (plan.posts || []).filter(isGhost)) {
    console.log(`  ${post.id.padEnd(18)} ${String(post.status).padEnd(10)} ${post.scheduledAt}  mode=${post.executionMode}${post.ghostPostId ? ` ghost=${post.ghostPostId}` : ''}`);
  }
}

// Real read-back: the Admin API can GET a post by id, so liveness is honest -
// 'published' is live, a surviving draft is not, a 404 means it was deleted. A
// natively-scheduled post reads 'scheduled' while its published_at is ahead and
// 'scheduled-overdue' once Ghost's scheduler has missed it (which owes the
// scheduler's ghost-release lane, mirroring yt's private-overdue).
async function cmdVerify(args) {
  const { plan } = loadPlan(args.plan);
  const now = Date.now();
  for (const post of (plan.posts || []).filter(isGhost)) {
    if (args.only && post.id !== args.only) continue;
    if (!post.ghostPostId) continue;
    try {
      const gp = (await ghost('GET', `/posts/${post.ghostPostId}/`)).posts?.[0] || {};
      const live = gp.status === 'published';
      let state = live ? 'published' : (gp.status || 'unknown');
      if (gp.status === 'scheduled') {
        const fireMs = Date.parse(gp.published_at || '');
        state = Number.isFinite(fireMs) && fireMs <= now ? 'scheduled-overdue' : 'scheduled';
      }
      RUN.results.push({ postId: post.id, platform: 'ghost', action: 'verify', ok: true, live, state, permalink: live ? (gp.url || null) : null, id: post.ghostPostId });
    } catch (err) {
      if (err.status === 404) {
        RUN.results.push({ postId: post.id, platform: 'ghost', action: 'verify', ok: true, live: false, state: 'missing', permalink: null, id: post.ghostPostId });
      } else {
        RUN.results.push({ postId: post.id, platform: 'ghost', action: 'verify', ok: false, live: null, state: 'unknown', errorMessage: String(err.message || err).slice(0, 200), id: post.ghostPostId });
      }
    }
  }
}

// The Admin API exposes no per-post analytics (email opens etc. live in Ghost's
// own dashboard, members analytics is a different surface) - honest no-op.
async function cmdInsights(args) {
  const { plan } = loadPlan(args.plan);
  void plan;
  console.log('[info] Ghost Admin API exposes no per-post analytics here - insights is a no-op.');
}

async function cmdDelete(args) {
  if (!args.id) { console.error('[err] delete requires --id <postId>'); process.exit(2); }
  await ghost('DELETE', `/posts/${args.id}/`);
  RUN.results.push({ platform: 'ghost', action: 'delete', ok: true, id: String(args.id) });
  console.log(`[ok] deleted Ghost post ${args.id}.`);
}

async function cmdProbe() {
  if (!readEnv('GHOST_ADMIN_API_KEY')) {
    RUN.results.push({ platform: 'ghost', action: 'probe', ok: false, detail: 'not configured (GHOST_ADMIN_API_KEY missing)' });
    return;
  }
  if (!siteUrl()) {
    RUN.results.push({ platform: 'ghost', action: 'probe', ok: false, detail: 'not configured (GHOST_SITE_URL missing)' });
    return;
  }
  try {
    const site = (await ghost('GET', '/site/')).site || {};
    RUN.results.push({ platform: 'ghost', action: 'probe', ok: true, detail: `connected to "${site.title}"`, tokenExpiresAt: null });
  } catch (err) {
    RUN.results.push({ platform: 'ghost', action: 'probe', ok: false, detail: String(err.message || err).slice(0, 200) });
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
  release: cmdRelease,
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
  if (resolveMode('ghost') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'ghost', command: commandName,
      planPath: typeof args.plan === 'string' ? path.resolve(String(args.plan)) : null,
      only: typeof args.only === 'string' ? args.only : null,
    });
    if (JSON_MODE) process.stdout.write(`${JSON.stringify(envelope)}\n`);
    else console.error(`[mock] ghost ${commandName}: ${envelope.results.length} result(s)`);
    return;
  }
  const cmd = COMMANDS[commandName];
  if (!cmd) {
    console.error(`Usage: node scripts/ghost-social.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
    process.exit(2);
  }
  if (['validate', 'schedule', 'release', 'publish-due', 'status', 'verify', 'insights'].includes(commandName) && !args.plan) {
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
