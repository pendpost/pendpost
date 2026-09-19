// lib/engage-browser.mjs - the auto-engage BROWSER EXECUTOR (spec 50 P4, on the §8 L3 path).
//
// WHY THIS IS L3 AND NOT THE EXTENSION. D1 and §7.6 originally routed browser lanes through
// the owner's real Chrome via the Claude in Chrome extension. That was measured unreachable on
// 2026-09-09 (§5.1 row 21, §5.2): a daemon-spawned child - headless or under a pty - is handed
// no `mcp__claude-in-chrome__*` tool at all, and `/chrome` inside it reports Status: Disabled.
// An executor that cannot execute is worse than an absent one, because the ledger would show
// browser platforms as usable. So spec 50's own third rung, L3, is now rung ONE for browser
// lanes: @playwright/mcp driving the SYSTEM Chrome against a pendpost-owned persistent profile
// under ~/.pendpost/browser/<clientId>/, armed by a one-time headed login ceremony
// (scripts/engage-browser.mjs). It needs no extension and no pairing.
//
// WHAT THAT CHANGES, HONESTLY. The profile is pendpost's, not the owner's default Chrome
// profile (Chrome locks that against a second instance, which is what sank D1's premise in the
// first place). So a lane is usable only after the owner has logged in ONCE in that profile.
// Everything else in the spec holds unchanged: one profile per client, all lanes inside it,
// in-app account switching (D13), the identity check before EVERY batch (§13.3), the
// read-only-first inspection, the auth_wall stop, the payload fence and the transcript audit.
//
// WHAT THIS MODULE OWNS: the profile, the bridge check, the MCP server description the runner
// writes for the child, the identity probe, one batch per spawn, the report ingest (the
// `results` branch of radar_engage_report), the transcript audit, and the reverse actions P3's
// engage_undo calls. It owns no policy: caps, gaps and grace stay in lib/engage-pacer.mjs, and
// the dispatch stays in lib/engage.mjs.
//
// ZERO-DEP, DELIBERATELY. pendpost is one zero-dependency Node process (README) and its own
// test suite pins that. So nothing here is imported from npm: the MCP server is launched as
// `npx -y @playwright/mcp@<pinned>` by the CHILD's config (nothing is installed into pendpost),
// system Chrome is found by path, and the login ceremony launches that same Chrome binary
// directly against the same profile directory. The version is pinned in one place below.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getPosting } from './config.mjs';
import { engageState } from './writes.mjs';
import { saveState } from './state.mjs';
import { logLine } from './util.mjs';
import { activeClientId } from './multi-client.mjs';
import {
  runAgentJob, readTranscript, appendTranscript,
  AGENT_ENGAGE_TOOLS, AGENT_ENGAGE_PROBE_TOOLS, BROWSER_TYPING_TOOLS,
} from './agent-runner.mjs';
import { ENGAGE_CAPABILITIES } from './radar.mjs';
import {
  findActionRow, markDone, markDryRun, markFailed, markReleasing, setLaneRuntime,
  enginePolicy, incrementCounter, engageDateKey,
} from './engage.mjs';

// ---------------------------------------------------------------------------
// The pinned browser server
// ---------------------------------------------------------------------------

// PINNED, not floating. `@latest` would let a background npm release change what the child can
// do to a live account between two batches; a build agent that measured the flags below
// measured THIS version. Overridable by env for a hand-run upgrade test, never by config - a
// config-settable package spec is a config-settable code execution.
//
// The same pin is DECLARED in package.json under `pendpost.browserServer`, so a dependency
// review of this repo finds it in the file people look in, and test/engage-browser.test.mjs
// fails when the two drift. It is deliberately NOT in `dependencies`: pendpost declares zero
// runtime dependencies (NFR-LIC-01, test/supply-chain.test.mjs), nothing is installed into the
// engine, and the server is fetched and run by the CHILD's own npx at this exact version.
export const PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp';
export const PLAYWRIGHT_MCP_VERSION = String(process.env.PENDPOST_PLAYWRIGHT_MCP_VERSION || '0.0.80');

// The MCP server name the child sees. Its tools are therefore mcp__browser__browser_navigate
// and friends, which is what AGENT_ENGAGE_TOOLS enumerates.
export const BROWSER_SERVER_NAME = 'browser';

// Verified against `npx @playwright/mcp@0.0.80 --help` on 2026-09-09:
//   --browser chrome        use the installed system Chrome channel (no bundled download)
//   --user-data-dir <path>  the persistent profile; ours, never the owner's default
//   --viewport-size <WxH>   note the `x`, not a comma - the spec's "1280,900" is not this flag's shape
//   --headless              headed is the DEFAULT; see BROWSER_HEADLESS below
// Deliberately NOT passed: --no-sandbox (weakens Chrome's own sandbox for no gain on a desktop
// Mac), --isolated (it would throw the profile away, which is the one thing we need to keep),
// and --allow-unrestricted-file-access (off by default, and it must stay off).
export const VIEWPORT_SIZE = '1280x900';

// Headed by default. MEASURED (2026-09-09): a session logged in inside this profile survives a
// later --headless run, so headless is not a login-breaker on its own - but headless Chrome is
// what several of these platforms fingerprint first, and a headed window is also the honest
// signal to the owner that their machine is acting as them. Env-overridable for an operator who
// wants the window out of the way; never a config key, because a silent headless flip changes
// what a platform sees without anything on screen saying so.
export const BROWSER_HEADLESS = String(process.env.PENDPOST_BROWSER_HEADLESS || '') === '1';

const ENGAGE_BATCH_TIMEOUT_MS = 600_000;
const ENGAGE_PROBE_TIMEOUT_MS = 180_000;
const DEFAULT_PROBE_TTL_HOURS = 24;

// ---------------------------------------------------------------------------
// The profile, and the Chrome that opens it
// ---------------------------------------------------------------------------

export const BROWSER_PROFILE_ROOT = path.join(os.homedir(), '.pendpost', 'browser');

// One profile per client, all lanes inside it - that IS D13's in-app-switching model: the
// executor verifies which account is logged in before every batch and files a "switch account"
// ask rather than logging anything in or out.
//
// The slug guard is not decoration: this path is handed to a browser as its whole state
// directory, and a clientId carrying `..` would point it at the operator's own Chrome profile,
// which is precisely the directory this feature must never touch.
export function browserProfileDir(clientId = activeClientId()) {
  const slug = String(clientId || 'default').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[.-]+/, '') || 'default';
  return path.join(BROWSER_PROFILE_ROOT, slug);
}

// System Chrome, by path. Override -> macOS bundles -> Linux binaries -> PATH. No Playwright
// import, no bundled browser: --browser chrome uses whatever this finds, and if it finds
// nothing the bridge check says so in plain words instead of a lane pretending to be ready.
const CHROME_CANDIDATES = Object.freeze([
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]);

function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

function whichFromPath(bin) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, bin);
    if (isExecutable(full)) return full;
  }
  return null;
}

export function chromeExecutable() {
  const override = String(process.env.PENDPOST_CHROME_BIN || '').trim();
  if (override) return isExecutable(override) ? override : null;
  for (const c of CHROME_CANDIDATES) if (isExecutable(c)) return c;
  return whichFromPath('google-chrome') || whichFromPath('chromium');
}

