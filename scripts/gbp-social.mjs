#!/usr/bin/env node
/**
 * gbp-social.mjs - direct Google Business Profile local-post publishing via the
 * My Business v4 API.
 *
 * Sibling of scripts/pinterest-social.mjs / telegram-social.mjs / x-social.mjs:
 * the same zero-dep, plan-driven, publish-straight-from-the-plan pattern, with
 * Google's standard OAuth2 authorization-code auth model.
 *
 * GBP has NO scheduling API - a local post goes live on creation, so entries
 * publish at their due time by re-running `publish-due` (driven by the scheduler
 * tick), exactly like Telegram / X / Pinterest. There is no native `schedule`
 * command.
 *
 * AUTH - OAuth2 authorization-code with a durable (NON-rotating) refresh token
 * (mirrors pinterest-social's loopback ceremony + expiry tracking):
 *   GBP_CLIENT_ID          the OAuth client id from the Google Cloud console.
 *   GBP_CLIENT_SECRET      the OAuth client secret (sent in the token-endpoint form body).
 *   GBP_ACCESS_TOKEN       minted at consent, short-lived (~1h), auto-refreshed.
 *   GBP_REFRESH_TOKEN      durable token used to mint fresh access tokens - Google
 *                          only issues it at consent (access_type=offline + prompt=consent)
 *                          and does NOT rotate it on refresh.
 *   GBP_TOKEN_EXPIRES_AT   epoch ms - when the access token expires.
 *   GBP_ACCOUNT_ID         the numeric Business Profile account id.
 *   GBP_LOCATION_ID        the numeric location id - posts land on the parent
 *                          accounts/<GBP_ACCOUNT_ID>/locations/<GBP_LOCATION_ID>.
 * `auth`/`connect` runs a loopback http server on 127.0.0.1:8088, opens the
 * Google consent screen (scope business.manage), captures ?code, exchanges it
 * and persists the tokens + expiry to the active client's gitignored .env, then
 * best-effort lists accounts + locations as a hint for GBP_ACCOUNT_ID /
 * GBP_LOCATION_ID.
 *
 * CONTENT - `summary` comes from post.caption (1500-char cap); the optional
 * per-post intent object post.gbp picks one of the THREE local-post shapes
 * (absent -> What's New):
 *   What's New  { topic: 'standard' }
 *   Offer       { topic: 'offer', couponCode?, redeemUrl?, terms? }
 *   Event       { topic: 'event', eventTitle, eventStart, eventEnd }  (ISO dates - all three REQUIRED)
 * plus an optional call-to-action on any shape: ctaType BOOK | ORDER | SHOP |
 * LEARN_MORE | SIGN_UP | CALL with ctaUrl (omitted for CALL - it dials the
 * listing's phone number). Media is supplied by a PUBLIC IMAGE URL (post.image):
 * the v4 localPosts surface takes media by sourceUrl ONLY, so a local-only
 * render cannot be uploaded through this lane - such entries publish text-only
 * with a clear [info].
 *
 * HONESTY - this lane is BETA: built + mock-verified; live verification is
 * deferred until the owner has credentials. The Business Profile APIs are gated
 * on PER-PROJECT Google approval (request access via the GBP API console) AND a
 * verified business location - until the project is allowlisted, every
 * mybusiness* call 403s. Auth still succeeds (the OAuth token mints fine), so
 * the engine surfaces "pending approval" honestly instead of failing. Quota
 * note: the GBP APIs are REQUEST-quota'd (per-minute/per-day request budgets),
 * not post-quota'd - there is no daily post cap, but sweeps should stay gentle.
 *
 * Commands:
 *   auth | connect   [--client-id X --client-secret Y]   one-time loopback OAuth ceremony
 *   refresh                                          mint a fresh access token from the refresh token
 *   validate         --plan <p> [--only <id>]        side-effect-free preview, never posts
 *   publish-due      --plan <p> [--only <id>] [--dry-run]   publish any due GBP entry
 *   status           --plan <p>                       list GBP plan entries
 *   verify           --plan <p> [--only <id>]         read-only liveness (GET local post -> state)
 *   insights         --plan <p> [--only <id>]         per-post metrics (views + CTA clicks, best-effort)
 *   performance      --plan <p>                        location-wide local-intent metrics (calls/directions/clicks/bookings + top search keywords)
 *   probe                                              read-only health probe (list accounts)
 *   delete           --id <resourceName>               delete a local post (cleanup)
 *   media-add        --source-url <u> | --file <p> --category <c> [--format PHOTO|VIDEO]
 *                                                       add a photo/video to the location gallery
 *   media-list                                         list the location's gallery media
 *   attributes-get                                     read the location's attributes
 *   attributes-set   --attribute <attributes/id> --value <v> [--value-type BOOL|ENUM|TEXT|NUMBER|URL|REPEATED_ENUM]
 *                                                       update one location attribute (valueType
 *                                                       picks the request field: values/uriValues/repeatedEnumValue)
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand } from '../lib/mode.mjs';
import { enforceCeremonyClient } from '../lib/cli-client.mjs';
import { recordAttempt } from '../lib/publish-hold.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
import { envPath } from '../lib/util.mjs';
import { activeRoot } from '../lib/context.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The .env lives in the ACTIVE client subtree, resolved by the shared envPath()
// (lib/util.mjs -> activeRoot()): the app sets PENDPOST_ROOT to that client root
// when it spawns us; a bare CLI run resolves the active client from data/clients.json.
const ENV_PATH = envPath();

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://mybusiness.googleapis.com/v4';
// Account/location discovery lives on the two NEWER Business Profile hosts
// (the v4 host only keeps localPosts) - both are gated on the same per-project approval.
const ACCOUNTS_API = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const INFO_API = 'https://mybusinessbusinessinformation.googleapis.com/v1';
// Location-wide performance metrics live on their OWN Business Profile host (NOT
// v4 localPosts:reportInsights, which is deprecated) - the modern Performance API.
const PERF_API = 'https://businessprofileperformance.googleapis.com/v1';
const SCOPE = 'https://www.googleapis.com/auth/business.manage';
const DEFAULT_REDIRECT = 'http://127.0.0.1:8088/oauth/gbp/callback';

// GBP local-post cap: a summary at 1500 chars.
const SUMMARY_LIMIT = 1500;
// The three local-post shapes + the CTA action types the v4 surface accepts.
const TOPICS = new Set(['standard', 'offer', 'event']);
const CTA_TYPES = new Set(['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL']);

// Reviews (spec 03, engagement): the v4 star-rating enum -> a 1-5 integer, and the
// owner-reply body cap. A review reply is upserted (PUT) or removed (DELETE) on the
// review's own resource; a review is NOT a local post (no topic/CTA/media).
const STAR_MAP = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const REVIEW_REPLY_LIMIT = 4096;
// A gentle page cap so a huge history never fans out unbounded (the GBP APIs are
// request-quota'd, gbp-social.mjs header): 50/page x 6 = up to 300 recent reviews.
const REVIEWS_MAX_PAGES = 6;

// Location media (spec 19, Pattern P3 + P4): the FROZEN category enum
// (accounts.locations.media locationAssociation.category) + media format the v4
// media surface accepts. Any other value is invalid_input - never silently coerced.
const MEDIA_CATEGORIES = new Set(['COVER', 'PROFILE', 'LOGO', 'EXTERIOR', 'INTERIOR', 'PRODUCT', 'AT_WORK', 'FOOD_AND_DRINK', 'MENU', 'COMMON_AREA', 'ROOMS', 'TEAMS', 'ADDITIONAL']);
const MEDIA_FORMATS = new Set(['PHOTO', 'VIDEO']);

// Test-only host overrides (mirrors GBP_REDIRECT_URI's override precedent): when set,
// media-add/media-list/attributes-get/attributes-set target a LOCAL stub host instead of
// the real Google APIs, so the two-step resumable upload (startUpload -> byte upload ->
// media.create) and the attributes PATCH are provable end-to-end with no live credentials/
// network. Read ONLY by these four verbs - every other verb (reviews, performance, local
// posts, discover...) keeps hitting the real, hardcoded API/INFO_API hosts unconditionally.
const mediaApiBase = () => readEnv('GBP_TEST_API') || API;
const infoApiBase = () => readEnv('GBP_TEST_INFO_API') || INFO_API;

// Refresh when the access token expires within this window (it lasts ~1h).
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// redirect uri is a constant overridable by env (mirrors pinterest-social's redirectUri).
const redirectUri = () => readEnv('GBP_REDIRECT_URI') || DEFAULT_REDIRECT;

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
    console.error(`[err] ${name} missing in .env - run 'node scripts/gbp-social.mjs auth' first.`);
    process.exit(1);
  }
  return v;
}

function tokenTail(t) {
  return t ? `...${t.slice(-6)}, length ${t.length}` : '(none)';
}

const accountId = () => readEnv('GBP_ACCOUNT_ID');
const locationId = () => readEnv('GBP_LOCATION_ID');
// Every localPosts call hangs off this parent resource.
const parentPath = () => `accounts/${accountId()}/locations/${locationId()}`;

// ---------- oauth ----------

// Google's token endpoint takes client_id/client_secret in the form body
// (no HTTP Basic, unlike Pinterest).
async function tokenExchange(params) {
  const clientId = requireEnv('GBP_CLIENT_ID');
  const clientSecret = requireEnv('GBP_CLIENT_SECRET');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const hint = data.error === 'invalid_grant'
      ? " - the refresh token is expired/revoked. Re-run 'node scripts/gbp-social.mjs auth'."
      : '';
    throw new Error(`OAuth ${params.grant_type}: HTTP ${res.status} ${data.error || ''} - ${data.error_description || data.message || JSON.stringify(data)}${hint}`);
  }
  return data;
}

// Persist a token-endpoint response and return the vars written (so the caller can
// log the new expiry). Google returns access_token (+ expires_in); a refresh_token
// ONLY arrives at consent (offline access) and never rotates on refresh, so the
// stored one is kept unless a new one shows up.
function persistTokens(data) {
  const vars = {
    GBP_ACCESS_TOKEN: data.access_token,
    GBP_TOKEN_EXPIRES_AT: String(Date.now() + (Number(data.expires_in) || 0) * 1000),
  };
  if (data.refresh_token) vars.GBP_REFRESH_TOKEN = data.refresh_token;
  writeEnv(vars);
  return vars;
}

// Return a valid access token, refreshing it (from the durable refresh token)
// if the current one expires within REFRESH_BUFFER_MS. Throws (never process.exit)
// so main().catch can emit the --json failure envelope and the probe path can catch.
async function ensureFreshToken({ force = false } = {}) {
  const token = readEnv('GBP_ACCESS_TOKEN');
  const expiresAt = Number(readEnv('GBP_TOKEN_EXPIRES_AT') || 0);
  if (!token && !readEnv('GBP_REFRESH_TOKEN')) {
    throw new Error("No GBP_ACCESS_TOKEN/GBP_REFRESH_TOKEN - run 'node scripts/gbp-social.mjs auth' first.");
  }
  if (token && !force && expiresAt - Date.now() > REFRESH_BUFFER_MS) return token;

  const refreshToken = readEnv('GBP_REFRESH_TOKEN');
  if (!refreshToken) {
    if (token && !force && expiresAt > Date.now()) return token;
    throw new Error("GBP access token expired and no refresh token is stored - re-run 'node scripts/gbp-social.mjs auth'.");
  }

  console.log('[info] Refreshing GBP access token...');
  let data;
  try {
    data = await tokenExchange({ grant_type: 'refresh_token', refresh_token: refreshToken });
  } catch (err) {
    throw new Error(`GBP token refresh failed (${err.message}). The refresh token likely expired or was revoked - re-run 'node scripts/gbp-social.mjs auth'.`);
  }
  const vars = persistTokens(data);
  console.log(`[ok] Token refreshed ${tokenTail(data.access_token)}, expires ${new Date(Number(vars.GBP_TOKEN_EXPIRES_AT)).toLocaleString('en-US')}.`);
  return data.access_token;
}

// ---------- google api helper (json GET/POST/DELETE) ----------

// Takes a FULL url (the lane spans three Google hosts: v4 localPosts + the two
// discovery APIs). err.status is attached so callers can branch on 403 (project
// not yet allowlisted for the Business Profile APIs) and 404 (post gone).
async function api(method, urlStr, { query, body, token } = {}) {
  const url = new URL(urlStr);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`GBP ${method} ${url.pathname}: HTTP ${res.status} - ${data.error?.message || data.error_description || text || ''}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Resolve a client-root-relative --file path to an absolute, containment-checked
// path (mirrors set_cover's filePath handling, lib/covers.mjs:249-265): resolve
// against activeRoot() (this process runs with PENDPOST_ROOT set to the caller's
// resolved client root, envPath()'s own anchor), then realpath-confine it inside
// that root so --file can never escape the client subtree. Returns null (never
// throws) on a missing/outside-root/non-file path so the caller degrades to
// invalid_input instead of crashing.
function resolveClientFile(rel) {
  const root = activeRoot();
  const abs = path.resolve(root, String(rel));
  let real;
  let realRoot;
  try {
    real = fs.realpathSync(abs);
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  try {
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

// ---------- plan helpers (same shape as the sibling engines) ----------
// (lock + field-merge save duplicated verbatim across the engine siblings -
// self-contained per the sibling pattern, no shared lib)

function loadPlan(planPath) {
  const abs = path.resolve(planPath);
  return { abs, plan: JSON.parse(fs.readFileSync(abs, 'utf8')) };
}

// Engine-owned fields; everything else (caption, schedule, approval, cover)
// belongs to the owner/pendpost and must survive concurrent edits.
const ENGINE_OWNED_FIELDS = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'xPostId', 'tgMessageId', 'dcMessageId', 'redditPostId', 'pinId', 'tiktokVideoId', 'mastodonStatusId', 'wordpressPostId', 'ghostPostId', 'nostrEventId', 'gbpPostId', 'status', 'postedAt', 'attempts', 'publishHold'];

// mkdir lockfile next to the plan: retry 5x200ms, steal when stale (>15 min).
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

const isGbp = (post) => (post.platforms || []).includes('gbp');
const gbpSummary = (post) => (post.caption || '').trim();
// The per-post intent object: absent -> a plain What's New post.
const gbpIntent = (post) => ((post.gbp && typeof post.gbp === 'object') ? post.gbp : { topic: 'standard' });
const gbpTopic = (post) => String(gbpIntent(post).topic || 'standard').toLowerCase();
// Media is supplied by a PUBLIC image url - GBP v4 localPosts cannot take an upload.
const gbpImageUrl = (post) => (post.image || '').trim();
const hasLocalMedia = (post) => Boolean(post.path || post.file);

// ---------- payload builder ----------

// The v4 event schedule takes a civil google.type.Date + TimeOfDay pair, not a
// timestamp - derive both from the ISO string in UTC.
function civilDateTime(iso) {
  const d = new Date(iso);
  return {
    date: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() },
    time: { hours: d.getUTCHours(), minutes: d.getUTCMinutes() },
  };
}

// Map a plan post + its gbp intent onto the v4 localPosts payload. Assumes the
// caps/completeness gates already ran (publish-due warn-skips before calling).
function buildLocalPost(post) {
  const intent = gbpIntent(post);
  const topic = gbpTopic(post);
  const payload = {
    languageCode: 'en',
    topicType: topic.toUpperCase(), // STANDARD | OFFER | EVENT
    summary: gbpSummary(post),
  };
  if (intent.ctaType) {
    payload.callToAction = { actionType: intent.ctaType };
    // CALL dials the listing's phone number - the API rejects a url with it.
    if (intent.ctaType !== 'CALL' && intent.ctaUrl) payload.callToAction.url = intent.ctaUrl;
  }
  // EVENT requires the event block (title + schedule); OFFER carries it only
  // when dates are provided (an offer's validity window is optional).
  if ((topic === 'event' || topic === 'offer') && intent.eventStart && intent.eventEnd) {
    const start = civilDateTime(intent.eventStart);
    const end = civilDateTime(intent.eventEnd);
    payload.event = {
      ...(intent.eventTitle ? { title: intent.eventTitle } : {}),
      schedule: { startDate: start.date, startTime: start.time, endDate: end.date, endTime: end.time },
    };
  }
  if (topic === 'offer') {
    payload.offer = {};
    if (intent.couponCode) payload.offer.couponCode = intent.couponCode;
    if (intent.redeemUrl) payload.offer.redeemOnlineUrl = intent.redeemUrl;
    if (intent.terms) payload.offer.termsConditions = intent.terms;
  }
  const url = gbpImageUrl(post);
  if (url) payload.media = [{ mediaFormat: 'PHOTO', sourceUrl: url }];
  return payload;
}

// ---------- commands ----------

async function cmdAuth(args) {
  console.log(`[info] Connecting Google Business Profile - credentials will be written to ${ENV_PATH}`);
  const clientId = args['client-id'] || readEnv('GBP_CLIENT_ID');
  const clientSecret = args['client-secret'] || readEnv('GBP_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    console.error('[err] Need --client-id and --client-secret (Google Cloud console -> APIs & Services -> Credentials) on first run, or set GBP_CLIENT_ID / GBP_CLIENT_SECRET in .env.');
    process.exit(2);
  }
  const redirect = redirectUri();
  writeEnv({ GBP_CLIENT_ID: clientId, GBP_CLIENT_SECRET: clientSecret, GBP_REDIRECT_URI: redirect });

  const u = new URL(redirect);
  const port = Number(u.port || 80);
  const callbackPath = u.pathname || '/oauth/gbp/callback';
  const state = crypto.randomUUID();
  const authUrl = `${AUTH_URL}?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline', // ask for a refresh token...
    prompt: 'consent', // ...and force Google to re-issue it even on re-consent
    state,
  }).toString()}`;

  console.log(`\n[action] Make sure ${redirect} is listed as an Authorized redirect URI for this OAuth client (Google Cloud console -> Credentials -> your client).`);
  console.log('[action] Opening the Google consent screen. Sign in with the account that manages your Business Profile. If it does not open, paste this URL:\n');
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
          redirect_uri: redirect,
        });
        if (!data.access_token) {
          throw new Error(`No access_token returned: ${JSON.stringify(data).slice(0, 200)}`);
        }
        const vars = persistTokens(data);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>pendpost: Google Business Profile connected.</h2><p>You can close this tab and return to the terminal.</p>');
        const exp = new Date(Number(vars.GBP_TOKEN_EXPIRES_AT)).toLocaleString('en-US');
        console.log(`\n[ok] Access token stored ${tokenTail(data.access_token)}, expires ${exp}.`);
        console.log(`[ok] Refresh token ${data.refresh_token ? 'stored - offline access enabled.' : 'NOT issued - re-run auth (prompt=consent) if refresh fails when the access token expires.'}`);
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

  // prove the token works and surface account/location ids as a setup hint.
  // Both discovery APIs 403 until the project is allowlisted for the Business
  // Profile APIs - that is NOT an auth failure, so it degrades to an honest warn.
  try {
    const token = await ensureFreshToken();
    const data = await api('GET', `${ACCOUNTS_API}/accounts`, { token });
    const accounts = data.accounts || [];
    if (!accounts.length) console.log('[warn] No Business Profile accounts visible to this Google user.');
    for (const a of accounts) {
      console.log(`  account  ${a.name}  "${a.accountName || ''}"  -> GBP_ACCOUNT_ID=${(a.name || '').split('/')[1] || '?'}`);
    }
    if (accounts[0]) {
      const locs = await api('GET', `${INFO_API}/${accounts[0].name}/locations`, { query: { readMask: 'name,title', pageSize: 10 }, token });
      for (const l of locs.locations || []) {
        console.log(`  location ${l.name}  "${l.title || ''}"  -> GBP_LOCATION_ID=${(l.name || '').split('/')[1] || '?'}`);
      }
    }
    if (!accountId() || !locationId()) console.log('[warn] GBP_ACCOUNT_ID / GBP_LOCATION_ID are not set - set the numeric ids (hints above) before publishing.');
  } catch (err) {
    if (err.status === 403) console.log('[warn] Could not list accounts/locations - Business Profile API access pending Google approval (request access for this project in the GBP API console).');
    else console.log(`[warn] Could not fetch accounts/locations: ${err.message}`);
  }
  console.log('[note] The Business Profile APIs need PER-PROJECT Google approval + a verified location - until then API calls 403 while the OAuth token itself stays valid.');
  console.log('[done] auth complete.');
}

async function cmdRefresh() {
  const token = await ensureFreshToken({ force: true });
  RUN.results.push({ platform: 'gbp', action: 'refresh', ok: true, tokenExpiresAt: Number(readEnv('GBP_TOKEN_EXPIRES_AT') || 0) || null });
  console.log(`[ok] Access token ${tokenTail(token)}, expires ${new Date(Number(readEnv('GBP_TOKEN_EXPIRES_AT'))).toLocaleString('en-US')}.`);
}

async function cmdValidate(args) {
  const { plan } = loadPlan(args.plan);
  console.log('================ VALIDATION ONLY - NOTHING WILL BE PUBLISHED ================');
  if (readEnv('GBP_ACCESS_TOKEN') || readEnv('GBP_REFRESH_TOKEN')) {
    console.log('[ok] OAuth tokens present.');
  } else {
    console.log("[warn] No GBP tokens stored - run 'node scripts/gbp-social.mjs auth' before publishing.");
  }
  if (!accountId() || !locationId()) console.log('[warn] GBP_ACCOUNT_ID / GBP_LOCATION_ID are not set - publish-due would fail.');
  const targets = (plan.posts || []).filter((p) => isGbp(p) && (!args.only || p.id === args.only));
  if (!targets.length) { console.log('[warn] No GBP entries match.'); return; }
  for (const post of targets) {
    const summary = gbpSummary(post);
    const intent = gbpIntent(post);
    const topic = gbpTopic(post);
    console.log(`\n----- ${post.id} -----`);
    console.log(`[preview] topic:   ${topic}${TOPICS.has(topic) ? '' : ' - UNKNOWN (use standard|offer|event)'}`);
    console.log(`[preview] summary (${summary.length}/${SUMMARY_LIMIT}${summary.length > SUMMARY_LIMIT ? ' - OVER LIMIT' : ''}):`);
    console.log(summary);
    if (intent.ctaType) {
      if (!CTA_TYPES.has(intent.ctaType)) console.log(`[warn] ctaType "${intent.ctaType}" is not a GBP action type (${[...CTA_TYPES].join('|')}).`);
      else if (intent.ctaType !== 'CALL' && !intent.ctaUrl) console.log(`[warn] ctaType ${intent.ctaType} needs a ctaUrl (only CALL goes without one) - this entry would be skipped.`);
      else console.log(`[preview] cta:     ${intent.ctaType}${intent.ctaType !== 'CALL' ? ` -> ${intent.ctaUrl}` : ' (dials the listing)'}`);
    }
    if (topic === 'event') {
      if (!intent.eventTitle || !intent.eventStart || !intent.eventEnd) console.log('[warn] event post is missing eventTitle/eventStart/eventEnd - this entry would be skipped (the API requires the full event block).');
      else console.log(`[preview] event:   "${intent.eventTitle}" ${intent.eventStart} -> ${intent.eventEnd}`);
    }
    if (topic === 'offer') {
      console.log(`[preview] offer:   coupon=${intent.couponCode || '-'} redeem=${intent.redeemUrl || '-'} terms=${intent.terms ? 'yes' : '-'}`);
    }
    const url = gbpImageUrl(post);
    if (url) {
      if (!/^https?:\/\//i.test(url)) console.log(`[warn] post.image "${url}" is not an absolute public URL - GBP media takes public URLs only.`);
      else console.log(`[preview] image url: ${url}`);
    } else if (hasLocalMedia(post)) {
      console.log("[info] local media is not publishable to GBP - set the post's image URL instead (post.image); this entry would publish text-only.");
    }
  }
  console.log('\n================ VALIDATION COMPLETE ================');
}

async function cmdPublishDue(args) {
  const { abs, plan } = loadPlan(args.plan);
  if (!accountId() || !locationId()) throw new Error('GBP_ACCOUNT_ID / GBP_LOCATION_ID is not set - cannot publish.');
  const parent = parentPath();
  const token = await ensureFreshToken();
  const now = Date.now();
  let published = 0;

  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isGbp(post)) continue;
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

    const summary = gbpSummary(post);
    const intent = gbpIntent(post);
    const topic = gbpTopic(post);
    if (!summary) { console.log(`[warn] ${post.id}: due but no summary (caption) - skipping.`); continue; }
    if (summary.length > SUMMARY_LIMIT) { console.log(`[warn] ${post.id}: summary is ${summary.length} chars (> ${SUMMARY_LIMIT}) - skipping.`); continue; }
    if (!TOPICS.has(topic)) { console.log(`[warn] ${post.id}: unknown gbp topic "${topic}" (use standard|offer|event) - skipping.`); continue; }
    if (intent.ctaType && !CTA_TYPES.has(intent.ctaType)) { console.log(`[warn] ${post.id}: ctaType "${intent.ctaType}" is not a GBP action type - skipping.`); continue; }
    if (intent.ctaType && intent.ctaType !== 'CALL' && !intent.ctaUrl) { console.log(`[warn] ${post.id}: ctaType ${intent.ctaType} needs a ctaUrl (only CALL goes without one) - skipping.`); continue; }
    if (topic === 'event' && !(intent.eventTitle && intent.eventStart && intent.eventEnd)) {
      // The API hard-requires event.title + event.schedule for topicType EVENT.
      console.log(`[warn] ${post.id}: event post is missing eventTitle/eventStart/eventEnd - skipping.`);
      continue;
    }

    const url = gbpImageUrl(post);
    if (!url && hasLocalMedia(post)) {
      // GBP v4 localPosts takes media by PUBLIC sourceUrl only - there is no
      // upload path, so a local-only render publishes text-only.
      console.log(`[info] ${post.id}: local media is not publishable to GBP - set the post's image URL instead (post.image); publishing text-only.`);
    }

    if (args['dry-run']) {
      console.log(`[dry] ${post.id}: would create a ${topic.toUpperCase()} local post on ${parent} (summary ${summary.length} chars${url ? `, photo ${url}` : ', text-only'}).`);
      continue;
    }

    console.log(`[info] ${post.id}: creating GBP ${topic.toUpperCase()} local post on ${parent}...`);
    try {
      const result = await api('POST', `${API}/${parent}/localPosts`, { body: buildLocalPost(post), token });
      const name = result?.name;
      if (!name) throw new Error(`create-localPost returned no name: ${JSON.stringify(result).slice(0, 200)}`);

      // Store the FULL resource name (accounts/.../localPosts/<id>) - verify and
      // delete address the post by that name verbatim.
      post.gbpPostId = String(name);
      post.status = 'posted';
      post.postedAt = new Date(now).toISOString();
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'gbp', action: 'publish', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'gbp', action: 'publish', ok: true, id: String(name) });
      console.log(`[ok] ${post.id}: published on Google Business Profile (${name}).`);
      if (result.searchUrl) console.log(`[ok] ${post.id}: live at ${result.searchUrl}`);
      published += 1;
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'gbp', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'gbp', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: GBP publish failed - ${err.message}`);
      continue;
    }
  }
  console.log(`[done] publish-due complete - ${published} local post(s) published.`);
}

async function cmdStatus(args) {
  const { plan } = loadPlan(args.plan);
  console.log('[info] GBP plan entries:');
  for (const post of (plan.posts || []).filter(isGbp)) {
    console.log(`  ${post.id.padEnd(18)} ${String(post.status).padEnd(10)} ${post.scheduledAt}  mode=${post.executionMode}${post.gbpPostId ? ` gbp=${post.gbpPostId}` : ''}`);
  }
}

// Read-only liveness: GET the stored local post by its full resource name. The
// API reports a lifecycle state (LIVE / PROCESSING / REJECTED) + searchUrl - the
// only permalink GBP exposes - so both are surfaced honestly per row.
async function cmdVerify(args) {
  const { plan } = loadPlan(args.plan);
  let token = null;
  try { token = await ensureFreshToken(); } catch { /* surfaced per row */ }
  for (const post of (plan.posts || []).filter(isGbp)) {
    if (args.only && post.id !== args.only) continue;
    if (!post.gbpPostId) continue;
    if (!token) {
      RUN.results.push({ postId: post.id, platform: 'gbp', action: 'verify', ok: true, live: false, state: 'unknown', permalink: null, id: post.gbpPostId });
      continue;
    }
    try {
      const resp = await api('GET', `${API}/${post.gbpPostId}`, { token });
      const state = String(resp.state || '').toUpperCase();
      const live = state === 'LIVE';
      RUN.results.push({ postId: post.id, platform: 'gbp', action: 'verify', ok: true, live, state: (state || 'unknown').toLowerCase(), permalink: resp.searchUrl || null, id: post.gbpPostId });
    } catch (err) {
      if (err.status === 404) {
        RUN.results.push({ postId: post.id, platform: 'gbp', action: 'verify', ok: true, live: false, state: 'missing', permalink: null, id: post.gbpPostId });
      } else {
        RUN.results.push({ postId: post.id, platform: 'gbp', action: 'verify', ok: false, errorCode: 'verify_failed', errorMessage: String(err.message || err).slice(0, 200), live: false, state: 'unknown', id: post.gbpPostId });
      }
    }
  }
}

