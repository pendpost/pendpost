#!/usr/bin/env node
// test/schedule-required.test.mjs - a post cannot be saved without a Termin.
//
// A time-less post (scheduledAt null/absent) mints zero publish lanes
// (scheduler.lanesFor) and would silently never publish. So the write layer
// refuses it at the single create chokepoint (covers HTTP, MCP, Composer,
// ThreadComposer) and refuses CLEARING a time on update. Omitting scheduledAt on
// a partial update is still fine (undefined is skipped); the sanctioned "hold" is
// executionMode:'parked', which keeps the time - not a null scheduledAt.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// A fresh, isolated data root MUST be set before the lib graph is imported
// (lib/context.mjs resolves the active root on first import).
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-schedule-required-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { validateFieldValues, createCampaign, createPost, updatePost } = await import('../lib/writes.mjs');

// --- 1. validateFieldValues: an OFFERED scheduledAt must be a valid ISO string ---
ok(validateFieldValues({ scheduledAt: '2026-01-01T00:00:00Z' }) === null, 'a valid ISO scheduledAt passes');
ok(validateFieldValues({ caption: 'x' }) === null, 'omitting scheduledAt on a partial patch passes (undefined skipped)');
const cleared = validateFieldValues({ scheduledAt: null });
ok(cleared && cleared.code === 'invalid_input', 'clearing a time (scheduledAt:null) is rejected');
const garbage = validateFieldValues({ scheduledAt: 'not-a-date' });
ok(garbage && garbage.code === 'invalid_input', 'an unparseable scheduledAt is rejected');

// --- 2. createPost REQUIRES a scheduledAt; updatePost cannot clear it ------------
const CAMP = 'acme';
await createCampaign({ id: CAMP, timezone: 'UTC', actor: 'owner' });

const missing = await createPost({ campaign: CAMP, post: { id: 'no-time', type: 'text', platforms: ['linkedin'], caption: 'c' }, actor: 'agent:claude' });
ok(!missing.ok && missing.code === 'invalid_input', 'createPost WITHOUT scheduledAt is rejected (invalid_input)');
ok(/scheduledAt is required/.test(missing.message || ''), 'the reject message names the required Termin');

const nulled = await createPost({ campaign: CAMP, post: { id: 'null-time', type: 'text', platforms: ['linkedin'], scheduledAt: null, caption: 'c' }, actor: 'agent:claude' });
ok(!nulled.ok && nulled.code === 'invalid_input', 'createPost with an explicit null scheduledAt is rejected');

const good = await createPost({ campaign: CAMP, post: { id: 'has-time', type: 'text', platforms: ['linkedin'], scheduledAt: '2026-07-14T13:00:00Z', caption: 'c' }, actor: 'agent:claude' });
ok(good.ok, `createPost WITH a valid scheduledAt succeeds: ${JSON.stringify(good)}`);

const rev = good.rev;
const clearAttempt = await updatePost({ campaign: CAMP, postId: 'has-time', ifRev: rev, fields: { scheduledAt: null }, actor: 'owner' });
ok(!clearAttempt.ok && clearAttempt.code === 'invalid_input', 'updatePost cannot clear a time (scheduledAt:null rejected)');

const capOnly = await updatePost({ campaign: CAMP, postId: 'has-time', ifRev: rev, fields: { caption: 'edited' }, actor: 'owner' });
ok(capOnly.ok, `a caption-only partial update (no scheduledAt) still works: ${JSON.stringify(capOnly)}`);

if (pass < 10) { console.error('[schedule-required] FAIL - missing assertions'); process.exit(1); }
console.log('[schedule-required] OK - no post is saved without a Termin.');
process.exit(0);