// npx, resolved the way lib/agent-runner.mjs resolves `claude`: beside the daemon's own node
// first (a standard install puts them together), then the usual bin dirs, then PATH. Under
// launchd the daemon's PATH is /usr/bin:/bin:/usr/sbin:/sbin with no Homebrew, so an unresolved
// bare 'npx' in the child's MCP config would fail silently as a server that never starts.
const NPX_DIRS = Object.freeze(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']);

export function resolveNpxBin() {
  const override = String(process.env.PENDPOST_NPX_BIN || '').trim();
  if (override) return isExecutable(override) ? override : null;
  const beside = path.join(path.dirname(process.execPath), 'npx');
  if (isExecutable(beside)) return beside;
  for (const dir of NPX_DIRS) {
    const full = path.join(dir, 'npx');
    if (isExecutable(full)) return full;
  }
  return whichFromPath('npx');
}

// THE KEYCHAIN FIX (spec 50, browser lanes). Playwright launches Chromium with a default arg
// list that includes `--use-mock-keychain` (playwright-core coreBundle). On macOS that makes
// Chrome derive its cookie-encryption key from an in-memory MOCK keychain, not the real
// "Chrome Safe Storage" login-keychain item. So a profile whose cookies were written by the
// owner's REAL Chrome (the login ceremony, or a `connect` copy) cannot be decrypted by the
// daemon's Chrome, and every browser lane reads back logged-out. Removing exactly that one
// default arg makes the daemon's Chrome use the real Keychain key - the same binary, the same
// OS user, so it is already in the item's ACL and no prompt appears. This is passed through a
// @playwright/mcp --config file (browser.launchOptions is forwarded to launchPersistentContext,
// per its config.d.ts) rather than a CLI flag, because there is no CLI flag for it. It is the
// ONE thing that makes any browser lane usable; without it neither `login` nor `connect` works.
export const BROWSER_LAUNCH_CONFIG = Object.freeze({
  browser: { launchOptions: { ignoreDefaultArgs: ['--use-mock-keychain'] } },
});

// Written once beside the profile root; static content, so re-writing it every launch is cheap
// and keeps it self-healing if it is ever deleted. Returns the path the child's --config reads.
export function writeBrowserLaunchConfig() {
  fs.mkdirSync(BROWSER_PROFILE_ROOT, { recursive: true });
  const p = path.join(BROWSER_PROFILE_ROOT, 'launch-config.json');
  fs.writeFileSync(p, JSON.stringify(BROWSER_LAUNCH_CONFIG, null, 2));
  return p;
}

// The argv the child's MCP config launches. Pure, so a test can assert the profile path and the
// --config (the keychain fix) are in it and that no secret ever is.
export function playwrightMcpArgv({ profileDir, headless = BROWSER_HEADLESS, viewport = VIEWPORT_SIZE, configPath } = {}) {
  return [
    '-y', `${PLAYWRIGHT_MCP_PACKAGE}@${PLAYWRIGHT_MCP_VERSION}`,
    '--browser', 'chrome',
    '--user-data-dir', profileDir,
    '--viewport-size', viewport,
    ...(configPath ? ['--config', configPath] : []),
    ...(headless ? ['--headless'] : []),
  ];
}

// The `mcpServers` fragment lib/agent-runner.mjs merges beside pendpost's own HTTP server.
// It carries NO secret: this server's entire state is the on-disk Chrome profile, and the
// profile is not readable through any pendpost tool or route.
export function browserMcpServers({ clientId = activeClientId(), headless = BROWSER_HEADLESS } = {}) {
  const npx = resolveNpxBin();
  return {
    [BROWSER_SERVER_NAME]: {
      command: npx || 'npx',
      args: playwrightMcpArgv({ profileDir: browserProfileDir(clientId), headless, configPath: writeBrowserLaunchConfig() }),
    },
  };
}

// ---------------------------------------------------------------------------
// The bridge check (§7.6, row 7e)
// ---------------------------------------------------------------------------

// On the L3 path "Waiting for Chrome" means something narrower and more actionable than it did
// on the extension path: Chrome is not installed, or this client's profile directory cannot be
// created. It never means "Chrome is closed" - pendpost opens its own, which is the whole point
// of owning the profile. D2's "no auto-launching Chrome" survives in the sense that matters:
// pendpost never touches the owner's own browser or its windows.
//
// Cached in state.engage.browser for chrome.probeTtlHours, because a filesystem probe per tick
// per client is pointless work on a machine where the answer changes about once a year.
export function checkBrowserBridge({ clientId = activeClientId(), now = Date.now(), force = false } = {}) {
  const state = engageState();
  const store = state.engage;
  const cached = store.browser && typeof store.browser === 'object' && !Array.isArray(store.browser) ? store.browser : null;
  const policy = enginePolicy();
  const ttlHours = Number((policy.chrome || {}).probeTtlHours);
  const ttlMs = (Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : DEFAULT_PROBE_TTL_HOURS) * 3600 * 1000;
  if (!force && cached && cached.clientId === String(clientId) && (now - (Date.parse(cached.checkedAt || '') || 0)) < ttlMs) {
    return { ...cached, cached: true };
  }

  const chromePath = chromeExecutable();
  const profileDir = browserProfileDir(clientId);
  let profileOk = false;
  let profileErr = '';
  try { fs.mkdirSync(profileDir, { recursive: true }); profileOk = fs.statSync(profileDir).isDirectory(); } catch (err) { profileErr = err?.message || String(err); }
  const npx = resolveNpxBin();

  let ok = true;
  let detail = 'Chrome is installed and this project has its own browser profile.';
  if (!chromePath) {
    ok = false;
    detail = 'Google Chrome is not installed on this Mac. Install Chrome, then check again - pendpost drives the installed Chrome, it does not ship a browser.';
  } else if (!profileOk) {
    ok = false;
    detail = `pendpost could not create its browser profile at ${profileDir}${profileErr ? ` (${profileErr})` : ''}.`;
  } else if (!npx) {
    ok = false;
    detail = 'npx was not found, so the browser server cannot be started. Install Node.js so that npx is on the daemon\'s PATH.';
  }

  const next = {
    ok,
    detail,
    checkedAt: new Date(now).toISOString(),
    clientId: String(clientId),
    chromePath: chromePath || null,
    profileDir,
  };
  store.browser = next;
  saveState();
  return { ...next, cached: false };
}

// ---------------------------------------------------------------------------
// The lanes, their identity check and their login page (§7.2 identity column)
// ---------------------------------------------------------------------------

// Every lane whose reply route is a browser one, derived from the frozen capability table
// rather than listed here - a hard-coded list is how a new browser lane goes missing from one
// surface and not another.
export const BROWSER_LANES = Object.freeze(Object.entries(ENGAGE_CAPABILITIES)
  .filter(([, row]) => Object.entries(row).some(([kind, list]) => kind !== 'identity' && Array.isArray(list) && list.some((e) => e === 'browser' || e === 'browser2')))
  .map(([lane]) => lane));

// url  - where the child looks
// where - the ONE sentence that tells it what on that page is the handle (§7.2 identity column)
// login - where the owner logs in during the ceremony
export const BROWSER_IDENTITY = Object.freeze({
  hackernews: Object.freeze({
    url: 'https://news.ycombinator.com/news',
    where: 'the username link in the orange header bar, top right, immediately left of the "logout" link. When the header shows a "login" link instead, nobody is logged in.',
    login: 'https://news.ycombinator.com/login',
  }),
  x: Object.freeze({
    url: 'https://x.com/home',
    where: 'the account button at the bottom of the left sidebar, which shows the display name over the @handle. Report the @handle without the @.',
    login: 'https://x.com/login',
  }),
  linkedin: Object.freeze({
    url: 'https://www.linkedin.com/in/me/',
    where: 'the URL you land on after LinkedIn redirects /in/me to the real profile: the vanity id between /in/ and the next slash.',
    login: 'https://www.linkedin.com/login',
  }),
  instagram: Object.freeze({
    url: 'https://www.instagram.com/accounts/edit/',
    where: 'the Username field on the edit-profile form. Do not change it, only read it.',
    login: 'https://www.instagram.com/accounts/login/',
  }),
  quora: Object.freeze({
    url: 'https://www.quora.com/profile',
    where: 'the profile name shown on the profile page you land on, or the profile URL segment after /profile/.',
    login: 'https://www.quora.com/',
  }),
});

export const laneLoginUrl = (lane) => (BROWSER_IDENTITY[lane] || {}).login || null;
export const laneIdentityTarget = (lane) => BROWSER_IDENTITY[lane] || null;

// The one line the ledger and the ceremony both print when a lane is not logged in. Named once
// so the state line, the digest and the CLI can never disagree about the command.
export const loginCommandFor = (lane, clientId = activeClientId()) => `node scripts/engage-browser.mjs login --client ${clientId} --lane ${lane}`;

// The one line the Radar automation switch prints when no lane is connected yet. Named beside
// loginCommandFor so the UI toast, the CLI and the digest can never disagree about the command.
export const connectCommandFor = (clientId = activeClientId()) => `node scripts/engage-browser.mjs connect --client ${clientId}`;

// ---------------------------------------------------------------------------
// Connect Chrome: reuse the owner's already-authenticated desktop Chrome sessions
// ---------------------------------------------------------------------------
//
// THE ONE-TIME ALTERNATIVE TO THE PER-LANE LOGIN CEREMONY. Rather than sign in by hand in each
// lane, the owner points connect at a profile of their REAL Chrome (where every social account
// is already logged in) and pendpost seeds its OWN per-client profile with a read-only copy of
// that profile's session stores. The recurring 24/7 automation still runs on the headless
// @playwright/mcp daemon path against pendpost's own profile - this only fills that profile's
// cookie jar once, from a source the owner names.
//
// WHY A COPY AND NOT THE EXTENSION / THE OWNER'S PROFILE DIRECTLY. The Claude-in-Chrome extension
// is unreachable from the daemon (see the header). Chrome locks a profile against a second
// instance, so the daemon can never open the owner's own profile dir. A COPY sidesteps both: it
// is pendpost's profile, openable headless around the clock, seeded from the owner's sessions.
//
// WHY THE COPY STAYS DECRYPTABLE (macOS). Chrome's cookie-encryption key on macOS is per
// APPLICATION (one login-Keychain entry, "Chrome Safe Storage"), not per profile: `os_crypt` in
// Local State is empty. So an encrypted cookie blob copied into pendpost's profile is read back
// by the SAME Chrome binary run by the SAME OS user against the SAME Keychain key. No decryption
// code, no secret ever touched by pendpost. (On a Chrome that moved macOS to app-bound cookie
// encryption this would break; scripts/engage-browser.mjs connect verifies a lane logs in before
// it claims success, and the per-lane login ceremony remains the fallback.)
//
// WHAT connect NEVER DOES. seedProfileFromChrome writes NO config and NO state - it only fills
// the on-disk profile; a lane becomes usable only when engage_probe -> confirm_handle -> Yes runs
// INSIDE the daemon, exactly as after a manual login. (The connect CLI then runs the same
// read-only identity probe the login ceremony does, which writes only lane RUNTIME that the daemon
// re-derives on its next tick - never config, never a handle.) It never reads or logs a cookie
// VALUE. seedProfileFromChrome only ever writes under this client's own profile dir
// (browserProfileDir's slug guard), never near the owner's Chrome.

// The owner's real Chrome user-data-dir. macOS first (where the daemon runs), then Linux. Not the
// pendpost profile root - this is the SOURCE the owner copies FROM.
export function chromeUserDataRoot() {
  const override = String(process.env.PENDPOST_CHROME_USER_DATA_DIR || '').trim();
  if (override) return override;
  const home = os.homedir();
  const mac = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  if (fs.existsSync(mac)) return mac;
  return path.join(home, '.config', 'google-chrome');
}

// The sqlite3 CLI, by path, the same "system binary or nothing" philosophy as chromeExecutable /
// resolveNpxBin. Used to copy the live Cookies DB with VACUUM INTO (a consistent snapshot that
// does not require quitting the owner's Chrome). No npm sqlite dependency: pendpost stays zero-dep.
const SQLITE_DIRS = Object.freeze(['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin', '/bin']);
export function resolveSqliteBin() {
  const override = String(process.env.PENDPOST_SQLITE_BIN || '').trim();
  if (override) return isExecutable(override) ? override : null;
  for (const dir of SQLITE_DIRS) {
    const full = path.join(dir, 'sqlite3');
    if (isExecutable(full)) return full;
  }
  return whichFromPath('sqlite3');
}

// The session stores a seeded profile needs. Cookies is the load-bearing one (the httpOnly auth
// cookies live only here - the extension path could never reach them). Local Storage carries the
// token some SPAs (Instagram, X) read on boot. IndexedDB is opt-in: it can be large and is rarely
// the sole auth store. Copied into <dest>/Default/, which is the profile @playwright/mcp opens.
export const SESSION_STORES = Object.freeze([
  { name: 'Cookies', kind: 'sqlite', rel: 'Cookies', default: true },
  { name: 'Local Storage', kind: 'dir', rel: 'Local Storage', default: true },
  { name: 'IndexedDB', kind: 'dir', rel: 'IndexedDB', default: false },
]);

/**
 * Enumerate the profiles inside the owner's real Chrome so `connect` can offer a labelled pick.
 * Read-only. Never opens a Cookies DB - only reads each profile's Preferences for a human label.
 * @returns {{dir:string,name:string,email:string,hasCookies:boolean}[]}
 */
export function discoverChromeProfiles(root = chromeUserDataRoot()) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const isProfile = (n) => n === 'Default' || /^Profile \d+$/.test(n);
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || !isProfile(e.name)) continue;
    const dir = path.join(root, e.name);
    let email = '';
    try {
      const prefs = JSON.parse(fs.readFileSync(path.join(dir, 'Preferences'), 'utf8'));
      const ai = Array.isArray(prefs.account_info) ? prefs.account_info : [];
      email = (ai[0] && (ai[0].email || ai[0].full_name)) || (prefs.profile && prefs.profile.name) || '';
    } catch { /* a profile with no readable Preferences still lists, just unlabelled */ }
    out.push({ dir, name: e.name, email: String(email || '').trim(), hasCookies: fs.existsSync(path.join(dir, 'Cookies')) });
  }
  // Default first, then Profile 1, 2, ... in numeric order.
  return out.sort((a, b) => (a.name === 'Default' ? -1 : b.name === 'Default' ? 1 : a.name.localeCompare(b.name, 'en', { numeric: true })));
}

