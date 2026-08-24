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
 *   post.newsletter    optional newsletter SLUG (else the first ACTIVE
 *                      newsletter, today's behaviour) - resolved against
 *                      GET /newsletters/ and REQUIRED to be active, else the
 *                      publish fails CLOSED (never silently email the wrong
 *                      list - spec 01 scenario 5).
 *   post.emailSegment  optional audience narrowing on the chosen newsletter:
 *                      'all'|'free'|'paid' (NQL presets) or a raw NQL filter
 *                      (e.g. 'label:vip'); blank/'all' omits &email_segment=
 *                      (Ghost's own default = every subscriber).
 *   post.emailOnly     true -> the post is SENT, not web-published (Ghost's
 *                      `email_only` post field); Ghost resolves status to
 *                      'sent' instead of 'published'.
 *   post.metaTitle         optional native Ghost meta_title (SEO/social title).
 *   post.metaDescription   optional native Ghost meta_description.
 *   post.featureImageAlt   optional native Ghost feature_image_alt - distinct
 *                          from the WordPress/X/Pinterest altText field (spec
 *                          21); Ghost has no such generic image-alt concept, but
 *                          DOES have this one native post-level field. All three
 *                          are native Ghost post fields - no attachment round-
 *                          trip, unlike WordPress's follow-up media update.
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
 *   insights         --plan <p> [--only <id>]   email opens/sends + link clicks (?include=email,count.clicks - spec 08)
 *   probe                                        read-only health probe (GET /site/)
 *   delete           --id <postId>               delete a Ghost post (cleanup; also cancels a scheduled one)
 *
 * ACCOUNT-SCOPED VERBS (spec 30, members + newsletters - Pattern P3, no --plan):
 * the audience behind spec 01's newsletter email. Reuse the SAME ghost() JWT
 * helper + Accept-Version pinning + errors[0].message mapping as every command
 * above; never persisted (stateless reads/writes, like `probe`).
 *   members          [--limit --page --filter]                    read the member list + free/paid/comped counts
 *   member-create    --email [--name --note --labels --newsletters --subscribed]   add one member
 *   members-import   --file <csv> | --rows <json> [--upload]       bulk-add members, resilient (skips duplicates); --rows/--file (no --upload) capped at 500 rows, use --upload for a larger CSV
 *   newsletters      (none)                                        read the newsletter roster
 *   newsletter-create --name [--description --subscribe-on-signup] create a newsletter
 *   newsletter-update --id --status active|archived [--name --description]  archive/activate/edit a newsletter
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand } from '../lib/mode.mjs';
import { enforceCeremonyClient } from '../lib/cli-client.mjs';
import { recordAttempt } from '../lib/publish-hold.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
import { envPath, parseCsvRows } from '../lib/util.mjs';
import { mdToHtml } from '../lib/markdown.mjs';
import { resolveCredential } from '../lib/cli-prompt.mjs';

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

const ENGINE_OWNED_FIELDS = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'xPostId', 'tgMessageId', 'dcMessageId', 'redditPostId', 'pinId', 'tiktokVideoId', 'mastodonStatusId', 'wordpressPostId', 'ghostPostId', 'nostrEventId', 'gbpPostId', 'status', 'postedAt', 'attempts', 'publishHold', 'publishRetry'];

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
  // Shared recorder (lib/publish-hold.mjs): trims the attempts tail and maintains
  // the publishHold failure cap - the local mirror of the cloud re-fire cap.
  recordAttempt(post, entry);
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
  // Spec 13: SEO metadata - all three are NATIVE Ghost post fields, set directly
  // on the create body (no attachment round-trip, unlike WordPress's follow-up
  // media update - see the file header).
  if (post.metaTitle) payload.meta_title = post.metaTitle;
  if (post.metaDescription) payload.meta_description = post.metaDescription;
  if (post.featureImageAlt) payload.feature_image_alt = post.featureImageAlt;
  // Spec 01: email-only send - Ghost SENDS the post (member email) but does NOT
  // web-publish it; the post's own status resolves to 'sent', never 'published'.
  // GATED on ghostEmail: email_only WITHOUT a newsletter send would transition to
  // 'sent' with no email AND no web version, silently vanishing the content while
  // pendpost marks it posted. email-only presupposes an email is being sent.
  // Spec 43: a draft HANDOFF never sends (there is no publish transition), so the
  // handed-off draft must not carry email_only either - the operator decides the
  // email question inside Ghost when THEY publish it. platform_validate blocks the
  // ghostEmail+publishAsDraft combination up front; this is the engine-side seatbelt
  // for approved posts that never saw Pruefen (it is advisory, not a publish gate).
  if (post.ghostEmail === true && post.emailOnly === true && post.publishAsDraft !== true) payload.email_only = true;
  return payload;
}