// Per-post metrics via the v4 reportInsights batch endpoint: search views + CTA
// clicks over the last 30 days. Best-effort - the endpoint 403s until the project
// is allowlisted, so failures degrade to an honest [warn] rather than fabricating.
async function cmdInsights(args) {
  const { plan } = loadPlan(args.plan);
  if (!accountId() || !locationId()) { console.log('[warn] insights: GBP_ACCOUNT_ID / GBP_LOCATION_ID are not set.'); return; }
  let token = null;
  try { token = await ensureFreshToken(); } catch (err) { console.log(`[warn] insights: ${err.message}`); return; }
  const targets = (plan.posts || []).filter((p) => isGbp(p) && (!args.only || p.id === args.only) && p.gbpPostId);
  if (!targets.length) return;
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    const data = await api('POST', `${API}/${parentPath()}/localPosts:reportInsights`, {
      body: {
        localPostNames: targets.map((p) => p.gbpPostId),
        basicRequest: {
          metricRequests: [{ metric: 'LOCAL_POST_VIEWS_SEARCH' }, { metric: 'LOCAL_POST_ACTIONS_CALL_TO_ACTION' }],
          timeRange: { startTime: start.toISOString(), endTime: end.toISOString() },
        },
      },
      token,
    });
    const rows = data.localPostMetrics || [];
    for (const post of targets) {
      const row = rows.find((r) => r.localPostName === post.gbpPostId);
      const value = (metric) => {
        const mv = (row?.metricValues || []).find((m) => m.metric === metric);
        return Number(mv?.totalValue?.value ?? 0);
      };
      RUN.results.push({ postId: post.id, platform: 'gbp', action: 'insights', ok: true, metrics: { views: value('LOCAL_POST_VIEWS_SEARCH'), ctaClicks: value('LOCAL_POST_ACTIONS_CALL_TO_ACTION') }, id: post.gbpPostId });
    }
  } catch (err) {
    if (err.status === 403) console.log('[warn] insights: Business Profile API access pending Google approval - no metrics available yet.');
    else console.log(`[warn] insights failed: ${String(err.message || err).slice(0, 200)}`);
  }
}

