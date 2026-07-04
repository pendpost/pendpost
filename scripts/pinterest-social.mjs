#!/usr/bin/env node
/**
 * pinterest-social.mjs - direct Pinterest pin creation via the Pinterest API v5.
 *
 * Sibling of scripts/yt-social.mjs / x-social.mjs / telegram-social.mjs: the same
 * zero-dep, plan-driven, publish-straight-from-the-plan pattern, with Pinterest's
 * own OAuth2 authorization-code auth model.
 *
 * Pinterest has NO scheduling API in the public v5 surface - entries publish at
 * their due time by re-running `publish-due` (driven by the scheduler tick),
 * exactly like Telegram / X / Instagram. There is no native `schedule` command.
 *
 * AUTH - OAuth2 authorization-code with rotating refresh tokens (mirrors yt-social's
 * loopback ceremony + x-social's expiry tracking):
 *   PINTEREST_APP_ID            the app id from the Pinterest developer portal.
 *   PINTEREST_APP_SECRET        the app secret (used for HTTP Basic on the token URL).
 *   PINTEREST_ACCESS_TOKEN      minted at consent, short-lived (~1h), auto-refreshed.
 *   PINTEREST_REFRESH_TOKEN     durable token used to mint fresh access tokens.
 *   PINTEREST_TOKEN_EXPIRES_AT  epoch ms - when the access token expires.
 *   PINTEREST_BOARD_ID          the destination board IDENTIFIER (where pins land).
 * `auth`/`connect` runs a loopback http server on 127.0.0.1:8088, opens the
 * consent screen, captures ?code, exchanges it (Basic auth app_id:secret) and
 * persists the tokens + expiry to the active client's gitignored .env.
 *
 * Pin media is supplied by a PUBLIC IMAGE URL (post.imageUrl), the simplest and
 * most reliable v5 create-pin path (media_source.source_type=image_url). A
 * local-only render with no public URL is SKIPPED with a clear [warn] - this
 * engine does not host media. Title/description come from post.pinTitle /
 * post.pinDescription (falling back to post.title / post.caption), the additive
 * per-platform override pattern x uses for xCaption and telegram for tgCaption.
 *
 * HONESTY - Pinterest "Standard access": a freshly-created Pinterest app starts on
 * TRIAL access, where pins created via the API are CREATOR-ONLY (visible only to
 * the authenticating account, not public, not in search/feeds). PUBLIC pins require
 * the app to pass Pinterest's per-app "Standard access" review. Until that review
 * passes, publish will succeed (a pin id comes back) but the pin is not publicly
 * visible. This is surfaced in the playbook + beta flag for this lane.
 *
 * Commands:
 *   auth | connect   [--app-id X --app-secret Y]   one-time loopback OAuth ceremony
 *   refresh                                          mint a fresh access token from the refresh token
 *   validate         --plan <p> [--only <id>]        side-effect-free preview, never posts
 *   publish-due      --plan <p> [--only <id>] [--dry-run]   publish any due Pinterest entry
 *   status           --plan <p>                       list Pinterest plan entries
 *   verify           --plan <p> [--only <id>]         read-only liveness (GET pin)
 *   insights         --plan <p> [--only <id>]         per-pin analytics (best-effort)
 *   probe                                              read-only health probe (GET user_account)
 *   delete           --id <pinId>                      delete a pin (cleanup)
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

const AUTH_URL = 'https://www.pinterest.com/oauth/';
const TOKEN_URL = 'https://api.pinterest.com/v5/oauth/token';
const API = 'https://api.pinterest.com/v5';
const SCOPES = 'pins:read,pins:write,boards:read';
const DEFAULT_REDIRECT = 'http://127.0.0.1:8088/oauth/pinterest/callback';

// Pinterest pin caps: a title at 100 chars, a description at 800.
const TITLE_LIMIT = 100;
const DESCRIPTION_LIMIT = 800;

// Refresh when the access token expires within this window (it lasts ~1h).
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// redirect uri is a constant overridable by env (mirrors yt-social's redirectUri).
const redirectUri = () => readEnv('PINTEREST_REDIRECT_URI') || DEFAULT_REDIRECT;

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
    console.error(`[err] ${name} missing in .env - run 'node scripts/pinterest-social.mjs auth' first.`);
    process.exit(1);
  }
  return v;
}

function tokenTail(t) {
  return t ? `...${t.slice(-6)}, length ${t.length}` : '(none)';
}

const boardId = () => readEnv('PINTEREST_BOARD_ID');

// authenticate with HTTP Basic app_id:app_secret on the token endpoint.
function basicAuthHeader() {
  const id = requireEnv('PINTEREST_APP_ID');
  const secret = requireEnv('PINTEREST_APP_SECRET');
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
}

// ---------- oauth ----------

async function tokenExchange(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(),
    },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const hint = data.error === 'invalid_grant'
      ? " - the refresh token is expired/revoked. Re-run 'node scripts/pinterest-social.mjs auth'."
      : '';
    throw new Error(`OAuth ${params.grant_type}: HTTP ${res.status} ${data.error || ''} - ${data.error_description || data.message || JSON.stringify(data)}${hint}`);
  }
  return data;
}

// Persist a token-endpoint response and return the vars written (so the caller can
// log the new expiry). Pinterest returns access_token (+ expires_in) and, on a
// rotating-refresh response, a fresh refresh_token + refresh_token_expires_in.
function persistTokens(data) {
  const vars = {
    PINTEREST_ACCESS_TOKEN: data.access_token,
    PINTEREST_TOKEN_EXPIRES_AT: String(Date.now() + (Number(data.expires_in) || 0) * 1000),
  };
  if (data.refresh_token) vars.PINTEREST_REFRESH_TOKEN = data.refresh_token;
  writeEnv(vars);
  return vars;
}

// Return a valid access token, refreshing it (rotating the stored refresh token)
// if the current one expires within REFRESH_BUFFER_MS. Throws (never process.exit)
// so main().catch can emit the --json failure envelope and the probe path can catch.
async function ensureFreshToken({ force = false } = {}) {
  const token = readEnv('PINTEREST_ACCESS_TOKEN');
  const expiresAt = Number(readEnv('PINTEREST_TOKEN_EXPIRES_AT') || 0);
  if (!token && !readEnv('PINTEREST_REFRESH_TOKEN')) {
    throw new Error("No PINTEREST_ACCESS_TOKEN/PINTEREST_REFRESH_TOKEN - run 'node scripts/pinterest-social.mjs auth' first.");
  }
  if (token && !force && expiresAt - Date.now() > REFRESH_BUFFER_MS) return token;

  const refreshToken = readEnv('PINTEREST_REFRESH_TOKEN');
  if (!refreshToken) {
    if (token && !force && expiresAt > Date.now()) return token;
    throw new Error("Pinterest access token expired and no refresh token is stored - re-run 'node scripts/pinterest-social.mjs auth'.");
  }

  console.log('[info] Refreshing Pinterest access token...');
  let data;
  try {
    data = await tokenExchange({ grant_type: 'refresh_token', refresh_token: refreshToken });
  } catch (err) {
    throw new Error(`Pinterest token refresh failed (${err.message}). The refresh token likely expired or was revoked - re-run 'node scripts/pinterest-social.mjs auth'.`);
  }
  const vars = persistTokens(data);
  console.log(`[ok] Token refreshed ${tokenTail(data.access_token)}, expires ${new Date(Number(vars.PINTEREST_TOKEN_EXPIRES_AT)).toLocaleString('en-US')}.`);
  return data.access_token;
}

// ---------- pinterest v5 api helper (json GET/POST/DELETE) ----------

async function api(method, pathname, { query, body, token } = {}) {
  const url = new URL(`${API}${pathname}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`Pinterest ${method} ${pathname}: HTTP ${res.status} - ${data.message || data.error_description || text || ''}`);
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
const ENGINE_OWNED_FIELDS = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'xPostId', 'tgMessageId', 'dcMessageId', 'pinId', 'status', 'postedAt', 'attempts'];

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

const isPinterest = (post) => (post.platforms || []).includes('pinterest');
const pinTitle = (post) => (post.pinTitle || post.title || '').trim();
const pinDescription = (post) => (post.pinDescription || post.caption || '').trim();
// Media is supplied by a PUBLIC image url - this engine does not host media.
const pinImageUrl = (post) => (post.imageUrl || '').trim();

function permalinkFor(post) {
  return post.pinId ? `https://www.pinterest.com/pin/${post.pinId}/` : null;
}

// ---------- commands ----------

async function cmdAuth(args) {
  console.log(`[info] Connecting Pinterest - credentials will be written to ${ENV_PATH}`);
  const appId = args['app-id'] || readEnv('PINTEREST_APP_ID');
  const appSecret = args['app-secret'] || readEnv('PINTEREST_APP_SECRET');
  if (!appId || !appSecret) {
    console.error('[err] Need --app-id and --app-secret (Pinterest developer portal -> your app) on first run, or set PINTEREST_APP_ID / PINTEREST_APP_SECRET in .env.');
    process.exit(2);
  }
  const redirect = redirectUri();
  writeEnv({ PINTEREST_APP_ID: appId, PINTEREST_APP_SECRET: appSecret, PINTEREST_REDIRECT_URI: redirect });

  const u = new URL(redirect);
  const port = Number(u.port || 80);
  const callbackPath = u.pathname || '/oauth/pinterest/callback';
  const state = crypto.randomUUID();
  const authUrl = `${AUTH_URL}?${new URLSearchParams({
    response_type: 'code',
    client_id: appId,
    redirect_uri: redirect,
    scope: SCOPES,
    state,
  }).toString()}`;

  console.log(`\n[action] Make sure ${redirect} is listed as a Redirect URI for this Pinterest app (developer portal -> your app -> Configure).`);
  console.log('[action] Opening the Pinterest consent screen. Sign in with the account that owns your destination board. If it does not open, paste this URL:\n');
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
        res.end('<h2>pendpost: Pinterest connected.</h2><p>You can close this tab and return to the terminal.</p>');
        const exp = new Date(Number(vars.PINTEREST_TOKEN_EXPIRES_AT)).toLocaleString('en-US');
        console.log(`\n[ok] Access token stored ${tokenTail(data.access_token)}, expires ${exp}.`);
        console.log(`[ok] Refresh token ${data.refresh_token ? 'stored - rotating-refresh enabled.' : 'NOT issued - re-auth may be needed when the access token expires.'}`);
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
      console.log(`[info] Waiting for the Pinterest consent redirect on ${redirect} ...`);
    });
  });

  // prove the token works and surface the account.
  try {
    const token = await ensureFreshToken();
    const me = await api('GET', '/user_account', { token });
    console.log(`[ok] Pinterest account: ${me.username || me.business_name || '(unknown)'}.`);
    const bid = boardId();
    if (!bid) console.log('[warn] PINTEREST_BOARD_ID is not set - set it to the destination board id before publishing.');
  } catch (err) {
    console.log(`[warn] Could not fetch the account: ${err.message}`);
  }
  console.log('[note] New Pinterest apps start on TRIAL access - API-created pins are CREATOR-ONLY until the app passes Pinterest "Standard access" review (then pins are public).');
  console.log('[done] auth complete.');
}

async function cmdRefresh() {
  const token = await ensureFreshToken({ force: true });
  RUN.results.push({ platform: 'pinterest', action: 'refresh', ok: true, tokenExpiresAt: Number(readEnv('PINTEREST_TOKEN_EXPIRES_AT') || 0) || null });
  console.log(`[ok] Access token ${tokenTail(token)}, expires ${new Date(Number(readEnv('PINTEREST_TOKEN_EXPIRES_AT'))).toLocaleString('en-US')}.`);
}

async function cmdValidate(args) {
  const { plan } = loadPlan(args.plan);
  console.log('================ VALIDATION ONLY - NOTHING WILL BE PUBLISHED ================');
  try {
    const token = await ensureFreshToken();
    const me = await api('GET', '/user_account', { token });
    console.log(`[ok] Token valid - authenticated as ${me.username || me.business_name || '(unknown)'}.`);
  } catch (err) {
    console.log(`[warn] account check failed (${err.message}). Continuing to content preview.`);
  }
  const bid = boardId();
  if (!bid) console.log('[warn] PINTEREST_BOARD_ID is not set - publish-due would skip every entry.');
  const targets = (plan.posts || []).filter((p) => isPinterest(p) && (!args.only || p.id === args.only));
  if (!targets.length) { console.log('[warn] No Pinterest entries match.'); return; }
  for (const post of targets) {
    const title = pinTitle(post);
    const desc = pinDescription(post);
    const url = pinImageUrl(post);
    console.log(`\n----- ${post.id} -----`);
    console.log(`[preview] title (${title.length}/${TITLE_LIMIT}${title.length > TITLE_LIMIT ? ' - OVER LIMIT' : ''}): ${title}`);
    console.log(`[preview] description (${desc.length}/${DESCRIPTION_LIMIT}${desc.length > DESCRIPTION_LIMIT ? ' - OVER LIMIT' : ''}):`);
    console.log(desc);
    if (!url) console.log('[warn] no public image url (post.imageUrl) - this entry would be skipped (engine does not host media).');
    else console.log(`[preview] image url: ${url}`);
  }
  console.log('\n================ VALIDATION COMPLETE ================');
}

async function cmdPublishDue(args) {
  const { abs, plan } = loadPlan(args.plan);
  const bid = boardId();
  if (!bid) throw new Error('PINTEREST_BOARD_ID is not set - cannot publish.');
  const token = await ensureFreshToken();
  const now = Date.now();
  let published = 0;

  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isPinterest(post)) continue;
    if (post.executionMode !== 'fully-scheduled') continue;
    if (post.status !== 'planned') continue;
    if ((post.approval || 'draft') !== 'approved') {
      console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish.`);
      continue;
    }
    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs) || dueMs > now) continue;

    const title = pinTitle(post);
    const desc = pinDescription(post);
    if (title.length > TITLE_LIMIT) { console.log(`[warn] ${post.id}: title is ${title.length} chars (> ${TITLE_LIMIT}) - skipping.`); continue; }
    if (desc.length > DESCRIPTION_LIMIT) { console.log(`[warn] ${post.id}: description is ${desc.length} chars (> ${DESCRIPTION_LIMIT}) - skipping.`); continue; }

    const url = pinImageUrl(post);
    if (!url) {
      // A local-only render with no public URL cannot become a pin: v5 create-pin
      // takes media by public URL, and this engine does not host media.
      console.log(`[warn] ${post.id}: due but no public image url (post.imageUrl) - skipping (Pinterest engine does not host media; supply a public url).`);
      continue;
    }

    if (args['dry-run']) {
      console.log(`[dry] ${post.id}: would create a pin on board ${bid} from ${url} (title ${title.length} / desc ${desc.length} chars).`);
      continue;
    }

    console.log(`[info] ${post.id}: creating Pinterest pin on board ${bid}...`);
    try {
      const body = {
        board_id: bid,
        title: title || undefined,
        description: desc || undefined,
        media_source: { source_type: 'image_url', url },
      };
      const result = await api('POST', '/pins', { body, token });
      const pinId = result?.id;
      if (!pinId) throw new Error(`create-pin returned no id: ${JSON.stringify(result).slice(0, 200)}`);

      post.pinId = String(pinId);
      post.status = 'posted';
      post.postedAt = new Date(now).toISOString();
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'pinterest', action: 'publish', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'pinterest', action: 'publish', ok: true, id: String(pinId) });
      console.log(`[ok] ${post.id}: published on Pinterest (pin ${pinId}).`);
      published += 1;
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'pinterest', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'pinterest', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: Pinterest publish failed - ${err.message}`);
      continue;
    }
  }
  console.log(`[done] publish-due complete - ${published} pin(s) published.`);
}

async function cmdStatus(args) {
  const { plan } = loadPlan(args.plan);
  console.log('[info] Pinterest plan entries:');
  for (const post of (plan.posts || []).filter(isPinterest)) {
    console.log(`  ${post.id.padEnd(18)} ${String(post.status).padEnd(10)} ${post.scheduledAt}  mode=${post.executionMode}${post.pinId ? ` pin=${post.pinId}` : ''}`);
  }
}

// Read-only liveness: GET the stored pin. A 200 means the pin exists; the public
// permalink is derivable from the id (note: the pin is only publicly reachable
// once the app has Pinterest "Standard access").
async function cmdVerify(args) {
  const { plan } = loadPlan(args.plan);
  let token = null;
  try { token = await ensureFreshToken(); } catch { /* surfaced per row */ }
  for (const post of (plan.posts || []).filter(isPinterest)) {
    if (args.only && post.id !== args.only) continue;
    if (!post.pinId) continue;
    if (!token) {
      RUN.results.push({ postId: post.id, platform: 'pinterest', action: 'verify', ok: true, live: false, state: 'unknown', permalink: null, id: post.pinId });
      continue;
    }
    try {
      await api('GET', `/pins/${post.pinId}`, { token });
      RUN.results.push({ postId: post.id, platform: 'pinterest', action: 'verify', ok: true, live: true, state: 'live', permalink: permalinkFor(post), id: post.pinId });
    } catch (err) {
      RUN.results.push({ postId: post.id, platform: 'pinterest', action: 'verify', ok: false, errorCode: 'verify_failed', errorMessage: String(err.message || err).slice(0, 200), live: false, state: 'unknown', id: post.pinId });
    }
  }
}

