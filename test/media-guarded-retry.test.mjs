#!/usr/bin/env node
// test/media-guarded-retry.test.mjs - the guarded retry (B3). The app's "Erneut versuchen"
// clears a publishHold via a same-time reschedule; for a post parked by a PROBE-CONFIRMED
// dead media URL that just re-fired the identical dead URL - a dead-end loop. reschedulePost
// now re-probes on a "retry now" (slot at/before now): if the public URL is STILL
// deterministically dead it REFUSES (hold kept, honest error) instead of re-arming into an
// immediate re-fail; once the URL is live it re-arms; a FUTURE reschedule (runway to fix the
// mirror) is always allowed.
//
// Real HTTP HEAD against a local server standing in for the public media host.
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-gretry-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 's1.png'), 'x');

// A local host whose liveness we flip between the reschedule calls.
let live = false; // false = 404 text/html (dead), true = 200 image/png
const server = http.createServer((_req, res) => {
  if (live) { res.writeHead(200, { 'content-type': 'image/png' }); res.end('x'); }
  else { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html>not found</html>'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const { setConfig, getConfig } = await import('../lib/config.mjs');
const { createCampaign, createPost, approvePost, reschedulePost } = await import('../lib/writes.mjs');

const readPost = () => {
  const plan = JSON.parse(fs.readFileSync(path.join(WS, 'data', 'plans', 'camp', 'post-plan.json'), 'utf8'));
  return (plan.posts || []).find((p) => p.id === 'p1');
};
const stampDeadHold = (scheduledAt) => {
  const file = path.join(WS, 'data', 'plans', 'camp', 'post-plan.json');
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  const p = plan.posts.find((x) => x.id === 'p1');
  p.scheduledAt = scheduledAt;
  p.publishHold = { at: new Date().toISOString(), lane: 'instagram', code: 9004, message: `the public media URL ${base}/s1.png returned 404 text/html (not an image/video) - re-mirror the render or set imageUrl` };
  fs.writeFileSync(file, JSON.stringify(plan, null, 2));
};

try {
  const cfg = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { publicMediaBaseUrl: base } } });
  assert.ok(cfg.ok, `setConfig(publicMediaBaseUrl): ${JSON.stringify(cfg)}`);

  const cc = await createCampaign({ id: 'camp', note: 'camp', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, `createCampaign: ${JSON.stringify(cc)}`);
  const cp = await createPost({ campaign: 'camp', post: { id: 'p1', type: 'image', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/s1.png', caption: 'a calm honest note for the retry path' }, actor: 'agent:claude' });
  assert.ok(cp.ok, `createPost: ${JSON.stringify(cp)}`);
  // The approve-time dead-URL gate (test/media-approve-gate.test.mjs) would refuse an
  // approve while the mirror is dead - this test is about the RETRY path, so approve live.
  live = true;
  const ap = await approvePost({ campaign: 'camp', postId: 'p1', actor: 'owner' });
  assert.ok(ap.ok, `approvePost: ${JSON.stringify(ap)}`);

  const PAST = '2020-01-01T00:00:00Z';
  const FUTURE = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();

  // ===== retry-now while the URL is STILL dead -> REFUSED, hold kept ==========
  live = false;
  stampDeadHold(PAST);
  const r1 = await reschedulePost({ campaign: 'camp', postId: 'p1', scheduledAt: PAST, actor: 'owner' });
  ok(!r1.ok && r1.code === 'media_url_dead', `a retry-now on a still-dead URL is refused (got ${JSON.stringify(r1).slice(0, 120)})`);
  ok(/re-mirror the render/i.test(r1.error || r1.message || ''), 'the refusal carries the actionable re-mirror diagnosis');
  ok(Boolean(readPost().publishHold), 'the hold is KEPT on a refused retry (no silent re-arm into a re-fail)');

  // ===== retry-now once the URL is LIVE -> re-arms, hold cleared ==============
  live = true;
  const r2 = await reschedulePost({ campaign: 'camp', postId: 'p1', scheduledAt: PAST, actor: 'owner' });
  ok(r2.ok, `once the URL is live, the retry re-arms (got ${JSON.stringify(r2).slice(0, 120)})`);
  ok(!readPost().publishHold, 'a live URL clears the hold (the post is re-armed)');

  // ===== a FUTURE reschedule is allowed even while dead (runway to re-mirror) =
  live = false;
  stampDeadHold(PAST);
  const r3 = await reschedulePost({ campaign: 'camp', postId: 'p1', scheduledAt: FUTURE, actor: 'owner' });
  ok(r3.ok, `a FUTURE reschedule is allowed even on a dead URL (runway to fix the mirror) (got ${JSON.stringify(r3).slice(0, 120)})`);
  ok(!readPost().publishHold, 'the future reschedule cleared the hold (re-armed for later)');

  console.log(`\n${pass} assertions passed`);
} catch (e) {
  console.error('FAIL:', e && e.stack || e);
  process.exitCode = 1;
} finally {
  server.close();
  fs.rmSync(WS, { recursive: true, force: true });
}