// Normalize one v4 review to the P6 inbound shape (lib/comments.mjs Comment) plus
// the review-only fields: commentId is the FULL resource name (accounts/.../reviews/
// <id>) - the reply verb addresses the review by that name verbatim, mirroring how
// gbpPostId stores the full local-post name. rating maps the star enum to 1-5;
// reply/replyTs carry an existing owner reply so the inbox can render "replied".
function normalizeReview(r = {}) {
  return {
    commentId: String(r.name || r.reviewId || ''),
    kind: 'review',
    author: (r.reviewer && r.reviewer.displayName) || 'Anonymous',
    text: r.comment || '',
    ts: r.updateTime || r.createTime || null,
    rating: STAR_MAP[r.starRating] || null,
    reply: (r.reviewReply && r.reviewReply.comment) || null,
    replyTs: (r.reviewReply && r.reviewReply.updateTime) || null,
    platform: 'gbp',
    postId: null,
    permalink: null,
  };
}

// reviews (read, spec 03): GET the location's reviews (accounts.locations.reviews.list),
// newest-first, following nextPageToken to a gentle cap, and normalize each to the P6
// inbound shape. Emits ONE result row { platform:gbp, action:reviews, ok, items[],
// averageRating, totalReviewCount }. Takes NO --plan - reviews are location-scoped, not
// post-scoped. Degrades like the rest of the lane (P9): 403 -> needs_scope (the project
// is not yet allowlisted for the Business Profile APIs), never a throw. Object.assign'd
// onto RUN so the top envelope's ok reflects a needs_scope/failure (mirrors the comment
// engines' cmdComments), while a success stays ok:true with the row.
async function cmdReviews() {
  Object.assign(RUN, await gatherReviews());
}

