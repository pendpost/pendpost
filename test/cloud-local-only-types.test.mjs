#!/usr/bin/env node
// test/cloud-local-only-types.test.mjs - H6. The cloud never fires a carousel
// (cloudFiresPost excludes it, enforced at the push and at the sync-status count), and
// NO surface said so. An album scheduled for a future time showed a plain "Geplant"
// while in truth it publishes only if this Mac is awake with the daemon running. That
// was live for three real posts.
//
// The capability endpoint is LANE-shaped and cannot answer a per-TYPE question, so
// localOnlyTypes rides the existing capabilities shape as a locally-known constant.
//
// This guard DERIVES the expected list from the exported predicate rather than
// hand-copying it. Adding a shape to cloudFiresPost therefore breaks the build and
// forces a UI decision, instead of silently leaving another post type uncovered while
// the dashboard keeps promising unattended delivery.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-localonly-types-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { cloudFiresPost } = await import('../lib/cloud-client.mjs');
const { LOCAL_ONLY_TYPES } = await import('../lib/capabilities.mjs');

// TYPES is not exported anywhere (it is hand-copied across three files, which is its
// own guard in test/enumeration-drift.test.mjs). Read the literal out of the source the
// way the repo's other cheap drift guards do, so this test still sees a NEW type the day
// it is added rather than a stale hand-copy of its own.
import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const typesSrc = fs.readFileSync(path.join(REPO, 'lib', 'writes.mjs'), 'utf8').match(/const TYPES = \[([^\]]*)\]/);
assert.ok(typesSrc, 'lib/writes.mjs declares the TYPES literal');
const TYPES = typesSrc[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);

try {
  ok(typeof cloudFiresPost === 'function', 'cloudFiresPost is exported (it is the single source for this list)');
  ok(Array.isArray(LOCAL_ONLY_TYPES), 'capabilities exposes LOCAL_ONLY_TYPES');

  // Derive: a PURE type the cloud refuses, probed on a lane that is otherwise cloud-fired.
  // linkedin is deliberate - it keeps the instagram-only image clause out of the answer.
  const derived = TYPES.filter((type) => !cloudFiresPost({ type, platforms: ['linkedin'] })).sort();
  ok(derived.join(',') === [...LOCAL_ONLY_TYPES].sort().join(','),
    `LOCAL_ONLY_TYPES matches what cloudFiresPost actually refuses (predicate: ${derived.join(',') || 'none'} / constant: ${[...LOCAL_ONLY_TYPES].sort().join(',') || 'none'})`);

  ok(LOCAL_ONLY_TYPES.includes('carousel'), 'carousel is named as local-only, which is the fact the delivery line now states');

  // The honest limit of a flat type list: the IG feed-image case is type AND platform,
  // so it cannot ride a per-type constant. It is still cloud-held; its own honesty line
  // is a follow-up, and this assertion is what stops that being forgotten silently.
  ok(cloudFiresPost({ type: 'image', platforms: ['linkedin'] }) === true
    && cloudFiresPost({ type: 'image', platforms: ['instagram'] }) === false,
    'the IG feed-image exclusion is platform-conditional, so it is deliberately NOT in the flat type list (its honesty line is a follow-up)');

  // The rollout gate (posting.carouselViaCloud, 2nd arg): OFF -> carousel + IG-image are
  // local-only (the derived list above); ON -> they cloud-fire. nostr-longform stays local
  // regardless (a separate companion). Proves the lift is behind the flag, not unconditional.
  ok(cloudFiresPost({ type: 'carousel', platforms: ['instagram'] }, false) === false
    && cloudFiresPost({ type: 'carousel', platforms: ['instagram'] }, true) === true,
    'carouselViaCloud gates carousel cloud-firing (off -> local, on -> cloud)');
  ok(cloudFiresPost({ type: 'image', platforms: ['instagram'] }, false) === false
    && cloudFiresPost({ type: 'image', platforms: ['instagram'] }, true) === true,
    'carouselViaCloud gates the IG feed-image cloud-firing too');
  ok(cloudFiresPost({ type: 'nostr-longform', platforms: ['nostr'] }, true) === false,
    'nostr-longform stays local-only even with the carousel gate on (its own companion is separate)');
  ok(cloudFiresPost({ type: 'reel', platforms: ['instagram'] }, false) === true,
    'a normal reel is unaffected by the gate (always cloud-fired)');

  const { laneCapabilities } = await import('../lib/capabilities.mjs');
  const caps = await laneCapabilities({ fetchImpl: async () => { throw new Error('offline'); } });
  ok(Array.isArray(caps.localOnlyTypes) && caps.localOnlyTypes.includes('carousel'),
    'the capabilities SHAPE carries localOnlyTypes, so the dashboard reads it from the same object as the lanes');
  ok(caps.source === 'fallback', 'and it is present on the degraded fallback shape too, not only on a live cloud answer');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
