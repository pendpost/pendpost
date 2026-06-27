// clients.mjs - operator/dashboard client lifecycle + active-context switching.
//
// These are OPERATOR-ONLY REST actions (no MCP tool, parity-exempted): client
// creation, switching the active client, editing a client's display metadata,
// and archiving/unarchiving. They manage the registry (data/clients.json) and
// must never be agent-accessible - an agent must not be able to manage clients
// or credentials, which protects the "posted to the wrong client" anti-goal.
//
// Registry shape (data/clients.json):
//   { activeClientId, clients: [{ id, displayName, status, timezone?, accent?,
//     logo?, createdAt, createdBy, ... }] }
// Reuses readRegistry()/writeRegistry() (atomic + cache-invalidating) and the
// same actor + atomic-write discipline as the write matrix. Each action logs one
// entry to the relevant client's activity feed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { errorBody, atomicWriteJson, DATA_ROOT } from './util.mjs';
import { withClient } from './context.mjs';
import { clientRoot, readRegistry, readRegistryOrError, writeRegistry } from './multi-client.mjs';
import { appendActivity, isRunning } from './scheduler.mjs';
import { loadState, isMetaBlocked } from './state.mjs';
import { getPosting } from './config.mjs';
import { loadManifest } from './plans.mjs';

// Same slug rule as multi-client.clientRoot (the id becomes a directory name and
// an activeRoot() path segment): lowercase alnum, hyphens allowed but not leading.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function requireActor(actor) {
  if (typeof actor !== 'string' || !actor.trim() || actor.trim().toLowerCase() === 'unknown') {
    return errorBody('invalid_input', 'actor is required (who is doing this - e.g. "owner")');
  }
  return null;
}

// A registry must always exist by the time these run (server boot calls
// initMultiClient). A missing/corrupt registry is an incident, not "no clients".
function loadRegistryOrError() {
  const registry = readRegistry();
  if (!registry || !Array.isArray(registry.clients)) {
    return { error: errorBody('manifest_error', 'client registry (data/clients.json) is missing or unreadable') };
  }
  return { registry };
}

// Optimistic-concurrency token for updateClient (ifRev/409), mirroring postRev /
// configRev: a content hash of the registry ENTRY. The entry is canonicalized
// (keys sorted, recursively) before hashing so a field-order or whitespace
// difference in clients.json never spuriously invalidates an in-flight edit -
// only a real value change rotates the rev. 12 hex chars, same idiom as postRev.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, k) => { acc[k] = canonicalize(value[k]); return acc; }, {});
  }
  return value;
}
function clientRev(entry) {
  return crypto.createHash('sha1').update(JSON.stringify(canonicalize(entry))).digest('hex').slice(0, 12);
}

function publicClient(c) {
  return {
    id: c.id,
    displayName: c.displayName || c.id,
    status: c.status || 'active',
    ...(c.timezone ? { timezone: c.timezone } : {}),
    ...(c.accent ? { accent: c.accent } : {}),
    ...(c.logo ? { logo: c.logo } : {}),
    rev: clientRev(c),
  };
}

