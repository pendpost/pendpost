// cloud-client.mjs - the OPTIONAL, gated client for the proprietary pendpost-cloud
// always-on runtime. Pure transport over the global fetch: it REUSES the core's own
// approval enumeration (eligibleDuePosts) and publish-job builder (buildPublishJob),
// content-addresses the plan + media files, and pushes already-approved jobs to the
// cloud so the runtime can fire the live lanes while the operator's machine is off.
//
// Open-core boundary (docs/specs/cloud-integration-contract.md): this module is
// ADDITIVE and OFF by default (cloud.enabled in cloud.json). It imports NO cloud
// code; it speaks only the documented HTTP seam. It NEVER logs the api key or a
// token, and the publish-job envelope it sends carries no secret, no caption text,
// and no media bytes (buildPublishJob guarantees that). The api key is a SECRET read
// from .env (PENDPOST_CLOUD_API_KEY), matching the core's secret trust tier in
// lib/config.mjs - never written to cloud.json, never logged, surfaced as presence +
// tail only. The cloud WORKSPACE id lives in cloud.json + the api key; it is
// deliberately kept OUT of the publish-job envelope (the envelope's identity.clientId
// is the LOCAL client id, exactly as the local scheduler stamps it). Nothing here
// runs unless the owner explicitly connects a workspace; the core schedules and
// publishes exactly as before when the flag is unset.
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { activeRoot, boundRoot, withClient } from './context.mjs';
import { readEnv, writeEnvVars, removeEnvVars, globalEnvPath } from './util.mjs';
import { loadPlanStore, findCampaign } from './plans.mjs';
import { mutatePlan, resolvePlanPath } from './planWrite.mjs';
import { activeClientId, clientRoot } from './multi-client.mjs';
import { listClients } from './clients.mjs';
import { eligibleDuePosts, lanesOwed, lanePlatforms, ENGINES, appendActivity, CLOUD_LANES } from './scheduler.mjs';
import { buildPublishJob } from './publish-job.mjs';
import { fileSha256, loadState, saveState } from './state.mjs';
import { readCloudConfig, writeCloudConfig, cloudApiKey, getCloudStatus, getConnection, brandAlwaysOn, setBrandAlwaysOn, listBrands, clearConnection, API_KEY_ENV } from './cloud-config.mjs';

// Re-export the cloud.json config surface (the readers/togglers live in
// cloud-config.mjs so the scheduler can read the cloud-enabled flag without an
// import cycle); callers still import them from here.
export { getCloudStatus, setCloudEnabled, cloudApiKeyStatus } from './cloud-config.mjs';

// A cloud transport / config error carrying a stable code (and the HTTP status when
// the failure came from the cloud). The message never contains the api key or a
// token.
export class CloudError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
    this.status = status;
  }
}

const MEDIA_CONTENT_TYPES = Object.freeze({
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/x-m4v',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
});
function contentTypeFor(abs) {
  return MEDIA_CONTENT_TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream';
}

// Cloud-contact bookkeeping: cloudFetch is the single transport choke point, so it is
// the one truthful place to stamp "when did we last actually reach the cloud". The
// stamp (state.cloudContact.okAt) feeds cloudSyncStatus - a stale okAt while a brand
// is cloud-managed means the guarantee is BROKEN (red dot), which is exactly the
// silent-outage signal the Jun/Jul incident lacked. Throttled to once per window so a
// multi-call tick does not churn state.json; failures record the sanitized message
// (never the key) for the status reason. Best-effort: bookkeeping never breaks a call.
const CONTACT_STAMP_THROTTLE_MS = 60_000;
let contactOkStampedMs = 0;
let contactErrStampedMs = 0;
function stampCloudContact(ok, message = null) {
  const nowMs = Date.now();
  if (ok && nowMs - contactOkStampedMs < CONTACT_STAMP_THROTTLE_MS) return;
  if (!ok && nowMs - contactErrStampedMs < CONTACT_STAMP_THROTTLE_MS) return;
  try {
    const s = loadState();
    const prev = (s.cloudContact && typeof s.cloudContact === 'object') ? s.cloudContact : {};
    const at = new Date(nowMs).toISOString();
    s.cloudContact = ok
      ? { ...prev, okAt: at, lastError: null, errorAt: null }
      : { ...prev, lastError: String(message || 'cloud request failed').slice(0, 200), errorAt: at };
    saveState();
    if (ok) contactOkStampedMs = nowMs; else contactErrStampedMs = nowMs;
  } catch { /* contact bookkeeping is best-effort */ }
}