async function gatherReviews() {
  if (!accountId() || !locationId()) {
    return { ok: false, error: 'GBP_ACCOUNT_ID / GBP_LOCATION_ID are not set', code: 'not_configured', results: [] };
  }
  let token;
  try {
    token = await ensureFreshToken();
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 200), code: 'engine_failure', results: [] };
  }
  try {
    const items = [];
    let averageRating = null;
    let totalReviewCount = null;
    let pageToken = null;
    for (let page = 0; page < REVIEWS_MAX_PAGES; page += 1) {
      const query = { orderBy: 'updateTime desc', pageSize: 50 };
      if (pageToken) query.pageToken = pageToken;
      // eslint-disable-next-line no-await-in-loop
      const data = await api('GET', `${API}/${parentPath()}/reviews`, { query, token });
      if (averageRating == null && typeof data.averageRating === 'number') averageRating = data.averageRating;
      if (totalReviewCount == null && data.totalReviewCount != null) totalReviewCount = Number(data.totalReviewCount);
      for (const r of data.reviews || []) items.push(normalizeReview(r));
      pageToken = data.nextPageToken || null;
      if (!pageToken) break;
    }
    return { ok: true, results: [{ platform: 'gbp', action: 'reviews', ok: true, items, averageRating, totalReviewCount }] };
  } catch (err) {
    if (err.status === 403) {
      return { ok: false, error: 'needs_scope', scope: 'business.manage', detail: 'Business Profile API pending approval', results: [] };
    }
    return { ok: false, error: String(err.message || err).slice(0, 200), code: 'engine_failure', results: [] };
  }
}

