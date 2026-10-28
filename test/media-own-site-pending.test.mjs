#!/usr/bin/env node
// test/media-own-site-pending.test.mjs - the own-site media rule (owner decision
// 2026-10-28). A blog post's Instagram image is the article's OG card on the brand's own
// site, which is date-gated and 404s until release day. The approve-time dead-URL gate
// refused all of them. Proves:
//   1. a dead URL on the host of posting.publicMediaBaseUrl (case-insensitive, leading
//      www. ignored), outside the mirror path, on a post scheduled in the FUTURE approves
//      and returns mediaPending [{platform, url}], noted on the activity row;
//   2. everything else still refuses with media_url_dead + {url, platform}, HTTP 409:
//      a dead render under the mirror path (the 2026-08 incident the gate exists for),
//      a past slot, another host, and any brand without publicMediaBaseUrl;
//   3. the PRE-FIRE probe stays fail-closed: an approved own-site-pending post whose URL
//      is still 404 when it is due is not published (no Graph call) and records the
//      terminal failure that parks it.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-own-site-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });
// Multi-client layout up front, so the /api face (which migrates a legacy root) reads the
// same tree as the lib calls.
const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
initMultiClient();
const ROOT = clientRoot('default');
fs.mkdirSync(path.join(ROOT, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data', 'media', 'card.png'), 'x');

// Every path 404s: the OG card is not released yet, the mirror render was never synced.
const server = http.createServer((req, res) => { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html>not found</html>'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const SITE = `http://127.0.0.1:${port}`;
const OTHER = `http://localhost:${port}`; // same server, different host name
const FUTURE = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
const PAST = new Date(Date.now() - 3600 * 1000).toISOString();

const { setConfig, getConfig } = await import('../lib/config.mjs');
const w = await import('../lib/writes.mjs');
const { ownSitePendingUrl } = await import('../lib/public-media.mjs');
const { getActivity } = await import('../lib/scheduler.mjs');
const planAbs = () => path.join(ROOT, 'data', 'plans', 'camp', 'post-plan.json');
const readPost = (id) => JSON.parse(fs.readFileSync(planAbs(), 'utf8')).posts.find((p) => p.id === id);
const mk = (id, imageUrl, scheduledAt = FUTURE) => w.createPost({
  campaign: 'camp',
  post: { id, type: 'image', platforms: ['instagram'], scheduledAt, path: 'data/media/card.png', imageUrl, caption: 'a calm honest note about the new article' },
  actor: 'agent:claude',
});
const setBase = (v) => setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { publicMediaBaseUrl: v } } });

try {
  // ===== pure rule =====
  ok(ownSitePendingUrl('https://pendpost.com/og/blog/a.png', 'https://www.pendpost.com/media') === true, 'same site (www. ignored), outside the mirror path -> own-site');
  ok(ownSitePendingUrl('https://WWW.PendPost.com/og/a.png', 'https://pendpost.com/media/') === true, 'host compare is case-insensitive');
  ok(ownSitePendingUrl('https://pendpost.com/media/clip.png', 'https://pendpost.com/media') === false, 'a render under the mirror path is NOT exempt (the 2026-08 mirror-404 case)');
  ok(ownSitePendingUrl('https://cdn.example.com/og/a.png', 'https://pendpost.com/media') === false, 'another host is not own-site');
  ok(ownSitePendingUrl('https://pendpost.com/og/a.png', '') === false && ownSitePendingUrl('https://pendpost.com/og/a.png', null) === false, 'no publicMediaBaseUrl -> no exemption');
  ok(ownSitePendingUrl('https://pendpost.com/a.png', 'https://pendpost.com') === false, 'a mirror at the site root leaves no path outside it -> no exemption');
  const { underMirrorPath } = await import('../lib/public-media.mjs');
  ok(underMirrorPath('https://www.pendpost.com/media/x.png', 'https://pendpost.com/media') === true && underMirrorPath('https://pendpost.com/og/x.png', 'https://pendpost.com/media') === false, 'underMirrorPath tells a mirror render from another own-site URL');
  ok(underMirrorPath('https://pendpost.com/x.png', 'https://pendpost.com') === true && underMirrorPath('https://cdn.example.com/media/x.png', 'https://pendpost.com/media') === false && underMirrorPath('https://pendpost.com/media/x.png', '') === false, 'a root mirror covers the whole site; another host or no base is not the mirror');

  ok(setBase(`${SITE}/media`).ok !== false, 'brand publicMediaBaseUrl points at its own site');
  await w.createCampaign({ id: 'camp', note: 'camp', timezone: 'UTC', actor: 'owner' });
  await mk('og', `${SITE}/og/blog/a.png`);
  await mk('mirror', `${SITE}/media/card.png`);
  await mk('pastog', `${SITE}/og/blog/b.png`, PAST);
  await mk('other', `${OTHER}/og/blog/c.png`);

  // ===== 1. own-site, future -> approved with mediaPending =====
  const a1 = await w.approvePost({ campaign: 'camp', postId: 'og', actor: 'owner' });
  ok(a1.ok === true && readPost('og').approval === 'approved', `own-site OG card not live yet + future slot -> approved (got ${JSON.stringify(a1).slice(0, 200)})`);
  ok(Array.isArray(a1.mediaPending) && a1.mediaPending.length === 1 && a1.mediaPending[0].platform === 'instagram' && a1.mediaPending[0].url === `${SITE}/og/blog/a.png`,
    `success carries mediaPending [{platform, url}] (got ${JSON.stringify(a1.mediaPending)})`);
  const row = getActivity(20).find((e) => e.action === 'approve' && e.postId === 'og');
  ok(row && /not live yet/i.test(row.errorMessage || '') && row.errorMessage.includes('/og/blog/a.png'), `the approve activity row notes the pending media (got ${row && row.errorMessage})`);

  // ===== 2. the refusals stay, with {url, platform} =====
  const a2 = await w.approvePost({ campaign: 'camp', postId: 'mirror', actor: 'owner' });
  ok(a2.code === 'media_url_dead' && a2.url === `${SITE}/media/card.png` && a2.platform === 'instagram', `a dead mirror render is still refused with {url, platform} (got ${JSON.stringify(a2).slice(0, 220)})`);
  ok(a2.fix === 'publish-media' && /not published to your site yet/.test(a2.message) && /mirror-media\.mjs/.test(a2.message) && /deploy the site/.test(a2.message),
    `an unmirrored render says the file is not on the site yet and names the fix (got ${JSON.stringify(a2).slice(0, 300)})`);
  const a3 = await w.approvePost({ campaign: 'camp', postId: 'pastog', actor: 'owner' });
  ok(a3.code === 'media_url_dead', 'an own-site URL on a slot already past is refused');
  const a4 = await w.approvePost({ campaign: 'camp', postId: 'other', actor: 'owner' });
  ok(a4.code === 'media_url_dead' && a4.platform === 'instagram', 'a dead URL on another host is refused');
  ok(a4.fix === 'edit' && !/mirror-media/.test(a4.message) && /image link/.test(a4.message), `a dead third-party link is an edit fix, not a mirror run (got ${JSON.stringify(a4).slice(0, 300)})`);
  const { handleApi } = await import('../lib/api.mjs');
  const req = Readable.from([Buffer.from(JSON.stringify({ actor: 'owner' }))]);
  req.method = 'POST'; req.headers = { 'content-type': 'application/json' };
  const res = { statusCode: 0, body: null, writeHead(s) { this.statusCode = s; }, end(b) { this.body = b; } };
  await handleApi(req, res, new URL('http://127.0.0.1/api/plans/camp/posts/other/approve'));
  const body = JSON.parse(res.body);
  ok(res.statusCode === 409 && body.code === 'media_url_dead' && body.url && body.platform === 'instagram', `/api answers 409 media_url_dead with url + platform (got ${res.statusCode} ${res.body.slice(0, 160)})`);
  ok(setBase('').ok !== false, 'brand without publicMediaBaseUrl');
  await mk('nobase', `${SITE}/og/blog/d.png`);
  const a5 = await w.approvePost({ campaign: 'camp', postId: 'nobase', actor: 'owner' });
  ok(a5.code === 'media_url_dead', 'a brand without publicMediaBaseUrl gets no exemption');

  // ===== 3. the pre-fire probe stays fail-closed =====
  const plan = JSON.parse(fs.readFileSync(planAbs(), 'utf8'));
  const due = plan.posts.find((p) => p.id === 'og');
  due.scheduledAt = PAST; // release day came, the card is still 404
  fs.writeFileSync(planAbs(), JSON.stringify(plan, null, 2));
  fs.writeFileSync(path.join(ROOT, '.env'), 'META_PAGE_ID=1\nMETA_PAGE_TOKEN=tok\nMETA_IG_USER_ID=2\n');
  const graphCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => {
    const u = String(url);
    if (u.startsWith(SITE) && (init.method || 'GET') === 'HEAD') return realFetch(url, init);
    graphCalls.push(u);
    return Promise.resolve({ ok: false, status: 500, headers: new Headers(), text: () => Promise.resolve('{}'), json: () => Promise.resolve({}) });
  };
  try {
    const meta = await import('../scripts/meta-social.mjs');
    meta.RUN.results.length = 0;
    // The scheduler spawns engines with PENDPOST_ROOT = the client root (media resolves there).
    process.env.PENDPOST_ROOT = ROOT;
    try { await meta.cmdPublishDue({ plan: planAbs(), only: 'og' }); } finally { process.env.PENDPOST_ROOT = WS; }
    const r = meta.RUN.results.find((x) => x.postId === 'og' && x.platform === 'instagram');
    ok(r && r.ok === false && /re-mirror the render/.test(r.errorMessage || ''), `the due post is not fired: a failed row with the dead-URL diagnosis (got ${JSON.stringify(r)})`);
    ok(!graphCalls.some((u) => u.includes('/media')), `no Instagram container call was made (graph calls: ${JSON.stringify(graphCalls)})`);
    const after = readPost('og');
    ok(!after.igMediaId && after.status !== 'posted', 'the post is not published');
    const { isTerminalRefusal } = await import('../lib/publish-hold.mjs');
    const att = (after.attempts || []).filter((a) => a.platform === 'instagram').pop();
    ok(att && isTerminalRefusal(att), 'the failure is a terminal refusal, so the publish hold parks the post on the first strike');
  } finally {
    globalThis.fetch = realFetch;
  }
} catch (e) {
  failures += 1;
  console.error('FAIL -', e.stack || e.message);
} finally {
  server.close();
  fs.rmSync(WS, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
