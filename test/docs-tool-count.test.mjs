#!/usr/bin/env node
// test/docs-tool-count.test.mjs - US-MCP-02 (A5): tie the docs' tool-count
// claims to the LIVE MCP surface so a stale "31 tools" can never re-ship.
//
// The figure is NOT hardcoded: we import TOOLS from lib/mcp.mjs - the SAME
// source test/parity-check.mjs counts - and derive liveCount from it. Then we
// scan README.md and the two site-docs that quote a tool count, and require
// every `<integer> tools` mention to equal liveCount. We also require the
// canonical doc (site-docs/mcp.mdx) to name `parity-check.mjs` as the
// authoritative self-check, so the number points at a verifier, not a trust.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib
// (util binds WORKSPACE_ROOT at import; mirrors test/account-mode.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// site-docs/ is private and not shipped to the public OSS repo, so this site-only
// doc tool-count guard is N/A there — skip cleanly. It still runs on the site repo.
if (!fs.existsSync(path.join(ROOT, 'site-docs'))) {
  console.log('  skip - site-docs absent (public checkout); doc tool-count guard is site-only');
  process.exit(0);
}

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// Throwaway workspace - set BEFORE importing lib (WORKSPACE_ROOT binds at import).
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-docs-'));
process.env.PENDPOST_ROOT = WS;

try {
  // ---- derive the LIVE tool count (do NOT hardcode) -------------------------
  const { TOOLS } = await import('../lib/mcp.mjs');
  ok(Array.isArray(TOOLS) && TOOLS.length > 0, 'lib/mcp.mjs exports a non-empty TOOLS array');
  const liveCount = TOOLS.length;

  // ---- read the docs that quote a tool count --------------------------------
  const docs = {
    'README.md': fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'),
    'site-docs/mcp.mdx': fs.readFileSync(path.join(ROOT, 'site-docs', 'mcp.mdx'), 'utf8'),
    'site-docs/architecture.mdx': fs.readFileSync(path.join(ROOT, 'site-docs', 'architecture.mdx'), 'utf8'),
  };

  // ---- every `<n> tools` integer must equal the live count ------------------
  let mentions = 0;
  for (const [name, text] of Object.entries(docs)) {
    for (const m of text.matchAll(/(\d+)\s+tools/g)) {
      mentions += 1;
      const n = Number(m[1]);
      ok(n === liveCount, `${name}: "${m[0]}" matches the live MCP tool count (${liveCount})`);
    }
  }
  ok(mentions > 0, `at least one doc states a tool count (found ${mentions}), so the guard has teeth`);

  // ---- the canonical doc points at the parity self-check --------------------
  ok(docs['site-docs/mcp.mdx'].includes('parity-check.mjs'),
    'site-docs/mcp.mdx names parity-check.mjs as the authoritative source for the live count');

  console.log(`[docs-tool-count] OK - ${mentions} doc tool-count mention(s) all equal live ${liveCount}; mcp.mdx cites parity-check.mjs (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
