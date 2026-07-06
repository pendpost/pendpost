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
 *   probe                                              read-only health probe (list accounts)
 *   delete           --id <resourceName>               delete a local post (cleanup)
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
const SCOPE = 'https://www.googleapis.com/auth/business.manage';
const DEFAULT_REDIRECT = 'http://127.0.0.1:8088/oauth/gbp/callback';

// GBP local-post cap: a summary at 1500 chars.
const SUMMARY_LIMIT = 1500;
// The three local-post shapes + the CTA action types the v4 surface accepts.
const TOPICS = new Set(['standard', 'offer', 'event']);
const CTA_TYPES = new Set(['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL']);

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

// ---------- plan helpers (same shape as the sibling engines) ----------
// (lock + field-merge save duplicated verbatim across the engine siblings -
// self-contained per the sibling pattern, no shared lib)

function loadPlan(planPath) {
  const abs = path.resolve(planPath);
  return { abs, plan: JSON.parse(fs.readFileSync(abs, 'utf8')) };
}

// Engine-owned fields; everything else (caption, schedule, approval, cover)
// belongs to the owner/pendpost and must survive concurrent edits.
const ENGINE_OWNED_FIELDS = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'xPostId', 'tgMessageId', 'dcMessageId', 'redditPostId', 'pinId', 'tiktokVideoId', 'mastodonStatusId', 'wordpressPostId', 'ghostPostId', 'nostrEventId', 'gbpPostId', 'status', 'postedAt', 'attempts'];

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
  post.attempts = Array.isArray(post.attempts) ? post.attempts : [];
  post.attempts.push(entry);
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
  delete: cmdDelete,
  probe: cmdProbe,
};

async function main() {
  const args = parseArgs(process.argv);
  JSON_MODE = Boolean(args.json);
  ACTOR = typeof args.actor === 'string' ? args.actor : 'cli';
  if (JSON_MODE) console.log = (...a) => console.error(...a);
  const commandName = args._[0];
  if (resolveMode('gbp') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'gbp', command: commandName,
      planPath: typeof args.plan === 'string' ? path.resolve(String(args.plan)) : null,
      only: typeof args.only === 'string' ? args.only : null,
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
  if (['validate', 'publish-due', 'status', 'verify', 'insights'].includes(commandName) && !args.plan) {
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