// reply-to-review (write, spec 03): upsert (PUT .../reply {comment}) or remove
// (DELETE .../reply when --text is empty or --delete is passed) the OWNER reply on
// one review, addressed by its full resource name (--review-id). A review reply is
// low-risk + reversible (edit/remove), so no confirm gate. Pushes { postId:null,
// platform:gbp, action:reply-to-review, ok, id:reviewId }. Degrades (P9), never
// throws: 403 -> needs_scope, 404 -> review_missing, over-length -> invalid_input.
async function cmdReplyToReview(args) {
  Object.assign(RUN, await doReplyToReview(args));
}

async function doReplyToReview(args) {
  const reviewId = typeof args['review-id'] === 'string' ? args['review-id'].trim() : '';
  if (!reviewId) {
    return { ok: false, error: 'reply-to-review requires --review-id <resource name>', code: 'invalid_input', results: [] };
  }
  const del = args.delete === true || args.delete === 'true';
  const text = typeof args.text === 'string' ? args.text : '';
  const remove = del || !text.trim();
  if (!remove && text.length > REVIEW_REPLY_LIMIT) {
    return { ok: false, error: `reply exceeds ${REVIEW_REPLY_LIMIT} chars`, code: 'invalid_input', results: [] };
  }
  let token;
  try {
    token = await ensureFreshToken();
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 200), code: 'engine_failure', results: [] };
  }
  try {
    if (remove) await api('DELETE', `${API}/${reviewId}/reply`, { token });
    else await api('PUT', `${API}/${reviewId}/reply`, { body: { comment: text }, token });
    return { ok: true, results: [{ postId: null, platform: 'gbp', action: 'reply-to-review', ok: true, id: reviewId }] };
  } catch (err) {
    if (err.status === 403) return { ok: false, error: 'needs_scope', scope: 'business.manage', detail: 'Business Profile API pending approval', results: [] };
    if (err.status === 404) return { ok: false, error: 'review_missing', code: 'review_missing', results: [] };
    return { ok: false, error: String(err.message || err).slice(0, 200), code: 'engine_failure', results: [] };
  }
}

