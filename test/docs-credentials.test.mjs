#!/usr/bin/env node
// test/docs-credentials.test.mjs - the hand-written credential docs under
// site-docs/credentials/ must exist for ALL four platforms and each must name its
// platform's primary env var, so the prose never silently drops a lane (the 'x' doc
// is the gap this unit closes). We assert existence + the load-bearing env var name
// ONLY - no prose/structural coupling, so the docs stay free to evolve.
//
// Zero-dep node:assert + node:fs (mirrors test/playbooks.test.mjs).
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'site-docs', 'credentials');

// site-docs/ is private and not shipped to the public OSS repo, so this site-only
// docs guard is N/A there — skip cleanly. It still runs in full on the site repo.
if (!existsSync(DOCS_DIR)) {
  console.log('  skip - site-docs/credentials absent (public checkout); credential-docs guard is site-only');
  process.exit(0);
}

// platform -> a primary env var name the doc MUST mention (any one of the alternates).
const PRIMARY_ENV = {
  meta: ['META_SYSTEM_USER_TOKEN', 'META_PAGE_TOKEN'],
  linkedin: ['LINKEDIN_ACCESS_TOKEN'],
  youtube: ['YT_REFRESH_TOKEN'],
  x: ['X_ACCESS_TOKEN_SECRET'],
};

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

for (const [platform, envVars] of Object.entries(PRIMARY_ENV)) {
  check(`${platform}.mdx exists and names its primary env var`, () => {
    const file = join(DOCS_DIR, `${platform}.mdx`);
    assert.ok(existsSync(file), `${platform}.mdx must exist`);
    const body = readFileSync(file, 'utf8');
    assert.ok(
      envVars.some((v) => body.includes(v)),
      `${platform}.mdx must mention one of: ${envVars.join(', ')}`,
    );
  });
}

if (failures) {
  console.error(`[docs-credentials] FAIL - ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('[docs-credentials] OK - all four credential docs exist (incl. x) and name their primary env var.');
process.exit(0);