// B5: attach a booleans-ONLY health roll-up to each public client entry, shared
// verbatim by client_list (MCP) and GET /api/clients (REST) so the two faces
// return identical fields. schedulerRunning is the PROCESS-GLOBAL scheduler timer
// (lib/scheduler.mjs - one timer for the whole server, NOT per-client), so read
// it ONCE outside the loop; every entry carries the same value. actionBlocked is
// the per-client Meta-368 breaker, read INSIDE that client's own
// withClient(clientRoot(id), ...) scope so no read crosses into another client's
// subtree. A corrupt/unreadable per-client state.json degrades to
// actionBlocked:false without aborting the rest of the list. NEVER leak
// blockedUntil/reason/fbTraceId or any secret - booleans only.
function withHealthRollup(clients) {
  const schedulerRunning = isRunning();
  // Mandate H: a fresh "default" workspace should step aside once a REAL project
  // exists. Count active, non-default clients ONCE: a default is "dormant"
  // (cosmetically auto-hideable by the UI) only when at least one real project is
  // active AND the default itself holds zero campaigns - so a MIGRATED default
  // carrying legacy data (campaigns) is never hidden, and its 368 breaker / state
  // stay swept (we never mutate the registry or change status). Booleans-only,
  // shared by both faces.
  const realActiveCount = clients.filter((c) => c.id !== 'default' && (c.status || 'active') === 'active').length;
  return clients.map((c) => {
    let actionBlocked = false;
    // locale is per-client config (config.json), not a registry field; read it in
    // the client's OWN scope so the SPA can switch UI language on active-client
    // change. Not health/secret - safe metadata; degrades to 'en' on any read error.
    let locale = 'en';
    let isDormantDefault = false;
    try {
      const isDefaultCandidate = c.id === 'default' && (c.status || 'active') === 'active' && realActiveCount >= 1;
      const summary = withClient(clientRoot(c.id), () => ({
        actionBlocked: isMetaBlocked(loadState()),
        locale: getPosting().locale || 'en',
        // Only pay for the (cheap, one-file) manifest read for the default candidate.
        empty: isDefaultCandidate ? loadManifest().plans.length === 0 : false,
      }));
      actionBlocked = summary.actionBlocked;
      locale = summary.locale;
      isDormantDefault = isDefaultCandidate && summary.empty;
    } catch {
      actionBlocked = false; // corrupt/quarantined state.json: degrade, don't abort the list
    }
    return { ...publicClient(c), schedulerRunning, actionBlocked, locale, isDormantDefault };
  });
}

// Log one client-admin action to the given client's OWN activity feed (scoped
// via withClient so it lands in that client's state.json, not whichever client
// happens to be active).
function logClientAction(id, action, actor) {
  try {
    withClient(clientRoot(id), () => {
      appendActivity({ campaign: null, postId: null, platform: null, action, ok: true, errorCode: null, errorMessage: null, lateMin: null, actor });
    });
  } catch { /* activity feed is best-effort; the registry write is the source of truth */ }
}

// The same shape as client_list (mcp.clientList), for the GET /api/clients twin.
// Carries the B5 booleans-only health roll-up { schedulerRunning, actionBlocked }
// and the C9 registryError incident envelope (null when healthy), so the twin
// surfaces a missing/corrupt registry identically to the MCP face.
export function listClients() {
  const { registry, error: registryError } = readRegistryOrError();
  const clients = withHealthRollup(registry && Array.isArray(registry.clients) ? registry.clients : [{ id: 'default', displayName: 'Default', status: 'active' }]);
  const activeClientId = registry && typeof registry.activeClientId === 'string' && registry.activeClientId ? registry.activeClientId : 'default';
  return { activeClientId, clients, registryError };
}

export { withHealthRollup };

// Switch the active client (operator action). The target must exist and be
// active - you cannot make an archived client active without unarchiving first.
export function setActiveClient({ id, actor } = {}) {
  const actErr = requireActor(actor);
  if (actErr) return actErr;
  if (typeof id !== 'string' || !SLUG_RE.test(id)) {
    return errorBody('invalid_input', 'id must match /^[a-z0-9][a-z0-9-]*$/');
  }
  const { registry, error } = loadRegistryOrError();
  if (error) return error;
  const entry = registry.clients.find((c) => c.id === id);
  if (!entry) return errorBody('unknown_campaign', `unknown client: ${id}`);
  if ((entry.status || 'active') !== 'active') {
    return errorBody('invalid_input', `client ${id} is archived - unarchive it before making it active`);
  }
  registry.activeClientId = id;
  writeRegistry(registry);
  logClientAction(id, 'client-activate', actor.trim());
  return { ok: true, activeClientId: id, clients: registry.clients.map(publicClient) };
}

