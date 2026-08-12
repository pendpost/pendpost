#!/usr/bin/env node
// test/review-listener.test.mjs - W2 the review listener (spec 48 §3.1/§4.5).
//
// A real second http.createServer on an ephemeral port. We prove: it routes ONLY
// /review/* (an /api or /mcp path 404s here - there is no code path to the operator
// faces), a valid token serves the page shell + bundle, unknown/revoked/expired
// tokens render ONE byte-identical neutral page (no oracle), media is contained
// (traversal refused, only enumerated refs served), the per-IP throttle engages,
// and the listener is FAIL-CLOSED (does not start with zero active reviewers, stops
// when the last one is revoked).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function fetchRetry(url, opts, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try { return await fetch(url, opts); } catch { await sleep(30); }
  }
  return fetch(url, opts);
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-rl-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
process.env.PENDPOST_REVIEW_HOST = '127.0.0.1';
const PORT = await freePort();
process.env.PENDPOST_REVIEW_PORT = String(PORT);
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
const { createClient, setActiveClient } = await import('../lib/clients.mjs');
const { createReviewer, revokeReviewer } = await import('../lib/reviewers.mjs');
const { createCampaign, createPost } = await import('../lib/writes.mjs');
const { bootReviewServer, reviewServerRunning, stopReviewServer } = await import('../lib/review-server.mjs');

const base = `http://127.0.0.1:${PORT}`;

try {
  initMultiClient();
  createClient({ id: 'acme', displayName: 'Acme Co', accent: '#3355ff', actor: 'owner' });
  setActiveClient({ id: 'acme', actor: 'owner' });
  await createCampaign({ id: 'c1', note: 'c1', timezone: 'UTC', actor: 'owner' });
  // A media file on disk so the media route can stream it.
  const mediaRel = 'data/media/clip.jpg';
  const mediaAbs = path.join(clientRoot('acme'), mediaRel);
  fs.mkdirSync(path.dirname(mediaAbs), { recursive: true });
  fs.writeFileSync(mediaAbs, Buffer.from('JPEGDATA-not-really', 'utf8'));
  await createPost({ campaign: 'c1', post: { id: 'p1', type: 'reel', platforms: ['x'], caption: 'a pending post', scheduledAt: new Date(Date.now() + 86400_000).toISOString(), path: mediaRel }, actor: 'agent:claude' });

  // ---- fail-closed: no start with zero reviewers ----
  bootReviewServer();
  ok(reviewServerRunning() === false, 'listener does NOT start with zero active reviewers');

  // ---- mint a reviewer -> the subscriber starts the listener ----
  const mint = createReviewer({ clientId: 'acme', name: 'Martina', actor: 'owner' });
  ok(reviewServerRunning() === true, 'minting an active reviewer starts the listener');
  const token = mint.token;

  // wait until it actually accepts connections
  const pageRes = await fetchRetry(`${base}/review/${token}`, {});
  ok(pageRes.status === 200, 'GET /review/<token> serves 200');
  const pageHtml = await pageRes.text();
  ok(/review-root/.test(pageHtml), 'the page shell mounts #review-root');

  // ---- only /review/* is routed: /api and /mcp 404 here ----
  const apiRes = await fetch(`${base}/api/clients`);
  ok(apiRes.status === 404, 'GET /api/clients 404s on the review listener (no operator face here)');
  const mcpRes = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
  ok(mcpRes.status === 404, 'POST /mcp 404s on the review listener');
  const rootRes = await fetch(`${base}/`);
  ok(rootRes.status === 404, 'GET / 404s (not a /review/* path)');

  // ---- neutral page: unknown vs revoked are byte-identical (no oracle) ----
  const mintB = createReviewer({ clientId: 'acme', name: 'Bruno', actor: 'owner' });
  revokeReviewer({ clientId: 'acme', reviewerId: mintB.reviewer.id, actor: 'owner' });
  const unknownRes = await fetch(`${base}/review/totallyunknowntoken`);
  const revokedRes = await fetch(`${base}/review/${mintB.token}`);
  ok(unknownRes.status === 404 && revokedRes.status === 404, 'unknown and revoked tokens both 404');
  const unknownBody = await unknownRes.text();
  const revokedBody = await revokedRes.text();
  ok(unknownBody === revokedBody, 'unknown and revoked render a byte-identical neutral page (no oracle)');
  ok(!/Acme/.test(unknownBody), 'the neutral page leaks no brand name');

  // ---- bundle: pending post with a contentHash ----
  const bundleRes = await fetch(`${base}/review/${token}/bundle`);
  ok(bundleRes.status === 200, 'GET /review/<token>/bundle serves 200');
  const bundle = await bundleRes.json();
  ok(bundle.ok && Array.isArray(bundle.pending), 'bundle carries a pending array');
  const p1 = bundle.pending.find((p) => p.postId === 'p1');
  ok(p1 && typeof p1.contentHash === 'string' && p1.contentHash.length >= 12, 'the pending post carries a contentHash');
  ok(p1.media.includes(mediaRel), 'the pending post enumerates its media ref');
  ok(bundle.brand && bundle.brand.name === 'Acme Co', 'bundle carries brand identity');

  // ---- media containment: enumerated ref streams, traversal refused ----
  const okMedia = await fetch(`${base}/review/${token}/media/${encodeURIComponent(mediaRel)}`);
  ok(okMedia.status === 200 || okMedia.status === 206, 'an enumerated media ref streams');
  const traversal = await fetch(`${base}/review/${token}/media/${encodeURIComponent('../../../../etc/passwd')}`);
  ok(traversal.status === 404, 'a traversal media ref is refused (not enumerated / contained)');

  // ---- throttle engages under a burst from one IP ----
  let saw429 = false;
  for (let i = 0; i < 160; i += 1) {
    const r = await fetch(`${base}/review/${token}/bundle`);
    if (r.status === 429) { saw429 = true; break; }
  }
  ok(saw429, 'the per-IP throttle engages under a burst');

  // ---- fail-closed: revoking the last active reviewer stops the listener ----
  revokeReviewer({ clientId: 'acme', reviewerId: mint.reviewer.id, actor: 'owner' });
  ok(reviewServerRunning() === false, 'revoking the last active reviewer stops the listener');

  console.log(`\nreview-listener: ${pass} assertions passed`);
} finally {
  stopReviewServer();
  fs.rmSync(WS, { recursive: true, force: true });
}
