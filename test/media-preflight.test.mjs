#!/usr/bin/env node
// test/media-preflight.test.mjs - the PRE-FIRE media fail-safe end-to-end over a real
// HTTP HEAD (probeMediaUrl -> isDeterministicallyDead -> classifyMediaProbe, composed as
// deadMediaUrlDiagnosis). This is the actual fetch path the meta + pinterest engines run
// before handing a public URL to the platform: a DETERMINISTICALLY dead URL returns the
// re-mirror diagnosis (the caller skips the doomed POST and parks on strike 1), while a
// healthy URL - and, crucially, a TRANSIENT 5xx - return null so the publish proceeds.
//
// Zero-dep: node:http local server + node:assert.
import assert from 'node:assert';
import http from 'node:http';
import { probeMediaUrl, deadMediaUrlDiagnosis, MEDIA_URL_DEAD_MARK } from '../lib/public-media.mjs';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const routes = {
  '/good.png': (res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end('x'); },
  '/dead.png': (res) => { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); res.end('<html>not found</html>'); },
  '/html200': (res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>spa shell</html>'); },
  '/gone': (res) => { res.writeHead(410, { 'content-type': 'text/html' }); res.end('gone'); },
  '/err500': (res) => { res.writeHead(503, { 'content-type': 'text/html' }); res.end('over capacity'); },
};
const server = http.createServer((req, res) => {
  const h = routes[req.url];
  if (h) return h(res);
  res.writeHead(404, { 'content-type': 'text/html' }); res.end('nope');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  // probeMediaUrl returns the raw HEAD result (or null for junk input)
  const good = await probeMediaUrl(`${base}/good.png`);
  ok(good && good.status === 200, 'probeMediaUrl reads a real HEAD (200 image)');
  ok((await probeMediaUrl('not-a-url')) === null, 'probeMediaUrl returns null for a non-http input (never throws)');

  // deadMediaUrlDiagnosis: dead URLs yield the actionable diagnosis
  const d404 = await deadMediaUrlDiagnosis(`${base}/dead.png`);
  ok(typeof d404 === 'string' && d404.includes(MEDIA_URL_DEAD_MARK), 'a 404 HTML URL is diagnosed dead (would skip + park)');
  const dHtml = await deadMediaUrlDiagnosis(`${base}/html200`);
  ok(typeof dHtml === 'string' && dHtml.includes(MEDIA_URL_DEAD_MARK), 'a 200-but-HTML URL (SPA catch-all) is diagnosed dead');
  const dGone = await deadMediaUrlDiagnosis(`${base}/gone`);
  ok(typeof dGone === 'string', 'a 410 Gone URL is diagnosed dead');

  // healthy + transient URLs must NOT block (fail-open)
  ok((await deadMediaUrlDiagnosis(`${base}/good.png`)) === null, 'a healthy image URL is NOT flagged - the publish proceeds');
  ok((await deadMediaUrlDiagnosis(`${base}/err500`)) === null, 'a transient 5xx is NOT flagged - fail-open, Meta still gets its fetch');

  console.log(`\n${pass} assertions passed`);
} catch (e) {
  console.error('FAIL:', e && e.stack || e);
  process.exitCode = 1;
} finally {
  server.close();
}
