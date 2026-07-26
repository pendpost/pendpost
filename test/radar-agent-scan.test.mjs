// test/radar-agent-scan.test.mjs - the agent research job lifecycle (spec 41 S4/S6/S8).
//
// Proofs:
//   (a) running -> done, and the counts are the SERVER'S TALLY: a stub that LIES about what it
//       found is ignored, because pendpost counts what actually landed in the feed;
//   (b) a non-zero exit is a `failed` job carrying the exit code + the child's own last words;
//   (c) the feed is UNTOUCHED by a failure that ingested nothing - nothing is invented;
//   (d) a second start while one runs is refused (never queued, never a second spend);
//   (e) Stop kills the child, ends the job failed/stopped, and KEEPS what was already
//       ingested - those were real findings;
//   (f) no provider / no queries / Radar off degrade honestly rather than throwing.
//
// HERMETIC: every spawn goes to a fake binary via PENDPOST_AGENT_BIN_CLAUDE_CODE.
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-agent-scan-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));

const BIN_VAR = 'PENDPOST_AGENT_BIN_CLAUDE_CODE';
const savedBin = process.env[BIN_VAR];
let server;

// A child that ingests 2 real signals and then CLAIMS it found 99. The liar again, in the
// other direction: the job row must report OUR tally, not its boast.
const ingestBin = path.join(WS, 'ingest-claude');
fs.writeFileSync(ingestBin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
const sig = (n) => ({ source: 'web', url: 'https://example.com/thread/' + n, text: 'what do you all use for scheduling posts?' });
fetch(cfg.mcpServers.pendpost.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'radar_ingest', arguments: { actor: 'agent:radar-scan', queryId: 'q1', signals: [sig(1), sig(2)] } } }) })
  .then(() => process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'I ingested 99 signals.', total_cost_usd: 0.4 })))
  .catch((e) => { process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: String(e.message) })); process.exit(1); });
`);
fs.chmodSync(ingestBin, 0o755);

const crashBin = path.join(WS, 'crash-claude');
fs.writeFileSync(crashBin, `#!/usr/bin/env node
process.stderr.write('the agent fell over\\n');
process.exit(7);
`);
fs.chmodSync(crashBin, 0o755);

// Ingests 1 signal, then hangs - so Stop has something real to interrupt AND something real
// to have already found.
const hangBin = path.join(WS, 'hang-claude');
fs.writeFileSync(hangBin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
fetch(cfg.mcpServers.pendpost.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'radar_ingest', arguments: { actor: 'agent:radar-scan', queryId: 'q1',
      signals: [{ source: 'web', url: 'https://example.com/found-before-stop', text: 'anyone know a good tool for this?' }] } } }) })
  .then(() => setInterval(() => {}, 1000));
`);
fs.chmodSync(hangBin, 0o755);

// Ingests NOTHING and says so - the honest empty result. The bug WS1 fixes: such a run never
// calls radar_ingest, and radar_ingest was the only writer of lastScan, so the panel's "last
// result" subtitle stayed stuck on the previous run ("gestern" right after a fresh scan).
const emptyBin = path.join(WS, 'empty-claude');
fs.writeFileSync(emptyBin, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'I searched and found nothing.', total_cost_usd: 0.1 }));
`);
fs.chmodSync(emptyBin, 0o755);

// WS2: found nothing, but proposes refined searches through the radar_ingest suggestions channel.
// The empty result becomes an actionable next step instead of a dead end.
const suggestBin = path.join(WS, 'suggest-claude');
fs.writeFileSync(suggestBin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
fetch(cfg.mcpServers.pendpost.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'radar_ingest', arguments: { actor: 'agent:radar-scan', queryId: 'q1', signals: [],
      suggestions: [{ label: 'Buffer alternative Mastodon', keywords: ['buffer alternative', 'mastodon scheduler'], reason: 'the threads found were about hiring, not tools' }] } } }) })
  .then(() => process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'found nothing; suggested 1 search' })))
  .catch((e) => { process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: String(e.message) })); process.exit(1); });
`);
fs.chmodSync(suggestBin, 0o755);

