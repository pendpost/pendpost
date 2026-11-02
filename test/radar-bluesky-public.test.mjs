// radar-bluesky-public.test.mjs - Radar 2.0 step 1, item 3: Bluesky search without a login.
//
// Before: a client with no Bluesky app password got a standing "Bluesky: not connected" row and no
// Bluesky results at all, though reading public posts needs no account. The Bluesky AppView answers
// app.bsky.feed.searchPosts unauthenticated at api.bsky.app (verified 200 on 2026-10-29;
// public.api.bsky.app answered 403). Proven IN-PROCESS against a stubbed global.fetch: zero network.
//
// Proofs:
//   (a) no app password: no createSession, every search goes to the public AppView with NO
//       Authorization header, and the items come back as a plain ok row;
//   (b) a 401/403 from the public endpoint degrades the lane (not_connected + detail), never
//       throws; after items were collected it keeps ok:true and CARRIES the degrade;
//   (c) with an app password configured, the authed path is used exactly as before (session on
//       the PDS, Bearer token on the PDS search);
//   (d) BLUESKY_PUBLIC_API_URL overrides the public base.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-bsky-public-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;
const ENV = path.join(WS, '.env');
const setEnv = (lines) => fs.writeFileSync(ENV, `${lines.join('\n')}\n`, { mode: 0o600 });

const realFetch = global.fetch;
const res = (body, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(body)), json: () => Promise.resolve(body) });
// Records { url, auth } for every call. Search calls are answered from `answers` in order.
function stub(answers, session = { accessJwt: 'jwt-1' }) {
  const calls = [];
  let i = 0;
  global.fetch = (url, init = {}) => {
    const u = String(url);
    const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || null;
    calls.push({ url: u, auth });
    if (u.includes('createSession')) return res(session);
    const a = answers[i++] || { body: { posts: [] } };
    return res(a.body || {}, a.status || 200);
  };
  return calls;
}
const post = (rkey, text = 'any tips for a social media scheduler?') => ({ uri: `at://did:plc:abc/app.bsky.feed.post/${rkey}`, author: { handle: 'someone.bsky.social' }, record: { text }, indexedAt: '2026-10-28T10:00:00.000Z' });

try {
  const bsky = await import('../scripts/bluesky-social.mjs');
  const row = () => bsky.RUN.results.find((r) => r && r.action === 'radar');
  const run = async (query) => { bsky.RUN.results.length = 0; await bsky.cmdRadar({ query: JSON.stringify(query) }); return row(); };
  const Q = { keywords: ['social media scheduler', 'crosspost'], lang: 'en' };

  // ---- (a) no app password: the public AppView, unauthenticated ---------------------------------
  setEnv(['# no Bluesky credentials']);
  let calls = stub([{ body: { posts: [post('a1'), post('a2')] } }, { body: { posts: [post('a2'), post('a3')] } }]);
  let r = await run(Q);
  ok(!calls.some((c) => c.url.includes('createSession')), 'no app password: no createSession call');
  ok(calls.length === 2 && calls.every((c) => c.url.startsWith(`${bsky.BLUESKY_PUBLIC_API}/xrpc/app.bsky.feed.searchPosts?`)), `every search goes to the public AppView (${calls.map((c) => new URL(c.url).host).join(',')})`);
  ok(bsky.BLUESKY_PUBLIC_API === 'https://api.bsky.app', 'the public base is api.bsky.app (public.api.bsky.app refuses search)');
  ok(calls.every((c) => c.auth === null), 'no Authorization header is sent');
  ok(calls.every((c) => new URL(c.url).searchParams.get('lang') === 'en'), 'the query lang still rides the public search');
  ok(r && r.ok === true && r.items.length === 3 && !r.degrade, `the items come back as a plain ok row (${r && r.items.length} items, deduped)`);

  // ---- (b) the public endpoint refuses ------------------------------------------------------------------
  calls = stub([{ status: 403, body: { error: 'Forbidden' } }]);
  r = await run(Q);
  ok(r && r.ok === false && r.error === 'not_connected' && r.scope === 'bluesky_app_password', `a 403 with nothing collected => not_connected with the app-password scope (got ${r && r.error})`);
  ok(r && /public search refused \(HTTP 403\)/.test(r.detail || ''), `the refusal names itself in detail (${r && r.detail})`);
  ok(calls.length === 1, 'the refusal stops the loop (no second request)');
  stub([{ body: { posts: [post('b1')] } }, { status: 401 }]);
  r = await run(Q);
  ok(r && r.ok === true && r.items.length === 1 && r.degrade && r.degrade.error === 'not_connected' && /HTTP 401/.test(r.degrade.detail), 'a 401 after items were collected keeps ok:true + items and carries the degrade');

  // ---- (c) with an app password: the authed path, unchanged ---------------------------------------------
  setEnv(['BLUESKY_IDENTIFIER=you.bsky.social', 'BLUESKY_APP_PASSWORD=app-pass', 'BLUESKY_PDS_URL=https://pds.example']);
  calls = stub([{ body: { posts: [post('c1')] } }, { body: { posts: [] } }]);
  r = await run(Q);
  ok(calls[0].url === 'https://pds.example/xrpc/com.atproto.server.createSession', 'an app password mints a session on the PDS first');
  const searches = calls.filter((c) => c.url.includes('searchPosts'));
  ok(searches.length === 2 && searches.every((c) => c.url.startsWith('https://pds.example/xrpc/') && c.auth === 'Bearer jwt-1'), 'the searches go to the PDS with the Bearer token');
  ok(r && r.ok === true && r.items.length === 1, 'the authed search returns its items');
  stub([{ status: 403 }]);
  r = await run(Q);
  ok(r && r.ok === false && r.error === 'needs_scope', `with an app password a 403 stays needs_scope (reconnect), as before (got ${r && r.error})`);

  // ---- (d) the override ---------------------------------------------------------------------------------
  setEnv(['BLUESKY_PUBLIC_API_URL=https://appview.example/']);
  calls = stub([{ body: { posts: [] } }, { body: { posts: [] } }]);
  r = await run(Q);
  ok(calls.every((c) => c.url.startsWith('https://appview.example/xrpc/app.bsky.feed.searchPosts?')), 'BLUESKY_PUBLIC_API_URL overrides the public base');
  ok(r && r.ok === true && r.items.length === 0 && !r.degrade, 'an empty public answer is a genuine empty ok row');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-bluesky-public] OK - Bluesky search runs without a login, degrades honestly when refused, and keeps the authed path (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-bluesky-public] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  global.fetch = realFetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