// One authenticated JSON request to the cloud api. The api key rides ONLY in the
// Authorization header - it is never placed in a url, a body, or a thrown message,
// and this module never logs, so the key cannot leak through here.
async function cloudFetch(method, urlPath, { body, baseUrl } = {}) {
  const cfg = readCloudConfig();
  const base = baseUrl || cfg.baseUrl;
  if (!base) throw new CloudError('not_configured', 'cloud baseUrl is not set - connect a workspace first');
  const key = cloudApiKey();
  if (!key) throw new CloudError('no_api_key', `${API_KEY_ENV} is not set in .env`);
  const headers = { Authorization: `Bearer ${key}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(new URL(urlPath, base), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    stampCloudContact(false, e.message);
    throw new CloudError('network_error', `cloud request failed: ${e.message}`);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = (data && data.error) || `cloud ${method} ${urlPath} -> HTTP ${res.status}`;
    // An HTTP error still proves the cloud is REACHABLE (it answered) - stamp ok so
    // the red dot means "cannot reach / cannot fire", not "a 4xx happened once".
    stampCloudContact(true);
    throw new CloudError('http_error', msg, res.status);
  }
  stampCloudContact(true);
  return data;
}

// Content-address a file and ensure it is in cloud object storage. Returns
// { sha256, bytes } for the manifest. Skips the upload when the cloud already has
// the object (dedup via the presign head-check). Bytes go DIRECT to object storage
// via the presigned PUT url; they never transit the api.
async function ensureUploaded(abs, kind) {
  const { sha256, bytes } = fileSha256(abs);
  const contentType = kind === 'plan' ? 'application/json' : contentTypeFor(abs);
  const presign = await cloudFetch('POST', '/v1/content/presign', { body: { kind, sha256, bytes, contentType } });
  if (presign && presign.alreadyPresent) return { sha256, bytes };
  if (!presign || !presign.url) throw new CloudError('presign_failed', `cloud returned no upload url for ${kind}`);
  const putHeaders = { ...(presign.headers || {}) };
  if (!Object.keys(putHeaders).some((h) => h.toLowerCase() === 'content-type')) putHeaders['Content-Type'] = contentType;
  let res;
  try {
    res = await fetch(presign.url, { method: 'PUT', headers: putHeaders, body: fs.readFileSync(abs) });
  } catch (e) {
    throw new CloudError('upload_failed', `${kind} upload failed: ${e.message}`);
  }
  if (!res.ok) throw new CloudError('upload_failed', `${kind} upload failed: HTTP ${res.status}`);
  return { sha256, bytes };
}

// Connect (or re-point) a cloud workspace. Verifies the base url is reachable, then
// persists { enabled:true, baseUrl, workspaceId } to cloud.json. The api key must
// already be in .env (it is never accepted or stored here).
export async function connectWorkspace({ baseUrl, workspaceId } = {}) {
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) {
    throw new CloudError('invalid_input', 'baseUrl must be an absolute http(s) URL');
  }
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
    throw new CloudError('invalid_input', 'workspaceId is required');
  }
  if (!cloudApiKey()) throw new CloudError('no_api_key', `set ${API_KEY_ENV} in .env before connecting`);
  await cloudFetch('GET', '/v1/health', { baseUrl });
  writeCloudConfig({ enabled: true, baseUrl, workspaceId: workspaceId.trim() });
  return getCloudStatus();
}

// ---- the frictionless "enable always-on" loopback handshake ----------------
//
// One button, no key ever typed. The local app opens the cloud sign-in page; the
// human signs in once (Clerk) and the cloud redirects back to this server's loopback
// with a single-use code; the app CLAIMS the code over TLS for its workspace api key,
// writes it to .env itself, connects the workspace, and auto-lifts (seals tokens +
// pushes approved jobs). The api key transits only the claim TLS body, never a url.

// The managed-cloud origin for the handshake. Baked in, env-overridable for
// staging/dev. Distinct from cloud.json baseUrl, which is only set AFTER a connect.
const CONNECT_CLOUD_BASE = process.env.PENDPOST_CLOUD_BASE || 'https://pendpost-cloud-api.fly.dev';
const LOOPBACK_PORT = Number(process.env.PENDPOST_PORT || 8090);
const CONNECT_STATE_TTL_MS = 10 * 60 * 1000;

// Pending handshakes (CSRF state -> issuedAt), in memory on the single long-lived
// local server. `state` is the LOCAL app's CSRF token, echoed unchanged through the
// cloud /connect page and verified back here in the callback.
const pendingConnects = new Map();

// Begin a handshake: mint a CSRF state, store it, and return the cloud sign-in url
// (redirecting back to this server's loopback callback). The caller opens the browser.
export function beginEnableConnect() {
  const state = crypto.randomBytes(16).toString('hex');
  pendingConnects.set(state, Date.now());
  const redirectUri = `http://127.0.0.1:${LOOPBACK_PORT}/api/cloud/enable/callback`;
  const authUrl = `${CONNECT_CLOUD_BASE}/connect?redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
  return { authUrl, state };
}

// Verify-and-consume a pending state (single-use, TTL-bounded).
function takePendingState(state) {
  const issuedAt = pendingConnects.get(state);
  if (issuedAt == null) return false;
  pendingConnects.delete(state);
  return Date.now() - issuedAt <= CONNECT_STATE_TTL_MS;
}

// Complete the handshake from the loopback callback: verify the CSRF state, claim the
// api key over TLS, persist it (0600 .env), connect the workspace, then auto-lift
// (seal tokens + push approved jobs). The api key is never returned to the caller or
// logged (the local server renders only a "connected" page; presence + tail elsewhere).
export async function completeEnableConnect({ code, state } = {}) {
  if (!state || !takePendingState(state)) {
    throw new CloudError('invalid_input', 'unknown or expired connect state');
  }
  if (!code || typeof code !== 'string') {
    throw new CloudError('invalid_input', 'missing connect code');
  }
  let claimed;
  try {
    const res = await fetch(new URL('/v1/connect/claim', CONNECT_CLOUD_BASE), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const text = await res.text();
    claimed = text ? JSON.parse(text) : null;
    if (!res.ok || !claimed || !claimed.apiKey) {
      throw new CloudError('http_error', (claimed && claimed.error) || `connect claim failed: HTTP ${res.status}`, res.status);
    }
  } catch (e) {
    if (e instanceof CloudError) throw e;
    throw new CloudError('network_error', `connect claim failed: ${e.message}`);
  }
  const baseUrl = claimed.baseUrl || CONNECT_CLOUD_BASE;
  // Persist the key first (cloudApiKey reads .env fresh), then connect + auto-lift. The
  // key is INSTALL-GLOBAL (it authenticates the one workspace), so it goes in the
  // install-global .env - NOT the active client's subtree - so a second always-on brand
  // resolves the SAME key without a per-client copy.
  writeEnvVars({ [API_KEY_ENV]: claimed.apiKey }, globalEnvPath());
  // Strip any stray per-client key copy from a pre-centralization connect so the freshly
  // minted GLOBAL key is the ONLY one every brand can resolve (the stale-pairing fix: one
  // global key -> one real workspace, no shadow). Best-effort; never blocks the connect.
  try { consolidateCloudKey(); } catch { /* consolidation is best-effort */ }
  // CONNECT LINKS ONLY: connectWorkspace links the workspace WITHOUT enabling any brand
  // (no auto-bill). Then reconcile EVERY brand's flag to the freshly-connected workspace -
  // all OFF on a fresh connect, which also heals any stale always-on row left in the cloud
  // so billing matches local intent. Enabling a brand is a separate, explicit, billable
  // toggle. Best-effort: a flag-sync failure must not undo a successful connect.
  await connectWorkspace({ baseUrl, workspaceId: claimed.workspaceId });
  let brands = null;
  try { brands = await syncBrandFlags(); } catch { brands = null; }
  const tokens = await handLocalTokens();
  let push = null;
  try {
    push = await pushApprovedJobs();
  } catch {
    push = null; // a push failure must not undo a successful connect + token seal
  }
  return { ok: true, workspaceId: claimed.workspaceId, brands, tokens, push };
}

// Enumerate the already-approved, due posts (the SHARED eligibleDuePosts filter,
// never forked), build one publish-job per owed lane (buildPublishJob is the second
// approval fence - a self-approved post is refused here too), upload the referenced
// plan + media, then POST the batch to /v1/sync/push. Returns a per-post summary.
// The cloud re-validates every envelope AND the approval proof server-side before it
// enqueues anything, so this push is one of three independent fences, never the only
// one.
export async function pushApprovedJobs() {
  const cfg = readCloudConfig();
  if (!cfg.enabled) throw new CloudError('disabled', 'cloud is not enabled (set cloud.enabled first)');
  if (!cfg.workspaceId) throw new CloudError('not_configured', 'connect a workspace first');
  const { campaigns, manifestError } = loadPlanStore();
  if (manifestError) throw new CloudError('manifest_error', manifestError);
  const now = Date.now();
  // Bound-aware (mirrors scheduler.publishClientId): when pushApprovedJobs runs inside
  // a withClient() binding (the per-client toggle below), stamp THAT client's id, not
  // the registry-active one. Unbound, it is the registry-active client, exactly as before.
  const clientId = boundRoot() ? path.basename(boundRoot()) : activeClientId();

  const jobs = [];
  const proofs = [];
  const planByPath = new Map(); // relative planPath -> { path, sha256, bytes }
  const mediaByPath = new Map(); // mediaPath -> { mediaPath, sha256, bytes }
  const pushed = [];
  const skipped = [];

  for (const { campaign: c, post } of eligibleDuePosts(campaigns, {})) {
    const lanes = lanesOwed(post);
    if (!lanes.length) continue;

    // Build the lane envelopes FIRST (the second approval fence) so a post that
    // builds nothing never triggers an upload.
    const postJobs = [];
    for (const lane of lanes) {
      try {
        postJobs.push(buildPublishJob(post, lane, {
          clientId,
          campaign: c.id,
          planPath: c.path,
          command: ENGINES[lane] ? ENGINES[lane].command : null,
          timeoutMs: ENGINES[lane] ? ENGINES[lane].timeoutMs : null,
          lanePlatforms: lanePlatforms(lane, post),
          now,
        }));
      } catch (e) {
        skipped.push({ campaign: c.id, postId: post.id, lane, reason: e.code || 'refused' });
      }
    }
    if (!postJobs.length) continue;

    // Content-address + upload the plan (caption-bearing) and media the built jobs
    // reference. A failed upload skips the whole post rather than push a job whose
    // content the runtime cannot resolve.
    try {
      const planRel = c.path;
      if (!planByPath.has(planRel)) {
        const planAbs = path.isAbsolute(planRel) ? planRel : path.resolve(activeRoot(), planRel);
        const { sha256, bytes } = await ensureUploaded(planAbs, 'plan');
        planByPath.set(planRel, { path: planRel, sha256, bytes });
      }
      const mediaPath = post.media && post.media.exists ? post.media.path : null;
      if (mediaPath && !mediaByPath.has(mediaPath)) {
        const mediaAbs = path.isAbsolute(mediaPath) ? mediaPath : path.resolve(activeRoot(), mediaPath);
        const { sha256, bytes } = await ensureUploaded(mediaAbs, 'media');
        mediaByPath.set(mediaPath, { mediaPath, sha256, bytes });
      }
    } catch (e) {
      skipped.push({ campaign: c.id, postId: post.id, reason: e.message });
      continue;
    }

    for (const job of postJobs) {
      jobs.push(job);
      pushed.push({ campaign: c.id, postId: post.id, lane: job.lane });
    }
    // One proof per post (the cloud indexes proofs by postId).
    proofs.push({
      postId: post.id,
      approvedBy: post.approvalBy || null,
      createdBy: post.createdBy || null,
      approvedAt: post.approvalAt || null,
    });
  }

  if (!jobs.length) return { ok: true, pushed, skipped, accepted: [], refused: [] };

  const result = await cloudFetch('POST', '/v1/sync/push', {
    body: {
      jobs,
      proofs,
      mediaManifest: [...mediaByPath.values()],
      planManifest: [...planByPath.values()],
    },
  });
  const accepted = (result && result.accepted) || [];
  // Persist the ACK per job (state.cloudAccepted, keyed campaign:postId:lane like
  // cloudFailures) so "this job reached the cloud" survives the tick. FIRST-ack-wins:
  // the tick re-pushes idempotently every 60s, so overwriting would reset the clock -
  // the scheduler's backstop grace anchors on when the cloud FIRST had the job. An ack
  // proves acceptance only, NEVER that the job will fire (the workspace-collision
  // incident acked every push and fired nothing) - the overdue leg stays the enforcer.
  if (accepted.length) {
    try {
      const acceptedIds = new Set(accepted.map((a) => a && a.jobId).filter(Boolean));
      const s = loadState();
      if (!s.cloudAccepted || typeof s.cloudAccepted !== 'object') s.cloudAccepted = {};
      const at = new Date().toISOString();
      let changed = false;
      for (const job of jobs) {
        if (!acceptedIds.has(job.jobId)) continue;
        const key = `${job.identity.campaign}:${job.identity.postId}:${job.lane}`;
        if (s.cloudAccepted[key]) continue; // first-ack-wins
        s.cloudAccepted[key] = { jobId: job.jobId, at };
        changed = true;
      }
      if (changed) saveState();
    } catch { /* ack bookkeeping is best-effort; the push result is unchanged */ }
  }
  return {
    ok: true,
    pushed,
    skipped,
    accepted,
    refused: (result && result.refused) || [],
  };
}

// ---- per-client always-on (the install-global account's brands) ------------
//
// The connection is install-global (ONE workspace); each local client is a BRAND
// inside it with its own always-on flag. Toggling a brand sets the LOCAL flag (the
// scheduler's per-client safeguard reads it) AND tells the cloud so the worker fires
// (or stops firing) that brand; turning a brand ON also pushes its approved jobs so
// the cloud has them. The cloud calls are best-effort: a transport failure still
// records the local intent (the operator can re-push).

export async function setClientAlwaysOn(clientId, on) {
  if (typeof clientId !== 'string' || !clientId) throw new CloudError('invalid_input', 'clientId is required');
  const want = Boolean(on);
  const connected = getConnection().connected;
  // A connected workspace needs the api key for the toggle to actually reach the cloud.
  // Check it BEFORE writing the local flag: a keyless toggle must fail cleanly instead of
  // recording a local always-on the cloud never heard about (the keyless half-state
  // cloudEnabledForActive() now also guards against). cloudFetch below would throw the same
  // no_api_key, but only AFTER setBrandAlwaysOn had already mutated the local flag - leaving
  // local + cloud out of sync. Done here (not by reordering setBrandAlwaysOn after the PUT)
  // so turning a brand ON still stops local firing BEFORE the cloud PUT starts the cloud
  // worker - reordering would open a window where both fire the same post (a double-post).
  if (connected && !cloudApiKey()) {
    throw new CloudError('no_api_key', `set ${API_KEY_ENV} in .env before toggling always-on`);
  }
  setBrandAlwaysOn(clientId, want);
  let push = null;
  if (connected) {
    // The api key scopes this to the workspace; the path names the local brand.
    await cloudFetch('PUT', `/v1/brands/${encodeURIComponent(clientId)}`, { body: { always_on: want } });
    if (want) {
      try {
        push = await withClient(clientRoot(clientId), () => pushApprovedJobs());
      } catch {
        push = null; // a push failure must not undo the toggle
      }
    }
  }
  return { ok: true, clientId, alwaysOn: want, push };
}

// Reconcile every locally-known brand's always-on FLAG to the cloud so the workspace's
// billing + worker fence match local intent. The flag inverse of pushAlwaysOnBrands
// (which pushes JOBS): iterate the SAME listBrands() set and PUT each brand's CURRENT
// flag - true AND false. Sending false too heals drift: setClientAlwaysOn does not catch
// its own PUT, so a once-failed pause could otherwise leave a paused brand still billing.
// Runs UNBOUND, so it uses the active client's api key = the one install-global workspace;
// a never-toggled client has no listBrands() entry, so no junk cloud row is created.
// Best-effort PER brand: a transport failure is recorded in `skipped`, never throws, never
// blocks the others (the local flag is already the source of truth).
export async function syncBrandFlags() {
  if (!getConnection().connected) return { ok: true, synced: [], skipped: [] };
  const synced = [];
  const skipped = [];
  for (const { clientId, alwaysOn } of listBrands()) {
    const want = Boolean(alwaysOn);
    try {
      await cloudFetch('PUT', `/v1/brands/${encodeURIComponent(clientId)}`, { body: { always_on: want } });
      synced.push({ clientId, alwaysOn: want });
    } catch (e) {
      skipped.push({ clientId, reason: (e && e.code) || 'sync_failed' });
    }
  }
  return { ok: true, synced, skipped };
}

// The "cloud clients" view: every local client with its per-brand always-on, plus the
// install-global connection summary. (postsUsed is layered in by the subscription
// surface; this returns always-on + identity only.)
export function cloudClients() {
  const { clients, activeClientId: active } = listClients();
  return {
    ok: true,
    connection: getConnection(),
    clients: clients.map((c) => ({
      clientId: c.id,
      name: c.displayName || c.id,
      active: c.id === active,
      alwaysOn: brandAlwaysOn(c.id),
    })),
  };
}

// ---- subscription + checkout (the metered-by-posts surface) ----------------

// GET /v1/subscription -> the client-readable view { alwaysOn, status, allowance,
// postsUsed, postsIncluded, billingMode, currentPeriodEnd, action, checkoutEligible }.
// Read-only; the api key scopes it to the workspace. No secrets, no Stripe ids.
export async function getSubscription() {
  return cloudFetch('GET', '/v1/subscription');
}

// POST /v1/billing/checkout { plan, interval } -> a Stripe Checkout url to subscribe to a
// tier (4242 in test). `plan` is the tier (starter|studio|agency) and `interval` is the
// billing cadence (month|year); they ride in the body next to the success/cancel urls that
// return the operator to the local dashboard. The api key scopes it to the workspace; the
// caller (the operator-only route) opens the browser with the url.
export async function startCheckout({ plan, interval } = {}) {
  const port = Number(process.env.PENDPOST_PORT || 8090);
  const back = `http://127.0.0.1:${port}/?cloud=checkout`;
  return cloudFetch('POST', '/v1/billing/checkout', { body: { plan, interval, successUrl: back, cancelUrl: back } });
}

// POST /v1/billing/spend-cap { cents } -> { spendCapCents }. Set (or clear, with null) the
// customer's overage spend cap in cents. The cap governs overage only; once the running
// overage reaches it, extra posts pause until it is raised or the period resets. The api
// key scopes it to the workspace; read-only inputs, no secrets.
export async function setSpendCap(cents) {
  return cloudFetch('POST', '/v1/billing/spend-cap', { body: { cents } });
}

// POST /v1/billing/portal -> a Stripe billing-portal url (manage plan, payment method,
// invoices, cancel). The returnUrl brings the operator back to the local dashboard; the
// api key scopes it to the workspace; the caller (operator-only route) opens the browser.
export async function startBillingPortal() {
  const port = Number(process.env.PENDPOST_PORT || 8090);
  const back = `http://127.0.0.1:${port}/?cloud=portal`;
  return cloudFetch('POST', '/v1/billing/portal', { body: { returnUrl: back } });
}

// Hand one platform token to the workspace's encrypted cloud vault over TLS. The
// token is sent in the request body and is NEVER logged here; the cloud seals it and
// returns presence only.
export async function handToken({ platform, platformAccountId, token, expiresAt = null } = {}) {
  if (typeof platform !== 'string' || !platform) throw new CloudError('invalid_input', 'platform is required');
  if (typeof platformAccountId !== 'string' || !platformAccountId) throw new CloudError('invalid_input', 'platformAccountId is required');
  if (typeof token !== 'string' || !token) throw new CloudError('invalid_input', 'token is required');
  return cloudFetch('PUT', `/v1/vault/${encodeURIComponent(platform)}`, {
    body: { platformAccountId, token, expiresAt },
  });
}

// Pull the self-host eject bundle (plan files + a per-platform re-auth checklist).
// Tokens are NEVER exported in plaintext; the operator re-mints each platform
// locally after ejecting.
export async function ejectBundle() {
  const cfg = readCloudConfig();
  if (!cfg.workspaceId) throw new CloudError('not_configured', 'connect a workspace first');
  return cloudFetch('GET', `/v1/eject/${encodeURIComponent(cfg.workspaceId)}`);
}

// Disconnect from the cloud and return to self-host - the real "Zurück zum Self-Host".
// It fetches the eject bundle FIRST (it needs the api key + workspaceId for the re-auth
// checklist), THEN clears the local connection (cloud.json) and removes the api key from
// .env, so the dashboard returns to the disconnected view and the local scheduler resumes
// firing every lane. The bundle's reauthChecklist tells the operator which platforms to
// re-mint locally; tokens are NEVER exported. A bundle-fetch failure (e.g. the workspace is
// already gone) must NOT block the local disconnect - clearing local state is the operator's
// escape hatch, so it proceeds without a bundle.
export async function disconnectWorkspace() {
  let bundle = null;
  try {
    bundle = await ejectBundle();
  } catch {
    bundle = null;
  }
  clearConnection();
  // Drop the install-global key, AND sweep the active client's .env in case a legacy
  // per-client copy lingers from a pre-centralization connect (un-migrated installs
  // share one .env, so the second call is a no-op there).
  removeEnvVars([API_KEY_ENV], globalEnvPath());
  removeEnvVars([API_KEY_ENV]);
  return { ok: true, ...(bundle || {}) };
}

// Lightweight LOCAL sign-out: clear the cloud connection (cloud.json) and remove the
// install-global api key from .env - the same local-state reset disconnectWorkspace does,
// but WITHOUT the heavy eject ceremony (no eject-bundle fetch, no per-platform re-auth
// checklist). It is the reversible "switch account / sign out" counterpart to the
// destructive Eject: it leaves the operator's PLATFORM auth (the .env platform tokens)
// untouched, so signing back in (the loopback handshake) restores everything. The cloud
// workspace itself is NOT torn down - the operator can reconnect, or eject for real later.
// Sweeps both the global .env and the active client's .env so a legacy per-client key
// copy cannot keep a stale workspace resolvable after sign-out (the stale-pairing fix:
// after this, NO key lingers anywhere, so a reconnect resolves a single fresh key).
export async function signOutWorkspace() {
  clearConnection();
  removeEnvVars([API_KEY_ENV], globalEnvPath());
  removeEnvVars([API_KEY_ENV]);
  return { ok: true };
}

// Consolidate to ONE install-global cloud api key: if a legacy per-client .env still
// carries a PENDPOST_CLOUD_API_KEY (from a pre-centralization connect), promote it to the
// install-global .env and strip the per-client copy, so EVERY brand resolves the SAME key
// = the SAME workspace. Idempotent: a no-op once the key already lives only in the global
// .env (the common case). The key VALUE is read only to move it; it is never returned or
// logged (presence + tail only). Returns whether a consolidation happened.
export function consolidateCloudKey() {
  const globalEnv = globalEnvPath();
  const perClient = readEnv(API_KEY_ENV); // resolves the ACTIVE client's .env (then global)
  const globalKey = readEnv(API_KEY_ENV, globalEnv);
  // If the active-client read finds a key but the GLOBAL .env does not have it, a stray
  // per-client copy exists - promote it global and drop the local copy.
  if (perClient && !globalKey) {
    writeEnvVars({ [API_KEY_ENV]: perClient }, globalEnv);
    removeEnvVars([API_KEY_ENV]); // strip the per-client copy now that it is global
    return { ok: true, consolidated: true };
  }
  // If BOTH exist, the global one is authoritative (cloudApiKey reads it first); strip the
  // stray per-client copy so it can never shadow a future rotation.
  if (globalKey && perClient && perClient !== globalKey) {
    removeEnvVars([API_KEY_ENV]);
    return { ok: true, consolidated: true };
  }
  return { ok: true, consolidated: false };
}

// Convert a stored epoch (seconds OR milliseconds) to ISO, or null. The core stores
// some expiries as epoch strings (LINKEDIN_TOKEN_EXPIRES_AT, X_TOKEN_EXPIRES_AT).
function isoFromEpoch(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n; // tolerate seconds or milliseconds
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Per-platform: which local .env values make up the token + the account id the cloud
// vault is keyed on. The operator-side inverse of the cloud worker's tokenEnvFor
// mapping: it reads from the SAME .env the local engines read. The token VALUE is
// read here ONLY to seal it into the vault over TLS - never logged, never returned.
// X uses OAuth1's four keys, bundled as JSON under one vault entry (the worker
// unpacks it); the others are a single token.
const PLATFORM_TOKEN_SOURCES = Object.freeze({
  facebook: (e) => ({ token: e('META_PAGE_TOKEN'), accountId: e('META_PAGE_ID') }),
  instagram: (e) => ({ token: e('META_PAGE_TOKEN'), accountId: e('META_IG_USER_ID') }),
  linkedin: (e) => ({ token: e('LINKEDIN_ACCESS_TOKEN'), accountId: e('LINKEDIN_ORG_URN'), expiresAt: isoFromEpoch(e('LINKEDIN_TOKEN_EXPIRES_AT')) }),
  youtube: (e) => ({ token: e('YT_REFRESH_TOKEN'), accountId: e('YT_CHANNEL_ID') }),
  x: (e) => {
    const oauth1 = e('X_API_KEY') && e('X_API_SECRET') && e('X_ACCESS_TOKEN') && e('X_ACCESS_TOKEN_SECRET');
    if (oauth1) {
      return {
        token: JSON.stringify({ apiKey: e('X_API_KEY'), apiSecret: e('X_API_SECRET'), accessToken: e('X_ACCESS_TOKEN'), accessTokenSecret: e('X_ACCESS_TOKEN_SECRET') }),
        accountId: e('X_HANDLE'),
      };
    }
    return { token: e('X_ACCESS_TOKEN'), accountId: e('X_HANDLE'), expiresAt: isoFromEpoch(e('X_TOKEN_EXPIRES_AT')) };
  },
  bluesky: (e) => ({ token: e('BLUESKY_APP_PASSWORD') || e('BSKY_APP_PASSWORD'), accountId: e('BLUESKY_HANDLE') || e('BSKY_HANDLE') }),
});

// Read the platform tokens already in the local .env and seal each into the cloud
// vault (PUT /v1/vault/:platform). The frictionless migration path for an existing
// self-host operator: no manual re-entry. Returns a per-platform summary recording
// WHETHER a token was handed over, NEVER the value (the value travels only in the
// request body over TLS; it is never logged or returned). A platform with no token
// or no account id in .env is skipped, not an error.
export async function handLocalTokens() {
  const e = (name) => readEnv(name) || '';
  const handed = [];
  const skipped = [];
  for (const [platform, source] of Object.entries(PLATFORM_TOKEN_SOURCES)) {
    const { token, accountId, expiresAt = null } = source(e);
    if (!token) { skipped.push({ platform, reason: 'no_token_in_env' }); continue; }
    if (!accountId) { skipped.push({ platform, reason: 'no_account_id_in_env' }); continue; }
    try {
      await handToken({ platform, platformAccountId: accountId, token, expiresAt });
      handed.push({ platform, platformAccountId: accountId });
    } catch (err) {
      skipped.push({ platform, reason: (err && err.code) || 'ingest_failed' });
    }
  }
  return { ok: true, handed, skipped };
}

// One-command migration: connect the workspace (when baseUrl + workspaceId are
// given), seal the local .env tokens into the vault, then push the approved jobs.
// The frictionless "move my connections to the cloud" flow. Each sub-step is kept
// separate in the result so a partial failure is legible.
export async function migrateToCloud({ baseUrl, workspaceId } = {}) {
  const connected = (baseUrl && workspaceId)
    ? await connectWorkspace({ baseUrl, workspaceId })
    : getCloudStatus();
  // Gate on the CONNECTION, not the active client's always-on. Re-sync is a workspace-global
  // maintenance action (re-seal tokens + re-push) and must work regardless of which brand is
  // paused - the old `!connected.enabled` gate greyed it out purely because the viewed client
  // was paused, which is why the buttons looked dead.
  if (!connected.workspaceId) {
    throw new CloudError('not_configured', 'connect a workspace first (pass baseUrl + workspaceId, or connect)');
  }
  // The vault is workspace-global, so always re-seal the local .env tokens.
  const tokens = await handLocalTokens();
  // Reconcile every brand's always-on FLAG to the workspace first (the billing + worker-fence
  // inverse of the job push below), so a re-sync also heals brand-flag drift, not just jobs.
  const brands = await syncBrandFlags();
  // Push only for the ALWAYS-ON brands (the cloud fires only those). Each push runs inside that
  // brand's binding, so pushApprovedJobs' anti-double-fire gate (cfg.enabled) passes exactly as
  // it does for the per-client toggle - no safeguard is relaxed.
  const push = await pushAlwaysOnBrands();
  return { ok: true, connected, tokens, brands, push };
}

// Push the approved, due jobs for every always-on brand, each in its own client binding (the
// same pattern setClientAlwaysOn uses), folding the per-brand results into ONE
// { pushed, skipped, accepted, refused } summary so the UI's PushSummary renders the whole
// re-sync in one place. A workspace with no always-on brand returns empty arrays (nothing to
// push) while the token re-seal still happened.
async function pushAlwaysOnBrands() {
  const active = activeClientId();
  const merged = { pushed: [], skipped: [], accepted: [], refused: [] };
  for (const { clientId } of listBrands().filter((b) => b.alwaysOn)) {
    // The ACTIVE client pushes UNBOUND so it respects activeRoot()'s no-registry fallback - a
    // lone default client's plans live at the workspace root, NOT data/clients/default, so a
    // withClient(clientRoot('default')) binding would find nothing. Other brands push inside
    // their own binding, exactly like setClientAlwaysOn does.
    const r = clientId === active
      ? await pushApprovedJobs()
      : await withClient(clientRoot(clientId), () => pushApprovedJobs());
    for (const k of ['pushed', 'skipped', 'accepted', 'refused']) {
      if (r && Array.isArray(r[k])) merged[k].push(...r[k]);
    }
  }
  return merged;
}

// ---- cloud→local result sync-back (the PULL inverse of pushApprovedJobs) ----
//
// The cloud fires the always-on lanes but cannot reach the local loopback, so the
// local engine POLLS the workspace's terminal job outcomes and reconciles its plan: a
// `done` job's MINTED platform id is written back to the matching plan post, flipping
// it to posted and clearing the planner's "overdue". This mirrors the local engine's
// OWN publish write (set the id + status:'posted' + postedAt) - NOT the owner-manual
// markPosted, so it sets no publishedVia and no externalUrl. It is idempotent (an
// already-posted post is skipped without even rewriting the plan) and a refusal NEVER
// touches the plan (the post legitimately stays due). No secret, no caption, no media.

// GET /v1/sync/results -> { results: [...] }. Read-only; the api key scopes it to the
// workspace. `since` (ISO) is an optional incremental cursor (the cloud filters on
// created_at). The local v1 polls without one and relies on the idempotent patch.
export async function getCloudResults({ since = null } = {}) {
  const q = since ? `?since=${encodeURIComponent(since)}` : '';
  return cloudFetch('GET', `/v1/sync/results${q}`);
}

// Map a platform + the local post type to the plan's engine-owned id field - the SAME
// mapping the publish engines and platformPending use (instagram->igMediaId; a facebook
// reel->fbReelId, else fbPostId; etc.). bluesky has no local id surface, so it returns
// null and that entry is skipped (a bluesky-only post cannot be reconciled - see the
// cloud-integration plan's Risks).
function idFieldFor(platform, postType) {
  switch (platform) {
    case 'instagram': return 'igMediaId';
    case 'facebook': return postType === 'reel' ? 'fbReelId' : 'fbPostId';
    case 'linkedin': return 'liPostId';
    case 'youtube': return 'ytVideoId';
    case 'x': return 'xPostId';
    default: return null;
  }
}

// Reconcile the BOUND/active client's plan from the cloud's terminal results. Runs
// inside a withClient() binding (the scheduler tick) or unbound (the active client);
// either way it patches ONLY this client's posts (a defense-in-depth filter on the
// result's clientId, since one workspace can host several brands). Gates on the
// CONNECTION (workspaceId), not the viewed brand's always-on - mirrors migrateToCloud,
// so a re-sync-style read works regardless of which brand is paused.
export async function reconcileCloudResults({ since = null } = {}) {
  const cfg = readCloudConfig();
  if (!cfg.workspaceId) throw new CloudError('not_configured', 'connect a workspace first');
  const clientId = boundRoot() ? path.basename(boundRoot()) : activeClientId();

  const data = await getCloudResults({ since });
  const results = (data && data.results) || [];

  // Group THIS client's `done` results by (campaign, postId) and merge every minted id
  // across lanes, so a multi-lane post flips to posted ONCE carrying all its ids (never
  // a partial-id posted state). Refused/failed are collected for the summary only.
  const groups = new Map(); // `${campaign}\x00${postId}` -> { campaign, postId, firedAt, entries }
  const refused = [];
  const failed = [];
  const held = [];
  for (const r of results) {
    if (r.clientId !== clientId) continue;
    if (r.state === 'failed') {
      // A failed fire is the self-healer's input: keep the jobId (to retrigger), the
      // firedAt (the backoff anchor), and the sanitized failureMessage (for health).
      failed.push({ jobId: r.jobId, campaign: r.campaign, postId: r.postId, lane: r.lane, firedAt: r.firedAt || null, failureMessage: r.failureMessage || null });
      continue;
    }
    if (r.state === 'stale_held') {
      // The cloud's staleness park (>15 min past due, never fired): NOT a failure - the
      // job simply awaits OUR explicit retrigger (retriggerHeldJobs), because the cloud
      // cannot know whether the local backstop already published while it was down.
      held.push({ jobId: r.jobId, campaign: r.campaign, postId: r.postId, lane: r.lane });
      continue;
    }
    if (r.state !== 'done') {
      refused.push({ campaign: r.campaign, postId: r.postId, lane: r.lane, state: r.state, refusedCode: r.refusedCode || null });
      continue;
    }
    const key = `${r.campaign}\x00${r.postId}`;
    let g = groups.get(key);
    if (!g) { g = { campaign: r.campaign, postId: r.postId, firedAt: r.firedAt || null, entries: [] }; groups.set(key, g); }
    if (!g.firedAt && r.firedAt) g.firedAt = r.firedAt;
    for (const e of r.results || []) if (e && e.ok && e.id) g.entries.push(e);
  }

  const patched = [];
  const skipped = [];
  for (const g of groups.values()) {
    const { campaign: c } = findCampaign(g.campaign);
    if (!c) { skipped.push({ postId: g.postId, outcome: 'unknown_campaign' }); continue; }
    const existing = (c.posts || []).find((p) => p.id === g.postId);
    if (!existing) { skipped.push({ postId: g.postId, outcome: 'unknown_post' }); continue; }
    // Idempotency fast-path: an already-posted post (cloud OR owner-manual) is left
    // exactly as-is - never re-patched, and mutatePlan (which always rewrites) is not
    // called, so the plan file does not churn on every poll.
    if (existing.status === 'posted') { skipped.push({ postId: g.postId, outcome: 'already_posted' }); continue; }

    const planAbs = resolvePlanPath(c.path);
    let outcome;
    try {
      outcome = await mutatePlan(planAbs, (plan) => {
        const p = (plan.posts || []).find((x) => x.id === g.postId);
        if (!p) return 'unknown_post';
        if (p.status === 'posted') return 'already_posted'; // re-check under the lock
        let set = false;
        for (const e of g.entries) {
          const field = idFieldFor(e.platform, p.type);
          if (!field) continue; // e.g. bluesky: no local id field
          p[field] = e.id;
          set = true;
        }
        if (!set) return 'no_id';
        // The engine's own write set (mirrors scripts/*-social.mjs): the minted id +
        // status:'posted' + postedAt (the cloud's authoritative fire time). NO
        // publishedVia (engine never sets it) and NO externalUrl (owner-manual-only).
        p.status = 'posted';
        p.postedAt = g.firedAt || new Date().toISOString();
        return 'patched';
      });
    } catch (e) {
      skipped.push({ postId: g.postId, outcome: e.code || 'write_failed' });
      continue;
    }
    if (outcome === 'patched') {
      patched.push({ campaign: g.campaign, postId: g.postId, outcome });
      // Best-effort audit row (mirrors verifyPost); a failure here never fails the patch.
      try {
        appendActivity({ campaign: g.campaign, postId: g.postId, platform: null, action: 'cloud-reconcile', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: 'cloud' });
      } catch { /* activity is best-effort */ }
    } else {
      skipped.push({ postId: g.postId, outcome });
    }
  }
  // Cache per-post cloud failure messages for pendpost_health (set on failed; cleared
  // when the post is now posted), so the operator sees WHY a post is stuck without a
  // live cloud call. Best-effort and only when something changed (no per-tick churn).
  if (failed.length || patched.length) {
    try {
      const s = loadState();
      if (!s.cloudFailures || typeof s.cloudFailures !== 'object') s.cloudFailures = {};
      const at = new Date().toISOString();
      for (const f of failed) s.cloudFailures[`${f.campaign}:${f.postId}`] = { lane: f.lane, jobId: f.jobId, message: f.failureMessage, at };
      for (const p of patched) delete s.cloudFailures[`${p.campaign}:${p.postId}`];
      // The matching push-ack records are now redundant (the post is posted, so the
      // eligibility walk excludes it anyway); drop every lane's key so cloudAccepted
      // never grows past the live backlog. Keyed campaign:postId:lane - prefix-match.
      if (s.cloudAccepted && typeof s.cloudAccepted === 'object') {
        for (const p of patched) {
          const prefix = `${p.campaign}:${p.postId}:`;
          for (const k of Object.keys(s.cloudAccepted)) if (k.startsWith(prefix)) delete s.cloudAccepted[k];
        }
      }
      // Same for the stale-held handoff anchors: a now-posted post's cloudRetriggered
      // entries are done their job (the backstop stood down); drop them so the map
      // never grows past the live backlog.
      if (s.cloudRetriggered && typeof s.cloudRetriggered === 'object') {
        for (const p of patched) {
          const prefix = `${p.campaign}:${p.postId}:`;
          for (const k of Object.keys(s.cloudRetriggered)) if (k.startsWith(prefix)) delete s.cloudRetriggered[k];
        }
      }
      saveState();
    } catch { /* cache is best-effort */ }
  }
  return { ok: true, patched, skipped, refused, failed, held };
}

// ---- the cloud guarantee roll-up (the header dot) ---------------------------------
//
// PURE READ, zero network: computed from state.json (the tick's bookkeeping) + the
// plan store, so /api/cloud stays fast and truthful even while the cloud is down.
// The contract the owner sees on the header cloud icon:
//   green  - every approved, fully-scheduled post owing a CLOUD lane is ack'd by the
//            cloud, contact is fresh, nothing failed: "everything on the cloud WILL post"
//   yellow - >=1 owed cloud-lane job has no push-ack yet (normal for <=1 tick after
//            approving; persistent yellow = pushes not landing)
//   red    - the guarantee is BROKEN: cloud unreachable past grace, an approved post
//            overdue-unpublished, a failed cloud fire, sync stopped, or the cloud
//            disagrees the brand is on. The scheduler's backstop then fires locally,
//            but red still demands the owner's attention.
// An ack proves ACCEPTANCE only, never that the job will fire (the workspace-collision
// incident acked everything and fired nothing) - which is why overdue-unpublished is a
// red condition of its own, independent of acks. Scope: CLOUD_LANES only; local-only
// lanes surface through pendpost_health exactly as before. Returns null when the
// active brand is not cloud-managed (the dot then falls back to the local states).
const SYNC_STALE_GRACE_MS = 10 * 60_000; // aligns with pendpost_health's OVERDUE_GRACE_MS
export function cloudSyncStatus() {
  const cfg = readCloudConfig();
  const clientId = boundRoot() ? path.basename(boundRoot()) : activeClientId();
  if (!cfg.workspaceId || !brandAlwaysOn(clientId) || !cloudApiKey()) return null;
  const s = loadState();
  const now = Date.now();

  const okAtIso = s.cloudContact && s.cloudContact.okAt ? s.cloudContact.okAt : null;
  const okAt = okAtIso ? Date.parse(okAtIso) : NaN;
  const contactStale = !Number.isFinite(okAt) || (now - okAt) > SYNC_STALE_GRACE_MS;
  const sub = s.cloudSubView && typeof s.cloudSubView === 'object' ? s.cloudSubView : null;

  let pendingCount = 0;
  let overdueCount = 0;
  let manifestBroken = false;
  const openKeys = new Set(); // `${campaign}:${postId}` still approved + unposted
  try {
    const { campaigns, manifestError } = loadPlanStore();
    if (manifestError) manifestBroken = true;
    const acks = s.cloudAccepted || {};
    for (const { campaign: c, post } of eligibleDuePosts(campaigns, {})) {
      openKeys.add(`${c.id}:${post.id}`);
      const lanes = lanesOwed(post).filter((l) => CLOUD_LANES.includes(l));
      if (!lanes.length) continue;
      const due = Date.parse(post.scheduledAt || '');
      const overdue = Number.isFinite(due) && (now - due) > SYNC_STALE_GRACE_MS;
      for (const lane of lanes) {
        if (overdue) { overdueCount += 1; continue; }
        if (!acks[`${c.id}:${post.id}:${lane}`]) pendingCount += 1;
      }
    }
  } catch { manifestBroken = true; }
  // A failure only breaks the guarantee while its post is still OPEN (approved +
  // unposted). A relic entry for a post that has since posted (e.g. fired locally, or
  // reconciled in an earlier era) must not hold the dot red forever - reconcile only
  // clears entries when IT patches the post, so stale keys can linger in state.json.
  const failedCount = Object.entries(s.cloudFailures || {})
    .filter(([key, f]) => f && CLOUD_LANES.includes(f.lane) && openKeys.has(key)).length;

  // Red reasons in severity order - the FIRST one is the headline the popover shows.
  const reason = contactStale ? 'cloud_unreachable'
    : overdueCount > 0 ? 'overdue_unpublished'
      : failedCount > 0 ? 'cloud_failures'
        : (sub && sub.syncStopped) ? 'sync_stopped'
          : (sub && sub.alwaysOn === false) ? 'flag_divergence'
            : manifestBroken ? 'manifest_error'
              : pendingCount > 0 ? 'push_pending'
                : 'all_confirmed';
  const state = reason === 'all_confirmed' ? 'green' : reason === 'push_pending' ? 'yellow' : 'red';
  return { state, reason, pendingCount, failedCount, overdueCount, lastContactAt: okAtIso };
}

// Reconcile EVERY always-on brand (the manual "Sync now" + the /api/cloud/reconcile
// route), each inside its own client binding (the same pattern pushAlwaysOnBrands
// uses), folding the per-brand summaries into one. A workspace with no always-on brand
// reconciles nothing. The ACTIVE client reconciles UNBOUND so it respects activeRoot()'s
// no-registry fallback (a lone default client's plans live at the workspace root).
// Don't re-fire a job whose last attempt (firedAt) is newer than this, so a doomed
// job is retried at most once per window (no platform 401-hammering) and a transient
// one recovers within a bounded window. The pendpost_health overdue blocker surfaces a
// stuck post sooner (smaller grace), so a human sees a real key issue before the re-fire.
const RETRY_BACKOFF_MS = 15 * 60_000;

// POST /v1/sync/retrigger -> re-queue + re-publish the named failed|refused cloud jobs
// (workspace-scoped). The ONLY re-fire path: the cloud worker's claim guard makes a plain
// re-push a no-op, so a stalled job advances only when we explicitly retrigger it.
export async function retriggerJobs(jobIds = []) {
  const ids = (Array.isArray(jobIds) ? jobIds : []).filter((x) => typeof x === 'string' && x);
  if (!ids.length) return { ok: true, requeued: [], skipped: [] };
  const cfg = readCloudConfig();
  if (!cfg.workspaceId) throw new CloudError('not_configured', 'connect a workspace first');
  const r = await cloudFetch('POST', '/v1/sync/retrigger', { body: { jobIds: ids } });
  return { ok: true, requeued: (r && r.requeued) || [], skipped: (r && r.skipped) || [] };
}

// Self-heal cloud fire failures (reactive; called from the tick after reconcile). When a
// failure is past the backoff: reseal the local tokens ONCE (a stale cloud token - e.g. a
// local re-auth not yet forwarded - self-heals before the re-fire), then retrigger the due
// failures. A genuinely-dead key keeps failing and is surfaced as a pendpost_health blocker
// (the one place a human is alerted); everything else converges on its own. Best-effort:
// a transport hiccup never throws into the tick. Scoped to the bound client by the caller.
export async function remediateCloudFailures(failed = [], { now = Date.now() } = {}) {
  const list = Array.isArray(failed) ? failed : [];
  const due = list.filter((f) => {
    const t = f && f.firedAt ? Date.parse(f.firedAt) : 0;
    return !Number.isFinite(t) || t <= 0 || (now - t) > RETRY_BACKOFF_MS;
  });
  if (!due.length) return { ok: true, resealed: false, retriggered: [] };
  // Reseal only when there IS a due re-fire (never per-tick while a job sits in backoff).
  let resealed = false;
  try { await handLocalTokens(); resealed = true; } catch { /* reseal is best-effort; never blocks the retrigger */ }
  const ids = due.map((f) => f.jobId).filter(Boolean);
  let retriggered = [];
  if (ids.length) {
    try { retriggered = (await retriggerJobs(ids)).requeued; } catch { /* best-effort */ }
  }
  return { ok: true, resealed, retriggered };
}

// Lift the cloud's staleness holds (reactive; called from the tick after remediate).
// The worker parks any job more than 15 min past due as 'stale_held' and fires it ONLY
// on an explicit retrigger - it cannot know whether our backstop already published
// while it was down. Retriggering is therefore the LOCAL PLAN's assertion: for each
// held job whose post is still UNPOSTED here, re-trigger it and record the handoff in
// state.cloudRetriggered - the scheduler's backstop anchors on that timestamp, so the
// cloud gets a full fresh grace window after every handoff and the two firers can
// never overlap. A held job whose post IS posted (backstop or owner-manual) is left
// parked: it can never auto-fire, so it is simply inert. Best-effort: a transport
// hiccup never throws into the tick; the hold persists, so the next tick retries.
export async function retriggerHeldJobs(held = []) {
  const list = Array.isArray(held) ? held : [];
  const unposted = [];
  for (const h of list) {
    if (!h || !h.jobId) continue;
    const { campaign: c } = findCampaign(h.campaign);
    const p = c && (c.posts || []).find((x) => x.id === h.postId);
    if (!p || p.status === 'posted') continue; // the double-post guard
    unposted.push(h);
  }
  if (!unposted.length) return { ok: true, retriggered: [] };
  const keyOf = (h) => `${h.campaign}:${h.postId}:${h.lane}`;
  // Anchor FIRST, durably, BEFORE the cloud can act on the handoff: were the retrigger
  // to land without the anchor, this tick's walk could backstop-fire the same post the
  // cloud is now firing. If the anchor cannot be written, skip the retrigger entirely
  // this tick (the hold persists; the next tick retries) - fail toward once-late,
  // never toward double.
  const prev = {};
  try {
    const s = loadState();
    if (!s.cloudRetriggered || typeof s.cloudRetriggered !== 'object') s.cloudRetriggered = {};
    const at = new Date().toISOString();
    for (const h of unposted) {
      prev[keyOf(h)] = s.cloudRetriggered[keyOf(h)];
      s.cloudRetriggered[keyOf(h)] = { jobId: h.jobId, at };
    }
    saveState();
  } catch {
    return { ok: false, retriggered: [] };
  }
  let requeued = [];
  try { requeued = (await retriggerJobs(unposted.map((h) => h.jobId))).requeued; } catch { /* hold persists; next tick retries */ }
  // Roll back the anchor for any job that was NOT actually handed off, so a failed
  // retrigger never suppresses the local backstop (which would strand the post with
  // NEITHER firer). A crash between write and rollback costs one grace window, no more.
  const missed = unposted.filter((h) => !requeued.includes(h.jobId));
  if (missed.length) {
    try {
      const s = loadState();
      if (s.cloudRetriggered && typeof s.cloudRetriggered === 'object') {
        for (const h of missed) {
          if (prev[keyOf(h)]) s.cloudRetriggered[keyOf(h)] = prev[keyOf(h)];
          else delete s.cloudRetriggered[keyOf(h)];
        }
        saveState();
      }
    } catch { /* rollback is best-effort; worst case is one grace window of delay */ }
  }
  return { ok: true, retriggered: requeued };
}

export async function reconcileAlwaysOnBrands() {
  const active = activeClientId();
  const merged = { ok: true, patched: [], skipped: [], refused: [] };
  for (const { clientId } of listBrands().filter((b) => b.alwaysOn)) {
    const r = clientId === active
      ? await reconcileCloudResults()
      : await withClient(clientRoot(clientId), () => reconcileCloudResults());
    for (const k of ['patched', 'skipped', 'refused']) {
      if (r && Array.isArray(r[k])) merged[k].push(...r[k]);
    }
  }
  return merged;
}
