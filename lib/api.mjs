// api.mjs - JSON API for the dashboard.
//
// ROUTES is deliberately declarative: test/parity-check.mjs
// parses this table and asserts that every non-GET route names an existing
// MCP tool (mcpTool) - the UI face and the MCP face must ship together.
import { sendJson, readBody, readBodyRaw, errorBody, VERSION, readEnv, writeEnvVars } from './util.mjs';
import { buildId, isBuilding, readUpdateStatus, updateDecision, REPO_ROOT } from './dashboard.mjs';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { loadPlanStore, findCampaign } from './plans.mjs';
import { scanAssets } from './assets.mjs';
import { accountStatus, recordMetaBlock, schedulerRunning } from './accounts.mjs';
import { getActivity, runDueExclusive, setScheduler } from './scheduler.mjs';
import { verifyPost } from './verify.mjs';
import { setCover, clearCover } from './covers.mjs';
import {
  createPost, updatePost, deletePost, approvePost, rejectPost,
  unschedulePost, reschedulePost, markPosted, createCampaign, setCampaignActive,
  tokenRefresh, xUpdateProfile, validateMedia, platformValidate, pendpostHealth, publishPreview, uploadAsset, deleteAsset, renameAsset, setMetaLane,
  clientsOverview,
} from './writes.mjs';
import { brandLint } from './lint.mjs';
import { fetchInsights, getInsights, generateDigest } from './insights.mjs';
import { probeAll } from './health.mjs';
import { getConfig, setConfig, disconnectPlatform } from './config.mjs';
import { resolveMode } from './mode.mjs';
import { clientList } from './mcp.mjs';
import { listClients, setActiveClient, createClient, updateClient, archiveClient } from './clients.mjs';
import { withClient, activeRoot } from './context.mjs';
import { clientRoot, activeClientId } from './multi-client.mjs';
import { getCloudStatus, setCloudEnabled, connectWorkspace, pushApprovedJobs, reconcileAlwaysOnBrands, disconnectWorkspace, signOutWorkspace, consolidateCloudKey, handLocalTokens, migrateToCloud, beginEnableConnect, completeEnableConnect, cloudClients, setClientAlwaysOn, getSubscription, startCheckout, startBillingPortal, setSpendCap, cloudSyncStatus } from './cloud-client.mjs';

// Parses the body and guarantees a plain object - `null`, arrays and scalars
// are valid JSON but would blow up downstream destructuring with a 500.
async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SyntaxError('body must be a JSON object');
  }
  return parsed;
}

// /api/plans/<campaign>/posts/<postId>/cover - the per-post cover override.
const COVER_PATH_RE = /^\/api\/plans\/([a-zA-Z0-9_-]+)\/posts\/([a-zA-Z0-9_-]+)\/cover$/;
// /api/plans/<campaign>/posts - post creation.
const POSTS_PATH_RE = /^\/api\/plans\/([a-zA-Z0-9_-]+)\/posts$/;
// /api/plans/<campaign>/posts/<postId> - one post (update/delete).
const POST_PATH_RE = /^\/api\/plans\/([a-zA-Z0-9_-]+)\/posts\/([a-zA-Z0-9_-]+)$/;
// /api/plans/<campaign>/posts/<postId>/<action> - post actions.
const POST_ACTION_RE = /^\/api\/plans\/([a-zA-Z0-9_-]+)\/posts\/([a-zA-Z0-9_-]+)\/(approve|reject|unschedule|reschedule|mark-posted|verify|validate-media|platform-validate)$/;
// /api/campaigns/<id>/active - manifest toggling.
const CAMPAIGN_ACTIVE_RE = /^\/api\/campaigns\/([a-zA-Z0-9_-]+)\/active$/;
// /api/assets/<name> - one asset (DELETE). The basename charset mirrors
// sanitizeAssetName (a-z 0-9 . _ -, no path segments); sanitizeAssetName is the
// real guard server-side and re-validates the decoded name. Excludes /upload and
// the /rename action so those routes are matched by their own entries first.
const ASSET_NAME_RE = /^\/api\/assets\/([a-zA-Z0-9._-]+)$/;
// /api/assets/<name>/rename - rename one asset (POST, new name in the body).
const ASSET_RENAME_RE = /^\/api\/assets\/([a-zA-Z0-9._-]+)\/rename$/;
// /api/clients/<id> - update one client (PATCH). The slug rule matches
// multi-client.mjs (lowercase alnum, hyphens not leading).
const CLIENT_ID_RE = /^\/api\/clients\/([a-z0-9][a-z0-9-]*)$/;
// /api/clients/<id>/archive - toggle a client's active/archived status.
const CLIENT_ARCHIVE_RE = /^\/api\/clients\/([a-z0-9][a-z0-9-]*)\/archive$/;

const ERROR_STATUS = {
  unknown_campaign: 404, unknown_post: 404, media_missing: 404,
  manifest_error: 503, in_flight: 423, stale_write: 409,
  needs_confirm: 428, not_approved: 409, engine_failure: 500,
};

function sendResult(res, result) {
  if (result.ok) return sendJson(res, 200, result);
  return sendJson(res, ERROR_STATUS[result.code] || 400, result);
}

// The OPTIONAL managed-cloud (pendpost-cloud) routes. A thrown CloudError maps to a
// stable HTTP status; everything else is a 500. The cloud api key and platform
// tokens NEVER reach a response (CloudError messages never carry them). These are
// operator-only ceremonies (they bear the cloud api key), so they are parity-exempt
// in API-CONTRACT.md rather than agent MCP tools.
const CLOUD_ERROR_STATUS = {
  invalid_input: 400, no_api_key: 400, not_configured: 409, disabled: 409,
  manifest_error: 503, http_error: 502, network_error: 502,
  presign_failed: 502, upload_failed: 502,
};
function cloudRoute(impl) {
  return async (req, res) => {
    let body = {};
    if ((req.method || 'GET') !== 'GET') {
      try { body = await readJsonBody(req); } catch { body = {}; }
    }
    try {
      return sendJson(res, 200, { ok: true, ...(await impl(body)) });
    } catch (err) {
      if (err && err.name === 'CloudError') {
        return sendJson(res, CLOUD_ERROR_STATUS[err.code] || 500, errorBody(err.code, err.message));
      }
      return sendJson(res, 500, errorBody('engine_failure', String((err && err.message) || err)));
    }
  };
}

// Body-taking write routes share this shape: parse JSON, merge the path ids,
// call the writes.mjs implementation, map the error code to an HTTP status.
function jsonRoute(re, impl) {
  return async (req, res, url) => {
    const match = url.pathname.replace(/\/+$/, '').match(re);
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, errorBody('invalid_input', 'body must be a JSON object'));
    }
    return sendResult(res, await impl(body, match));
  };
}

