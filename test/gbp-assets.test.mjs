#!/usr/bin/env node
// gbp-assets.test.mjs - GBP location media gallery + attributes (spec 19, account
// management) run credential-free (mock) AND against a local HTTP stub (live path, no
// real Google network) so the two-step resumable upload sequence is provable end-to-end.
//
// Proves, end-to-end through the REAL engine entrypoint + the REAL lib read/write face:
//   1. mock mode: media-add (URL + local file) fabricate ok envelopes; an unknown
//      category/format -> invalid_input; media-list/attributes-get normalize their
//      shapes; attributes-set acknowledges (incl. a URL-type --value-type round trip);
//      all four DEGRADE to needs_scope (P9) when ungranted.
//   2. live mode, no network: category/format/source validation runs BEFORE any HTTP
//      call (invalid_input); a not-configured lane (no account/location ids) is a
//      FAILED read -> ok:false, code:'not_configured' - never a false-empty items:[].
//   3. live mode, local stub server (GBP_TEST_API/GBP_TEST_INFO_API overrides): the
//      media-add --source-url path makes exactly ONE POST; the media-add --file path
//      runs the startUpload -> raw byte upload (at the REAL /upload/v1/media/<name>
//      path) -> media.create sequence IN ORDER, and a 403 on the byte-upload leg alone
//      degrades to needs_scope; media-list/attributes-get normalize the stub's response;
//      attributes-set PATCHes with attributeMask=<attributeName>, coerces only the
//      literal true/false spellings (a numeric-looking string stays a string), and a
//      URL-type attribute round-trips through uriValues; a 403 from the stub degrades
//      to needs_scope.
//   4. the lib faces (listGbpMedia/getGbpAttributes/gbpMediaAdd/gbpAttributesSet)
//      require an actor on writes and map the engine degrades onto the shared envelope.
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

// PENDPOST_ROOT must be set BEFORE importing lib (util binds WORKSPACE_ROOT at import).
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-gbpassets-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_MOCK_UNGRANTED;
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'media', 'test.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0x03]));

// Run the engine binary directly. extraEnv can override/unset PENDPOST_MODE (null =
// delete) so the live path exercises the LIVE engine with no creds/network.
function runEngine(args, extraEnv = {}) {
  const env = { ...process.env, PENDPOST_ROOT: WS, ...extraEnv };
  for (const [k, v] of Object.entries(extraEnv)) if (v === null) delete env[k];
  const out = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'gbp-social.mjs'), ...args], { cwd: REPO, env, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

// ASYNC variant (execFile, not execFileSync) for calls that must hit a LOCAL http
// server running in THIS same process: execFileSync blocks the whole event loop for
// the child's lifetime, so the parent's http.createServer could never accept/respond
// to the child's request (a deadlock) - execFile lets the server's request handler
// run while the child is alive (mirrors test/discord-structured.test.mjs's pattern).
function runEngineAsync(args, extraEnv = {}) {
  const env = { ...process.env, PENDPOST_ROOT: WS, ...extraEnv };
  for (const [k, v] of Object.entries(extraEnv)) if (v === null) delete env[k];
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(REPO, 'scripts', 'gbp-social.mjs'), ...args], { cwd: REPO, env, encoding: 'utf8' }, (err, stdout) => {
      if (err && !stdout) { reject(err); return; }
      try { resolve(JSON.parse(stdout.trim().split('\n').pop())); } catch (parseErr) { reject(parseErr); }
    });
  });
}

const { listGbpMedia, getGbpAttributes, gbpMediaAdd, gbpAttributesSet } = await import('../lib/writes.mjs');