// Segment preset -> Ghost NQL filter (post.emailSegment). Blank/'all' means "no
// restriction" - Ghost's own default, every subscriber of the chosen newsletter;
// 'free'/'paid' are the two presets the Composer's <select> offers; anything
// else (e.g. a raw 'label:vip') is validated only as a plain string
// (lib/writes.mjs) and passed straight through as an advanced NQL filter.
const EMAIL_SEGMENT_MAP = { all: '', free: 'status:free', paid: 'status:-free' };
function emailSegmentFor(post) {
  const raw = typeof post.emailSegment === 'string' ? post.emailSegment.trim() : '';
  if (!raw) return null;
  const mapped = Object.prototype.hasOwnProperty.call(EMAIL_SEGMENT_MAP, raw) ? EMAIL_SEGMENT_MAP[raw] : raw;
  return mapped || null; // 'all' maps to '' -> treated as "no segment" (omitted)
}

// The `?newsletter=<slug>&email_segment=<nql>` for a publish/schedule
// transition. `post.newsletter` requests an explicit newsletter slug - resolved
// against an ACTIVE newsletter and FAIL-CLOSED (throws, errorCode invalid_input)
// when it names none (never silently email the wrong list, spec 01 scenario 5);
// blank falls back to today's first-ACTIVE-newsletter behaviour (scenario 4).
// The segment only applies once a newsletter is actually chosen.
// Spec 30: the ONE fetch of GET /newsletters/, shared by newsletterParamsFor
// (resolving the publish-time slug/segment, below) and the new `newsletters`
// read verb (cmdNewsletters) - factored out here so the two never duplicate the
// request. Returns the raw Ghost newsletter objects (id/slug/name/status/...).
async function fetchNewsletters() {
  return (await ghost('GET', '/newsletters/')).newsletters || [];
}

async function newsletterParamsFor(post) {
  if (post.ghostEmail !== true) return { slug: null, segment: null };
  const newsletters = await fetchNewsletters();
  const requested = typeof post.newsletter === 'string' ? post.newsletter.trim() : '';
  let active;
  if (requested) {
    active = newsletters.find((n) => n.slug === requested && n.status === 'active');
    if (!active) {
      const err = new Error(`no active newsletter "${requested}"`);
      err.code = 'invalid_input';
      throw err;
    }
  } else {
    active = newsletters.find((n) => n.status === 'active');
    if (!active) console.log(`[warn] ${post.id}: ghostEmail requested but no ACTIVE newsletter exists - publishing WITHOUT email.`);
  }
  return { slug: active ? active.slug : null, segment: active ? emailSegmentFor(post) : null };
}

// ---------- commands ----------

