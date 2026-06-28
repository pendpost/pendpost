// cloud-config.mjs - the OPTIONAL managed-cloud configuration + the secret-tier
// api-key accessor.
//
// The CONNECTION is install-GLOBAL: ONE cloud workspace for the whole install, in
// data/cloud.json (DATA_ROOT, alongside data/clients.json). Each local client is a
// BRAND inside it with its own always-on flag - so an operator running many client
// brands pays once for one workspace, not N. (This replaces the old per-client
// cloud.json under activeRoot(); any legacy per-client file is promoted on first read.)
//
// Kept SEPARATE from lib/cloud-client.mjs so the scheduler can read the per-client
// always-on flag (the local-firing safeguard) WITHOUT importing the transport
// (cloud-client imports the scheduler; the scheduler importing cloud-client would
// cycle). This module imports neither.
//
// The api key is a SECRET: .env only (PENDPOST_CLOUD_API_KEY), presence + 4-char
// tail display only, never written or logged - matching the SECRETS trust tier.
// It is also INSTALL-GLOBAL: it authenticates the ONE workspace above (the brand is
// named in the request url path; the key only scopes to the workspace), so it lives in
// the install-global .env (WORKSPACE_ROOT/.env via globalEnvPath()) and resolves the
// SAME for every brand - NOT in the per-client subtree. cloudApiKey() reads it global-
// first, falling back to the active client's .env for installs connected before this.
import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACE_ROOT, DATA_ROOT, atomicWriteJson, readEnv, tokenTail, globalEnvPath } from './util.mjs';
import { boundRoot } from './context.mjs';
import { activeClientId } from './multi-client.mjs';

export const API_KEY_ENV = 'PENDPOST_CLOUD_API_KEY';

// The Clerk Account Portal (manage account: email, security, sign-in methods). It is a
// hosted page on the cloud's Clerk instance, NOT a pendpost route - so the local app
// links out to it. The URL is a Clerk-instance property (its slug differs per
// environment), so it is env-overridable; the default is the live pendpost-cloud
// instance's account-portal user page. Surfaced read-only in getCloudStatus so the
// account menu can offer "Manage account" without a round-trip. Not a secret.
export const ACCOUNT_PORTAL_URL = process.env.PENDPOST_CLOUD_ACCOUNT_PORTAL
  || 'https://balanced-giraffe-97.accounts.dev/user';

const GLOBAL_DEFAULTS = Object.freeze({ baseUrl: '', workspaceId: '' });

// The install-global connection file: data/cloud.json (NOT per-client; NOT config.json).
function globalCloudPath() {
  return path.join(DATA_ROOT, 'cloud.json');
}

// The current client id, bound-aware (mirrors scheduler.publishClientId): the
// withClient() binding when one is active, else the registry's active client.
function currentClientId() {
  const bound = boundRoot();
  return bound ? path.basename(bound) : activeClientId();
}

function normalizeBrands(raw) {
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [id, v] of Object.entries(raw)) {
      out[id] = { alwaysOn: Boolean(v && typeof v === 'object' ? v.alwaysOn : v) };
    }
  }
  return out;
}

// Read a legacy per-client cloud.json ({enabled, baseUrl, workspaceId}); null if absent/bad.
function tryReadLegacy(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data) && !data.brands) return data;
  } catch {
    /* absent or corrupt */
  }
  return null;
}

// One-time promotion of the OLD per-client cloud.json files into the install-global
// file. Runs only when the global file does not yet exist. The first connected legacy
// config provides the (single) global workspace; each legacy client's `enabled`
// becomes its brand's always-on. Idempotent: the written global file makes future
// reads skip this. (Realistically there is at most one connected client.)
function promoteLegacyIfNeeded() {
  if (fs.existsSync(globalCloudPath())) return;
  const sources = [];
  const single = tryReadLegacy(path.join(WORKSPACE_ROOT, 'cloud.json'));
  if (single) sources.push({ clientId: activeClientId(), cfg: single });
  try {
    const clientsDir = path.join(DATA_ROOT, 'clients');
    for (const id of fs.readdirSync(clientsDir)) {
      const cfg = tryReadLegacy(path.join(clientsDir, id, 'cloud.json'));
      if (cfg) sources.push({ clientId: id, cfg });
    }
  } catch {
    /* no clients dir yet */
  }
  if (sources.length === 0) return;
  const connected = sources.find((s) => s.cfg.workspaceId);
  const next = { baseUrl: (connected && connected.cfg.baseUrl) || '', workspaceId: (connected && connected.cfg.workspaceId) || '', brands: {} };
  for (const s of sources) next.brands[s.clientId] = { alwaysOn: Boolean(s.cfg.enabled) };
  writeGlobalConfig(next);
}

