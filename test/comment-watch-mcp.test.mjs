#!/usr/bin/env node
// test/comment-watch-mcp.test.mjs - THE THIRD FACE (parity-check dim 3, S9): the own-post
// comment inbox an agent sees over MCP is the SAME set the Studio sees. comment_inbox reads
// it, comment_inbox_refresh forces a sweep, comment_resolve marks one handled - all through
// the REAL handleRpc dispatch, bound to the SAME client root the HTTP + MCP faces bind.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-cw-mcp-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { handleRpc, TOOLS } = await import('../lib/mcp.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const { commentInbox } = await import('../lib/comment-watch.mjs');
const { withClient } = await import('../lib/context.mjs');
const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');

const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
const call = async (name, args = {}) => {
  const out = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return out.result;
};

try {
  // The three tools are registered.
  for (const n of ['comment_inbox', 'comment_inbox_refresh', 'comment_resolve']) {
    ok(TOOLS.some((t) => t.name === n), `${n} is a registered MCP tool`);
  }

  // Enable monitoring and seed two unanswered comments directly into the bound client's state.
  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { commentWatch: { enabled: true } } } });
  await asClient(async () => {
    const st = loadState();
    st.comments = {
      items: [
        { lane: 'youtube', platform: 'youtube', campaign: 'c1', postId: 'p1', commentId: 'a', author: 'x', text: 'hi', ts: '2026-08-06T10:00:00Z', permalink: null, foundAt: '2026-08-06T10:00:00Z' },
        { lane: 'youtube', platform: 'youtube', campaign: 'c1', postId: 'p1', commentId: 'b', author: 'y', text: 'yo', ts: '2026-08-06T11:00:00Z', permalink: null, foundAt: '2026-08-06T11:00:00Z' },
      ],
      seen: [], lastSweep: '2026-08-06T11:30:00Z', sources: { youtube: { ok: true } },
    };
    saveState();
  });

  // comment_inbox over MCP == commentInbox() in-process (the SAME function the GET route calls).
  const inboxRpc = await call('comment_inbox');
  const inboxDirect = await asClient(async () => commentInbox());
  ok(inboxRpc.structuredContent.unanswered === 2, 'comment_inbox (MCP) reports 2 unanswered');
  ok(inboxRpc.structuredContent.unanswered === inboxDirect.unanswered, 'the MCP inbox matches the in-process inbox (third-face parity)');
  const item = inboxRpc.structuredContent.posts[0].comments[0];
  ok(typeof item.key === 'string' && item.key.includes('p1'), 'each inbox comment carries its resolve key');

  // comment_resolve over MCP removes it; the next read shows one fewer.
  const resolved = await call('comment_resolve', { key: 'youtube:p1:a', reason: 'replied', actor: 'owner' });
  ok(resolved.structuredContent.ok === true && resolved.structuredContent.removed === 1, 'comment_resolve (MCP) marks one handled');
  const after = await call('comment_inbox');
  ok(after.structuredContent.unanswered === 1, 'the resolved comment left the inbox (1 remains)');

  // comment_inbox_refresh is inert-but-ok with no posted posts + no re-surface of the resolved one.
  const refreshed = await call('comment_inbox_refresh');
  ok(refreshed.structuredContent.ok === true, 'comment_inbox_refresh returns ok');
  ok(!refreshed.structuredContent.posts.some((p) => p.comments.some((c) => c.commentId === 'a')), 'a resolved comment never re-surfaces via refresh');
} catch (err) {
  failures += 1;
  console.error('  FAIL - threw:', (err && err.stack) || err);
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
