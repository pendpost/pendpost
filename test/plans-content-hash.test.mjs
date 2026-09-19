#!/usr/bin/env node
// test/plans-content-hash.test.mjs - spec 51 Task 3 regression guard.
//
// postContentHash is the SHIPPED 12-hex approval fingerprint (stamped as
// approvedContentHash at approval time). Spec 51 factors its canonical-object
// construction into an exported contentCanonical(post) and adds a full-length
// contentSha256(post) over the SAME bytes, so the two integrity hashes can never
// describe different content. This test pins postContentHash's value BEFORE the
// refactor (computed against the pre-spec-51 implementation, see the pinned
// EXPECTED constants below) and asserts it is byte-identical after - a drift here
// would silently invalidate every existing approvedContentHash on disk.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib, matching
// the other lib/plans.mjs tests, even though the functions under test are pure.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-plans-hash-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { postContentHash, contentCanonical, contentSha256 } = await import('../lib/plans.mjs');

// (a) postContentHash is unchanged for representative posts. These 12-hex values
// were computed against the CURRENT (pre-refactor) inline implementation - see the
// Task 3 verification transcript - then pinned here so any future change to
// POST_CONTENT_FIELDS ordering/logic or the hash algorithm trips this test.
// Re-pinned 2026-09-19 when spec 51 landed on develop (2.6.0): POST_CONTENT_FIELDS grew by the
// content fields added across the 200+ commits since spec 51 was cut (liAuthor, liDescription, the
// reddit/gbp/tt fields, isPromo, etc.), so the canonical object, and thus these fingerprints, moved.
// This is INTENDED field growth, not a canonicalization change: the canonical<->hash relationship and
// the non-content-field stability below both still hold. Existing on-disk approvedContentHash values
// were retired by scripts/migrate-attest-baseline.mjs on upgrade (they fire as legacy no_fingerprint),
// so the drift does not block any already-approved post.
const REPRESENTATIVE = { caption: 'hi', platforms: ['x'], type: 'text' };
const EXPECTED_HASH = 'd2ce277896a4';
ok(postContentHash(REPRESENTATIVE) === EXPECTED_HASH,
  `postContentHash(representative post) === pinned ${EXPECTED_HASH} (no drift from the refactor)`);

const RICHER = {
  caption: 'hello', platforms: ['x', 'linkedin'], type: 'image',
  tags: ['a', 'b'], attestation: { x: { signed: true } },
};
const EXPECTED_HASH_RICHER = '27fb42110bae';
ok(postContentHash(RICHER) === EXPECTED_HASH_RICHER,
  `postContentHash(richer post) === pinned ${EXPECTED_HASH_RICHER}`);

const EXPECTED_HASH_EMPTY = '2cca0d131de4';
ok(postContentHash({}) === EXPECTED_HASH_EMPTY,
  `postContentHash({}) === pinned ${EXPECTED_HASH_EMPTY}`);

// postContentHash must literally be sha1(JSON.stringify(contentCanonical(post))).slice(0,12) -
// the exact relationship the refactor is supposed to establish.
const crypto = await import('node:crypto');
const expectedFromCanonical = crypto.createHash('sha1')
  .update(JSON.stringify(contentCanonical(REPRESENTATIVE)))
  .digest('hex').slice(0, 12);
ok(postContentHash(REPRESENTATIVE) === expectedFromCanonical,
  'postContentHash(post) === sha1(JSON.stringify(contentCanonical(post))).slice(0,12)');

// (b) contentSha256 is 64 hex chars, stable across key-insertion-order differences,
// and stable across missing-vs-null for a content field.
const sha = contentSha256(REPRESENTATIVE);
ok(/^[0-9a-f]{64}$/.test(sha), 'contentSha256 is exactly 64 lowercase hex chars');

const reordered = { platforms: ['x'], caption: 'hi', type: 'text' };
ok(contentSha256(reordered) === sha, 'contentSha256 is stable across key-insertion-order differences');
ok(postContentHash(reordered) === postContentHash(REPRESENTATIVE),
  'postContentHash is likewise stable across key-insertion-order differences');

const missingField = { caption: 'hi', platforms: ['x'], type: 'text' }; // no explicit `link`
const explicitNull = { caption: 'hi', platforms: ['x'], type: 'text', link: null };
ok(contentSha256(missingField) === contentSha256(explicitNull),
  'contentSha256 treats a missing content field the same as an explicit null');
ok(postContentHash(missingField) === postContentHash(explicitNull),
  'postContentHash treats a missing content field the same as an explicit null');

// (c) A non-content field (ids, attestation, receipt) must NOT change either hash -
// they are outcome metadata, never content (hard constraint: additive-only fields
// must stay out of POST_CONTENT_FIELDS).
const withNonContent = {
  ...REPRESENTATIVE,
  ids: { x: '123456' },
  attestation: { x: { signed: 'abc' } },
  receipt: { x: { at: '2026-09-09T00:00:00Z' } },
};
ok(postContentHash(withNonContent) === postContentHash(REPRESENTATIVE),
  'adding ids/attestation/receipt does not change postContentHash');
ok(contentSha256(withNonContent) === contentSha256(REPRESENTATIVE),
  'adding ids/attestation/receipt does not change contentSha256');

console.log(`\n${pass} assertions passed - test/plans-content-hash.test.mjs`);
