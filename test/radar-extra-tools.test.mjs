// test/radar-extra-tools.test.mjs - Radar 2.0 step 4 (spec 55): bring-your-own READ-ONLY research
// tools for the agent scan (posting.radar.agent.extraTools).
//
// Proofs:
//   (a) validation: exact mcp__<server>__<tool> names only; wildcards, built-ins (Bash, Write, Edit,
//       NotebookEdit, WebFetch), our own pendpost server, the engage browser server and write-verb
//       tools are refused; dedupe and the cap hold;
//   (b) the owner gate: a non-owner actor is refused (agent is owner-only), an actor that merely
//       SAYS "owner" (any MCP caller can) cannot change the list either, the MCP config_set face is
//       refused, an unchanged echo passes, and only the server-verified owner path
//       (CONFIG_OWNER_ACTION, the Studio REST route) writes it;
//   (c) server resolution: only http/sse servers from the operator's Claude user config are copied
//       (type, url, headers), a stdio server is refused (it would inherit the child's credential),
//       a missing server is reported, never invented;
//   (d) the spawn: --allowed-tools carries AGENT_SCAN_TOOLS + the usable extra tools and nothing
//       else, the per-job --mcp-config carries pendpost plus exactly the copied servers, the brief
//       names the tools, and the job row records them; an invalid entry hand-edited into
//       config.json is dropped at spawn time.
//
// HERMETIC: every spawn goes to a fake binary via PENDPOST_AGENT_BIN_CLAUDE_CODE; the Claude user
// config is a temp file via PENDPOST_CLAUDE_USER_CONFIG. No network.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-extra-tools-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));

const BIN_VAR = 'PENDPOST_AGENT_BIN_CLAUDE_CODE';
const savedBin = process.env[BIN_VAR];
const savedUserCfg = process.env.PENDPOST_CLAUDE_USER_CONFIG;
let server;

// The operator's own Claude user config: one hosted http server (with a key in a header), one
// stdio server, one sse server under a key that needs normalising.
const USER_CFG = path.join(WS, 'claude.json');
fs.writeFileSync(USER_CFG, JSON.stringify({
  mcpServers: {
    exa: { type: 'http', url: 'https://mcp.exa.ai/mcp', headers: { 'x-api-key': 'exa-test-key' }, extra: 'dropped' },
    hn: { type: 'stdio', command: 'npx', args: ['-y', '@cyanheads/hn-mcp-server'], env: { SECRET: 'x' } },
    'x.local': { type: 'sse', url: 'http://127.0.0.1:8000/mcp' },
  },
}));
process.env.PENDPOST_CLAUDE_USER_CONFIG = USER_CFG;

