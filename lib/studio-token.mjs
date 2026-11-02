// studio-token.mjs - the per-process Studio owner token (spec 56).
//
// The REST face used to treat "the request came through /api" as owner proof: the routes that
// set a process-private owner marker (CONFIG_OWNER_ACTION, RADAR_OWNER_ACTION) set it on every
// request, and POST /api/dashboard-update pulled and rebuilt for anyone who could reach the
// port. A request with no Origin header (curl, an agent's own HTTP client, any local process)
// passed the SEC-1 Origin check and was trusted as the owner.
//
// The fix is one secret per server process:
//   - minted here at module load (crypto.randomBytes), never persisted across restarts;
//   - handed to the Studio SPA by GET /api/session, which answers only same-origin fetch
//     metadata (Sec-Fetch-Site: same-origin) or one of pendpost's own Origins;
//   - written to a 0600 file OUTSIDE the workspace (~/.pendpost/studio-token) on boot so a CLI or
//     curl flow run by the owner can read it and pass it. Outside the workspace because the
//     workspace is what the HTTP faces serve and what workspace-relative MCP file arguments
//     (set_cover, gbp_media_add) resolve against; ~/.pendpost is the existing per-user dir;
//   - checked with a timing-safe compare. A MATCHING header is owner proof. A MISSING header is
//     an agent-level request (owner markers stay unset, the write itself still runs), except on
//     a route that is owner-only by nature (dashboard-update), which refuses. A WRONG header is
//     always refused, so a Studio tab holding a token from before a daemon restart learns that
//     its token is stale (and refetches it) instead of silently losing owner rights.
//
// Threat model (what the token does and does not stop):
//   STOPS (a) a page on another origin in the owner's browser: CORS refuses its Origin, and a
//         browser sets Sec-Fetch-Site itself, so the page can neither forge same-origin fetch
//         metadata nor read a no-cors answer; (b) a RESTRICTED agent that reaches pendpost only
//         through the MCP tools, or through a fetch tool that cannot set request headers: it
//         never holds the token, so every REST write it makes is agent-level.
//   DOES NOT STOP an arbitrary local HTTP client (curl, a shell, any process running as the
//         owner's user). It can forge Sec-Fetch-Site and read the token file, but it can equally
//         edit config.json, state.json and .env directly, so it is already owner-equivalent; the
//         token adds no boundary against it and does not pretend to.
//
// Zero deps beyond node:crypto/fs/os/path.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { daemonPort } from './util.mjs';

// The request header (Node lower-cases incoming header names). Documented in API-CONTRACT.md.
export const STUDIO_TOKEN_HEADER = 'x-pendpost-studio-token';

// One token per process: a daemon restart mints a new one and every old copy stops matching.
const TOKEN = crypto.randomBytes(32).toString('base64url');
const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();
const TOKEN_DIGEST = digest(TOKEN);

export function studioToken() {
  return TOKEN;
}

// The token directory: the per-user ~/.pendpost (PENDPOST_STUDIO_TOKEN_DIR overrides it, for a
// container or a test). Never inside the workspace.
export function studioTokenDir() {
  return path.resolve(process.env.PENDPOST_STUDIO_TOKEN_DIR || path.join(os.homedir(), '.pendpost'));
}

// The token file, keyed by port: only one process can hold a port, so the file for a port is
// always the live token of whatever serves it. The default daemon port writes
// ~/.pendpost/studio-token; any other PENDPOST_PORT (dev:live on 8099, a test server) writes
// ~/.pendpost/studio-token-<port>.
export function studioTokenFile(port = daemonPort()) {
  return path.join(studioTokenDir(), Number(port) === 8090 ? 'studio-token' : `studio-token-${port}`);
}

// The token files that exist right now, by identity (stat: dev + ino), in the token directory
// (both its given and its real path). Names are matched case-insensitively.
function tokenIdentities() {
  const dir = studioTokenDir();
  const dirs = new Set([dir]);
  try { dirs.add(fs.realpathSync(dir)); } catch { /* not created yet */ }
  const ids = [];
  for (const d of dirs) {
    try { ids.push(fs.statSync(d)); } catch { continue; }
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!/^studio-token/i.test(n)) continue;
      try { ids.push(fs.statSync(path.join(d, n))); } catch { /* raced away */ }
    }
  }
  return ids;
}

// True when `abs` (or an already-taken stat of it) IS a token file or the token directory. The
// string check is only a cheap, case-insensitive pre-filter; the answer comes from file
// IDENTITY (dev + ino), so a case variant on a case-insensitive volume, a symlink, a hard link
// or a ".." spelling all get the same answer. uploadAsset refuses such a source.
export function isStudioTokenPath(abs, st = null) {
  const p = path.resolve(String(abs)).toLowerCase();
  const dir = studioTokenDir().toLowerCase();
  if (p === dir || (p.startsWith(dir + path.sep) && /^studio-token/.test(path.basename(p)))) return true;
  let stat = st;
  if (!stat) {
    try { stat = fs.statSync(abs); } catch { return false; }
  }
  return tokenIdentities().some((t) => t.dev === stat.dev && t.ino === stat.ino);
}

