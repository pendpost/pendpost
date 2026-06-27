// multi-client.mjs - the per-client registry + the idempotent, zero-loss boot
// migration (Phase 1a multi-client foundation).
//
// Each client owns a self-contained subtree under data/clients/<id>/ that mirrors
// the legacy single-workspace layout (.env, config.json, state.json, rules.json,
// data/plans, data/media). data/clients.json is the registry: which clients exist
// and which one is active. activeRoot() (lib/context.mjs) resolves path helpers
// into the active client's subtree; this module owns the slug rules, the registry
// read/write, and the one-time migration that lifts a pre-existing single
// workspace into clients/default/ without losing a byte.
import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACE_ROOT, DATA_ROOT, atomicWriteJson, logLine } from './util.mjs';
import { invalidateRegistryCache } from './context.mjs';

// A client id is a filesystem-safe slug (it becomes a directory name and an
// activeRoot() path segment): lowercase alnum, hyphens allowed but not leading.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

const REGISTRY_PATH = path.join(DATA_ROOT, 'clients.json');
const CLIENTS_DIR = path.join(DATA_ROOT, 'clients');
// Belt-and-suspenders idempotency marker: even if clients.json were removed, a
// migration that already happened must never run twice and re-move nothing.
const MIGRATED_MARKER = path.join(DATA_ROOT, '.migrated-to-clients');

// The legacy single-workspace items, each mapped to its destination INSIDE the
// default client subtree. Top-level config files keep their name; the data/
// subdirs nest under clients/default/data/ so the per-client layout mirrors the
// legacy one exactly (engines self-root on PENDPOST_ROOT and find data/ there).
function legacyItems() {
  return [
    { src: path.join(WORKSPACE_ROOT, '.env'), relDest: '.env' },
    { src: path.join(WORKSPACE_ROOT, 'config.json'), relDest: 'config.json' },
    { src: path.join(WORKSPACE_ROOT, 'state.json'), relDest: 'state.json' },
    { src: path.join(WORKSPACE_ROOT, 'rules.json'), relDest: 'rules.json' },
    { src: path.join(DATA_ROOT, 'plans'), relDest: path.join('data', 'plans') },
    { src: path.join(DATA_ROOT, 'media'), relDest: path.join('data', 'media') },
  ];
}

// Resolve a client id to its absolute root. Validates the slug so a hostile or
// malformed id can never escape data/clients/ via traversal or odd characters.
export function clientRoot(id) {
  if (typeof id !== 'string' || !SLUG_RE.test(id)) {
    // Throwable form of errorBody('invalid_input', ...): same { code } contract
    // the write matrix catches and turns into a JSON error reply.
    throw Object.assign(new Error('client id must match /^[a-z0-9][a-z0-9-]*$/'), { code: 'invalid_input' });
  }
  return path.join(CLIENTS_DIR, id);
}

// Read the registry, or null when it does not exist / is unreadable. A corrupt
// registry is reported (never silently treated as "no clients", which could
// disarm per-client state); the caller decides how to surface it.
export function readRegistry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// The same read, but surfacing WHY it is null - mirrors plans.loadManifest's
// { plans, error } contract. A missing OR corrupt data/clients.json (including a
// well-formed object that lacks the clients[] array) yields a populated
// manifest_error envelope so the read-list faces (clientList / listClients /
// GET /api/clients) can report the incident instead of silently degrading a
// tampered registry to a healthy-looking lone "default" client. registry is null
// whenever error is set; the caller still falls back to the implicit default so
// the contract shape is unchanged.
export function readRegistryOrError() {
  let raw;
  try {
    raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
  } catch {
    return { registry: null, error: { code: 'manifest_error', message: `client registry ${REGISTRY_PATH} is missing or unreadable` } };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.clients)) {
      return { registry: null, error: { code: 'manifest_error', message: `client registry ${REGISTRY_PATH} has no "clients" array` } };
    }
    return { registry: parsed, error: null };
  } catch (err) {
    return { registry: null, error: { code: 'manifest_error', message: `client registry ${REGISTRY_PATH} unreadable: ${err.message}` } };
  }
}

// Atomic registry write (tmp + rename, same discipline as writeEnvVars /
// atomicWriteJson), then invalidate the activeRoot() cache so the new active
// client is seen on the very next path resolution.
export function writeRegistry(registry) {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  atomicWriteJson(REGISTRY_PATH, registry);
  invalidateRegistryCache();
}

// The active client id from the registry, defaulting to "default" when the
// registry is absent or omits it.
export function activeClientId() {
  const registry = readRegistry();
  const id = registry && typeof registry.activeClientId === 'string' && registry.activeClientId
    ? registry.activeClientId
    : 'default';
  return id;
}

function defaultClientEntry() {
  return {
    id: 'default',
    displayName: 'Default',
    status: 'active',
    createdAt: new Date().toISOString(),
    createdBy: 'migration',
  };
}

function defaultRegistry() {
  return { activeClientId: 'default', clients: [defaultClientEntry()] };
}

// Whether a legacy single-workspace exists at WORKSPACE_ROOT (any of the items
// the migration would move). Drives migrate-vs-just-write-registry.
function hasLegacyWorkspace() {
  return legacyItems().some((it) => fs.existsSync(it.src));
}

// Idempotent, zero-loss, crash-safe boot migration.
//
//  - Already migrated (clients.json present OR the marker exists): no-op.
//  - Legacy workspace present: mkdir clients/default, fs.renameSync each existing
//    legacy item into it (per-file rename = atomic, crash-safe), then write
//    clients.json and the marker. A crash mid-move leaves clients.json unwritten,
//    so the next boot re-enters and finishes the remaining renames (each rename
//    is a no-op for an item already moved because its source is gone).
//  - Fresh empty workspace: just write clients.json with the default client.
//
// Returns { migrated } so the caller (server boot) and the test can branch.
export function initMultiClient() {
  // Re-entry guard: a prior run that reached the registry (or the marker) wins.
  if (fs.existsSync(REGISTRY_PATH) || fs.existsSync(MIGRATED_MARKER)) {
    return { migrated: false };
  }

  if (!hasLegacyWorkspace()) {
    writeRegistry(defaultRegistry());
    return { migrated: false };
  }

  const defaultRoot = path.join(CLIENTS_DIR, 'default');
  fs.mkdirSync(defaultRoot, { recursive: true });
  let moved = 0;
  for (const it of legacyItems()) {
    if (!fs.existsSync(it.src)) continue; // already moved (crash re-entry) or absent
    const dest = path.join(defaultRoot, it.relDest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(it.src, dest);
    moved += 1;
  }
  writeRegistry(defaultRegistry());
  // Marker last: only after clients.json is durable do we stamp "done", so a
  // crash before the registry write always re-enters and completes.
  try { fs.writeFileSync(MIGRATED_MARKER, `${new Date().toISOString()}\n`); } catch { /* marker is best-effort; clients.json is the real guard */ }
  logLine('ok', `multi-client: migrated legacy workspace -> data/clients/default (${moved} item(s))`);
  return { migrated: true };
}