// Location media gallery + attributes (spec 19, account management, Pattern P3 + P9).
// FOUR verbs, no post TYPE / publish field - the gallery + attributes live on the
// LOCATION, not any plan post. All four degrade like the rest of the lane: 403 ->
// needs_scope (business.manage), never a throw past the envelope.

// media-add (write): public URL -> a single media.create POST; local --file -> the
// two-step resumable upload (media:startUpload -> raw byte POST -> media.create with
// dataRef). Category is validated against the FROZEN MEDIA_CATEGORIES set; format
// defaults to PHOTO. Pushes { platform:'gbp', action:'media-add', ok, id:<mediaName>,
// googleUrl }.
async function cmdMediaAdd(args) {
  Object.assign(RUN, await doMediaAdd(args));
}

async function doMediaAdd(args) {
  const category = typeof args.category === 'string' ? args.category.trim().toUpperCase() : '';
  if (!MEDIA_CATEGORIES.has(category)) {
    return { ok: false, error: `--category must be one of ${[...MEDIA_CATEGORIES].join('|')}`, code: 'invalid_input', results: [] };
  }
  const format = typeof args.format === 'string' && args.format.trim() ? args.format.trim().toUpperCase() : 'PHOTO';
  if (!MEDIA_FORMATS.has(format)) {
    return { ok: false, error: `--format must be one of ${[...MEDIA_FORMATS].join('|')}`, code: 'invalid_input', results: [] };
  }
  const sourceUrl = typeof args['source-url'] === 'string' ? args['source-url'].trim() : '';
  const file = typeof args.file === 'string' ? args.file.trim() : '';
  if (!sourceUrl && !file) {
    return { ok: false, error: 'media-add requires --source-url <public url> or --file <client-root-relative path>', code: 'invalid_input', results: [] };
  }
  if (sourceUrl && file) {
    return { ok: false, error: 'media-add takes --source-url OR --file, not both', code: 'invalid_input', results: [] };
  }
  if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) {
    return { ok: false, error: '--source-url must be an absolute http(s) URL', code: 'invalid_input', results: [] };
  }
  let absFile = null;
  if (file) {
    absFile = resolveClientFile(file);
    if (!absFile) return { ok: false, error: `file not found: ${file}`, code: 'invalid_input', results: [] };
  }
  if (!accountId() || !locationId()) {
    return { ok: false, error: 'GBP_ACCOUNT_ID / GBP_LOCATION_ID are not set', code: 'not_configured', results: [] };
  }
  let token;
  try {
    token = await ensureFreshToken();
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 200), code: 'engine_failure', results: [] };
  }
  const base = mediaApiBase();
  const parent = parentPath();
  try {
    let result;
    if (sourceUrl) {
      result = await api('POST', `${base}/${parent}/media`, {
        body: { mediaFormat: format, locationAssociation: { category }, sourceUrl },
        token,
      });
    } else {
      const startRes = await api('POST', `${base}/${parent}/media:startUpload`, { body: {}, token });
      const resourceName = startRes?.resourceName;
      if (!resourceName) throw new Error(`media:startUpload returned no resourceName: ${JSON.stringify(startRes).slice(0, 200)}`);
      // media.upload lives on its OWN path template (/upload/v1/media/{+name}) -
      // NOT a '/v4' -> '/upload/v4' rewrite of the media API base (spec 19 review,
      // BLOCKER-1: that rewrite is a no-op against the real host, so every live
      // --file upload 404'd). Keep the HOST from `base` (so the GBP_TEST_API stub
      // override still routes here) but hardcode the real upload/v1/media path.
      const uploadUrl = `${new URL(base).origin}/upload/v1/media/${resourceName}?upload_type=media`;
      const bytes = fs.readFileSync(absFile);
      const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
        body: bytes,
      });
      if (!uploadRes.ok) {
        const text = await uploadRes.text().catch(() => '');
        // Attach .status like the api() helper does (:254-270) so a 403 on this
        // raw fetch leg also degrades to needs_scope (spec 19 review, MINOR-4)
        // instead of the generic engine_failure a plain Error would produce.
        const uploadErr = new Error(`media byte upload failed: HTTP ${uploadRes.status} - ${text.slice(0, 200)}`);
        uploadErr.status = uploadRes.status;
        throw uploadErr;
      }
      result = await api('POST', `${base}/${parent}/media`, {
        body: { mediaFormat: format, locationAssociation: { category }, dataRef: { resourceName } },
        token,
      });
    }
    const name = result?.name;
    if (!name) throw new Error(`media create returned no name: ${JSON.stringify(result).slice(0, 200)}`);
    return { ok: true, results: [{ platform: 'gbp', action: 'media-add', ok: true, id: String(name), googleUrl: result.googleUrl || null }] };
  } catch (err) {
    if (err.status === 403) return { ok: false, error: 'needs_scope', scope: 'business.manage', detail: 'Business Profile API pending approval', results: [] };
    return { ok: false, error: String(err.message || err).slice(0, 200), code: 'engine_failure', results: [] };
  }
}

// media-list (read): GET the location's gallery, normalized. Emits ONE result row
// { platform:'gbp', action:'media-list', ok:true, items:[{id,format,category,
// thumbnailUrl,googleUrl,createTime}] }. A FAILED read is ok:false at the top
// envelope, NEVER a false-empty { ok:true, items:[] }.
async function cmdMediaList(args) {
  Object.assign(RUN, await doMediaList(args));
}

async function doMediaList(args) {
  if (!accountId() || !locationId()) {
    return { ok: false, error: 'GBP_ACCOUNT_ID / GBP_LOCATION_ID are not set', code: 'not_configured', results: [] };
  }
  let token;
  try {
    token = await ensureFreshToken();
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 200), code: 'engine_failure', results: [] };
  }
  try {
    const query = {};
    if (args['page-size']) query.pageSize = args['page-size'];
    if (args['page-token']) query.pageToken = args['page-token'];
    const data = await api('GET', `${mediaApiBase()}/${parentPath()}/media`, { query, token });
    const items = (data.mediaItems || []).map((m) => ({
      id: m.name || null,
      format: m.mediaFormat || null,
      category: (m.locationAssociation && m.locationAssociation.category) || null,
      thumbnailUrl: m.thumbnailUrl || null,
      googleUrl: m.googleUrl || null,
      createTime: m.createTime || null,
    }));
    return { ok: true, results: [{ platform: 'gbp', action: 'media-list', ok: true, items }] };
  } catch (err) {
    if (err.status === 403) return { ok: false, error: 'needs_scope', scope: 'business.manage', detail: 'Business Profile API pending approval', results: [] };
    return { ok: false, error: String(err.message || err).slice(0, 200), code: 'engine_failure', results: [] };
  }
}

// attributes-get (read): GET the location's attributes on the DISTINCT v1
// business-information host (locations/{l}/attributes - NO account prefix, unlike
// every v4 media/localPosts call). Emits ONE result row { platform:'gbp',
// action:'attributes-get', ok:true, items:[{id,valueType,values}] }.
async function cmdAttributesGet() {
  Object.assign(RUN, await doAttributesGet());
}

async function doAttributesGet() {
  if (!locationId()) {
    return { ok: false, error: 'GBP_LOCATION_ID is not set', code: 'not_configured', results: [] };
  }
  let token;
  try {
    token = await ensureFreshToken();
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 200), code: 'engine_failure', results: [] };
  }
  try {
    const data = await api('GET', `${infoApiBase()}/locations/${locationId()}/attributes`, { token });
    const items = (data.attributes || []).map((a) => ({ id: a.name || null, valueType: a.valueType || null, values: Array.isArray(a.values) ? a.values : [] }));
    return { ok: true, results: [{ platform: 'gbp', action: 'attributes-get', ok: true, items }] };
  } catch (err) {
    if (err.status === 403) return { ok: false, error: 'needs_scope', scope: 'business.manage', detail: 'Business Profile API pending approval', results: [] };
    return { ok: false, error: String(err.message || err).slice(0, 200), code: 'engine_failure', results: [] };
  }
}

