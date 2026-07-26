#!/usr/bin/env node
/**
 * reddit-social.mjs - direct Reddit submission via the OAuth2 API.
 *
 * Sibling of scripts/telegram-social.mjs / discord-social.mjs: the same zero-dep,
 * plan-driven, publish-straight-from-the-local-render pattern, with Reddit's own
 * (script-app, password-grant) auth + posting model.
 *
 * Reddit, like Telegram, is a STATIC-credential lane: there is NO browser OAuth
 * dance and NO long-lived refresh token to persist. A short-lived bearer token is
 * minted on demand per run from a "script" app's client id/secret + the bot
 * account's username/password (OAuth2 password grant), used, and thrown away.
 * `connect`/`auth` therefore only VALIDATES the static creds - it writes nothing.
 *
 * Reddit has NO scheduling API, so entries publish at their due time by re-running
 * `publish-due` (driven by the scheduler tick), exactly like Telegram / Discord.
 *
 * HONESTY / RISK (surfaced as a 'beta' flag + in the playbook):
 *   - Reddit's FREE data API is licensed for NON-COMMERCIAL use only. A commercial
 *     auto-posting workload may require a paid/commercial agreement with Reddit.
 *   - Automated submitting is COMMUNITY-NORM sensitive: most subreddits dislike or
 *     ban bot/cross-posted content, many enforce rate limits, karma/age gates, and
 *     per-subreddit rules. Always post only where you have permission, sparingly,
 *     and to a subreddit whose rules allow it (REDDIT_SUBREDDIT, e.g. "test").
 *   - Reddit BANS default/blank User-Agents - every request sends a descriptive UA.
 *
 * AUTH - a "script" app (https://www.reddit.com/prefs/apps), no browser:
 *   REDDIT_CLIENT_ID      the script app's client id (under the app name).
 *   REDDIT_CLIENT_SECRET  the script app's secret.
 *   REDDIT_USERNAME       the bot account's username (no leading u/).
 *   REDDIT_PASSWORD       the bot account's password.
 *   REDDIT_SUBREDDIT      the destination subreddit identifier (non-secret), e.g.
 *                         "test". The account must be allowed to submit there.
 *
 * Text comes from post.redditText (falls back to post.caption); the title from
 * post.title (falls back to the first non-empty line of the caption) - the
 * additive per-platform override pattern x uses for xCaption.
 *
 * Commands:
 *   auth | connect   mint a token + GET /api/v1/me; report the username; writes nothing
 *   refresh          no-op (token is minted per run, never persisted) - sibling parity
 *   validate         --plan <p> [--only <id>]   side-effect-free preview, never posts
 *   publish-due      --plan <p> [--only <id>] [--dry-run]   publish any due Reddit entry
 *                    (spec 16: link / self / image / native-video kinds + post flair)
 *   flairs           [--subreddit <sr>]         read-only, live-only link-flair templates
 *   status           --plan <p>                 list Reddit plan entries
 *   verify           --plan <p> [--only <id>]   read-only liveness (best-effort)
 *   insights         --plan <p> [--only <id>]   minimal honest metrics (score/comments)
 *   probe                                        read-only health probe (token + /me)
 *   delete           --id <fullname>             delete a submission (t3_...) cleanup
 *   presubmit        --plan <p> [--only <id>]   read-only subreddit rules check (spec 09)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand } from '../lib/mode.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
import { isPollPost, pollOptions, pollDurationMinutes, pollBlocker, pollBlockRow, POLL_LANE_LIMITS } from '../lib/poll.mjs';
import { isCarouselPost, carouselItems, carouselBlocker, carouselBlockRow, carouselUnsupported } from '../lib/carousel.mjs';
import { envPath } from '../lib/util.mjs';
import { laneReadiness } from '../lib/lane-readiness.mjs';
import { classifySubRules } from '../lib/reddit-norms.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = envPath();

// Reddit caps: a self-post title at 300 chars, a self-post body at 40000.
const TITLE_LIMIT = 300;
const TEXT_LIMIT = 40000;

// ---------- env helpers (same shape as the sibling engines) ----------

function readEnvRaw() {
  return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
}
function readEnv(name) {
  const m = readEnvRaw().match(new RegExp(`^${name}=(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

const subreddit = () => readEnv('REDDIT_SUBREDDIT');

// Reddit BANS default/blank User-Agents - send a descriptive UA on EVERY request.
function userAgent() {
  const u = readEnv('REDDIT_USERNAME') || 'unknown';
  return `pendpost/1.0 (by /u/${u})`;
}

// ---------- OAuth2 (password grant, minted on demand, never persisted) ----------

async function mintToken() {
  const clientId = readEnv('REDDIT_CLIENT_ID');
  const clientSecret = readEnv('REDDIT_CLIENT_SECRET');
  const username = readEnv('REDDIT_USERNAME');
  const password = readEnv('REDDIT_PASSWORD');
  const missing = [];
  if (!clientId) missing.push('REDDIT_CLIENT_ID');
  if (!clientSecret) missing.push('REDDIT_CLIENT_SECRET');
  if (!username) missing.push('REDDIT_USERNAME');
  if (!password) missing.push('REDDIT_PASSWORD');
  if (missing.length) throw new Error(`Reddit credentials missing in .env: ${missing.join(', ')}`);

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'password', username, password }).toString();
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent(),
    },
    body,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok || !data.access_token) {
    // Never echo the password/secret - only Reddit's own error string.
    throw new Error(`Reddit token mint failed: HTTP ${res.status} - ${data.error || data.message || data.raw || 'unknown'}`);
  }
  return data.access_token;
}

// Authenticated call against the oauth.reddit.com host.
async function reddit(token, method, pathname, { body, form } = {}) {
  const url = `https://oauth.reddit.com${pathname}`;
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': userAgent() };
  let init = { method, headers };
  if (form) {
    init.body = new URLSearchParams(form).toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`Reddit ${method} ${pathname}: HTTP ${res.status} - ${data.message || data.raw || text || 'unknown'}`);
  }
  return data;
}

// ---------- plan helpers (same shape as the sibling engines) ----------

function loadPlan(planPath) {
  const abs = path.resolve(planPath);
  return { abs, plan: JSON.parse(fs.readFileSync(abs, 'utf8')) };
}

const ENGINE_OWNED_FIELDS = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'xPostId', 'tgMessageId', 'dcMessageId', 'redditPostId', 'redditPermalink', 'redditSubmitted', 'status', 'postedAt', 'attempts', 'radarReplyState', 'radarFollowup'];

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

export const RUN = { results: [] };
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

const isReddit = (post) => (post.platforms || []).includes('reddit');
const bodyText = (post) => (post.redditText || post.caption || '').trim();

// Title: explicit per-platform/post title, else the first non-empty caption line.
function titleFor(post) {
  if (post.title && String(post.title).trim()) return String(post.title).trim().slice(0, TITLE_LIMIT);
  const firstLine = (post.caption || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return firstLine.slice(0, TITLE_LIMIT);
}

// A public/external media URL turns the submission into a `link` post; otherwise
// it is a `self` (text) post. Spec 16: the operator-authored `redditUrl` is the
// canonical link field (the older externalUrl/url/link are legacy fallbacks).
function externalUrl(post) {
  const u = post.redditUrl || post.externalUrl || post.url || post.link || '';
  return typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : null;
}

// Spec 16: pick the Reddit submission kind by (post.type, media, redditUrl). Poll and
// carousel are handled by their own blocks before this is reached, but they are named
// here so the mock-driver can share ONE kind rule with the live engine. image/video are
// the new P3 upload kinds; a type=text post is `link` when it carries a redditUrl, else
// a `self` (text) post. Pure - no I/O (the callers already resolved `ext`).
export function redditSubmitKind(post, ext = externalUrl(post)) {
  if (isPollPost(post)) return 'poll';
  if (isCarouselPost(post)) return 'gallery';
  if (post.type === 'image') return 'image';
  if (post.type === 'video') return 'video';
  return ext ? 'link' : 'self';
}

// Spec 16: the flair form fields a submit carries. flair_id always rides when the
// operator picked a template; flair_text only when the (editable) template's text is
// set - Reddit ignores flair_text on a non-editable template, so an empty value is
// simply omitted. Returns a plain object merged into the /api/submit form.
function flairFields(post) {
  const out = {};
  const id = typeof post.redditFlairId === 'string' ? post.redditFlairId.trim() : '';
  const text = typeof post.redditFlairText === 'string' ? post.redditFlairText.trim() : '';
  if (id) out.flair_id = id;
  if (text) out.flair_text = text;
  return out;
}

// Spec 16: normalize a subreddit's raw link_flair_v2 array into the Composer's picker
// shape ({ id, text, editable, cssClass }). Defensive: a non-array (a failed/odd read)
// yields [] so a caller never throws - the lib face treats a failed READ as ok:false
// (never a false-empty { ok:true, items:[] }), so [] here only ever means "no templates".
export function normalizeFlairs(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((f) => (f && typeof f === 'object'
      ? { id: String(f.id || ''), text: String(f.text || ''), editable: Boolean(f.text_editable), cssClass: String(f.css_class || '') }
      : null))
    .filter((f) => f && f.id);
}

// Minimal XML entity decode for the S3 <Location> the media upload returns (only the
// five predefined entities ever appear in an S3 key/URL). Node built-ins only.
function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// Spec 16 (Pattern P3, the tricky part): register a media asset, upload the bytes to
// S3, and return the resulting media URL used by /api/submit. THREE steps, node
// built-ins only (no new dep, §H.4):
//   1. POST /api/media/asset.json { filepath, mimetype } -> { args:{ action, fields[] },
//      asset:{ asset_id, websocket_url } } (a short-lived S3 lease).
//   2. multipart/form-data POST of the returned fields[] + the file bytes to the S3
//      action URL. The body is assembled BY HAND (a Buffer of the boundary parts + the
//      raw bytes) because the file part carries binary that a URLSearchParams/JSON body
//      would corrupt - the file MUST be the LAST part (an S3 POST-policy requirement).
//   3. the caller submits with the returned url (+ video_poster_url for a video).
async function leaseAndUpload(token, absPath, mimetype) {
  const filename = path.basename(absPath);
  const lease = await reddit(token, 'POST', '/api/media/asset.json', { form: { filepath: filename, mimetype } });
  const action = lease?.args?.action;
  const fields = Array.isArray(lease?.args?.fields) ? lease.args.fields : [];
  if (!action || !fields.length) {
    throw new Error(`media lease returned no action/fields: ${JSON.stringify(lease).slice(0, 200)}`);
  }
  // The action URL is often protocol-relative (//reddit-uploaded-media.s3.amazonaws.com).
  const actionUrl = /^https?:\/\//i.test(action) ? action : `https:${action}`;
  const bytes = fs.readFileSync(absPath);
  const boundary = `----pendpost${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const enc = (s) => Buffer.from(s, 'utf8');
  const parts = [];
  for (const f of fields) {
    if (!f || f.name === undefined) continue;
    parts.push(enc(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value ?? ''}\r\n`));
  }
  // The file part is LAST (S3 requires the `file` field after every policy field).
  parts.push(enc(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimetype}\r\n\r\n`));
  parts.push(bytes);
  parts.push(enc(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  const res = await fetch(actionUrl, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'User-Agent': userAgent() },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`media upload failed: HTTP ${res.status} - ${String(text).slice(0, 200)}`);
  // S3 returns XML with <Location> (the final URL); fall back to action + the `key` field.
  const loc = text.match(/<Location>([^<]+)<\/Location>/i);
  const keyField = fields.find((f) => f && f.name === 'key');
  const url = loc ? decodeXmlEntities(loc[1]) : (keyField ? `${actionUrl.replace(/\/+$/, '')}/${keyField.value}` : null);
  if (!url) throw new Error(`media upload returned no Location/key: ${String(text).slice(0, 160)}`);
  return { url, assetId: lease?.asset?.asset_id || null };
}

// Reddit fullnames look like t3_abc; bare ids are the part after the underscore.
function bareId(name) {
  if (!name) return null;
  const s = String(name);
  return s.includes('_') ? s.split('_').pop() : s;
}

function permalinkFor(post) {
  if (!post.redditPostId) return null;
  if (post.redditPermalink) return `https://www.reddit.com${post.redditPermalink}`;
  const id = bareId(post.redditPostId);
  return id ? `https://redd.it/${id}` : null;
}

// Spec 16 review [NIT]: map a render's extension to its real image mimetype so the S3
// media lease isn't handed a .webp/.gif declared as image/png (which the lease may
// reject). Video renders are always mp4; anything unknown keeps a sane png default.
function mimeForRender(absPath, kind) {
  if (kind === 'video') return 'video/mp4';
  const ext = path.extname(String(absPath || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

// Spec 16 review [BLOCKER - duplicate live posts]: an image/video /api/submit returns
// json.data = { user_submitted_page, websocket_url } with NO post id - the post IS
// created, but its t3_ id only arrives over a websocket (native WebSocket is absent on
// Node 20 and we add no dep, §H.4). This detects that success-but-no-id ack shape so the
// publish path resolves the id out-of-band instead of throwing "no id" - which would
// falsely record a failure and re-lease/re-upload/re-submit a DUPLICATE live post every
// scheduler tick (the account-ban spam pattern the engine header warns about).
// E1: 'gallery' rides this predicate for the SAME reason image/video do. A gallery
// submit can succeed with no post id (the id only arrives over a websocket). Without
// this, the engine would throw "submit returned no id" for an album that is ALREADY
// LIVE, record a failure, and re-lease, re-upload and re-submit the whole gallery every
// sweep: duplicate live posts, the exact ban pattern this file's header warns about.
function isMediaSubmitAck(data) {
  const d = data?.json?.data?.post || data?.json?.data || {};
  return Boolean(d.websocket_url || d.user_submitted_page) && !d.name && !d.id;
}

// The submit kinds whose success can arrive WITHOUT an id, and which therefore must ride
// resolveMediaPostId + the sentinel rather than throwing.
const ID_LESS_ACK_KINDS = new Set(['image', 'video', 'gallery']);

// The anti-duplicate sentinel: a media submit that SUCCEEDED but whose id we could not
// resolve still stamps a non-null redditPostId so lanesOwed / eligibility / deriveState
// never re-owe the reddit lane (every one of those keys purely on `redditPostId` being
// truthy). Re-submitting a succeeded post = a new duplicate live post per tick, so the
// unknown id is strictly better than a re-fire. verify/insights degrade honestly on it.
const REDDIT_SUBMITTED_SENTINEL = 't3_pendpost_submitted';
const isSentinelReddit = (id) => id === REDDIT_SUBMITTED_SENTINEL;

// Poll knobs for the submitted-listing resolve (env-overridable so tests run fast).
function mediaPollTries() { const n = Number(process.env.REDDIT_MEDIA_POLL_TRIES); return Number.isFinite(n) && n > 0 ? n : 5; }
function mediaPollDelayMs() { const n = Number(process.env.REDDIT_MEDIA_POLL_DELAY_MS); return Number.isFinite(n) && n >= 0 ? n : 1500; }

// Resolve a just-created media post's real fullname by POLLING the account's own recent
// submissions and matching the just-submitted post by title (+ subreddit). A bounded
// GET-poll (no websocket), node built-ins only, so it works identically on Node 20 AND
// 22. Returns { name, permalink } on a match, else null (the caller then sentinels).
async function resolveMediaPostId(token, me, { title, sr }) {
  const wantTitle = String(title || '').trim();
  const wantSr = String(sr || '').toLowerCase();
  for (let i = 0; i < mediaPollTries(); i++) {
    if (i) await new Promise((r) => setTimeout(r, mediaPollDelayMs()));
    let listing;
    try {
      listing = await reddit(token, 'GET', `/user/${encodeURIComponent(me)}/submitted?limit=10&sort=new`);
    } catch { continue; } // a transient listing read failure just costs a retry, never a throw
    for (const child of listing?.data?.children || []) {
      const p = child?.data;
      if (!p) continue;
      const sameTitle = String(p.title || '').trim() === wantTitle;
      const sameSr = !wantSr || String(p.subreddit || '').toLowerCase() === wantSr;
      if (sameTitle && sameSr) {
        const name = p.name || (p.id ? `t3_${bareId(p.id)}` : null);
        if (name) return { name: String(name), permalink: typeof p.permalink === 'string' ? p.permalink : null };
      }
    }
  }
  return null;
}

// ---------- spec 37: account warmth + the publish-tier judge ----------

// Map a /api/v1/me identity read into the warmth inputs the tier judge reads:
// account age (days), link + comment karma. created_utc is UNIX seconds. Every
// field degrades to null on a missing/odd value (the judge fail-closes to 'cold').
function computeWarmth(me) {
  if (!me || typeof me !== 'object') return null;
  const createdUtc = Number(me.created_utc);
  const linkKarma = Number(me.link_karma);
  const commentKarma = Number(me.comment_karma);
  const lkOk = Number.isFinite(linkKarma);
  const ckOk = Number.isFinite(commentKarma);
  return {
    ageDays: Number.isFinite(createdUtc) ? Math.floor((Date.now() - createdUtc * 1000) / 86400000) : null,
    linkKarma: lkOk ? linkKarma : null,
    commentKarma: ckOk ? commentKarma : null,
    karma: (lkOk && ckOk) ? linkKarma + commentKarma : null,
    checkedAt: new Date().toISOString(),
  };
}

// The tier-judge inputs for ONE post: warmth (per-account) + subRequirementsMet
// (per-sub, from the presubmit verdict) + isPromo (per-post; ABSENCE = promo). A null
// warmth passes undefined age/karma so laneReadiness fail-closes to 'cold'.
function readinessInputs(post, warmth, subRequirementsMet) {
  return {
    accountAgeDays: warmth ? warmth.ageDays : undefined,
    linkKarma: warmth ? warmth.linkKarma : undefined,
    commentKarma: warmth ? warmth.commentKarma : undefined,
    subRequirementsMet,
    isPromo: post.isPromo,
  };
}

// Fetch the account warmth ONCE (a single /api/v1/me), returning null on any failure
// (the judge fail-closes). Callers cache the promise per run so it never re-fires.
async function fetchWarmth(token) {
  try { return computeWarmth(await reddit(token, 'GET', '/api/v1/me')); }
  catch { return null; }
}

// NOTE (spec 37, review fix #1): warmth is NEVER persisted from this engine subprocess.
// The long-lived server caches state.json per root (lib/state.mjs) and atomically rewrites
// it from that cache every scheduler tick, which would CLOBBER a subprocess-written
// reddit.warmth key (the app would fail-closed to cold while the engine reads live warmth
// and auto-fires -> a duplicate-post window). Instead the engine RETURNS warmth in its
// discover/presubmit result and the SERVER persists it IN-PROCESS (lib/writes.mjs
// connectDiscover + presubmitCheck -> lib/state.mjs persistRedditWarmth), where the cache
// respects it. So this engine only COMPUTES warmth; it never writes state.json.

// The subreddit's PROSE rules (spec: reddit norms). Separate from fetchSubRules' try block on
// purpose - these rules are advisory, so a failure here returns [] (the classifier then emits
// no warnings) instead of costing the caller its blocking post_requirements check.
async function fetchSubProse(token, sr) {
  try {
    const res = await reddit(token, 'GET', `/r/${sr}/about/rules`);
    return Array.isArray(res?.rules) ? res.rules : [];
  } catch {
    return [];
  }
}

// Fetch + cache a subreddit's post_requirements + /about ONCE per run (shared by
// presubmit AND the fire-time tier re-check). Returns { rules } | { error }. Node
// built-ins only; a rules-endpoint failure is a structured { error }, never a throw.
async function fetchSubRules(token, sr, cache) {
  if (cache.has(sr)) return cache.get(sr);
  let info;
  try {
    const requirements = await reddit(token, 'GET', `/api/v1/${sr}/post_requirements`);
    const aboutRes = await reddit(token, 'GET', `/r/${sr}/about`);
    const about = aboutRes?.data || {};
    info = {
      rules: {
        flairRequired: Boolean(requirements.is_flair_required),
        titleRequiredStrings: Array.isArray(requirements.title_required_strings) ? requirements.title_required_strings.filter(Boolean) : [],
        titleRegexes: Array.isArray(requirements.title_regexes) ? requirements.title_regexes.filter(Boolean) : [],
        titleMax: Number.isFinite(requirements.title_text_max_length) && requirements.title_text_max_length > 0 ? requirements.title_text_max_length : null,
        titleMin: Number.isFinite(requirements.title_text_min_length) && requirements.title_text_min_length > 0 ? requirements.title_text_min_length : null,
        subredditType: String(about.subreddit_type || '').toLowerCase(),
        submissionType: String(about.submission_type || 'any').toLowerCase(),
        // E1: many subreddits disallow galleries, so catch it BEFORE approval rather than
        // at submit. Tri-state on purpose: only an EXPLICIT false blocks. An absent or
        // non-boolean value stays null and fails OPEN, because a bad presubmit read must
        // never block a lawful post.
        allowGalleries: typeof requirements.allow_galleries === 'boolean' ? requirements.allow_galleries : null,
      },
      // The PROSE rules (/r/<sub>/about/rules) + the "read before posting" sticky, for the
      // norm classifier. Strictly ADDITIVE advisory signal, so its own failure must never
      // cost us the machine-readable gates above: a failed read degrades to an empty list
      // INSIDE this try, never to the { error } that omits the whole lane from the panel.
      // submit_text rides the /about response already fetched, so this is one extra call.
      norms: { prose: await fetchSubProse(token, sr), submitText: String(about.submit_text || '') },
    };
  } catch (err) {
    info = { error: String(err.message || err).slice(0, 200) };
  }
  cache.set(sr, info);
  return info;
}

// Pure: evaluate a post's blocking problems against a sub's rules (spec 36). Shared by
// cmdPresubmit (advisory panel) AND the spec-37 fire-time tier re-check
// (subRequirementsMet := no problems). No I/O.
function evaluateSubProblems(post, rules, title) {
  const { flairRequired, titleRequiredStrings, titleRegexes, titleMax, titleMin, subredditType, submissionType, allowGalleries } = rules;
  const problems = [];
  // Check against the REAL submit kind cmdPublishDue would use (link/self/image/video/
  // poll/gallery), not a stale link-or-self guess. submission_type gates a LINK-vs-SELF
  // class: media + links are link-class; self + poll are self-class.
  const kind = redditSubmitKind(post);
  const submitClass = (kind === 'self' || kind === 'poll') ? 'self' : 'link';
  // Spec 36: flair-required is a BLOCKING problem - a flairless post auto-removes.
  if (flairRequired && !post.redditFlairId) problems.push({ code: 'flairRequired', text: '' });
  if (titleMax && title.length > titleMax) problems.push({ code: 'titleRule', text: `over ${titleMax} chars` });
  if (titleMin && title.length < titleMin) problems.push({ code: 'titleRule', text: `under ${titleMin} chars` });
  if (titleRequiredStrings.length && !titleRequiredStrings.some((s) => title.toLowerCase().includes(String(s).toLowerCase()))) {
    problems.push({ code: 'titleRule', text: `must include one of: ${titleRequiredStrings.join(', ')}` });
  }
  for (const re of titleRegexes) {
    let matches = true;
    try { matches = new RegExp(re).test(title); } catch { matches = true; } // a malformed API pattern is never our block
    if (!matches) problems.push({ code: 'titleRule', text: `must match pattern ${re}` });
  }
  // E1: only an explicit false blocks - null/undefined fails open (see fetchSubRules).
  if (kind === 'gallery' && allowGalleries === false) problems.push({ code: 'galleryNotAllowed', text: '' });
  if (subredditType === 'restricted' || subredditType === 'private') problems.push({ code: 'restricted', text: subredditType });
  if (submissionType !== 'any' && submissionType !== submitClass) problems.push({ code: 'submissionType', text: submissionType });
  return problems;
}

// ---------- commands ----------

async function cmdAuth() {
  const token = await mintToken();
  const me = await reddit(token, 'GET', '/api/v1/me');
  console.log(`[ok] Reddit credentials valid - authenticated as u/${me.name}.`);
  // Spec 37: RETURN the account warmth in the envelope so the SERVER can persist it
  // in-process on connect (never a subprocess state write - see the note above).
  RUN.warmth = computeWarmth(me);
  const sr = subreddit();
  if (!sr) console.log('[warn] REDDIT_SUBREDDIT is not set - publish-due will have no destination.');
  else console.log(`[ok] Destination subreddit: r/${sr}. Confirm the account may submit there and the subreddit allows bot posts.`);
  RUN.results.push({ platform: 'reddit', action: 'auth', ok: true, detail: `u/${me.name}${sr ? ` -> r/${sr}` : ''}` });
}

async function cmdRefresh() {
  console.log('[info] Reddit tokens are minted per run from the password grant (no persisted refresh token).');
}

async function cmdValidate(args) {
  const { plan } = loadPlan(args.plan);
  console.log('================ VALIDATION ONLY - NOTHING WILL BE PUBLISHED ================');
  let token = null;
  try {
    token = await mintToken();
    const me = await reddit(token, 'GET', '/api/v1/me');
    console.log(`[ok] Credentials valid - authenticated as u/${me.name}.`);
  } catch (err) {
    console.log(`[warn] auth check failed (${err.message}). Continuing to content preview.`);
  }
  const sr = subreddit();
  console.log(`[info] Destination subreddit: ${sr ? `r/${sr}` : '(REDDIT_SUBREDDIT not set)'}`);
  const targets = (plan.posts || []).filter((p) => isReddit(p) && (!args.only || p.id === args.only));
  if (!targets.length) { console.log('[warn] No Reddit entries match.'); return; }
  for (const post of targets) {
    const title = titleFor(post);
    const ext = externalUrl(post);
    const text = bodyText(post);
    // Spec 16: preview the real kind the publish would submit (link/self/image/video).
    // redditSubmitKind already resolves poll/gallery internally - no outer double-check.
    const kind = redditSubmitKind(post, ext);
    console.log(`\n----- ${post.id} -----`);
    console.log(`[preview] kind:    ${kind}`);
    console.log(`[preview] title (${title.length}/${TITLE_LIMIT}${title.length > TITLE_LIMIT ? ' - OVER LIMIT' : ''}): ${title || '(MISSING - required)'}`);
    if (kind === 'link') {
      console.log(`[preview] url:     ${ext}`);
    } else if (kind === 'gallery') {
      // E1: preview the album the gallery submit would assemble.
      const slides = carouselItems(post).map((it) => resolveMediaPath(plan, { file: it.file, path: it.path }));
      console.log(`[preview] slides:  ${slides.length} (${slides.filter(Boolean).length} resolve on disk)`);
      const gBlock = carouselBlocker(post, 'reddit', slides.map((x) => ({ exists: Boolean(x) }))) || carouselUnsupported(post, 'reddit');
      if (gBlock) console.log(`[note] this gallery would be refused: ${gBlock}`);
    } else if (kind === 'image' || kind === 'video') {
      const mediaPath = resolveMediaPath(plan, post);
      console.log(`[preview] media:   ${mediaPath ? path.basename(mediaPath) : '(MISSING - an image/video submission needs a local render)'}`);
      if (kind === 'video' && !(post.imageUrl || '').trim()) console.log('[note] a video submission needs a public cover image (imageUrl) as the poster.');
    } else if (kind === 'self') {
      console.log(`[preview] text (${text.length}/${TEXT_LIMIT}${text.length > TEXT_LIMIT ? ' - OVER LIMIT' : ''}):`);
      console.log(text);
    }
    if (post.redditFlairId) console.log(`[preview] flair:   ${post.redditFlairText || post.redditFlairId}`);
  }
  console.log('\n================ VALIDATION COMPLETE ================');
}

export async function cmdPublishDue(args) {
  const { abs, plan } = loadPlan(args.plan);
  // Spec 36: the target subreddit is resolved PER-POST inside the loop
  // (post.redditSubreddit > the connection default REDDIT_SUBREDDIT). The old
  // top-level throw when no global default exists is demoted to a per-post
  // warn+skip, so a post carrying its own subreddit still publishes.
  const now = Date.now();
  let published = 0;
  let token = null;

  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isReddit(post)) continue;
    if (post.executionMode !== 'fully-scheduled') continue;
    if (post.status !== 'planned') continue;
    if ((post.approval || 'draft') !== 'approved') {
      console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish.`);
      continue;
    }
    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs) || dueMs > now) continue;

    // Spec 34: a Radar reply-to-external post REPLIES to the signal's thing_id instead
    // of submitting a NEW post. It reached here only after a DISTINCT human approved it
    // (the approval gate above + no-self-approval + never-auto-approve). Fail-closed: a
    // gone/404 thread => radar_target_gone (never a stray new submission). Human-gated
    // (Responsible Builder) - only ever an approved operator draft reaches this.
    if (post.radarReplyTo) {
      const rr = post.radarReplyTo;
      // WRONG-TARGET guard (safety review #3b): fire ONLY when the reply's source is this
      // lane. A source<->platform mismatch (validateFieldValues rejects it at create) can
      // never fire a reddit reply to a non-reddit target.
      if (rr.source !== 'reddit') { RUN.results.push({ postId: post.id, platform: 'reddit', action: 'publish', ok: false, errorCode: 'invalid_input', errorMessage: `radarReplyTo.source '${rr.source}' does not match the reddit lane` }); continue; }
      const body = String(post.caption || '').trim();
      if (!body) { RUN.results.push({ postId: post.id, platform: 'reddit', action: 'publish', ok: false, errorCode: 'invalid_input', errorMessage: 'radar reply needs a caption' }); continue; }
      const { radarHttp } = await import('../lib/radar.mjs');
      try { token = token || await mintToken(); } catch (err) { RUN.results.push({ postId: post.id, platform: 'reddit', action: 'publish', ok: false, errorCode: 'needs_scope', errorMessage: String(err.message || err).slice(0, 200) }); continue; }
      const form = new URLSearchParams({ api_type: 'json', thing_id: String(rr.externalId), text: body });
      const { ok, status, json } = await radarHttp('https://oauth.reddit.com/api/comment', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': userAgent(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      const apiErrors = json?.json?.errors;
      if (!ok || (Array.isArray(apiErrors) && apiErrors.length)) {
        const gone = status === 404 || (Array.isArray(apiErrors) && apiErrors.some((e) => /DELETED|NOT_FOUND|TOO_OLD|THREAD_LOCKED/i.test(String(e))));
        const code = gone ? 'radar_target_gone' : (status === 401 || status === 403 ? 'needs_scope' : 'engine_failure');
        // TERMINAL target-gone (safety review #5): mark radarReplyState so lanesOwed stops
        // owing this lane - the post never re-fires (no more hammering the dead thread).
        if (gone) { post.radarReplyState = 'target_gone'; await savePlan(abs, plan, [post.id]); }
        RUN.results.push({ postId: post.id, platform: 'reddit', action: 'publish', ok: false, errorCode: code, errorMessage: `reddit reply HTTP ${status}${apiErrors ? ` ${JSON.stringify(apiErrors).slice(0, 120)}` : ''}` });
        continue;
      }
      post.redditPostId = String(json?.json?.data?.things?.[0]?.data?.name || `reply_${rr.externalId}`);
      post.status = 'posted';
      post.postedAt = new Date(now).toISOString();
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'reddit', action: 'publish', ok: true, id: post.redditPostId, radarReply: rr.externalId });
      published += 1;
      continue;
    }

    const title = titleFor(post);
    if (!title) { console.log(`[warn] ${post.id}: due but no title (post.title / first caption line) - skipping.`); continue; }
    if (title.length > TITLE_LIMIT) { console.log(`[warn] ${post.id}: title is ${title.length} chars (> ${TITLE_LIMIT}) - skipping.`); continue; }

    // Spec 36: resolve the destination subreddit for THIS post - the per-post
    // redditSubreddit (a leading r/ is stripped) falls back to the connection
    // default. No subreddit at all -> a per-post warn+skip (the demoted throw),
    // placed BEFORE any submit so no sub-less post ever reaches the API.
    const sr = (post.redditSubreddit || '').replace(/^\/?r\//, '').trim() || subreddit();
    if (!sr) { console.log(`[warn] ${post.id}: no subreddit (post.redditSubreddit / REDDIT_SUBREDDIT) - skipping.`); continue; }

    const ext = externalUrl(post);
    const text = bodyText(post);
    // Spec 10: a native poll post (2-6 options, 1-7 days). The QUESTION is the title;
    // the optional body is `text`. Fail-closed BEFORE any submit (the question is the
    // title, so validate against `title`, not the caption).
    const pollPost = isPollPost(post);
    if (pollPost) {
      const blocker = pollBlocker(post, title, POLL_LANE_LIMITS.reddit);
      if (blocker) {
        console.log(`[warn] ${post.id}: ${blocker} - skipping.`);
        RUN.results.push(pollBlockRow(post, 'reddit', blocker));
        continue;
      }
    }
    // Spec 05: a native gallery post - the QUESTION/title is the post title; the slides
    // are the gallery images. Fail-closed BEFORE any submit (count/cap + slides-on-disk).
    // The engine's media-lease layer (leaseAndUpload, spec 16) covers SINGLE assets only;
    // what is missing for galleries is the multi-slide submit path (per-slide lease
    // uploads + submit_gallery_post) - so a valid carousel emits a structured, honest
    // ok:false row (never a half-post) and the operator posts the gallery manually until
    // the gallery submit path lands (this lane is beta / mock-only, spec §3).
    const carouselPost = isCarouselPost(post);
    let galleryPaths = [];
    if (carouselPost) {
      galleryPaths = carouselItems(post).map((it) => resolveMediaPath(plan, { file: it.file, path: it.path }));
      const blocker = carouselBlocker(post, 'reddit', galleryPaths.map((p) => ({ exists: Boolean(p) })))
        || carouselUnsupported(post, 'reddit');
      if (blocker) {
        console.log(`[warn] ${post.id}: ${blocker} - skipping.`);
        RUN.results.push(carouselBlockRow(post, 'reddit', blocker));
        continue;
      }
    }
    // Spec 16: choose the submission kind by (post.type, media, redditUrl). Poll is
    // already handled above; the rest are link / self / image / video.
    const kind = pollPost ? 'poll' : redditSubmitKind(post, ext);
    if (kind === 'self' && text.length > TEXT_LIMIT) { console.log(`[warn] ${post.id}: text is ${text.length} chars (> ${TEXT_LIMIT}) - skipping.`); continue; }

    // Spec 16 (P3): image/video need a local render, validated BEFORE any remote call.
    // Missing bytes degrade to a STRUCTURED ok:false skip row (never a text fallback,
    // never a crash) so Activity shows the honest reason.
    let mediaPath = null;
    if (kind === 'image' || kind === 'video') {
      mediaPath = resolveMediaPath(plan, post);
      if (!mediaPath) {
        console.log(`[warn] ${post.id}: ${kind} submission has no local render - skipping (never a text fallback).`);
        RUN.results.push({ postId: post.id, platform: 'reddit', action: 'publish', ok: false, errorCode: 'media_missing', errorMessage: `reddit ${kind} submission needs a local media render` });
        continue;
      }
    }
    // A native video also needs a PUBLIC cover (imageUrl) as its poster - degrade with a
    // warn + structured skip if absent (spec §4), never a bare text/self fallback.
    let posterUrl = null;
    if (kind === 'video') {
      posterUrl = (post.imageUrl || '').trim();
      if (!posterUrl) {
        console.log(`[warn] ${post.id}: reddit video needs a public cover image (imageUrl) as the poster - skipping.`);
        RUN.results.push({ postId: post.id, platform: 'reddit', action: 'publish', ok: false, errorCode: 'unsupported', errorMessage: 'reddit video submission needs a public cover image (imageUrl) as the poster' });
        continue;
      }
    }

    // The token is minted here for the submit below. In a dry-run a mint failure is not fatal -
    // a dry-run never submits, so we just report and skip.
    // Spec 37 (reversed 2026-07-13): there is NO fire-time tier re-check / manual defer. Every
    // approved + due reddit post auto-publishes (owner: warn-and-allow, promo included). The
    // account-warmth advisories are display-only and already shown to the human at approval time
    // via the presubmit report; a genuinely unmet subreddit requirement that Reddit rejects
    // surfaces as an ordinary publish failure below (no account-standing harm from one removal).
    if (!token) {
      try { token = await mintToken(); }
      catch (err) {
        if (args['dry-run']) { console.log(`[dry] ${post.id}: cannot mint a token (${err.message}).`); continue; }
        throw new Error(`cannot mint Reddit token: ${err.message}`);
      }
    }

    if (args['dry-run']) {
      if (pollPost) console.log(`[dry] ${post.id}: would submit a poll post (${pollOptions(post).length} options) to r/${sr}.`);
      else if (kind === 'gallery') console.log(`[dry] ${post.id}: would upload ${galleryPaths.length} slides and submit ONE gallery to r/${sr}.`);
      else console.log(`[dry] ${post.id}: would submit a ${kind} post to r/${sr}${ext ? ` -> ${ext}` : ''}.`);
      continue;
    }

    console.log(`[info] ${post.id}: submitting ${kind} post to r/${sr}...`);
    try {
      let data;
      if (pollPost) {
        // /api/submit_poll_post takes a JSON body: options 2-6, duration in DAYS 1-7.
        const durationDays = Math.max(1, Math.min(7, Math.round(pollDurationMinutes(post) / 1440) || 1));
        data = await reddit(token, 'POST', '/api/submit_poll_post', { body: { sr, title, text, options: pollOptions(post), duration: durationDays } });
      } else if (kind === 'gallery') {
        // E1: POST /api/submit_gallery_post.json with a JSON body (the submit_poll_post
        // precedent), NOT /api/submit with kind=gallery. items[].media_id is the LEASE's
        // asset_id, never the S3 url.
        //
        // Uploads are SEQUENTIAL, never parallel: the OAuth budget is 60 requests per
        // minute and a 20-slide album would blow it. A 429 throws here, which means no
        // post is created and the next sweep retries cleanly.
        //
        // Deliberately NO outbound_url per slide: that field is spec 39's public mirror,
        // and using it as a click target would leak the CDN link.
        const items = [];
        for (const abs of galleryPaths) {
          const up = await leaseAndUpload(token, abs, mimeForRender(abs, 'image'));
          if (!up.assetId) throw new Error(`gallery slide ${path.basename(abs)} returned no asset_id - refusing to submit a partial album`);
          items.push({ media_id: up.assetId, caption: '' });
        }
        data = await reddit(token, 'POST', '/api/submit_gallery_post.json', {
          body: { sr, title, items, api_type: 'json', ...flairFields(post) },
        });
      } else if (kind === 'image' || kind === 'video') {
        // P3 upload sub-flow: lease an S3 slot, POST the bytes, submit with the media url.
        const mimetype = mimeForRender(mediaPath, kind);
        const upload = await leaseAndUpload(token, mediaPath, mimetype);
        const form = { api_type: 'json', sr, title, kind, url: upload.url, ...flairFields(post) };
        if (kind === 'video') form.video_poster_url = posterUrl;
        data = await reddit(token, 'POST', '/api/submit', { form });
      } else {
        const form = ext
          ? { api_type: 'json', sr, title, kind: 'link', url: ext, ...flairFields(post) }
          : { api_type: 'json', sr, title, kind: 'self', text, ...flairFields(post) };
        data = await reddit(token, 'POST', '/api/submit', { form });
      }
      const errs = data?.json?.errors;
      if (Array.isArray(errs) && errs.length) {
        throw new Error(`submit rejected: ${errs.map((e) => (Array.isArray(e) ? e.join(' ') : String(e))).join('; ').slice(0, 200)}`);
      }
      // submit_poll_post nests the created post under json.data.post; /api/submit
      // returns it directly under json.data. Fall back across both shapes.
      const d = data?.json?.data?.post || data?.json?.data || {};
      let name = d.name || (d.id ? `t3_${bareId(d.id)}` : null);
      let permalinkPath = typeof d.url === 'string' ? d.url.replace(/^https?:\/\/(www\.)?reddit\.com/i, '') : null;
      let idNote = null;

      // Spec 16 review [BLOCKER - anti-duplicate]: an image/video submit succeeds with NO
      // id (Reddit returns { user_submitted_page, websocket_url }; the id only arrives over
      // a websocket). The post EXISTS - the submit ALREADY succeeded, so we MUST NOT
      // re-submit. Resolve the real id by polling the account's own recent submissions; if
      // that can't find it after the bounded retries, stamp a sentinel id so the lane is
      // marked posted and NEVER re-owed (an unknown id beats a duplicate live post/tick).
      if (!name && ID_LESS_ACK_KINDS.has(kind) && isMediaSubmitAck(data)) {
        let me = null;
        try { me = (await reddit(token, 'GET', '/api/v1/me'))?.name || null; } catch { /* fall through to sentinel */ }
        const resolved = me ? await resolveMediaPostId(token, me, { title, sr }) : null;
        if (resolved) {
          name = resolved.name;
          if (resolved.permalink) permalinkPath = resolved.permalink;
          idNote = 'id resolved via submitted-listing poll (websocket id not awaited)';
        } else {
          name = REDDIT_SUBMITTED_SENTINEL;
          post.redditSubmitted = true;
          idNote = 'submit succeeded but id unresolved after poll - marked posted (sentinel) so the lane is never re-submitted';
          console.log(`[warn] ${post.id}: ${kind} submit succeeded but id unresolved - marking posted with a sentinel to prevent a duplicate re-submit.`);
        }
      }
      if (!name) throw new Error(`submit returned no id: ${JSON.stringify(data).slice(0, 200)}`);

      post.redditPostId = String(name);
      if (permalinkPath) post.redditPermalink = permalinkPath;
      post.status = 'posted';
      post.postedAt = new Date(now).toISOString();
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'reddit', action: 'publish', ok: true, errorCode: null, errorMessage: idNote, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'reddit', action: 'publish', ok: true, id: String(name), ...(idNote ? { note: idNote } : {}) });
      console.log(`[ok] ${post.id}: submitted to r/${sr} (${name}).`);
      published += 1;
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'reddit', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'reddit', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: Reddit submit failed - ${err.message}`);
      continue;
    }
  }
  console.log(`[done] publish-due complete - ${published} submission(s) published.`);
}

async function cmdStatus(args) {
  const { plan } = loadPlan(args.plan);
  console.log('[info] Reddit plan entries:');
  for (const post of (plan.posts || []).filter(isReddit)) {
    console.log(`  ${post.id.padEnd(18)} ${String(post.status).padEnd(10)} ${post.scheduledAt}  mode=${post.executionMode}${post.redditPostId ? ` reddit=${post.redditPostId}` : ''}`);
  }
}

// Best-effort liveness: GET /api/info?id=<fullname> and report whether the
// submission still exists + its public permalink.
async function cmdVerify(args) {
  const { plan } = loadPlan(args.plan);
  let token = null;
  try { token = await mintToken(); } catch { /* surfaced per row */ }
  for (const post of (plan.posts || []).filter(isReddit)) {
    if (args.only && post.id !== args.only) continue;
    if (!post.redditPostId) continue;
    // A media post whose id we couldn't resolve carries the sentinel (spec 16 review): the
    // post was submitted, but there is no real id to /api/info against - report it honestly
    // as 'pending' rather than querying a fake id and reading it back as 'removed'.
    if (isSentinelReddit(post.redditPostId)) {
      RUN.results.push({ postId: post.id, platform: 'reddit', action: 'verify', ok: true, live: false, state: 'pending', permalink: null, id: post.redditPostId });
      continue;
    }
    if (!token) {
      RUN.results.push({ postId: post.id, platform: 'reddit', action: 'verify', ok: true, live: false, state: 'unknown', permalink: permalinkFor(post), id: post.redditPostId });
      continue;
    }
    try {
      const data = await reddit(token, 'GET', `/api/info?id=${encodeURIComponent(post.redditPostId)}`);
      const child = data?.data?.children?.[0]?.data;
      const live = Boolean(child) && !child.removed && !child.removed_by_category;
      const permalink = child?.permalink ? `https://www.reddit.com${child.permalink}` : permalinkFor(post);
      RUN.results.push({ postId: post.id, platform: 'reddit', action: 'verify', ok: true, live, state: live ? 'submitted' : 'removed', permalink, id: post.redditPostId });
    } catch (err) {
      RUN.results.push({ postId: post.id, platform: 'reddit', action: 'verify', ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 200), id: post.redditPostId });
    }
  }
}

