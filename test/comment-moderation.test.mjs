#!/usr/bin/env node
// test/comment-moderation.test.mjs - comment moderation (spec 06, Pattern P3 engine
// verb + P4 parity pair + P9 mock-first). Proves, credential-free, no network:
//
//   ENGINE (mock, per lane):
//     1. every action in a lane's COMMENT_CAPABILITIES.moderate array returns
//        { ok:true, id } + a { action:'moderate', moderation } row (no offered
//        action is unsupported - the table can never over-promise the verb).
//     2. an action the lane does NOT support returns { ok:false, error:'unsupported_action' }.
//     3. an ungranted token (PENDPOST_MOCK_UNGRANTED) degrades to needs_scope (never a throw).
//
//   CONSISTENCY (the four faces cannot drift):
//     4. MODERATE_ACTIONS == the UNION of every lane's moderate array.
//     5. the moderate_comment tool's action enum == MODERATE_ACTIONS; it is a WRITE
//        tool with clientId + actor + confirm; trimmed lanes (tiktok/nostr) offer nothing.
//
//   TOOL (handleMcp, spec 06 §2 confirm-gate + lib mapping):
//     6. a bare Delete (no confirm) returns needs_confirm; confirm:true passes the gate.
//     7. a supported action with confirm:true returns ok:true.
//     8. an unsupported action surfaces error:'unsupported_action'; an ungranted scope
//        surfaces not_configured.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

// A throwaway root, set BEFORE importing lib (WORKSPACE_ROOT binds at import).
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-moderation-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

// The lanes with a real moderation verb (spec 06) + a sample comment id; linkedin
// alone needs the share urn (--id), so it carries one.
// mastodon is intentionally ABSENT (spec 06 review #5): its moderate set is now []
// (DELETE /statuses/{id} only removes your own toots), so it offers no moderation -
// asserted below alongside tiktok/nostr, not exercised as a moderating lane here.
const ENGINES = {
  meta: { script: 'scripts/meta-social.mjs', cid: 'ig_1' },
  youtube: { script: 'scripts/yt-social.mjs', cid: 'yt_1' },
  linkedin: { script: 'scripts/linkedin-social.mjs', cid: 'urn:li:comment:1', objectId: 'urn:li:share:1' },
  wordpress: { script: 'scripts/wordpress-social.mjs', cid: '42' },
  reddit: { script: 'scripts/reddit-social.mjs', cid: 't1_abc' },
  telegram: { script: 'scripts/telegram-social.mjs', cid: '123' },
  discord: { script: 'scripts/discord-social.mjs', cid: 'dc_1' },
};

