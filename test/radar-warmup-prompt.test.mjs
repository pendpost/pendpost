#!/usr/bin/env node
// test/radar-warmup-prompt.test.mjs - the WARM-UP (karma) block in radarScanPrompt.
// A warm-up query changes what the scan agent is asked for: not buying intent, but comment
// targets + non-promo post ideas, both via the SAME radar_ingest, distinguished by url shape.
// Proofs:
//   (a) a warm-up query adds the WARM-UP block + a per-query MODE marker;
//   (b) an ordinary batch has NEITHER (no behaviour change for non-karma users);
//   (c) the block forbids promotion and states the post-idea url convention (subreddit, no /comments/);
//   (d) the prompt stays dash-clean (the humanizer rule applies to composed prompts too).
import assert from 'node:assert';
const { radarScanPrompt } = await import('../lib/radar-prompt.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const warm = radarScanPrompt([{ id: 'wu', label: 'Warm up', sources: ['reddit'], subreddits: ['mcp'], warmup: true }], 20, 'pendpost');
const plain = radarScanPrompt([{ id: 'q1', label: 'Buyers', sources: ['reddit'] }], 20, 'pendpost');

// (a)
ok(/WARM-UP \(KARMA\) QUERIES/.test(warm), '(a) a warm-up query appends the WARM-UP block');
ok(/MODE: warm-up/.test(warm), '(a) the warm-up query carries a per-query MODE marker');
ok(/COMMENT TARGETS/.test(warm) && /POST IDEAS/.test(warm), '(a) the block asks for both comment targets and post ideas');

// (b)
ok(!/WARM-UP \(KARMA\)/.test(plain), '(b) an ordinary batch has NO warm-up block');
ok(!/MODE: warm-up/.test(plain), '(b) an ordinary query has no MODE marker');

// (c)
ok(/NO product mention|Never write a promotional/.test(warm), '(c) the block forbids promotion');
ok(/no \/comments\/|NO \/comments\//i.test(warm), '(c) the post-idea url convention (subreddit, no /comments/) is stated');
ok(/unique slug/.test(warm), '(c) distinct externalId (slug) is required so ideas do not collapse on dedupe');

// (d) dash discipline: no em/en dashes anywhere in the composed prompt
ok(!/[–—]/.test(warm), '(d) the composed warm-up prompt contains no em or en dashes');

console.log(`\n[radar-warmup-prompt] OK - warm-up queries brief the agent for comments + non-promo post ideas, ordinary queries are untouched (${pass} assertions).`);
