#!/usr/bin/env node
// packaging/desktop/build-bundle.mjs - assemble the desktop "runtime bundle".
//
// The macOS .dmg and the Windows installer both ship the SAME bundle: the
// published pendpost file set (server + lib + the built dashboard + the clean
// example data + the shipped contract docs) plus a pinned, checksum-verified Node
// runtime for the target platform. The app is a thin native shell over
// `node runtime/server.mjs` on http://127.0.0.1:8090 - no Tauri, no Node SEA,
// nothing new to maintain (see packaging/desktop/README.md).
//
// SECURITY: the bundle is an ALLOWLIST, exactly like npm's `files`. An over-broad
// entry would ship the owner's per-client .env credentials and private working
// data to every download. test/desktop-bundle.test.mjs stages the real output and
// fails the build on any leak; assertCleanStage() is the same guard inline.
//
// Layout produced under <out>/runtime/:
//   runtime/node            (macOS, universal x64+arm64)  | node.exe (Windows)
//   runtime/server.mjs, lib/, scripts/, bin/, app/dist/, data/{plans,media,captions}/, ...
//
// CLI:
//   node packaging/desktop/build-bundle.mjs --platform mac  --out build/desktop-mac
//   node packaging/desktop/build-bundle.mjs --platform win  --out build/desktop-win
//   node packaging/desktop/build-bundle.mjs --platform mac  --out X --skip-node   (offline stage only)
//
// Cert-free: this script needs NO signing material. Signing/notarization happen in
// .github/workflows/release-desktop.yml after the bundle is assembled.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packaging/desktop/ -> repo root is two levels up.
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

// The pinned Node runtime. A specific patch (not "latest") so the bundle is
// reproducible and the SHASUMS256 verification below is meaningful; bump
// deliberately. Node 20 is the active LTS and matches .nvmrc / the CI matrix.
export const NODE_VERSION = '20.18.1';

const NODE_ASSET = {
  'darwin-x64': { name: `node-v${NODE_VERSION}-darwin-x64.tar.gz`, bin: `node-v${NODE_VERSION}-darwin-x64/bin/node` },
  'darwin-arm64': { name: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, bin: `node-v${NODE_VERSION}-darwin-arm64/bin/node` },
  'win-x64': { name: `node-v${NODE_VERSION}-win-x64.zip`, bin: `node-v${NODE_VERSION}-win-x64/node.exe` },
};

// EXACTLY the npm `files` product entries (kept in lockstep with package.json so a
// reviewer reasons about one shape). Trailing slash = directory, copied
// recursively. Missing entries (e.g. app/dist/ before a build) are skipped, never
// fail - the dashboard build is a separate, explicit step.
export const BUNDLE_ALLOWLIST = [
  'server.mjs',
  'lib/',
  'scripts/',
  'bin/',
  'app/dist/',
  'data/plans/',
  'data/media/',
  'data/captions/',
  'rules.json',
  'config.example.json',
  '.env.example',
  'README.md',
  'LICENSE',
  'DISCLAIMER.md',
  'SECURITY.md',
  'AGENTS.md',
];

// A staged path matching ANY of these is a credential / private-data leak and
// fails the build. .env.example and config.example.json deliberately do NOT match
// (only the raw .env / config.json do). Mirrors the npm supply-chain guard.
export const FORBIDDEN_RX = [
  /(^|\/)\.env$/, // raw credentials (only .env.example ships)
  /(^|\/)config\.json$/, // owner runtime config (config.example.json ships)
  /(^|\/)clients(\/|$)/, // data/clients/<tenant> - per-client credentials + private content
  /(^|\/)sync(\/|$)/, // private forward-port state
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.git(\/|$)/,
];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status ?? r.signal}`);
}

// Recursively copy one repo entry into destDir, preserving its repo-relative path,
// recording every copied FILE in `manifest` (repo-relative, forward slashes).
function copyEntry(absSrc, repoRoot, destDir, manifest) {
  const rel = path.relative(repoRoot, absSrc);
  const destPath = path.join(destDir, rel);
  const st = fs.statSync(absSrc);
  if (st.isDirectory()) {
    fs.mkdirSync(destPath, { recursive: true });
    for (const ent of fs.readdirSync(absSrc).sort()) {
      copyEntry(path.join(absSrc, ent), repoRoot, destDir, manifest);
    }
  } else {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(absSrc, destPath);
    manifest.push(rel.split(path.sep).join('/'));
  }
}

// Copy the BUNDLE_ALLOWLIST product files from repoRoot into destDir. Pure file
// I/O: no Node download, no dashboard build, no network - so the guard test can
// exercise the real copy logic offline. Returns the copied manifest.
export function stageAppFiles(repoRoot, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const manifest = [];
  for (const entry of BUNDLE_ALLOWLIST) {
    const abs = path.join(repoRoot, entry.replace(/\/$/, ''));
    if (!fs.existsSync(abs)) continue; // app/dist/ before a build, etc.
    copyEntry(abs, repoRoot, destDir, manifest);
  }
  return manifest;
}

// Throw if any file under dir matches a forbidden pattern. The inline twin of the
// guard test, callable from the workflow as a belt-and-braces check.
export function assertCleanStage(dir) {
  const offenders = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) { walk(abs); continue; }
      const rel = path.relative(dir, abs).split(path.sep).join('/');
      if (FORBIDDEN_RX.some((rx) => rx.test(rel))) offenders.push(rel);
    }
  };
  walk(dir);
  if (offenders.length) {
    throw new Error(`desktop bundle would leak ${offenders.length} forbidden path(s): ${offenders.slice(0, 10).join(', ')}`);
  }
}

// ---- Node runtime: download, verify checksum, extract -----------------------

async function fetchShasums() {
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SHASUMS256 fetch failed (${res.status}) for Node v${NODE_VERSION}`);
  const map = new Map();
  for (const line of (await res.text()).split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/);
    if (m) map.set(m[2], m[1]);
  }
  return map;
}

