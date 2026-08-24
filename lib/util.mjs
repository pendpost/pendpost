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
export const VERSION = '2.2.0';

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

// The daemon's OWN port + the URL a LOCAL child process dials to reach its MCP face.
// server.mjs imports DAEMON_PORT for its listen() call, so the 8090 default has exactly
// one definition here and cannot drift from what spec 41's spawned agent is told to dial.
// lib/ must not import server.mjs (server.mjs imports lib/*), so the resolution lives at
// the leaf instead.
export const daemonPort = () => Number(process.env.PENDPOST_PORT || 8090);
// ALWAYS loopback, never the bind host. PENDPOST_HOST=0.0.0.0 (the container case) is a
// WILDCARD meaning "every interface", not a dialable address - echoing it into a URL
// would hand a child something it cannot connect to. A child on this host reaches the
// daemon via loopback whatever it bound to, and 127.0.0.1:<port> is what server.mjs's
// Host allow-list (the DNS-rebinding guard) accepts.
export const mcpUrl = () => `http://127.0.0.1:${daemonPort()}/mcp`;

// Stable error codes shared by the JSON API and the MCP tools. Every error
// reply is { code, message, hint?, retryAfter? } so agents can branch on code.
export const ERROR_CODES = new Set([
  'unknown_campaign', 'unknown_post', 'media_missing', 'not_approved',
  'needs_confirm', 'blocked_368', 'stale_write', 'in_flight',
  'invalid_input', 'engine_failure', 'manifest_error', 'unknown_route',
  // Spec 48 (client review link): a review decision whose carried contentHash no
  // longer matches the current approvable post - refused IN FRONT of setApproval so
  // a reviewer never approves copy they did not see. Distinct from stale_write (an
  // optimistic-concurrency rev clash on an operator edit).
  'stale_content',
  // `npm run dev:live` READ/COMPOSE-ONLY guard (lib/dev-mode.mjs): a publish/approval
  // write refused because this is the dev instance, not the live daemon.
  'dev_readonly',
  // Spec 20 (nostr zaps, the money path): a pay request that was published but never
  // confirmed - DISTINCT from engine_failure so the operator checks their wallet
  // instead of blindly retrying a possibly-settled payment.
  'payment_status_unknown',
  // Owner round 3 (radar_queue_reply): the signal's agent score is below the owner's
  // draft threshold (posting.radar.autoReply.minScore). A FINAL skip, never a retry -
  // distinct from invalid_input so the drafting child logs it as a decision, not an error.
  'below_threshold',
  // Spec 48 R10 (client review link): review.hosted was asked to enable, but the
  // pendpost-cloud receiver that serves the always-on hosted link is flagged not built
  // (§9.4). A fail-closed refusal DISTINCT from invalid_input so the operator reads
  // "not yet available" (the local review link still works), not "you sent a bad value".
  'review_hosted_unavailable',
  // Enforced pre-flight gate: setApproval refused because a targeted lane carries a
  // content-integrity blocker (caption over cap, av-sync, poll/carousel shape, ...) the
  // platform WILL reject. Carries blocked:[{platform, problems}]. DISTINCT from
  // not_approved (that is the publish-side "this post was never blessed") - this is the
  // approve-side "this post is not fit to bless yet". The owner can pass force:true.
  'not_ready',
  // Inbound-reply round-trip (spec 23): the operator answers one inbound X Activity
  // event from the inbox. not_repliable = a reaction/follow event has no thread to
  // answer (a FINAL skip, not a retry); not_found = the eventId is not in the local
  // inbound-event store. needs_scope/credits/target_gone are the mapped engine
  // failures the inbox surfaces distinctly (authorize a write scope / top up X API
  // credits / the tweet or DM conversation is gone), never a blind retry.
  'not_repliable', 'not_found', 'needs_scope', 'credits', 'target_gone',
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

// Spec 30 (Ghost members-import), fixed post-review: a zero-dep RFC-4180 CSV
// parser (comma-delimited, double-quoted fields with embedded commas/newlines
// and escaped "" -> ", CRLF or LF line endings, blank-line skipping, a missing
// trailing newline). A real Ghost/Mailchimp/Excel member export quotes every
// field that contains a comma or newline - the PRIOR naive split(',') silently
// corrupted that data before it was written into Ghost: `jane@x.com,"Doe,
// Jane"` split into a phantom extra cell (name became `"Doe`), `"bob@x.com"
// ,Bob` round-tripped the email WITH its literal quote characters (a 422 from
// Ghost), and an embedded newline inside a quoted note split one row into two.
// Malformed input (e.g. an unterminated quote) DEGRADES rather than throws -
// the unclosed field just consumes to EOF as its own content instead of
// crashing the whole import. Shared between the live engine
// (scripts/ghost-social.mjs) and the mock driver (lib/drivers/mock-driver.mjs)
// so the row-splitting logic never drifts between the two - both import it
// from here rather than each other (they already import each other in one
// direction, so a shared neutral home avoids a cycle). The header row is
// lower-cased so `Email,Name` and `email,name` both resolve to the same row
// keys; a blank/whitespace-only file returns [].
function parseCsvRecords(text) {
  const s = String(text || '');
  const n = s.length;
  const records = [];
  let row = [];
  let field = '';
  let quoted = false; // did the CURRENT field open with a leading "?
  let inQuotes = false;
  const pushField = () => { row.push(quoted ? field : field.trim()); field = ''; quoted = false; };
  const pushRow = () => {
    pushField();
    if (!(row.length === 1 && row[0] === '')) records.push(row); // drop blank lines
    row = [];
  };
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped "" -> "
        inQuotes = false; // the closing quote
        i += 1;
        continue;
      }
      field += c; // any byte, including a literal comma or newline, inside quotes
      i += 1;
      continue;
    }
    if (c === '"' && field === '') { inQuotes = true; quoted = true; i += 1; continue; }
    if (c === ',') { pushField(); i += 1; continue; }
    if (c === '\r') { if (s[i + 1] === '\n') i += 1; pushRow(); i += 1; continue; }
    if (c === '\n') { pushRow(); i += 1; continue; }
    field += c;
    i += 1;
  }
  if (field !== '' || row.length > 0 || quoted) pushRow(); // trailing row with no final newline
  return records;
}

export function parseCsvRows(csvText) {
  const records = parseCsvRecords(csvText);
  if (!records.length) return [];
  const headers = records[0].map((h) => h.trim().toLowerCase());
  return records.slice(1).map((cells) => {
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
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