// Mandate H promotion test: true when the active client is the lone, EMPTY default
// (no other active client yet) - the precondition for auto-promoting the very first
// real client to active. Reads the default's manifest in its own scope; if that read
// cannot prove emptiness, returns false (never promote on uncertainty, and never over
// a default that holds migrated legacy data).
function isFirstRealClient(registry) {
  if (registry.activeClientId !== 'default') return false;
  const realActive = registry.clients.filter((c) => c.id !== 'default' && (c.status || 'active') === 'active').length;
  if (realActive !== 0) return false;
  const def = registry.clients.find((c) => c.id === 'default');
  if (!def || (def.status || 'active') !== 'active') return false;
  try {
    return withClient(clientRoot('default'), () => loadManifest().plans.length === 0);
  } catch {
    return false;
  }
}

// Create a new client: validate the slug, register it, and scaffold its subtree
// (data/clients/<id>/data/plans/active-plans.json with an empty plans array) so
// the very first plan_list/loadManifest under it reads a healthy empty manifest.
export function createClient({ id, displayName, logo = null, accent = null, timezone = null, actor } = {}) {
  const actErr = requireActor(actor);
  if (actErr) return actErr;
  if (typeof id !== 'string' || !SLUG_RE.test(id)) {
    return errorBody('invalid_input', 'id must be a slug matching /^[a-z0-9][a-z0-9-]*$/');
  }
  if (typeof displayName !== 'string' || !displayName.trim()) {
    return errorBody('invalid_input', 'displayName is required');
  }
  for (const [k, v] of Object.entries({ logo, accent, timezone })) {
    if (v != null && typeof v !== 'string') return errorBody('invalid_input', `${k} must be a string`);
  }
  const { registry, error } = loadRegistryOrError();
  if (error) return error;
  if (registry.clients.some((c) => c.id === id)) {
    return errorBody('invalid_input', `client ${id} already exists`);
  }
  const root = path.join(DATA_ROOT, 'clients', id);
  if (fs.existsSync(root)) {
    return errorBody('invalid_input', `data/clients/${id} already exists on disk`);
  }
  try {
    const plansDir = path.join(root, 'data', 'plans');
    fs.mkdirSync(plansDir, { recursive: true });
    atomicWriteJson(path.join(plansDir, 'active-plans.json'), { plans: [] });
  } catch (err) {
    return errorBody('engine_failure', `could not scaffold client subtree: ${err.message}`);
  }
  const entry = {
    id,
    displayName: displayName.trim(),
    status: 'active',
    ...(timezone ? { timezone } : {}),
    ...(accent ? { accent } : {}),
    ...(logo ? { logo } : {}),
    createdAt: new Date().toISOString(),
    createdBy: actor.trim(),
  };
  // Mandate H: the FIRST real client created while the active client is still the
  // EMPTY default is promoted to active in the SAME registry write, so the operator
  // lands on their real project (the dormant default then auto-hides via
  // isDormantDefault). Decided BEFORE the push so the "no real client yet" check sees
  // a clean slate; it never fires once a real client exists, and never over a default
  // holding migrated data.
  const promote = isFirstRealClient(registry);
  registry.clients.push(entry);
  if (promote) registry.activeClientId = id;
  writeRegistry(registry);
  logClientAction(id, 'client-create', actor.trim());
  if (promote) logClientAction(id, 'client-activate', actor.trim());
  return { ok: true, client: publicClient(entry) };
}

// A logo is display metadata: either null (clear it) or the {path,url} object the
// dashboard's hardened upload produces and ClientAvatar renders (logo.url, else
// /media/<logo.path>). path must be a non-empty relative string (never absolute
// or a traversal) so a logo can only ever reference this client's own data/media.
function validateLogo(v) {
  if (v === null) return null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'logo must be an object { path, url } or null';
  const p = v.path;
  if (typeof p !== 'string' || !p.trim()) return 'logo.path is required';
  if (p.includes('..') || path.isAbsolute(p)) return 'logo.path must be a relative path under data/media';
  if (v.url != null && typeof v.url !== 'string') return 'logo.url must be a string';
  return null;
}

