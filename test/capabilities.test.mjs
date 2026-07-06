#!/usr/bin/env node
// test/capabilities.test.mjs - the lane-capability read (lib/capabilities.mjs).
//
// Proves the read NEVER throws and always returns the full shape: a live cloud
// answer is adopted verbatim (source 'cloud'), while a network failure, a non-2xx,
// a malformed body, and an empty lane map all degrade to the conservative baked-in
// fallback (source 'fallback') whose honesty invariants hold: reddit + tiktok are
// local_only (never cloud), the native lanes are the four platform-scheduled ones,
// and the offline cloud claim stays exactly the proven meta/linkedin/x guarantee.
// Also proves the cache: a cloud answer is memoized, and an unknown capability
// value from a NEWER cloud degrades per-lane instead of blanking the badge.
import assert from 'node:assert';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); console.log(`  ok - ${msg}`); pass += 1; };

const { laneCapabilities, resetCapabilitiesCache, FALLBACK_LANES, CAPABILITIES } = await import('../lib/capabilities.mjs');

const jsonRes = (body, okFlag = true) => ({ ok: okFlag, json: async () => body });

// ---- (1) fallback honesty invariants ----------------------------------------
resetCapabilitiesCache();
const offline = await laneCapabilities({ fetchImpl: async () => { throw new Error('offline'); } });
ok(offline.ok === true, 'offline read still resolves ok');
eq(offline.source, 'fallback', 'offline read falls back');
eq(offline.lanes.reddit, 'local_only', 'fallback: reddit is local_only (non-commercial API)');
eq(offline.lanes.tiktok, 'local_only', 'fallback: tiktok is local_only (unaudited apps post private)');
eq(offline.lanes['youtube-release'], 'local_only', 'fallback: youtube-release is local_only');
eq([...offline.cloudLanes].sort(), ['linkedin', 'meta', 'x'], 'fallback cloud claim is exactly the proven meta/linkedin/x');
eq([...offline.nativeLanes].sort(), ['ghost', 'mastodon', 'wordpress', 'youtube'], 'fallback natives are the platform-scheduled four');
ok(offline.localOnlyLanes.includes('reddit') && offline.localOnlyLanes.includes('tiktok'), 'localOnlyLanes names reddit + tiktok');
ok(Object.values(FALLBACK_LANES).every((c) => CAPABILITIES.includes(c)), 'every fallback value is a known capability');

// ---- (2) non-2xx and malformed bodies also fall back ------------------------
resetCapabilitiesCache();
const http500 = await laneCapabilities({ fetchImpl: async () => jsonRes({ error: 'boom' }, false) });
eq(http500.source, 'fallback', 'a non-2xx degrades to the fallback');
resetCapabilitiesCache();
const garbage = await laneCapabilities({ fetchImpl: async () => jsonRes({ hello: 'world' }) });
eq(garbage.source, 'fallback', 'a body without lanes degrades to the fallback');
resetCapabilitiesCache();
const empty = await laneCapabilities({ fetchImpl: async () => jsonRes({ lanes: { meta: '??' } }) });
eq(empty.source, 'fallback', 'a lane map with no known capability degrades to the fallback');

// ---- (3) a live cloud answer is adopted verbatim + derived lists match ------
resetCapabilitiesCache();
const cloudMap = {
  meta: 'cloud', linkedin: 'cloud', x: 'cloud', telegram: 'cloud',
  youtube: 'native', mastodon: 'native',
  reddit: 'local_only', tiktok: 'local_only',
  bluesky: 'disabled',
};
const live = await laneCapabilities({ fetchImpl: async () => jsonRes({ version: 1, lanes: cloudMap }) });
eq(live.source, 'cloud', 'a live answer is source cloud');
eq(live.lanes.telegram, 'cloud', 'a capability flip (telegram->cloud) propagates without a deploy');
eq([...live.localOnlyLanes].sort(), ['reddit', 'tiktok'], 'derived localOnlyLanes mirror the live map');
ok(!('gbp' in live.lanes), 'the live map replaces the fallback, never merges');

// ---- (4) the cloud answer is memoized (no per-paint network) ----------------
let calls = 0;
const cached = await laneCapabilities({ fetchImpl: async () => { calls += 1; return jsonRes({ lanes: cloudMap }); } });
eq(cached.source, 'cloud', 'second read inside the TTL is served');
eq(calls, 0, 'second read inside the TTL never re-fetches');

// ---- (5) an unknown capability value degrades that lane to the fallback -----
resetCapabilitiesCache();
const partial = await laneCapabilities({ fetchImpl: async () => jsonRes({ lanes: { ...cloudMap, reddit: 'hyperspace' } }) });
eq(partial.source, 'cloud', 'a mostly-valid live map is still adopted');
eq(partial.lanes.reddit, 'local_only', 'an unknown value degrades that lane to the baked truth');

resetCapabilitiesCache();
console.log(`capabilities.test.mjs: ${pass} checks passed`);
