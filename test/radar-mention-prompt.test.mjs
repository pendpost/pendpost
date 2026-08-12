#!/usr/bin/env node
// test/radar-mention-prompt.test.mjs - the BRAND MENTIONS (reputation) block in radarScanPrompt.
// A mention query changes what the scan agent is asked for: not buying intent, but public posts
// that NAME the brand (praise, complaint, misinformation, support question), via the SAME
// radar_ingest. Proofs:
//   (a) a mention query adds the BRAND MENTIONS block + a per-query MODE marker;
//   (b) an ordinary batch has NEITHER (no behaviour change for non-mention users);
//   (c) the block enumerates the mention kinds and forbids inventing a mention;
//   (d) the prompt stays dash-clean (the humanizer rule applies to composed prompts too).
import assert from 'node:assert';
const { radarScanPrompt } = await import('../lib/radar-prompt.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const mention = radarScanPrompt([{ id: 'bm', label: 'Brand mentions', sources: ['reddit', 'mastodon'], keywords: ['pendpost'], mention: true }], 20, 'pendpost');
const plain = radarScanPrompt([{ id: 'q1', label: 'Buyers', sources: ['reddit'] }], 20, 'pendpost');

// (a)
ok(/BRAND MENTIONS \(REPUTATION\) QUERIES/.test(mention), '(a) a mention query appends the BRAND MENTIONS block');
ok(/MODE: brand mention/.test(mention), '(a) the mention query carries a per-query MODE marker');

// (b)
ok(!/BRAND MENTIONS/.test(plain), '(b) an ordinary batch has NO brand-mentions block');
ok(!/MODE: brand mention/.test(plain), '(b) an ordinary query has no MODE marker');

// (c)
ok(/praise|recommendation/.test(mention) && /complaint/.test(mention) && /misleading claim|wrong .* claim/.test(mention) && /support question/.test(mention), '(c) the block enumerates the mention kinds');
ok(/Do NOT invent a mention/.test(mention), '(c) the block forbids inventing a mention');
ok(/reply to nothing here|operator reads each mention/.test(mention), '(c) the mention path stays human-gated (agent replies to nothing)');

// (d) dash discipline: no em/en dashes anywhere in the composed prompt
ok(!/[–—]/.test(mention), '(d) the composed brand-mentions prompt contains no em or en dashes');

console.log(`\n[radar-mention-prompt] OK - mention queries brief the agent for reputation events, ordinary queries are untouched (${pass} assertions).`);