/**
 * Seed this client's pendpost browser profile from a source Chrome profile the owner named.
 * Cookies is copied with sqlite3 VACUUM INTO (a consistent snapshot off the live, running Chrome);
 * the dir stores are copied recursively. Writes ONLY under browserProfileDir(clientId)/Default,
 * never logs a cookie value, never touches config or state.
 *
 * @param {object} opts
 * @param {string} opts.clientId
 * @param {string} opts.sourceProfileDir - an absolute dir returned by discoverChromeProfiles
 * @param {string[]} [opts.stores] - store names from SESSION_STORES; defaults to the `default:true` set
 * @returns {{ ok:boolean, dest:string, copied:string[], skipped:string[], message?:string }}
 */
export function seedProfileFromChrome({ clientId = activeClientId(), sourceProfileDir, stores } = {}) {
  const src = String(sourceProfileDir || '').trim();
  if (!src || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    return { ok: false, dest: '', copied: [], skipped: [], message: `source Chrome profile not found: ${src || '(none)'}` };
  }
  // The destination is pendpost's own, slug-guarded profile. A clientId carrying `..` cannot make
  // this resolve outside the pendpost browser root - the one directory this feature must own.
  const dest = browserProfileDir(clientId);
  fs.mkdirSync(BROWSER_PROFILE_ROOT, { recursive: true });
  const rootReal = fs.realpathSync(BROWSER_PROFILE_ROOT);
  const destParentReal = fs.realpathSync(path.dirname(dest));
  if (destParentReal !== rootReal) {
    return { ok: false, dest, copied: [], skipped: [], message: 'refusing to seed a profile outside the pendpost browser root' };
  }
  // Never seed a profile a live browser has open: Chrome's SingletonLock means a batch or a manual
  // window is using this exact dir, and overwriting under it corrupts both sides. The lock is a
  // DANGLING symlink (target is host-pid), so existsSync (which follows the link) is always false -
  // lstat is the only probe that sees it.
  let profileOpen = false;
  try { fs.lstatSync(path.join(dest, 'SingletonLock')); profileOpen = true; } catch { /* no lock: free to seed */ }
  if (profileOpen) {
    return { ok: false, dest, copied: [], skipped: [], message: 'this project\'s browser profile is open right now (a batch or a window). Close it, then run connect again.' };
  }
  const inner = path.join(dest, 'Default');
  fs.mkdirSync(inner, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(inner, 0o700); } catch { /* best-effort on an existing dir */ }

  const wanted = Array.isArray(stores) && stores.length
    ? SESSION_STORES.filter((s) => stores.includes(s.name))
    : SESSION_STORES.filter((s) => s.default);

  // A copied session store is as sensitive as the owner's own; keep it owner-only, not the 0644
  // sqlite3/cpSync default. Recursive for the dir stores. Best-effort: a store that cannot be
  // chmod'd is still functional.
  const lockDown = (p) => {
    try {
      const st = fs.statSync(p);
      fs.chmodSync(p, st.isDirectory() ? 0o700 : 0o600);
      if (st.isDirectory()) for (const e of fs.readdirSync(p)) lockDown(path.join(p, e));
    } catch { /* best-effort */ }
  };
  // A file: URI source: ? # % in the path must be percent-encoded; the destination's single
  // quotes are SQL-escaped for VACUUM INTO.
  const toFileUri = (p) => `file:${p.replace(/%/g, '%25').replace(/\?/g, '%3f').replace(/#/g, '%23')}?mode=ro&immutable=1`;

  const copied = [];
  const skipped = [];
  for (const store of wanted) {
    const from = path.join(src, store.rel);
    const to = path.join(inner, store.rel);
    if (!fs.existsSync(from)) { skipped.push(store.name); continue; }
    if (store.kind === 'sqlite') {
      const sqlite = resolveSqliteBin();
      if (!sqlite) return { ok: false, dest, copied, skipped, message: 'sqlite3 was not found; install it or set PENDPOST_SQLITE_BIN' };
      try { fs.rmSync(to, { force: true }); } catch { /* a stale copy is overwritten */ }
      // immutable read: a consistent snapshot of the main DB without contending for the lock the
      // owner's running Chrome holds. VACUUM INTO writes ONLY the destination file.
      execFileSync(sqlite, [toFileUri(from), '.timeout 5000', `VACUUM INTO '${to.replace(/'/g, "''")}'`], { stdio: ['ignore', 'ignore', 'pipe'] });
      lockDown(to);
      copied.push(store.name);
    } else {
      try { fs.rmSync(to, { recursive: true, force: true }); } catch { /* overwrite */ }
      fs.cpSync(from, to, { recursive: true });
      lockDown(to);
      copied.push(store.name);
    }
  }
  return { ok: copied.length > 0, dest, copied, skipped, message: copied.length ? undefined : 'nothing was copied; the source profile has none of the session stores' };
}