try {
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { radarAgentScan, radarAgentStop, listRadar, radarIngest } = await import('../lib/writes.mjs');
  const { AGENT_SCAN_TOOLS } = await import('../lib/agent-runner.mjs');
  const { handleRpc, TOOLS } = await import('../lib/mcp.mjs');
  const { loadState } = await import('../lib/state.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');

  // Bind the SAME client root the MCP + HTTP faces bind (lib/mcp.mjs callTool, lib/api.mjs
  // handleApi). Without this the test would write config at PENDPOST_ROOT while the child's
  // ingest lands under data/clients/default - two roots, and a green test proving nothing.
  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  // The .env lives in the BOUND client's root, not at PENDPOST_ROOT - that is where
  // readEnv/envPath resolve it from, and getting this wrong is exactly how the credential
  // "vanishes" for a spawned child.
  const CLIENT_ROOT = clientRoot(activeClientId());
  fs.mkdirSync(CLIENT_ROOT, { recursive: true });
  fs.writeFileSync(path.join(CLIENT_ROOT, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\n');

  // A real MCP face for the child to call, dispatching through the REAL handleRpc - so the
  // ingest path under test is the shipped one, not a stand-in.
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const out = await handleRpc(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.PENDPOST_PORT = String(server.address().port);

  // ===== tools are registered =====
  ok(TOOLS.some((t) => t.name === 'radar_agent_scan'), 'radar_agent_scan is a registered MCP tool');
  ok(TOOLS.some((t) => t.name === 'radar_agent_stop'), 'radar_agent_stop is a registered MCP tool');
  const scanTool = TOOLS.find((t) => t.name === 'radar_agent_scan');
  ok(scanTool.inputSchema.properties.clientId, 'radar_agent_scan declares clientId (parity)');
  ok(/no fallback/i.test(scanTool.description), 'the tool description states there is NO fallback scan');

  // ===== (f) Radar OFF => inert =====
  let r = await asClient(() => radarAgentScan({ actor: 'owner' }));
  ok(r.ok === true && r.enabled === false && r.job === null, 'Radar OFF => inert: no job, no spawn, no spend');

  await asClient(() => setConfig({
    ifRev: getConfig().rev,
    actor: 'owner',
    set: { posting: { radar: { enabled: true, queries: [{ id: 'q1', label: 'Scheduling', enabled: true, keywords: ['scheduling'] }] } } },
  }));

  // ===== (f) no provider => an honest refusal naming the fix =====
  r = await asClient(() => radarAgentScan({ actor: 'owner' }));
  ok(r.ok !== true && r.code === 'not_configured', 'no provider connected => not_configured, NEVER a silent fallback scan');
  ok(/no fallback/i.test(r.message || '') || /connect your agent/i.test(r.message || ''), 'the refusal tells the operator what to do');

  await asClient(() => setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { agent: { provider: 'claude-code' } } } } }));

  // ===== actor is required =====
  r = await asClient(() => radarAgentScan({}));
  ok(r.ok !== true && r.code === 'invalid_input', 'actor is required - a spend must be attributable');

  // ===== (a) running -> done, and the SERVER tallies =====
  process.env[BIN_VAR] = ingestBin;
  r = await asClient(() => radarAgentScan({ actor: 'owner' }));
  ok(r.ok === true && r.job && r.job.state === 'done', 'S4: a clean job runs and flips to done');
  ok(r.job.queryId === null, 'no queryId => ONE job covering every enabled query (never one child per query)');
  ok(r.job.providerId === 'claude-code', 'the job records which provider spent the money');
  ok(r.job.accepted === 2, `THE TALLY IS OURS: the stub claimed 99, we counted the 2 that actually landed (got ${r.job.accepted})`);
  ok(typeof r.job.finishedAt === 'string', 'a finished job carries finishedAt');

  let feed = await asClient(() => listRadar({}));
  ok(feed.items.length === 2, 'the ingested signals are in the ranked feed');
  ok(feed.items.every((s) => s.ingested === true), 'they carry ingested:true, so the UI badges them "from your agent"');
  ok(Array.isArray(feed.jobs) && feed.jobs[0].id === r.job.id, 'radar_list carries jobs[] newest-first so the panel can render the row');

  // ===== (b)+(c) a crash is failed, and invents nothing =====
  process.env[BIN_VAR] = crashBin;
  r = await asClient(() => radarAgentScan({ actor: 'owner' }));
  ok(r.job.state === 'failed', 'S6: a child that dies makes the job failed');
  ok(r.job.exitCode === 7, `the job carries the child's exit code (got ${r.job.exitCode})`);
  ok(/fell over/.test(r.job.tail || ''), `the child's own last words survive as tail: ${JSON.stringify(r.job.tail)}`);
  ok(r.job.reason === 'exit', 'reason is machine-readable for the UI');
  ok(r.job.accepted === 0, 'a failed job that ingested nothing reports 0 - nothing is invented');
  feed = await asClient(() => listRadar({}));
  ok(feed.items.length === 2, 'the feed is UNTOUCHED by the failure (still the 2 real signals)');

  // ===== WS1: a DONE run that ingested nothing still stamps lastScan =====
  process.env[BIN_VAR] = emptyBin;
  r = await asClient(() => radarAgentScan({ actor: 'owner' }));
  ok(r.job.state === 'done', 'an honest empty scan is done, not failed');
  ok(r.job.accepted === 0, 'it ingested nothing - nothing invented');
  feed = await asClient(() => listRadar({}));
  ok(feed.lastScan === r.job.finishedAt, 'WS1: a done run stamps lastScan to its finish, even at 0 ingested - the "letztes Resultat" subtitle self-corrects instead of staying stuck on the prior run');

  // ===== WS2: an empty run can propose refined searches (the suggestions channel) =====
  process.env[BIN_VAR] = suggestBin;
  r = await asClient(() => radarAgentScan({ actor: 'owner' }));
  ok(r.job.state === 'done' && r.job.accepted === 0, 'the suggesting run found nothing (0 accepted)');
  ok(Array.isArray(r.job.suggestions) && r.job.suggestions.length === 1, 'WS2: the refined-search suggestion is stored on the job for the empty state to offer');
  ok(r.job.suggestions[0].label === 'Buffer alternative Mastodon' && Array.isArray(r.job.suggestions[0].keywords), 'the suggestion carries a label + keywords the one-click "add search" chip needs');
  const feedSug = await asClient(() => listRadar({}));
  ok(feedSug.jobs[0].suggestions.length === 1, 'radar_list carries job.suggestions[] so the panel can render the chips');

  // ===== (d)+(e) one job per client, and Stop =====
  process.env[BIN_VAR] = hangBin;
  const inflight = asClient(() => radarAgentScan({ actor: 'owner' }));
  // Wait until the child has actually ingested, so Stop is interrupting REAL work. Polling the
  // feed rather than an env-var marker, because the child env is a floor - it cannot see a
  // marker path we did not hand it, and the fence is doing its job by refusing.
  let landed = 0;
  for (let i = 0; i < 100 && landed < 3; i += 1) {
    await new Promise((res) => setTimeout(res, 100));
    landed = (await asClient(() => listRadar({}))).items.length;
  }
  ok(landed === 3, `the hanging child ingested one signal before we stop it (feed has ${landed})`);

  const second = await asClient(() => radarAgentScan({ actor: 'owner' }));
  ok(second.ok !== true && second.code === 'in_flight', 'S4: a second start while running is REFUSED (never queued, never a second child)');
  ok(second.retryAfter === 30, 'the refusal carries retryAfter, so an agent knows to wait rather than hammer');

  const stopped = await asClient(() => radarAgentStop({}));
  ok(stopped.ok === true && stopped.stopped === true, 'S8: Stop acknowledges immediately');
  const stoppedJob = await inflight;
  ok(stoppedJob.job.state === 'failed' && stoppedJob.job.reason === 'stopped', 'S8: the job ends failed/stopped');

  feed = await asClient(() => listRadar({}));
  ok(feed.items.length === 3, `S8: the feed KEEPS what the child already ingested (3 signals), got ${feed.items.length}`);
  ok(feed.items.some((s) => s.url === 'https://example.com/found-before-stop'), 'the pre-stop finding is still there - it was a real ingest');

  const noJob = await asClient(() => radarAgentStop({}));
  ok(noJob.ok === true && noJob.stopped === false, 'stopping when nothing runs is a no-op, never an error');

  // ===== THE CROSS-CLIENT FENCE (found by the first real scan) =====
  // The child is a SEPARATE PROCESS: it does not inherit withClient, so its radar_ingest call
  // binds to whatever client is merely ACTIVE unless the prompt tells it which one it is
  // working for. On the first real run this cost an entire 6-minute job: scoped to `pendpost`,
  // bound to `bondigoo`, queryId unresolvable, four real findings thrown away. The near-miss is
  // the worse half - had the active client owned a query with the same id, one brand's research
  // would have landed silently in another brand's feed.
  const { radarScanPrompt } = await import('../lib/radar-prompt.mjs');
  const promptFor = radarScanPrompt([{ id: 'q1', label: 'S' }], 20, 'pendpost');
  ok(/clientId: "pendpost"/.test(promptFor), 'the prompt NAMES the client the job is scoped to');
  ok(/REQUIRED on every radar_ingest call/.test(promptFor), 'and states it is required on every ingest, not optional');
  ok(/wrong one/.test(promptFor), 'and says WHY, so the agent does not treat it as boilerplate');
  const promptNoClient = radarScanPrompt([{ id: 'q1', label: 'S' }], 20, null);
  ok(!/clientId/.test(promptNoClient), 'a legacy single-workspace job (no client id) does not invent one');
  // The free-text brief is the operator's own words and leads the query block as the intent to
  // judge against. A query with a brief and no keyword arrays is complete, not empty.
  const promptBrief = radarScanPrompt([{ id: 'q1', label: 'S', brief: 'people asking which scheduler handles Mastodon' }], 20, 'pendpost');
  ok(/what to watch for: people asking which scheduler handles Mastodon/.test(promptBrief), 'the free-text brief leads the query block verbatim');
  ok(promptBrief.indexOf('what to watch for') < promptBrief.indexOf('sources to prioritise'), 'the brief leads, before the structured narrowing');
  // The agent has no config_get, so it cannot look a queryId up - the prompt must pre-empt the
  // dead end it otherwise reasons its way into ("the query must not exist; let me go check").
  ok(/already saved in this project/.test(promptFor), 'the prompt states the queryIds are already saved');
  ok(!AGENT_SCAN_TOOLS.includes('mcp__pendpost__config_get'), 'config_get stays OFF the allow-list - the query is in the prompt, and a research child gets no config read');

  // ===== the job cap =====
  const state = asClient(() => loadState());
  ok(state.radar.jobs.length <= 20, 'jobs[] is capped - the volatile feed never grows unbounded');

  // ===== no credential leaks into the job rows =====
  const jobsBlob = JSON.stringify(state.radar.jobs);
  ok(!jobsBlob.includes('sk-ant-oat01-fake'), 'no job row carries the credential');

  // ===== an ingest OUTSIDE a job still works (agents that scan on their own) =====
  const solo = await asClient(() => radarIngest({ actor: 'agent:other', queryId: 'q1', signals: [{ source: 'web', url: 'https://example.com/solo', text: 'looking for a tool' }] }));
  ok(solo.ok === true && solo.accepted === 1, 'radar_ingest still works with NO job running - spec 38 is untouched');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-agent-scan] OK - lifecycle running->done, counts are the SERVER tally, failure invents nothing, one job per client, stop keeps real findings (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-agent-scan] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((r) => server.close(r));
  if (savedBin === undefined) delete process.env[BIN_VAR]; else process.env[BIN_VAR] = savedBin;
  delete process.env.PENDPOST_PORT;
  fs.rmSync(WS, { recursive: true, force: true });
}
