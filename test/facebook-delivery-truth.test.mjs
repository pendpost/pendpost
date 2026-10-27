#!/usr/bin/env node
// test/facebook-delivery-truth.test.mjs - issue #7: no surface may claim that Facebook posts
// are handed to Facebook's own scheduler and "fire even when your computer is off".
//
// The truth: pendpost fires a Facebook post at its due time. With the always-on cloud on,
// the cloud fires it (computer off is fine); without it, pendpost on this computer fires it.
// Only YouTube, Mastodon, WordPress and Ghost are natively scheduled by pendpost.
//
// Guards the core constant (lib/plans.mjs NATIVE_SCHEDULING_PLATFORMS, read by
// lib/publish-job.mjs delivery.survivesPowerOff) and the public copy that repeated the claim.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const { NATIVE_SCHEDULING_PLATFORMS } = await import('../lib/plans.mjs');
ok(!NATIVE_SCHEDULING_PLATFORMS.has('facebook'), 'core: facebook is not a natively scheduling platform');
ok(['youtube', 'mastodon', 'wordpress', 'ghost'].every((p) => NATIVE_SCHEDULING_PLATFORMS.has(p)), 'core: the four real native lanes stay native');

const FALSE_CLAIMS = [
  /Facebook scheduled posts/,
  /Facebook and YouTube (?:schedule|posts survive)/,
  /YouTube\s+and\s+Facebook schedule natively/,
  /Facebook (?:and|&) YouTube[^.]{0,80}(?:even when|with) your computer (?:is )?off/i,
  /Facebook, YouTube, Mastodon, WordPress,? and\s+Ghost/,
  /Facebook \(`scheduled_publish_time`\)/,
  /\|\s*Facebook\s*\|\s*(?:yes|Native)/,
  /name: "Facebook",[^}]*scheduling: "Native"/,
  /Native scheduling where the platform supports it \(Facebook/,
];
// Critic finding 5: every public surface that repeated the claim.
for (const rel of [
  'README.md', 'site-docs/introduction.mdx', 'web/src/pages/agents.astro',
  'site-docs/always-on.mdx', 'site-docs/scheduling.mdx', 'web/src/data/pricing.ts', 'web/src/data/faqs.ts',
  'web/src/components/Pricing.astro', 'web/src/data/brand.ts', 'web/src/pages/index.astro', 'web/src/pages/services.astro',
]) {
  const src = read(rel);
  ok(!FALSE_CLAIMS.some((re) => re.test(src)), `${rel}: no claim that Facebook schedules natively`);
}
ok(/always-on cloud|always-on host/i.test(read('README.md')), 'README: still names the always-on route for computer-off delivery');

console.log(`\n[facebook-delivery-truth] OK (${pass} assertions).`);
