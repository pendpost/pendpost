#!/usr/bin/env node
// test/agents-md-freshness.test.mjs - AGENTS.md is GENERATED from lib/playbooks.mjs
// (the single per-platform prose source) by scripts/gen-agents.mjs. This guard
// fails `npm run check` if the committed AGENTS.md drifts from the generator -
// e.g. a playbook scope/portal/cli was edited but AGENTS.md was not regenerated.
// Byte-exact compare (mirrors the doc-derivation tests) so any drift is caught.
// Fix on failure: node scripts/gen-agents.mjs --write
//
// Zero-dep: imports render() directly (the generator's entrypoint is guarded so
// importing has no side effect) and reads the committed file off disk.
import assert from 'node:assert';
import fs from 'node:fs';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const { render } = await import('../scripts/gen-agents.mjs');
const expected = render();
const onDisk = fs.readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');

ok(typeof expected === 'string' && expected.length > 0,
  'scripts/gen-agents.mjs render() returns a non-empty string');
ok(onDisk === expected,
  'AGENTS.md matches the generator (stale? run: node scripts/gen-agents.mjs --write)');

// Cold-agent guarantee: every platform's portal + mint command is present, so an
// agent given ONLY AGENTS.md can state the correct next setup step per platform.
for (const portal of [
  'https://developers.facebook.com/apps',
  'https://www.linkedin.com/developers/apps',
  'https://developer.x.com/en/portal/dashboard',
  'https://console.cloud.google.com/apis/credentials',
]) {
  ok(onDisk.includes(portal), `AGENTS.md carries the portal URL ${portal}`);
}
for (const cli of [
  'node scripts/meta-social.mjs setup-system-user',
  'node scripts/linkedin-social.mjs auth',
  'node scripts/x-social.mjs auth',
  'node scripts/yt-social.mjs auth',
]) {
  ok(onDisk.includes(cli), `AGENTS.md carries the mint command "${cli}"`);
}

console.log(`[agents-md-freshness] OK - ${pass} assertions.`);
