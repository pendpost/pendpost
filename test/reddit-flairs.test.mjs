#!/usr/bin/env node
// test/reddit-flairs.test.mjs - spec 16 (Reddit link-flair read verb + lib face).
//   1. PURE NORMALIZE: the engine's normalizeFlairs maps a subreddit's raw
//      link_flair_v2 array into the Composer picker shape ({ id, text, editable,
//      cssClass }); junk / id-less entries are dropped; a non-array (a failed read)
//      normalizes to [] without throwing.
//   2. LIB FACE (P9): the `flairs` verb is LIVE-ONLY (left out of MOCKABLE_COMMANDS,
//      like probe), so in mock mode with no credentials listRedditFlairs degrades to a
//      STRUCTURED ok:FALSE (not_configured / needs_scope) - NEVER a false-empty
//      { ok:true, items:[] } that would read as "no flairs" for a read that failed.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib (util
// binds WORKSPACE_ROOT at import; mirrors test/presubmit.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-reddit-flairs-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

// Guarded entrypoint (no main() on import) - the pure normalizer is unit-testable.
const { normalizeFlairs } = await import('../scripts/reddit-social.mjs');
const { listRedditFlairs } = await import('../lib/writes.mjs');

try {
  // ---- (1) pure normalize -----------------------------------------------------
  const items = normalizeFlairs([
    { id: 'a1', text: 'News', text_editable: true, css_class: 'news' },
    { id: 'b2', text: 'Discussion', text_editable: false },
    { id: '', text: 'no id' }, // dropped: no id
    null, // dropped: junk
  ]);
  ok(items.length === 2, 'normalizeFlairs keeps only well-formed { id } templates');
  ok(items[0].id === 'a1' && items[0].text === 'News' && items[0].editable === true && items[0].cssClass === 'news',
    'a template normalizes to { id, text, editable, cssClass }');
  ok(items[1].editable === false, 'text_editable:false maps to editable:false');
  ok(Array.isArray(normalizeFlairs(null)) && normalizeFlairs(null).length === 0,
    'a non-array (a failed read) normalizes to [] - never throws');
  ok(Array.isArray(normalizeFlairs('nope')) && normalizeFlairs(undefined).length === 0,
    'a string / undefined also normalizes to [] (defensive)');

  // ---- (2) lib face: live-only, so mock/no-creds -> structured ok:false --------
  const res = await listRedditFlairs({ subreddit: 'test' });
  ok(res.ok === false, 'a scope-absent / not-configured read resolves ok:FALSE (never { ok:true, items:[] })');
  ok(res.error === 'not_configured' || res.error === 'needs_scope', `the degrade carries a structured error (${res.error})`);
  ok(res.code === 'not_configured' || res.code === 'engine_failure', 'the degrade carries a stable ERROR_CODE for the MCP toolError path');
  ok(Array.isArray(res.items) && res.items.length === 0, 'items is an empty array on the degrade (so the Composer can .map safely)');
  ok(typeof res.message === 'string' && res.message.length > 0, 'the degrade carries an honest message (never empty)');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