// Read a local file an MCP caller named as an upload source (asset_upload filePath), refusing a
// secret. Refused: a path with ANY dot segment (".env", ".ssh/...", ".pendpost/..."), checked on
// the real path; segments inside the install or workspace root's own prefix are not counted, so
// a checkout under a dot directory (a .claude/worktrees/... worktree) still works. Refused too:
// any Studio token file, by identity. The read goes through the validated real path with
// O_NOFOLLOW, and the opened descriptor must be the very file that was checked (dev + ino, and
// the real path unchanged), so a symlink swap between check and read is refused, not followed.
// Which directories a source may come from at all is NOT decided here.
export function readUploadSource(abs, roots = []) {
  const refuse = { ok: false, message: 'that source file cannot be uploaded (dotfiles, dot directories and the Studio token are refused)' };
  let real;
  try { real = fs.realpathSync(abs); } catch (err) { return { ok: false, message: `could not read the upload: ${err.message}` }; }
  const realRoots = roots.map((r) => { try { return fs.realpathSync(r); } catch { return path.resolve(r); } });
  const base = realRoots.filter((r) => real === r || real.startsWith(r + path.sep)).sort((a, b) => b.length - a.length)[0];
  const rest = base ? path.relative(base, real) : real;
  if (rest.split(path.sep).some((seg) => seg.startsWith('.') && seg !== '.')) return refuse;
  let handle;
  try {
    handle = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (err) {
    return { ok: false, message: `could not read the upload: ${err.message}` };
  }
  try {
    const st = fs.fstatSync(handle);
    if (!st.isFile()) return { ok: false, message: 'the upload source is not a file' };
    let again = null;
    try { again = fs.realpathSync(real); } catch { /* vanished */ }
    let checked = null;
    try { checked = fs.statSync(real); } catch { /* vanished */ }
    if (again !== real || !checked || checked.dev !== st.dev || checked.ino !== st.ino) return refuse;
    if (isStudioTokenPath(abs, st) || isStudioTokenPath(real, st)) return refuse;
    return { ok: true, buf: fs.readFileSync(handle) };
  } finally {
    fs.closeSync(handle);
  }
}

// Write the token file, owner-read/write only (0600, its directory 0700), atomically (tmp +
// rename, so a reader never sees a half-written token). Overwrites the previous process's file,
// and removes it again on a clean exit when it still holds this process's token (so test servers
// on random ports leave nothing behind). Returns the path.
export function writeStudioTokenFile(file = studioTokenFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${TOKEN}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  process.once('exit', () => {
    try { if (fs.readFileSync(file, 'utf8').trim() === TOKEN) fs.unlinkSync(file); } catch { /* best-effort */ }
  });
  return file;
}

// 'absent' (no header, or an empty one), 'valid' (timing-safe match) or 'invalid'.
// Both sides are hashed first, so the compare is fixed-length and leaks nothing about the token.
export function studioTokenState(req) {
  const raw = req && req.headers ? req.headers[STUDIO_TOKEN_HEADER] : undefined;
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  if (typeof value !== 'string' || !value.trim()) return 'absent';
  return crypto.timingSafeEqual(digest(value.trim()), TOKEN_DIGEST) ? 'valid' : 'invalid';
}

// True only when the request carries THIS process's token. The one predicate every owner marker
// on the REST face is derived from.
export function isStudioOwner(req) {
  return studioTokenState(req) === 'valid';
}

// pendpost's own Origins, registered by server.mjs (its SEC-1 ALLOWED_ORIGINS set). Empty until
// registered, so a bare handleApi (tests) only hands the token to same-origin fetch metadata.
let sessionOrigins = new Set();
export function setSessionOrigins(origins) {
  sessionOrigins = new Set(origins || []);
}

// The GET /api/session gate (threat model at the top of this file). It trusts Sec-Fetch-Site and
// Origin, which any NON-browser local client can forge. That residual risk is accepted on
// purpose: such a client runs as the owner's user and can already edit data/ and read the token
// file, so it is owner-equivalent. The gate exists for the two callers that CANNOT forge these
// headers: a browser page on another origin, and a restricted agent whose only reach is the MCP
// tools or a fetch tool that sends no custom headers.
// Browsers set Sec-Fetch-Site themselves and a page cannot forge it:
// 'same-origin' is the SPA served by this server or by the Vite dev server that proxies to it.
// An allowed Origin with 'same-site' (or no fetch metadata at all, an older browser) is the dev
// Studio on a sibling loopback port. Everything else is refused: 'cross-site', 'none' (a typed
// URL), and a bare request with neither header (curl, an agent's HTTP client), which reads the
// token file instead.
export function sessionRequestAllowed(req) {
  const headers = (req && req.headers) || {};
  const site = String(headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'same-origin') return true;
  const origin = headers.origin;
  if (!origin || !sessionOrigins.has(origin)) return false;
  return site === '' || site === 'same-site';
}