// Reddit exposes only coarse public counters to a bot - honest, minimal metrics
// (score + comment count) pulled from /api/info, never engagement breakdowns.
async function cmdInsights(args) {
  const { plan } = loadPlan(args.plan);
  let token = null;
  try { token = await mintToken(); } catch { console.log('[info] Reddit insights: could not authenticate - skipping.'); return; }
  for (const post of (plan.posts || []).filter(isReddit)) {
    if (args.only && post.id !== args.only) continue;
    if (!post.redditPostId) continue;
    if (isSentinelReddit(post.redditPostId)) continue; // no real id to query metrics for yet
    try {
      const data = await reddit(token, 'GET', `/api/info?id=${encodeURIComponent(post.redditPostId)}`);
      const child = data?.data?.children?.[0]?.data;
      if (!child) { RUN.results.push({ postId: post.id, platform: 'reddit', action: 'insights', ok: true, metrics: {} }); continue; }
      RUN.results.push({ postId: post.id, platform: 'reddit', action: 'insights', ok: true, metrics: { score: child.score ?? 0, num_comments: child.num_comments ?? 0, upvote_ratio: child.upvote_ratio ?? null } });
    } catch (err) {
      RUN.results.push({ postId: post.id, platform: 'reddit', action: 'insights', ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 200) });
    }
  }
}