function runEngine(script, args, extraEnv = {}) {
  const out = execFileSync(process.execPath, [path.join(REPO, script), ...args], {
    cwd: REPO, env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: 'mock', ...extraEnv }, encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function rpc(handleMcp, msg) {
  const req = Readable.from([Buffer.from(JSON.stringify(msg), 'utf8')]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json' };
  const chunks = [];
  const res = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  res.writeHead = () => {};
  await handleMcp(req, res);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : null;
}
let nextId = 100;
async function call(handleMcp, name, args) {
  const reply = await rpc(handleMcp, { jsonrpc: '2.0', id: (nextId += 1), method: 'tools/call', params: { name, arguments: args } });
  const result = reply && reply.result;
  const payload = result && result.content && result.content[0] ? JSON.parse(result.content[0].text) : null;
  return { isError: Boolean(result && result.isError), payload };
}

try {
  const { COMMENT_CAPABILITIES, MODERATE_ACTIONS, DESTRUCTIVE_MODERATE_ACTIONS, linkedinCommentNumericId, runLaneModerate } = await import('../lib/comments.mjs');

  // ===== (1-3) ENGINE per-lane matrix (mock) =====
  for (const [lane, def] of Object.entries(ENGINES)) {
    const supported = COMMENT_CAPABILITIES[lane].moderate;
    ok(supported.length > 0, `${lane}: has a non-empty moderate action set`);
    const objArgs = def.objectId ? ['--id', def.objectId] : [];
    for (const action of supported) {
      const env = runEngine(def.script, ['moderate', '--comment-id', def.cid, '--action', action, ...objArgs, '--json', '--actor', 'owner']);
      const row = (env.results || []).find((r) => r.action === 'moderate');
      ok(env.ok === true && typeof env.id === 'string' && env.id, `${lane}/${action}: mock moderate returns { ok:true, id }`);
      ok(row && row.ok === true && row.moderation === action && row.platform === lane, `${lane}/${action}: row carries { action:'moderate', moderation, platform }`);
    }
    // An action outside the lane's set is a structured unsupported_action (never a throw / false ok).
    const unsupported = MODERATE_ACTIONS.find((a) => !supported.includes(a));
    const uns = runEngine(def.script, ['moderate', '--comment-id', def.cid, '--action', unsupported, ...objArgs, '--json', '--actor', 'owner']);
    ok(uns.ok === false && uns.error === 'unsupported_action' && uns.lane === lane, `${lane}: an unsupported action (${unsupported}) returns { ok:false, error:'unsupported_action', lane }`);
    // An ungranted token degrades to needs_scope on BOTH the mock signal (P9).
    const ung = runEngine(def.script, ['moderate', '--comment-id', def.cid, '--action', supported[0], ...objArgs, '--json', '--actor', 'owner'], { PENDPOST_MOCK_UNGRANTED: lane });
    ok(ung.ok === false && ung.error === 'needs_scope' && typeof ung.scope === 'string', `${lane}: an ungranted token degrades to needs_scope (P9)`);
  }

  // A LIVE path (no mode) with NO credentials returns a REAL needs_scope (no network).
  const liveMeta = runEngine('scripts/meta-social.mjs', ['moderate', '--comment-id', 'c1', '--action', 'hide', '--json', '--actor', 'owner'], { PENDPOST_MODE: '' });
  ok(liveMeta.ok === false && liveMeta.error === 'needs_scope', 'meta: LIVE moderate with no creds degrades to needs_scope (no network)');

  // ===== (4-5) CONSISTENCY: table <-> verb <-> tool cannot drift =====
  const union = [...new Set(Object.values(COMMENT_CAPABILITIES).flatMap((c) => c.moderate))];
  ok(eq([...MODERATE_ACTIONS], union), `MODERATE_ACTIONS is the UNION of every lane's moderate array: ${union.join(',')}`);
  const { TOOLS } = await import('../lib/mcp.mjs');
  const tool = TOOLS.find((t) => t.name === 'moderate_comment');
  ok(tool, 'moderate_comment is registered in TOOLS');
  ok(eq(tool.inputSchema.properties.action.enum, [...MODERATE_ACTIONS]), 'the moderate_comment tool action enum == MODERATE_ACTIONS (one source, no drift)');
  const props = tool.inputSchema.properties;
  ok('clientId' in props && 'actor' in props && 'confirm' in props, 'moderate_comment schema has clientId + actor + confirm');
  ok(['actor', 'campaign', 'postId', 'commentId', 'action'].every((k) => tool.inputSchema.required.includes(k)), 'moderate_comment requires actor + campaign + postId + commentId + action');
  ok(COMMENT_CAPABILITIES.tiktok.moderate.length === 0 && COMMENT_CAPABILITIES.nostr.moderate.length === 0 && COMMENT_CAPABILITIES.mastodon.moderate.length === 0, 'trimmed lanes (tiktok/nostr/mastodon) offer NO moderation (GUI honesty - the verb cannot do it); mastodon DELETE only removes your own toots (review #5)');

  // DESTRUCTIVE_MODERATE_ACTIONS (spec 06 review #1/#4): the content-suppressing subset
  // both faces confirm-gate, and it is EXACTLY delete/hide/remove/spam - a subset of the
  // union, and the restorative approve/unhide/hold are NOT in it.
  ok(eq([...DESTRUCTIVE_MODERATE_ACTIONS], ['delete', 'hide', 'remove', 'spam']), 'DESTRUCTIVE_MODERATE_ACTIONS == [delete, hide, remove, spam]');
  ok([...DESTRUCTIVE_MODERATE_ACTIONS].every((a) => MODERATE_ACTIONS.includes(a)), 'every DESTRUCTIVE action is a member of the MODERATE_ACTIONS union');
  ok(['approve', 'unhide', 'hold'].every((a) => !DESTRUCTIVE_MODERATE_ACTIONS.includes(a)), 'the RESTORATIVE actions (approve/unhide/hold) are NOT confirm-gated');

  // ===== (6-8) TOOL: confirm-gate + lib mapping, via handleMcp =====
  const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
  initMultiClient();
  const plansDir = path.join(clientRoot('default'), 'data', 'plans');
  fs.mkdirSync(path.join(plansDir, 'c'), { recursive: true });
  fs.writeFileSync(path.join(plansDir, 'active-plans.json'), JSON.stringify({ plans: [{ id: 'c', path: 'data/plans/c/post-plan.json', active: true }] }, null, 2));
  fs.writeFileSync(path.join(plansDir, 'c', 'post-plan.json'), JSON.stringify({
    campaign: 'c', timezone: 'UTC',
    posts: [{ id: 'p1', platforms: ['instagram'], status: 'posted', igMediaId: 'IG1', approval: 'approved', scheduledAt: '2020-01-01T00:00:00Z' }],
  }, null, 2));

  const { handleMcp } = await import('../lib/mcp.mjs');
  await rpc(handleMcp, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });

  // (6) a bare Delete (no confirm) returns needs_confirm (spec 06 §2).
  const bareDelete = await call(handleMcp, 'moderate_comment', { campaign: 'c', postId: 'p1', commentId: 'ig_1', action: 'delete', actor: 'owner' });
  ok(bareDelete.isError && bareDelete.payload.code === 'needs_confirm', 'moderate_comment Delete without confirm:true is refused with needs_confirm');
  // confirm:true passes the gate (an unknown campaign proves it got past the confirm check).
  const confirmedPastGate = await call(handleMcp, 'moderate_comment', { campaign: 'nope', postId: 'p1', commentId: 'x', action: 'delete', actor: 'owner', confirm: true });
  ok(confirmedPastGate.isError && confirmedPastGate.payload.code === 'unknown_campaign', 'confirm:true passes the confirm gate (then fails on the unknown campaign, not needs_confirm)');

  // (7) a supported action with confirm:true returns ok:true.
  const hidden = await call(handleMcp, 'moderate_comment', { campaign: 'c', postId: 'p1', commentId: 'ig_1', action: 'hide', actor: 'owner', confirm: true });
  ok(!hidden.isError && hidden.payload.ok === true && hidden.payload.action === 'hide' && hidden.payload.platform === 'meta', 'moderate_comment hide (confirm:true) returns { ok:true, action:"hide", platform:"meta" }');

  // requireActor rejects empty/unknown.
  const noActor = await call(handleMcp, 'moderate_comment', { campaign: 'c', postId: 'p1', commentId: 'ig_1', action: 'hide', actor: 'unknown', confirm: true });
  ok(noActor.isError && noActor.payload.code === 'invalid_input', 'moderate_comment rejects actor "unknown" (requireActor)');

  // (8) an unsupported action for the lane surfaces error:'unsupported_action'.
  const unsupportedTool = await call(handleMcp, 'moderate_comment', { campaign: 'c', postId: 'p1', commentId: 'ig_1', action: 'approve', actor: 'owner', confirm: true });
  ok(unsupportedTool.isError && unsupportedTool.payload.error === 'unsupported_action', 'moderate_comment approve on a meta post surfaces error:"unsupported_action" (GUI honesty)');

  // an ungranted scope surfaces not_configured (the lib maps the engine needs_scope).
  process.env.PENDPOST_MOCK_UNGRANTED = 'meta';
  const ungrantedTool = await call(handleMcp, 'moderate_comment', { campaign: 'c', postId: 'p1', commentId: 'ig_1', action: 'hide', actor: 'owner', confirm: true });
  ok(ungrantedTool.isError && ungrantedTool.payload.code === 'not_configured', 'an ungranted scope surfaces not_configured (authorize prompt)');
  delete process.env.PENDPOST_MOCK_UNGRANTED;

  // ===== (9-12) LIB FACE: confirm gate + paused honesty + linkedin delete id (spec 06 review) =====
  const { moderateComment } = await import('../lib/writes.mjs');
  const envFile = path.join(clientRoot('default'), '.env');

  // (9) the confirm gate lives INSIDE moderateComment (spec 06 review #1/#4) so the REST
  // twin inherits it too: a destructive action without confirm returns needs_confirm.
  const libBareDelete = await moderateComment({ campaign: 'c', postId: 'p1', commentId: 'ig_1', action: 'delete', actor: 'owner' });
  ok(libBareDelete.ok !== true && libBareDelete.code === 'needs_confirm', 'moderateComment (lib face) rejects delete WITHOUT confirm -> needs_confirm');
  // executes WITH confirm:true (a real mock moderate on the meta lane).
  const libDelete = await moderateComment({ campaign: 'c', postId: 'p1', commentId: 'ig_1', action: 'delete', actor: 'owner', confirm: true });
  ok(libDelete.ok === true && libDelete.action === 'delete' && libDelete.platform === 'meta', 'moderateComment delete WITH confirm:true executes (ok:true)');
  // a RESTORATIVE action needs NO confirm: it passes straight to campaign resolution
  // (unknown_campaign here proves it got PAST the gate, not needs_confirm).
  const libApprove = await moderateComment({ campaign: 'nope', postId: 'p1', commentId: 'x', action: 'approve', actor: 'owner' });
  ok(libApprove.code === 'unknown_campaign', 'moderateComment approve (restorative) needs NO confirm (past the gate)');
  const libUnhide = await moderateComment({ campaign: 'nope', postId: 'p1', commentId: 'x', action: 'unhide', actor: 'owner' });
  ok(libUnhide.code === 'unknown_campaign', 'moderateComment unhide (restorative) needs NO confirm');

  // (10) paused-lane honesty (review #3): a paused meta lane emits { ok:true, paused:true,
  // skipped:'lane_paused' } - moderateComment maps it to a structured NON-success (never a
  // false ok:true "moderated" row). The pause flag is read from the client .env.
  fs.writeFileSync(envFile, 'META_PUBLISHING_PAUSED=true\n');
  const pausedMod = await moderateComment({ campaign: 'c', postId: 'p1', commentId: 'ig_1', action: 'hide', actor: 'owner', confirm: true });
  ok(pausedMod.ok !== true && pausedMod.error === 'lane_paused' && pausedMod.code === 'not_configured', 'a paused lane yields a NON-success (error:lane_paused), never a false ok:true (review #3)');
  fs.rmSync(envFile, { force: true });

  // (11) linkedin delete id (review #2/#6): URN -> trailing NUMERIC comment id.
  ok(linkedinCommentNumericId('urn:li:comment:(urn:li:activity:99,12345)') === '12345', 'linkedinCommentNumericId extracts the trailing numeric id from the URN');
  ok(linkedinCommentNumericId('7788') === '7788', 'linkedinCommentNumericId passes a bare numeric id through');
  // fail-closed: a token but no LINKEDIN_ORG_URN degrades to needs_scope, never a doomed 400.
  fs.writeFileSync(envFile, 'LINKEDIN_ACCESS_TOKEN=tok\n');
  const liNoActor = await runLaneModerate('linkedin', { action: 'delete', 'comment-id': 'urn:li:comment:(urn:li:activity:99,12345)', id: 'urn:li:share:1' });
  ok(liNoActor.ok !== true && liNoActor.error === 'needs_scope', 'linkedin moderate fails closed to needs_scope when LINKEDIN_ORG_URN is unset (review #6)');
  // with the org urn, the DELETE path carries the NUMERIC id in the {commentId} slot, not the URN.
  fs.writeFileSync(envFile, 'LINKEDIN_ACCESS_TOKEN=tok\nLINKEDIN_ORG_URN=urn:li:organization:1\n');
  let capturedUrl = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { capturedUrl = String(url); return { ok: true, status: 200, text: async () => '{}' }; };
  try {
    const liDel = await runLaneModerate('linkedin', { action: 'delete', 'comment-id': 'urn:li:comment:(urn:li:activity:99,12345)', id: 'urn:li:share:1' });
    ok(liDel.ok === true, 'linkedin moderate delete succeeds with token + org urn (stubbed transport)');
  } finally {
    globalThis.fetch = realFetch;
  }
  ok(typeof capturedUrl === 'string' && capturedUrl.includes('/comments/12345') && !capturedUrl.includes('/comments/urn'), 'linkedin DELETE path uses the NUMERIC comment id (/comments/12345), not the URN (review #2)');
  fs.rmSync(envFile, { force: true });

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[comment-moderation] OK - the moderate verb + tool: per-lane actions, unsupported/needs_scope degrade, confirm-gated Delete, table<->verb<->tool consistent (${pass} assertions).`);
} catch (err) {
  console.error(`[comment-moderation] FAIL - ${err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
