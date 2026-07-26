#!/usr/bin/env node
// test/humanize-wiring.test.mjs - the always-on humanizer gate is wired into the AUTHORING
// path, so outbound copy is humanized before it is ever persisted (and therefore before a
// transmit-only engine can send it). Driven against the REAL createPost/updatePost writers.
//
// createPost is the one door both normal posts and Radar replies walk through, so proving the
// caption is cleaned on create proves the gate for both. Also proves update cleans on edit, and
// that a structural field carried alongside prose (redditText is prose and cleaned; a made-up
// non-prose value is not in POST_PROSE_FIELDS so it is left alone - covered by the unit test).
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-humanize-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));

const { createCampaign, createPost, updatePost } = await import('../lib/writes.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const getPost = (camp, id) => (loadPlanStore().campaigns.find((c) => c.id === camp)?.posts || []).find((p) => p.id === id);
const DASHES = /[–—]/;
const CURLY = /[‘’“”]/;

try {
  const cc = await createCampaign({ id: 'h', note: 'h', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, `createCampaign: ${JSON.stringify(cc)}`);

  // ---- create: the prose fields are humanized before persistence ----
  const cp = await createPost({
    campaign: 'h',
    post: {
      id: 'p1', type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4',
      caption: 'pendpost is local-first — no cloud needed, and it’s fast',
      firstComment: 'more here — soon',
      xCaption: 'local-first — always',
    },
    actor: 'agent:claude',
  });
  assert.ok(cp.ok, `createPost: ${JSON.stringify(cp)}`);
  const p = getPost('h', 'p1');
  ok(!DASHES.test(p.caption) && !CURLY.test(p.caption), 'created caption is humanized (no em dash, no curly quote)');
  ok(p.caption === 'pendpost is local-first, no cloud needed, and it\'s fast', 'created caption reads exactly as humanized');
  ok(!DASHES.test(p.firstComment), 'created firstComment is humanized');
  ok(!DASHES.test(p.xCaption), 'created per-platform xCaption is humanized');

  // ---- update: the edited prose is humanized on the way in ----
  const up = await updatePost({ campaign: 'h', postId: 'p1', ifRev: p.rev, fields: { caption: 'now — even faster' }, actor: 'owner' });
  assert.ok(up.ok, `updatePost: ${JSON.stringify(up)}`);
  const p2 = getPost('h', 'p1');
  ok(!DASHES.test(p2.caption) && p2.caption === 'now, even faster', 'updated caption is humanized on edit');
} catch (err) {
  failures += 1;
  console.error(`  FAIL - threw: ${err && err.stack || err}`);
}

console.log(`\nhumanize-wiring.test.mjs: ${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