// Pre-submit validation reads (spec 09, Pattern P3, read-only). Checks the
// destination subreddit's rules BEFORE publish so PlatformBlockers can warn the
// operator ahead of a silent `submit rejected` at publish time (:334 above).
// Fetches the subreddit-level data ONCE per run (shared across every targeted
// reddit post), then evaluates each post's title/kind against it. A
// rules-endpoint failure is a per-post ok:false/engine_failure row (never a
// crash; the presubmitCheck lib face omits it from the merged panel). A
// missing subreddit/credential degrades to a needs_scope warning (P9) instead
// of throwing - `ready:null` reads as "couldn't check", not "blocked".
function presubmitNeedsScope(postId, message, extra = {}) {
  return {
    postId, platform: 'reddit', action: 'presubmit', ok: true, ready: null,
    problems: [], warnings: [{ code: 'needsScope', text: String(message || '').slice(0, 200) }], meta: {},
    ...extra,
  };
}

// Spec 36: resolve the destination subreddit for a post exactly as cmdPublishDue
// would - the per-post redditSubreddit (a leading r/ stripped) then the connection
// default. One source of truth so presubmit checks the SAME sub that would publish.
function resolveSub(post) {
  return (post.redditSubreddit || '').replace(/^\/?r\//, '').trim() || subreddit();
}

export async function cmdPresubmit(args) {
  const { plan } = loadPlan(args.plan);
  // A Radar reply (post.radarReplyTo) is NOT presubmit's business: presubmit exists to check
  // a SUBMISSION against its destination subreddit's post_requirements, and a reply is a
  // comment on a thread (:596-626, /api/comment) with no destination sub and no title to
  // evaluate. Left in, it resolved no sub and degraded to a needsScope warning - telling the
  // operator to "authorize the connection to check the platform rules" for rules that do not
  // apply to a comment. The warmth advisories are exempted for replies app-side already
  // (app/src/lib/format.js:434), so dropping the reply here loses no signal.
  const targets = (plan.posts || []).filter((p) => isReddit(p) && !p.radarReplyTo && (!args.only || p.id === args.only));
  if (!targets.length) return;
  let token;
  try {
    token = await mintToken();
  } catch (err) {
    // Spec 36: a token that cannot be minted degrades EVERY post to needsScope
    // (the credential gate is account-wide, not per-sub) - never a throw. Spec 37:
    // no warmth read is possible either, so the tier fails closed to manual per post.
    for (const post of targets) {
      const { advisories } = laneReadiness('reddit', readinessInputs(post, null, undefined));
      RUN.results.push(presubmitNeedsScope(post.id, err.message, { warmth: null, advisories }));
    }
    return;
  }

  // Spec 37: fetch the account warmth ONCE per run (a single /api/v1/me), cached in-run
  // like the per-sub requirements below - so the tier judge has the same age/karma for
  // every targeted post. A failed read is null (the judge fail-closes to 'cold'/manual).
  const warmth = await fetchWarmth(token);

  // Spec 36: group the targets by their resolved subreddit and fetch each unique
  // sub's post_requirements + /about ONCE per run (cache within the call). A post
  // that resolves to NO sub degrades per-post (never all posts); a per-sub fetch
  // failure is an engine_failure row for that sub's posts only.
  const subCache = new Map(); // sub -> { rules } | { error }

  for (const post of targets) {
    const sr = resolveSub(post);
    if (!sr) {
      // No sub -> can't verify requirements; subRequirementsMet unknown -> a subRequirements
      // advisory (plus promo/cold as they apply). Additive display-only keys.
      const { advisories } = laneReadiness('reddit', readinessInputs(post, warmth, undefined));
      RUN.results.push(presubmitNeedsScope(post.id, 'no subreddit set (post.redditSubreddit / REDDIT_SUBREDDIT) - cannot check subreddit rules.', { warmth, advisories }));
      continue;
    }
    const info = await fetchSubRules(token, sr, subCache);
    if (info.error) {
      RUN.results.push({ postId: post.id, platform: 'reddit', action: 'presubmit', ok: false, errorCode: 'engine_failure', errorMessage: info.error });
      continue;
    }
    const title = titleFor(post);
    const problems = evaluateSubProblems(post, info.rules, title);
    // The sub's PROSE rules, classified into advisory warnings ({ code, text } - the shape this
    // channel already uses, which the app localizes as blockers.presubmit.<code> with {text}).
    // Never a problem, never a gate on `ready`: these are what the ROOM expects, and the owner
    // decision is warn-and-allow. flairExpected is suppressed when the API already requires a
    // flair (that is a blocking problem above) or the post has one picked.
    const warnings = classifySubRules({
      rules: info.norms?.prose,
      submitText: info.norms?.submitText,
      flairRequired: info.rules.flairRequired,
      hasFlair: Boolean(post.redditFlairId),
    });
    const ready = problems.length === 0;
    // Spec 37 (reversed 2026-07-13): attach the derived warmth advisories (ADDITIVELY - display
    // only, never a gate on `ready`). The app localizes the advisory codes; the engine emits
    // { code, params } only. Every approved reddit post still auto-publishes.
    const { advisories } = laneReadiness('reddit', readinessInputs(post, warmth, ready));

    RUN.results.push({
      postId: post.id, platform: 'reddit', action: 'presubmit', ok: true,
      ready, problems, warnings, meta: { subreddit: sr },
      warmth, advisories,
    });
  }
}

async function cmdDelete(args) {
  if (!args.id) { console.error('[err] delete requires --id <fullname> (e.g. t3_abc123)'); process.exit(2); }
  const token = await mintToken();
  await reddit(token, 'POST', '/api/del', { form: { id: String(args.id) } });
  RUN.results.push({ platform: 'reddit', action: 'delete', ok: true, id: String(args.id) });
  console.log(`[ok] deleted Reddit submission ${args.id}.`);
}

async function cmdProbe() {
  if (!readEnv('REDDIT_CLIENT_ID') || !readEnv('REDDIT_USERNAME')) {
    RUN.results.push({ platform: 'reddit', action: 'probe', ok: false, detail: 'not configured (REDDIT_CLIENT_ID / REDDIT_USERNAME missing)' });
    return;
  }
  try {
    const token = await mintToken();
    const me = await reddit(token, 'GET', '/api/v1/me');
    RUN.results.push({ platform: 'reddit', action: 'probe', ok: true, detail: `connected as u/${me.name}`, tokenExpiresAt: null });
  } catch (err) {
    RUN.results.push({ platform: 'reddit', action: 'probe', ok: false, detail: String(err.message || err).slice(0, 200) });
  }
}

// Connected-account discovery (spec 22, Pattern P3): who is this account + which
// subreddits does it moderate? Reads creds via readEnv so a missing credential
// degrades to an ok:false row, never a crash. Reuses the same /api/v1/me identity
// read + /subreddits/mine/moderator; picking one writes redditSubreddit. Takes no --plan.
async function cmdDiscover() {
  const { discoverOk, discoverNeedsScope, discoverAuthError, markCurrent } = await import('../lib/discovery.mjs');
  if (!readEnv('REDDIT_CLIENT_ID') || !readEnv('REDDIT_CLIENT_SECRET') || !readEnv('REDDIT_USERNAME') || !readEnv('REDDIT_PASSWORD')) {
    RUN.results.push(discoverNeedsScope('reddit'));
    return;
  }
  try {
    const token = await mintToken();
    const me = await reddit(token, 'GET', '/api/v1/me');
    let mods = [];
    try {
      const listing = await reddit(token, 'GET', '/subreddits/mine/moderator?limit=100');
      mods = (listing?.data?.children || []).map((c) => c.data).filter(Boolean);
    } catch { /* moderator list is best-effort; identity still stands */ }
    const sealed = (readEnv('REDDIT_SUBREDDIT') || '').replace(/^\/?r\//, '').trim();
    const assets = markCurrent(mods.map((s) => ({
      kind: 'section', id: s.display_name, name: `r/${s.display_name}`,
      meta: s.subscribers != null ? { subscribers: s.subscribers } : undefined,
    })), sealed);
    // Spec 37 (review fix #1): attach warmth to the discover row so the SERVER persists it
    // in-process (connectDiscover -> persistRedditWarmth). Discover fires when Setup opens
    // right after connect, so this is the connect-time warmth refresh (no subprocess write).
    const discoverRow = discoverOk('reddit', {
      identity: { id: me.id ? `t2_${me.id}` : (me.name || ''), handle: me.name || null, name: me.name ? `u/${me.name}` : 'Reddit user', avatarUrl: (me.icon_img || '').split('?')[0] || undefined },
      assets,
      selected: { redditSubreddit: sealed || null },
    });
    discoverRow.warmth = computeWarmth(me);
    RUN.results.push(discoverRow);
  } catch (err) {
    RUN.results.push(discoverAuthError('reddit', err.message || err));
  }
}

// Spec 16 (Pattern P4 read verb): list a subreddit's link-flair templates for the
// Composer flair picker. READ-ONLY, LIVE-ONLY (left OUT of MOCKABLE_COMMANDS, like
// probe). Degrades cleanly (P9): a missing credential/subreddit is a structured
// not_configured row, a token that can't be minted or a 403 is needs_scope - never a
// throw, and never a false-empty { ok:true, items:[] } (a FAILED read is ok:false so
// the picker shows "flair unavailable", not the empty "no flairs" state). Takes an
// optional --subreddit (falls back to REDDIT_SUBREDDIT). No --plan.
async function cmdFlairs(args) {
  const raw = typeof args.subreddit === 'string' && args.subreddit.trim() ? args.subreddit.trim() : subreddit();
  const sr = (raw || '').replace(/^\/?r\//, '').trim();
  if (!readEnv('REDDIT_CLIENT_ID') || !readEnv('REDDIT_USERNAME')) {
    RUN.results.push({ platform: 'reddit', action: 'flairs', ok: false, error: 'not_configured', message: 'Reddit credentials missing (REDDIT_CLIENT_ID / REDDIT_USERNAME)', subreddit: sr || null });
    return;
  }
  if (!sr) {
    RUN.results.push({ platform: 'reddit', action: 'flairs', ok: false, error: 'not_configured', message: 'REDDIT_SUBREDDIT is not set - no subreddit to read flairs from', subreddit: null });
    return;
  }
  let token;
  try {
    token = await mintToken();
  } catch (err) {
    RUN.results.push({ platform: 'reddit', action: 'flairs', ok: false, error: 'needs_scope', message: String(err.message || err).slice(0, 200), subreddit: sr });
    return;
  }
  try {
    const data = await reddit(token, 'GET', `/r/${encodeURIComponent(sr)}/api/link_flair_v2`);
    RUN.results.push({ platform: 'reddit', action: 'flairs', ok: true, items: normalizeFlairs(data), subreddit: sr });
  } catch (err) {
    const msg = String(err.message || err);
    // A 403 = the account/token lacks flair read (or the sub has flair disabled) -> the
    // P9 needs_scope degrade the Composer renders as "flair unavailable". Any other error
    // is a genuine read failure (still ok:false, never a false-empty items:[]).
    const error = /HTTP 403/.test(msg) ? 'needs_scope' : 'engine_failure';
    RUN.results.push({ platform: 'reddit', action: 'flairs', ok: false, error, message: msg.slice(0, 200), subreddit: sr });
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

// The inbound-engagement seam (spec 02, Pattern P6): read + reply to inbound
// comments on this lane's own posts. Thin wrappers over the shared, source-agnostic
// REST in lib/comments.mjs (dynamic import so the publish hot path's module graph is
// untouched). The result is merged onto RUN so main() emits the normalized
// { items } / { id } envelope; a needs_scope degrade sets ok:false (P9). Reddit
// reply is HUMAN-GATED (Responsible Builder Policy): only ever the operator's
// explicit panel submit reaches this - never an autonomous/scheduler path.
async function cmdComments(args) {
  const { runLaneComments } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneComments('reddit', args));
}
async function cmdReply(args) {
  const { runLaneReply } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneReply('reddit', args));
}
async function cmdModerate(args) {
  const { runLaneModerate } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneModerate('reddit', args));
}

// The Radar (beta) SEARCH verb (spec 33, Pattern P3 read + P9). Runs a RadarQuery
// (--query <json>) against Reddit's public search and maps hits to UNSCORED Signal rows
// { source, externalId, url, author, text, community, ts } - the seam (lib/radar.mjs
// runLaneRadar) scores + dedupes them. READ-ONLY; creds via readEnv (never requireEnv),
// so a missing BYO app degrades to needs_scope (not a process.exit) and a 429 to
// rate_limited - never a throw (P9). Searches /r/{sub}/search per query.subreddits, else
// the global /search. Mock mode NEVER reaches here (main() routes `radar` to the mock
// driver via MOCKABLE_COMMANDS) - this is the LIVE path. Reddit Data API Terms: keep it
// BYO-key + rate-limited; single-project self-hosted search is in-bounds.
async function cmdRadar(args) {
  const { radarOkRow, radarNeedsScopeRow, radarRateLimitedRow, radarErrorRow, radarHttp } = await import('../lib/radar.mjs');
  let query = {};
  try { query = args.query ? JSON.parse(String(args.query)) : {}; } catch { query = {}; }
  if (!readEnv('REDDIT_CLIENT_ID') || !readEnv('REDDIT_CLIENT_SECRET') || !readEnv('REDDIT_USERNAME') || !readEnv('REDDIT_PASSWORD')) {
    RUN.results.push(radarNeedsScopeRow('reddit', 'reddit_oauth'));
    return;
  }
  let token;
  try { token = await mintToken(); } catch { RUN.results.push(radarNeedsScopeRow('reddit', 'reddit_oauth')); return; }
  const keywords = Array.isArray(query.keywords) ? query.keywords.filter((k) => typeof k === 'string' && k.trim()) : [];
  const q = (keywords.length ? keywords.join(' OR ') : (typeof query.label === 'string' ? query.label.trim() : '')).trim();
  if (!q) { RUN.results.push(radarOkRow('reddit', [])); return; }
  const subs = Array.isArray(query.subreddits) ? query.subreddits.map((s) => String(s).replace(/^\/?r\//, '').trim()).filter(Boolean) : [];
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': userAgent() };
  const params = (extra) => new URLSearchParams({ q, sort: 'new', t: 'week', limit: '25', type: 'link,comment', raw_json: '1', ...extra }).toString();
  const paths = subs.length ? subs.map((s) => `/r/${encodeURIComponent(s)}/search?${params({ restrict_sr: '1' })}`) : [`/search?${params({})}`];
  const items = [];
  let degrade = null; // first per-subreddit failure — surfaced ONLY if nothing was collected (keep partial yield)
  for (const p of paths) {
    const { ok, status, json, retryAfter, error } = await radarHttp(`https://oauth.reddit.com${p}`, { headers });
    if (!ok) {
      if (status === 429) degrade = radarRateLimitedRow('reddit', retryAfter);
      else if (status === 401 || status === 403) degrade = radarNeedsScopeRow('reddit', 'reddit_oauth');
      else degrade = radarErrorRow('reddit', error || `HTTP ${status}`);
      break; // stop hitting a failing/throttled endpoint; return whatever earlier subs yielded
    }
    for (const child of (json?.data?.children || [])) {
      const d = child?.data;
      if (!d) continue;
      const isComment = child.kind === 't1';
      items.push({
        source: 'reddit', externalId: d.name || d.id,
        url: d.permalink ? `https://www.reddit.com${d.permalink}` : null,
        author: d.author, community: d.subreddit ? `r/${d.subreddit}` : null,
        text: isComment ? (d.body || '') : `${d.title || ''}${d.selftext ? `\n\n${d.selftext}` : ''}`.trim(),
        ts: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
      });
    }
  }
  if (!items.length && degrade) { RUN.results.push(degrade); return; }
  RUN.results.push(radarOkRow('reddit', items));
}

// Spec 44 (READ-only): did the thread's original author reply back to OUR posted comment?
// For each posted radar reply on this lane, GET our comment's subtree and let the pure
// parser answer. NEVER writes to reddit; NEVER re-attempts a terminal post. Stamps
// radarFollowup + radarReplyState='author_replied' on a hit (ENGINE_OWNED, so it persists).
export async function cmdRadarFollowup(args) {
  const { abs, plan } = loadPlan(args.plan);
  const { radarHttp, parseRedditFollowup, stampFollowup, needsFollowupCheck } = await import('../lib/radar.mjs');
  let token = null;
  const nowIso = new Date().toISOString();
  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    const rr = post.radarReplyTo;
    if (!rr || rr.source !== 'reddit' || !needsFollowupCheck(post) || !post.redditPostId) continue;
    try { token = token || await mintToken(); } catch (err) {
      RUN.results.push({ postId: post.id, platform: 'reddit', action: 'radar-followup', ok: false, errorCode: 'needs_scope', errorMessage: String(err.message || err).slice(0, 200) });
      continue;
    }
    const headers = { Authorization: `Bearer ${token}`, 'User-Agent': userAgent() };
    // Resolve the SUBMISSION (link) id our comment lives under: a t3_ target IS the article;
    // otherwise ask reddit for our comment's link_id.
    let article = /^t3_/.test(String(rr.externalId || '')) ? String(rr.externalId).replace(/^t3_/, '') : null;
    if (!article) {
      const info = await radarHttp(`https://oauth.reddit.com/api/info?id=${encodeURIComponent(post.redditPostId)}`, { headers });
      const linkId = info && info.json && info.json.data && info.json.data.children && info.json.data.children[0] && info.json.data.children[0].data && info.json.data.children[0].data.link_id;
      article = linkId ? String(linkId).replace(/^t3_/, '') : null;
    }
    if (!article) { stampFollowup(post, null, nowIso); await savePlan(abs, plan, [post.id]); RUN.results.push({ postId: post.id, platform: 'reddit', action: 'radar-followup', ok: true, authorReplied: false }); continue; }
    const comment = String(post.redditPostId).replace(/^t1_/, '');
    const { ok, status, json } = await radarHttp(`https://oauth.reddit.com/comments/${article}?comment=${comment}&depth=2&limit=100&raw_json=1`, { headers });
    if (!ok) {
      const gone = status === 404;
      if (gone) post.radarReplyState = 'target_gone';
      stampFollowup(post, null, nowIso);
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'reddit', action: 'radar-followup', ok: false, errorCode: gone ? 'radar_target_gone' : (status === 401 || status === 403 ? 'needs_scope' : 'engine_failure'), errorMessage: `reddit followup HTTP ${status}` });
      continue;
    }
    const hit = parseRedditFollowup(json, { author: rr.author, ourId: post.redditPostId, sinceTs: Date.parse(post.postedAt) });
    stampFollowup(post, hit, nowIso);
    await savePlan(abs, plan, [post.id]);
    RUN.results.push({ postId: post.id, platform: 'reddit', action: 'radar-followup', ok: true, authorReplied: Boolean(hit) });
  }
}

const COMMANDS = {
  auth: cmdAuth,
  connect: cmdAuth,
  comments: cmdComments,
  reply: cmdReply,
  moderate: cmdModerate,
  refresh: cmdRefresh,
  validate: cmdValidate,
  'publish-due': cmdPublishDue,
  status: cmdStatus,
  verify: cmdVerify,
  insights: cmdInsights,
  delete: cmdDelete,
  probe: cmdProbe,
  discover: cmdDiscover,
  presubmit: cmdPresubmit,
  flairs: cmdFlairs,
  radar: cmdRadar,
  'radar-followup': cmdRadarFollowup,
};

async function main() {
  const args = parseArgs(process.argv);
  JSON_MODE = Boolean(args.json);
  ACTOR = typeof args.actor === 'string' ? args.actor : 'cli';
  if (JSON_MODE) console.log = (...a) => console.error(...a);
  const commandName = args._[0];
  if (resolveMode('reddit') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'reddit', command: commandName,
      planPath: typeof args.plan === 'string' ? path.resolve(String(args.plan)) : null,
      only: typeof args.only === 'string' ? args.only : null,
      // spec 06: the moderate verb carries its action so the mock can branch per-lane.
      action: typeof args.action === 'string' ? args.action : null,
      // spec 33: the radar verb carries its --query (RadarQuery JSON) so the mock's
      // handleRadar can echo the query's competitors into its canned signals.
      query: typeof args.query === 'string' ? args.query : null,
    });
    if (JSON_MODE) process.stdout.write(`${JSON.stringify(envelope)}\n`);
    else console.error(`[mock] reddit ${commandName}: ${envelope.results.length} result(s)`);
    return;
  }
  const cmd = COMMANDS[commandName];
  if (!cmd) {
    console.error(`Usage: node scripts/reddit-social.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
    process.exit(2);
  }
  if (['validate', 'publish-due', 'status', 'verify', 'insights', 'presubmit'].includes(commandName) && !args.plan) {
    console.error(`[err] ${commandName} requires --plan <post-plan.json>`);
    process.exit(2);
  }
  await cmd(args);
  if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: true, ...RUN })}\n`);
}

// Guard main() so the pure helpers (redditSubmitKind / normalizeFlairs) are importable
// by tests without running the CLI (mirrors nostr-social.mjs / telegram-social.mjs).
// When spawned as a subprocess (execScript), process.argv[1] IS this file, so main runs.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (err) => {
    console.error('[err]', err.message || err);
    if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: false, error: String(err.message || err).slice(0, 300), ...RUN })}\n`);
    process.exit(1);
  });
}
