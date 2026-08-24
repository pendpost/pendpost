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
import { readEnv, writeEnvVars, removeEnvVars, globalEnvPath, logLine } from './util.mjs';
import { loadPlanStore, findCampaign } from './plans.mjs';
import { isCarouselPost } from './carousel.mjs';
import { mutatePlan, resolvePlanPath } from './planWrite.mjs';
import { activeClientId, clientRoot } from './multi-client.mjs';
import { listClients } from './clients.mjs';
import { eligibleDuePosts, lanesOwed, lanePlatforms, ENGINES, appendActivity, CLOUD_LANES, openPostKeys } from './scheduler.mjs';
import { buildPublishJob } from './publish-job.mjs';
import { fileSha256, loadState, saveState, isLaneBlocked, recordLaneBlock } from './state.mjs';
import { stampEngager } from './engagers.mjs';
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

// Render a caught cloud error as a legible one-line log string. When the cloud ANSWERED with
// an HTTP status (a CloudError from cloudFetch), surface `http <status> (<code>)` - a 5xx is
// additionally marked a server-side fault - so a recurrence names its cause instead of hiding
// behind the raw body (e.g. a 500 whose body is the opaque string "internal error"). A
// status-less error (network/config) falls back to its own message, so there is never a bogus
// "http null". CloudError messages never contain the api key, so this is safe to log.
export function describeCloudError(e) {
  if (e && Number.isFinite(e.status)) {
    const fault = e.status >= 500 ? ' server-side fault' : '';
    return `http ${e.status} (${e.code || 'error'})${fault}: ${e.message}`;
  }
  return (e && e.message) || String(e);
}

