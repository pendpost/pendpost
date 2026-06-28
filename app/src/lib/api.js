import { useQuery, useQueryClient } from '@tanstack/react-query';

async function getJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

export function usePlans() {
  return useQuery({
    queryKey: ['plans'],
    queryFn: () => getJson('/api/plans'),
    refetchInterval: 30_000,
  });
}

export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: () => getJson('/api/accounts'),
    refetchInterval: 60_000,
  });
}

// Dashboard build status (GET /api/health -> buildId, building) for the in-app
// updater. Polled on a short interval so a background rebuild's new bundle is
// noticed promptly; the payload is tiny. refetchIntervalInBackground keeps the
// poll alive when the dashboard is an unfocused tab/window - an updater is most
// useful precisely when you have left it open in the background.
export function useBuildStatus() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => getJson('/api/health'),
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
  });
}

export function useAssets(enabled) {
  return useQuery({
    queryKey: ['assets'],
    queryFn: () => getJson('/api/assets'),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useActivity(enabled) {
  return useQuery({
    queryKey: ['activity'],
    queryFn: () => getJson('/api/activity?limit=500'),
    enabled,
    refetchInterval: 15_000,
  });
}

export function useInsights(enabled) {
  return useQuery({
    queryKey: ['insights'],
    queryFn: () => getJson('/api/insights'),
    enabled,
    refetchInterval: 60_000,
  });
}

export function useDigest(enabled) {
  return useQuery({
    queryKey: ['digest'],
    queryFn: () => getJson('/api/digest'),
    enabled,
    staleTime: 60_000,
  });
}

export function useConfig(enabled) {
  return useQuery({
    queryKey: ['config'],
    queryFn: () => getJson('/api/config'),
    enabled,
    staleTime: 30_000,
  });
}

// One-call readiness (US-ONB-05): { ok, ready, schedulerRunning, blockers[],
// nextDue[] } from GET /api/pendpost-health (lib/writes.mjs pendpostHealth). Read-only
// and client-scoped server-side; the checklist renders blockers as actionable steps.
export function usePendpostHealth(enabled) {
  return useQuery({
    queryKey: ['pendpost-health'],
    queryFn: () => getJson('/api/pendpost-health'),
    enabled,
    refetchInterval: 60_000,
  });
}

// Read-only per-platform publish readiness (B2): { ok, postId, platforms:{<p>:
// {ready, problems[], warnings[]}} } from GET /api/plans/<c>/posts/<id>/platform-validate
// (lib/writes.mjs platformValidate). Surfaced as advisory blocker rows in
// PostDetail/Composer so the owner learns of a bad post before publish, never at
// publish - read-only, never writes, never pokes a lane. enabled-gated and keyed
// per campaign+postId so it refetches per post and a client switch invalidates it.
export function usePlatformValidate(campaign, postId, enabled = true) {
  return useQuery({
    queryKey: ['platform-validate', campaign, postId],
    queryFn: () => getJson(`/api/plans/${campaign}/posts/${postId}/platform-validate`),
    enabled: enabled && Boolean(campaign) && Boolean(postId),
    staleTime: 30_000,
  });
}

// Read-only media spec-check (B2): { ok, media, probe, checks:{resolution,
// codecOk, faststart} } from GET /api/plans/<c>/posts/<id>/validate-media
// (lib/writes.mjs validateMedia). The checks surface as advisory rows (wrong
// resolution / no faststart / codec) - never blocking, never auto-retrying.
export function useValidateMedia(campaign, postId, enabled = true) {
  return useQuery({
    queryKey: ['validate-media', campaign, postId],
    queryFn: () => getJson(`/api/plans/${campaign}/posts/${postId}/validate-media`),
    enabled: enabled && Boolean(campaign) && Boolean(postId),
    staleTime: 30_000,
  });
}

// --- Multi-client (LOCAL, in-core) ---------------------------------------
// The active client scopes every other call server-side; these read the
// registry ({ activeClientId, clients:[{id,displayName,status,timezone?,accent?,logo?}] }).
export function useClients() {
  return useQuery({
    queryKey: ['clients'],
    queryFn: () => getJson('/api/clients'),
    staleTime: 30_000,
  });
}

// C4: read-only cross-client roll-up ({ activeClientId, clients:[{id,displayName,
// status,ready,schedulerRunning,pending,overdue,metaBlocked,nextDue,error}] })
// from GET /api/clients/overview (lib/writes.mjs clientsOverview). The server
// iterates the registry and scopes each row internally, so this is NOT
// client-scoped: it is a registry-wide read that does not refetch on a client
// switch. Booleans + counts only - never a 368's blockedUntil/reason/secret.
export function useClientsOverview() {
  return useQuery({
    queryKey: ['clients-overview'],
    queryFn: () => getJson('/api/clients/overview'),
    staleTime: 30_000,
  });
}

// Convenience selector over useClients(): the resolved active client object
// (or null while loading / if the active id is not in the list).
export function useActiveClient() {
  const q = useClients();
  const data = q.data;
  const active = data?.clients?.find((c) => c.id === data.activeClientId) || null;
  return { ...q, activeClient: active, activeClientId: data?.activeClientId || null };
}

// Switching the active client re-scopes every server read, so the cached data
// of every client-scoped page must be invalidated to refetch under the new
// client. Returns a function the switcher awaits.
export function useSetActiveClient() {
  const queryClient = useQueryClient();
  return async (id) => {
    const data = await setActiveClient(id);
    queryClient.invalidateQueries({ queryKey: ['clients'] });
    for (const key of CLIENT_SCOPED_KEYS) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
    return data;
  };
}

// Every query key whose data is scoped to the active client on the server.
// Switching client or a client write (create/update/archive that flips the
// active one) invalidates all of these so no stale client's data lingers.
const CLIENT_SCOPED_KEYS = ['plans', 'accounts', 'activity', 'insights', 'assets', 'config', 'digest', 'pendpost-health', 'platform-validate', 'validate-media'];

async function sendJson(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `${path}: HTTP ${res.status}`);
    err.code = data.code;
    throw err;
  }
  return data;
}

const postJson = (path, body) => sendJson('POST', path, body);

// The pendpost UI always acts as the owner - they are its only user. Agents use
// the MCP face with their own actor strings.
const ACTOR = 'owner';

// The human "Check now" click (App.jsx) is the confirmation, so post
// confirm:true to satisfy the server's fail-closed needs_confirm gate. An
// optional scope { campaign, postId } narrows the run to a single post (the
// planner run-now review dialog loops it over the selected posts); omitting it
// publishes every due post, the original Activity-sweep behavior.
export const runPublishDue = (scope = {}) => postJson('/api/run/publish-due', { actor: 'ui', confirm: true, ...scope });
export const setSchedulerRunning = (running) => postJson('/api/scheduler', { running });

// --- Client admin (operator-only; mirrors the other write helpers) ---------
export const getClients = () => getJson('/api/clients');
export const setActiveClient = (id) => postJson('/api/clients/active', { id, actor: ACTOR });
export const createClient = (body) => postJson('/api/clients', { ...body, actor: ACTOR });
export const updateClient = (id, body) => sendJson('PATCH', `/api/clients/${id}`, { ...body, actor: ACTOR });
export const archiveClient = (id) => postJson(`/api/clients/${id}/archive`, { actor: ACTOR });

// --- Phase D write matrix ---
// Create a campaign (US-ONB-04): the first-run empty-state's primary action.
// body = { id, note?, timezone? }; maps to campaign_create / POST /api/campaigns.
export const createCampaign = (body) => postJson('/api/campaigns', { ...body, actor: ACTOR });
export const createPost = (campaign, post) => postJson(`/api/plans/${campaign}/posts`, { post, actor: ACTOR });
export const updatePost = (campaign, postId, ifRev, fields) => sendJson('PATCH', `/api/plans/${campaign}/posts/${postId}`, { ifRev, fields, actor: ACTOR });
export const deletePost = (campaign, postId, force = false) => sendJson('DELETE', `/api/plans/${campaign}/posts/${postId}`, { force, actor: ACTOR });
export const approvePost = (campaign, postId, note) => postJson(`/api/plans/${campaign}/posts/${postId}/approve`, { actor: ACTOR, note });
export const rejectPost = (campaign, postId, note) => postJson(`/api/plans/${campaign}/posts/${postId}/reject`, { actor: ACTOR, note });
export const unschedulePost = (campaign, postId, confirm = false) => postJson(`/api/plans/${campaign}/posts/${postId}/unschedule`, { confirm, actor: ACTOR });
export const reschedulePost = (campaign, postId, scheduledAt, confirm = false) => postJson(`/api/plans/${campaign}/posts/${postId}/reschedule`, { scheduledAt, confirm, actor: ACTOR });
// Mark a post the owner published natively outside pendpost as posted, so it
// leaves the publish-due queue. Never publishes; externalUrl is optional.
export const markPosted = (campaign, postId, externalUrl) => postJson(`/api/plans/${campaign}/posts/${postId}/mark-posted`, { externalUrl, actor: ACTOR });
// Read a handed-off post back from its platforms to confirm it is live (writes a
// non-destructive verify block; never publishes). The caller invalidates ['plans'].
export const verifyPost = (campaign, postId) => postJson(`/api/plans/${campaign}/posts/${postId}/verify`, { actor: ACTOR });
// Live brand-lint. An optional platform tunes the server's caption/hashtag caps
// (A4); omitting it preserves the conservative default-cap behaviour for callers
// that have no platform context.
export const lintText = (text, platform) => postJson('/api/lint', platform ? { text, platform } : { text });
export const refreshLinkedinToken = () => postJson('/api/accounts/linkedin/refresh', {});
export const refreshXToken = () => postJson('/api/accounts/x/refresh', {});
// Run a live liveness probe (proves the token actually authenticates); result
// lands in account_status.<platform>.live. An optional platform scopes the probe
// to a single lane (C4); omitting it probes all lanes - existing no-arg callers
// (App.jsx, Sidebar.jsx) keep their whole-instance recheck unchanged.
export const recheckHealth = (platform) => postJson('/api/health/recheck', platform ? { platform } : {});
// A Meta-368 block has no machine-readable clear time, so it never auto-expires;
// the owner confirms out of band (Meta Business Suite) that it lifted, then
// clears it here. blockedUntil:null records "cleared".
export const clearMetaBlock = () => postJson('/api/state/meta-block', { blockedUntil: null, source: ACTOR, actor: ACTOR, reason: 'owner confirmed Meta lifted the block' });
export const fetchInsights = (campaign) => postJson('/api/insights/fetch', campaign ? { campaign } : {});
// C1: set the Meta publishing lane's cadence cap and/or pause/resume it. body =
// { cadence?, paused?, reason? }; maps to meta_lane_set / POST /api/state/meta-lane.
// The caller invalidates ['accounts'] (account_status.meta carries the lane state).
export const setMetaLane = (body) => postJson('/api/state/meta-lane', { ...body, actor: ACTOR });
// Edit non-secret config (identifiers -> .env, posting vars -> config.json).
// Secrets are display-only and never sent. set = { identifiers?, posting? }.
export const saveConfig = (ifRev, set) => postJson('/api/config', { ifRev, set, actor: ACTOR });

// Operator-only connect ceremony (POST /api/connect). Kicks off the engine's connect
// command for one platform against the active client; the ENGINE writes the .env (the
// server never persists the secret). creds carry the public Client ID + the secret/token
// the operator entered (youtube/linkedin/x: clientId+clientSecret; meta: systemUserToken).
// Resolves { started, interactive } - the caller then polls recheckHealth until the lane
// flips. The secret stays on this machine (a 127.0.0.1 POST into the local .env).
export const connectPlatform = (platform, creds = {}) => postJson('/api/connect', { platform, ...creds });

// Imperative read of the engine connect ceremony's live state for one platform
// (GET /api/connect/status?platform=<p>). Resolves { ok, state:'idle'|'running'|
// 'failed'|'connected', detail, authUrl, at }. The ConnectPanel polls this while
// 'waiting' so it can surface the consent link and a hard failure instead of a
// dead-end spinner. Mirrors the file's other GETs (getJson throws on a non-2xx).
export const connectStatus = (platform) => getJson('/api/connect/status?platform=' + encodeURIComponent(platform));

// --- Covers (Phase C surface, UI face lands with the composer) ---
export const setCoverFrame = (campaign, postId, frameSec) => postJson(`/api/plans/${campaign}/posts/${postId}/cover`, { frameSec });
export const clearCover = (campaign, postId) => sendJson('DELETE', `/api/plans/${campaign}/posts/${postId}/cover`, undefined);
export async function uploadCover(campaign, postId, file) {
  const res = await fetch(`/api/plans/${campaign}/posts/${postId}/cover`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'image/jpeg' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `cover upload: HTTP ${res.status}`);
    err.code = data.code;
    throw err;
  }
  return data;
}

// --- Assets mutation (C2): delete / rename a library file. Both are confirm-
// gated + in-use-protected server-side (needs_confirm/428 names the using
// post(s)); pendpost always acts as the owner. The caller invalidates
// ['assets']. delete_asset takes confirm in the JSON body (DELETE with a body);
// rename_asset POSTs the new name + confirm to /api/assets/<name>/rename.
export const deleteAsset = (file, confirm = false) => sendJson('DELETE', `/api/assets/${encodeURIComponent(file)}`, { confirm, actor: ACTOR });
export const renameAsset = (file, toName, confirm = false) => postJson(`/api/assets/${encodeURIComponent(file)}/rename`, { toName, confirm, actor: ACTOR });

// --- Assets ingestion (WP6): stream a new media file into data/media. The
// filename + actor ride the query string (the CORS header allowlist is fixed).
export async function uploadAssetFile(file) {
  const res = await fetch(`/api/assets/upload?filename=${encodeURIComponent(file.name)}&actor=${ACTOR}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `asset upload: HTTP ${res.status}`);
    err.code = data.code;
    throw err;
  }
  return data;
}