// attributes-set (write): a single-attribute PATCH with attributeMask=<attributeName>
// on the SAME v1 business-information host (locations.updateAttributes) - idempotent
// (PATCH is an upsert), so a repeat call is safe. Pushes { platform:'gbp',
// action:'attributes-set', ok, id:<attributeName> }.
// NOTE (spec 19 review, BLOCKER-2): updateAttributes takes attributeMask, NOT
// updateMask - there is no updateMask field on this method, so the original param
// name 400'd on every live call.
const ATTR_VALUE_TYPES = new Set(['BOOL', 'ENUM', 'TEXT', 'NUMBER', 'URL', 'REPEATED_ENUM']);

// Only the two literal boolean spellings coerce (spec 19 review, MINOR-3): a
// legitimate attribute value that happens to look numeric (e.g. a TEXT attribute
// "12345") must survive as the operator typed it - the old blind Number() branch
// silently mis-typed such values.
function coerceAttrValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

// Google's Attribute resource carries the value in a DIFFERENT field per
// valueType (spec 19 review, MINOR-3): values[] for BOOL/ENUM/TEXT/NUMBER,
// uriValues[] ({uri}) for URL, repeatedEnumValue ({setValues}) for REPEATED_ENUM.
// valueType is optional - omitted (the common case) keeps the original values[]
// shape; the operator (or a caller that already read the attribute's valueType
// via attributes-get) supplies --value-type for the two attributes that need a
// different field.
function buildAttributeValue(valueType, rawValue) {
  if (valueType === 'URL') return { uriValues: [{ uri: String(rawValue) }] };
  if (valueType === 'REPEATED_ENUM') {
    const setValues = String(rawValue).split(',').map((v) => v.trim()).filter(Boolean);
    return { repeatedEnumValue: { setValues } };
  }
  return { values: [coerceAttrValue(rawValue)] };
}

async function cmdAttributesSet(args) {
  Object.assign(RUN, await doAttributesSet(args));
}

async function doAttributesSet(args) {
  const attribute = typeof args.attribute === 'string' ? args.attribute.trim() : '';
  if (!attribute) {
    return { ok: false, error: 'attributes-set requires --attribute <attributes/<id>>', code: 'invalid_input', results: [] };
  }
  if (args.value === undefined || args.value === null) {
    return { ok: false, error: 'attributes-set requires --value <v>', code: 'invalid_input', results: [] };
  }
  const valueType = typeof args['value-type'] === 'string' ? args['value-type'].trim().toUpperCase() : '';
  if (valueType && !ATTR_VALUE_TYPES.has(valueType)) {
    return { ok: false, error: `--value-type must be one of ${[...ATTR_VALUE_TYPES].join('|')}`, code: 'invalid_input', results: [] };
  }
  if (!locationId()) {
    return { ok: false, error: 'GBP_LOCATION_ID is not set', code: 'not_configured', results: [] };
  }
  let token;
  try {
    token = await ensureFreshToken();
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 200), code: 'engine_failure', results: [] };
  }
  try {
    const body = { attributes: [{ name: attribute, ...buildAttributeValue(valueType, args.value) }] };
    await api('PATCH', `${infoApiBase()}/locations/${locationId()}/attributes`, { query: { attributeMask: attribute }, body, token });
    return { ok: true, results: [{ platform: 'gbp', action: 'attributes-set', ok: true, id: attribute }] };
  } catch (err) {
    if (err.status === 403) return { ok: false, error: 'needs_scope', scope: 'business.manage', detail: 'Business Profile API pending approval', results: [] };
    return { ok: false, error: String(err.message || err).slice(0, 200), code: 'engine_failure', results: [] };
  }
}

// Location-wide LOCAL-INTENT performance via the Business Profile Performance API
// (distinct host from the deprecated v4 localPosts:reportInsights). Called ONCE
// per gbp-evidence campaign by the insights sweep (account-scoped, not per post):
//   1. fetchMultiDailyMetricsTimeSeries - the daily action counters over the last
//      30 days; each series is summed to a single scalar.
//   2. searchkeywords/impressions/monthly - the top search terms that surfaced the
//      listing, truncated to the top 10 by count.
// Emits ONE account row { postId:null, platform:'gbp', action:'performance', ok,
// scope:'account', performance:{...} }. 403 -> the needs_scope degrade (P9);
// never throws past the envelope (any failure becomes an ok:false row instead).
const PERF_DAILY_METRICS = [
  'CALL_CLICKS', 'WEBSITE_CLICKS', 'BUSINESS_DIRECTION_REQUESTS', 'BUSINESS_BOOKINGS',
  'BUSINESS_CONVERSATIONS', 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
];

async function cmdPerformance() {
  const accountRow = (extra) => ({ postId: null, platform: 'gbp', action: 'performance', scope: 'account', ...extra });
  if (!accountId() || !locationId()) {
    RUN.results.push(accountRow({ ok: false, errorCode: 'not_configured', errorMessage: 'GBP_ACCOUNT_ID / GBP_LOCATION_ID are not set' }));
    return;
  }
  let token;
  try {
    token = await ensureFreshToken();
  } catch (err) {
    RUN.results.push(accountRow({ ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 200) }));
    return;
  }
  const loc = locationId();
  const civil = (d) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
  try {
    // -- daily action metrics (last 30 days), each series summed to a scalar --
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sp = new URLSearchParams();
    for (const m of PERF_DAILY_METRICS) sp.append('dailyMetrics', m);
    const s = civil(start);
    const e = civil(end);
    sp.set('dailyRange.start_date.year', String(s.year));
    sp.set('dailyRange.start_date.month', String(s.month));
    sp.set('dailyRange.start_date.day', String(s.day));
    sp.set('dailyRange.end_date.year', String(e.year));
    sp.set('dailyRange.end_date.month', String(e.month));
    sp.set('dailyRange.end_date.day', String(e.day));
    const daily = await api('GET', `${PERF_API}/locations/${loc}:fetchMultiDailyMetricsTimeSeries?${sp.toString()}`, { token });
    // Flatten multiDailyMetricTimeSeries[].dailyMetricTimeSeries[] and sum each
    // series' datedValues (values arrive as strings; absent -> 0).
    const series = [];
    for (const grp of daily.multiDailyMetricTimeSeries || []) {
      for (const dm of grp.dailyMetricTimeSeries || []) series.push(dm);
    }
    const sumMetric = (name) => {
      const dm = series.find((d) => d.dailyMetric === name);
      return (dm?.timeSeries?.datedValues || []).reduce((acc, v) => acc + Number(v.value || 0), 0);
    };

    // -- top monthly search keywords, truncated to the top 10 by count --
    const kw = await api('GET', `${PERF_API}/locations/${loc}/searchkeywords/impressions/monthly`, { token });
    const searchKeywords = (kw.searchKeywordsCounts || [])
      .map((r) => ({ keyword: String(r.searchKeyword || ''), count: Number(r.insightsValue?.value ?? r.insightsValue?.threshold ?? 0) }))
      .filter((r) => r.keyword)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    RUN.results.push(accountRow({
      ok: true,
      performance: {
        calls: sumMetric('CALL_CLICKS'),
        websiteClicks: sumMetric('WEBSITE_CLICKS'),
        directions: sumMetric('BUSINESS_DIRECTION_REQUESTS'),
        bookings: sumMetric('BUSINESS_BOOKINGS'),
        conversations: sumMetric('BUSINESS_CONVERSATIONS'),
        impressions: sumMetric('BUSINESS_IMPRESSIONS_DESKTOP_SEARCH') + sumMetric('BUSINESS_IMPRESSIONS_MOBILE_SEARCH'),
        searchKeywords,
      },
    }));
  } catch (err) {
    if (err.status === 403) {
      // The token minted fine - only the Business Profile API surface is gated on
      // Google's per-project approval. Degrade to the structured needs_scope shape
      // (P9), never a crash; the sweep filters this ok:false row out honestly.
      RUN.results.push(accountRow({ ok: false, error: 'needs_scope', scope: 'business.manage' }));
      console.log('[warn] performance: Business Profile API access pending Google approval - no metrics available yet.');
      return;
    }
    RUN.results.push(accountRow({ ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 200) }));
    console.log(`[warn] performance failed: ${String(err.message || err).slice(0, 200)}`);
  }
}