// ---------------------------------------------------------------------------
// The report fence (§9) - armed around exactly one spawn
// ---------------------------------------------------------------------------

// FAIL-CLOSED, like the follow-up fence and for the same reason: a batch result is a claim
// about what happened in a browser pendpost itself drove, and nothing but a spawned engage
// child ever has one. Outside an armed batch the results branch of radar_engage_report is
// inert; inside one it accepts exactly the actionIds this batch was handed.
let engageFence = null; // { runId, lane, clientId, actionIds:Set, texts:Map, dryRun, probe, report }

export function beginEngageFence({ runId, lane, clientId, rows = [], dryRun = false, probe = false }) {
  engageFence = {
    runId,
    lane,
    clientId: String(clientId),
    dryRun: dryRun === true,
    probe: probe === true,
    actionIds: new Set(rows.map((r) => r && r.id).filter(Boolean)),
    texts: new Map(rows.filter(Boolean).map((r) => [r.id, (r.payload && r.payload.text) || ''])),
    report: null,
  };
  return engageFence;
}

export function endEngageFence() { const f = engageFence; engageFence = null; return f; }
export const engageFenceArmed = () => engageFence !== null;
export const engageActionAllowed = (actionId) => engageFence !== null && engageFence.actionIds.has(actionId);

// ---------------------------------------------------------------------------
// The payload fence (§9, risk 4)
// ---------------------------------------------------------------------------

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// The engine handed the child a text. The child reports what it actually posted. Anything
// beyond the disclosure line and a trim at a sentence boundary is drift - a page that talked
// the child into posting different words - and drift fails the row and cools the lane down.
//
// Deliberately tolerant in exactly two directions and no others:
//   1. the disclosure line may be appended (D12, §7.6);
//   2. the text may be SHORTER, as a prefix, for a platform length cap (X 280).
// It is never tolerant of added words, reordered words, or a different text of similar length.
export function payloadMatches(sent, posted, disclosureLine = '') {
  const s = norm(sent);
  if (!s) return true; // a like/follow carries no text - there is nothing to fence
  let p = norm(posted);
  if (!p) return false;
  const d = norm(disclosureLine);
  if (d && p.endsWith(d)) p = norm(p.slice(0, p.length - d.length));
  if (p === s) return true;
  // A trim: a prefix, and long enough that "posted three words of it" cannot pass as one.
  const floor = Math.min(s.length, Math.max(40, Math.floor(s.length * 0.5)));
  return s.startsWith(p) && p.length >= floor;
}

// ---------------------------------------------------------------------------
// The transcript audit (§9, row 7e2)
// ---------------------------------------------------------------------------

// Our OWN marker, written by the report handler at the moment an auth_wall report arrives -
// while the child is still alive. The child cannot forge it (it never calls it) and it cannot
// avoid it (reporting the auth wall is what stops the batch), so its position in the file is
// real ordering evidence about what the child did AFTER it said it had hit a login wall.
export const AUTH_WALL_MARK = 'pendpost__auth_wall';

const shortToolName = (n) => String(n || '').split('__').pop();

/**
 * Read one child's transcript back and judge it.
 * @returns {{ ok:boolean, calls:number, typing:number, typedAfterAuthWall:number, authWallAt:number|null, observed:boolean }}
 * `observed:false` means no transcript file existed - "we did not look", never "nothing
 * happened", and every caller says so rather than treating it as a pass with evidence.
 */