async function fetchVerifiedArchive(assetKey, workDir, shasums) {
  const { name } = NODE_ASSET[assetKey];
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${name}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Node download failed (${res.status}) for ${name}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const want = shasums.get(name);
  if (!want) throw new Error(`no SHASUMS256 entry for ${name}`);
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== want) throw new Error(`sha256 mismatch for ${name}\n  got  ${got}\n  want ${want}`);
  const archivePath = path.join(workDir, name);
  fs.writeFileSync(archivePath, buf);
  return archivePath;
}

// Extract just the node binary. macOS/Linux: the system `tar` (bsdtar) reads the
// .tar.gz fine. Windows: the bundle is a .zip, but the `tar` on PATH inside the
// Actions Git-bash shell is GNU tar, which (a) cannot read zip and (b) misparses a
// drive-letter path (`C:\...`) as a remote `host:path` ("Cannot connect to C").
// So on Windows call the system bsdtar (libarchive) explicitly - it handles both
// zip and drive letters.
function extractNodeBinary(assetKey, archivePath, workDir) {
  const { bin } = NODE_ASSET[assetKey];
  const outDir = path.join(workDir, `x-${assetKey}`);
  fs.mkdirSync(outDir, { recursive: true });
  const tarBin = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  run(tarBin, ['-xf', archivePath, '-C', outDir]);
  const binPath = path.join(outDir, ...bin.split('/'));
  if (!fs.existsSync(binPath)) throw new Error(`node binary missing after extract: ${binPath}`);
  return binPath;
}

// Place a verified Node runtime into destDir. macOS gets a UNIVERSAL binary
// (lipo of x64 + arm64) so the one .dmg runs on Intel and Apple Silicon; Windows
// gets node.exe (x64). Returns the path to the placed binary.
export async function downloadNode({ platform, destDir }) {
  fs.mkdirSync(destDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-node-'));
  try {
    const shasums = await fetchShasums();
    if (platform === 'mac') {
      const x64 = extractNodeBinary('darwin-x64', await fetchVerifiedArchive('darwin-x64', work, shasums), work);
      const arm = extractNodeBinary('darwin-arm64', await fetchVerifiedArchive('darwin-arm64', work, shasums), work);
      const out = path.join(destDir, 'node');
      run('lipo', ['-create', x64, arm, '-output', out]); // universal2
      fs.chmodSync(out, 0o755);
      return out;
    }
    if (platform === 'win') {
      const bin = extractNodeBinary('win-x64', await fetchVerifiedArchive('win-x64', work, shasums), work);
      const out = path.join(destDir, 'node.exe');
      fs.copyFileSync(bin, out);
      return out;
    }
    throw new Error(`unsupported platform: ${platform} (expected mac | win)`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// Build the dashboard SPA into app/dist (the bundle ships the BUILT assets, not
// the source). Mirrors the CI build-dashboard job.
function buildDashboard(repoRoot) {
  const appDir = path.join(repoRoot, 'app');
  const shell = process.platform === 'win32';
  run('npm', ['ci'], { cwd: appDir, shell });
  run('npm', ['run', 'build'], { cwd: appDir, shell });
}

// Full assembly: build the dashboard, stage the product files, verify no leak,
// then drop in the pinned Node runtime. Returns { runtimeDir, manifest }.
export async function buildBundle({ platform, repoRoot = REPO_ROOT, out, skipNode = false, skipBuild = false }) {
  if (!out) throw new Error('buildBundle: --out is required');
  if (!skipBuild) buildDashboard(repoRoot);

  const runtimeDir = path.join(out, 'runtime');
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  const manifest = stageAppFiles(repoRoot, runtimeDir);
  assertCleanStage(runtimeDir);

  if (!fs.existsSync(path.join(runtimeDir, 'app', 'dist', 'index.html'))) {
    // Not fatal for a --skip-build stage check, but a real build must ship it.
    console.warn('[build-bundle] warning: app/dist/index.html missing - the dashboard was not built (use without --skip-build for a real bundle).');
  }

  if (!skipNode) {
    const nodeBin = await downloadNode({ platform, destDir: runtimeDir });
    console.log(`[build-bundle] bundled Node v${NODE_VERSION}: ${path.relative(out, nodeBin)}`);
  }

  console.log(`[build-bundle] staged ${manifest.length} product files into ${path.relative(process.cwd(), runtimeDir) || runtimeDir}`);
  return { runtimeDir, manifest };
}

// ---- CLI --------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { skipNode: false, skipBuild: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--platform') opts.platform = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--skip-node') opts.skipNode = true;
    else if (a === '--skip-build') opts.skipBuild = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.platform || !['mac', 'win'].includes(opts.platform)) {
    throw new Error('usage: build-bundle.mjs --platform <mac|win> --out <dir> [--skip-node] [--skip-build]');
  }
  if (!opts.out) opts.out = path.join(REPO_ROOT, 'build', `desktop-${opts.platform}`);
  await buildBundle(opts);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error(`[build-bundle] ${err.message}`); process.exit(1); });
}