// Per-pin analytics: GET /pins/<id>/analytics. Best-effort - the endpoint requires
// the analytics scope/Standard access and 7 days of data, so failures degrade to an
// honest ok:false row rather than fabricating metrics.
async function cmdInsights(args) {
  const { plan } = loadPlan(args.plan);
  let token = null;
  try { token = await ensureFreshToken(); } catch (err) { console.log(`[warn] insights: ${err.message}`); return; }
  for (const post of (plan.posts || []).filter(isPinterest)) {
    if (args.only && post.id !== args.only) continue;
    if (!post.pinId) continue;
    try {
      const end = new Date();
      const start = new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);
      const fmt = (d) => d.toISOString().slice(0, 10);
      const data = await api('GET', `/pins/${post.pinId}/analytics`, {
        query: { start_date: fmt(start), end_date: fmt(end), metric_types: 'IMPRESSION,PIN_CLICK,SAVE,OUTBOUND_CLICK' },
        token,
      });
      RUN.results.push({ postId: post.id, platform: 'pinterest', action: 'insights', ok: true, metrics: data, id: post.pinId });
    } catch (err) {
      RUN.results.push({ postId: post.id, platform: 'pinterest', action: 'insights', ok: false, errorCode: 'insights_unavailable', errorMessage: String(err.message || err).slice(0, 200), id: post.pinId });
    }
  }
}