// Update a client's display metadata. The id is IMMUTABLE (it is the directory
// name and an activeRoot() segment); only displayName/logo/accent/timezone move.
// ifRev/409 (C5): the caller MUST echo the rev it read via GET /api/clients so a
// concurrent edit can never silently last-writer-wins. The 409 check, the rev
// recompute, and writeRegistry form a SINGLE re-read-compare-write sequence (no
// registry-level lock exists, unlike mutatePlan), so the TOCTOU window is closed.
export function updateClient({ id, ifRev, displayName, logo, accent, timezone, actor } = {}) {
  const actErr = requireActor(actor);
  if (actErr) return actErr;
  if (typeof id !== 'string' || !SLUG_RE.test(id)) {
    return errorBody('invalid_input', 'id must match /^[a-z0-9][a-z0-9-]*$/');
  }
  // Fail-closed: a missing/non-string ifRev is rejected BEFORE any write attempt.
  if (typeof ifRev !== 'string' || !ifRev) {
    return errorBody('invalid_input', 'ifRev is required - read GET /api/clients and echo its rev');
  }
  const updates = { displayName, logo, accent, timezone };
  const offered = Object.entries(updates).filter(([, v]) => v !== undefined);
  if (!offered.length) return errorBody('invalid_input', 'nothing to update (displayName/logo/accent/timezone)');
  for (const [k, v] of offered) {
    if (k === 'logo') { const e = validateLogo(v); if (e) return errorBody('invalid_input', e); continue; }
    if (v !== null && typeof v !== 'string') return errorBody('invalid_input', `${k} must be a string or null`);
    if (k === 'displayName' && (v === null || !String(v).trim())) return errorBody('invalid_input', 'displayName cannot be empty');
  }
  // SINGLE re-read-compare-write sequence: read the registry NOW, compare the
  // target entry's CURRENT rev against ifRev, and only then mutate + write. No
  // await/yield separates the compare from the write, so two concurrent updates
  // cannot both pass the 409 check against the same stale rev.
  const { registry, error } = loadRegistryOrError();
  if (error) return error;
  const entry = registry.clients.find((c) => c.id === id);
  if (!entry) return errorBody('unknown_campaign', `unknown client: ${id}`);
  if (ifRev !== clientRev(entry)) {
    return errorBody('stale_write', 'this client changed since you read it - re-read GET /api/clients and retry');
  }
  for (const [k, v] of offered) {
    if (v === null) delete entry[k];
    else entry[k] = k === 'displayName' ? String(v).trim() : v;
  }
  writeRegistry(registry);
  logClientAction(id, 'client-update', actor.trim());
  return { ok: true, client: publicClient(entry), rev: clientRev(entry) };
}

// Toggle a client's status between active and archived. Archiving the currently
// active client is refused (the scheduler would have no active client to sweep);
// switch to another client first.
export function archiveClient({ id, actor } = {}) {
  const actErr = requireActor(actor);
  if (actErr) return actErr;
  if (typeof id !== 'string' || !SLUG_RE.test(id)) {
    return errorBody('invalid_input', 'id must match /^[a-z0-9][a-z0-9-]*$/');
  }
  const { registry, error } = loadRegistryOrError();
  if (error) return error;
  const entry = registry.clients.find((c) => c.id === id);
  if (!entry) return errorBody('unknown_campaign', `unknown client: ${id}`);
  const nextStatus = (entry.status || 'active') === 'active' ? 'archived' : 'active';
  if (nextStatus === 'archived' && registry.activeClientId === id) {
    return errorBody('invalid_input', `client ${id} is the active client - switch to another client before archiving it`);
  }
  entry.status = nextStatus;
  writeRegistry(registry);
  logClientAction(id, nextStatus === 'archived' ? 'client-archive' : 'client-unarchive', actor.trim());
  return { ok: true, client: publicClient(entry) };
}
