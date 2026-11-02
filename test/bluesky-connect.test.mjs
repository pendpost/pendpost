#!/usr/bin/env node
// test/bluesky-connect.test.mjs - the Bluesky dead end goes away (studio fix flow, finding F1).
//
// Bluesky is a Radar REPLY lane with no Setup card. A reply whose credentials were never set
// failed with needs_scope, whose copy says "a permission is missing, reconnecting fixes it",
// and the Studio's "Reconnect" led to a Setup page with no Bluesky card: a dead end.
//
// Proves, network-free (stubbed global.fetch):
//   (a) publish-due with no credentials records not_connected (not needs_scope); a stored app
//       password the PDS refuses stays needs_scope.
//   (b) not_connected is a credential failure: it parks on the first strike and its recovery
//       is 'reconnect', exactly like needs_scope.
//   (c) `auth` proves the pair with one createSession and writes the session handle as
//       BLUESKY_HANDLE (the account id the cloud vault keys on); a refusal throws with the
//       status, never the password.
//   (d) bluesky is a static connect lane: /api/connect validates its two fields and
//       /api/connect/status answers for it.
//   (e) a connect run that exits 0 releases the parked Bluesky replies (Bluesky has no health
//       probe, so the ceremony itself is the proof) and only those.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-bluesky-connect-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_MOCK_FAIL;
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
const ENV = path.join(WS, '.env');
const setEnv = (lines) => fs.writeFileSync(ENV, `${lines.join('\n')}\n`, { mode: 0o600 });

const realFetch = global.fetch;
const res = (body, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(body)), json: () => Promise.resolve(body) });
let sessionAnswer = { status: 200, body: { accessJwt: 'jwt-1', did: 'did:plc:me', handle: 'me.bsky.social' } };
const calls = [];
global.fetch = (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, body: init.body });
  if (u.includes('createSession')) return res(sessionAnswer.body, sessionAnswer.status);
  return res({ error: 'unexpected' }, 404);
};

function jsonReq(method, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  return req;
}
function getReq() {
  const req = Readable.from([]);
  req.method = 'GET';
  req.headers = {};
  return req;
}
function mockRes() {
  return { statusCode: 0, body: null, writeHead(s) { this.statusCode = s; }, setHeader() {}, end(b) { this.body = b; } };
}

