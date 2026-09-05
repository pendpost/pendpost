#!/usr/bin/env node
// test/media-approve-gate.test.mjs - the APPROVE-TIME dead-URL gate (2026-08-26, third
// mirror-404 incident). The public media mirror (web/public/media/ + prod deploy) is a
// manual step; when a render was never mirrored, the post used to sail through approval
// and then fail at publish with Meta 9004. setApproval now probes the post's public media
// URL(s) (same seams as the pre-fire fail-safe: postPublicMediaUrls -> deadMediaUrlDiagnosis)
// and REFUSES an approve whose URL is already deterministically dead - naming the URL and
// the one-command fix (ops/mirror-media.mjs). Fail-open on transient probes, force:true
// overrides, reject is never gated, and the auto-approve path (createPost -> setApproval)
// flows through the same gate so a doomed post stays a draft instead of auto-scheduling.
//
// Real HTTP HEAD against a local server standing in for the public media host.
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-apgate-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
for (const f of ['dead.png', 'flaky.png', 'good.png', 'auto.png']) {
  fs.writeFileSync(path.join(WS, 'data', 'media', f), 'x');
}

// The mirror host: liveness is per-FILE, so one server plays every scenario.
const server = http.createServer((req, res) => {
  if (req.url === '/good.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end('x'); return; }
  if (req.url === '/flaky.png') { res.writeHead(503, { 'content-type': 'text/html' }); res.end('over capacity'); return; }
  res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html>not found</html>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const { setConfig, getConfig } = await import('../lib/config.mjs');
const { createCampaign, createPost, approvePost, rejectPost } = await import('../lib/writes.mjs');

const readPost = (id) => {
  const plan = JSON.parse(fs.readFileSync(path.join(WS, 'data', 'plans', 'camp', 'post-plan.json'), 'utf8'));
  return (plan.posts || []).find((p) => p.id === id);
};
const FUTURE = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
const mkPost = (id, file) => createPost({
  campaign: 'camp',
  post: { id, type: 'image', platforms: ['instagram'], scheduledAt: FUTURE, path: `data/media/${file}`, caption: 'a calm honest note for the approve gate' },
  actor: 'agent:claude',
});

try {
  const cfg = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { publicMediaBaseUrl: base } } });
  assert.ok(cfg.ok, `setConfig(publicMediaBaseUrl): ${JSON.stringify(cfg)}`);
  const cc = await createCampaign({ id: 'camp', note: 'camp', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, `createCampaign: ${JSON.stringify(cc)}`);
  for (const [id, file] of [['pdead', 'dead.png'], ['pflaky', 'flaky.png'], ['pgood', 'good.png']]) {
    const cp = await mkPost(id, file);
    assert.ok(cp.ok, `createPost ${id}: ${JSON.stringify(cp)}`);
  }

  // ===== a dead (404 html) mirror URL refuses the approve, post stays a draft =====
  const a1 = await approvePost({ campaign: 'camp', postId: 'pdead', actor: 'owner' });
  ok(!a1.ok && a1.code === 'media_url_dead', `approving a post with a 404 mirror URL is refused (got ${JSON.stringify(a1).slice(0, 140)})`);
  ok(/re-mirror the render/i.test(a1.error || a1.message || ''), 'the refusal carries the actionable re-mirror diagnosis');
  ok(/mirror-media\.mjs/.test(a1.error || a1.message || ''), 'the refusal names the one-command fix (ops/mirror-media.mjs)');
  ok(readPost('pdead').approval === 'draft', 'the post stays a DRAFT after the refused approve');

  // ===== reject is never gated, even on a dead URL =====
  const rj = await rejectPost({ campaign: 'camp', postId: 'pdead', actor: 'owner' });
  ok(rj.ok, `rejecting a dead-URL post is NOT gated (got ${JSON.stringify(rj).slice(0, 120)})`);

  // ===== force:true overrides (the publish fence stays the fail-closed backstop) =====
  const af = await approvePost({ campaign: 'camp', postId: 'pdead', actor: 'owner', force: true });
  ok(af.ok, `force:true approves over the dead URL (got ${JSON.stringify(af).slice(0, 120)})`);

  // ===== a transient 5xx is INCONCLUSIVE - approve proceeds (fail-open) =====
  const a2 = await approvePost({ campaign: 'camp', postId: 'pflaky', actor: 'owner' });
  ok(a2.ok, `a transient 503 does NOT block the approve (fail-open) (got ${JSON.stringify(a2).slice(0, 120)})`);

  // ===== a healthy URL approves normally =====
  const a3 = await approvePost({ campaign: 'camp', postId: 'pgood', actor: 'owner' });
  ok(a3.ok, `a healthy mirror URL approves normally (got ${JSON.stringify(a3).slice(0, 120)})`);

  // ===== auto-approve flows through the same gate: a dead URL leaves a DRAFT =====
  const pol = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { autoApprove: { enabled: true, platforms: ['instagram'], campaigns: [], types: [], requireLintClean: false } } } });
  assert.ok(pol.ok, `setConfig(autoApprove): ${JSON.stringify(pol)}`);
  const cpa = await mkPost('pauto', 'auto.png'); // auto.png is not routed -> 404 = dead
  assert.ok(cpa.ok, `createPost pauto: ${JSON.stringify(cpa)}`);
  ok(cpa.autoApproved !== true && readPost('pauto').approval === 'draft', 'auto-approve on a dead URL is refused by the gate - the post stays a draft (never schedules a doomed fire)');

  console.log(`\n${pass} assertions passed`);
} catch (e) {
  console.error('FAIL:', e && e.stack || e);
  process.exitCode = 1;
} finally {
  server.close();
  fs.rmSync(WS, { recursive: true, force: true });
}