export function auditTranscript(runId) {
  const rows = readTranscript(runId);
  const authWallAt = rows.findIndex((r) => r && r.name === AUTH_WALL_MARK);
  const isTyping = (r) => BROWSER_TYPING_TOOLS.includes(shortToolName(r && r.name));
  const typing = rows.filter(isTyping).length;
  const typedAfterAuthWall = authWallAt === -1 ? 0 : rows.slice(authWallAt + 1).filter(isTyping).length;
  return {
    ok: typedAfterAuthWall === 0,
    calls: rows.length,
    typing,
    typedAfterAuthWall,
    authWallAt: authWallAt === -1 ? null : authWallAt,
    observed: rows.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Ingesting a child's report (the `results` branch of radar_engage_report)
// ---------------------------------------------------------------------------

const RESULT_CODES = Object.freeze(['ok', 'auth_wall', 'wrong_account', 'community_rule', 'exec_failed', 'target_gone']);

function laneCommunityKey(lane, community) { return `${lane} ${String(community || '').trim()}`; }

const COMMUNITY_RULES = Object.freeze(['none', 'disclose', 'noAutomation']);

export function communityRuleFor(lane, community) {
  const state = engageState();
  const entry = state.engage.communities[laneCommunityKey(lane, community)];
  return entry && typeof entry === 'object' ? entry : null;
}

export function cacheCommunityRule(lane, community, rule, { source = 'browser', now = Date.now() } = {}) {
  if (!COMMUNITY_RULES.includes(rule)) return null;
  const name = String(community || '').trim();
  if (!name) return null;
  const state = engageState();
  const entry = { community: name, lane, rule, checkedAt: new Date(now).toISOString(), source };
  state.engage.communities[laneCommunityKey(lane, name)] = entry;
  saveState();
  return entry;
}

/**
 * The child's batch report, applied by the ENGINE (spec 50 §7.6 / §9).
 *
 * Everything here is a re-decision, never a hand-over: the child says what it saw, and this
 * decides what the row becomes. A row the child claims `ok` for still fails when its
 * postedText drifted from what we handed over; a lane the child says is fine still goes
 * unusable when the batch code says auth_wall.
 *
 * @param {object} report - { batchId, lane, code?, handleSeen?, community?, results?[] }
 * @returns {{ ok:boolean, code?:string, applied:number, refused:number, results:object[] }}
 */
export function applyEngageResults(report = {}, { now = Date.now } = {}) {
  if (!engageFence) {
    return { ok: false, code: 'not_armed', message: 'no "Respond for me" browser batch is running, so there is nothing to report results for', applied: 0, refused: 0, results: [] };
  }
  const fence = engageFence;
  const lane = fence.lane;
  const policy = enginePolicy();
  const disclosure = disclosureLineFor(policy);
  const batchCode = RESULT_CODES.includes(report.code) ? report.code : 'ok';

  // Record the child's own claim so the batch runner can settle rows the child never mentioned.
  fence.report = { ...report, code: batchCode };

  // ---- batch-level stops. These are LANE facts, not row facts, so they are applied here and
  // the rows are settled by runBrowserBatch once the child has exited.
  if (batchCode === 'auth_wall') {
    // Our own ordering witness, written while the child is still running (see AUTH_WALL_MARK).
    appendTranscript(fence.runId, { name: AUTH_WALL_MARK, target: lane });
    setLaneRuntime(lane, { usable: false, reason: 'not_logged_in', lastProbeAt: new Date(now()).toISOString() });
  } else if (batchCode === 'wrong_account') {
    const seen = String(report.handleSeen || '').trim().replace(/^@/, '');
    setLaneRuntime(lane, { usable: false, reason: 'wrong_account', handleSeen: seen, lastProbeAt: new Date(now()).toISOString() });
  }

  // ---- the identity probe's own answer.
  if (fence.probe) {
    const seen = String(report.handleSeen || '').trim().replace(/^@/, '');
    applyProbeVerdict(lane, { handleSeen: seen, code: batchCode }, { now });
    return { ok: true, probe: true, lane, handleSeen: seen, code: batchCode, applied: 0, refused: 0, results: [] };
  }

  // ---- the community rule the child read once (D12, rows 7e5 / 7e6).
  if (report.community && typeof report.community === 'object' && COMMUNITY_RULES.includes(report.community.rule)) {
    cacheCommunityRule(lane, report.community.name || report.community.community, report.community.rule, { now: now() });
  }

  const rows = Array.isArray(report.results) ? report.results : [];
  const out = [];
  let applied = 0;
  const todayKey = engageDateKey(now(), 'UTC');
  for (const raw of rows) {
    const actionId = raw && typeof raw.actionId === 'string' ? raw.actionId.trim() : '';
    if (!actionId || !fence.actionIds.has(actionId)) {
      out.push({ actionId, ok: false, code: 'target_fenced' });
      continue;
    }
    const row = findActionRow(engageState(), actionId);
    if (!row) { out.push({ actionId, ok: false, code: 'not_found' }); continue; }

    // Dry run (D19): the row is only "would have replied" when the child actually reached the
    // post control. composerFound:false is an honest "could not reach the post box", not a pass.
    if (fence.dryRun) {
      const composerFound = raw.composerFound === true;
      markDryRun(actionId, { wouldPost: composerFound, composerFound, via: 'browser' });
      applied += 1;
      out.push({ actionId, ok: true, status: 'dry_run', composerFound });
      continue;
    }

    if (raw.ok !== true) {
      markFailed(actionId, { code: RESULT_CODES.includes(raw.code) ? raw.code : 'exec_failed', message: String(raw.error || '').slice(0, 300) });
      out.push({ actionId, ok: false, code: raw.code || 'exec_failed' });
      continue;
    }

    // THE PAYLOAD FENCE (§9, risk 4). The engine handed the text over; the child reports what
    // it posted. Drift beyond the disclosure line and a trim is a page that changed our words,
    // and it fails the row rather than being written down as a success.
    const sent = fence.texts.get(actionId) || '';
    if (sent && !payloadMatches(sent, raw.postedText, disclosure)) {
      markFailed(actionId, { code: 'payload_mismatch', message: 'the text reported as posted is not the text pendpost handed over' });
      coolLaneDown(lane, 'repeated_failure', { now: now() });
      out.push({ actionId, ok: false, code: 'payload_mismatch' });
      continue;
    }

    const permalink = typeof raw.permalink === 'string' && /^https?:\/\//.test(raw.permalink.trim()) ? raw.permalink.trim() : null;
    markDone(actionId, {
      permalink,
      via: 'browser',
      postedText: typeof raw.postedText === 'string' ? raw.postedText.slice(0, 2000) : null,
      trimmed: raw.trimmed === true,
      screenshot: typeof raw.screenshot === 'string' ? raw.screenshot.slice(0, 300) : null,
    });
    try { incrementCounter(row.lane, row.kind, todayKey); } catch { /* counters are accounting, never a reason to lose a result */ }
    // Evidence (§7.6): the signal itself must say the brand answered, with the permalink, so
    // radar_list and the feed are truthful without a join to the action list. Written through
    // the EXISTING signal-level writer (lib/writes.mjs markCopyPosted, the copyPosted ledger),
    // which is the one evidence path a lane with no plan post has.
    if (row.kind === 'reply' && permalink) writeBrowserReplyEvidence(row, permalink);
    applied += 1;
    out.push({ actionId, ok: true, status: 'done', permalink });
  }
  return { ok: true, lane, code: batchCode, applied, refused: out.length - applied, results: out };
}

// The disclosure line for this client, with {brand} resolved (D12 / §7.1).
export function disclosureLineFor(policy = enginePolicy(), posting = getPosting()) {
  const d = policy.disclosure || {};
  if (d.respectCommunityRules === false) return '';
  const brand = ((posting || {}).radar || {}).brand;
  const name = (brand && (brand.name || brand.brand)) || (posting || {}).brandName || activeClientId();
  return String(d.line || '').replace(/\{brand\}/g, String(name || '').trim());
}

// The signal-level evidence for a browser reply. Fire and forget by design: the row is already
// `done` with its permalink, and a state writer that threw must not un-post a real reply.
function writeBrowserReplyEvidence(row, permalink) {
  const [source, externalId] = String(row.signalKey || '').split(' ');
  if (!source || !externalId) return;
  import('./writes.mjs')
    .then(({ markCopyPosted }) => markCopyPosted({ source, externalId, postedUrl: permalink, actor: 'policy:auto-engage' }))
    .catch(() => { /* the row's own result keeps the permalink either way */ });
}

/**
 * The reverse of writeBrowserReplyEvidence, for `engage_undo` (§7.9, risk 5 "undo lies").
 *
 * An API-route reply's evidence is DERIVED from its plan post, so deleting the post clears it.
 * A browser reply has no plan post: its only evidence is the copyPosted ledger entry written
 * above, and listRadar joins `replied` off exactly that. So an undone browser reply whose
 * ledger entry survived would leave the feed claiming the thread was answered by a reply that
 * is no longer there - the same class of lie the spec calls out for DMs.
 *
 * Removes ONLY the entry this action wrote: matched by signalKey AND by the permalink the row
 * recorded, so a copy the OWNER hand-posted to the same thread (the L4 handoff path) is never
 * swept away by an undo of pendpost's own reply. Pure over the store; saves once.
 *
 * @returns {boolean} whether an entry was removed
 */
export function clearBrowserReplyEvidence(row) {
  if (!row || row.kind !== 'reply') return false;
  const permalink = (row.result && row.result.permalink) || null;
  if (!permalink) return false;
  const [source, externalId] = String(row.signalKey || '').split(' ');
  if (!source || !externalId) return false;
  const state = engageState();
  const ledger = Array.isArray(state.radar && state.radar.copyPosted) ? state.radar.copyPosted : [];
  const before = ledger.length;
  state.radar.copyPosted = ledger.filter((e) => !(
    e && String(e.source || '') === source && String(e.externalId || '') === externalId && e.postedUrl === permalink
  ));
  if (state.radar.copyPosted.length === before) return false;
  saveState();
  return true;
}

// A lane cool-down (§8's circuit breaker), shared by the payload fence and the transcript audit.
export function coolLaneDown(lane, reason = 'repeated_failure', { hours = 24, now = Date.now() } = {}) {
  return setLaneRuntime(lane, {
    usable: false,
    reason: 'cooling_down',
    pausedUntil: new Date(now + hours * 3600 * 1000).toISOString(),
    pauseReason: reason,
  });
}

// ---------------------------------------------------------------------------
// The identity probe (§7.2 / §7.3, rows 2e / 2e2 / 7e3)
// ---------------------------------------------------------------------------

/**
 * Turn one probe observation into the LaneRuntime the platform row renders (§7.3).
 * Pure decision, one write. The four outcomes are the four the UI already draws:
 *   nothing seen / login form visible -> not_logged_in, with the ceremony command as detail
 *   handle seen, config handle empty  -> confirm_handle (the inline Yes/No, never free text)
 *   handle seen, equal to config      -> ready + usable
 *   handle seen, different            -> wrong_account
 */
export function applyProbeVerdict(lane, { handleSeen = '', code = 'ok' } = {}, { now = Date.now, clientId = activeClientId() } = {}) {
  const at = new Date(typeof now === 'function' ? now() : now).toISOString();
  const seen = String(handleSeen || '').trim().replace(/^@/, '');
  if (code === 'auth_wall' || !seen) {
    const rt = setLaneRuntime(lane, { usable: false, reason: 'not_logged_in', handleSeen: '', lastProbeAt: at });
    return { ...rt, lane, detail: `Run: ${loginCommandFor(lane, clientId)}` };
  }
  const policy = enginePolicy();
  const configured = String(((policy.lanes || {})[lane] || {}).handle || '').trim().replace(/^@/, '');
  if (!configured) {
    const rt = setLaneRuntime(lane, { usable: false, reason: 'confirm_handle', handleSeen: seen, lastProbeAt: at });
    return { ...rt, lane, detail: `Chrome is logged in as @${seen} on ${lane}. Confirm it is this project's account.` };
  }
  if (configured.toLowerCase() === seen.toLowerCase()) {
    const rt = setLaneRuntime(lane, { usable: true, reason: 'ready', handleSeen: seen, lastProbeAt: at });
    return { ...rt, lane, detail: null };
  }
  const rt = setLaneRuntime(lane, { usable: false, reason: 'wrong_account', handleSeen: seen, lastProbeAt: at });
  return { ...rt, lane, detail: `Chrome is logged in as @${seen} on ${lane}, not @${configured}. Switch the account in ${lane} itself, then check again.` };
}

/**
 * Run the identity check for one browser lane. Spawns the read-only `probe` child against this
 * client's profile; the child cannot click, type or press a key at the TOOL layer, so it cannot
 * log anything in even if a page asks it to.
 *
 * @param {object} opts
 * @param {string} opts.lane
 * @param {function} [opts.runner] - TEST SEAM: stands in for runAgentJob. Tests never spawn.
 * @returns {Promise<object>} the LaneRuntime shape plus { ok, detail, handleSeen, code }
 */
export async function probeBrowserLane({ lane, clientId = activeClientId(), runner = runAgentJob, now = Date.now } = {}) {
  const target = BROWSER_IDENTITY[lane];
  if (!target) return { ok: false, code: 'invalid_input', message: `${lane} is not a browser lane`, lane };

  const bridge = checkBrowserBridge({ clientId, now: now(), force: true });
  if (!bridge.ok) {
    const rt = setLaneRuntime(lane, { usable: false, reason: 'not_logged_in', lastProbeAt: new Date(now()).toISOString() });
    return { ...rt, ok: true, lane, code: 'no_bridge', detail: bridge.detail, usable: false };
  }

  const posting = getPosting();
  const policy = enginePolicy(posting);
  const providerId = String(((posting.radar || {}).agent || {}).provider || '');
  if (!providerId) {
    // The lane vocabulary the platform row draws has FOUR states and no "could not check", so a
    // check that could not run reports the same unusable state a failed one does. That is not a
    // fudge: `not_logged_in` here means "this profile is not armed for this platform", which is
    // exactly true when nothing can be sent to look. What differs is the DETAIL, and the detail
    // names the real blocker rather than sending the owner to a login ceremony that would not
    // help. The one thing that must never happen is a green Ready no check earned.
    const rt = setLaneRuntime(lane, { usable: false, reason: 'not_logged_in', lastProbeAt: new Date(now()).toISOString() });
    return { ...rt, ok: true, lane, code: 'no_provider', detail: 'No agent provider is set for this project, so nothing can open a browser to check. Set posting.radar.agent.provider first.', usable: false };
  }

  const { radarEngageProbePrompt } = await import('./radar-prompt.mjs');
  const runId = randomUUID();
  const prompt = radarEngageProbePrompt({ lane, target, clientId });
  beginEngageFence({ runId, lane, clientId, rows: [], probe: true });
  let run = null;
  let probeFence = null;
  try {
    run = await runner({
      providerId,
      prompt,
      allowedTools: [...AGENT_ENGAGE_PROBE_TOOLS],
      model: policy.model || null,
      timeoutMs: ENGAGE_PROBE_TIMEOUT_MS,
      mcpServers: browserMcpServers({ clientId }),
      transcriptRunId: runId,
    });
  } catch (err) {
    run = { ok: false, detail: err?.message || String(err) };
  } finally {
    probeFence = endEngageFence();
  }
  // The report tool is the witness; the child's closing words are the fallback for a run whose
  // MCP call never landed. Same code path either way (see applyFallbackReport).
  if (probeFence && !probeFence.report) applyFallbackReport(probeFence, run, lane, now);

  // "NOTHING LANDED" IS READ OFF THE FENCE, NOT OFF THE LANE. The fence's own `report` slot is
  // filled by this run and by nothing else, so an empty one means this child reported nothing -
  // whether the lane happened to be `checking` beforehand or was left `ready` by yesterday's
  // successful check. Reading the lane instead would let a stale green state survive a check
  // that never ran, which is the single worst outcome this whole verb exists to prevent.
  if (!probeFence || !probeFence.report) {
    const verdict = applyProbeVerdict(lane, { handleSeen: '', code: 'auth_wall' }, { now, clientId });
    return { ...verdict, ok: true, lane, code: 'no_report', detail: (run && (run.detail || run.tail)) || verdict.detail, runId };
  }

  // The verdict applyEngageResults already applied, re-read from the lane, plus the SENTENCE
  // applyProbeVerdict minted for it. The sentence is the whole difference between a state and
  // an instruction, so it is carried through rather than recomputed for one of the four cases.
  const seen = String(probeFence.report.handleSeen || '').trim().replace(/^@/, '');
  const verdict = applyProbeVerdict(lane, { handleSeen: seen, code: probeFence.report.code }, { now, clientId });
  return { ...verdict, ok: true, lane, runId, code: verdict.reason };
}

// EVERY place the child's own words can be, in the order they are most likely to carry the
// report. MEASURED 2026-09-09 (§5.2): `run.detail` is only the FIRST LINE of the child's final
// message (lib/agent-runner.mjs normalizes it that way, so a job row shows one line), and the
// report block is at the END of that message. So a fallback that read `detail` alone found a
// sentence, judged it unparseable, and reported `no_report` for a run that had in fact answered
// - the exact failure a real probe hit. `tail` is the LAST chars of the same message, which is
// where a closing json block actually lives.
const childWords = (run) => (run ? [run.tail, run.detail, run.stdout] : []).filter((x) => typeof x === 'string' && x);

// The child's final words, when they carry a JSON object. A fenced ```json block wins; a bare
// trailing object is accepted too. Never executed, never trusted for anything the engine does
// not re-check - it is the same report the tool carries, arriving by a second road.
export function parseChildReport(text) {
  const s = String(text || '');
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
  const candidates = [];
  let m;
  while ((m = fenced.exec(s)) !== null) candidates.push(m[1]);
  const last = s.lastIndexOf('{');
  if (last !== -1) candidates.push(s.slice(last));
  for (const c of candidates.reverse()) {
    try {
      const o = JSON.parse(c);
      if (o && typeof o === 'object' && !Array.isArray(o) && (o.code || o.results || o.handleSeen !== undefined)) return o;
    } catch { /* not this one */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// One batch, one child (§7.5 step 8, §7.6)
// ---------------------------------------------------------------------------

/**
 * Execute one lane's browser batch.
 *
 * @param {object} opts
 * @param {string} opts.lane
 * @param {string[]} opts.rowIds - at most 8, one lane, from the pacer's browserBatches
 * @param {boolean} [opts.dryRun] - D19: drive Chrome to the post control, then stop
 * @param {function} [opts.runner] - TEST SEAM for runAgentJob
 * @returns {Promise<object>} { ok, ran, lane, runId?, code?, applied?, skipped?, reason? }
 */
export async function runBrowserBatch({ lane, rowIds = [], dryRun = false, clientId = activeClientId(), runner = runAgentJob, now = Date.now } = {}) {
  if (!BROWSER_IDENTITY[lane]) return { ok: false, ran: false, lane, reason: 'not_a_browser_lane' };
  const ids = [...new Set((Array.isArray(rowIds) ? rowIds : []).filter((x) => typeof x === 'string' && x))].slice(0, 8);
  if (!ids.length) return { ok: true, ran: false, lane, reason: 'nothing_due' };

  const posting = getPosting();
  const policy = enginePolicy(posting);
  const providerId = String(((posting.radar || {}).agent || {}).provider || '');
  if (!providerId) return { ok: true, ran: false, lane, reason: 'no_provider' };

  const bridge = checkBrowserBridge({ clientId, now: now() });
  if (!bridge.ok) return { ok: true, ran: false, lane, reason: 'no_bridge', detail: bridge.detail };

  // ---- rows, and the community gate BEFORE the spawn (row 7e5: "a second signal from the
  // same community is skipped without opening Chrome"). A cached noAutomation rule is the one
  // case where the cheapest correct answer is to not start a browser at all.
  const state = engageState();
  const rows = [];
  const skipped = [];
  for (const id of ids) {
    const row = findActionRow(state, id);
    if (!row || row.lane !== lane) continue;
    const community = communityOf(row, state);
    const cached = community ? communityRuleFor(lane, community) : null;
    if (cached && cached.rule === 'noAutomation') {
      row.status = 'skipped';
      row.waitingOn = null;
      row.result = { code: 'community_rule', community };
      skipped.push(id);
      continue;
    }
    rows.push(row);
  }
  if (skipped.length) saveState();
  if (!rows.length) return { ok: true, ran: false, lane, reason: 'all_skipped', skipped: skipped.length };

  // ---- the rows are now with an executor.
  for (const r of rows) markReleasing(r.id);

  const runId = randomUUID();
  const expectedHandle = String(((policy.lanes || {})[lane] || {}).handle || '').trim().replace(/^@/, '');
  const disclosureLine = disclosureLineFor(policy, posting);
  const { radarEngagePrompt } = await import('./radar-prompt.mjs');
  const prompt = radarEngagePrompt({
    clientId,
    lane,
    expectedHandle,
    identity: BROWSER_IDENTITY[lane],
    rows: rows.map((r) => ({
      actionId: r.id,
      kind: r.kind,
      url: signalUrlFor(r, state),
      community: communityOf(r, state),
      text: (r.payload && r.payload.text) || '',
    })),
    communities: knownCommunities(lane, state),
    dryRun: dryRun === true,
    disclosureLine,
    noteLocale: posting.locale || null,
  });

  beginEngageFence({ runId, lane, clientId, rows, dryRun });
  let run = null;
  let fence = null;
  try {
    run = await runner({
      providerId,
      prompt,
      allowedTools: [...AGENT_ENGAGE_TOOLS],
      model: policy.model || null,
      timeoutMs: ENGAGE_BATCH_TIMEOUT_MS,
      mcpServers: browserMcpServers({ clientId }),
      transcriptRunId: runId,
    });
  } catch (err) {
    run = { ok: false, detail: err?.message || String(err) };
  } finally {
    fence = endEngageFence();
  }
  // The report tool is the WITNESS; the child's closing words are the fallback road for a run
  // whose MCP call never landed (a denied tool, a daemon that was not listening). Same code
  // path either way: the fallback re-enters applyEngageResults through the same fence.
  if (fence && !fence.report) applyFallbackReport(fence, run, lane, now);
  return settleBatch({ lane, rows, runId, fence, run, dryRun, clientId, now });
}

// Re-arm the fence for exactly the length of one fallback ingest, then put it back down.
function applyFallbackReport(fence, run, lane, now) {
  let parsed = null;
  for (const words of childWords(run)) {
    parsed = parseChildReport(words);
    if (parsed) break;
  }
  if (!parsed) return;
  engageFence = fence;
  try { applyEngageResults({ ...parsed, lane }, { now }); } finally { engageFence = null; }
}

// Everything the report did not settle, settled by the engine (§7.6 + §9). Runs in the finally
// of the spawn, so a child that died mid-batch still leaves every row in a state the owner can
// read - never a queue of rows silently stuck at `releasing`.
function settleBatch({ lane, rows, runId, fence, run, dryRun, clientId, now }) {
  const code = (fence && fence.report && fence.report.code) || (run && run.ok ? 'no_report' : 'child_failed');
  const audit = auditTranscript(runId);

  // THE TRANSCRIPT AUDIT (§9, row 7e2). A child that typed AFTER telling us it had hit a login
  // wall did the one thing the whole credential story forbids. The batch fails and the lane
  // cools down - the child's own account of the batch is not consulted.
  if (!audit.ok) {
    for (const r of rows) {
      const cur = findActionRow(engageState(), r.id);
      if (cur && cur.status === 'releasing') markFailed(r.id, { code: 'exec_failed', message: 'the browser child typed after reporting a login wall - the batch was failed and the platform cooled down' });
    }
    coolLaneDown(lane, 'repeated_failure', { now: now() });
    logLine('warn', `engage batch ${runId} on ${lane}: transcript audit failed (${audit.typedAfterAuthWall} typing calls after auth_wall) - lane cooled down`);
    return { ok: false, ran: true, lane, runId, code: 'transcript_audit', audit, applied: 0 };
  }

  let requeued = 0;
  let failed = 0;
  for (const r of rows) {
    const cur = findActionRow(engageState(), r.id);
    if (!cur || cur.status !== 'releasing') continue;
    if (code === 'auth_wall') {
      // Row 7e2: the platform is unusable, the rows go BACK to the queue waiting on the lane.
      // Nothing is failed - there was nothing wrong with the row, only with the login.
      cur.status = 'queued';
      cur.waitingOn = 'lane';
      requeued += 1;
    } else if (code === 'wrong_account') {
      cur.status = 'queued';
      cur.waitingOn = 'lane';
      requeued += 1;
    } else {
      markFailed(r.id, { code: 'exec_failed', message: (run && (run.detail || run.tail)) || 'the browser child did not report a result for this action' });
      failed += 1;
    }
  }
  if (requeued) saveState();

  const applied = rows.length - requeued - failed;
  logLine('info', `engage batch ${runId} on ${lane}${dryRun ? ' (dry run)' : ''}: ${applied} settled by the child, ${requeued} requeued, ${failed} failed (${code})`);
  return { ok: code === 'ok' || code === 'community_rule', ran: true, lane, runId, code, applied, requeued, failed, audit, clientId };
}

// The signal a row targets, and its url / community. Read from the cached signal, because a row
// only carries the signalKey - the fences and the feed build the same key the same way.
function signalFor(row, state) {
  const key = String(row.signalKey || '');
  return (state.radar?.signals || []).find((s) => s && `${s.source} ${s.externalId}` === key) || null;
}
function signalUrlFor(row, state) { const s = signalFor(row, state); return (s && s.url) || null; }
function communityOf(row, state) { const s = signalFor(row, state); return (s && s.community) || null; }

// What we already know about this lane's communities, so the child reads a sidebar ONCE.
function knownCommunities(lane, state) {
  const out = {};
  for (const [key, entry] of Object.entries(state.engage.communities || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (!key.startsWith(`${lane} `)) continue;
    out[key.slice(lane.length + 1)] = entry.rule;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Undo for browser kinds (§7.9) - P3's engage_undo calls this
// ---------------------------------------------------------------------------

// What "take it back" means per kind, in the words the child is given.
const REVERSE_INSTRUCTION = Object.freeze({
  reply: 'Open the permalink, find the reply posted by this account, open its own menu and DELETE it. Confirm the deletion if the platform asks.',
  like: 'Open the permalink and click the like control again so it is no longer liked.',
  upvote: 'Open the permalink and click the upvote control again so the vote is removed.',
  follow: 'Open the author\'s profile and use the Following control to UNFOLLOW them.',
  repost: 'Open the permalink and undo the repost (un-retweet / delete the boost).',
  dm: 'Open the conversation and delete the message for everyone, if and only if the platform offers that. If it only offers "delete for me", do nothing and report cannot_recall.',
  post: 'Open the permalink and delete the post.',
});

export const canBrowserReverse = (kind) => Object.prototype.hasOwnProperty.call(REVERSE_INSTRUCTION, kind);

/**
 * The reverse of one executed browser action (spec 50 §7.9). A one-row batch with a reverse
 * instruction, so it inherits every fence the forward path has: the same profile, the same
 * identity check, the same read-only-first inspection, the same transcript.
 *
 * P3 owns `engage_undo` and calls this. SIGNATURE, so it can be called cold:
 *   browserReverse(row, { runner?, clientId?, now? })
 *     row     the DONE action row (id, lane, kind, result.permalink) from state.engage.queue
 *     returns { ok, code, message?, lane, kind, runId? }
 *             code: 'undone' | 'cannot_recall' | 'not_reversible' | 'no_permalink' |
 *                   'no_bridge' | 'no_provider' | 'exec_failed'
 * It NEVER marks the original row - the caller owns the row's `undone` status and its inline
 * confirm (row 11), because the confirm is the owner's decision and this is only the hands.
 */
export async function browserReverse(row, { runner = runAgentJob, clientId = activeClientId(), now = Date.now } = {}) {
  if (!row || typeof row !== 'object') return { ok: false, code: 'invalid_input', message: 'no action row' };
  const lane = String(row.lane || '');
  const kind = String(row.kind || '');
  if (!BROWSER_IDENTITY[lane]) return { ok: false, code: 'not_reversible', message: `${lane} is not a browser lane`, lane, kind };
  if (!canBrowserReverse(kind)) return { ok: false, code: 'not_reversible', message: `there is no reverse for a ${kind} on ${lane}`, lane, kind };
  const permalink = (row.result && row.result.permalink) || null;
  if (!permalink) return { ok: false, code: 'no_permalink', message: 'this action has no permalink, so there is nothing to open and undo', lane, kind };

  const posting = getPosting();
  const policy = enginePolicy(posting);
  const providerId = String(((posting.radar || {}).agent || {}).provider || '');
  if (!providerId) return { ok: false, code: 'no_provider', message: 'no agent provider is set for this project', lane, kind };
  const bridge = checkBrowserBridge({ clientId, now: now() });
  if (!bridge.ok) return { ok: false, code: 'no_bridge', message: bridge.detail, lane, kind };

  const runId = randomUUID();
  const { radarEngageUndoPrompt } = await import('./radar-prompt.mjs');
  const prompt = radarEngageUndoPrompt({
    clientId,
    lane,
    kind,
    permalink,
    expectedHandle: String(((policy.lanes || {})[lane] || {}).handle || '').trim().replace(/^@/, ''),
    identity: BROWSER_IDENTITY[lane],
    instruction: REVERSE_INSTRUCTION[kind],
    actionId: row.id,
  });

  beginEngageFence({ runId, lane, clientId, rows: [], probe: false });
  let run;
  try {
    run = await runner({
      providerId,
      prompt,
      allowedTools: [...AGENT_ENGAGE_TOOLS],
      model: policy.model || null,
      timeoutMs: ENGAGE_PROBE_TIMEOUT_MS,
      mcpServers: browserMcpServers({ clientId }),
      transcriptRunId: runId,
    });
  } finally {
    endEngageFence();
  }

  let parsed = null;
  for (const words of childWords(run)) {
    parsed = parseChildReport(words);
    if (parsed) break;
  }
  parsed = parsed || {};
  const first = Array.isArray(parsed.results) ? parsed.results[0] : null;
  if (parsed.code === 'cannot_recall' || (first && first.code === 'cannot_recall')) {
    return { ok: false, code: 'cannot_recall', message: `${kind} cannot be recalled on ${lane}`, lane, kind, runId };
  }
  if (run && run.ok === true && (parsed.code === 'ok' || (first && first.ok === true))) {
    return { ok: true, code: 'undone', lane, kind, runId };
  }
  return { ok: false, code: 'exec_failed', message: (run && (run.detail || run.tail)) || 'the browser child did not confirm the undo', lane, kind, runId };
}

// ---------------------------------------------------------------------------
// The reconcile helper lib/radar-sweep.mjs calls (§7.6, row "half-done from a previous attempt")
// ---------------------------------------------------------------------------

// A `releasing` browser row older than this lost its child (the daemon restarted, the Mac
// slept, the batch was killed) and is a candidate for the "did it actually post?" reconcile.
export const RELEASING_RECONCILE_MS = 20 * 60_000;

// The rows the reconcile should go and look for. Pure over the store, so lib/radar-sweep.mjs
// can ask without importing the executor's spawn machinery.
export function staleBrowserReplies(now = Date.now()) {
  const state = engageState();
  return (state.engage.queue || []).filter((r) => {
    if (!r || r.status !== 'releasing' || r.kind !== 'reply') return false;
    if (!BROWSER_IDENTITY[r.lane]) return false;
    const since = Date.parse(r.releasedAt || r.releaseAt || '') || 0;
    return since > 0 && (now - since) >= RELEASING_RECONCILE_MS;
  }).map((r) => ({ ...r }));
}

/**
 * A stale browser reply WAS found under the target: mark it done rather than re-post it
 * (§7.6 idempotency, §8 "a rung never re-posts a reply"). Guarded by actionId so a reconcile
 * can only ever settle the row it was asked about, and only while that row is still in flight.
 */
export function reconcileBrowserRow(actionId, { permalink = null, now = Date.now() } = {}) {
  const row = findActionRow(engageState(), actionId);
  if (!row) return { ok: false, code: 'not_found' };
  if (row.status !== 'releasing') return { ok: false, code: 'not_in_flight', status: row.status };
  markDone(actionId, { permalink, via: 'browser', reconciled: true });
  try { incrementCounter(row.lane, row.kind, engageDateKey(now, 'UTC')); } catch { /* accounting only */ }
  if (row.kind === 'reply' && permalink) writeBrowserReplyEvidence(row, permalink);
  return { ok: true, code: 'done', actionId, permalink };
}
