#!/usr/bin/env node
// test/caption-backstop.test.mjs - the shared caption-cap guard (lib/caption.mjs).
// Mirrors poll.mjs/carousel.mjs: ONE side-effect-free blocker both platformValidate
// (pre-flight) and the live engines (fail-closed backstop) read, so a lane's caption
// cap can never drift between the two. captionBlocker returns null when publishable,
// else the SAME human reason platformValidate emits; captionBlockRow is the structured
// ok:false publish row (mirrors pollBlockRow/carouselBlockRow).
import assert from 'node:assert';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); console.log(`  ok - ${msg}`); pass += 1; };

const { CAPTION_LIMITS, captionBlocker, captionBlockRow } = await import('../lib/caption.mjs');

// --- captionBlocker: per-lane cap from the shared map ---
eq(captionBlocker('x'.repeat(2201), 'instagram'), 'caption is 2201 chars - instagram caps at 2200',
  'over the instagram cap returns the byte-exact reason');
eq(captionBlocker('x'.repeat(2200), 'instagram'), null, 'exactly at the cap is publishable');
eq(captionBlocker('short', 'instagram'), null, 'under the cap is publishable');
eq(captionBlocker('x'.repeat(3001), 'linkedin'), 'caption is 3001 chars - linkedin caps at 3000',
  'linkedin cap (3000) enforced');
eq(captionBlocker('x'.repeat(5001), 'youtube'), 'caption is 5001 chars - youtube caps at 5000',
  'youtube cap (5000) enforced');

// --- unknown lane / no cap known -> never blocks (mirrors `|| Infinity`) ---
eq(captionBlocker('x'.repeat(99999), 'nostr'), null, 'a lane with no known cap never blocks');

// --- explicit limit overrides the map (telegram passes TEXT_LIMIT vs CAPTION_LIMIT) ---
eq(captionBlocker('x'.repeat(1025), 'telegram', 1024), 'caption is 1025 chars - telegram caps at 1024',
  'an explicit limit overrides the lane default');
eq(captionBlocker('x'.repeat(1025), 'telegram', 4096), null,
  'a higher explicit limit lets the same text through');

// --- empty / nullish text is never over cap ---
eq(captionBlocker('', 'instagram'), null, 'empty text never blocks');
eq(captionBlocker(null, 'instagram'), null, 'null text is treated as empty');
eq(captionBlocker(undefined, 'instagram'), null, 'undefined text is treated as empty');

// --- the shared map is the authoritative source (the constant lint.mjs + writes.mjs re-use) ---
eq(CAPTION_LIMITS.instagram, 2200, 'instagram cap');
eq(CAPTION_LIMITS.facebook, 63206, 'facebook cap');
eq(CAPTION_LIMITS.linkedin, 3000, 'linkedin cap');
eq(CAPTION_LIMITS.youtube, 5000, 'youtube cap');

// --- captionBlockRow: the structured publish-failure row (mirrors pollBlockRow) ---
const row = captionBlockRow({ id: 'p1' }, 'instagram', 'caption is 2201 chars - instagram caps at 2200');
eq(row.postId, 'p1', 'block row carries the post id');
eq(row.platform, 'instagram', 'block row carries the platform');
eq(row.action, 'publish', 'block row action is publish');
eq(row.ok, false, 'block row is ok:false');
eq(row.errorCode, 'invalid_input', "block row errorCode is 'invalid_input' (matches the existing engine rows)");
eq(row.errorMessage, 'caption is 2201 chars - instagram caps at 2200', 'block row carries the reason');

console.log(`\n${pass} assertions passed`);