async function cmdDelete(args) {
  if (!args.id) { console.error('[err] delete requires --id <pinId>'); process.exit(2); }
  const token = await ensureFreshToken();
  await api('DELETE', `/pins/${args.id}`, { token });
  RUN.results.push({ platform: 'pinterest', action: 'delete', ok: true, id: String(args.id) });
  console.log(`[ok] deleted Pinterest pin ${args.id}.`);
}

async function cmdProbe() {
  if (!readEnv('PINTEREST_ACCESS_TOKEN') && !readEnv('PINTEREST_REFRESH_TOKEN')) {
    RUN.results.push({ platform: 'pinterest', action: 'probe', ok: false, detail: 'not configured (PINTEREST_ACCESS_TOKEN/PINTEREST_REFRESH_TOKEN missing)' });
    return;
  }
  try {
    const token = await ensureFreshToken();
    const me = await api('GET', '/user_account', { token });
    const expiresAt = Number(readEnv('PINTEREST_TOKEN_EXPIRES_AT') || 0) || null;
    RUN.results.push({ platform: 'pinterest', action: 'probe', ok: true, detail: `connected as ${me.username || me.business_name || '?'}`, tokenExpiresAt: expiresAt });
  } catch (err) {
    RUN.results.push({ platform: 'pinterest', action: 'probe', ok: false, detail: String(err.message || err).slice(0, 200) });
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
  if (resolveMode('pinterest') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'pinterest', command: commandName,
      planPath: typeof args.plan === 'string' ? path.resolve(String(args.plan)) : null,
      only: typeof args.only === 'string' ? args.only : null,
    });
    if (JSON_MODE) process.stdout.write(`${JSON.stringify(envelope)}\n`);
    else console.error(`[mock] pinterest ${commandName}: ${envelope.results.length} result(s)`);
    return;
  }
  const cmd = COMMANDS[commandName];
  if (!cmd) {
    console.error(`Usage: node scripts/pinterest-social.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
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