// Connect ceremony: platform -> the engine connect command. youtube/linkedin/x and
// pinterest/tiktok mint via an interactive browser OAuth (auth); meta exchanges a
// long-lived System User token (setup-system-user, no browser). idEnv is the
// persisted public client-id key that lets a re-auth (expired token) run with no
// re-entry. The interactive auth lanes that take their app id/secret on FLAGS carry
// `appIdFlag`/`appSecretFlag` (pinterest uses --app-id/--app-secret, tiktok uses
// --client-key/--client-secret); youtube/linkedin/x default to --client-id/--client-secret.
const CONNECT_LANES = {
  youtube: { script: 'yt-social.mjs', cmd: 'auth', interactive: true, idEnv: 'YT_CLIENT_ID' },
  linkedin: { script: 'linkedin-social.mjs', cmd: 'auth', interactive: true, idEnv: 'LINKEDIN_CLIENT_ID' },
  x: { script: 'x-social.mjs', cmd: 'auth', interactive: true, idEnv: 'X_CLIENT_ID' },
  meta: { script: 'meta-social.mjs', cmd: 'setup-system-user', interactive: false },
  pinterest: { script: 'pinterest-social.mjs', cmd: 'auth', interactive: true, idEnv: 'PINTEREST_APP_ID', appIdFlag: '--app-id', appSecretFlag: '--app-secret' },
  tiktok: { script: 'tiktok-social.mjs', cmd: 'auth', interactive: true, idEnv: 'TIKTOK_CLIENT_KEY', appIdFlag: '--client-key', appSecretFlag: '--client-secret' },
};

// STATIC-credential lanes: NO browser OAuth. The operator types the static secrets,
// the handler persists them to the active client's .env (the exact contract env keys
// only, writeEnvVars is whitelist-bounded by THIS caller), then spawns `<script> auth`
// (no flags - it reads the freshly written .env) and the connect-run registry tracks
// the exit code. Each entry maps a request body field -> the .env key it lands in.
// Secret VALUES never reach a log or a response.
const STATIC_LANES = {
  telegram: { script: 'telegram-social.mjs', fields: { botToken: 'TELEGRAM_BOT_TOKEN', channelId: 'TELEGRAM_CHANNEL_ID' } },
  discord: { script: 'discord-social.mjs', fields: { webhookUrl: 'DISCORD_WEBHOOK_URL' } },
  reddit: { script: 'reddit-social.mjs', fields: { redditClientId: 'REDDIT_CLIENT_ID', redditClientSecret: 'REDDIT_CLIENT_SECRET', redditUsername: 'REDDIT_USERNAME', redditPassword: 'REDDIT_PASSWORD' } },
};
const cleanArg = (v) => (typeof v === 'string' ? v.trim() : '');
// A credential value must never carry a newline/NUL (it would corrupt the .env line)
// and must be sanely bounded. Returns an error string or null.
const badArg = (v) => (/[\r\n\0]/.test(v) ? 'value contains a newline' : v.length > 4096 ? 'value too long' : null);

// ---- Connect-run registry (feedback channel for the interactive ceremony) ----
// The interactive OAuth child (startConnect) used to spawn with stdio:'ignore' and
// swallow errors, so a failed connect (browser didn't open, loopback port held by a
// stale child -> EADDRINUSE, Google rejected the client) left the GUI blind and
// spinning. We now capture the child's stdout/stderr tails into a per-(client,
// platform) record and expose it via GET /api/connect/status so the panel can show
// the consent URL (printed on stdout when the browser fails to open) or the failure.
// In-memory only - a fresh process starts idle. The child handle is stashed on the
// record so a retry can SIGTERM a stale child (freeing the loopback port), but it is
// NEVER returned by readConnectStatus.
const connectRuns = new Map();
const runKey = (platform) => `${activeClientId()}:${platform}`;
const CONNECT_TAIL_CAP = 1024; // ~1KB of stdout/stderr kept per stream
const CONNECT_DETAIL_CAP = 200; // failure detail line is bounded
// Connect-output URLs we trust as the consent URL, most-specific host first. The
// engine prints the consent URL on its own line when it cannot open the browser.
const CONNECT_AUTH_HOSTS = ['accounts.google.com', 'www.linkedin.com', 'api.x.com', 'twitter.com', 'x.com'];

