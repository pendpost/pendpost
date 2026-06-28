// util.mjs - shared helpers for the pendpost server (zero-dep).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Two distinct roots:
//  - INSTALL_ROOT / REPO_ROOT: where the code + built assets live (lib/, scripts/,
//    app/dist, the shipped default rules.json). Always resolved from this file.
//  - WORKSPACE_ROOT: where the OWNER'S data lives (.env, config.json, state.json,
//    data/). Defaults to the install dir so a plain checkout just works, but is
//    overridable via PENDPOST_ROOT so one install can serve a separate workspace
//    (npx, docker, multi-tenant). STUDIO_ROOT stays an alias for WORKSPACE_ROOT.
const INSTALL_ROOT = path.resolve(__dirname, '..');
export const REPO_ROOT = INSTALL_ROOT;
export const WORKSPACE_ROOT = path.resolve(process.env.PENDPOST_ROOT || INSTALL_ROOT);
export const STUDIO_ROOT = WORKSPACE_ROOT;
export const DATA_ROOT = path.join(WORKSPACE_ROOT, 'data');
export const VERSION = '1.1.1';

// The .env now lives in the ACTIVE client subtree, not at WORKSPACE_ROOT.
// envPath() resolves it from activeRoot() at call time (lib/context.mjs): the
// bound client's root when withClient() is active, the active client's root once
// migrated, or the legacy WORKSPACE_ROOT in the un-migrated single-workspace
// fallback - so existing behavior is preserved when no clients.json exists.
// Imported lazily to avoid an import-time cycle (context.mjs imports util.mjs);
// the binding is only ever read inside these function bodies, never at top level.
import { activeRoot } from './context.mjs';
export function envPath() {
  return path.join(activeRoot(), '.env');
}
// Back-compat alias: some modules import ENV_PATH. It is a FUNCTION returning the
// activeRoot()-resolved path (a value snapshot would freeze the wrong root). Call
// it: ENV_PATH(). Internal readers use envPath() directly.
export const ENV_PATH = envPath;

// The INSTALL-GLOBAL .env (WORKSPACE_ROOT/.env), independent of the active client.
// Reserved for install-global secrets - today only the managed-cloud api key, which
// authenticates the ONE install-global workspace (data/cloud.json) and so must resolve
// the same for every brand. PER-CLIENT secrets (platform tokens) stay at envPath().
// In the un-migrated single-workspace fallback activeRoot() IS WORKSPACE_ROOT, so this
// COINCIDES with envPath() - centralizing the cloud key is a no-op for single-client
// installs and only separates the locations once clients.json exists.
export function globalEnvPath() {
  return path.join(WORKSPACE_ROOT, '.env');
}

// Stable error codes shared by the JSON API and the MCP tools. Every error
// reply is { code, message, hint?, retryAfter? } so agents can branch on code.
export const ERROR_CODES = new Set([
  'unknown_campaign', 'unknown_post', 'media_missing', 'not_approved',
  'needs_confirm', 'blocked_368', 'stale_write', 'in_flight',
  'invalid_input', 'engine_failure', 'manifest_error', 'unknown_route',
  // Managed-cloud transport/config codes — JSON-API/operator-only (NOT MCP tools).
  // Mirror of CLOUD_ERROR_STATUS in lib/api.mjs; a CloudError code must be here or
  // errorBody() throws on it.
  'no_api_key', 'not_configured', 'disabled',
  'http_error', 'network_error', 'presign_failed', 'upload_failed',
]);

export function errorBody(code, message, extra = {}) {
  if (!ERROR_CODES.has(code)) throw new Error(`unknown error code: ${code}`);
  return { code, message, ...extra };
}

// All four .env helpers take an OPTIONAL absolute path, defaulting to the active
// client's .env (envPath()). Callers pass globalEnvPath() to read/write the
// install-global cloud api key; everything else keeps the per-client default.
export function readEnvRaw(p = envPath()) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

export function readEnv(name, p = envPath()) {
  const m = readEnvRaw(p).match(new RegExp(`^${name}=(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

// Last 4 chars of a secret for display - never the value itself.
export function tokenTail(value) {
  return value ? `...${value.slice(-4)}` : null;
}

// Hardened .env writer for the pendpost config surface: function-replacer (a value
// containing '$NN' would be mangled by String#replace), atomic tmp+rename, 0600
// perms. Rejects '=' / newline in a value (they corrupt the line parser). It does
// NOT gate on key name - the CALLER must whitelist which keys are writable and
// must NEVER pass a secret here (the pendpost config surface writes non-secret
// identifiers only; secrets stay an interactive CLI ceremony).
export function writeEnvVars(updates, p = envPath()) {
  let raw = readEnvRaw(p);
  for (const [k, v] of Object.entries(updates)) {
    if (v == null) continue;
    const val = String(v);
    if (/[=\n\r]/.test(val)) throw new Error(`value for ${k} contains '=' or a newline`);
    if (new RegExp(`^${k}=`, 'm').test(raw)) {
      raw = raw.replace(new RegExp(`^${k}=.*$`, 'm'), () => `${k}=${val}`);
    } else {
      raw += `${raw.endsWith('\n') || raw === '' ? '' : '\n'}${k}=${val}\n`;
    }
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, raw, { mode: 0o600 });
  fs.renameSync(tmp, p);
}

// Remove the given .env keys entirely (line + trailing newline), cleanly dropping a
// secret rather than leaving a dangling `KEY=`. Atomic tmp+rename + 0600, mirroring
// writeEnvVars. Accepts a name or an array of names; a missing key is a no-op. Like
// writeEnvVars, it does NOT gate on key name - the CALLER whitelists which keys to drop.
export function removeEnvVars(names, p = envPath()) {
  const list = Array.isArray(names) ? names : [names];
  let raw = readEnvRaw(p);
  if (!raw) return;
  for (const k of list) {
    raw = raw.replace(new RegExp(`^${k}=.*\\n?`, 'm'), '');
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, raw, { mode: 0o600 });
  fs.renameSync(tmp, p);
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Raw Buffer body reader (UPLOAD-1). Binary uploads (cover JPEGs) MUST come
// through here - the utf8 decode in readBody() corrupts binary bytes.
//
// The body is cached on the request (req[BODY_CACHE]) so it can be read more
// than once: lib/api.mjs peeks the body in its dispatcher to resolve a per-call
// clientId, then the route handler reads it again. A Node request stream is
// single-use, so without this cache the second read would hang/return empty.
const BODY_CACHE = Symbol('pendpost.bodyCache');
export function readBodyRaw(req, limit = 4 * 1024 * 1024) {
  if (req[BODY_CACHE]) return req[BODY_CACHE];
  const p = new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  req[BODY_CACHE] = p;
  return p;
}

export function readBody(req, limit = 4 * 1024 * 1024) {
  return readBodyRaw(req, limit).then((buf) => buf.toString('utf8'));
}

// Atomic JSON write: tmp file + rename, so a crash mid-write never leaves a
// half-written file behind (STATE-1). Same-directory tmp keeps rename atomic.
export function atomicWriteJson(absPath, data) {
  const tmp = `${absPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, absPath);
}

export function logLine(tag, msg) {
  console.log(`${new Date().toISOString()} [${tag}] ${msg}`);
}

// launchd agents run with a minimal PATH (/usr/bin:/bin:...) that excludes
// Homebrew, so a bare execFile('ffprobe') dies with spawn ENOENT under the
// installed agent while working fine in a dev shell. Resolve known install
// locations first, fall back to PATH.
export function resolveBin(name) {
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return name;
}