async function cmdAuth() {
  // .env still wins; otherwise, on an interactive terminal, prompt the operator to paste
  // what they copied (the Admin API key hidden, never echoed, never in shell history) and
  // persist it so the /site/ probe below (and every later run) can read it. A
  // non-interactive run (daemon/CI/mock) skips the prompt and fails closed at the guards.
  const siteRoot = await resolveCredential({
    value: readEnv('GHOST_SITE_URL'),
    hint: 'Paste your Ghost site URL (the Ghost site root, e.g. https://blog.example.com): ',
  });
  if (!siteRoot) { console.error('[err] GHOST_SITE_URL missing in .env (the Ghost site root, e.g. https://blog.example.com).'); process.exit(2); }
  const apiKey = await resolveCredential({
    value: readEnv('GHOST_ADMIN_API_KEY'),
    secret: true,
    hint: 'Paste your Ghost Admin API key (Settings > Integrations > Custom integrations > Admin API key): ',
  });
  if (!apiKey) { console.error('[err] GHOST_ADMIN_API_KEY missing in .env (Settings -> Integrations -> Custom integrations -> Admin API key).'); process.exit(2); }
  writeEnv({ GHOST_SITE_URL: siteRoot, GHOST_ADMIN_API_KEY: apiKey });
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
    // Publish hold (lib/publish-hold.mjs): the failure cap is spent - never re-fire on
    // its own. Backstop for direct CLI runs; the scheduler's lanesOwed already drops a
    // held post from the fire loop. Reschedule or edit clears the hold.
    if (post.publishHold) {
      console.log(`[skip] ${post.id}: publish hold after repeated failures (${post.publishHold.code ?? post.publishHold.message ?? 'unknown'}) - reschedule or edit the post to retry.`);
      continue;
    }
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
    // Spec 43 §4.1: the draft HANDOFF. WordPress honors this flag; Ghost silently
    // ignored it and published live - the exact silent-publish hole this closes.
    // When set, step 1 (the draft create) is the WHOLE job: no publish flip, no
    // newsletter email (there is no draft->published transition to hang one on).
    const draftHandoff = post.publishAsDraft === true;

    if (args['dry-run']) {
      console.log(draftHandoff
        ? `[dry] ${post.id}: would create draft "${title}" (${html.length} chars html) and stop there (publishAsDraft - the operator publishes from Ghost admin).`
        : `[dry] ${post.id}: would create draft "${title}" (${html.length} chars html) then publish${wantsEmail ? ' + newsletter email' : ' (web-only)'}.`);
      continue;
    }

    console.log(draftHandoff
      ? `[info] ${post.id}: handing off "${title}" as a Ghost draft...`
      : `[info] ${post.id}: publishing "${title}" to Ghost...`);
    try {
      // Step 0: resolve the newsletter slug + segment FIRST, before any Ghost
      // object exists. An unknown/inactive requested slug throws here (errorCode
      // invalid_input - fail-closed, spec 01 scenario 5); resolving it before the
      // draft POST keeps that path genuinely side-effect-free (no orphan draft +
      // image upload left behind to be re-created every 60s scheduler tick).
      // A draft handoff never emails, so it skips the resolution outright.
      const { slug: newsletterSlug, segment: emailSegment } = wantsEmail && !draftHandoff ? await newsletterParamsFor(post) : { slug: null, segment: null };

      // Step 1: create the DRAFT. Publishing directly would skip the
      // draft->published transition Ghost hangs the newsletter email on.
      const payload = await buildDraftPayload(plan, post, { title, html });
      const draft = (await ghost('POST', '/posts/?source=html', { body: { posts: [payload] } })).posts?.[0];
      if (!draft?.id) throw new Error('draft create returned no post id');

      // Step 2: flip draft -> published; ?newsletter=<slug>&email_segment=<nql> on
      // THIS transition is what makes Ghost email subscribers (and to whom). No
      // active newsletter -> web-only. A draft handoff STOPS after step 1: the
      // recorded id is the draft's, and the operator publishes from Ghost admin.
      let liv = null;
      if (!draftHandoff) {
        const publishPath = `/posts/${draft.id}/?source=html${newsletterSlug ? `&newsletter=${encodeURIComponent(newsletterSlug)}` : ''}${newsletterSlug && emailSegment ? `&email_segment=${encodeURIComponent(emailSegment)}` : ''}`;
        liv = (await ghost('PUT', publishPath, { body: { posts: [{ status: 'published', updated_at: draft.updated_at }] } })).posts?.[0];
      }

      post.ghostPostId = String(draft.id);
      post.status = 'posted';
      post.postedAt = new Date(now).toISOString();
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'ghost', action: 'publish', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'ghost', action: 'publish', ok: true, id: String(draft.id), ...(draftHandoff ? { draft: true } : {}) });
      console.log(draftHandoff
        ? `[ok] ${post.id}: handed off as a Ghost draft (post ${draft.id}) - publish it from Ghost admin (no email sent).`
        : `[ok] ${post.id}: published on Ghost - ${liv?.url || '(no url returned)'}${newsletterSlug ? ` (newsletter "${newsletterSlug}" emailed)` : ' (web-only, no email)'}`);
      published += 1;
    } catch (err) {
      const errorCode = err.code || 'engine_failure';
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'ghost', action: 'publish', ok: false, errorCode, errorMessage: err.message.slice(0, 300), actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'ghost', action: 'publish', ok: false, errorCode, errorMessage: err.message.slice(0, 300) });
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
    // Publish hold (lib/publish-hold.mjs): the failure cap is spent - never re-fire on
    // its own. Backstop for direct CLI runs; the scheduler's lanesOwed already drops a
    // held post from the fire loop. Reschedule or edit clears the hold.
    if (post.publishHold) {
      console.log(`[skip] ${post.id}: publish hold after repeated failures (${post.publishHold.code ?? post.publishHold.message ?? 'unknown'}) - reschedule or edit the post to retry.`);
      continue;
    }
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
    // Spec 43 §4.1: a draft handoff never natively schedules - Ghost's 'scheduled'
    // status auto-publishes at published_at, the exact opposite of a handoff. The
    // draft is created NOW and the operator publishes it from Ghost admin (the
    // WordPress model: wordpress-social.mjs treats draftHandoff as immediate).
    const draftHandoff = post.publishAsDraft === true;
    const immediate = pastDue || draftHandoff;

    if (!immediate && dueMs <= now + MIN_SCHEDULE_LEAD_MS) {
      console.log(`[skip] ${post.id}: due in <${Math.ceil(MIN_SCHEDULE_LEAD_MS / 60000)}m - inside Ghost's minimum scheduling lead; it publishes AT due time instead.`);
      continue;
    }
    if (args['dry-run']) {
      console.log(draftHandoff
        ? `[dry] ${post.id}: would create draft "${title}" and stop there (publishAsDraft - the operator publishes from Ghost admin).`
        : pastDue
          ? `[dry] ${post.id}: past due - would create draft "${title}" then publish immediately${wantsEmail ? ' + newsletter email' : ' (web-only)'}.`
          : `[dry] ${post.id}: would create draft "${title}" then natively schedule it for ${new Date(dueMs).toISOString()}${wantsEmail ? ' + newsletter email at publish' : ' (web-only)'}.`);
      continue;
    }

    console.log(draftHandoff
      ? `[info] ${post.id}: handing off "${title}" as a Ghost draft...`
      : pastDue
        ? `[info] ${post.id}: past due - publishing "${title}" to Ghost immediately...`
        : `[info] ${post.id}: natively scheduling "${title}" on Ghost for ${new Date(dueMs).toISOString()}...`);
    try {
      // Step 0: resolve the newsletter slug + segment FIRST, before any Ghost
      // object exists. An unknown/inactive requested slug throws here (errorCode
      // invalid_input - fail-closed, spec 01 scenario 5); resolving it before the
      // draft POST keeps that path genuinely side-effect-free (no orphan draft +
      // image upload left behind to be re-created every 60s scheduler tick).
      // A draft handoff never emails, so it skips the resolution outright.
      const { slug: newsletterSlug, segment: emailSegment } = wantsEmail && !draftHandoff ? await newsletterParamsFor(post) : { slug: null, segment: null };

      // Step 1: the DRAFT (the transition Ghost hangs the email on needs one).
      const payload = await buildDraftPayload(plan, post, { title, html });
      const draft = (await ghost('POST', '/posts/?source=html', { body: { posts: [payload] } })).posts?.[0];
      if (!draft?.id) throw new Error('draft create returned no post id');

      // Step 2: draft -> published (past due) or draft -> scheduled + published_at.
      // ?newsletter=<slug>&email_segment=<nql> on THIS transition binds the email
      // either way. A draft handoff STOPS after step 1 - no flip, no email.
      let liv = null;
      if (!draftHandoff) {
        const targetStatus = pastDue ? 'published' : 'scheduled';
        const body = { status: targetStatus, updated_at: draft.updated_at };
        if (!pastDue) body.published_at = new Date(dueMs).toISOString();
        const flipPath = `/posts/${draft.id}/?source=html${newsletterSlug ? `&newsletter=${encodeURIComponent(newsletterSlug)}` : ''}${newsletterSlug && emailSegment ? `&email_segment=${encodeURIComponent(emailSegment)}` : ''}`;
        liv = (await ghost('PUT', flipPath, { body: { posts: [body] } })).posts?.[0];
      }

      post.ghostPostId = String(draft.id);
      if (immediate) {
        post.status = 'posted';
        post.postedAt = new Date(now).toISOString();
        appendAttempt(post, { ts: new Date().toISOString(), platform: 'ghost', action: 'publish', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
        await savePlan(abs, plan, [post.id]);
        RUN.results.push({ postId: post.id, platform: 'ghost', action: 'publish', ok: true, id: String(draft.id), ...(draftHandoff ? { draft: true } : {}) });
        console.log(draftHandoff
          ? `[ok] ${post.id}: handed off as a Ghost draft (post ${draft.id}) - publish it from Ghost admin (no email sent).`
          : `[ok] ${post.id}: published on Ghost - ${liv?.url || '(no url returned)'}${newsletterSlug ? ` (newsletter "${newsletterSlug}" emailed)` : ' (web-only, no email)'}`);
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
      const action = immediate ? 'publish' : 'schedule-native';
      const errorCode = err.code || 'engine_failure';
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'ghost', action, ok: false, errorCode, errorMessage: err.message.slice(0, 300), actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'ghost', action, ok: false, errorCode, errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: Ghost ${immediate ? 'publish' : 'schedule'} failed - ${err.message}`);
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
      // Spec 01: an email-only post resolves to 'sent', not 'published' - treat it
      // as a clean live no-op too (else a successfully-sent post logs a spurious
      // ok:false invalid_input from the non-'scheduled' branch below).
      if (gp.status === 'published' || gp.status === 'sent') {
        RUN.results.push({ postId: post.id, platform: 'ghost', action: 'release', ok: true, id: post.ghostPostId, live: true, state: gp.status, permalink: gp.url || null });
        console.log(`[ok] ${post.id}: already ${gp.status} - no action.`);
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
      // Spec 01: an email-only post never web-publishes - Ghost resolves its
      // status to 'sent' instead of 'published'. Both read as LIVE so verify_post
      // stays honest and lanesOwed/reconcile never re-fire an already-sent post.
      const live = gp.status === 'published' || gp.status === 'sent';
      let state = live ? gp.status : (gp.status || 'unknown');
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

// Spec 08 (richer analytics, Pattern P5): the Admin API DOES expose per-post
// email + link-click stats once ?include=email,count.clicks is asked for - this
// was a no-op only because nothing requested those includes. opened/sent read 0
// (never omitted) for a web-only post that was never emailed - an honest fact,
// not a fabricated number. Degrades to an ok:false row on any failure (deleted
// post, rotated key, etc.), never a throw (P9).
async function cmdInsights(args) {
  const { plan } = loadPlan(args.plan);
  const targets = (plan.posts || []).filter((p) => isGhost(p) && p.ghostPostId && (!args.only || p.id === args.only));
  if (!targets.length) { console.log('[done] insights complete - no posts with a ghostPostId.'); return; }
  for (const post of targets) {
    try {
      const gp = (await ghost('GET', `/posts/${post.ghostPostId}/?include=email,count.clicks`)).posts?.[0];
      if (!gp) throw new Error(`post ${post.ghostPostId} lookup returned no post`);
      const metrics = {
        opened: Number(gp.email?.opened_count ?? 0),
        sent: Number(gp.email?.email_count ?? 0),
        clicks: Number(gp.count?.clicks ?? 0),
      };
      RUN.results.push({ postId: post.id, platform: 'ghost', action: 'insights', ok: true, id: post.ghostPostId, metrics });
      console.log(`[ok] ${post.id}: Ghost ${JSON.stringify(metrics)}`);
    } catch (err) {
      RUN.results.push({ postId: post.id, platform: 'ghost', action: 'insights', ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 300), id: post.ghostPostId });
      console.error(`[err] ${post.id}: ghost insights failed - ${err.message}`);
    }
  }
  console.log(`[done] insights complete - ${RUN.results.filter((r) => r.ok).length} fetched.`);
}

// A 404 means the post is ALREADY GONE (deleted in the Ghost admin, previously
// cancelled, or never resolvable) - exactly the end state a delete wants, so
// it is swallowed as an idempotent success rather than raising engine_failure
// and stranding the plan row (mirrors yt-social.mjs cmdDelete /
// discord-social.mjs cmdDeleteEvent). Any OTHER error still throws.
async function cmdDelete(args) {
  if (!args.id) { console.error('[err] delete requires --id <postId>'); process.exit(2); }
  try {
    await ghost('DELETE', `/posts/${args.id}/`);
    console.log(`[ok] deleted Ghost post ${args.id}.`);
  } catch (err) {
    if (err?.status !== 404) throw err;
    console.log(`[skip] Ghost post ${args.id} is already gone (404) - counting it deleted.`);
    RUN.results.push({ platform: 'ghost', action: 'delete', ok: true, id: String(args.id), alreadyGone: true });
    return;
  }
  RUN.results.push({ platform: 'ghost', action: 'delete', ok: true, id: String(args.id) });
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

// ---------- account-scoped verbs (spec 30: members + newsletters, Pattern P3) ----------
//
// SIX verbs, none `--plan` (account-level, not any plan post) - the audience
// behind spec 01's newsletter email. Each pushes exactly ONE result row onto
// RUN.results and NEVER throws (P9): a missing GHOST_SITE_URL/GHOST_ADMIN_API_KEY
// degrades the row to { ok:false, errorCode:'not_configured' } (mirrors cmdProbe),
// a 422/validation Ghost error degrades to { ok:false, errorCode:'invalid_input' },
// anything else to 'engine_failure'. Segments = labels (NQL `label:<slug>`) - Ghost
// has no first-class segment object, so there is no separate segment verb; a
// member's `--labels` IS the segment target spec 01's emailSegment consumes.

// Shared not-configured guard (mirrors cmdProbe's two-part check, :702-717) - pushes
// the row itself so every verb below can just `if (!requireGhostConfigured(...)) return;`.
function requireGhostConfigured(action) {
  if (!readEnv('GHOST_ADMIN_API_KEY') || !siteUrl()) {
    RUN.results.push({ platform: 'ghost', action, ok: false, errorCode: 'not_configured', errorMessage: 'GHOST_SITE_URL / GHOST_ADMIN_API_KEY not set' });
    return false;
  }
  return true;
}

// Comma-separated CLI value -> a trimmed, non-empty string array (mirrors tagsFor's
// splitting, :257-261) - used for --labels and --newsletters on member-create.
function parseListArg(raw) {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  if (typeof raw !== 'string') return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// Ghost's own id shape (a 24-char hex ObjectId, same as a post id) - lets
// member-create/members-import accept EITHER a newsletter id or slug in the same
// --newsletters flag and address it correctly ({id} vs {slug} in the POST body).
const GHOST_ID_RE = /^[0-9a-f]{24}$/i;
const newsletterRef = (idOrSlug) => (GHOST_ID_RE.test(idOrSlug) ? { id: idOrSlug } : { slug: idOrSlug });

function normalizeMember(m) {
  return {
    id: m.id,
    email: m.email,
    name: m.name || null,
    status: m.status,
    labels: Array.isArray(m.labels) ? m.labels.map((l) => ({ id: l.id, name: l.name, slug: l.slug })) : [],
    newsletters: Array.isArray(m.newsletters) ? m.newsletters.map((n) => ({ id: n.id, name: n.name, status: n.status })) : [],
  };
}

// members (read): GET /members/?include=newsletters,labels&limit&page&filter.
// `total` is the SAME list call's meta.pagination.total (honors --filter, if any);
// free/paid/comped are THREE separate exact per-status counts (limit:1, reading
// only meta.pagination.total) so the Setup audience line ("1,090 free - 150 paid")
// is never a page-limited tally - each status query composes the caller's --filter
// via NQL `+` (AND) so a filtered read's breakdown still narrows consistently.
async function cmdMembers(args) {
  if (!requireGhostConfigured('members')) return;
  try {
    const limit = Math.max(1, Math.min(Number.parseInt(args.limit, 10) || 15, 100));
    const page = Math.max(1, Number.parseInt(args.page, 10) || 1);
    const userFilter = typeof args.filter === 'string' && args.filter.trim() ? args.filter.trim() : '';
    const filterQS = userFilter ? `&filter=${encodeURIComponent(userFilter)}` : '';
    const data = await ghost('GET', `/members/?include=newsletters,labels&limit=${limit}&page=${page}${filterQS}`);
    const items = (data.members || []).map(normalizeMember);
    const total = data.meta?.pagination?.total ?? items.length;
    const countFor = async (status) => {
      // MINOR-4: NQL `+` (AND) binds tighter than `,` (OR), so an unparenthesized
      // `status:free+${userFilter}` against an OR filter (e.g. "label:a,label:b")
      // parsed as (status:free AND label:a) OR label:b - silently wrong breakdown.
      // Parenthesizing the user filter forces status: to AND across the WHOLE
      // filter regardless of its own , / + composition.
      const statusFilter = userFilter ? `status:${status}+(${userFilter})` : `status:${status}`;
      const d = await ghost('GET', `/members/?limit=1&filter=${encodeURIComponent(statusFilter)}`);
      return d.meta?.pagination?.total ?? 0;
    };
    const [free, paid, comped] = await Promise.all([countFor('free'), countFor('paid'), countFor('comped')]);
    RUN.results.push({ platform: 'ghost', action: 'members', ok: true, counts: { total, free, paid, comped }, items });
  } catch (err) {
    RUN.results.push({ platform: 'ghost', action: 'members', ok: false, errorCode: err.status === 422 ? 'invalid_input' : 'engine_failure', errorMessage: String(err.message || err).slice(0, 300) });
  }
}

// member-create (write): POST /members/ {members:[{email,name,note,labels,newsletters,subscribed}]}.
async function cmdMemberCreate(args) {
  if (!requireGhostConfigured('member-create')) return;
  const email = typeof args.email === 'string' ? args.email.trim() : '';
  if (!email) {
    RUN.results.push({ platform: 'ghost', action: 'member-create', ok: false, errorCode: 'invalid_input', errorMessage: '--email is required' });
    return;
  }
  try {
    const member = { email };
    if (typeof args.name === 'string' && args.name.trim()) member.name = args.name.trim();
    if (typeof args.note === 'string' && args.note.trim()) member.note = args.note.trim();
    const labels = parseListArg(args.labels);
    if (labels.length) member.labels = labels.map((name) => ({ name }));
    const newsletters = parseListArg(args.newsletters);
    if (newsletters.length) member.newsletters = newsletters.map(newsletterRef);
    if (args.subscribed !== undefined) member.subscribed = args.subscribed === true || args.subscribed === 'true';
    const data = await ghost('POST', '/members/', { body: { members: [member] } });
    const id = data.members?.[0]?.id;
    if (!id) throw new Error('member create returned no id');
    RUN.results.push({ platform: 'ghost', action: 'member-create', ok: true, id });
  } catch (err) {
    RUN.results.push({ platform: 'ghost', action: 'member-create', ok: false, errorCode: err.status === 422 ? 'invalid_input' : 'engine_failure', errorMessage: String(err.message || err).slice(0, 300) });
  }
}

// members-import (write): --file <csv> or --rows <json>, iterating POST /members/
// per row - zero-dep, RESILIENT (a bad/duplicate row is skipped, never aborts the
// batch). A duplicate email (Ghost's real 422 "already exists" validation error)
// is tallied as `skipped`; every other failure (missing email caught locally, or
// any other rejected row) lands in `failed[]` with its message - the distinction
// spec 30 scenario 3 draws ("duplicates are skipped ... never crashing the batch").
// --upload takes the multipart fast-path (POST /members/upload/, the SAME FormData
// shape uploadFeatureImage already uses) instead of the per-row loop.
//
// Post-review (MAJOR-2): the per-row loop has no cap/throttle, and each row is
// its own live network round-trip - a large batch can run past
// GHOST_MEMBERS_IMPORT_TIMEOUT_MS (lib/writes.mjs), SIGTERMing the engine
// mid-batch. Members already POSTed to Ghost by then are real and stick; the
// caller only sees engine_failure and the {created,skipped,failed} tally is
// lost. MAX_IMPORT_ROWS caps the per-row path so a run always has time to
// finish (see the timeout comment in lib/writes.mjs for the math) and points
// an over-cap caller at --upload instead, which hands the WHOLE file to Ghost
// as one multipart request or Ghost does the batching server-side, so there is
// no per-row round-trip to get killed mid-way.
const MAX_IMPORT_ROWS = 500;

async function cmdMembersImport(args) {
  if (!requireGhostConfigured('members-import')) return;
  let rows = [];
  try {
    if (typeof args.rows === 'string' && args.rows.trim()) {
      const parsed = JSON.parse(args.rows);
      if (!Array.isArray(parsed)) throw new Error('--rows must be a JSON array');
      rows = parsed;
    } else if (typeof args.file === 'string' && args.file.trim()) {
      const root = process.env.PENDPOST_ROOT ? path.resolve(process.env.PENDPOST_ROOT) : path.resolve(__dirname, '..');
      const abs = path.isAbsolute(args.file) ? args.file : path.resolve(root, args.file);
      if (!fs.existsSync(abs)) throw new Error(`file not found: ${args.file}`);
      if (args.upload) {
        const form = new FormData();
        form.append('membersfile', new Blob([fs.readFileSync(abs)], { type: 'text/csv' }), path.basename(abs));
        const data = await ghost('POST', '/members/upload/', { form });
        const meta = data.meta || {};
        const stats = meta.stats || meta;
        // Ghost's documented importer shape nests invalid rows under
        // meta.stats.invalid; some responses instead put them at meta.invalid.
        // Read created/skipped/failed with the SAME stats-then-meta fallback for
        // all three (previously `failed` only checked meta.invalid, so a
        // stats.invalid-shaped response silently reported failed:[] - MINOR-3).
        const invalidList = Array.isArray(stats.invalid) ? stats.invalid : (Array.isArray(meta.invalid) ? meta.invalid : []);
        RUN.results.push({
          platform: 'ghost', action: 'members-import', ok: true,
          created: Number(stats.imported ?? 0),
          skipped: Number(Array.isArray(meta.duplicates) ? meta.duplicates.length : (stats.duplicates ?? 0)),
          failed: invalidList.map((e) => ({ email: e.email || null, error: e.error || 'invalid row' })),
        });
        return;
      }
      rows = parseCsvRows(fs.readFileSync(abs, 'utf8'));
    } else {
      throw new Error('members-import requires --file <csv> or --rows <json>');
    }
  } catch (err) {
    RUN.results.push({ platform: 'ghost', action: 'members-import', ok: false, errorCode: 'invalid_input', errorMessage: String(err.message || err).slice(0, 300) });
    return;
  }

  // MAJOR-2: reject an over-cap per-row import UP FRONT (before any network
  // call) rather than letting it run into the timeout mid-batch. --upload
  // (checked above, before rows[] is ever populated from --file) is exempt -
  // it is Ghost's own server-side bulk import, one request, no per-row cap.
  if (rows.length > MAX_IMPORT_ROWS) {
    RUN.results.push({
      platform: 'ghost', action: 'members-import', ok: false, errorCode: 'invalid_input',
      errorMessage: `members-import via --rows/--file is capped at ${MAX_IMPORT_ROWS} rows (got ${rows.length}) so a large batch can't be killed mid-run by the engine timeout; pass --file <csv> --upload instead for Ghost's server-side bulk import (one request, no per-row cap).`,
    });
    return;
  }

  let created = 0;
  let skipped = 0;
  const failed = [];
  for (const row of rows) {
    const email = typeof row?.email === 'string' ? row.email.trim() : '';
    if (!email) { failed.push({ email: null, error: 'missing email' }); continue; }
    try {
      const member = { email };
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      if (name) member.name = name;
      const note = typeof row.note === 'string' ? row.note.trim() : '';
      if (note) member.note = note;
      const labels = parseListArg(row.labels);
      if (labels.length) member.labels = labels.map((n) => ({ name: n }));
      const newsletters = parseListArg(row.newsletters);
      if (newsletters.length) member.newsletters = newsletters.map(newsletterRef);
      await ghost('POST', '/members/', { body: { members: [member] } });
      created += 1;
    } catch (err) {
      const msg = String(err.message || err);
      if (err.status === 422 && /already exists|duplicate/i.test(msg)) skipped += 1;
      else failed.push({ email, error: msg.slice(0, 200) });
    }
  }
  RUN.results.push({ platform: 'ghost', action: 'members-import', ok: true, created, skipped, failed });
}

// newsletters (read): GET /newsletters/ - reuses fetchNewsletters(), the SAME
// call newsletterParamsFor makes at publish time (spec 01). No duplicate fetch.
async function cmdNewsletters() {
  if (!requireGhostConfigured('newsletters')) return;
  try {
    const newsletters = await fetchNewsletters();
    const items = newsletters.map((n) => ({ id: n.id, slug: n.slug, name: n.name, status: n.status, subscribe_on_signup: n.subscribe_on_signup, members_count: n.count?.members ?? n.members_count ?? undefined }));
    RUN.results.push({ platform: 'ghost', action: 'newsletters', ok: true, items });
  } catch (err) {
    RUN.results.push({ platform: 'ghost', action: 'newsletters', ok: false, errorCode: err.status === 422 ? 'invalid_input' : 'engine_failure', errorMessage: String(err.message || err).slice(0, 300) });
  }
}

// newsletter-create (write): POST /newsletters/ {newsletters:[{name,description,subscribe_on_signup}]}.
async function cmdNewsletterCreate(args) {
  if (!requireGhostConfigured('newsletter-create')) return;
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) {
    RUN.results.push({ platform: 'ghost', action: 'newsletter-create', ok: false, errorCode: 'invalid_input', errorMessage: '--name is required' });
    return;
  }
  try {
    const newsletter = { name };
    if (typeof args.description === 'string' && args.description.trim()) newsletter.description = args.description.trim();
    if (args['subscribe-on-signup'] !== undefined) newsletter.subscribe_on_signup = args['subscribe-on-signup'] === true || args['subscribe-on-signup'] === 'true';
    const data = await ghost('POST', '/newsletters/', { body: { newsletters: [newsletter] } });
    const created = data.newsletters?.[0];
    if (!created?.id) throw new Error('newsletter create returned no id');
    RUN.results.push({ platform: 'ghost', action: 'newsletter-create', ok: true, id: created.id, slug: created.slug });
  } catch (err) {
    RUN.results.push({ platform: 'ghost', action: 'newsletter-create', ok: false, errorCode: err.status === 422 ? 'invalid_input' : 'engine_failure', errorMessage: String(err.message || err).slice(0, 300) });
  }
}

// newsletter-update (write): PUT /newsletters/{id}/ {newsletters:[{status,...,
// updated_at}]} - archive/activate/rename. Ghost's edit endpoints collision-check
// on `updated_at` (the SAME precondition posts PUT carries, e.g. cmdRelease
// :610), so this GETs the current newsletter first (a fresh JWT/round-trip, but
// account writes are rare/operator-paced, not a hot loop) rather than guessing a
// stale timestamp. IDEMPOTENT: re-applying the same status is the same end state.
const NEWSLETTER_STATUSES = new Set(['active', 'archived']);
async function cmdNewsletterUpdate(args) {
  if (!requireGhostConfigured('newsletter-update')) return;
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) {
    RUN.results.push({ platform: 'ghost', action: 'newsletter-update', ok: false, errorCode: 'invalid_input', errorMessage: '--id is required' });
    return;
  }
  if (args.status !== undefined && !NEWSLETTER_STATUSES.has(args.status)) {
    RUN.results.push({ platform: 'ghost', action: 'newsletter-update', ok: false, errorCode: 'invalid_input', errorMessage: '--status must be active|archived' });
    return;
  }
  try {
    const current = (await ghost('GET', `/newsletters/${encodeURIComponent(id)}/`)).newsletters?.[0];
    if (!current) throw Object.assign(new Error(`newsletter ${id} not found`), { status: 404 });
    const patch = { updated_at: current.updated_at };
    if (args.status !== undefined) patch.status = args.status;
    if (typeof args.name === 'string' && args.name.trim()) patch.name = args.name.trim();
    if (typeof args.description === 'string') patch.description = args.description.trim();
    const data = await ghost('PUT', `/newsletters/${encodeURIComponent(id)}/`, { body: { newsletters: [patch] } });
    const updated = data.newsletters?.[0];
    if (!updated?.id) throw new Error('newsletter update returned no id');
    RUN.results.push({ platform: 'ghost', action: 'newsletter-update', ok: true, id: updated.id, status: updated.status });
  } catch (err) {
    const errorCode = err.status === 422 || err.status === 404 ? 'invalid_input' : 'engine_failure';
    RUN.results.push({ platform: 'ghost', action: 'newsletter-update', ok: false, errorCode, errorMessage: String(err.message || err).slice(0, 300) });
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
  // Spec 30 (members + newsletters, Pattern P3): account-scoped, no --plan - NOT
  // added to the plan-required guard below.
  members: cmdMembers,
  'member-create': cmdMemberCreate,
  'members-import': cmdMembersImport,
  newsletters: cmdNewsletters,
  'newsletter-create': cmdNewsletterCreate,
  'newsletter-update': cmdNewsletterUpdate,
};

async function main() {
  const args = parseArgs(process.argv);
  await enforceCeremonyClient({ argv: args, command: args._[0], lane: 'ghost', scriptUrl: import.meta.url });
  JSON_MODE = Boolean(args.json);
  ACTOR = typeof args.actor === 'string' ? args.actor : 'cli';
  if (JSON_MODE) console.log = (...a) => console.error(...a);
  const commandName = args._[0];
  if (resolveMode('ghost') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'ghost', command: commandName,
      planPath: typeof args.plan === 'string' ? path.resolve(String(args.plan)) : null,
      only: typeof args.only === 'string' ? args.only : null,
      // Spec 30 (members + newsletters): the account-scoped verbs' own flags,
      // threaded through so mock mode can fabricate a shape-faithful envelope
      // with no network (email/name/description/status/id already exist as
      // generic kwargs shared with other lanes' mock cases).
      email: typeof args.email === 'string' ? args.email : null,
      name: typeof args.name === 'string' ? args.name : null,
      description: typeof args.description === 'string' ? args.description : null,
      status: typeof args.status === 'string' ? args.status : null,
      id: typeof args.id === 'string' ? args.id : null,
      limit: args.limit !== undefined ? args.limit : null,
      page: args.page !== undefined ? args.page : null,
      filter: typeof args.filter === 'string' ? args.filter : null,
      rows: typeof args.rows === 'string' ? args.rows : null,
      filePath: typeof args.file === 'string' ? args.file : null,
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

// Run only when executed directly (node scripts/ghost-social.mjs ...), not when
// imported for a unit test of an exported command (cmdDelete) - mirrors the guard
// discord-social.mjs/mastodon-social.mjs/telegram-social.mjs/nostr-social.mjs use.
// The daemon invokes this as a subprocess, so argv[1] is this script and main()
// still runs in production. Unconditional invocation here would run main() against
// the TEST RUNNER's own argv on import, printing the usage line and calling
// process.exit(2), killing the test process itself (spec 12's discord-social.mjs
// review lesson, applied here for ghost-delete-idempotent.test.mjs).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (err) => {
    console.error('[err]', err.message || err);
    if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: false, error: String(err.message || err).slice(0, 300), ...RUN })}\n`);
    process.exit(1);
  });
}

// Test-only export: cmdDelete + RUN are exported so a delete-idempotency test can
// drive the real 404-swallow logic in-process against a stubbed global.fetch, with
// no network/credentials/subprocess - mirrors yt-social.mjs's cmdDelete export.
export { cmdDelete, RUN };
