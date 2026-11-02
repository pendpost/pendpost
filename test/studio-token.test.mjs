#!/usr/bin/env node
// test/studio-token.test.mjs - spec 56: owner-only REST actions need the per-process Studio
// token, not just "the request came through /api".
//
// What this pins:
//   (a) GET /api/session hands the token ONLY to same-origin fetch metadata or a registered
//       pendpost Origin; cross-site, a typed URL ('none'), a foreign Origin and a bare request
//       (curl) are all refused, and the answer is never cacheable.
//   (b) POST /api/config: without the token the write is agent-level (CONFIG_OWNER_ACTION unset,
//       so extraTools is refused); a WRONG token is refused outright (studio_token_invalid); the
//       right token is the owner path and writes the list.
//   (c) POST /api/radar/triage: without the token no owner label is written (RADAR_OWNER_ACTION
//       unset, the dismiss itself still runs); a wrong token is refused and changes nothing; the
//       right token writes the implicit "more" label.
//   (d) POST /api/dashboard-update: no token -> owner_token_required, wrong token ->
//       studio_token_invalid, right token -> past the gate.
//   (e) the token file: outside the workspace (~/.pendpost, here a temp override), 0600 in a
//       0700 dir, holds exactly this process's token, per-port name, removed on a clean exit.
//   (f) no HTTP route serves a token file or any dotfile: GET /media refuses dot segments, the
//       SPA static route never leaves app/dist, and asset_upload refuses the token file and
//       dotfiles as a filePath source (so an MCP caller cannot copy it into the media library).
//   (g) server.mjs allows the header through CORS and registers the session Origins.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-studio-token-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });
const TOKEN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-studio-token-home-'));
process.env.PENDPOST_STUDIO_TOKEN_DIR = path.join(TOKEN_DIR, '.pendpost');

