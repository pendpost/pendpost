#!/usr/bin/env node
// test/robots.test.mjs - the served dashboard must be crawlable.
//
// Search Console reported "Blocked by robots.txt". The dashboard shipped NO
// robots.txt, so a request for /robots.txt fell through serveStatic's SPA
// fallback and returned the dashboard HTML instead of a valid rules file.
//
// The fix ships app/public/robots.txt (Vite copies public/* verbatim into
// app/dist/, which the server serves) that allows indexing while keeping the
// operational endpoints (/api, /media, /mcp, /review) out of the index, and
// teaches lib/static.mjs to serve .txt/.xml with the correct content type.
//
// Pure file inspection (app/dist is gitignored, so there is nothing built to
// serve in CI): asserts the shipped rules file and the static MIME wiring.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL - ${name}: ${err.message}`);
  }
}

const ROBOTS_PATH = path.join(REPO_ROOT, 'app', 'public', 'robots.txt');
let robots = '';
check('app/public/robots.txt exists (Vite copies it into app/dist)', () => {
  assert.ok(fs.existsSync(ROBOTS_PATH), 'expected app/public/robots.txt to exist');
  robots = fs.readFileSync(ROBOTS_PATH, 'utf8');
});

// Parse the directive lines once (ignore comments/blanks), lower-cased keys.
const directives = robots
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()];
  });
const disallows = directives.filter(([k]) => k === 'disallow').map(([, v]) => v);

check('declares a wildcard user-agent group', () => {
  assert.ok(
    directives.some(([k, v]) => k === 'user-agent' && v === '*'),
    'expected "User-agent: *"',
  );
});

// The whole point: nothing may blanket-block the site. "Disallow: /" (or an
// empty-path allow-nothing) is exactly the rule that produced the Search
// Console error, so guard against it ever coming back.
check('does NOT blanket-block the site (no "Disallow: /")', () => {
  assert.ok(
    !disallows.includes('/'),
    `a bare "Disallow: /" blocks the entire site; found disallows: ${JSON.stringify(disallows)}`,
  );
});

check('explicitly allows the root so public pages are indexable', () => {
  assert.ok(
    directives.some(([k, v]) => k === 'allow' && v === '/'),
    'expected "Allow: /"',
  );
});

// Operational endpoints (JSON API, media stream, MCP, private review links)
// must stay out of the index - but never at the cost of the public pages above.
check('keeps the operational endpoints out of the index', () => {
  for (const prefix of ['/api', '/media', '/mcp', '/review']) {
    assert.ok(
      disallows.some((d) => d.startsWith(prefix)),
      `expected a Disallow covering ${prefix}`,
    );
  }
});

// serveStatic serves the built dist by file extension; without a .txt MIME
// entry robots.txt would go out as application/octet-stream.
const staticSrc = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'static.mjs'), 'utf8');
check('lib/static.mjs serves .txt as text/plain', () => {
  assert.ok(
    /['"]\.txt['"]\s*:\s*['"]text\/plain/.test(staticSrc),
    'expected a ".txt": "text/plain..." entry in the static MIME map',
  );
});

if (failures) {
  console.error(`[robots] FAIL - ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('[robots] OK - served dashboard is crawlable; operational endpoints stay unindexed.');
process.exit(0);