// The recording child: writes its argv and the per-job MCP config to a file (its env is a floor, so
// the path is baked in), then answers like a clean run that found nothing.
const RECORD = path.join(WS, 'spawn-record.json');
const recordBin = path.join(WS, 'record-claude');
fs.writeFileSync(recordBin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
const prev = fs.existsSync(${JSON.stringify(RECORD)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(RECORD)}, 'utf8')) : [];
prev.push({ args, cfg });
fs.writeFileSync(${JSON.stringify(RECORD)}, JSON.stringify(prev));
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'found nothing', total_cost_usd: 0.01 }));
`);
fs.chmodSync(recordBin, 0o755);
const readRecord = () => (fs.existsSync(RECORD) ? JSON.parse(fs.readFileSync(RECORD, 'utf8')) : []);
const argAfter = (args, flag) => args[args.indexOf(flag) + 1];

try {
  const { setConfig, getConfig, CONFIG_OWNER_ACTION } = await import('../lib/config.mjs');
  const { extraToolProblem, validExtraTools, extraMcpServersFor, AGENT_SCAN_TOOLS, EXTRA_TOOLS_MAX } = await import('../lib/agent-runner.mjs');
  const { radarScanPrompt } = await import('../lib/radar-prompt.mjs');
  const { radarAgentScan } = await import('../lib/writes.mjs');
  const { handleRpc } = await import('../lib/mcp.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  const cfgNow = () => asClient(() => getConfig());
  const CLIENT_ROOT = clientRoot(activeClientId());
  fs.mkdirSync(CLIENT_ROOT, { recursive: true });
  fs.writeFileSync(path.join(CLIENT_ROOT, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\n');

  // ===== (a) validation =====
  ok(extraToolProblem('mcp__exa__web_search_exa') === null, 'an exact read tool name is valid');
  ok(extraToolProblem('mcp__hn-mcp-server__hn_search_content') === null, 'a dashed server name is valid');
  ok(extraToolProblem('mcp__xmcp__searchPostsRecent') === null, 'a camelCase read tool (searchPostsRecent) is valid: "Posts" is a noun there');
  ok(extraToolProblem('mcp__x__getPostsById') === null && extraToolProblem('mcp__hn__hn_get_thread') === null, 'get-style reads are valid');
  for (const bad of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Read']) {
    ok(extraToolProblem(bad) !== null, `built-in ${bad} is refused`);
  }
  ok(/wildcard/.test(extraToolProblem('mcp__exa__*') || ''), 'a server wildcard is refused');
  ok(extraToolProblem('mcp__exa') !== null, 'the whole-server form is refused');
  ok(/reserved/.test(extraToolProblem('mcp__pendpost__plan_delete_post') || ''), 'our own pendpost server is refused');
  ok(/reserved/.test(extraToolProblem('mcp__pendpost__radar_ingest') || ''), 'even radar_ingest is refused here: it rides AGENT_SCAN_TOOLS');
  ok(/reserved/.test(extraToolProblem('mcp__browser__browser_type') || ''), 'the engage browser server is refused');
  for (const w of ['mcp__xmcp__createPosts', 'mcp__x__deletePosts', 'mcp__r__post_comment', 'mcp__s__send_message', 'mcp__g__update_issue', 'mcp__x__likePost', 'mcp__r__reply_to_thread', 'mcp__x__repostPost', 'mcp__f__upload_file', 'mcp__sh__execute_command']) {
    ok(/write tool/.test(extraToolProblem(w) || ''), `write-verb tool ${w} is refused`);
  }
  ok(extraToolProblem('mcp__x__get_tweet') === null && extraToolProblem('mcp__r__list_comment_replies') === null, 'a leading-only verb used as a noun (get_tweet, list_comment_replies) stays valid');
  ok(extraToolProblem('mcp__a__b'.padEnd(200, 'x')) !== null, 'an over-long name is refused');
  ok(extraToolProblem(42) !== null && extraToolProblem('') !== null, 'a non-string or empty entry is refused');
  const v = validExtraTools(['mcp__exa__web_search_exa', ' mcp__exa__web_search_exa ', 'Bash', 'mcp__pendpost__config_set']);
  ok(v.tools.length === 1 && v.tools[0] === 'mcp__exa__web_search_exa', 'validExtraTools trims and dedupes');
  ok(v.rejected.length === 2 && v.rejected.every((x) => x.reason), 'validExtraTools reports each refusal with a reason');
  const many = Array.from({ length: EXTRA_TOOLS_MAX + 3 }, (_, i) => `mcp__s__read_${i}`);
  ok(validExtraTools(many).tools.length === EXTRA_TOOLS_MAX, `the list is capped at ${EXTRA_TOOLS_MAX}`);
  ok(validExtraTools('nope').tools.length === 0, 'a non-array is an empty list, never a throw');

  // ===== (c) server resolution from the operator's Claude user config =====
  const res = extraMcpServersFor(['mcp__exa__web_search_exa', 'mcp__exa__web_fetch_exa', 'mcp__hn__hn_search_content', 'mcp__x_local__searchPostsRecent', 'mcp__nope__search']);
  ok(res.tools.join(',') === 'mcp__exa__web_search_exa,mcp__exa__web_fetch_exa,mcp__x_local__searchPostsRecent', `usable tools = http + sse servers only (got ${res.tools.join(',')})`);
  ok(JSON.stringify(res.servers.exa) === JSON.stringify({ type: 'http', url: 'https://mcp.exa.ai/mcp', headers: { 'x-api-key': 'exa-test-key' } }), 'the http server is copied as type/url/headers and nothing else');
  ok(res.servers.x_local && res.servers.x_local.type === 'sse', 'a config key that needs normalising ("x.local") maps to its tool-name segment (x_local)');
  ok(!res.servers.hn, 'the stdio server is NOT copied');
  ok(res.unavailable.some((u) => u.tool === 'mcp__hn__hn_search_content' && /stdio/.test(u.reason)), 'the stdio refusal says why (it would inherit the credential)');
  ok(res.unavailable.some((u) => u.tool === 'mcp__nope__search' && /no MCP server/.test(u.reason)), 'a server the operator never installed is reported, never invented');
  ok(extraMcpServersFor(['mcp__exa__web_search_exa'], { file: path.join(WS, 'missing.json') }).tools.length === 0, 'no Claude config file = no extra tools');
  ok(!JSON.stringify(res.unavailable).includes('exa-test-key'), 'no reason string carries a server secret');

  // ===== (b) the owner gate =====
  await asClient(() => setConfig({
    ifRev: cfgNow().rev,
    actor: 'owner',
    set: { posting: { radar: {
      enabled: true,
      queries: [{ id: 'q1', label: 'Scheduling', enabled: true, keywords: ['scheduling'] }],
      sources: { reddit: { scan: true }, mastodon: { scan: false }, bluesky: { scan: false }, hackernews: { scan: false } },
      agent: { provider: 'claude-code' },
    } } },
  }));
  const tools = ['mcp__exa__web_search_exa', 'mcp__hn__hn_search_content'];
  let r = await asClient(() => setConfig({ ifRev: cfgNow().rev, actor: 'agent:claude', set: { posting: { radar: { agent: { extraTools: tools } } } } }));
  ok(r.ok !== true && /only the owner/.test(r.message || ''), 'a non-owner actor is refused (agent is an owner-only subtree)');
  r = await asClient(() => setConfig({ ifRev: cfgNow().rev, actor: 'owner', set: { posting: { radar: { agent: { extraTools: tools } } } } }));
  ok(r.ok !== true && /Studio or by editing config\.json/.test(r.message || ''), 'actor:"owner" alone (what any MCP caller can type) cannot change extraTools');
  const rpc = await asClient(() => handleRpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'config_set', arguments: { ifRev: cfgNow().rev, actor: 'owner', set: { posting: { radar: { agent: { extraTools: tools } } } } } } }));
  ok(JSON.stringify(rpc).includes('Studio or by editing config.json'), 'the MCP config_set face is refused too');
  ok(cfgNow().posting.radar.agent.extraTools.length === 0, 'nothing was written by the refused calls');
  r = await asClient(() => setConfig({ ifRev: cfgNow().rev, actor: 'owner', set: { posting: { radar: { agent: { extraTools: ['mcp__pendpost__plan_delete_post'] } } } }, [CONFIG_OWNER_ACTION]: true }));
  ok(r.ok !== true && /reserved/.test(r.message || ''), 'even the verified owner cannot add a pendpost tool (specific refusal)');
  r = await asClient(() => setConfig({ ifRev: cfgNow().rev, actor: 'owner', set: { posting: { radar: { agent: { extraTools: 'mcp__exa__web_search_exa' } } } }, [CONFIG_OWNER_ACTION]: true }));
  ok(r.ok !== true && /must be an array/.test(r.message || ''), 'a non-array is refused with a named message');
  r = await asClient(() => setConfig({ ifRev: cfgNow().rev, actor: 'owner', set: { posting: { radar: { agent: { extraTools: tools } } } }, [CONFIG_OWNER_ACTION]: true }));
  ok(r.ok === true, 'the server-verified owner path (CONFIG_OWNER_ACTION) writes the list');
  ok(cfgNow().posting.radar.agent.extraTools.join(',') === tools.join(','), 'the list persisted');
  ok(cfgNow().posting.radar.agent.provider === 'claude-code', 'a partial agent write keeps the provider (one-level merge)');
  const agentNow = cfgNow().posting.radar.agent;
  r = await asClient(() => setConfig({ ifRev: cfgNow().rev, actor: 'owner', set: { posting: { radar: { agent: { ...agentNow, dailyBudget: 2 } } } } }));
  ok(r.ok === true && cfgNow().posting.radar.agent.dailyBudget === 2, 'echoing the unchanged list with another agent key passes without the marker (not a change)');
  r = await asClient(() => setConfig({ ifRev: cfgNow().rev, actor: 'owner', set: { posting: { radar: { agent: { extraTools: [] } } } } }));
  ok(r.ok !== true, 'clearing the list is a change too: it needs the verified path (no silent edit either way)');
  ok(cfgNow().posting.radar.agent.extraTools.length === 2, 'the list is unchanged after the refused clear');
  const apiSrc = fs.readFileSync(new URL('../lib/api.mjs', import.meta.url), 'utf8');
  ok(/path: '\/api\/config', mcpTool: 'config_set',[\s\S]{0,600}\[CONFIG_OWNER_ACTION\]: isStudioOwner\(req\)/.test(apiSrc), 'the Studio REST route POST /api/config is the one that sets the marker, and only with the Studio token (spec 56)');

  // ===== (d) the spawn =====
  const BASE = radarScanPrompt([{ id: 'q1', keywords: ['x'] }]);
  ok(!BASE.includes('EXTRA RESEARCH TOOLS') && BASE.includes('your only tools are web search, web fetch and\n  radar_ingest'), 'no extra tools -> the brief is unchanged');
  process.env[BIN_VAR] = recordBin;
  r = await asClient(() => radarAgentScan({ actor: 'owner' }));
  ok(r.ok === true && r.job && r.job.state === 'done', 'the scan with extra tools runs to done');
  const rec = readRecord();
  ok(rec.length >= 1, `the child was spawned (records: ${rec.length})`);
  const research = rec[0];
  const allowed = argAfter(research.args, '--allowed-tools').split(',');
  ok(AGENT_SCAN_TOOLS.every((t) => allowed.includes(t)), 'the child keeps every AGENT_SCAN_TOOLS entry');
  ok(allowed.includes('mcp__exa__web_search_exa'), 'the usable extra tool is in --allowed-tools');
  ok(!allowed.includes('mcp__hn__hn_search_content'), 'the stdio-backed tool is NOT in --allowed-tools');
  ok(allowed.length === AGENT_SCAN_TOOLS.length + 1, `nothing else was added (got ${allowed.join(',')})`);
  ok(!allowed.some((t) => /^mcp__pendpost__/.test(t) && t !== 'mcp__pendpost__radar_ingest'), 'radar_ingest stays the only pendpost tool');
  ok(research.args.includes('--strict-mcp-config'), 'the child is still hermetic (--strict-mcp-config)');
  ok(Object.keys(research.cfg.mcpServers).sort().join(',') === 'exa,pendpost', `the per-job MCP config holds pendpost + exa only (got ${Object.keys(research.cfg.mcpServers).join(',')})`);
  ok(research.cfg.mcpServers.exa.url === 'https://mcp.exa.ai/mcp', 'the exa server definition reached the child');
  ok(research.cfg.mcpServers.pendpost.type === 'http' && /127\.0\.0\.1|localhost/.test(research.cfg.mcpServers.pendpost.url), 'pendpost\'s own server is untouched');
  const prompt = argAfter(research.args, '-p');
  ok(prompt.includes('EXTRA RESEARCH TOOLS') && prompt.includes('mcp__exa__web_search_exa'), 'the brief names the extra tool');
  ok(/Prefer them over WebSearch for FRESH social posts/.test(prompt), 'the brief tells the child to prefer them for fresh social posts');
  ok(/radar_ingest exactly as described below/.test(prompt) && /intent, authorRole, replyable, timing/.test(prompt), 'the brief keeps radar_ingest + the step 2 facts as the only way to report');
  ok(!prompt.includes('mcp__hn__hn_search_content'), 'an unusable tool is not named in the brief');
  ok(r.job.extraTools && r.job.extraTools.active.join(',') === 'mcp__exa__web_search_exa', 'the job row records the active extra tools');
  ok(r.job.extraTools.unavailable.some((u) => u.tool === 'mcp__hn__hn_search_content'), 'the job row records why a tool was unavailable');
  ok(!JSON.stringify(r.job).includes('exa-test-key'), 'the job row never carries a server secret');

  // A hand-edited config.json is not trusted: an invalid entry is dropped at spawn time.
  const cfgPath = path.join(CLIENT_ROOT, 'config.json');
  const stored = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  stored.radar.agent.extraTools = ['mcp__pendpost__plan_delete_post', 'Bash', 'mcp__exa__web_search_exa'];
  fs.writeFileSync(cfgPath, JSON.stringify(stored, null, 2));
  fs.rmSync(RECORD, { force: true });
  r = await asClient(() => radarAgentScan({ actor: 'owner' }));
  const rec2 = readRecord()[0];
  const allowed2 = argAfter(rec2.args, '--allowed-tools').split(',');
  ok(!allowed2.includes('mcp__pendpost__plan_delete_post') && !allowed2.includes('Bash'), 'hand-edited pendpost/Bash entries never reach --allowed-tools');
  ok(allowed2.includes('mcp__exa__web_search_exa'), 'the valid entry still does');
  ok(r.job.extraTools.unavailable.some((u) => u.tool === 'mcp__pendpost__plan_delete_post'), 'the dropped entry is reported on the job row');

  // No extra tools configured -> the spawn is exactly as before (no extra server, no extra tool).
  stored.radar.agent.extraTools = [];
  fs.writeFileSync(cfgPath, JSON.stringify(stored, null, 2));
  fs.rmSync(RECORD, { force: true });
  r = await asClient(() => radarAgentScan({ actor: 'owner' }));
  const rec3 = readRecord()[0];
  ok(argAfter(rec3.args, '--allowed-tools') === AGENT_SCAN_TOOLS.join(','), 'without extraTools the allow-list is exactly AGENT_SCAN_TOOLS');
  ok(Object.keys(rec3.cfg.mcpServers).join(',') === 'pendpost', 'without extraTools the MCP config is pendpost only');
  ok(r.job.extraTools === undefined, 'without extraTools the job row carries no extraTools key');
} catch (e) {
  failures += 1;
  console.error('  FAIL - threw:', e && e.stack ? e.stack : e);
} finally {
  if (server) server.close();
  if (savedBin === undefined) delete process.env[BIN_VAR]; else process.env[BIN_VAR] = savedBin;
  if (savedUserCfg === undefined) delete process.env.PENDPOST_CLAUDE_USER_CONFIG; else process.env.PENDPOST_CLAUDE_USER_CONFIG = savedUserCfg;
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