function readGlobalConfig() {
  promoteLegacyIfNeeded();
  try {
    const data = JSON.parse(fs.readFileSync(globalCloudPath(), 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return {
        baseUrl: typeof data.baseUrl === 'string' ? data.baseUrl : '',
        workspaceId: typeof data.workspaceId === 'string' ? data.workspaceId : '',
        brands: normalizeBrands(data.brands),
      };
    }
  } catch {
    /* missing or corrupt => safe default (disconnected). It carries no secret. */
  }
  return { ...GLOBAL_DEFAULTS, brands: {} };
}

function writeGlobalConfig(next) {
  const gp = globalCloudPath();
  fs.mkdirSync(path.dirname(gp), { recursive: true });
  atomicWriteJson(gp, {
    baseUrl: next.baseUrl || '',
    workspaceId: next.workspaceId || '',
    brands: normalizeBrands(next.brands),
  });
}

// ---- the install-global connection ----------------------------------------

export function getConnection() {
  const g = readGlobalConfig();
  return { baseUrl: g.baseUrl, workspaceId: g.workspaceId, connected: Boolean(g.workspaceId) };
}

export function setConnection({ baseUrl, workspaceId }) {
  const g = readGlobalConfig();
  writeGlobalConfig({ ...g, baseUrl: baseUrl || '', workspaceId: (workspaceId || '').trim() });
  return getConnection();
}

// Disconnect the install from its cloud workspace: blank the connection AND clear every
// brand's always-on. A stale always-on flag must not survive a disconnect - it would keep
// the local scheduler skipping a lane (cloudEnabledForActive) even though the workspace is
// gone, so the lane would never fire. The api key is a SECRET in .env, removed by the caller
// (cloud-client.disconnectWorkspace); this module never touches secrets.
export function clearConnection() {
  writeGlobalConfig({ baseUrl: '', workspaceId: '', brands: {} });
  return getConnection();
}

// ---- per-client always-on brands ------------------------------------------

export function brandAlwaysOn(clientId) {
  const b = readGlobalConfig().brands[clientId];
  return Boolean(b && b.alwaysOn);
}

export function setBrandAlwaysOn(clientId, on) {
  const g = readGlobalConfig();
  g.brands[clientId] = { alwaysOn: Boolean(on) };
  writeGlobalConfig(g);
  return Boolean(on);
}

// The stored brands map as a list (clients that have been toggled or pushed). The UI
// merges this with the local client registry to show every client with a toggle.
export function listBrands() {
  const g = readGlobalConfig();
  return Object.entries(g.brands).map(([clientId, b]) => ({ clientId, alwaysOn: Boolean(b.alwaysOn) }));
}

// ---- back-compat config shape (used by cloud-client + the scheduler) -------
// readCloudConfig/writeCloudConfig keep the legacy {enabled, baseUrl, workspaceId}
// shape, now backed by the global connection + the ACTIVE client's brand: `enabled`
// (read) is the active client's always-on. So the existing connect transport keeps
// working while the new multi-client view uses the brand functions above.

export function readCloudConfig() {
  const g = readGlobalConfig();
  const b = g.brands[currentClientId()];
  return { enabled: Boolean(b && b.alwaysOn), baseUrl: g.baseUrl, workspaceId: g.workspaceId };
}

// CONNECT LINKS ONLY: writing the connection NEVER auto-enables a brand's always-on
// (that is an explicit, billable toggle via setCloudEnabled / setBrandAlwaysOn). So
// `next.enabled` is intentionally ignored here - a fresh connect leaves every brand OFF.
export function writeCloudConfig(next) {
  setConnection({ baseUrl: next.baseUrl, workspaceId: next.workspaceId });
}

// The api key, read fresh per call so a rotation takes effect without a restart.
// INSTALL-GLOBAL: read from the install-global .env first so every brand resolves the
// SAME key regardless of the active client (matching the install-global connection),
// then fall back to the active client's .env for back-compat with installs connected
// before the key was centralized. A stale per-client copy can never shadow the global
// one (global is tried first), so a rotation that rewrites the global .env wins.
export function cloudApiKey() {
  return readEnv(API_KEY_ENV, globalEnvPath()) || readEnv(API_KEY_ENV) || '';
}

// Presence + 4-char tail only, NEVER the value.
export function cloudApiKeyStatus() {
  const v = cloudApiKey();
  return { present: Boolean(v), tail: tokenTail(v) };
}

// The read surface the local API/app render: the global connection, the ACTIVE
// client's always-on (as `enabled`, for back-compat), plus api-key PRESENCE.
export function getCloudStatus() {
  const g = readGlobalConfig();
  const b = g.brands[currentClientId()];
  return {
    enabled: Boolean(b && b.alwaysOn),
    baseUrl: g.baseUrl || '',
    workspaceId: g.workspaceId || '',
    apiKey: cloudApiKeyStatus(),
    // The Clerk account-portal link the app's "Manage account" opens (env-overridable).
    accountPortalUrl: ACCOUNT_PORTAL_URL,
  };
}

// Toggle the ACTIVE client's always-on without re-connecting. Returns the new status.
export function setCloudEnabled(enabled) {
  setBrandAlwaysOn(currentClientId(), Boolean(enabled));
  return getCloudStatus();
}

// The local-firing SAFEGUARD the scheduler reads, now PER-CLIENT: the install is
// connected to a workspace, this client's brand is always-on, AND the cloud api key is
// present, so the always-on cloud worker is the sole firer for THIS client and the LOCAL
// scheduler must skip it (otherwise the local and cloud copies, which cannot see each
// other's minted ids, would BOTH fire the same due post). A client that is NOT always-on
// keeps firing locally. The operator pauses a client by toggling it off or ejecting.
//
// The api-key check is load-bearing: a configured-but-keyless connection (workspaceId set,
// PENDPOST_CLOUD_API_KEY missing from .env) is NOT operational - no keyed cloud call can
// succeed and nothing was ever pushed, so the cloud cannot fire the lane. Without this
// check the local scheduler would skip the lane too and it would fire NOWHERE (a silent
// non-publish). So when the key is missing we fail SAFE to local firing. This mirrors the
// keyless connect-view routing in app/src/components/Cloud.jsx.
export function cloudEnabledForActive() {
  const g = readGlobalConfig();
  const b = g.brands[currentClientId()];
  return Boolean(g.workspaceId) && Boolean(b && b.alwaysOn) && Boolean(cloudApiKey());
}