let server;
try {
  const { initMultiClient, clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { loadState, saveState } = await import('../lib/state.mjs');
  const { handleApi } = await import('../lib/api.mjs');
  const { serveMedia } = await import('../lib/media.mjs');
  const { serveStatic } = await import('../lib/static.mjs');
  const { uploadAsset } = await import('../lib/writes.mjs');
  const T = await import('../lib/studio-token.mjs');

  initMultiClient();
  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  const cfgNow = () => asClient(() => getConfig());
  const TOKEN = T.studioToken();
  const H = T.STUDIO_TOKEN_HEADER;
  ok(typeof TOKEN === 'string' && TOKEN.length >= 40, 'a per-process token is minted from 32 random bytes');

  // Seed: Radar on with one query + an agent provider, and a small feed.
  const seeded = await asClient(() => setConfig({
    ifRev: getConfig().rev,
    actor: 'owner',
    set: { posting: { radar: {
      enabled: true,
      queries: [{ id: 'q1', label: 'Scheduling', enabled: true, keywords: ['scheduler'] }],
      agent: { provider: 'claude-code' },
    } } },
  }));
  ok(seeded.ok === true, `seed config (${seeded.code || 'ok'})`);
  const now = new Date().toISOString();
  const seed = (id) => ({ source: 'hackernews', externalId: id, url: `https://news.ycombinator.com/item?id=${id}`, author: `a_${id}`, text: `which scheduler for ${id}?`, matchedQuery: 'q1', ts: now, intentScore: 70, intentTags: [], suggestedAction: 'reply', scoredBy: 'agent', ingested: true, intent: 'ask_reco', authorRole: 'seeker', replyable: true, classifiedBy: 'agent' });
  asClient(() => {
    const st = loadState();
    st.radar = { signals: ['n1', 'w1', 'o1'].map(seed), seen: [], feedback: {} };
    saveState();
  });
  const more = () => asClient(() => (((loadState().radar.feedback || {}).q1 || {}).more || []).map((e) => e.externalId));
  const signalIds = () => asClient(() => (loadState().radar.signals || []).map((s) => s.externalId));

  T.setSessionOrigins(['http://localhost:5179']);
  // The three HTTP faces that read files (server.mjs dispatch, minus the auth/host gates).
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (url.pathname === '/media') return serveMedia(req, res, url);
    return serveStatic(req, res, url);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, { headers = {}, body } = {}) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, headers: r.headers, body: await r.json().catch(() => ({})) };
  };

  // ===== (a) GET /api/session =====
  let r = await call('GET', '/api/session', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
  ok(r.status === 200 && r.body.token === TOKEN && r.body.header === H, 'same-origin fetch metadata gets the token and the header name');
  ok(/no-store/.test(r.headers.get('cache-control') || ''), 'the session answer is Cache-Control: no-store');
  r = await call('GET', '/api/session', { headers: { Origin: 'http://localhost:5179', 'Sec-Fetch-Site': 'same-site' } });
  ok(r.status === 200 && r.body.token === TOKEN, 'a registered pendpost Origin on a sibling loopback port (same-site) gets the token');
  r = await call('GET', '/api/session', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  ok(r.status === 403 && !JSON.stringify(r.body).includes(TOKEN), 'cross-site fetch metadata is refused and never sees the token');
  r = await call('GET', '/api/session', { headers: { Origin: 'http://localhost:5179', 'Sec-Fetch-Site': 'cross-site' } });
  ok(r.status === 403, 'cross-site is refused even next to an allowed Origin');
  r = await call('GET', '/api/session', { headers: { 'Sec-Fetch-Site': 'none' } });
  ok(r.status === 403, "a typed URL ('none') is refused");
  r = await call('GET', '/api/session', { headers: { Origin: 'http://evil.example', 'Sec-Fetch-Site': 'same-site' } });
  ok(r.status === 403, 'an Origin outside the registered set is refused');
  r = await call('GET', '/api/session');
  ok(r.status === 403 && !JSON.stringify(r.body).includes(TOKEN), 'a bare request (curl, an agent HTTP client) is refused: the CLI reads the token file instead');
  r = await call('GET', '/api/session', { headers: { 'Sec-Fetch-Site': 'same-origin', [H]: 'stale-token' } });
  ok(r.status === 200, 'a stale token header never blocks the session refetch itself');

  // ===== (b) POST /api/config (CONFIG_OWNER_ACTION) =====
  const tools = ['mcp__exa__web_search_exa'];
  const setTools = (headers) => call('POST', '/api/config', { headers, body: { ifRev: cfgNow().rev, actor: 'owner', set: { posting: { radar: { agent: { extraTools: tools } } } } } });
  r = await setTools({});
  ok(r.status !== 200 && /Studio or by editing config\.json/.test(r.body.message || ''), 'no token: the config write is agent-level, so extraTools is refused');
  ok((cfgNow().posting.radar.agent.extraTools || []).length === 0, 'no token: nothing was written');
  r = await setTools({ [H]: `${TOKEN}x` });
  ok(r.status === 403 && r.body.code === 'studio_token_invalid', 'a wrong token is refused outright (403 studio_token_invalid)');
  ok((cfgNow().posting.radar.agent.extraTools || []).length === 0, 'wrong token: nothing was written');
  r = await call('POST', '/api/config', { headers: { [H]: 'x' }, body: { ifRev: cfgNow().rev, actor: 'owner', set: { posting: { locale: 'de-CH' } } } });
  ok(r.status === 403 && r.body.code === 'studio_token_invalid', 'a wrong token is refused even for a write that needs no owner proof');
  r = await setTools({ [H]: TOKEN });
  ok(r.status === 200 && r.body.ok === true, `the right token is the owner path (${r.status} ${r.body.code || ''})`);
  ok(cfgNow().posting.radar.agent.extraTools.join(',') === tools.join(','), 'right token: the list persisted');
  r = await call('POST', '/api/config', { body: { ifRev: cfgNow().rev, actor: 'owner', set: { posting: { locale: 'de-CH' } } } });
  ok(r.status === 200 && cfgNow().posting.locale === 'de-CH', 'no token: an ordinary config write still runs (agent-level, not rejected wholesale)');

  // ===== (c) POST /api/radar/triage (RADAR_OWNER_ACTION) =====
  const done = (id, headers) => call('POST', '/api/radar/triage', { headers, body: { source: 'hackernews', externalId: id, action: 'dismiss', actor: 'gui' } });
  r = await done('n1', {});
  ok(r.status === 200 && !more().includes('n1'), 'no token: the dismiss runs but writes NO owner label');
  ok(!signalIds().includes('n1'), 'no token: the dismiss itself happened');
  r = await done('w1', { [H]: 'not-the-token' });
  ok(r.status === 403 && r.body.code === 'studio_token_invalid', 'wrong token: the triage is refused');
  ok(signalIds().includes('w1') && !more().includes('w1'), 'wrong token: nothing changed');
  r = await done('o1', { [H]: TOKEN });
  ok(r.status === 200 && more().includes('o1'), 'right token: the owner "Done" writes the implicit "more" label');

  // ===== (d) POST /api/dashboard-update (owner-only by nature) =====
  r = await call('POST', '/api/dashboard-update');
  ok(r.status === 403 && r.body.code === 'owner_token_required', 'no token: the dashboard update is refused (owner_token_required)');
  r = await call('POST', '/api/dashboard-update', { headers: { [H]: 'nope' } });
  ok(r.status === 403 && r.body.code === 'studio_token_invalid', 'wrong token: the dashboard update is refused (studio_token_invalid)');
  // Past the gate, this mock-mode server never updates itself (lib/self-update.mjs refuses
  // with not_here), so the right-token call proves the gate let it through and can never
  // start a real pull or rebuild of this checkout.
  r = await call('POST', '/api/dashboard-update', { headers: { [H]: TOKEN } });
  ok(r.status === 409 && r.body.code === 'not_here', 'right token: the request passes the gate (a mock instance never updates itself)');
  // The status route the Studio polls during an update: a plain read (no token), with the
  // pid that reveals a restart and the update block naming the running version.
  r = await call('GET', '/api/dashboard-update');
  ok(r.status === 200 && r.body.ok === true && r.body.pid === process.pid, 'GET /api/dashboard-update: a read without the token, carries the server pid');
  ok(r.body.update && r.body.update.available === false && r.body.update.reason === 'not-here', 'GET /api/dashboard-update: a mock instance offers nothing');
  ok(r.body.update.running && typeof r.body.update.running.version === 'string' && 'commit' in r.body.update.running, 'GET /api/dashboard-update: names the running version and commit');
  ok('buildId' in r.body && 'building' in r.body, 'GET /api/dashboard-update: carries the bundle id and build flag');

  // ===== (e) the token file =====
  const tokenDir = path.join(TOKEN_DIR, '.pendpost');
  ok(T.studioTokenFile(8090) === path.join(tokenDir, 'studio-token'), 'the default port writes ~/.pendpost/studio-token');
  ok(T.studioTokenFile(8099) === path.join(tokenDir, 'studio-token-8099'), 'another port writes ~/.pendpost/studio-token-<port>');
  ok(!T.studioTokenFile(8090).startsWith(WS), 'the token file is outside the workspace');
  const file = T.writeStudioTokenFile(T.studioTokenFile(8090));
  ok(fs.readFileSync(file, 'utf8').trim() === TOKEN, 'the file holds exactly this process token');
  ok((fs.statSync(file).mode & 0o777) === 0o600, 'the file is 0600 (owner read/write only)');
  ok((fs.statSync(tokenDir).mode & 0o777) === 0o700, 'its directory is 0700');
  fs.writeFileSync(file, 'old-process-token\n', { mode: 0o644 });
  T.writeStudioTokenFile(file);
  ok(fs.readFileSync(file, 'utf8').trim() === TOKEN && (fs.statSync(file).mode & 0o777) === 0o600, 'a previous process file is overwritten, back to 0600');
  ok(T.studioTokenState({ headers: { [H]: '  ' } }) === 'absent' && T.studioTokenState({ headers: {} }) === 'absent', 'an empty or missing header is absent (agent-level), not a wrong token');
  ok(T.studioTokenState({ headers: { [H]: ` ${TOKEN} ` } }) === 'valid', 'surrounding whitespace (a `cat` of the file) still matches');
  ok(T.isStudioTokenPath(file) && T.isStudioTokenPath(T.studioTokenFile(8099)) && !T.isStudioTokenPath(path.join(WS, 'data', 'media', 'a.png')), 'isStudioTokenPath names the token files and nothing else');

  // ===== (f) no HTTP route serves a token file or a dotfile =====
  const dataDir = path.join(clientRoot(activeClientId()), 'data');
  fs.mkdirSync(path.join(dataDir, 'media'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, '.hidden'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, '.studio-token'), `${TOKEN}\n`);
  fs.writeFileSync(path.join(dataDir, '.studio-token-8099'), `${TOKEN}\n`);
  fs.writeFileSync(path.join(dataDir, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(dataDir, '.hidden', 'a.png'), 'x');
  fs.writeFileSync(path.join(dataDir, 'media', 'ok.png'), 'png-bytes');
  const getRaw = async (p) => { const res = await fetch(`${base}${p}`); return { status: res.status, text: await res.text() }; };
  for (const p of ['data/.studio-token', 'data/.studio-token-8099', 'data/./.studio-token', 'data/media/../.studio-token', 'data/.env', 'data/.hidden/a.png']) {
    const g = await getRaw(`/media?p=${encodeURIComponent(p)}`);
    ok((g.status === 403 || g.status === 404) && !g.text.includes(TOKEN), `GET /media?p=${p} is refused (${g.status})`);
  }
  const scoped = await getRaw(`/media?p=${encodeURIComponent('data/.studio-token')}&clientId=${activeClientId()}`);
  ok(scoped.status === 403 && !scoped.text.includes(TOKEN), 'the clientId-scoped /media form is refused too');
  const fine = await getRaw(`/media?p=${encodeURIComponent('data/media/ok.png')}`);
  ok(fine.status === 200 && fine.text === 'png-bytes', 'an ordinary media file is still served');
  for (const p of ['/.studio-token', '/..%2f..%2fdata%2f.studio-token', '/%2e%2e/%2e%2e/data/.studio-token', `/..%2f..%2f..%2f..%2f..%2f..%2f..%2f..%2f${encodeURIComponent(file)}`]) {
    const g = await getRaw(p);
    ok(!g.text.includes(TOKEN), `the static SPA route never serves a token file (${p})`);
  }
  const up = (filePath, filename) => asClient(() => uploadAsset({ filePath, filename, actor: 'agent:test' }));
  r = await up(file, 'tok.png');
  ok(r.ok !== true && /Studio token/.test(r.message || ''), 'asset_upload refuses the token file as a filePath source');
  ok(!fs.existsSync(path.join(dataDir, 'media', 'tok.png')), 'nothing landed in the media library');
  fs.symlinkSync(file, path.join(TOKEN_DIR, 'innocent.png'));
  r = await up(path.join(TOKEN_DIR, 'innocent.png'), 'tok2.png');
  ok(r.ok !== true, 'a symlink to the token file is refused (real path check)');
  r = await up(path.join(dataDir, '.env'), 'env.png');
  ok(r.ok !== true, 'a dotfile source (.env) is refused');
  fs.writeFileSync(path.join(TOKEN_DIR, 'real.png'), 'png');
  r = await up(path.join(TOKEN_DIR, 'real.png'), 'real.png');
  ok(r.ok === true, `an ordinary file is still uploaded (${r.code || 'ok'})`);
  // Identity, not name: a case variant, a symlink and a HARD LINK (a different name, no dot
  // segment anywhere) to the token file are all the same file.
  ok(T.isStudioTokenPath(path.join(tokenDir, 'Studio-Token')) && T.isStudioTokenPath(path.join(TOKEN_DIR, '.PENDPOST', 'STUDIO-TOKEN-8099')), 'a case-variant spelling of a token path is caught');
  ok(T.isStudioTokenPath(path.join(TOKEN_DIR, 'innocent.png')), 'a symlink to the token file is caught by identity');
  fs.linkSync(file, path.join(TOKEN_DIR, 'hardlink.png'));
  ok(T.isStudioTokenPath(path.join(TOKEN_DIR, 'hardlink.png')), 'a hard link to the token file is caught by identity');
  r = await up(path.join(TOKEN_DIR, 'hardlink.png'), 'tok3.png');
  ok(r.ok !== true && !fs.existsSync(path.join(dataDir, 'media', 'tok3.png')), 'asset_upload refuses a hard link to the token file');
  ok(!T.isStudioTokenPath(path.join(TOKEN_DIR, 'real.png')), 'an unrelated file is not a token file');
  // ANY dot segment of the real path, not just the basename.
  fs.mkdirSync(path.join(TOKEN_DIR, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(TOKEN_DIR, '.ssh', 'id.png'), 'key');
  r = await up(path.join(TOKEN_DIR, '.ssh', 'id.png'), 'id.png');
  ok(r.ok !== true, 'a file inside a dot directory is refused');
  fs.symlinkSync(path.join(TOKEN_DIR, '.ssh', 'id.png'), path.join(TOKEN_DIR, 'plain.png'));
  r = await up(path.join(TOKEN_DIR, 'plain.png'), 'plain.png');
  ok(r.ok !== true, 'a plain-named symlink into a dot directory is refused (the real path is checked)');
  // A root that itself sits under a dot directory (a .claude/worktrees/... checkout) still works.
  const dotRoot = path.join(TOKEN_DIR, '.claude', 'worktrees', 'wt');
  fs.mkdirSync(path.join(dotRoot, 'media'), { recursive: true });
  fs.writeFileSync(path.join(dotRoot, 'media', 'clip.png'), 'clip');
  fs.writeFileSync(path.join(dotRoot, '.env'), 'X=1');
  const inRoot = T.readUploadSource(path.join(dotRoot, 'media', 'clip.png'), [dotRoot]);
  ok(inRoot.ok === true && inRoot.buf.toString() === 'clip', "a file under a root's own dot prefix is read (and through the checked path)");
  ok(T.readUploadSource(path.join(dotRoot, '.env'), [dotRoot]).ok !== true, 'a dotfile inside that root is still refused');
  ok(T.readUploadSource(path.join(dotRoot, 'media', 'clip.png'), []).ok !== true, 'the same file outside any root counts the dot directory and is refused');

  // ===== (g) server.mjs wiring =====
  const serverSrc = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  ok(/Access-Control-Allow-Headers[^\n]*STUDIO_TOKEN_HEADER/.test(serverSrc), 'the CORS header allowlist lets the token header through');
  ok(/setSessionOrigins\(ALLOWED_ORIGINS\)/.test(serverSrc), 'server.mjs registers its SEC-1 Origins for the session gate');
  ok(/writeStudioTokenFile\(\)/.test(serverSrc), 'server.mjs writes the token file on boot');

  if (failures) throw new Error(`${failures} assertion(s) failed`);
  console.log(`[studio-token] OK - session gate, owner markers, dashboard-update gate, token file (${pass} assertions).`);
} catch (err) {
  console.error(`[studio-token] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(WS, { recursive: true, force: true });
  fs.rmSync(TOKEN_DIR, { recursive: true, force: true });
}