async function cmdDelete(args) {
  if (!args.id) { console.error('[err] delete requires --id <resourceName> (accounts/.../locations/.../localPosts/<id>)'); process.exit(2); }
  const token = await ensureFreshToken();
  await api('DELETE', `${API}/${args.id}`, { token });
  RUN.results.push({ platform: 'gbp', action: 'delete', ok: true, id: String(args.id) });
  console.log(`[ok] deleted GBP local post ${args.id}.`);
}

async function cmdProbe() {
  if (!readEnv('GBP_ACCESS_TOKEN') && !readEnv('GBP_REFRESH_TOKEN')) {
    RUN.results.push({ platform: 'gbp', action: 'probe', ok: false, detail: 'not configured (GBP_REFRESH_TOKEN missing)' });
    return;
  }
  try {
    const token = await ensureFreshToken();
    const expiresAt = Number(readEnv('GBP_TOKEN_EXPIRES_AT') || 0) || null;
    try {
      const data = await api('GET', `${ACCOUNTS_API}/accounts`, { query: { pageSize: 1 }, token });
      const first = (data.accounts || [])[0];
      RUN.results.push({ platform: 'gbp', action: 'probe', ok: true, detail: `connected as ${first?.accountName || first?.name || '?'}`, tokenExpiresAt: expiresAt });
    } catch (err) {
      if (err.status !== 403) throw err;
      // The token minted/refreshed fine, so the credential IS proven - only the
      // Business Profile API surface is still gated on Google's per-project approval.
      RUN.results.push({ platform: 'gbp', action: 'probe', ok: true, detail: 'token valid - Business Profile API pending approval', tokenExpiresAt: expiresAt });
    }
  } catch (err) {
    RUN.results.push({ platform: 'gbp', action: 'probe', ok: false, detail: String(err.message || err).slice(0, 200) });
  }
}

// Connected-account discovery (spec 22, Pattern P3): which Business Profile account +
// locations can this token manage? Reads creds via readEnv so a missing token degrades
// to an ok:false row, never process.exit past the envelope. Reuses the accounts.list +
// locations reads (already in cmdAuth); picking a location writes gbpLocationId. GBP is
// MOCK-FIRST - the live path 403s until Google grants per-project Business Profile API
// access, which degrades to needs_scope (business.manage). Takes no --plan.
async function cmdDiscover() {
  const { discoverOk, discoverNeedsScope, discoverAuthError, markCurrent } = await import('../lib/discovery.mjs');
  if (!readEnv('GBP_ACCESS_TOKEN') && !readEnv('GBP_REFRESH_TOKEN')) {
    RUN.results.push(discoverNeedsScope('gbp'));
    return;
  }
  let token;
  try { token = await ensureFreshToken(); } catch (err) { RUN.results.push(discoverAuthError('gbp', err.message || err)); return; }
  try {
    const acctData = await api('GET', `${ACCOUNTS_API}/accounts`, { token });
    const accounts = acctData.accounts || [];
    const acct = accounts.find((a) => (a.name || '').split('/')[1] === accountId()) || accounts[0];
    let locations = [];
    if (acct) {
      const locData = await api('GET', `${INFO_API}/${acct.name}/locations`, { query: { readMask: 'name,title', pageSize: 100 }, token });
      locations = locData.locations || [];
    }
    const sealed = locationId() || null;
    const assets = markCurrent(locations.map((l) => {
      const lid = (l.name || '').split('/').pop();
      return { kind: 'location', id: lid, name: l.title || lid };
    }), sealed);
    RUN.results.push(discoverOk('gbp', {
      identity: { id: acct ? ((acct.name || '').split('/')[1] || '') : '', handle: null, name: acct?.accountName || 'Business Profile' },
      assets,
      selected: { gbpLocationId: sealed },
    }));
  } catch (err) {
    if (err.status === 403) { RUN.results.push(discoverNeedsScope('gbp')); return; }
    RUN.results.push(discoverAuthError('gbp', err.message || err));
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
  'publish-due': cmdPublishDue,
  status: cmdStatus,
  verify: cmdVerify,
  insights: cmdInsights,
  performance: cmdPerformance,
  reviews: cmdReviews,
  'reply-to-review': cmdReplyToReview,
  delete: cmdDelete,
  probe: cmdProbe,
  discover: cmdDiscover,
  'media-add': cmdMediaAdd,
  'media-list': cmdMediaList,
  'attributes-get': cmdAttributesGet,
  'attributes-set': cmdAttributesSet,
};

async function main() {
  const args = parseArgs(process.argv);
  await enforceCeremonyClient({ argv: args, command: args._[0], lane: 'gbp', scriptUrl: import.meta.url });
  JSON_MODE = Boolean(args.json);
  ACTOR = typeof args.actor === 'string' ? args.actor : 'cli';
  if (JSON_MODE) console.log = (...a) => console.error(...a);
  const commandName = args._[0];
  if (resolveMode('gbp') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'gbp', command: commandName,
      planPath: typeof args.plan === 'string' ? path.resolve(String(args.plan)) : null,
      only: typeof args.only === 'string' ? args.only : null,
      reviewId: typeof args['review-id'] === 'string' ? args['review-id'] : null,
      text: typeof args.text === 'string' ? args.text : null,
      remove: args.delete === true || args.delete === 'true',
      sourceUrl: typeof args['source-url'] === 'string' ? args['source-url'] : null,
      filePath: typeof args.file === 'string' ? args.file : null,
      category: typeof args.category === 'string' ? args.category : null,
      format: typeof args.format === 'string' ? args.format : null,
      attribute: typeof args.attribute === 'string' ? args.attribute : null,
      value: typeof args.value === 'string' ? args.value : null,
      valueType: typeof args['value-type'] === 'string' ? args['value-type'] : null,
    });
    if (JSON_MODE) process.stdout.write(`${JSON.stringify(envelope)}\n`);
    else console.error(`[mock] gbp ${commandName}: ${envelope.results.length} result(s)`);
    return;
  }
  const cmd = COMMANDS[commandName];
  if (!cmd) {
    console.error(`Usage: node scripts/gbp-social.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
    process.exit(2);
  }
  if (['validate', 'publish-due', 'status', 'verify', 'insights', 'performance'].includes(commandName) && !args.plan) {
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