try {
  const bsky = await import('../scripts/bluesky-social.mjs');
  const { recordAttempt, isTerminalRefusal, isCredentialFailure, failureRecovery } = await import('../lib/publish-hold.mjs');
  const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
  const { mutatePlan, resolvePlanPath } = await import('../lib/planWrite.mjs');
  const { loadPlanStore } = await import('../lib/plans.mjs');
  const { handleApi, noteConnectStart, noteConnectExit, readConnectStatus } = await import('../lib/api.mjs');

  // ---- (a) not_connected vs needs_scope ----------------------------------------------------
  const planFile = path.join(WS, 'bsky-plan.json');
  const reply = (id) => ({
    id, platforms: ['bluesky'], caption: 'a short honest reply', approval: 'approved', executionMode: 'fully-scheduled',
    scheduledAt: '2020-01-01T00:00:00Z', radarReplyTo: { source: 'bluesky', externalId: 'at://did:plc:x/app.bsky.feed.post/1', url: 'https://bsky.app/profile/x/post/1' },
  });
  fs.writeFileSync(planFile, JSON.stringify({ posts: [reply('r1')] }, null, 2));

  setEnv(['# no bluesky credentials']);
  bsky.RUN.results.length = 0;
  calls.length = 0;
  await bsky.cmdPublishDue({ plan: planFile });
  let row = bsky.RUN.results.find((r) => r.postId === 'r1');
  ok(row && row.ok === false && row.errorCode === 'not_connected', `no credentials -> not_connected (${row && row.errorCode})`);
  ok(/not connected/i.test(row.errorMessage) && !/permission/i.test(row.errorMessage), 'the message says not connected, never a missing permission');
  ok(!calls.some((c) => c.url.includes('createSession')), 'no credentials -> no sign-in attempt at all');

  setEnv(['BLUESKY_IDENTIFIER=me.bsky.social', 'BLUESKY_APP_PASSWORD=aaaa-bbbb-cccc-dddd']);
  sessionAnswer = { status: 401, body: { error: 'AuthenticationRequired', message: 'Invalid identifier or password' } };
  bsky.RUN.results.length = 0;
  await bsky.cmdPublishDue({ plan: planFile });
  row = bsky.RUN.results.find((r) => r.postId === 'r1');
  ok(row && row.errorCode === 'needs_scope', `a stored app password the PDS refuses stays needs_scope (${row && row.errorCode})`);

  // ---- (b) the classifier --------------------------------------------------------------------
  const nc = { ts: new Date().toISOString(), platform: 'bluesky', action: 'publish', ok: false, errorCode: 'not_connected', errorMessage: 'Bluesky is not connected (BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD not set)' };
  ok(isCredentialFailure(nc) === true, 'not_connected is a credential failure');
  ok(isTerminalRefusal(nc) === true, 'not_connected parks on the first strike');
  ok(failureRecovery({ code: 'not_connected', message: nc.errorMessage }) === 'reconnect', 'not_connected recovers by connecting (recovery reconnect)');
  ok(failureRecovery({ code: 'needs_scope', message: 'bluesky session HTTP 401' }) === 'reconnect', 'a refused session still recovers by reconnecting');

  // ---- (c) auth ------------------------------------------------------------------------------
  const written = [];
  sessionAnswer = { status: 200, body: { accessJwt: 'jwt-1', did: 'did:plc:me', handle: 'me.bsky.social' } };
  setEnv(['BLUESKY_IDENTIFIER=me@example.com', 'BLUESKY_APP_PASSWORD=aaaa-bbbb-cccc-dddd']);
  calls.length = 0;
  await bsky.cmdAuth({}, { writeEnv: (u) => written.push(u) });
  const sess = calls.find((c) => c.url.includes('createSession'));
  ok(sess && JSON.parse(sess.body).identifier === 'me@example.com', 'auth signs in with BLUESKY_IDENTIFIER');
  ok(written.length === 1 && written[0].BLUESKY_HANDLE === 'me.bsky.social', 'auth persists the session handle as BLUESKY_HANDLE (the cloud vault account id)');

  sessionAnswer = { status: 401, body: { error: 'AuthenticationRequired', message: 'Invalid identifier or password' } };
  let threw = null;
  try { await bsky.cmdAuth({}, { writeEnv: () => {} }); } catch (e) { threw = e; }
  ok(threw && /HTTP 401/.test(threw.message), 'a refused sign-in throws with the status');
  ok(threw && !threw.message.includes('aaaa-bbbb'), 'the refusal never carries the app password');

  setEnv(['# nothing']);
  threw = null;
  try { await bsky.cmdAuth({}, { writeEnv: () => {} }); } catch (e) { threw = e; }
  ok(threw && /not connected/i.test(threw.message), 'auth with nothing stored fails closed');

  // ---- (d) the static connect lane -----------------------------------------------------------
  {
    const r = mockRes();
    await handleApi(jsonReq('POST', { platform: 'bluesky', identifier: 'me.bsky.social' }), r, new URL('http://127.0.0.1/api/connect'));
    const body = JSON.parse(r.body);
    ok(r.statusCode === 400 && body.code === 'invalid_input' && /bluesky needs appPassword/.test(body.message), `a missing app password is refused before anything is written (${r.statusCode} ${body.message})`);
  }
  {
    const r = mockRes();
    await handleApi(getReq(), r, new URL('http://127.0.0.1/api/connect/status?platform=bluesky'));
    const body = JSON.parse(r.body);
    ok(r.statusCode === 200 && body.state === 'idle', `connect status answers for bluesky (${r.statusCode} ${body.state})`);
  }

  // ---- (e) a clean connect exit releases the parked replies -----------------------------------
  const cc = await createCampaign({ id: 'bsky', note: 'bluesky holds', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, `createCampaign: ${JSON.stringify(cc)}`);
  for (const id of ['b-cred', 'b-old', 'b-dup', 'x-cred']) {
    const r = await createPost({ campaign: 'bsky', post: { id, type: 'text', platforms: ['x'], scheduledAt: '2020-01-01T00:00:00Z', caption: 'a short honest note' }, actor: 'agent:claude' });
    assert.ok(r.ok, `createPost(${id}): ${JSON.stringify(r)}`);
    const a = await approvePost({ campaign: 'bsky', postId: id, actor: 'owner' });
    assert.ok(a.ok, `approvePost(${id}): ${JSON.stringify(a)}`);
  }
  const planPath = resolvePlanPath(loadPlanStore().campaigns.find((c) => c.id === 'bsky').path);
  const att = (errorCode, errorMessage, platform = 'bluesky') => ({ ts: new Date().toISOString(), platform, action: 'publish', ok: false, errorCode, errorMessage });
  await mutatePlan(planPath, (plan) => {
    const by = (id) => plan.posts.find((p) => p.id === id);
    for (const id of ['b-cred', 'b-old', 'b-dup']) by(id).platforms = ['bluesky'];
    recordAttempt(by('b-cred'), att('not_connected', nc.errorMessage));
    // A reply parked BEFORE this change, under the old needs_scope code: it is released too.
    recordAttempt(by('b-old'), att('needs_scope', 'BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD not set'));
    recordAttempt(by('b-dup'), att('invalid_input', 'radar reply needs a caption'));
    recordAttempt(by('x-cred'), att('engine_failure', 'X POST /tweets: HTTP 401 - Unauthorized', 'x'));
  });
  const getPost = (id) => loadPlanStore().campaigns.find((c) => c.id === 'bsky').posts.find((p) => p.id === id);
  ok(['b-cred', 'b-old', 'b-dup', 'x-cred'].every((id) => Boolean(getPost(id).publishHold)), 'all four posts start held');
  ok(getPost('b-cred').lastFailure?.recovery === 'reconnect', 'the not-connected reply asks for the connect (recovery reconnect)');

  noteConnectStart('bluesky');
  await noteConnectExit('bluesky', 1);
  ok(Boolean(getPost('b-cred').publishHold), 'a failed connect run releases nothing');

  noteConnectStart('bluesky');
  await noteConnectExit('bluesky', 0);
  ok(readConnectStatus('bluesky').state === 'connected', 'a clean exit reads connected');
  ok(!getPost('b-cred').publishHold, 'the not-connected reply is back in the fire loop');
  ok(!getPost('b-old').publishHold, 'the reply parked under the old needs_scope code is released too');
  ok(Boolean(getPost('b-dup').publishHold), 'a content hold on the same lane stays parked');
  ok(Boolean(getPost('x-cred').publishHold), 'a credential hold on ANOTHER lane stays parked');

  console.log(`[bluesky-connect] OK - Bluesky connects in the Studio and a clean connect releases its parked replies (${pass} assertions).`);
} catch (e) {
  console.error('FAIL:', e && e.stack || e);
  process.exitCode = 1;
} finally {
  global.fetch = realFetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