// Append `chunk` to `prev` and keep only the last CONNECT_TAIL_CAP chars.
const appendTail = (prev, chunk) => (prev + String(chunk)).slice(-CONNECT_TAIL_CAP);
// The last non-empty line of a captured tail, capped - used as the failure detail.
function lastNonEmptyLine(tail) {
  const lines = String(tail || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, CONNECT_DETAIL_CAP) : '';
}
// Scan accumulated stdout for the consent URL, preferring a known OAuth host.
function scanAuthUrl(text) {
  const urls = String(text || '').match(/https?:\/\/[^\s'"<>)]+/g) || [];
  if (!urls.length) return null;
  for (const host of CONNECT_AUTH_HOSTS) {
    const hit = urls.find((u) => { try { return new URL(u).host === host; } catch { return false; } });
    if (hit) return hit;
  }
  return urls[0];
}

// Begin (or restart) a connect run for the active client + platform. Replaces any
// prior record (a retry starts clean); the child handle is attached later by the
// caller via connectRuns.get(key).child = child.
export function noteConnectStart(platform) {
  connectRuns.set(runKey(platform), {
    state: 'running', detail: null, authUrl: null, at: new Date().toISOString(),
    stdout: '', stderr: '', child: null,
  });
}
// Capture a stdout chunk; once we have not found the consent URL yet, scan the
// accumulated stdout for it (the engine prints it on its own line).
export function noteConnectStdout(platform, chunk) {
  const rec = connectRuns.get(runKey(platform));
  if (!rec) return;
  rec.stdout = appendTail(rec.stdout, chunk);
  if (!rec.authUrl) {
    const url = scanAuthUrl(rec.stdout);
    if (url) rec.authUrl = url;
  }
}
// Capture a stderr chunk (kept for the failure detail line).
export function noteConnectStderr(platform, chunk) {
  const rec = connectRuns.get(runKey(platform));
  if (!rec) return;
  rec.stderr = appendTail(rec.stderr, chunk);
}
// The child exited: code 0 => connected; otherwise failed (unless already connected),
// with detail = the last non-empty stderr line (fallback stdout).
export function noteConnectExit(platform, code) {
  const rec = connectRuns.get(runKey(platform));
  if (!rec) return;
  rec.child = null;
  if (code === 0) { rec.state = 'connected'; return; }
  if (rec.state === 'connected') return;
  rec.state = 'failed';
  rec.detail = lastNonEmptyLine(rec.stderr) || lastNonEmptyLine(rec.stdout) || null;
}
// The child failed to spawn (ENOENT etc.): failed, detail = the (capped) message.
export function noteConnectError(platform, message) {
  const rec = connectRuns.get(runKey(platform));
  if (!rec) return;
  rec.child = null;
  rec.state = 'failed';
  rec.detail = String(message || '').slice(0, CONNECT_DETAIL_CAP) || null;
}
// Public status for the active client + platform. NEVER returns the child handle or
// the raw stdout/stderr tails - only { state, detail, authUrl, at }. The authUrl
// carries only the public client_id (the engine never prints client_secret).
export function readConnectStatus(platform) {
  const rec = connectRuns.get(runKey(platform));
  if (!rec) return { state: 'idle', detail: null, authUrl: null, at: null };
  return { state: rec.state, detail: rec.detail, authUrl: rec.authUrl, at: rec.at };
}

// Kick off the SAME engine connect command the `pendpost connect` CLI runs, against
// the active client (PENDPOST_ROOT=activeRoot()). Fire-and-forget like /api/dashboard-update:
// the engine writes the .env (the server NEVER persists the secret), opens the browser for
// OAuth lanes, and the GUI polls /api/health/recheck for the outcome. Returns { error } or
// { interactive }. Operator-only (no mcpTool) - minting a credential is never an agent action.
// Spawn the engine connect command for `platform` with `args` against the active
// client (PENDPOST_ROOT=activeRoot()), wiring stdout/stderr into the connect-run
// registry. Shared by the interactive and static paths. `interactive` flags whether
// the lane opens a browser (the GUI shows the consent URL) vs runs to completion.
function spawnConnect(platform, script, args, interactive) {
  // A stale child from a prior attempt still holds the loopback OAuth port; SIGTERM
  // it so a retry can rebind (otherwise the engine fails with EADDRINUSE).
  const key = runKey(platform);
  const prior = connectRuns.get(key);
  if (prior && prior.child && prior.child.exitCode === null && prior.child.signalCode === null) {
    try { prior.child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  // spawn (not execFile): an interactive auth runs for minutes and prints freely;
  // execFile's output-buffer cap would kill the child. We pipe stdout/stderr into the
  // connect-run registry so the GUI (GET /api/connect/status) can surface the consent
  // URL or a failure - the old stdio:'ignore' left it blind. The engine still
  // auto-opens the browser, so the user needs no terminal.
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts', script), ...args], {
    cwd: REPO_ROOT, env: { ...process.env, PENDPOST_ROOT: activeRoot() }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  noteConnectStart(platform);
  connectRuns.get(key).child = child; // stashed so a retry can SIGTERM it; NEVER returned by readConnectStatus
  child.stdout.on('data', (d) => noteConnectStdout(platform, d.toString()));
  child.stderr.on('data', (d) => noteConnectStderr(platform, d.toString()));
  child.on('error', (e) => noteConnectError(platform, e.message)); // ENOENT etc. now reach the GUI
  child.on('exit', (code) => noteConnectExit(platform, code));
  // No kill-timeout: the OAuth legitimately runs for minutes while the user consents.
  child.unref();
  return { interactive };
}

function startConnect(body) {
  const platform = cleanArg(body && body.platform).toLowerCase();
  const lane = CONNECT_LANES[platform];
  const staticLane = STATIC_LANES[platform];
  if (!lane && !staticLane) {
    return { error: errorBody('invalid_input', `unknown platform "${platform}" (expected youtube | meta | linkedin | x | pinterest | tiktok | telegram | discord | reddit)`) };
  }

  // --- STATIC-credential lanes (telegram | discord | reddit): no browser OAuth. ---
  // Validate every provided field, PERSIST the contract's env keys to the active
  // client's .env (writeEnvVars is whitelist-bounded by the keys we pass here), then
  // spawn `auth` (no flags - it reads the freshly written .env). Secrets never logged.
  if (staticLane) {
    const env = {};
    for (const [field, envKey] of Object.entries(staticLane.fields)) {
      const v = cleanArg(body[field]);
      if (!v) return { error: errorBody('invalid_input', `${platform} needs ${field}`) };
      const e = badArg(v); if (e) return { error: errorBody('invalid_input', `${field} ${e}`) };
      env[envKey] = v;
    }
    try { writeEnvVars(env); } catch { return { error: errorBody('invalid_input', 'could not persist credentials') }; }
    return spawnConnect(platform, staticLane.script, ['auth'], false);
  }

  // --- INTERACTIVE OAuth lanes (youtube | linkedin | x | meta | pinterest | tiktok) ---
  const args = [lane.cmd];
  const push = (flag, raw) => { const v = cleanArg(raw); if (!v) return null; const e = badArg(v); if (e) return `${flag.replace('--', '')} ${e}`; args.push(flag, v); return null; };
  if (platform === 'meta') {
    const token = cleanArg(body.systemUserToken);
    if (!token) return { error: errorBody('invalid_input', 'meta needs a System User token (systemUserToken)') };
    for (const [field, flag] of [['systemUserToken', '--system-user-token'], ['appId', '--app-id'], ['appSecret', '--app-secret'], ['pageId', '--page-id']]) {
      const e = push(flag, body[field]); if (e) return { error: errorBody('invalid_input', e) };
    }
  } else {
    // pinterest/tiktok read their app id/secret under different flag names than the
    // youtube/linkedin/x default (--client-id/--client-secret); the lane declares them.
    const idFlag = lane.appIdFlag || '--client-id';
    const secretFlag = lane.appSecretFlag || '--client-secret';
    const e1 = push(idFlag, body.oauthClientId); if (e1) return { error: errorBody('invalid_input', e1) };
    const e2 = push(secretFlag, body.clientSecret); if (e2) return { error: errorBody('invalid_input', e2) };
    // First connect needs creds in the body; a re-auth can rely on the persisted client id.
    if (!cleanArg(body.oauthClientId) && !cleanArg(body.clientSecret) && !readEnv(lane.idEnv)) {
      return { error: errorBody('invalid_input', `${platform} needs a Client ID and Client Secret to connect`) };
    }
  }
  return spawnConnect(platform, lane.script, args, lane.interactive);
}

const ROUTES = [
  // Cover routes precede the bare /api/plans/<id> prefix route: Express-style
  // declaration order - /:param/literal before bare /:param, or the campaign
  // lookup absorbs the cover path.
  {
    method: 'POST', prefix: '/api/plans/', mcpTool: 'set_cover',
    test: (route) => COVER_PATH_RE.test(route),
    handler: async (req, res, url) => {
      const [, campaign, postId] = url.pathname.replace(/\/+$/, '').match(COVER_PATH_RE);
      const contentType = String(req.headers['content-type'] || '');
      let args;
      if (/^image\//i.test(contentType)) {
        // Raw binary upload (UPLOAD-1): bytes go through readBodyRaw - the
        // utf8 readBody would corrupt them. Format is sniffed server-side.
        let buf;
        try {
          buf = await readBodyRaw(req);
        } catch (err) {
          return sendJson(res, 413, errorBody('invalid_input', err.message));
        }
        args = { campaign, postId, base64: buf.toString('base64') };
      } else {
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return sendJson(res, 400, errorBody('invalid_input', 'body must be a JSON object (frameSec | filePath | base64) or a raw image/* upload'));
        }
        args = { campaign, postId, frameSec: body.frameSec, filePath: body.filePath, base64: body.base64 };
      }
      return sendResult(res, await setCover(args));
    },
  },
  {
    method: 'DELETE', prefix: '/api/plans/', mcpTool: 'clear_cover',
    test: (route) => COVER_PATH_RE.test(route),
    handler: async (req, res, url) => {
      const [, campaign, postId] = url.pathname.replace(/\/+$/, '').match(COVER_PATH_RE);
      return sendResult(res, await clearCover({ campaign, postId }));
    },
  },
  // --- Phase D write matrix (every route's MCP twin ships in mcp.mjs) ---
  {
    method: 'POST', prefix: '/api/plans/', mcpTool: 'plan_create_post',
    test: (route) => POSTS_PATH_RE.test(route),
    handler: jsonRoute(POSTS_PATH_RE, (body, m) => createPost({ campaign: m[1], post: body.post, actor: body.actor })),
  },
  {
    method: 'PATCH', prefix: '/api/plans/', mcpTool: 'plan_update_post',
    test: (route) => POST_PATH_RE.test(route),
    handler: jsonRoute(POST_PATH_RE, (body, m) => updatePost({ campaign: m[1], postId: m[2], ifRev: body.ifRev, fields: body.fields, actor: body.actor })),
  },
  {
    method: 'DELETE', prefix: '/api/plans/', mcpTool: 'plan_delete_post',
    test: (route) => POST_PATH_RE.test(route),
    handler: jsonRoute(POST_PATH_RE, (body, m) => deletePost({ campaign: m[1], postId: m[2], force: body.force, actor: body.actor })),
  },
  {
    method: 'POST', prefix: '/api/plans/', mcpTool: 'approve_post',
    test: (route) => POST_ACTION_RE.test(route) && route.endsWith('/approve'),
    handler: jsonRoute(POST_ACTION_RE, (body, m) => approvePost({ campaign: m[1], postId: m[2], actor: body.actor, note: body.note })),
  },
  {
    method: 'POST', prefix: '/api/plans/', mcpTool: 'reject_post',
    test: (route) => POST_ACTION_RE.test(route) && route.endsWith('/reject'),
    handler: jsonRoute(POST_ACTION_RE, (body, m) => rejectPost({ campaign: m[1], postId: m[2], actor: body.actor, note: body.note })),
  },
  {
    method: 'POST', prefix: '/api/plans/', mcpTool: 'unschedule',
    test: (route) => POST_ACTION_RE.test(route) && route.endsWith('/unschedule'),
    handler: jsonRoute(POST_ACTION_RE, (body, m) => unschedulePost({ campaign: m[1], postId: m[2], confirm: body.confirm, actor: body.actor })),
  },
  {
    method: 'POST', prefix: '/api/plans/', mcpTool: 'reschedule',
    test: (route) => POST_ACTION_RE.test(route) && route.endsWith('/reschedule'),
    handler: jsonRoute(POST_ACTION_RE, (body, m) => reschedulePost({ campaign: m[1], postId: m[2], scheduledAt: body.scheduledAt, confirm: body.confirm, actor: body.actor })),
  },
  {
    method: 'POST', prefix: '/api/plans/', mcpTool: 'mark_posted',
    test: (route) => POST_ACTION_RE.test(route) && route.endsWith('/mark-posted'),
    handler: jsonRoute(POST_ACTION_RE, (body, m) => markPosted({ campaign: m[1], postId: m[2], actor: body.actor, externalUrl: body.externalUrl })),
  },
  {
    method: 'POST', prefix: '/api/plans/', mcpTool: 'verify_post',
    test: (route) => POST_ACTION_RE.test(route) && route.endsWith('/verify'),
    handler: jsonRoute(POST_ACTION_RE, (body, m) => verifyPost({ campaign: m[1], postId: m[2], actor: body.actor })),
  },
  {
    method: 'GET', prefix: '/api/plans/', mcpTool: 'validate_media',
    test: (route) => POST_ACTION_RE.test(route) && route.endsWith('/validate-media'),
    handler: async (req, res, url) => {
      const [, campaign, postId] = url.pathname.replace(/\/+$/, '').match(POST_ACTION_RE);
      return sendResult(res, await validateMedia({ campaign, postId }));
    },
  },
  {
    method: 'GET', prefix: '/api/plans/', mcpTool: 'platform_validate',
    test: (route) => POST_ACTION_RE.test(route) && route.endsWith('/platform-validate'),
    handler: async (req, res, url) => {
      const [, campaign, postId] = url.pathname.replace(/\/+$/, '').match(POST_ACTION_RE);
      return sendResult(res, await platformValidate({ campaign, postId }));
    },
  },
  {
    method: 'POST', path: '/api/campaigns', mcpTool: 'campaign_create',
    handler: jsonRoute(/^.*$/, (body) => createCampaign({ id: body.id, note: body.note, timezone: body.timezone, folder: body.folder, actor: body.actor })),
  },
  {
    method: 'POST', prefix: '/api/campaigns/', mcpTool: 'campaign_set_active',
    test: (route) => CAMPAIGN_ACTIVE_RE.test(route),
    handler: jsonRoute(CAMPAIGN_ACTIVE_RE, (body, m) => setCampaignActive({ id: m[1], active: body.active, actor: body.actor })),
  },
  {
    method: 'POST', path: '/api/lint', mcpTool: 'brand_lint',
    handler: jsonRoute(/^.*$/, (body) => Promise.resolve(brandLint({ text: body.text, platform: body.platform }))),
  },
  {
    method: 'POST', path: '/api/accounts/linkedin/refresh', mcpTool: 'token_refresh',
    handler: jsonRoute(/^.*$/, () => tokenRefresh({ platform: 'linkedin' })),
  },
  {
    // X (Twitter) has the same programmatic refresh as LinkedIn (the engine's
    // REFRESH_ENGINES carries both); both faces map to the one token_refresh tool,
    // which already dispatches by platform. No new tool needed (parity stays 1 tool,
    // 2 routes - the tool is reachable from the API face, the rule parity enforces).
    method: 'POST', path: '/api/accounts/x/refresh', mcpTool: 'token_refresh',
    handler: jsonRoute(/^.*$/, () => tokenRefresh({ platform: 'x' })),
  },
  {
    // Edit the connected X profile (name/bio/url/location/image/banner) via the
    // v1.1 account/* path. Fail-closed in lockstep with the MCP twin
    // (lib/mcp.mjs x_update_profile): a REAL account change, so a missing/false
    // confirm short-circuits BEFORE the engine; probe:true is the read-only
    // access-tier check and needs no confirm. image/banner are local file paths.
    method: 'POST', path: '/api/accounts/x/profile', mcpTool: 'x_update_profile',
    handler: async (req, res) => {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, errorBody('invalid_input', 'body must be valid JSON'));
      }
      if (body.probe !== true && body.confirm !== true) {
        return sendJson(res, 428, errorBody('needs_confirm', 'x_update_profile makes a REAL change to the live X profile - pass confirm: true (use probe: true for a read-only access-tier check).'));
      }
      return sendResult(res, await xUpdateProfile({
        name: typeof body.name === 'string' ? body.name : undefined,
        bio: typeof body.bio === 'string' ? body.bio : undefined,
        url: typeof body.url === 'string' ? body.url : undefined,
        location: typeof body.location === 'string' ? body.location : undefined,
        image: typeof body.image === 'string' ? body.image : undefined,
        banner: typeof body.banner === 'string' ? body.banner : undefined,
        probe: body.probe === true,
        actor: typeof body.actor === 'string' ? body.actor : 'ui',
      }));
    },
  },
  {
    // Optional body.platform scopes the recheck to one lane (the other three are
    // not spawned); absent, every lane is re-probed. force:true always bypasses
    // the 1h auto-floor for a manual recheck. No new route - the same twin as the
    // health_recheck MCP tool.
    method: 'POST', path: '/api/health/recheck', mcpTool: 'health_recheck',
    handler: jsonRoute(/^.*$/, (body) => probeAll({ force: true, platform: typeof body.platform === 'string' ? body.platform : null })),
  },
  {
    method: 'GET', path: '/api/config', mcpTool: 'config_get',
    handler: (req, res) => sendResult(res, getConfig()),
  },
  {
    method: 'POST', path: '/api/config', mcpTool: 'config_set',
    handler: jsonRoute(/^.*$/, (body) => setConfig({ ifRev: body.ifRev, actor: body.actor, set: body.set })),
  },
  {
    // OPERATOR-ONLY platform disconnect (mcpTool: null, parity-exempt in API-CONTRACT.md):
    // clears EVERY stored credential for the platform from the active client's .env - the
    // inverse of the connect ceremony. Bearing/clearing a credential is a human dashboard
    // action, deliberately NOT an agent tool (same stance as /api/connect). Fail-closed:
    // needs confirm:true (-> 428 via the STATUS map).
    method: 'POST', path: '/api/disconnect', mcpTool: null,
    handler: jsonRoute(/^.*$/, (body) => disconnectPlatform({ platform: body.platform, confirm: body.confirm, actor: body.actor })),
  },
  {
    // OPERATOR-ONLY connect ceremony (mcpTool: null, parity-exempt in API-CONTRACT.md):
    // minting a platform credential is a human dashboard action that bears the user's
    // client secret - deliberately NOT an agent tool. It just kicks off the engine's
    // existing connect command (engine writes the active client's .env); the GUI then
    // polls /api/health/recheck until the lane flips Connected.
    method: 'POST', path: '/api/connect', mcpTool: null,
    handler: async (req, res) => {
      let body;
      try { body = await readJsonBody(req); } catch { return sendJson(res, 400, errorBody('invalid_input', 'body must be a JSON object')); }
      const result = startConnect(body);
      if (result.error) return sendJson(res, 400, result.error);
      return sendJson(res, 200, { ok: true, started: true, interactive: result.interactive });
    },
  },
  {
    // Feedback channel for the interactive connect ceremony (operator-only, like
    // POST /api/connect - reading a connect run is not an agent action, mcpTool:null).
    // The GUI polls this while the OAuth child runs: it surfaces the consent URL
    // (when the browser failed to open) or the failure (EADDRINUSE, rejected client)
    // instead of spinning blind. Per active client + ?platform; never exposes the
    // child handle or any secret.
    method: 'GET', path: '/api/connect/status', mcpTool: null,
    handler: (req, res, url) => {
      const platform = cleanArg(url.searchParams.get('platform')).toLowerCase();
      if (!CONNECT_LANES[platform] && !STATIC_LANES[platform]) {
        return sendJson(res, 400, errorBody('invalid_input', `unknown platform "${platform}" (expected youtube | meta | linkedin | x | pinterest | tiktok | telegram | discord | reddit)`));
      }
      return sendJson(res, 200, { ok: true, ...readConnectStatus(platform) });
    },
  },
  {
    method: 'GET', path: '/api/pendpost-health', mcpTool: 'pendpost_health',
    handler: (req, res, url) => {
      const horizon = Number(url.searchParams.get('horizon')) || 5;
      return sendResult(res, pendpostHealth({ horizon }));
    },
  },
  {
    // Read-only publish preview / dry-run (C3). Modeled on pendpost-health: clamp
    // horizon 1..20 (default 5) - publishPreview re-clamps too. The dispatcher
    // already binds this request to the active (or ?clientId) client root, so the
    // preview is per-client scoped without a body. Describes; never publishes.
    method: 'GET', path: '/api/preview', mcpTool: 'publish_preview',
    handler: async (req, res, url) => {
      const horizon = Number(url.searchParams.get('horizon')) || 5;
      const campaign = url.searchParams.get('campaign') || null;
      return sendResult(res, await publishPreview({ horizon, campaign }));
    },
  },
  // --- multi-client ---
  // Reads are safe for agents (client_list has an MCP twin). The four non-GET
  // client-admin routes below are OPERATOR-ONLY (no mcpTool, parity-exempted):
  // client lifecycle + active-context switching are dashboard actions,
  // deliberately not agent-accessible.
  {
    method: 'GET', path: '/api/clients', mcpTool: 'client_list',
    handler: (req, res) => sendJson(res, 200, clientList()),
  },
  {
    // C4: read-only cross-client roll-up (GET, so parity needs no exemption - it
    // names its mcpTool clients_overview, the new READ tool). This route is
    // matched by the isClientAdmin prefix in handleApi and therefore runs
    // UNSCOPED - intentional: clientsOverview() iterates the registry and binds
    // EACH client's read inside its own withClient(clientRoot(id), ...) scope, so
    // the dispatcher must NOT pre-bind one client. Clamp horizon 1..20 (default
    // 20); clientsOverview re-clamps via pendpostHealth. Describes; never writes.
    method: 'GET', path: '/api/clients/overview', mcpTool: 'clients_overview',
    handler: (req, res, url) => {
      const horizon = Number(url.searchParams.get('horizon')) || 20;
      return sendJson(res, 200, clientsOverview({ horizon }));
    },
  },
  {
    method: 'POST', path: '/api/clients/active', mcpTool: 'client_set_active',
    handler: jsonRoute(/^.*$/, (body) => setActiveClient({ id: body.id, actor: body.actor })),
  },
  {
    method: 'POST', path: '/api/clients', mcpTool: 'client_create',
    handler: jsonRoute(/^.*$/, (body) => createClient({ id: body.id, displayName: body.displayName, logo: body.logo, accent: body.accent, timezone: body.timezone, actor: body.actor })),
  },
  {
    method: 'PATCH', prefix: '/api/clients/', mcpTool: 'client_update',
    test: (route) => CLIENT_ID_RE.test(route),
    handler: jsonRoute(CLIENT_ID_RE, (body, m) => updateClient({ id: m[1], ifRev: body.ifRev, displayName: body.displayName, logo: body.logo, accent: body.accent, timezone: body.timezone, actor: body.actor })),
  },
  {
    method: 'POST', prefix: '/api/clients/', mcpTool: 'client_archive',
    test: (route) => CLIENT_ARCHIVE_RE.test(route),
    handler: jsonRoute(CLIENT_ARCHIVE_RE, (body, m) => archiveClient({ id: m[1], actor: body.actor })),
  },
  // --- Phase E insights ---
  {
    method: 'GET', path: '/api/insights', mcpTool: null,
    handler: (req, res) => sendResult(res, getInsights()),
  },
  {
    method: 'POST', path: '/api/insights/fetch', mcpTool: 'fetch_insights',
    handler: jsonRoute(/^.*$/, (body) => fetchInsights({ campaign: typeof body.campaign === 'string' ? body.campaign : null })),
  },
  {
    method: 'GET', path: '/api/digest', mcpTool: 'generate_digest',
    handler: (req, res) => sendResult(res, generateDigest()),
  },
  {
    method: 'GET', path: '/api/health', mcpTool: null,
    handler: (req, res) => {
      const { campaigns, manifestError } = loadPlanStore({ includePosts: false });
      // Overall mock/live for the bug-report prefill in the Help & feedback dialog:
      // a forced PENDPOST_MODE wins, else live if any core lane resolves live.
      const forcedMode = String(process.env.PENDPOST_MODE || '').trim().toLowerCase();
      const overallMode = (forcedMode === 'live' || forcedMode === 'mock')
        ? forcedMode
        : (['meta', 'linkedin', 'youtube', 'x'].some((p) => resolveMode(p) === 'live') ? 'live' : 'mock');
      sendJson(res, 200, {
        ok: true,
        version: VERSION,
        // Host facts the browser cannot read, surfaced so the feedback dialog can
        // prefill a bug report (localhost single-user app; never any credential).
        node: process.version,
        os: `${process.platform} ${os.release()}`,
        mode: overallMode,
        now: new Date().toISOString(),
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        campaigns: campaigns.length,
        manifestError,
        schedulerRunning: schedulerRunning(),
        // Dashboard build status the SPA polls: buildId changes when a background
        // rebuild swaps in a new bundle (-> "update available"); building is true
        // while a rebuild runs (-> "preparing update" indicator). Both read-only.
        buildId: buildId(),
        building: isBuilding(),
        // GitHub update status (Stage D), read from the periodic git-check.
        // available = upstream has commits we lack; canPull = a clean fast-forward
        // is possible (the one-click "Update" only shows then). Safe defaults
        // (not available) on a non-git install. reason explains a blocked pull.
        update: (() => { const s = readUpdateStatus(); const d = updateDecision(s); return { available: d.offer, canPull: d.canPull, ahead: s.ahead, branch: s.branch, reason: d.reason }; })(),
      });
    },
  },
  {
    // One-click GitHub update: fast-forward pull + rebuild, kicked off in the
    // background (the SPA then watches buildId via /api/health). UI/OPS-ONLY by
    // design (exempted in API-CONTRACT.md): an agent must never pull or rebuild
    // the operator's checkout. SAFE: rejects unless the status shows a clean,
    // fast-forwardable tree, and scripts/dashboard-build.mjs re-guards live with
    // `git pull --ff-only` (which can never clobber local commits).
    method: 'POST', path: '/api/dashboard-update', mcpTool: null,
    handler: (req, res) => {
      const s = readUpdateStatus();
      const d = updateDecision(s);
      if (!d.offer) return sendJson(res, 200, { ok: true, started: false, reason: d.reason });
      if (!d.canPull) return sendJson(res, 400, errorBody('invalid_input', `cannot fast-forward (${d.reason}) - resolve in a terminal`, { reason: d.reason }));
      execFile(process.execPath, [path.join(REPO_ROOT, 'scripts', 'dashboard-build.mjs'), 'pull-build'], { cwd: REPO_ROOT }, () => {});
      return sendJson(res, 200, { ok: true, started: true });
    },
  },
  {
    method: 'GET', path: '/api/plans', mcpTool: 'plan_list',
    handler: (req, res) => {
      const { campaigns, manifestError } = loadPlanStore();
      sendJson(res, 200, { campaigns, manifestError, schedulerRunning: schedulerRunning() });
    },
  },
  {
    method: 'GET', prefix: '/api/plans/', mcpTool: 'plan_get',
    handler: (req, res, url, route) => {
      let id;
      try {
        id = decodeURIComponent(url.pathname.replace(/\/+$/, '').slice(route.prefix.length));
      } catch {
        return sendJson(res, 404, errorBody('unknown_campaign', 'campaign id is not valid percent-encoding'));
      }
      const { campaign, manifestError } = findCampaign(id);
      if (campaign) return sendJson(res, 200, campaign);
      if (manifestError) return sendJson(res, 503, errorBody('manifest_error', manifestError));
      return sendJson(res, 404, errorBody('unknown_campaign', `unknown campaign: ${id}`));
    },
  },
  {
    method: 'POST', path: '/api/assets/upload', mcpTool: 'asset_upload',
    handler: async (req, res, url) => {
      // Raw binary body (video/* or image/*); filename + actor ride the query
      // string (the CORS header allowlist is fixed, so no custom upload headers).
      const filename = url.searchParams.get('filename');
      const actor = url.searchParams.get('actor') || 'owner';
      let buf;
      try {
        buf = await readBodyRaw(req, 200 * 1024 * 1024);
      } catch (err) {
        return sendJson(res, 413, errorBody('invalid_input', err.message));
      }
      // Pass the raw readBodyRaw Buffer straight through - no base64 encode/decode
      // round-trip (C8). The MCP face keeps its base64/filePath branches.
      return sendResult(res, await uploadAsset({ filename, bytes: buf, actor }));
    },
  },
  {
    method: 'GET', path: '/api/assets', mcpTool: 'assets_list',
    handler: async (req, res) => sendJson(res, 200, await scanAssets()),
  },
  // C2: rename one asset (POST, new name in the body). Declared BEFORE the bare
  // DELETE /api/assets/<name> so the /rename action is matched first (the bare
  // name regex ends at the name and never absorbs /rename anyway, but keeping the
  // more-specific route first mirrors the cover-before-bare-plan declaration).
  {
    method: 'POST', prefix: '/api/assets/', mcpTool: 'rename_asset',
    test: (route) => ASSET_RENAME_RE.test(route),
    handler: jsonRoute(ASSET_RENAME_RE, (body, m) => renameAsset({ file: decodeURIComponent(m[1]), toName: body.toName, confirm: body.confirm, actor: body.actor })),
  },
  // C2: delete one asset (DELETE; actor + confirm ride the JSON body, modeled on
  // the clear_cover DELETE handler). In-use-protected + confirm-gated in
  // writes.mjs#deleteAsset; needs_confirm -> 428 via the STATUS map.
  {
    method: 'DELETE', prefix: '/api/assets/', mcpTool: 'delete_asset',
    test: (route) => ASSET_NAME_RE.test(route),
    handler: jsonRoute(ASSET_NAME_RE, (body, m) => deleteAsset({ file: decodeURIComponent(m[1]), confirm: body.confirm, actor: body.actor })),
  },
  {
    method: 'GET', path: '/api/accounts', mcpTool: 'account_status',
    handler: (req, res) => sendJson(res, 200, accountStatus()),
  },
  {
    method: 'GET', path: '/api/activity', mcpTool: 'activity_log',
    handler: (req, res, url) => {
      const limit = Number(url.searchParams.get('limit')) || 100;
      sendJson(res, 200, { activity: getActivity(limit), schedulerRunning: schedulerRunning() });
    },
  },
  {
    method: 'POST', path: '/api/run/publish-due', mcpTool: 'publish_due_run',
    handler: async (req, res) => {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, errorBody('invalid_input', 'body must be valid JSON'));
      }
      // Fail-closed, in lockstep with the MCP twin (lib/mcp.mjs publish_due_run):
      // this route performs REAL publishes, so a missing/false confirm must
      // short-circuit BEFORE runDueExclusive. The dashboard's human "Check now"
      // click is the confirmation (app/src/lib/api.js posts confirm:true).
      if (body.confirm !== true) {
        return sendJson(res, 428, errorBody('needs_confirm', 'publish_due_run performs REAL publishes - pass confirm: true (and only on the owner\'s explicit instruction).'));
      }
      const result = await runDueExclusive(typeof body.actor === 'string' ? body.actor : 'ui', {
        campaign: typeof body.campaign === 'string' ? body.campaign : null,
        postId: typeof body.postId === 'string' ? body.postId : null,
      });
      if (!result.ok) {
        const status = result.code === 'in_flight' ? 423 : 503;
        return sendJson(res, status, errorBody(result.code, result.message, result.retryAfter ? { retryAfter: result.retryAfter } : {}));
      }
      return sendJson(res, 200, result);
    },
  },
  {
    method: 'POST', path: '/api/scheduler', mcpTool: 'scheduler_set',
    handler: async (req, res) => {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, errorBody('invalid_input', 'body must be valid JSON'));
      }
      if (typeof body.running !== 'boolean') {
        return sendJson(res, 400, errorBody('invalid_input', 'running must be a boolean'));
      }
      return sendJson(res, 200, setScheduler(body.running));
    },
  },
  {
    method: 'POST', path: '/api/state/meta-block', mcpTool: 'pendpost_record_block',
    handler: async (req, res) => {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, errorBody('invalid_input', 'body must be valid JSON'));
      }
      const result = recordMetaBlock(body);
      if (!result.ok) return sendJson(res, 400, result);
      return sendJson(res, 200, result);
    },
  },
  {
    // C1: set the Meta publishing lane's cadence cap and/or pause/resume the
    // lane. The whole-file read-merge-write lives in writes.mjs#setMetaLane; the
    // handler runs inside the per-request client root (handleApi binds it).
    method: 'POST', path: '/api/state/meta-lane', mcpTool: 'meta_lane_set',
    handler: async (req, res) => {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, errorBody('invalid_input', 'body must be valid JSON'));
      }
      return sendResult(res, await setMetaLane(body));
    },
  },
  {
    // GET /api/cloud - the managed-cloud status (enabled + baseUrl + workspaceId +
    // api-key PRESENCE only) plus `sync`, the guarantee roll-up driving the header
    // dot (green: every approved cloud-lane post is confirmed on the cloud; yellow:
    // push pending; red: broken). Pure local read - never returns a key or token,
    // never blocks on the network; sync is null when the brand is not cloud-managed.
    method: 'GET', path: '/api/cloud', mcpTool: null,
    handler: async (req, res) => {
      let sync = null;
      try { sync = cloudSyncStatus(); } catch { /* the dot degrades to null, never a 500 */ }
      return sendJson(res, 200, { ok: true, ...getCloudStatus(), sync });
    },
  },
  {
    // POST /api/cloud/connect - verify + persist { enabled, baseUrl, workspaceId } to
    // cloud.json. The api key stays in .env; it is never accepted here.
    method: 'POST', path: '/api/cloud/connect', mcpTool: null,
    handler: cloudRoute((body) => connectWorkspace({ baseUrl: body.baseUrl, workspaceId: body.workspaceId })),
  },
  {
    // POST /api/cloud/enabled - pause/resume pushing without losing the connection.
    method: 'POST', path: '/api/cloud/enabled', mcpTool: null,
    handler: cloudRoute((body) => {
      if (typeof body.enabled !== 'boolean') throw Object.assign(new Error('enabled must be a boolean'), { name: 'CloudError', code: 'invalid_input' });
      return setCloudEnabled(body.enabled);
    }),
  },
  {
    // POST /api/cloud/push - push the already-approved, due jobs to the cloud runtime.
    method: 'POST', path: '/api/cloud/push', mcpTool: null,
    handler: cloudRoute(() => pushApprovedJobs()),
  },
  {
    // POST /api/cloud/reconcile - the PULL inverse of push: poll the cloud's terminal
    // results and reconcile every always-on brand's plan (write minted ids, clear
    // "overdue"). The "Sync now" button. Idempotent; a refusal never mutates the plan.
    method: 'POST', path: '/api/cloud/reconcile', mcpTool: null,
    handler: cloudRoute(() => reconcileAlwaysOnBrands()),
  },
  {
    // GET /api/cloud/clients - every local client with its per-brand always-on + the
    // install-global connection summary (the "cloud clients" view). Read-only.
    method: 'GET', path: '/api/cloud/clients', mcpTool: null,
    handler: async (req, res) => sendJson(res, 200, cloudClients()),
  },
  {
    // POST /api/cloud/clients/always-on - toggle one client's always-on (body:
    // {clientId, alwaysOn}). Sets the local brand flag + tells the cloud which brand the
    // worker fires; turning ON also pushes that client's approved jobs. Operator-only.
    method: 'POST', path: '/api/cloud/clients/always-on', mcpTool: null,
    handler: cloudRoute((body) => {
      if (typeof body.alwaysOn !== 'boolean') throw Object.assign(new Error('alwaysOn must be a boolean'), { name: 'CloudError', code: 'invalid_input' });
      return setClientAlwaysOn(body.clientId, body.alwaysOn);
    }),
  },
  {
    // GET /api/cloud/subscription - the metered subscription view (status + usage + the
    // entitlement action) proxied from the cloud. Read-only; drives the in-app meter.
    method: 'GET', path: '/api/cloud/subscription', mcpTool: null,
    handler: cloudRoute(() => getSubscription()),
  },
  {
    // POST /api/cloud/checkout - open a Stripe Checkout to subscribe to a tier (body:
    // {plan, interval}). Returns the url AND opens the operator's browser. Operator-only.
    method: 'POST', path: '/api/cloud/checkout', mcpTool: null,
    handler: cloudRoute(async (body) => {
      const { url } = await startCheckout({ plan: body.plan, interval: body.interval });
      if (url) execFile('open', [url], () => {});
      return { url };
    }),
  },
  {
    // POST /api/cloud/spend-cap - set (or clear, with null) the overage spend cap (body:
    // {cents}). The cap governs overage only; once reached, extra posts pause. Operator-only.
    method: 'POST', path: '/api/cloud/spend-cap', mcpTool: null,
    handler: cloudRoute((body) => setSpendCap(body.cents)),
  },
  {
    // POST /api/cloud/billing-portal - open the Stripe billing portal (manage plan,
    // payment method, invoices, cancel). Returns the url AND opens the browser. Operator-only.
    method: 'POST', path: '/api/cloud/billing-portal', mcpTool: null,
    handler: cloudRoute(async () => {
      const { url } = await startBillingPortal();
      if (url) execFile('open', [url], () => {});
      return { url };
    }),
  },
  {
    // POST /api/cloud/eject - disconnect from the cloud and return to self-host: fetch the
    // re-auth checklist, THEN clear the local connection + remove the api key, returning the
    // bundle so the UI can show what to re-mint locally before it routes back to the off view.
    method: 'POST', path: '/api/cloud/eject', mcpTool: null,
    handler: cloudRoute(() => disconnectWorkspace()),
  },
  {
    // POST /api/cloud/sign-out - the LIGHTWEIGHT "sign out / switch account": clear the
    // local connection + remove the install-global api key, WITHOUT the heavy eject
    // ceremony (no re-auth checklist, platform tokens left intact). Reversible: sign back
    // in via the loopback handshake. Operator-only.
    method: 'POST', path: '/api/cloud/sign-out', mcpTool: null,
    handler: cloudRoute(() => signOutWorkspace()),
  },
  {
    // POST /api/cloud/hand-tokens - seal the local .env platform tokens into the
    // cloud vault (the frictionless migration; no manual re-entry). Operator-only.
    method: 'POST', path: '/api/cloud/hand-tokens', mcpTool: null,
    handler: cloudRoute(() => handLocalTokens()),
  },
  {
    // POST /api/cloud/migrate - one command: connect (if baseUrl+workspaceId) + seal
    // the local tokens into the vault + push the approved jobs. Operator-only.
    method: 'POST', path: '/api/cloud/migrate', mcpTool: null,
    handler: cloudRoute((body) => migrateToCloud({ baseUrl: body.baseUrl, workspaceId: body.workspaceId })),
  },
  {
    // POST /api/cloud/enable/start - the one-click "enable always-on": mint a CSRF
    // state, open the OS browser to the cloud sign-in page, and return the auth url
    // (also shown in the UI as a fallback link). No key is ever typed. Operator-only.
    method: 'POST', path: '/api/cloud/enable/start', mcpTool: null,
    handler: cloudRoute(() => {
      const { authUrl } = beginEnableConnect();
      // Best-effort: open the operator's default browser. The UI also shows the url.
      execFile('open', [authUrl], () => {});
      return { authUrl };
    }),
  },
  {
    // GET /api/cloud/enable/callback - the loopback redirect target. Verifies the CSRF
    // state, claims the api key over TLS, writes .env + cloud.json, seals tokens, pushes
    // approved jobs, and renders a plain "connected, close this tab" page (NOT JSON; it
    // needs the query params and an HTML response). The api key is never rendered.
    method: 'GET', path: '/api/cloud/enable/callback', mcpTool: null,
    handler: async (req, res, url) => {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      try {
        await completeEnableConnect({ code, state });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(connectResultHtml(true));
      } catch {
        // A generic page only - never echo an error detail (defense-in-depth: no value
        // can leak through the page even though CloudError messages carry no secret).
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(connectResultHtml(false));
      }
    },
  },
];