try {
  // ================= 1. MOCK MODE (credential-free, no network) =================
  const addByUrl = runEngine(['media-add', '--source-url', 'https://example.com/pic.jpg', '--category', 'INTERIOR', '--json', '--actor', 'owner']);
  ok(addByUrl.ok === true && addByUrl.results[0].action === 'media-add' && addByUrl.results[0].id && addByUrl.results[0].googleUrl,
    'mock media-add via --source-url fabricates { ok:true, id, googleUrl }');

  const addByFile = runEngine(['media-add', '--file', 'media/test.jpg', '--category', 'EXTERIOR', '--json', '--actor', 'owner']);
  ok(addByFile.ok === true && addByFile.results[0].action === 'media-add' && addByFile.results[0].id && addByFile.results[0].googleUrl,
    'mock media-add via --file fabricates { ok:true, id, googleUrl } (both upload paths accepted)');

  const badCategory = runEngine(['media-add', '--source-url', 'https://example.com/pic.jpg', '--category', 'NOT_A_CATEGORY', '--json', '--actor', 'owner']);
  ok(badCategory.ok === false && badCategory.code === 'invalid_input', 'mock media-add rejects an unknown category -> invalid_input');

  // Spec 19 review, MINOR-6: the mock validated category but discarded format
  // (`void format`), so an unsupported format (e.g. GIF) silently succeeded in
  // mock and only failed once live - mock/live parity now rejects it here too.
  const badFormat = runEngine(['media-add', '--source-url', 'https://example.com/pic.jpg', '--category', 'INTERIOR', '--format', 'GIF', '--json', '--actor', 'owner']);
  ok(badFormat.ok === false && badFormat.code === 'invalid_input', 'mock media-add rejects an unsupported format (GIF) -> invalid_input (mock/live parity, spec 19 review MINOR-6)');

  const list = runEngine(['media-list', '--json', '--actor', 'owner']);
  ok(list.ok === true && list.results[0].action === 'media-list' && Array.isArray(list.results[0].items) && list.results[0].items.length >= 2,
    'mock media-list emits 2+ fabricated items');
  ok(list.results[0].items.every((it) => it.id && it.format && it.category), 'every mock media item carries id/format/category');

  const attrs = runEngine(['attributes-get', '--json', '--actor', 'owner']);
  ok(attrs.ok === true && attrs.results[0].action === 'attributes-get' && Array.isArray(attrs.results[0].items) && attrs.results[0].items.length >= 1,
    'mock attributes-get emits a small fabricated attribute set');
  ok(attrs.results[0].items.every((it) => it.id && 'valueType' in it && Array.isArray(it.values)), 'every mock attribute carries id/valueType/values[]');

  const attrSet = runEngine(['attributes-set', '--attribute', 'attributes/has_wifi', '--value', 'true', '--json', '--actor', 'owner']);
  ok(attrSet.ok === true && attrSet.results[0].action === 'attributes-set' && attrSet.results[0].id === 'attributes/has_wifi',
    'mock attributes-set acknowledges { ok:true, id:<attributeName> }');

  // Spec 19 review, MINOR-3: --value-type picks the request field a URL-type
  // attribute needs (uriValues, not values) - the mock accepts it and echoes the
  // uriValues shape so a mock-mode test can drive the same contract as live.
  const urlAttrSetMock = runEngine(['attributes-set', '--attribute', 'attributes/from_the_business', '--value', 'https://example.com/about', '--value-type', 'URL', '--json', '--actor', 'owner']);
  ok(urlAttrSetMock.ok === true && urlAttrSetMock.results[0].id === 'attributes/from_the_business' && urlAttrSetMock.results[0].uriValues?.[0]?.uri === 'https://example.com/about',
    'mock attributes-set --value-type URL echoes { uriValues:[{uri}] } instead of values[]');

  const badValueType = runEngine(['attributes-set', '--attribute', 'attributes/has_wifi', '--value', 'true', '--value-type', 'NOT_A_TYPE', '--json', '--actor', 'owner']);
  ok(badValueType.ok === false && badValueType.code === 'invalid_input', 'mock attributes-set rejects an unknown --value-type -> invalid_input');

  for (const args of [
    ['media-add', '--source-url', 'https://example.com/x.jpg', '--category', 'INTERIOR'],
    ['media-list'],
    ['attributes-get'],
    ['attributes-set', '--attribute', 'attributes/has_wifi', '--value', 'true'],
  ]) {
    const ung = runEngine([...args, '--json', '--actor', 'owner'], { PENDPOST_MOCK_UNGRANTED: 'gbp' });
    ok(ung.ok === false && ung.error === 'needs_scope' && ung.scope === 'business.manage', `mock ${args[0]} ungranted degrades to needs_scope (scope business.manage)`);
  }

  // ================= 2. LIVE MODE, no network (validation-only degrades) =========
  const liveBadCategory = runEngine(['media-add', '--source-url', 'https://example.com/pic.jpg', '--category', 'NOT_A_CATEGORY', '--json', '--actor', 'owner'], { PENDPOST_MODE: null });
  ok(liveBadCategory.ok === false && liveBadCategory.code === 'invalid_input', 'live media-add rejects an unknown category -> invalid_input (before any network call)');

  const liveBothSources = runEngine(['media-add', '--source-url', 'https://example.com/pic.jpg', '--file', 'media/test.jpg', '--category', 'INTERIOR', '--json', '--actor', 'owner'], { PENDPOST_MODE: null });
  ok(liveBothSources.ok === false && liveBothSources.code === 'invalid_input', 'live media-add rejects --source-url AND --file together -> invalid_input');

  const liveNoSource = runEngine(['media-add', '--category', 'INTERIOR', '--json', '--actor', 'owner'], { PENDPOST_MODE: null });
  ok(liveNoSource.ok === false && liveNoSource.code === 'invalid_input', 'live media-add rejects neither --source-url nor --file -> invalid_input');

  const liveMissingFile = runEngine(['media-add', '--file', 'media/does-not-exist.jpg', '--category', 'INTERIOR', '--json', '--actor', 'owner'], { PENDPOST_MODE: null });
  ok(liveMissingFile.ok === false && liveMissingFile.code === 'invalid_input', 'live media-add rejects a missing local --file -> invalid_input (no network)');

  // A --file that EXISTS but resolves outside the client root must still be
  // rejected (the realpath containment guard, not just an ENOENT check).
  const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-gbpassets-outside-'));
  const outsideFile = path.join(OUTSIDE, 'outside.jpg');
  fs.writeFileSync(outsideFile, Buffer.from([0xff, 0xd8, 0xff]));
  const relEscape = path.relative(WS, outsideFile);
  const liveEscapeFile = runEngine(['media-add', '--file', relEscape, '--category', 'INTERIOR', '--json', '--actor', 'owner'], { PENDPOST_MODE: null });
  ok(liveEscapeFile.ok === false && liveEscapeFile.code === 'invalid_input', 'live media-add rejects a --file that EXISTS but resolves outside the client root -> invalid_input (containment, not just ENOENT)');
  fs.rmSync(OUTSIDE, { recursive: true, force: true });

  // A FAILED read (no GBP_ACCOUNT_ID/GBP_LOCATION_ID + LIVE engine) is ok:false,
  // code:'not_configured' - NEVER a false-empty { ok:true, items:[] }.
  const liveListUnconfigured = runEngine(['media-list', '--json', '--actor', 'owner'], { PENDPOST_MODE: null });
  ok(liveListUnconfigured.ok === false && liveListUnconfigured.code === 'not_configured', 'live media-list with no account/location ids is a FAILED read (not_configured), never false-empty');

  const liveAttrsUnconfigured = runEngine(['attributes-get', '--json', '--actor', 'owner'], { PENDPOST_MODE: null });
  ok(liveAttrsUnconfigured.ok === false && liveAttrsUnconfigured.code === 'not_configured', 'live attributes-get with no location id is a FAILED read (not_configured), never false-empty');

  const liveAttrsSetNoAttr = runEngine(['attributes-set', '--value', 'true', '--json', '--actor', 'owner'], { PENDPOST_MODE: null });
  ok(liveAttrsSetNoAttr.ok === false && liveAttrsSetNoAttr.code === 'invalid_input', 'live attributes-set requires --attribute -> invalid_input');

  const liveAttrsSetNoValue = runEngine(['attributes-set', '--attribute', 'attributes/has_wifi', '--json', '--actor', 'owner'], { PENDPOST_MODE: null });
  ok(liveAttrsSetNoValue.ok === false && liveAttrsSetNoValue.code === 'invalid_input', 'live attributes-set requires --value -> invalid_input');

  // ================= 3. LIVE MODE, local HTTP stub (the real sequence) ===========
  // GBP_TEST_API / GBP_TEST_INFO_API (test-only overrides, gbp-social.mjs) route the
  // four asset verbs at this local server instead of the real Google hosts, so the
  // two-step resumable upload is provable with no live credentials/network.
  const requests = [];
  let force403 = false;
  // Spec 19 review, MINOR-4: forces a 403 on ONLY the raw byte-upload leg (not the
  // whole server), so the test can prove that specific leg's error carries .status
  // and degrades media-add to needs_scope, distinct from the whole-server force403
  // below (which proves the same for a plain api()-routed read).
  let force403OnUpload = false;
  // Spec 19 review, MINOR-3: a tiny in-memory attribute store so attributes-set
  // (PATCH) and a subsequent attributes-get (GET) genuinely round-trip through the
  // stub - proving a URL-type attribute's uriValues write is what a follow-up read
  // sees, not just that the PATCH body was shaped correctly.
  const attributeStore = {
    'attributes/has_wifi': { name: 'attributes/has_wifi', valueType: 'BOOL', values: [true] },
    'attributes/from_the_business': { name: 'attributes/from_the_business', valueType: 'URL', uriValues: [] },
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    let body = null;
    try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { /* raw bytes upload */ }
    const u = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, pathname: u.pathname, query: Object.fromEntries(u.searchParams), body, bytes: raw.length });

    if (force403) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'forbidden - Business Profile API pending approval' } }));
      return;
    }
    if (req.method === 'POST' && u.pathname === '/accounts/1/locations/2/media:startUpload') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ resourceName: 'accounts/1/locations/2/media/abc123' }));
      return;
    }
    // The REAL media.upload path template (spec 19 review, BLOCKER-1):
    // /upload/v1/media/{+name} - NOT the startUpload resourceName's own "media"
    // collection path (the old, buggy '/v4'->'/upload/v4' rewrite happened to land
    // there only because GBP_TEST_API has no /v4 suffix, masking the live bug).
    if (req.method === 'POST' && u.pathname === '/upload/v1/media/accounts/1/locations/2/media/abc123') {
      if (force403OnUpload) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'forbidden - Business Profile API pending approval' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.method === 'POST' && u.pathname === '/accounts/1/locations/2/media') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'accounts/1/locations/2/media/abc123', googleUrl: 'https://stub.google/photo.jpg' }));
      return;
    }
    if (req.method === 'GET' && u.pathname === '/accounts/1/locations/2/media') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        mediaItems: [
          { name: 'accounts/1/locations/2/media/x1', mediaFormat: 'PHOTO', locationAssociation: { category: 'INTERIOR' }, thumbnailUrl: 'https://stub.google/x1-thumb.jpg', googleUrl: 'https://stub.google/x1.jpg', createTime: '2026-01-01T00:00:00Z' },
        ],
      }));
      return;
    }
    if (req.method === 'GET' && u.pathname === '/locations/2/attributes') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ attributes: Object.values(attributeStore) }));
      return;
    }
    if (req.method === 'PATCH' && u.pathname === '/locations/2/attributes') {
      const attr = body?.attributes?.[0];
      if (attr && attr.name && attributeStore[attr.name]) {
        attributeStore[attr.name] = {
          name: attr.name,
          valueType: attributeStore[attr.name].valueType,
          ...(attr.values !== undefined ? { values: attr.values } : {}),
          ...(attr.uriValues !== undefined ? { uriValues: attr.uriValues } : {}),
          ...(attr.repeatedEnumValue !== undefined ? { repeatedEnumValue: attr.repeatedEnumValue } : {}),
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: attr?.name || 'attributes/has_wifi' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `stub has no route for ${req.method} ${u.pathname}` } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const stubEnv = {
    PENDPOST_MODE: null,
    GBP_ACCOUNT_ID: '1',
    GBP_LOCATION_ID: '2',
    GBP_ACCESS_TOKEN: 'stub-access-token',
    GBP_TOKEN_EXPIRES_AT: String(Date.now() + 24 * 60 * 60 * 1000),
    GBP_TEST_API: `http://127.0.0.1:${port}`,
    GBP_TEST_INFO_API: `http://127.0.0.1:${port}`,
  };
  // Only the GBP_* creds/overrides are .env-backed (readEnv()); PENDPOST_MODE is a
  // process env var read directly by lib/mode.mjs, never persisted to .env.
  const envVars = { ...stubEnv };
  delete envVars.PENDPOST_MODE;
  fs.writeFileSync(path.join(WS, '.env'), `${Object.entries(envVars).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o600 });

  try {
    requests.length = 0;
    const urlAdd = await runEngineAsync(['media-add', '--source-url', 'https://example.com/pic.jpg', '--category', 'INTERIOR', '--json', '--actor', 'owner'], stubEnv);
    ok(urlAdd.ok === true && urlAdd.results[0].id === 'accounts/1/locations/2/media/abc123' && urlAdd.results[0].googleUrl === 'https://stub.google/photo.jpg',
      'live media-add --source-url resolves { ok:true, id, googleUrl } from the stub');
    ok(requests.length === 1 && requests[0].method === 'POST' && requests[0].pathname === '/accounts/1/locations/2/media' && requests[0].body.sourceUrl === 'https://example.com/pic.jpg',
      'live media-add --source-url makes EXACTLY ONE POST carrying sourceUrl (no startUpload)');

    requests.length = 0;
    const fileAdd = await runEngineAsync(['media-add', '--file', 'media/test.jpg', '--category', 'EXTERIOR', '--format', 'PHOTO', '--json', '--actor', 'owner'], stubEnv);
    ok(fileAdd.ok === true && fileAdd.results[0].id === 'accounts/1/locations/2/media/abc123', 'live media-add --file resolves { ok:true, id } from the stub');
    ok(requests.length === 3, `live media-add --file makes exactly 3 requests (startUpload, byte upload, create) - got ${requests.length}`);
    ok(requests[0].pathname === '/accounts/1/locations/2/media:startUpload', 'request 1 is media:startUpload');
    ok(requests[1].pathname === '/upload/v1/media/accounts/1/locations/2/media/abc123' && requests[1].bytes > 0,
      'request 2 is the raw byte upload to /upload/v1/media/<resourceName> (spec 19 review, BLOCKER-1 - not a /v4->/upload/v4 rewrite), carrying the file bytes');
    ok(requests[2].pathname === '/accounts/1/locations/2/media' && requests[2].body.dataRef?.resourceName === 'accounts/1/locations/2/media/abc123' && requests[2].body.locationAssociation?.category === 'EXTERIOR',
      'request 3 is media.create with { dataRef:{resourceName}, locationAssociation:{category} } - the startUpload -> upload -> create sequence, in order');

    // Spec 19 review, MINOR-4: a 403 on ONLY the raw byte-upload leg (startUpload
    // and create both still succeed) must degrade the same way a 403 on any other
    // leg does - needs_scope, never a bare engine_failure.
    requests.length = 0;
    force403OnUpload = true;
    const uploadForbidden = await runEngineAsync(['media-add', '--file', 'media/test.jpg', '--category', 'EXTERIOR', '--json', '--actor', 'owner'], stubEnv);
    ok(uploadForbidden.ok === false && uploadForbidden.error === 'needs_scope' && uploadForbidden.scope === 'business.manage',
      'a 403 on ONLY the raw byte-upload leg degrades media-add --file to needs_scope (the error carries .status, spec 19 review MINOR-4)');
    force403OnUpload = false;

    requests.length = 0;
    const liveList = await runEngineAsync(['media-list', '--json', '--actor', 'owner'], stubEnv);
    ok(liveList.ok === true && liveList.results[0].items.length === 1 && liveList.results[0].items[0].id === 'accounts/1/locations/2/media/x1' && liveList.results[0].items[0].category === 'INTERIOR',
      'live media-list normalizes the stub\'s mediaItems[] to { id, format, category, thumbnailUrl, googleUrl, createTime }');

    const liveAttrs = await runEngineAsync(['attributes-get', '--json', '--actor', 'owner'], stubEnv);
    const liveWifiAttr = liveAttrs.results[0]?.items?.find((it) => it.id === 'attributes/has_wifi');
    ok(liveAttrs.ok === true && liveAttrs.results[0].items.length === 2 && liveWifiAttr && liveWifiAttr.valueType === 'BOOL',
      'live attributes-get normalizes the stub\'s attributes[] to { id, valueType, values }');

    requests.length = 0;
    const liveAttrSet = await runEngineAsync(['attributes-set', '--attribute', 'attributes/has_wifi', '--value', 'true', '--json', '--actor', 'owner'], stubEnv);
    ok(liveAttrSet.ok === true && liveAttrSet.results[0].id === 'attributes/has_wifi', 'live attributes-set resolves { ok:true, id:<attributeName> }');
    ok(requests.length === 1 && requests[0].method === 'PATCH' && requests[0].pathname === '/locations/2/attributes' && requests[0].query.attributeMask === 'attributes/has_wifi',
      'live attributes-set PATCHes /locations/{l}/attributes with attributeMask=<attributeName> (spec 19 review, BLOCKER-2 - updateAttributes has no updateMask field)');
    ok(requests[0].body.attributes?.[0]?.name === 'attributes/has_wifi' && requests[0].body.attributes?.[0]?.values?.[0] === true,
      'the PATCH body carries { attributes:[{name,values}] } with "true" coerced to a real boolean');

    // Spec 19 review, MINOR-3: a numeric-LOOKING string must survive as a string -
    // the old coerceAttrValue silently mis-typed it to a Number.
    requests.length = 0;
    const numericAttrSet = await runEngineAsync(['attributes-set', '--attribute', 'attributes/has_wifi', '--value', '12345', '--json', '--actor', 'owner'], stubEnv);
    ok(numericAttrSet.ok === true, 'live attributes-set accepts a numeric-looking string value');
    ok(requests[0].body.attributes?.[0]?.values?.[0] === '12345' && typeof requests[0].body.attributes[0].values[0] === 'string',
      'a numeric-looking string value is sent AS A STRING (not coerced to Number) - only the literal true/false spellings coerce (spec 19 review, MINOR-3)');

    // Spec 19 review, MINOR-3: a URL-type attribute round-trips through uriValues
    // (not values). Write it, then read the stub's stored resource directly
    // (bypassing the engine's own get-normalization) to prove the write actually
    // reached the resource a follow-up read would see.
    requests.length = 0;
    const urlAttrSet = await runEngineAsync(['attributes-set', '--attribute', 'attributes/from_the_business', '--value', 'https://example.com/about', '--value-type', 'URL', '--json', '--actor', 'owner'], stubEnv);
    ok(urlAttrSet.ok === true && urlAttrSet.results[0].id === 'attributes/from_the_business', 'live attributes-set accepts --value-type URL for a URL-type attribute');
    ok(requests.length === 1 && requests[0].query.attributeMask === 'attributes/from_the_business', 'the URL-type PATCH still uses attributeMask=<attributeName>');
    ok(requests[0].body.attributes?.[0]?.uriValues?.[0]?.uri === 'https://example.com/about' && requests[0].body.attributes?.[0]?.values === undefined,
      'the PATCH body carries uriValues (not values) for a URL-type attribute');
    const rtRes = await fetch(`http://127.0.0.1:${port}/locations/2/attributes`);
    const rtBody = await rtRes.json();
    const rtAttr = (rtBody.attributes || []).find((a) => a.name === 'attributes/from_the_business');
    ok(rtAttr && rtAttr.uriValues?.[0]?.uri === 'https://example.com/about', 'a URL-type attribute round-trips: the write is visible on a subsequent read of the same resource');

    force403 = true;
    const forbidden = await runEngineAsync(['media-list', '--json', '--actor', 'owner'], stubEnv);
    ok(forbidden.ok === false && forbidden.error === 'needs_scope' && forbidden.scope === 'business.manage', 'a 403 from the stub degrades media-list to needs_scope (scope business.manage)');
    force403 = false;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(path.join(WS, '.env'), { force: true });
  }

  // ================= 4. lib faces (writes.mjs) ====================================
  process.env.PENDPOST_MODE = 'mock';
  const libMedia = await listGbpMedia({});
  ok(libMedia.ok === true && Array.isArray(libMedia.items) && libMedia.items.length >= 2, 'listGbpMedia() resolves ok:true with the mock gallery items');

  const libAttrs = await getGbpAttributes();
  ok(libAttrs.ok === true && Array.isArray(libAttrs.items) && libAttrs.items.length >= 1, 'getGbpAttributes() resolves ok:true with the mock attribute set');

  const noActorAdd = await gbpMediaAdd({ sourceUrl: 'https://example.com/x.jpg', category: 'INTERIOR' });
  ok(noActorAdd.ok !== true && noActorAdd.code === 'invalid_input', 'gbpMediaAdd rejects a missing actor (invalid_input)');
  const unknownActorAdd = await gbpMediaAdd({ sourceUrl: 'https://example.com/x.jpg', category: 'INTERIOR', actor: 'unknown' });
  ok(unknownActorAdd.ok !== true && unknownActorAdd.code === 'invalid_input', 'gbpMediaAdd rejects actor "unknown"');
  const bothSourcesAdd = await gbpMediaAdd({ sourceUrl: 'https://example.com/x.jpg', filePath: 'media/test.jpg', category: 'INTERIOR', actor: 'owner' });
  ok(bothSourcesAdd.ok !== true && bothSourcesAdd.code === 'invalid_input', 'gbpMediaAdd rejects sourceUrl AND filePath together (invalid_input)');
  const noCategoryAdd = await gbpMediaAdd({ sourceUrl: 'https://example.com/x.jpg', actor: 'owner' });
  ok(noCategoryAdd.ok !== true && noCategoryAdd.code === 'invalid_input', 'gbpMediaAdd requires category (invalid_input)');

  const libAdd = await gbpMediaAdd({ sourceUrl: 'https://example.com/x.jpg', category: 'INTERIOR', actor: 'owner' });
  ok(libAdd.ok === true && libAdd.platform === 'gbp' && libAdd.id, 'gbpMediaAdd() succeeds via the mock engine { ok:true, id, platform:gbp }');

  const noActorSet = await gbpAttributesSet({ attribute: 'attributes/has_wifi', value: 'true' });
  ok(noActorSet.ok !== true && noActorSet.code === 'invalid_input', 'gbpAttributesSet rejects a missing actor (invalid_input)');
  const noValueSet = await gbpAttributesSet({ attribute: 'attributes/has_wifi', actor: 'owner' });
  ok(noValueSet.ok !== true && noValueSet.code === 'invalid_input', 'gbpAttributesSet requires value (invalid_input)');

  const libSet = await gbpAttributesSet({ attribute: 'attributes/has_wifi', value: 'true', actor: 'owner' });
  ok(libSet.ok === true && libSet.id === 'attributes/has_wifi' && libSet.platform === 'gbp', 'gbpAttributesSet() succeeds via the mock engine { ok:true, id, platform:gbp }');

  process.env.PENDPOST_MOCK_UNGRANTED = 'gbp';
  const libMediaScope = await listGbpMedia({});
  const libAttrsScope = await getGbpAttributes();
  const libAddScope = await gbpMediaAdd({ sourceUrl: 'https://example.com/x.jpg', category: 'INTERIOR', actor: 'owner' });
  const libSetScope = await gbpAttributesSet({ attribute: 'attributes/has_wifi', value: 'true', actor: 'owner' });
  delete process.env.PENDPOST_MOCK_UNGRANTED;
  ok(libMediaScope.ok === true && libMediaScope.needsScope === true && libMediaScope.items.length === 0, 'listGbpMedia ungranted resolves ok:true + needsScope, items:[] - the honest authorize affordance');
  ok(libAttrsScope.ok === true && libAttrsScope.needsScope === true && libAttrsScope.items.length === 0, 'getGbpAttributes ungranted resolves ok:true + needsScope, items:[]');
  ok(libAddScope.ok !== true && libAddScope.code === 'not_configured' && libAddScope.needsScope === true, 'gbpMediaAdd ungranted -> not_configured + needsScope (authorize affordance)');
  ok(libSetScope.ok !== true && libSetScope.code === 'not_configured' && libSetScope.needsScope === true, 'gbpAttributesSet ungranted -> not_configured + needsScope (authorize affordance)');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[gbp-assets] OK - mock fabrication + category rejection, live validation-only degrades, the real startUpload->upload->create sequence + attributes PATCH against a local stub, lib faces (${pass} assertions).`);
} catch (err) {
  console.error(`[gbp-assets] FAIL - ${err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
