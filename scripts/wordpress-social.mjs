#!/usr/bin/env node
/**
 * wordpress-social.mjs - direct WordPress publishing via the REST API.
 *
 * Sibling of scripts/telegram-social.mjs / reddit-social.mjs: the same zero-dep,
 * plan-driven, publish-straight-from-the-local-render pattern - but this is the
 * first LONG-FORM lane: a plan entry maps to a full blog post (title + body +
 * excerpt + tags + featured image), not a short caption.
 *
 * Works against any SELF-HOSTED WordPress (>= 5.6) and wordpress.com sites - both
 * ship Application Passwords + the wp/v2 REST API out of the box. The REST API
 * must be enabled (it is by default; some security plugins turn it off, which
 * surfaces here as a 404 on /wp-json).
 *
 * NATIVE SCHEDULING (owner decision 2026-07-05, reversing the earlier
 * publish-at-due-time choice): `schedule` creates the post ahead of its due time
 * with status 'future' + date_gmt, so WordPress's own scheduler (wp-cron)
 * publishes it even when this machine is off - the same survives-power-off model
 * as yt-social.mjs. The plan stays the source of truth via a full reconcile
 * story: the post KEEPS ITS ID across the future->publish transition (like a
 * YouTube publishAt video, unlike a Mastodon queue entry), so it is findable,
 * verifiable (GET /posts/<id> reports 'future' vs 'publish') and cancellable
 * (`delete --id`; lib/writes.mjs nativeHandoff drives that on unschedule/
 * reschedule/edit). wp-cron only fires on site traffic, so a low-traffic site
 * can leave a post 'future' PAST its date - verify reads that back as
 * 'future-overdue' and the scheduler's wordpress-release lane flips it live
 * (`release`, a one-field status update - the exact yt private-overdue model).
 * `publish-due` is kept for manual/late runs - `schedule` falls back to the same
 * immediate publish when an entry is already past due.
 *
 * AUTH - an Application Password, no browser OAuth:
 *   WORDPRESS_SITE_URL      the site root, e.g. https://blog.example.com
 *                           (a trailing slash is tolerated - normalized away).
 *   WORDPRESS_USERNAME      the WP username the password was minted for.
 *   WORDPRESS_APP_PASSWORD  minted under Users -> Profile -> Application
 *                           Passwords in wp-admin. Long-lived until revoked, so
 *                           `refresh` is a no-op. Sent as HTTP Basic
 *                           (base64 of "username:appPassword") on EVERY request.
 * The user needs a role that may publish_posts (Author/Editor/Administrator);
 * `connect`/`auth` validates exactly that (GET /users/me) and writes nothing.
 *
 * CONTENT - the long-form mapping (raw plan post fields):
 *   post.title    REQUIRED - the article title. A due entry without one is
 *                 warn-skipped (a blog post cannot exist untitled).
 *   post.body     the article body in MARKDOWN (falls back to post.caption),
 *                 converted to HTML by lib/markdown.mjs - a deliberately small
 *                 subset (headings, emphasis, links, lists, code, blockquotes);
 *                 anything fancier is authored as literal HTML in the body.
 *   post.excerpt  optional hand-written excerpt (omitted -> WP auto-generates).
 *   post.tags     a comma-separated string ("launch, changelog"); each name is
 *                 resolved to an existing tag id (case-insensitive, entity-
 *                 decoded) or created on the fly - race-safe via term_exists.
 *   media         the post's local IMAGE (jpg/jpeg/png/webp/gif) uploads to
 *                 /media and becomes the featured image; a video cannot be a
 *                 WordPress featured image and is skipped with an [info] note.
 * The public permalink comes back on the created post's `link` field - it is
 * logged on publish and surfaced through verify.
 *
 * Commands:
 *   auth | connect   validate the application password (GET /users/me); writes nothing
 *   refresh          no-op (application passwords are long-lived) - sibling parity
 *   validate         --plan <p> [--only <id>]   side-effect-free preview, never posts
 *   schedule         --plan <p> [--only <id>] [--dry-run]   natively schedule (status 'future'); publishes NOW when past due
 *   release          --plan <p> [--only <id>]   flip a future-overdue post live (wp-cron backstop)
 *   publish-due      --plan <p> [--only <id>] [--dry-run]   publish any due WordPress entry (manual/late path)
 *   status           --plan <p>                 list WordPress plan entries
 *   verify           --plan <p> [--only <id>]   read-only liveness (GET /posts/<id>; 'future' reads scheduled/future-overdue)
 *   insights         --plan <p> [--only <id>]   no-op (core WP exposes no post metrics)
 *   probe                                        read-only health probe (/users/me)
 *   delete           --id <postId>               permanently delete a post (?force=true; also cancels a scheduled one)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand } from '../lib/mode.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
import { envPath } from '../lib/util.mjs';
import { mdToHtml } from '../lib/markdown.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = envPath();

// ---------- env helpers (same shape as the sibling engines) ----------

function readEnvRaw() {
  return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
}
function readEnv(name) {
  const m = readEnvRaw().match(new RegExp(`^${name}=(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

// The site root, normalized: a trailing slash would double up in `${site}/wp-json`.
function siteUrl() {
  const raw = readEnv('WORDPRESS_SITE_URL');
  return raw ? raw.replace(/\/+$/, '') : null;
}
const apiBase = () => `${siteUrl()}/wp-json/wp/v2`;

function siteHost() {
  const s = siteUrl();
  try { return new URL(s).host; } catch { return s || 'unknown'; }
}

// ---------- REST API helper ----------

function basicAuth() {
  const username = readEnv('WORDPRESS_USERNAME') || '';
  const appPassword = readEnv('WORDPRESS_APP_PASSWORD') || '';
  return `Basic ${Buffer.from(`${username}:${appPassword}`).toString('base64')}`;
}

// `raw` uploads bytes as-is (the /media sideload contract: raw body + the
// filename in Content-Disposition); `form` is urlencoded; `body` is JSON.
async function wp(method, pathname, { body, form, raw } = {}) {
  if (!siteUrl()) throw new Error('WORDPRESS_SITE_URL is not set in .env');
  const url = `${apiBase()}${pathname}`;
  const headers = { Authorization: basicAuth() };
  const init = { method, headers };
  if (raw) {
    headers['Content-Type'] = raw.contentType;
    headers['Content-Disposition'] = `attachment; filename="${raw.filename}"`;
    init.body = raw.buffer;
  } else if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`WordPress ${method} ${pathname}: HTTP ${res.status} - ${data.message || data.code || data.raw || text || 'unknown'}`);
    err.status = res.status;
    err.wpCode = data.code || null;
    err.wpData = data.data || null; // term_exists carries the winner's term_id here
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

const isWordpress = (post) => (post.platforms || []).includes('wordpress');
const titleFor = (post) => (post.title ? String(post.title).trim() : '');
const bodyMarkdown = (post) => (post.body || post.caption || '').trim();
const excerptFor = (post) => (post.excerpt ? String(post.excerpt).trim() : '');

// post.tags is a comma-separated string ("a, b, c") - split, trim, drop empties.
function tagNames(post) {
  return String(post.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
}

// Only an image can be a WordPress featured image - keyed off the extension.
const IMAGE_CONTENT_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
function imageContentType(localPath) {
  return IMAGE_CONTENT_TYPES[path.extname(localPath).toLowerCase()] || null;
}

// WP returns tag names HTML-entity-encoded (e.g. "&amp;") - decode before the
// case-insensitive exact match. Named non-amp entities first, &amp; last.
function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Resolve each tag name to an id: exact match on the decoded name first, then
// create. A concurrent create loses with 400 term_exists - the error body
// carries the winner's id in .data.term_id, so the race resolves to the same id.
async function resolveTagIds(names) {
  const ids = [];
  for (const name of names) {
    const found = await wp('GET', `/tags?search=${encodeURIComponent(name)}&per_page=100`);
    const hit = (Array.isArray(found) ? found : []).find((t) => decodeEntities(t.name).toLowerCase() === name.toLowerCase());
    if (hit) { ids.push(hit.id); continue; }
    try {
      const created = await wp('POST', '/tags', { body: { name } });
      ids.push(created.id);
    } catch (err) {
      const existingId = err.wpCode === 'term_exists' ? err.wpData?.term_id : null;
      if (!existingId) throw err;
      ids.push(existingId);
    }
  }
  return ids;
}

// Shared content assembly for publish-due and schedule: resolve tag ids, upload
// the featured image, render the markdown - everything except status/date.
async function buildPayload(post, { title, md, featuredPath }) {
  const tagIds = await resolveTagIds(tagNames(post));
  let featuredMediaId = null;
  if (featuredPath) {
    const media = await wp('POST', '/media', {
      raw: { buffer: fs.readFileSync(featuredPath), contentType: imageContentType(featuredPath), filename: path.basename(featuredPath) },
    });
    featuredMediaId = media.id;
  }
  const payload = { title, content: mdToHtml(md), tags: tagIds };
  const excerpt = excerptFor(post);
  if (excerpt) payload.excerpt = excerpt;
  if (featuredMediaId) payload.featured_media = featuredMediaId;
  return payload;
}

// The per-entry content gate shared by publish-due and schedule: returns
// { title, md, featuredPath } or null (with the warn logged) when unpublishable.
function publishableContent(plan, post) {
  const title = titleFor(post);
  if (!title) { console.log(`[warn] ${post.id}: no title (post.title is required for a blog post) - skipping.`); return null; }
  const md = bodyMarkdown(post);
  if (!md) { console.log(`[warn] ${post.id}: no body (post.body/caption) - skipping.`); return null; }
  let featuredPath = null;
  const mediaPath = resolveMediaPath(plan, post);
  if (mediaPath) {
    if (imageContentType(mediaPath)) featuredPath = mediaPath;
    else console.log(`[info] ${post.id}: video media is not used as a WordPress featured image.`);
  }
  return { title, md, featuredPath };
}

// ---------- commands ----------

async function cmdAuth() {
  const missing = [];
  if (!siteUrl()) missing.push('WORDPRESS_SITE_URL');
  if (!readEnv('WORDPRESS_USERNAME')) missing.push('WORDPRESS_USERNAME');
  if (!readEnv('WORDPRESS_APP_PASSWORD')) missing.push('WORDPRESS_APP_PASSWORD');
  if (missing.length) { console.error(`[err] WordPress credentials missing in .env: ${missing.join(', ')}`); process.exit(2); }
  const me = await wp('GET', '/users/me?context=edit');
  console.log(`[ok] authenticated as ${me.name} (${me.slug}) on ${siteUrl()}`);
  if (!me?.capabilities?.publish_posts) console.log('[warn] this user cannot publish_posts - publish-due will fail (needs an Author/Editor/Administrator role).');
  RUN.results.push({ platform: 'wordpress', action: 'auth', ok: true, detail: `${me.name} (${me.slug}) on ${siteHost()}` });
}

async function cmdRefresh() {
  console.log('[info] WordPress application passwords are long-lived (no refresh).');
}

async function cmdValidate(args) {
  const { plan } = loadPlan(args.plan);
  console.log('================ VALIDATION ONLY - NOTHING WILL BE PUBLISHED ================');
  try {
    const me = await wp('GET', '/users/me?context=edit');
    console.log(`[ok] Credentials valid - authenticated as ${me.name} (${me.slug}).`);
    if (!me?.capabilities?.publish_posts) console.log('[warn] this user cannot publish_posts.');
  } catch (err) {
    console.log(`[warn] auth check failed (${err.message}). Continuing to content preview.`);
  }
  const targets = (plan.posts || []).filter((p) => isWordpress(p) && (!args.only || p.id === args.only));
  if (!targets.length) { console.log('[warn] No WordPress entries match.'); return; }
  for (const post of targets) {
    const title = titleFor(post);
    const md = bodyMarkdown(post);
    const excerpt = excerptFor(post);
    const tags = tagNames(post);
    console.log(`\n----- ${post.id} -----`);
    console.log(`[preview] title:   ${title || '(MISSING - required)'}`);
    console.log(`[preview] body:    ${md.length} chars of markdown${md ? '' : ' (EMPTY)'}`);
    console.log(`[preview] excerpt: ${excerpt || '(none - WordPress auto-generates)'}`);
    console.log(`[preview] tags:    ${tags.length ? tags.join(', ') : '(none)'}`);
    const mediaPath = resolveMediaPath(plan, post);
    if (!mediaPath) {
      console.log('[preview] featured image: (none)');
    } else if (imageContentType(mediaPath)) {
      console.log(`[preview] featured image: ${path.basename(mediaPath)} (${(fs.statSync(mediaPath).size / 1e6).toFixed(1)} MB)`);
    } else {
      console.log(`[info] ${post.id}: video media is not used as a WordPress featured image.`);
    }
  }
  console.log('\n================ VALIDATION COMPLETE ================');
}

async function cmdPublishDue(args) {
  const { abs, plan } = loadPlan(args.plan);
  if (!siteUrl()) throw new Error('WORDPRESS_SITE_URL is not set - cannot publish.');
  const now = Date.now();
  let published = 0;

  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isWordpress(post)) continue;
    if (post.executionMode !== 'fully-scheduled') continue;
    if (post.status !== 'planned') continue;
    if ((post.approval || 'draft') !== 'approved') {
      console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish.`);
      continue;
    }
    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs) || dueMs > now) continue;

    const content = publishableContent(plan, post);
    if (!content) continue;
    const { title, md, featuredPath } = content;

    if (args['dry-run']) {
      console.log(`[dry] ${post.id}: would publish "${title}" (${md.length} chars markdown, ${tagNames(post).length} tag(s)${featuredPath ? `, featured image ${path.basename(featuredPath)}` : ''}).`);
      continue;
    }

    console.log(`[info] ${post.id}: publishing "${title}" to ${siteHost()}...`);
    try {
      const payload = await buildPayload(post, content);
      payload.status = 'publish';
      const resp = await wp('POST', '/posts', { body: payload });
      if (!resp?.id) throw new Error(`create returned no id: ${JSON.stringify(resp).slice(0, 200)}`);

      post.wordpressPostId = String(resp.id);
      post.status = 'posted';
      post.postedAt = new Date(now).toISOString();
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'wordpress', action: 'publish', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'wordpress', action: 'publish', ok: true, id: String(resp.id) });
      console.log(`[ok] ${post.id}: published on WordPress (post ${resp.id}) - ${resp.link || '(no link returned)'}`);
      published += 1;
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'wordpress', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'wordpress', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: WordPress publish failed - ${err.message}`);
      continue;
    }
  }
  console.log(`[done] publish-due complete - ${published} post(s) published.`);
}

// Native scheduling: create every approved future entry NOW with status 'future'
// + date_gmt, so wp-cron publishes it with this machine off. The post id is
// minted at schedule time and survives the future->publish transition, so
// verify/release/delete all address the same object. A past-due entry publishes
// immediately instead (the old publish-due behavior - never strand a late
// approval); there is no minimum lead (any future date_gmt is accepted).
async function cmdSchedule(args) {
  const { abs, plan } = loadPlan(args.plan);
  if (!siteUrl()) throw new Error('WORDPRESS_SITE_URL is not set - cannot schedule.');
  const now = Date.now();
  let scheduled = 0;
  let published = 0;

  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isWordpress(post)) continue;
    if (post.executionMode !== 'fully-scheduled') continue;
    if (post.status !== 'planned') continue;
    if ((post.approval || 'draft') !== 'approved') {
      console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish.`);
      continue;
    }
    if (post.wordpressPostId) { console.log(`[skip] ${post.id}: already has wordpressPostId ${post.wordpressPostId}.`); continue; }
    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs)) { console.log(`[warn] ${post.id}: unparseable scheduledAt "${post.scheduledAt}" - skipping.`); continue; }

    const content = publishableContent(plan, post);
    if (!content) continue;
    const { title, md, featuredPath } = content;
    const pastDue = dueMs <= now;

    if (args['dry-run']) {
      console.log(pastDue
        ? `[dry] ${post.id}: past due - would publish "${title}" immediately.`
        : `[dry] ${post.id}: would natively schedule "${title}" (status 'future', date_gmt ${new Date(dueMs).toISOString()}${featuredPath ? `, featured image ${path.basename(featuredPath)}` : ''}).`);
      continue;
    }

    console.log(pastDue
      ? `[info] ${post.id}: past due - publishing "${title}" to ${siteHost()} immediately...`
      : `[info] ${post.id}: natively scheduling "${title}" on ${siteHost()} for ${new Date(dueMs).toISOString()}...`);
    try {
      const payload = await buildPayload(post, content);
      if (pastDue) {
        payload.status = 'publish';
      } else {
        payload.status = 'future';
        // date_gmt (not date): unambiguous UTC, independent of the site timezone.
        // WP's REST date format takes no milliseconds/zone suffix.
        payload.date_gmt = new Date(dueMs).toISOString().slice(0, 19);
      }
      const resp = await wp('POST', '/posts', { body: payload });
      if (!resp?.id) throw new Error(`create returned no id: ${JSON.stringify(resp).slice(0, 200)}`);

      post.wordpressPostId = String(resp.id);
      if (pastDue) {
        post.status = 'posted';
        post.postedAt = new Date(now).toISOString();
        appendAttempt(post, { ts: new Date().toISOString(), platform: 'wordpress', action: 'publish', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
        await savePlan(abs, plan, [post.id]);
        RUN.results.push({ postId: post.id, platform: 'wordpress', action: 'publish', ok: true, id: String(resp.id) });
        console.log(`[ok] ${post.id}: published on WordPress (post ${resp.id}) - ${resp.link || '(no link returned)'}`);
        published += 1;
      } else {
        post.status = 'scheduled';
        appendAttempt(post, { ts: new Date().toISOString(), platform: 'wordpress', action: 'schedule-native', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
        await savePlan(abs, plan, [post.id]);
        RUN.results.push({ postId: post.id, platform: 'wordpress', action: 'schedule-native', ok: true, id: String(resp.id) });
        console.log(`[ok] ${post.id}: natively scheduled (post ${resp.id}, status=${resp.status}, publishes ${resp.date_gmt || payload.date_gmt} UTC).`);
        scheduled += 1;
      }
    } catch (err) {
      const action = pastDue ? 'publish' : 'schedule-native';
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'wordpress', action, ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'wordpress', action, ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: WordPress ${pastDue ? 'publish' : 'schedule'} failed - ${err.message}`);
    }
  }
  console.log(`[done] schedule complete - ${scheduled} natively scheduled, ${published} published (past due).`);
}

// Recover a natively-scheduled post wp-cron left 'future' past its date (verify
// read-back 'future-overdue' - the low-traffic-site failure mode, since wp-cron
// only runs on page hits): flip it live with a one-field status update - NEVER a
// re-create. Idempotent and safe on a bare CLI run: an already-published post is
// a no-op, a still-future schedule is left untouched (the exact yt release model).
async function cmdRelease(args) {
  const { abs, plan } = loadPlan(args.plan);
  const now = Date.now();
  for (const post of (plan.posts || []).filter(isWordpress)) {
    if (args.only && post.id !== args.only) continue;
    if (!post.wordpressPostId) continue;
    try {
      const resp = await wp('GET', `/posts/${encodeURIComponent(post.wordpressPostId)}?context=edit`);
      if (resp?.status === 'publish') {
        RUN.results.push({ postId: post.id, platform: 'wordpress', action: 'release', ok: true, id: post.wordpressPostId, live: true, state: 'published', permalink: resp.link || null });
        console.log(`[ok] ${post.id}: already published - no action.`);
        continue;
      }
      if (resp?.status !== 'future') {
        RUN.results.push({ postId: post.id, platform: 'wordpress', action: 'release', ok: false, errorCode: 'invalid_input', errorMessage: `post ${post.wordpressPostId} is '${resp?.status}' - release only flips a 'future' post` });
        console.log(`[skip] ${post.id}: post is '${resp?.status}' - nothing to release.`);
        continue;
      }
      const fireMs = Date.parse(`${resp.date_gmt}Z`);
      if (Number.isFinite(fireMs) && fireMs > now) {
        RUN.results.push({ postId: post.id, platform: 'wordpress', action: 'release', ok: false, errorCode: 'invalid_input', errorMessage: `still natively scheduled for ${resp.date_gmt} UTC - not releasing early` });
        console.log(`[skip] ${post.id}: still scheduled (${resp.date_gmt} UTC) - not releasing early.`);
        continue;
      }
      const updated = await wp('POST', `/posts/${encodeURIComponent(post.wordpressPostId)}`, { body: { status: 'publish' } });
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'wordpress', action: 'release', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'wordpress', action: 'release', ok: true, id: post.wordpressPostId, live: true, state: 'published', permalink: updated?.link || null });
      console.log(`[ok] ${post.id}: released - post ${post.wordpressPostId} is now published.`);
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'wordpress', action: 'release', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'wordpress', action: 'release', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: release failed - ${err.message}`);
    }
  }
  console.log('[done] release complete.');
}

async function cmdStatus(args) {
  const { plan } = loadPlan(args.plan);
  console.log('[info] WordPress plan entries:');
  for (const post of (plan.posts || []).filter(isWordpress)) {
    console.log(`  ${post.id.padEnd(18)} ${String(post.status).padEnd(10)} ${post.scheduledAt}  mode=${post.executionMode}${post.wordpressPostId ? ` wp=${post.wordpressPostId}` : ''}`);
  }
}

// Real read-back liveness: GET /posts/<id> returns the current status + the
// public permalink; a 404 (deleted/trashed with force) reads as missing. A
// natively-scheduled post reads 'scheduled' while its date is still ahead and
// 'future-overdue' once wp-cron has missed it (which owes the scheduler's
// wordpress-release lane, mirroring yt's private-overdue).
async function cmdVerify(args) {
  const { plan } = loadPlan(args.plan);
  const now = Date.now();
  for (const post of (plan.posts || []).filter(isWordpress)) {
    if (args.only && post.id !== args.only) continue;
    if (!post.wordpressPostId) continue;
    try {
      const resp = await wp('GET', `/posts/${encodeURIComponent(post.wordpressPostId)}?context=edit`);
      const live = resp?.status === 'publish';
      let state = live ? 'published' : String(resp?.status || 'unknown');
      if (resp?.status === 'future') {
        const fireMs = Date.parse(`${resp.date_gmt}Z`);
        state = Number.isFinite(fireMs) && fireMs <= now ? 'future-overdue' : 'scheduled';
      }
      RUN.results.push({ postId: post.id, platform: 'wordpress', action: 'verify', ok: true, live, state, permalink: live ? (resp?.link || null) : null, id: post.wordpressPostId });
    } catch (err) {
      if (err.status === 404) {
        RUN.results.push({ postId: post.id, platform: 'wordpress', action: 'verify', ok: true, live: false, state: 'missing', permalink: null, id: post.wordpressPostId });
      } else {
        RUN.results.push({ postId: post.id, platform: 'wordpress', action: 'verify', ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 200), id: post.wordpressPostId });
      }
    }
  }
}

// Core WordPress has no view/engagement counters (that is a plugin concern,
// e.g. Jetpack Stats) - honest no-op.
async function cmdInsights(args) {
  const { plan } = loadPlan(args.plan);
  void plan;
  console.log('[info] WordPress core exposes no post metrics - insights is a no-op.');
}

async function cmdDelete(args) {
  if (!args.id) { console.error('[err] delete requires --id <postId>'); process.exit(2); }
  await wp('DELETE', `/posts/${encodeURIComponent(String(args.id))}?force=true`);
  RUN.results.push({ platform: 'wordpress', action: 'delete', ok: true, id: String(args.id) });
  console.log(`[ok] deleted WordPress post ${args.id} (permanently - force=true).`);
}

async function cmdProbe() {
  if (!readEnv('WORDPRESS_APP_PASSWORD')) {
    RUN.results.push({ platform: 'wordpress', action: 'probe', ok: false, detail: 'not configured (WORDPRESS_APP_PASSWORD missing)' });
    return;
  }
  try {
    const me = await wp('GET', '/users/me?context=edit');
    RUN.results.push({ platform: 'wordpress', action: 'probe', ok: true, detail: `connected as ${me.name} on ${siteHost()}`, tokenExpiresAt: null });
  } catch (err) {
    RUN.results.push({ platform: 'wordpress', action: 'probe', ok: false, detail: String(err.message || err).slice(0, 200) });
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
  if (resolveMode('wordpress') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'wordpress', command: commandName,
      planPath: typeof args.plan === 'string' ? path.resolve(String(args.plan)) : null,
      only: typeof args.only === 'string' ? args.only : null,
    });
    if (JSON_MODE) process.stdout.write(`${JSON.stringify(envelope)}\n`);
    else console.error(`[mock] wordpress ${commandName}: ${envelope.results.length} result(s)`);
    return;
  }
  const cmd = COMMANDS[commandName];
  if (!cmd) {
    console.error(`Usage: node scripts/wordpress-social.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
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
