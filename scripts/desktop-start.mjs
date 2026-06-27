#!/usr/bin/env node
// scripts/desktop-start.mjs - the entrypoint the desktop apps spawn.
//
// The macOS app and the Windows launcher both run:
//   <bundled node> <bundle>/scripts/desktop-start.mjs
// with PENDPOST_ROOT pointing at a per-user, WRITABLE workspace
// (~/Library/Application Support/pendpost or %APPDATA%\pendpost) and PENDPOST_PORT
// set. The code + built dashboard live in the read-only bundle (REPO_ROOT); all
// state is written under PENDPOST_ROOT (WORKSPACE_ROOT) - see lib/util.mjs.
//
// It does two things, then boots the normal server:
//   1. First run only: seed the empty workspace from the bundled example data, so
//      a fresh install opens to the same try-it-in-mock-mode demo as `npx pendpost`.
//   2. import server.mjs (which calls server.listen at module load).
// Re-runs never clobber the user's workspace.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Seed workspaceRoot/data from bundleRoot/data on first run only. Returns
// { seeded } - true when it copied the example data, false when the workspace
// already had a data/ dir (so the user's own plans/media are never overwritten).
export function seedWorkspace(bundleRoot, workspaceRoot) {
  const dataDest = path.join(workspaceRoot, 'data');
  if (fs.existsSync(dataDest)) return { seeded: false };
  const dataSrc = path.join(bundleRoot, 'data');
  if (!fs.existsSync(dataSrc)) return { seeded: false }; // nothing to seed (defensive)
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.cpSync(dataSrc, dataDest, { recursive: true });
  return { seeded: true };
}

// CLI: seed, then boot the server. Guarded so importing this module (e.g. from a
// test) does NOT start a server.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const bundleRoot = path.resolve(__dirname, '..');
  const workspaceRoot = process.env.PENDPOST_ROOT || bundleRoot;
  try {
    const { seeded } = seedWorkspace(bundleRoot, workspaceRoot);
    if (seeded) console.error(`[pendpost] first run: seeded the example workspace at ${workspaceRoot}`);
  } catch (err) {
    // A seeding failure must not stop the app booting - the server creates what it
    // needs under PENDPOST_ROOT on demand; the user just won't see the demo.
    console.error(`[pendpost] workspace seed skipped: ${err.message}`);
  }
  await import(pathToFileURL(path.join(bundleRoot, 'server.mjs')).href);
}