// The minimal page rendered at the end of the one-click handshake. Self-contained,
// no script, no secret: it tells the operator to return to pendpost. Success means
// the api key was claimed, written, and the workspace connected + auto-lifted.
function connectResultHtml(ok) {
  const title = ok ? 'connected' : 'could not connect';
  const body = ok
    ? 'always-on is enabled. you can close this tab and return to pendpost.'
    : 'the connection did not complete. close this tab and try again from pendpost.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />`
    + `<meta name="viewport" content="width=device-width, initial-scale=1" />`
    + `<title>pendpost - ${title}</title>`
    + `<style>body{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;color-scheme:light dark}`
    + `main{width:min(420px,92vw);padding:24px;text-align:center}h1{font-size:18px;font-weight:700;letter-spacing:-.01em;margin:0 0 8px}`
    + `p{color:#71717a;margin:0}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

// Resolve the per-request client id: the query string for GET, the JSON body
// for non-GET (peeked here via the cached body reader so the handler can read it
// again). A missing/blank clientId falls back to the active client. Returns null
// when no clientId was supplied at all (bind the active client implicitly).
export async function resolveClientId(req, url) {
  if (req.method === 'GET') {
    const q = url.searchParams.get('clientId');
    return q && q.trim() ? q.trim() : null;
  }
  // Only JSON bodies can carry clientId; binary uploads (image/*, video/*) pass
  // it on the query string. Peeking a non-JSON body here would consume the
  // binary stream needlessly, so guard on the content-type.
  const contentType = String(req.headers['content-type'] || '');
  if (!/^application\/json\b/i.test(contentType)) {
    const q = url.searchParams.get('clientId');
    return q && q.trim() ? q.trim() : null;
  }
  try {
    const raw = (await readBodyRaw(req)).toString('utf8');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.clientId === 'string' && parsed.clientId.trim()) {
      return parsed.clientId.trim();
    }
  } catch { /* malformed body - let the handler surface the parse error */ }
  return null;
}

export async function handleApi(req, res, url) {
  const route = url.pathname.replace(/\/+$/, '');
  // Two-step dispatch (path first, then method) so one path can carry several
  // methods (POST + DELETE on the cover route) without the first table entry
  // 405-ing the rest.
  const pathMatches = ROUTES.filter((entry) => {
    const pathMatch = entry.path ? route === entry.path : route.startsWith(entry.prefix);
    return pathMatch && (!entry.test || entry.test(route));
  });
  if (!pathMatches.length) {
    return sendJson(res, 404, errorBody('unknown_route', `unknown route: ${route}`, { hint: 'see docs/plans/platform/API-CONTRACT.md for the route list' }));
  }
  const entry = pathMatches.find((e) => e.method === req.method);
  if (!entry) {
    const allowed = [...new Set(pathMatches.map((e) => e.method))].join(', ');
    return sendJson(res, 405, errorBody('invalid_input', `${route} only supports ${allowed}`));
  }
  // Bind the per-call client root ONCE for the whole handler (activeRoot()
  // resolves under it). An explicit clientId scopes this one request; otherwise
  // the active client. Client-admin routes manage the registry itself and run
  // unscoped (their clientId, when present, is the id being administered, not a
  // scoping override) - they are matched by prefix and skipped here.
  const isClientAdmin = route === '/api/clients' || route.startsWith('/api/clients/');
  let clientId = null;
  if (!isClientAdmin) {
    try {
      clientId = await resolveClientId(req, url);
    } catch { /* body read failure surfaces in the handler */ }
  }
  let root;
  try {
    root = clientRoot(clientId ?? activeClientId());
  } catch (err) {
    return sendJson(res, 400, errorBody(err.code || 'invalid_input', err.message));
  }
  return withClient(root, () => entry.handler(req, res, url, entry));
}