// Spec 05 / Spec 18 / Spec 39 (cloud-parity honesty): whether the cloud can FIRE this
// post today. THREE post shapes are LOCAL-fired only until their cloud companion ships:
//   - CAROUSEL (spec 05): the push envelope is a content-addressed REFERENCE to the
//     plan blob; a single-media post's bytes ride the media manifest (one mediaSha256),
//     but a carousel's ordered slide bytes have NO upload seam, so the cloud never
//     receives the slides and a pushed carousel job would loop as an unresolvable no-op.
//   - NOSTR-LONGFORM (spec 18): nostr IS a CLOUD_LANES lane, but the cloud's vendored
//     nostr engine has no kind-30023 branch yet - a pushed article would warn-skip
//     forever or mis-publish its stale caption as a kind-1 note. So a long-form article
//     fires LOCALLY only until the cloud engine learns kind 30023 + the nostr-longform
//     type (see OWNER-HANDOFF); SHORT notes (type=text) and polls still cloud-fire.
//   - IG FEED IMAGE (spec 39): meta is a CLOUD_LANES lane and `imageUrl` is a plain
//     content field the cloud re-reads (no publish-job/N bump, no bytes move), but the
//     cloud's vendored meta engine has no type==='image' IMAGE-container branch yet -
//     a pushed IG image job would silently no-op loop, defect 1 with a longer feedback
//     loop. Held back until the companion ships (see OWNER-HANDOFF), then lift this.
// Additive gate - it touches neither CLOUD_LANES, the approval fences (buildPublishJob),
// nor the claim/reconcile flow (such a post is simply never pushed, so nothing comes
// back to reconcile); the local scheduler assembles + fires it exactly as today.
export function cloudFiresPost(post) {
  return !isCarouselPost(post) && post.type !== 'nostr-longform'
    && !(post.type === 'image' && (post.platforms || []).includes('instagram'));
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
  try { brands = await syncBrandFlags({ force: true }); } catch { brands = null; }
  const tokens = await handLocalTokens(boundClientId());
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
  const clientId = boundClientId();
  // Resolved ONCE per push, inside this brand's binding, and stamped onto every
  // envelope below.
  const expectedAccounts = expectedAccountsFor();

  const jobs = [];
  const proofs = [];
  const planByPath = new Map(); // relative planPath -> { path, sha256, bytes }
  const mediaByPath = new Map(); // mediaPath -> { mediaPath, sha256, bytes }
  const pushed = [];
  const skipped = [];

  for (const { campaign: c, post } of eligibleDuePosts(campaigns, {})) {
    // Spec 05: a carousel is LOCAL-fired only (its slide bytes have no cloud upload
    // seam yet - cloudFiresPost), so never enqueue it as a cloud no-op the worker can't
    // resolve. The local scheduler assembles + fires it exactly as today.
    if (!cloudFiresPost(post)) continue;
    // CLOUD_LANES only (same scope as the overdue backstop below): every other lane
    // is LOCAL-ONLY - the local scheduler fires it on schedule regardless of cloud
    // state, so pushing it would double-post the moment the cloud enables the lane.
    // A post owing no cloud lane skips entirely: no job, no proof, no plan/media upload.
    const lanes = lanesOwed(post).filter((l) => CLOUD_LANES.includes(l));
    if (!lanes.length) continue;

    // Build the lane envelopes FIRST (the second approval fence) so a post that
    // builds nothing never triggers an upload.
    // Pre-flight verdict per lane: a content-blocked lane throws not_ready in
    // buildPublishJob below and is SKIPPED (never pushed) - the local push is the
    // fence that keeps a blocked job off the cloud entirely. The verdict is also
    // stamped into the envelope for the cloud's ingest-time refusal (defense in
    // depth). Dynamic import breaks the writes<->cloud-client static cycle.
    const w = await import('./writes.mjs');
    const preflightCtx = w.preflightContext(post);
    const laneVerdict = (lane) => {
      const blockers = [];
      for (const platform of lanePlatforms(lane, post)) {
        const { problems, needsSetup } = w.lanePreflight(post, platform, preflightCtx);
        if (problems.length && needsSetup !== true) blockers.push({ platform, problems });
      }
      return { ok: blockers.length === 0, blockers };
    };
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
          preflight: laneVerdict(lane),
          // The accounts THIS brand's .env names, so the cloud worker can refuse a
          // credential that resolves somewhere else. Read here, inside the brand's
          // binding, from the same map that decides what gets vaulted, so the two can
          // never disagree. Only the CLOUD push carries this: the local dispatcher
          // reads its credentials from the very .env this is read from, so comparing
          // there would be a value against itself.
          expectedAccounts,
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
// (or stops firing) that brand; turning a brand ON also seals THAT brand's tokens
// into the vault and pushes its approved jobs so the cloud can actually fire them.
// The job push is best-effort (the operator can re-push), but the SEAL is fail-closed:
// a brand the cloud cannot resolve credentials for holds jobs it can never fire, the
// lanes refuse at fire time, and the local 20-minute overdue backstop lands the post
// late with no explanation - so a failed seal aborts the toggle instead.

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
  // AUTO-SEAL ON TURN-ON: seal THIS brand's tokens into the vault BEFORE anything else.
  // The vault is per-brand (migration 0035), and until 2026-08 sealing happened only at
  // connect (for the bound brand) or via the manual all-brands re-sync - so toggling a
  // SECOND brand always-on pushed jobs the cloud could never fire: its lanes refused at
  // fire time and the 20-minute overdue backstop landed the posts late, unexplained.
  // Ordered before the local flag AND the brand PUT, and fail-closed (mirroring the
  // keyless guard above and the archive flow's cloud-off abort): a failed seal must not
  // arm the cloud worker or record a local always-on the cloud cannot honor. Sealing
  // itself never starts firing (only the brand PUT does), so there is no double-post
  // window in doing it first. A brand with nothing to seal is fine - only an attempted
  // seal that FAILED (transport/ingest, not env shape) aborts. Turning OFF never seals.
  let tokens = null;
  if (connected && want) {
    tokens = await handLocalTokens(clientId);
    const failed = tokens.skipped.filter((s) => s.reason !== 'no_token_in_env' && s.reason !== 'no_account_id_in_env');
    if (failed.length) {
      const lanes = failed.map((s) => s.platform).join(', ');
      throw new CloudError('seal_failed', `could not seal this brand's tokens for: ${lanes} - the brand stays off; check the cloud connection and try again, or run a re-sync`);
    }
  }
  setBrandAlwaysOn(clientId, want);
  let push = null;
  if (connected) {
    // The api key scopes this to the workspace; the path names the local brand.
    await cloudFetch('PUT', `/v1/brands/${encodeURIComponent(clientId)}`, { body: { always_on: want } });
    // The cloud confirmed this exact flag, so the tick's re-assert has nothing to heal
    // until the interval lapses (see syncBrandFlags). Without this stamp the very next
    // tick would re-PUT the flag the owner just set.
    stampBrandFlagSync(clientId, want);
    if (want) {
      try {
        push = await withClient(clientRoot(clientId), () => pushApprovedJobs());
      } catch {
        push = null; // a push failure must not undo the toggle
      }
    }
  }
  return { ok: true, clientId, alwaysOn: want, tokens, push };
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
// How long a CONFIRMED flag is trusted before it is re-asserted. The tick calls this every
// minute, but a flag the cloud has already acknowledged cannot drift on its own - only a
// failed PUT can, and that failure is visible immediately (the record is written on success
// only). Re-asserting per tick cost ~2,880 PUTs a day per install, each one a cloud write,
// an audit row and a live Stripe subscriptions.list; six hours keeps the self-heal while
// making the steady state free. Explicit ceremonies (connect, re-sync, a drift the
// subscription view proves) pass force:true and never wait.
const FLAG_SYNC_MIN_INTERVAL_MS = 6 * 3600_000;

// Record a PUT the cloud accepted, so the next tick can skip an unchanged re-assert.
// Best-effort: a state write failure only costs one redundant PUT.
function stampBrandFlagSync(clientId, alwaysOn, at = new Date().toISOString()) {
  try {
    const s = loadState();
    if (!s.cloudFlagSync || typeof s.cloudFlagSync !== 'object') s.cloudFlagSync = {};
    s.cloudFlagSync[clientId] = { alwaysOn: Boolean(alwaysOn), at };
    saveState();
  } catch { /* the stamp is an optimization, never a correctness gate */ }
}

// Whether the cloud already confirmed this exact flag recently enough to skip the PUT.
function brandFlagFresh(clientId, want, now = Date.now()) {
  try {
    const rec = (loadState().cloudFlagSync || {})[clientId];
    if (!rec || Boolean(rec.alwaysOn) !== Boolean(want)) return false;
    const at = Date.parse(rec.at || '');
    return Number.isFinite(at) && (now - at) < FLAG_SYNC_MIN_INTERVAL_MS;
  } catch { return false; }
}

export async function syncBrandFlags({ force = false, now = Date.now() } = {}) {
  if (!getConnection().connected) return { ok: true, synced: [], skipped: [], unchanged: [] };
  const synced = [];
  const skipped = [];
  const unchanged = [];
  for (const { clientId, alwaysOn } of listBrands()) {
    const want = Boolean(alwaysOn);
    if (!force && brandFlagFresh(clientId, want, now)) { unchanged.push({ clientId, alwaysOn: want }); continue; }
    try {
      await cloudFetch('PUT', `/v1/brands/${encodeURIComponent(clientId)}`, { body: { always_on: want } });
      stampBrandFlagSync(clientId, want);
      synced.push({ clientId, alwaysOn: want });
    } catch (e) {
      skipped.push({ clientId, reason: (e && e.code) || 'sync_failed' });
    }
  }
  return { ok: true, synced, skipped, unchanged };
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

// Heal a half-written connection: the api key is present (so the workspace still
// authenticates) but cloud.json lost its workspaceId, which makes every connected-check
// read false and silently demotes the install to local firing. The subscription view
// echoes the workspaceId the key resolves to, so one authenticated read re-links the
// install WITHOUT the full connect handshake (which would mint a NEW key and reset every
// brand flag OFF). Brand always-on flags are untouched. No-ops when already connected
// or keyless. Callers: daemon startup (best-effort) + the Cloud page's reconnect action.
export async function healConnection() {
  const conn = getConnection();
  if (conn.workspaceId) return { healed: false, reason: 'already_connected' };
  if (!cloudApiKey()) return { healed: false, reason: 'no_api_key' };
  const baseUrl = conn.baseUrl || CONNECT_CLOUD_BASE;
  const view = await cloudFetch('GET', '/v1/subscription', { baseUrl });
  const workspaceId = view && typeof view.workspaceId === 'string' ? view.workspaceId.trim() : '';
  if (!workspaceId) return { healed: false, reason: 'cloud_did_not_echo_workspace' };
  await connectWorkspace({ baseUrl, workspaceId });
  return { healed: true, workspaceId };
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

// The brand whose data this call is acting on: the withClient() binding when there is
// one (the per-brand loops), else the registry-active client. Mirrors
// scheduler.publishClientId. Extracted because THREE call sites had the same
// expression inline and the reseal needed a fourth: a reseal that guesses the wrong
// brand is the 25.07.2026 incident, so it gets one definition.
function boundClientId() {
  return boundRoot() ? path.basename(boundRoot()) : activeClientId();
}

// Hand one platform token to the workspace's encrypted cloud vault over TLS. The
// token is sent in the request body and is NEVER logged here; the cloud seals it and
// returns presence only.
export async function handToken({ clientId, platform, platformAccountId, token, expiresAt = null } = {}) {
  // The BRAND is required: the vault is workspace-scoped, so a credential sealed
  // without one lands in a row no brand can resolve, and before migration 0035 it
  // silently stole the lane from whichever brand sealed earlier.
  if (typeof clientId !== 'string' || !clientId) throw new CloudError('invalid_input', 'clientId is required');
  if (typeof platform !== 'string' || !platform) throw new CloudError('invalid_input', 'platform is required');
  if (typeof platformAccountId !== 'string' || !platformAccountId) throw new CloudError('invalid_input', 'platformAccountId is required');
  if (typeof token !== 'string' || !token) throw new CloudError('invalid_input', 'token is required');
  return cloudFetch('PUT', `/v1/vault/${encodeURIComponent(platform)}`, {
    body: { clientId, platformAccountId, token, expiresAt },
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

// Lift the webhook ID (the numeric snowflake right after /webhooks/) out of a Discord
// incoming-webhook URL - the account key the cloud vault stores Discord under. Returns
// '' for a malformed/absent URL, so the entry is skipped like any other missing account.
function discordWebhookId(url) {
  try {
    const parts = new URL(String(url)).pathname.split('/').filter(Boolean); // [...,'webhooks','<id>','<token>']
    const i = parts.indexOf('webhooks');
    return i >= 0 && parts[i + 1] ? parts[i + 1] : '';
  } catch { return ''; }
}

// A host the cloud (Fly) can actually reach: reject loopback / private-range IPs /
// link-local / .internal / .flycast / .local, which the cloud vault-ingest treats as
// SSRF targets and rejects (400). Mirrors that server-side filter so a dev's private
// relay never poisons the whole PUT.
function isPublicHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return false;
  if (h.endsWith('.internal') || h.endsWith('.flycast') || h.endsWith('.local')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) { // IPv4 literal
    const [a, b] = h.split('.').map(Number);
    if (a === 0 || a === 127 || a === 10) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false; // link-local
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT (RFC 6598)
    return true;
  }
  if (h.includes(':')) { // IPv6 literal
    if (h === '::1' || h === '::') return false;
    if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return false; // ULA / link-local
    return true;
  }
  return true; // a public DNS name
}

// Filter a comma-separated NOSTR_RELAYS list down to the PUBLIC wss:// relays the cloud
// can dial. The cloud rejects (400) ws:// and private/SSRF hosts, so sending them would
// fail the entire vault PUT; we seal only the reachable subset (original spelling kept).
function publicWssRelays(raw) {
  const out = [];
  for (const s of String(raw || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    let u;
    try { u = new URL(s); } catch { continue; }
    if (u.protocol !== 'wss:') continue;
    if (!isPublicHost(u.hostname)) continue;
    out.push(s);
  }
  return out;
}

// Per-platform: which local .env values make up the token + the account id the cloud
// vault is keyed on. The operator-side inverse of the cloud worker's tokenEnvFor
// mapping: it reads from the SAME .env the local engines read. The token VALUE is
// read here ONLY to seal it into the vault over TLS - never logged, never returned.
// Most lanes are a single token; a few carry a compound shape the cloud worker unpacks:
//   - x        : OAuth1's four keys, bundled as JSON under one vault entry.
//   - discord  : the token IS the full webhook URL (the worker POSTs to it directly and
//                REJECTS any token that isn't an /api/webhooks/ URL); the account id is
//                the webhook id lifted out of that URL.
//   - nostr    : a JSON bundle { privateKey, relays } - the nsec/hex signing key plus the
//                public wss:// relays the cloud will fan out to; the account id is the npub.
// WHICH .env value is a platform's ACCOUNT. Split out of PLATFORM_TOKEN_SOURCES so the
// account a post is EXPECTED to land on (expectedAccountsFor, sealed into the publish-job
// envelope) and the account the credential is VAULTED under are the same expression, by
// construction. Two separate definitions could drift, and a drift between "where the owner
// approved this to go" and "where the credential points" is exactly the 25.07.2026 incident.
// Reads only non-secret identifiers; the token values live in PLATFORM_TOKEN_SOURCES below.
const PLATFORM_ACCOUNT_IDS = Object.freeze({
  facebook: (e) => e('META_PAGE_ID'),
  instagram: (e) => e('META_IG_USER_ID'),
  linkedin: (e) => e('LINKEDIN_ORG_URN'),
  youtube: (e) => e('YT_CHANNEL_ID'),
  x: (e) => e('X_HANDLE'),
  telegram: (e) => e('TELEGRAM_CHANNEL_ID'),
  discord: (e) => discordWebhookId(e('DISCORD_WEBHOOK_URL')),
  nostr: (e) => e('NOSTR_NPUB'),
  bluesky: (e) => e('BLUESKY_HANDLE') || e('BSKY_HANDLE'),
});

const PLATFORM_TOKEN_SOURCES = Object.freeze({
  facebook: (e) => ({ token: e('META_PAGE_TOKEN'), accountId: PLATFORM_ACCOUNT_IDS.facebook(e) }),
  instagram: (e) => ({ token: e('META_PAGE_TOKEN'), accountId: PLATFORM_ACCOUNT_IDS.instagram(e) }),
  linkedin: (e) => ({ token: e('LINKEDIN_ACCESS_TOKEN'), accountId: PLATFORM_ACCOUNT_IDS.linkedin(e), expiresAt: isoFromEpoch(e('LINKEDIN_TOKEN_EXPIRES_AT')) }),
  youtube: (e) => ({ token: e('YT_REFRESH_TOKEN'), accountId: PLATFORM_ACCOUNT_IDS.youtube(e) }),
  x: (e) => {
    const oauth1 = e('X_API_KEY') && e('X_API_SECRET') && e('X_ACCESS_TOKEN') && e('X_ACCESS_TOKEN_SECRET');
    if (oauth1) {
      return {
        token: JSON.stringify({ apiKey: e('X_API_KEY'), apiSecret: e('X_API_SECRET'), accessToken: e('X_ACCESS_TOKEN'), accessTokenSecret: e('X_ACCESS_TOKEN_SECRET') }),
        accountId: PLATFORM_ACCOUNT_IDS.x(e),
      };
    }
    return { token: e('X_ACCESS_TOKEN'), accountId: PLATFORM_ACCOUNT_IDS.x(e), expiresAt: isoFromEpoch(e('X_TOKEN_EXPIRES_AT')) };
  },
  telegram: (e) => ({ token: e('TELEGRAM_BOT_TOKEN'), accountId: PLATFORM_ACCOUNT_IDS.telegram(e) }),
  discord: (e) => {
    const url = e('DISCORD_WEBHOOK_URL');
    return { token: url, accountId: PLATFORM_ACCOUNT_IDS.discord(e) };
  },
  nostr: (e) => {
    const relays = publicWssRelays(e('NOSTR_RELAYS'));
    const privateKey = e('NOSTR_PRIVATE_KEY');
    // No reachable relay -> no useful bundle: leave token '' so it is skipped (the cloud
    // could not fire a relay-less account anyway), never a 400-guaranteed PUT.
    return {
      token: (privateKey && relays.length) ? JSON.stringify({ privateKey, relays }) : '',
      accountId: PLATFORM_ACCOUNT_IDS.nostr(e),
    };
  },
  bluesky: (e) => ({ token: e('BLUESKY_APP_PASSWORD') || e('BSKY_APP_PASSWORD'), accountId: PLATFORM_ACCOUNT_IDS.bluesky(e) }),
});

// The account each platform is EXPECTED to publish to for the CURRENTLY BOUND client,
// read from that client's own .env. Sealed into the publish-job envelope
// (payloadRef.expectedAccounts) so the executor can refuse when the credential it
// resolved names a different account. Non-secret identifiers only - safe to persist in
// an envelope and to log. A platform with no identifier set yields null, which the
// executor treats as "no expectation" rather than "expect nothing".
export function expectedAccountsFor() {
  const e = (name) => readEnv(name) || '';
  const out = {};
  for (const [platform, accountIdOf] of Object.entries(PLATFORM_ACCOUNT_IDS)) {
    out[platform] = accountIdOf(e) || null;
  }
  return Object.freeze(out);
}

// Read the platform tokens already in the local .env and seal each into the cloud
// vault (PUT /v1/vault/:platform). The frictionless migration path for an existing
// self-host operator: no manual re-entry. Returns a per-platform summary recording
// WHETHER a token was handed over, NEVER the value (the value travels only in the
// request body over TLS; it is never logged or returned). A platform with no token
// or no account id in .env is skipped, not an error.
// Takes the BRAND whose .env is being sealed, explicitly, and binds to that brand's
// root itself rather than inheriting whatever happened to be bound. That ambient read
// is the local half of the 25.07.2026 incident: the vault was workspace-keyed and this
// function had no brand at all, so every reseal overwrote the lane for all brands and
// the most recent writer won. The clientId now travels with the credential, so two
// brands' Instagram rows coexist and each resolves only its own.
export async function handLocalTokens(clientId) {
  if (!clientId || typeof clientId !== 'string') {
    throw new CloudError('invalid_input', 'handLocalTokens(clientId) requires the brand whose .env is being sealed');
  }
  // Same active-vs-bound conditional as pushAlwaysOnBrands: the ACTIVE client must run
  // UNBOUND so it respects activeRoot()'s no-registry fallback, because a lone default
  // client's .env lives at the workspace root, NOT data/clients/default. Binding it
  // unconditionally would read an empty .env, seal nothing, and (with the cloud now
  // failing closed) leave every lane refusing.
  const seal = () => sealBoundEnvTokens(clientId);
  return clientId === activeClientId() ? seal() : withClient(clientRoot(clientId), seal);
}

// Re-seal every brand the workspace knows about, each from its OWN .env, folding the
// per-brand results into one summary. This is what a re-sync and the operator's
// "hand tokens" action mean now that the vault is per-brand: sealing one brand says
// nothing about the others, and an unsealed brand's lanes refuse. Best-effort per
// brand so one broken .env cannot block the rest.
export async function sealAllBrands() {
  const handed = [];
  const skipped = [];
  const brands = [];
  for (const { clientId } of listBrands()) {
    try {
      const r = await handLocalTokens(clientId);
      handed.push(...r.handed);
      skipped.push(...r.skipped.map((s) => ({ ...s, clientId })));
      brands.push({ clientId, ok: true });
    } catch (err) {
      brands.push({ clientId, ok: false, reason: (err && err.code) || 'seal_failed' });
    }
  }
  return { ok: true, brands, handed, skipped };
}

// The seal itself, always executed inside the owning brand's binding by handLocalTokens.
async function sealBoundEnvTokens(clientId) {
  const e = (name) => readEnv(name) || '';
  const handed = [];
  const skipped = [];
  for (const [platform, source] of Object.entries(PLATFORM_TOKEN_SOURCES)) {
    const { token, accountId, expiresAt = null } = source(e);
    if (!token) { skipped.push({ platform, reason: 'no_token_in_env' }); continue; }
    if (!accountId) { skipped.push({ platform, reason: 'no_account_id_in_env' }); continue; }
    try {
      await handToken({ clientId, platform, platformAccountId: accountId, token, expiresAt });
      handed.push({ platform, platformAccountId: accountId, clientId });
    } catch (err) {
      skipped.push({ platform, reason: (err && err.code) || 'ingest_failed' });
    }
  }
  return { ok: true, clientId, handed, skipped };
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
  // Re-seal EVERY brand's .env, not just the active one. The vault is per-brand since
  // migration 0035, so a re-sync that sealed only the active client would leave every
  // other brand's lanes unresolvable - and with the cloud now failing closed, silently
  // refusing rather than silently publishing to the wrong account.
  const tokens = await sealAllBrands();
  // Reconcile every brand's always-on FLAG to the workspace first (the billing + worker-fence
  // inverse of the job push below), so a re-sync also heals brand-flag drift, not just jobs.
  const brands = await syncBrandFlags({ force: true });
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

// The refusal codes that mean "the cloud could not prove where this post would land"
// (apps/runtime/src/engines/spawn.ts CredentialRefusalError). Unlike a paused workspace
// or a brand toggled off, these are misconfigurations only the operator can clear, and
// the post stays unpublished until they do, so they are surfaced as failures.
const CREDENTIAL_REFUSALS = new Set(['account_unresolved', 'account_mismatch']);

// What happened, why, and the one action that recovers.
const CREDENTIAL_REFUSAL_MESSAGE = Object.freeze({
  account_unresolved: 'Nothing was published: this project has no connected account for that platform in the cloud. Reconnect the lane for this project under Einrichtung.',
  account_mismatch: 'Nothing was published: the connected cloud account is not the one this post was approved for. Reconnect the lane for this project under Einrichtung.',
});

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
    // Cloud lanes (CLOUD_LANES): the cloud fires these, so reconcile MUST map their
    // done-result id back to the plan or the post never flips to posted and the local
    // backstop double-fires it.
    case 'telegram': return 'tgMessageId';
    case 'discord': return 'dcMessageId';
    case 'nostr': return 'nostrEventId';
    // The remaining wave-2 lanes are LOCAL-ONLY (not in CLOUD_LANES) - the cloud never
    // fires them, so these arms are defensive parity with platformPending only.
    case 'mastodon': return 'mastodonStatusId';
    case 'wordpress': return 'wordpressPostId';
    case 'ghost': return 'ghostPostId';
    case 'gbp': return 'gbpPostId';
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
  const clientId = boundClientId();

  const data = await getCloudResults({ since });
  const results = (data && data.results) || [];

  // Group THIS client's `done` results by (campaign, postId) and merge every minted id
  // across lanes, so a multi-lane post flips to posted ONCE carrying all its ids (never
  // a partial-id posted state). Refused/failed are collected for the summary only.
  const groups = new Map(); // `${campaign}\x00${postId}` -> { campaign, postId, firedAt, entries }
  const refused = [];
  const failed = [];
  const held = [];
  const radarGone = [];
  for (const r of results) {
    if (r.clientId !== clientId) continue;
    if (r.state === 'failed') {
      // Spec 45 cloud parity: a Radar reply to a GONE tweet (errorCode radar_target_gone) is
      // TERMINAL, not a recoverable failure. Route it to the terminal-stamp pass below instead
      // of the self-healer, so the lane STOPS being owed rather than looping the local backstop
      // against a since-deleted tweet (a 404 posts nothing, so it never double-posts - it loops).
      if (r.errorCode === 'radar_target_gone') { radarGone.push({ campaign: r.campaign, postId: r.postId, lane: r.lane }); continue; }
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
      // jobId rides along so a credential refusal can be retriggered once the operator
      // reconnects the lane (see CREDENTIAL_REFUSALS below).
      refused.push({ jobId: r.jobId, campaign: r.campaign, postId: r.postId, lane: r.lane, state: r.state, refusedCode: r.refusedCode || null });
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
  const radarTerminal = [];
  // Posts that are now LIVE but were NOT patched this poll: already posted by a prior action
  // - most importantly the LOCAL backstop's own publish, which never flows through `patched`.
  // They must still clear any stale cloudFailures entry, else a post the cloud once failed and
  // the backstop then published keeps looking failed in the pendpost_health roll-up forever.
  const alreadyLive = [];
  for (const g of groups.values()) {
    const { campaign: c } = findCampaign(g.campaign);
    if (!c) { skipped.push({ postId: g.postId, outcome: 'unknown_campaign' }); continue; }
    const existing = (c.posts || []).find((p) => p.id === g.postId);
    if (!existing) { skipped.push({ postId: g.postId, outcome: 'unknown_post' }); continue; }
    // Idempotency fast-path: an already-posted post (cloud OR owner-manual) is left
    // exactly as-is - never re-patched, and mutatePlan (which always rewrites) is not
    // called, so the plan file does not churn on every poll.
    if (existing.status === 'posted') { skipped.push({ postId: g.postId, outcome: 'already_posted' }); alreadyLive.push({ campaign: g.campaign, postId: g.postId }); continue; }

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
      // Posted under the lock (another actor between the fast-path and here) is also now
      // live - clear its stale failure below.
      if (outcome === 'already_posted') alreadyLive.push({ campaign: g.campaign, postId: g.postId });
    }
  }
  // Spec 45 cloud parity: stamp radarReplyState='target_gone' for a cloud-fired reply whose
  // target tweet is gone (404). Mirrors the local engine's own terminal write (scripts/
  // x-social.mjs), so the scheduler's lanesOwed stops owing the lane. Without it a cloud-fired
  // dead-tweet reply would be re-owed every tick (it never double-posts - a 404 posts nothing -
  // but it loops). Idempotent: an already-stamped post is skipped without touching the plan file.
  for (const rg of radarGone) {
    const { campaign: c } = findCampaign(rg.campaign);
    if (!c) { skipped.push({ postId: rg.postId, outcome: 'unknown_campaign' }); continue; }
    const existing = (c.posts || []).find((p) => p.id === rg.postId);
    if (!existing) { skipped.push({ postId: rg.postId, outcome: 'unknown_post' }); continue; }
    if (existing.radarReplyState === 'target_gone') { skipped.push({ postId: rg.postId, outcome: 'already_target_gone' }); continue; }
    const planAbs = resolvePlanPath(c.path);
    let outcome;
    try {
      outcome = await mutatePlan(planAbs, (plan) => {
        const p = (plan.posts || []).find((x) => x.id === rg.postId);
        if (!p) return 'unknown_post';
        if (p.radarReplyState === 'target_gone') return 'already_target_gone'; // re-check under the lock
        p.radarReplyState = 'target_gone';
        return 'stamped';
      });
    } catch (e) {
      skipped.push({ postId: rg.postId, outcome: e.code || 'write_failed' });
      continue;
    }
    if (outcome === 'stamped') {
      radarTerminal.push({ campaign: rg.campaign, postId: rg.postId });
      try {
        appendActivity({ campaign: rg.campaign, postId: rg.postId, platform: null, action: 'cloud-reconcile', ok: false, errorCode: 'radar_target_gone', errorMessage: 'the reply target is gone (terminal)', lateMin: null, actor: 'cloud' });
      } catch { /* activity is best-effort */ }
    } else {
      skipped.push({ postId: rg.postId, outcome });
    }
  }
  // Cache per-post cloud failure messages for pendpost_health (set on failed; cleared
  // when the post is now posted), so the operator sees WHY a post is stuck without a
  // live cloud call. Best-effort and only when something changed (no per-tick churn).
  // `nowLive` = every post posted as a result of this reconcile (patched) OR already posted by
  // a prior action (alreadyLive, incl. the local backstop). Each must clear a stale failure.
  const nowLive = patched.concat(alreadyLive);
  // A CREDENTIAL refusal is a real, operator-actionable stuck post and must be as loud
  // as a failure. Before this it was invisible: reconcile put every non-done/failed/held
  // state into a summary-only `refused` array, and cloudFailures was written ONLY from
  // `failed` - so a refused job never reached the health roll-up, never set
  // connection.sync.broken, and was never retriggered. Making the cloud fail closed
  // without this would have swapped a silent WRONG publish for a silent NO publish.
  //
  // Deliberately only the credential codes. The other refusals (workspace paused, brand
  // off, entitlement) are expected, reversible states already shown in the cloud and
  // billing UI; routing those here would fill the failure surface with normal operation.
  const credentialRefusals = refused.filter((r) => CREDENTIAL_REFUSALS.has(r.refusedCode));
  if (failed.length || refused.length || nowLive.length) {
    try {
      const s = loadState();
      if (!s.cloudFailures || typeof s.cloudFailures !== 'object') s.cloudFailures = {};
      const at = new Date().toISOString();
      // Track whether anything actually changed. alreadyLive recurs in the cloud results every
      // poll (a done post stays done), so gating saveState on a real mutation is what keeps this
      // from churning state to disk on every tick once the stale entry is already gone.
      let mutated = false;
      // /v1/sync/results is a HISTORY, not a delta: it replays every terminal result the
      // workspace ever recorded, including failures whose post the local backstop published
      // weeks ago. Writing those back would re-create the very relics pruneCloudMarkers just
      // deleted, on every single poll - a state write per tick, and an in-flight gate that
      // can never close. A failure is only meaningful while its post is still OPEN (approved
      // and unposted), which is exactly the condition cloudSyncStatus already reads it under.
      const open = openPostKeys();
      // MERGE, never replace: `retries` and `terminal` are owned by remediateCloudFailures
      // and must survive this poll's rewrite, or the attempt cap resets every 60s and the
      // re-fire loop becomes unbounded again. Everything else is the cloud's latest word.
      for (const f of failed) {
        const k = `${f.campaign}:${f.postId}`;
        if (!open.has(k)) continue;
        const prev = (s.cloudFailures[k] && typeof s.cloudFailures[k] === 'object') ? s.cloudFailures[k] : {};
        s.cloudFailures[k] = { ...prev, lane: f.lane, jobId: f.jobId, message: f.failureMessage, at };
        mutated = true;
        // X HTTP 402 (API credits depleted) seen from a CLOUD fire: arm the SAME
        // lane-wide block the local publish path arms (lib/scheduler.mjs), so one
        // failure halts the lane on both firers until the operator resumes it.
        if (f.lane === 'x' && /HTTP 402/.test(String(f.failureMessage || '')) && !isLaneBlocked('x')) {
          try { recordLaneBlock('x', { code: 'credits', reason: String(f.failureMessage || '').slice(0, 300) }); } catch { /* best-effort */ }
        }
      }
      for (const r of credentialRefusals) {
        const k = `${r.campaign}:${r.postId}`;
        if (!open.has(k)) continue;
        const prev = (s.cloudFailures[k] && typeof s.cloudFailures[k] === 'object') ? s.cloudFailures[k] : {};
        s.cloudFailures[k] = { ...prev, lane: r.lane, jobId: r.jobId, message: CREDENTIAL_REFUSAL_MESSAGE[r.refusedCode], refusedCode: r.refusedCode, at };
        mutated = true;
      }
      for (const p of nowLive) {
        const k = `${p.campaign}:${p.postId}`;
        if (s.cloudFailures[k]) { delete s.cloudFailures[k]; mutated = true; }
      }
      // The matching push-ack records are now redundant (the post is posted, so the
      // eligibility walk excludes it anyway); drop every lane's key so cloudAccepted
      // never grows past the live backlog. Keyed campaign:postId:lane - prefix-match.
      // Keyed off nowLive, NOT `patched`: a post the LOCAL backstop published reconciles
      // as already_posted and never appears in `patched`, so clearing on patched alone
      // left its ack behind forever - 17 of this install's 24 acks were exactly that, and
      // each one held the in-flight gate (and the cloud polling) open.
      const clearLaneKeys = (map, campaign, postId) => {
        if (!map || typeof map !== 'object') return;
        const prefix = `${campaign}:${postId}:`;
        for (const k of Object.keys(map)) if (k.startsWith(prefix)) { delete map[k]; mutated = true; }
      };
      for (const p of nowLive) {
        clearLaneKeys(s.cloudAccepted, p.campaign, p.postId);
        // Same for the stale-held handoff anchors: a now-posted post's cloudRetriggered
        // entries have done their job (the backstop stood down).
        clearLaneKeys(s.cloudRetriggered, p.campaign, p.postId);
      }
      // A TERMINAL refusal ends the round-trip just as a fire does: the cloud will never
      // publish this job (the brand is off, the workspace is paused, the entitlement is
      // gone), so its ack is not in-flight work either. The credential refusals are
      // deliberately excluded - those stay in flight, because reconnecting the lane and
      // retriggering is exactly the recovery path, and cloudFailures already tracks them.
      for (const r of refused) {
        if (CREDENTIAL_REFUSALS.has(r.refusedCode)) continue;
        clearLaneKeys(s.cloudAccepted, r.campaign, r.postId);
        clearLaneKeys(s.cloudRetriggered, r.campaign, r.postId);
      }
      if (mutated) saveState();
    } catch { /* cache is best-effort */ }
  }
  return { ok: true, patched, skipped, refused, failed, held, radarTerminal };
}

// Active reachability probe: one cheap GET /v1/health per tick. cloudFetch already
// stamps cloudContact (okAt on reach, errorAt on network failure), so this keeps okAt
// honest during QUIET periods too - not just as a side-effect of push/reconcile - which
// is the difference between "unreachable" meaning genuinely down vs merely idle. It also
// captures the one liveness signal nothing else here sees: the cloud's OWN publisher
// worker. /v1/health returns { worker: { ok, stale } }; a reachable cloud whose worker is
// wedged accepts jobs and fires nothing (the silent-drop class from the Jul incident), so
// we record workerStale for the status roll-up. Best-effort; the write is guarded so a
// steady state does not churn state.json every minute. Skips when not cloud-configured.
export async function cloudHealthPing() {
  const cfg = readCloudConfig();
  if (!cfg.workspaceId || !cloudApiKey()) return null;
  let data;
  try {
    data = await cloudFetch('GET', '/v1/health');
  } catch { return null; } // contact already stamped errorAt; nothing else to record
  const workerStale = Boolean(data && data.worker && (data.worker.stale === true || data.worker.ok === false));
  try {
    const s = loadState();
    const prev = (s.cloudContact && typeof s.cloudContact === 'object') ? s.cloudContact : {};
    if (prev.workerStale !== workerStale) { s.cloudContact = { ...prev, workerStale }; saveState(); }
  } catch { /* workerStale bookkeeping is best-effort */ }
  return { ok: true, workerStale };
}

// ---- the cloud guarantee roll-up (the header dot) ---------------------------------
//
// PURE READ, zero network: computed from state.json (the tick's bookkeeping) + the
// plan store, so /api/cloud stays fast and truthful even while the cloud is down.
// The contract the owner sees on the header cloud icon - FOUR severities (the state
// field is 'green' | 'yellow' | 'amber' | 'red'; the GUI paints yellow and amber the
// same colour but they mean different things and carry different copy):
//   green  - every approved, fully-scheduled post owing a CLOUD lane is ack'd by the
//            cloud, contact is fresh, nothing failed: "everything on the cloud WILL post"
//   yellow - >=1 owed cloud-lane job has no push-ack yet (normal for <=1 tick after
//            approving; persistent yellow = pushes not landing). reason: push_pending
//   amber  - delivery is DEGRADED but the local backstop covers it while the Mac is
//            awake, so it is attention, not failure: cloud unreachable past grace,
//            its worker wedged, sync stopped (quota), or the on-flag drifted. reasons:
//            cloud_unreachable / worker_stale / sync_stopped / flag_divergence
//   red    - the guarantee is BROKEN, a post is at risk RIGHT NOW: an approved post
//            overdue-unpublished, a failed cloud fire, or a plan that cannot be read to
//            fire at all. reasons: overdue_unpublished / cloud_failures / manifest_error.
//            The scheduler's backstop still fires locally, but red demands attention.
// An ack proves ACCEPTANCE only, never that the job will fire (the workspace-collision
// incident acked everything and fired nothing) - which is why overdue-unpublished is a
// red condition of its own, independent of acks. Scope: CLOUD_LANES only; local-only
// lanes surface through pendpost_health exactly as before. Returns null when the
// active brand is not cloud-managed (the dot then falls back to the local states).
const SYNC_STALE_GRACE_MS = 10 * 60_000; // aligns with pendpost_health's OVERDUE_GRACE_MS
// The reason -> severity vocabulary, single-sourced. The MCP cloud_status outputSchema
// enum imports these, and a drift test asserts every reason has a locale key, so a new
// reason cannot be added here and silently missed by the agent face or the popover copy.
export const SYNC_STATES = ['green', 'yellow', 'amber', 'red'];
export const SYNC_RED_REASONS = ['overdue_unpublished', 'cloud_failures', 'manifest_error'];
const SYNC_AMBER_REASONS = ['cloud_unreachable', 'worker_stale', 'sync_stopped', 'flag_divergence'];
// Every reason cloudSyncStatus can emit. all_confirmed=green, push_pending=yellow, the
// rest map to amber/red via SYNC_RED_REASONS below.
export const SYNC_REASONS = ['all_confirmed', 'push_pending', ...SYNC_AMBER_REASONS, ...SYNC_RED_REASONS];
export function cloudSyncStatus() {
  const cfg = readCloudConfig();
  const clientId = boundClientId();
  if (!cfg.workspaceId || !brandAlwaysOn(clientId) || !cloudApiKey()) return null;
  const s = loadState();
  const now = Date.now();

  const okAtIso = s.cloudContact && s.cloudContact.okAt ? s.cloudContact.okAt : null;
  const okAt = okAtIso ? Date.parse(okAtIso) : NaN;
  const contactStale = !Number.isFinite(okAt) || (now - okAt) > SYNC_STALE_GRACE_MS;
  // Only trust the worker-stale flag while contact is FRESH - if we cannot reach the
  // cloud, its last-known worker state is stale information, and "unreachable" already
  // covers it (checked first below).
  const workerStale = !contactStale && Boolean(s.cloudContact && s.cloudContact.workerStale);
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
      // Spec 05: a carousel is LOCAL-fired only (cloudFiresPost) - it is never pushed, so it
      // must never count toward cloud pending/overdue (the local scheduler covers it, like a
      // local-only lane). Keeps the health dot honest instead of red-flagging the cloud for a
      // post the cloud was never given.
      if (!cloudFiresPost(post)) continue;
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

  // Reasons in severity order - the FIRST match is the headline the popover shows.
  // Post-SAFETY reasons (a post is actually overdue/failed, or a plan can't be read to
  // fire at all) come FIRST so a genuine miss is never masked by a mere connectivity
  // blip. Then CONNECTIVITY/quota reasons (cloud can't be reached / its worker is wedged
  // / sync is stopped / the on-flag drifted) - the local backstop covers these while the
  // Mac is awake, so they are attention (amber), not failure. Then the transient
  // syncing state (yellow), then all-clear (green).
  const reason = overdueCount > 0 ? 'overdue_unpublished'
    : failedCount > 0 ? 'cloud_failures'
      : manifestBroken ? 'manifest_error'
        // Neon economy: a stale contact is surfaced ONLY when a push is pending it endangers. Idle
        // polling was removed (an idle daemon makes zero Neon calls so the compute can suspend), so a
        // stale okAt with nothing pending means "not polled, nothing to sync" - not "unreachable".
        : (contactStale && pendingCount > 0) ? 'cloud_unreachable'
          : workerStale ? 'worker_stale'
            : (sub && sub.syncStopped) ? 'sync_stopped'
              : (sub && sub.alwaysOn === false) ? 'flag_divergence'
                : pendingCount > 0 ? 'push_pending'
                  : 'all_confirmed';
  // Three visible severities: red = a post is at risk RIGHT NOW; amber = delivery is
  // degraded but the local backstop covers it; yellow = normal transient syncing; green.
  const state = reason === 'all_confirmed' ? 'green'
    : reason === 'push_pending' ? 'yellow'
      : SYNC_RED_REASONS.includes(reason) ? 'red'
        : 'amber';
  return { state, reason, pendingCount, failedCount, overdueCount, workerStale, lastContactAt: okAtIso };
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
// How many times a failed job is handed back to the cloud before it is declared terminal.
// Backoff bounds the rate; this bounds the total. Three is enough for a transient platform
// hiccup or a token that a reseal fixes, and short enough that a permanent refusal reaches
// the operator within the hour instead of looping unseen for weeks.
const MAX_REFIRE_ATTEMPTS = 3;

// ---- the shared atomic publish-claim (a LEASE - "truly always-on", piece 1) --------
//
// The cloud worker and this engine's BACKSTOP are two independent firers of the same
// publish-job. Before a backstop fire the scheduler asserts the shared claim (the cloud
// worker takes the same lease directly in its own store before every fire), so exactly
// one of the two can ever publish a given job:
//   acquire -> { granted, consumed, externalId, holder }. Denied+consumed = the cloud
//              already PUBLISHED it (externalId is the minted platform id): mark the
//              post posted and stand down. Denied+live-lease = the cloud is firing
//              right now: stand down this tick (the post stays due).
//   consume -> after a successful backstop fire, with the minted id (permanent).
//   release -> after a failed backstop fire, so the cloud can take over immediately.
// The holder is forced to 'local' server-side (the api key IS this engine's identity);
// no holder ever rides in the body. A claim row carries no secret: the claimKey is the
// deterministic jobId and externalId is a public platform post id.
export async function publishClaim(action, claimKey, { leaseMs = null, externalId = null } = {}) {
  if (typeof claimKey !== 'string' || !claimKey) throw new CloudError('invalid_input', 'claimKey is required');
  const body = { action, claimKey };
  if (leaseMs != null) body.leaseMs = leaseMs;
  if (externalId != null) body.externalId = externalId;
  return cloudFetch('POST', '/v1/publish-claim', { body });
}

// Mark a post posted from a CONSUMED publish claim: the cloud already published it (the
// claim's externalId is the minted platform id), so the local plan must flip to posted
// and the backstop stand down - the same write set reconcileCloudResults applies for a
// done job (minted id + status:'posted' + postedAt; no publishedVia, no externalUrl).
// `platforms` is the lane's platform list (lanePlatforms(lane, post)); the externalId
// lands on the FIRST platform that maps to a plan id field. Idempotent: an
// already-posted post is left untouched.
export async function markPostedFromClaim({ campaign, postId, platforms = [], externalId = null } = {}) {
  const { campaign: c } = findCampaign(campaign);
  if (!c) return { ok: false, outcome: 'unknown_campaign' };
  const planAbs = resolvePlanPath(c.path);
  const outcome = await mutatePlan(planAbs, (plan) => {
    const p = (plan.posts || []).find((x) => x.id === postId);
    if (!p) return 'unknown_post';
    if (p.status === 'posted') return 'already_posted';
    if (externalId) {
      for (const platform of platforms) {
        const field = idFieldFor(platform, p.type);
        if (!field) continue;
        p[field] = externalId;
        break;
      }
    }
    p.status = 'posted';
    p.postedAt = new Date().toISOString();
    return 'patched';
  });
  if (outcome === 'patched') {
    try {
      appendActivity({ campaign, postId, platform: null, action: 'cloud-reconcile', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: 'cloud' });
    } catch { /* activity is best-effort */ }
  }
  return { ok: outcome === 'patched' || outcome === 'already_posted', outcome };
}

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
  // THE DOUBLE-POST GUARD, first: never re-fire a job whose LOCAL post is already posted or
  // parked. retriggerHeldJobs has always had this check; remediate never did, and the live
  // install showed exactly what that costs - eight of nine looping jobs were for posts that
  // were already published (the local backstop got there first) or that the owner had
  // deliberately parked. The cloud keeps reporting those jobs `failed` forever, so reconcile
  // rewrites the cache entry every poll and it is never cleared by the nowLive path, which
  // only fires when the CLOUD reports the job done. So the loop ran on posts that were live.
  // The claim lease makes an actual double-post unlikely, not impossible - and re-firing a
  // published post is wrong whether or not it lands.
  //
  // A settled post also has nothing left to remediate, so its cached failure is dropped here:
  // that clears the stale reason out of the planner AND resets the attempt counter for free.
  const keyOf = (f) => `${f.campaign}:${f.postId}`;
  const settled = [];
  const live = list.filter((f) => {
    if (!f || !f.campaign || !f.postId) return false;
    const { campaign: c } = findCampaign(f.campaign);
    const p = c && (c.posts || []).find((x) => x.id === f.postId);
    // An unknown post cannot be judged - leave it to the backoff/cap path rather than
    // silently dropping a job whose plan we simply could not read.
    if (!p) return true;
    const done = p.status === 'posted' || (p.executionMode && p.executionMode !== 'fully-scheduled');
    if (done) settled.push(f);
    return !done;
  });
  if (settled.length) {
    try {
      const s = loadState();
      if (s.cloudFailures && typeof s.cloudFailures === 'object') {
        let mutated = false;
        for (const f of settled) {
          if (s.cloudFailures[keyOf(f)]) { delete s.cloudFailures[keyOf(f)]; mutated = true; }
        }
        if (mutated) saveState();
      }
    } catch { /* best-effort; the guard above already stopped the re-fire this tick */ }
  }

  const backoffDue = live.filter((f) => {
    const t = f && f.firedAt ? Date.parse(f.firedAt) : 0;
    return !Number.isFinite(t) || t <= 0 || (now - t) > RETRY_BACKOFF_MS;
  });
  if (!backoffDue.length) return { ok: true, resealed: false, retriggered: [], terminal: [], settled: settled.map(keyOf) };

  // The ATTEMPT CAP. Backoff alone bounds the RATE, never the TOTAL: before this, a job the
  // platform will never accept was re-fired every 15 minutes for as long as it sat in the
  // plan. Nine such jobs were looping on the live install (an X reply X's own API forbids,
  // plus eight media 404s from campaigns weeks old) - roughly 36 doomed calls an hour against
  // a pay-per-use API, and none of it visible to the operator.
  //
  // Deliberately GENERIC, not a per-platform error taxonomy: pendpost cannot know every
  // refusal every platform will ever invent, and a permanent one is indistinguishable from a
  // transient one until retries stop helping. After MAX_REFIRE_ATTEMPTS windows the entry is
  // stamped terminal:true, the re-fire stops, and lib/plans.mjs turns it into a visible
  // publish-failed post the operator can act on. The counter lives in state.cloudFailures and
  // is cleared with the entry the moment the post goes live, so a real recovery resets it.
  let counts = {};
  try {
    const s = loadState();
    counts = (s.cloudFailures && typeof s.cloudFailures === 'object') ? s.cloudFailures : {};
  } catch { counts = {}; }

  const due = [];
  const terminal = [];
  for (const f of backoffDue) {
    const prev = counts[keyOf(f)];
    const tries = (prev && Number.isFinite(prev.retries)) ? prev.retries : 0;
    if (tries >= MAX_REFIRE_ATTEMPTS) terminal.push(f);
    else due.push(f);
  }

  // Stamp the newly-exhausted entries terminal (idempotent: an already-terminal entry is
  // skipped, so a settled failure never churns state to disk on the next tick).
  if (terminal.length) {
    try {
      const s = loadState();
      if (s.cloudFailures && typeof s.cloudFailures === 'object') {
        let mutated = false;
        for (const f of terminal) {
          const e = s.cloudFailures[keyOf(f)];
          if (e && typeof e === 'object' && e.terminal !== true) { e.terminal = true; mutated = true; }
        }
        if (mutated) saveState();
      }
    } catch { /* the cap still holds this tick; the stamp retries next tick */ }
  }

  if (!due.length) return { ok: true, resealed: false, retriggered: [], terminal: terminal.map(keyOf), settled: settled.map(keyOf) };
  // Reseal only when there IS a due re-fire (never per-tick while a job sits in backoff).
  let resealed = false;
  // Reseal ONLY the brand this remediation is bound to. Unscoped, this ran under
  // whichever brand the tick happened to be walking and overwrote the workspace-global
  // Meta vault row every time, which is what kept handing bondigoo's Instagram lane to
  // pendpost. With the vault brand-keyed a reseal now only ever touches its own rows.
  try { await handLocalTokens(boundClientId()); resealed = true; } catch { /* reseal is best-effort; never blocks the retrigger */ }
  const ids = due.map((f) => f.jobId).filter(Boolean);
  let retriggered = [];
  if (ids.length) {
    try { retriggered = (await retriggerJobs(ids)).requeued; } catch { /* best-effort */ }
  }
  // Count the attempt only for a job we actually handed back to the cloud - a retrigger that
  // never left (transport down) must not burn a life.
  if (retriggered.length) {
    try {
      const s = loadState();
      if (!s.cloudFailures || typeof s.cloudFailures !== 'object') s.cloudFailures = {};
      const sent = new Set(retriggered);
      let mutated = false;
      for (const f of due) {
        if (!f.jobId || !sent.has(f.jobId)) continue;
        const e = s.cloudFailures[keyOf(f)];
        if (!e || typeof e !== 'object') continue;
        e.retries = (Number.isFinite(e.retries) ? e.retries : 0) + 1;
        mutated = true;
      }
      if (mutated) saveState();
    } catch { /* the count is best-effort; a missed increment costs one extra attempt */ }
  }
  return { ok: true, resealed, retriggered, terminal: terminal.map(keyOf), settled: settled.map(keyOf) };
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

// ---- inbound events (webhook / realtime ingestion seam, spec 23) -----------
//
// There is no inbound webhook seam in this MIT core by design (contract §1): a local
// process cannot receive a 24/7 public callback. So this is a PULL, the exact inverse
// mirror of the cloud->local result sync-back above: a pendpost-cloud webhook receiver
// (a REQUIRED companion change in the separate, private cloud repo - see
// docs/specs/cloud-integration-contract.md §10, NOT built here) verifies + normalizes
// every platform's comment/mention/message/reaction into ONE `inbound-event` shape and
// stores it; this engine pulls the stored feed on demand (the read tool / GET route) or
// best-effort alongside the tick. It is a READ ONLY seam: unlike reconcileCloudResults,
// it never patches a plan post (an inbound event is display/attribution data, not a
// publish result) and it carries no token/secret/media bytes.

// The frozen `type` enum (spec 23 §4a). An unknown type is DROPPED at the pull boundary
// (forward-compat, like an unknown publish-job version - contract §9).
// `follow` was added for the X Activity API (post/mention/reply/like/repost ride the
// existing comment/mention/reaction types; a like or repost carries `reaction`, but a
// FOLLOW has no post and no reaction - only an author - so it needs its own member).
// This enum is mirrored in pendpost-cloud's normalizer and MUST change in lockstep
// (contract §9 forward-compat: an unknown type is dropped, so the producer emitting
// `follow` before this consumer knew it would have silently dropped every follow).
const INBOUND_EVENT_TYPES = new Set(['comment', 'mention', 'message', 'reaction', 'follow']);

// Normalize + validate one raw cloud row to the local inbound-event shape (spec 23 §4a):
// { eventId, type, platform, clientId, postId, externalPostId, author, text, reaction,
//   parentId, permalink, ts }. Returns null for a malformed row, an unrecognized `type`,
// or an unparseable `ts` (used for display ordering + the store cap below - NOT the
// incremental-cursor axis; the cursor is the cloud's own opaque `cursor`, see
// reconcileInboundEvents) - dropped, never thrown. Strips any field outside the frozen
// schema, so a cloud row carrying more than this shape (it must never carry a
// token/secret/media bytes) never leaks an extra field through.
function normalizeInboundEvent(r) {
  if (!r || typeof r !== 'object') return null;
  if (typeof r.eventId !== 'string' || !r.eventId) return null;
  if (!INBOUND_EVENT_TYPES.has(r.type)) return null;
  if (typeof r.platform !== 'string' || !r.platform) return null;
  if (typeof r.clientId !== 'string' || !r.clientId) return null;
  if (typeof r.ts !== 'string' || !r.ts || !Number.isFinite(Date.parse(r.ts))) return null;
  const rawAuthor = (r.author && typeof r.author === 'object') ? r.author : {};
  const author = { id: typeof rawAuthor.id === 'string' ? rawAuthor.id : null };
  if (typeof rawAuthor.handle === 'string') author.handle = rawAuthor.handle;
  if (typeof rawAuthor.displayName === 'string') author.displayName = rawAuthor.displayName;
  return {
    eventId: r.eventId,
    type: r.type,
    platform: r.platform,
    clientId: r.clientId,
    postId: typeof r.postId === 'string' ? r.postId : null,
    externalPostId: typeof r.externalPostId === 'string' ? r.externalPostId : null,
    author,
    text: typeof r.text === 'string' ? r.text : null,
    reaction: typeof r.reaction === 'string' ? r.reaction : null,
    parentId: typeof r.parentId === 'string' ? r.parentId : null,
    permalink: typeof r.permalink === 'string' ? r.permalink : null,
    ts: r.ts,
  };
}

// GET /v1/sync/events -> { events: [...], cursor }. Read-only; the api key scopes it to
// the workspace. `since` is an OPAQUE, server-issued cursor (not necessarily a
// timestamp) - byte-identical in spirit to getCloudResults (:805-808), the exact
// inverse endpoint, except the cursor here rides in the response too (`cursor`) so the
// caller persists exactly what the cloud handed back, never a value it derived itself.
export async function getInboundEvents({ since = null } = {}) {
  const q = since ? `?since=${encodeURIComponent(since)}` : '';
  return cloudFetch('GET', `/v1/sync/events${q}`);
}

// A capped per-client STORE of normalized events (state.inboundEvents), keyed by
// eventId - the durable inbox itself, not just the last-pulled delta. (spec 23 review
// MAJOR-1: a consume-once cursor+delta design self-erases the inbox the moment a poll
// returns nothing, and races a second consumer - Studio's 60s poll, the MCP tool, the
// GET twin, or a second tab - each of which would otherwise steal the delta from the
// others. §4a says eventId "drives idempotent inbox merge", so every pull MERGES its
// delta into this store instead: dedupe by eventId (the newer copy wins), then keep the
// INBOUND_EVENTS_CAP most-recent by `ts`. Mirrors ACTIVITY_CAP's cap-then-persist shape
// (scheduler.mjs:26), sized generously for a display feed, not an audit log.
const INBOUND_EVENTS_CAP = 200;

// Reconcile the BOUND/active client's inbound-event feed: pull GET /v1/sync/events,
// normalize + validate every row (an unrecognized type is dropped), keep ONLY this
// client's events (the SAME r.clientId !== clientId defense-in-depth filter
// reconcileCloudResults uses, :860 - one workspace can host several brands), MERGE them
// into the durable per-client store above, and return the ACCUMULATED store (optionally
// narrowed by `type`/`postId`) rather than the bare delta - so the inbox is stable
// across polls and every consumer sees the same feed regardless of poll timing.
//
// The cursor persisted in state.inboundEventsCursor is the cloud's OWN opaque `cursor`
// from the response, stored VERBATIM - never derived from an event's `ts`. A delayed
// webhook delivery (Meta retries for minutes to hours) can carry a `ts` far in the
// past; deriving the cursor from `ts` would filter such a delivery out server-side
// forever once the local cursor had already advanced past it. The cloud's store cursor
// only moves forward in STORE order, so a late arrival still lands under a later
// cursor and is never lost (mirrors getCloudResults cursoring on the cloud's store
// time, not event time).
//
// MINOR-4: a local-only install (cloud never connected) is the DEFAULT, expected
// steady state - the fetch is skipped ENTIRELY in that case (no request, no warn),
// rather than warn-logging 'not_configured' on every 60s poll forever. The warn log is
// reserved for an UNEXPECTED failure (network/http) once the cloud IS configured.
//
// FAILS OPEN: unlike reconcileCloudResults, this NEVER throws - an unconfigured cloud,
// a transport error, or a malformed response all resolve to { ok:true, events } (the
// still-populated store on a hiccup, [] before anything has ever been pulled), so the
// read tool and its GET twin can always answer honestly without a new failure surface
// (mirrors the scheduler's best-effort reconcile pattern, scheduler.mjs:455-456, but
// internalized here since this seam must never propagate a thrown error to its callers).
export async function reconcileInboundEvents({ since = null, type = null, postId = null } = {}) {
  const clientId = boundClientId();
  let cursor = since;
  if (cursor == null) {
    try {
      const s = loadState();
      cursor = (s.inboundEventsCursor && typeof s.inboundEventsCursor === 'string') ? s.inboundEventsCursor : null;
    } catch { cursor = null; }
  }
  const cfg = readCloudConfig();
  if (cfg.workspaceId && cloudApiKey()) {
    try {
      const data = await getInboundEvents({ since: cursor });
      const rows = (data && Array.isArray(data.events)) ? data.events : [];
      const fresh = [];
      for (const r of rows) {
        const ev = normalizeInboundEvent(r);
        if (!ev) continue;
        if (ev.clientId !== clientId) continue; // defense-in-depth, mirrors :860
        fresh.push(ev);
      }
      if (fresh.length) {
        const s = loadState();
        const store = Array.isArray(s.inboundEvents) ? s.inboundEvents : [];
        const byId = new Map(store.map((e) => [e.eventId, e]));
        for (const ev of fresh) byId.set(ev.eventId, ev); // dedupe by eventId, newest pull wins
        s.inboundEvents = [...byId.values()]
          .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)) // newest ts first
          .slice(0, INBOUND_EVENTS_CAP);
        // Relationship-memory accretion (spec 49 R12): stamp the SENDER of each freshly-merged
        // inbound event as a 'they'-direction 'inbound' exchange. De-dupe rides the existing
        // eventId de-dupe: ref=eventId, so a re-merged event is the same exchange (idempotent).
        // Wrapped + non-throwing: this seam FAILS OPEN (below) and must never gain a throw here.
        try {
          for (const ev of fresh) {
            const a = ev.author || {};
            stampEngager(s, {
              lane: ev.platform, handle: a.handle || a.displayName || a.id,
              kind: 'inbound', ts: ev.ts, ref: ev.eventId, permalink: ev.permalink,
              direction: 'they', excerpt: ev.text,
            });
          }
        } catch { /* accretion never breaks the inbound merge */ }
        saveState();
      }
      const nextCursor = (data && typeof data.cursor === 'string' && data.cursor) ? data.cursor : null;
      if (nextCursor && nextCursor !== cursor) {
        try {
          const s2 = loadState();
          s2.inboundEventsCursor = nextCursor;
          saveState();
        } catch { /* cursor bookkeeping is best-effort */ }
      }
    } catch (e) {
      // Reached only for an UNEXPECTED failure (network_error/http_error): the
      // not_configured/no_api_key codes cloudFetch would otherwise throw are already
      // ruled out by the cfg check above, so anything here is worth a warn.
      logLine('warn', `cloud-client: inbound-events pull failed for ${clientId}: ${e.message}`);
    }
  }
  const store = Array.isArray(loadState().inboundEvents) ? loadState().inboundEvents : [];
  // state.json is already per-client (activeRoot()), so only this client's events are
  // ever merged in above - but re-assert the clientId defense filter on read too (belt
  // and suspenders, same discipline as the approval fences), plus the request's
  // optional type/postId narrowing.
  const events = store.filter((e) => e.clientId === clientId && (!type || e.type === type) && (!postId || e.postId === postId));
  return { ok: true, events };
}
