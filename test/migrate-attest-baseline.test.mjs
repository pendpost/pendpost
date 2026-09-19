#!/usr/bin/env node
// test/migrate-attest-baseline.test.mjs - guards the spec 51 (2.6.0) upgrade migration that
// retires stale approvedContentHash fingerprints so an older-build approval is not wrongly held
// by the new fail-closed fence. Tests the pure core against a fake hasher (no filesystem, no lib).
import assert from 'node:assert';
import { retireStaleFingerprints } from '../scripts/migrate-attest-baseline.mjs';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

// Fake hasher: the "current" canonical hash of every post is 'CURRENT'. So a stored
// approvedContentHash of 'CURRENT' matches (untouched) and anything else is stale (retired).
const hasher = () => 'CURRENT';

// (a) a non-terminal post with a STALE fingerprint is retired (cleared -> legacy no_fingerprint).
const stale = { posts: [{ id: 'a', status: 'scheduled', approvedContentHash: 'OLD1234' }] };
ok(retireStaleFingerprints(stale, hasher) === 1, 'a stale non-terminal fingerprint is counted');
ok(!('approvedContentHash' in stale.posts[0]), 'the stale fingerprint field is removed');

// (b) a non-terminal post whose fingerprint still MATCHES is left untouched (keeps its receipt).
const fresh = { posts: [{ id: 'b', status: 'approved', approvedContentHash: 'CURRENT' }] };
ok(retireStaleFingerprints(fresh, hasher) === 0, 'a matching fingerprint is not touched');
ok(fresh.posts[0].approvedContentHash === 'CURRENT', 'the matching fingerprint survives');

// (c) a TERMINAL post (already posted) is skipped even if its stored hash is stale.
const posted = { posts: [{ id: 'c', status: 'posted', approvedContentHash: 'OLD9999' }] };
ok(retireStaleFingerprints(posted, hasher) === 0, 'a terminal post is skipped');
ok(posted.posts[0].approvedContentHash === 'OLD9999', 'a terminal post keeps its fingerprint');

// (d) a post with no fingerprint at all is a no-op (never crashes).
const none = { posts: [{ id: 'd', status: 'scheduled' }] };
ok(retireStaleFingerprints(none, hasher) === 0, 'a post with no fingerprint is a no-op');

// (e) the single-post plan shape (plan.post) is handled too.
const single = { post: { id: 'e', status: 'ready', approvedContentHash: 'OLD' } };
ok(retireStaleFingerprints(single, hasher) === 1, 'the single-post plan shape is migrated');

// (f) idempotent: a second pass over an already-migrated plan changes nothing.
ok(retireStaleFingerprints(stale, hasher) === 0, 'a second pass is idempotent');

console.log(`\n${pass} assertions passed - test/migrate-attest-baseline.test.mjs`);
