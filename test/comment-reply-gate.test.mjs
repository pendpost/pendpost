#!/usr/bin/env node
// test/comment-reply-gate.test.mjs - the B2 comment-reply confirm gate (ux-audit
// 2026-08-04, dim 2 gap G7 / matrix I9). reply_to_comment and reply_to_review post
// PUBLIC text on a live thread immediately - unlike the Radar reply lane there is
// no approval fence, so before this gate ANY connected MCP agent (including a
// prompt-injected one) could publish a reply with zero human gate. The fix mirrors
// the moderate_comment confirm pattern INSIDE the shared lib functions, so the MCP
// tool AND the REST route inherit it together:
//
//   (a) a NON-owner actor without confirm is refused fail-closed with a structured
//       needs_confirm error that names the fix (pass confirm: true).
//   (b) the same call WITH confirm:true executes (a real mock reply).
//   (c) the owner actor is UNCHANGED (the Studio Comments/Reviews panels post
//       actor:'owner' via app/src/lib/api.js and stay one-click, no confirm).
//   (d) reply_to_review gets the exact same gate.
//
// Plus the MCP face: both tool schemas accept confirm (additionalProperties is
// false, so an ungated schema would REJECT a confirming caller), neither REQUIRES
// it (the owner face), and both descriptions state the gate plainly.
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
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-replygate-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_MOCK_UNGRANTED;

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
  // A posted meta post the reply verb can resolve an object id from.
  const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
  initMultiClient();
  const plansDir = path.join(clientRoot('default'), 'data', 'plans');
  fs.mkdirSync(path.join(plansDir, 'c'), { recursive: true });
  fs.writeFileSync(path.join(plansDir, 'active-plans.json'), JSON.stringify({ plans: [{ id: 'c', path: 'data/plans/c/post-plan.json', active: true }] }, null, 2));
  fs.writeFileSync(path.join(plansDir, 'c', 'post-plan.json'), JSON.stringify({
    campaign: 'c', timezone: 'UTC',
    posts: [{ id: 'p1', platforms: ['instagram'], status: 'posted', igMediaId: 'IG1', approval: 'approved', scheduledAt: '2020-01-01T00:00:00Z' }],
  }, null, 2));

  // A real mock reviewId off the gbp engine (the same way gbp-reviews.test.mjs mints it).
  const revOut = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'gbp-social.mjs'), 'reviews', '--json', '--actor', 'inbox'], {
    cwd: REPO, env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: 'mock' }, encoding: 'utf8',
  });
  const revEnv = JSON.parse(revOut.trim().split('\n').pop());
  const rid = revEnv.results[0].items[0].commentId;

  const { replyToComment, replyToReview } = await import('../lib/writes.mjs');

  // ===== (a) non-owner actor WITHOUT confirm: fail-closed needs_confirm =====
  const agentBare = await replyToComment({ campaign: 'c', postId: 'p1', commentId: 'ig_1', text: 'hello there', actor: 'agent:claude' });
  ok(agentBare.ok !== true && agentBare.code === 'needs_confirm', 'replyToComment refuses a non-owner actor without confirm (needs_confirm)');
  ok(typeof agentBare.message === 'string' && agentBare.message.includes('confirm: true'), 'the needs_confirm error names the fix (pass confirm: true)');
  // The gate fires BEFORE campaign resolution: fail-closed even on garbage input.
  const agentGarbage = await replyToComment({ campaign: 'nope', postId: 'p1', commentId: 'x', text: 'hi', actor: 'agent:claude' });
  ok(agentGarbage.code === 'needs_confirm', 'the gate fires before campaign resolution (needs_confirm, not unknown_campaign)');

  // ===== (b) the same call WITH confirm:true executes =====
  const agentConfirmed = await replyToComment({ campaign: 'c', postId: 'p1', commentId: 'ig_1', text: 'hello there', actor: 'agent:claude', confirm: true });
  ok(agentConfirmed.ok === true && agentConfirmed.platform === 'meta' && agentConfirmed.commentId === 'ig_1', 'replyToComment with confirm:true executes for a non-owner actor (ok:true)');

  // ===== (c) the owner actor is unchanged (the Studio GUI path, no confirm) =====
  const ownerBare = await replyToComment({ campaign: 'c', postId: 'p1', commentId: 'ig_1', text: 'thanks for the note', actor: 'owner' });
  ok(ownerBare.ok === true && ownerBare.platform === 'meta', 'replyToComment as actor owner still executes WITHOUT confirm (GUI unchanged)');

  // ===== (d) reply_to_review: the exact same gate =====
  const revAgentBare = await replyToReview({ reviewId: rid, text: 'thanks so much', actor: 'agent:claude' });
  ok(revAgentBare.ok !== true && revAgentBare.code === 'needs_confirm', 'replyToReview refuses a non-owner actor without confirm (needs_confirm)');
  ok(typeof revAgentBare.message === 'string' && revAgentBare.message.includes('confirm: true'), 'the review needs_confirm error names the fix (pass confirm: true)');
  const revAgentConfirmed = await replyToReview({ reviewId: rid, text: 'thanks so much', actor: 'agent:claude', confirm: true });
  ok(revAgentConfirmed.ok === true && revAgentConfirmed.reviewId === rid, 'replyToReview with confirm:true executes for a non-owner actor (ok:true)');
  const revOwnerBare = await replyToReview({ reviewId: rid, text: 'thanks so much', actor: 'owner' });
  ok(revOwnerBare.ok === true && revOwnerBare.platform === 'gbp', 'replyToReview as actor owner still executes WITHOUT confirm (GUI unchanged)');

  // ===== MCP face: schema + description state the gate =====
  const { TOOLS, handleMcp } = await import('../lib/mcp.mjs');
  for (const name of ['reply_to_comment', 'reply_to_review']) {
    const tool = TOOLS.find((t) => t.name === name);
    ok(tool && 'confirm' in tool.inputSchema.properties, `${name} schema accepts confirm (additionalProperties:false would reject it otherwise)`);
    ok(tool && !tool.inputSchema.required.includes('confirm'), `${name} does not REQUIRE confirm (the owner face stays one-call)`);
    ok(tool && /confirm/.test(tool.description) && /owner/.test(tool.description), `${name} description states the non-owner confirm gate plainly`);
  }

  // The gate holds end-to-end through handleMcp (the face a chat agent actually calls).
  await rpc(handleMcp, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const mcpBare = await call(handleMcp, 'reply_to_comment', { campaign: 'c', postId: 'p1', commentId: 'ig_1', text: 'hello', actor: 'agent:claude' });
  ok(mcpBare.isError && mcpBare.payload.code === 'needs_confirm', 'MCP reply_to_comment without confirm is refused with needs_confirm');
  const mcpConfirmed = await call(handleMcp, 'reply_to_comment', { campaign: 'c', postId: 'p1', commentId: 'ig_1', text: 'hello', actor: 'agent:claude', confirm: true });
  ok(!mcpConfirmed.isError && mcpConfirmed.payload.ok === true, 'MCP reply_to_comment with confirm:true executes');
  const mcpRevBare = await call(handleMcp, 'reply_to_review', { reviewId: rid, text: 'thank you', actor: 'agent:claude' });
  ok(mcpRevBare.isError && mcpRevBare.payload.code === 'needs_confirm', 'MCP reply_to_review without confirm is refused with needs_confirm');
  const mcpRevConfirmed = await call(handleMcp, 'reply_to_review', { reviewId: rid, text: 'thank you', actor: 'agent:claude', confirm: true });
  ok(!mcpRevConfirmed.isError && mcpRevConfirmed.payload.ok === true, 'MCP reply_to_review with confirm:true executes');

  console.log(`[comment-reply-gate] ${failures ? 'FAIL' : 'OK'} - B2 non-owner confirm gate on reply_to_comment + reply_to_review (${pass} assertions${failures ? `, ${failures} failures` : ''}).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
