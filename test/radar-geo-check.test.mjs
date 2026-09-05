// test/radar-geo-check.test.mjs - the KI-Sichtbarkeit (GEO) check finally gets a trigger.
//
// The owner types buying questions in Settings; until now nothing ever ran them, so they sat
// forever at "noch nicht geprueft". Proofs:
//   (a) PURE: radarScanPrompt folds a GEO block (with the questions + radar_footprint_log) in ONLY
//       when questions are passed; a scan with none is byte-for-byte the old prompt.
//   (b) PURE: radarGeoPrompt is the standalone brief - questions in, footprint-log instructions out.
//   (c) E2E: a normal scan with questions saved lets the child ALSO call radar_footprint_log (the
//       tool is on the allow-list only then), and the footprint lands.
//   (d) E2E: scope:'geo' runs the check ALONE (no signal research), records footprint, marks the
//       job scope:'geo' done, and does NOT bump the signal feed's lastScan.
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

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-geo-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));

const BIN_VAR = 'PENDPOST_AGENT_BIN_CLAUDE_CODE';
const savedBin = process.env[BIN_VAR];
let server;

// A child that ingests one signal AND logs one footprint - the folded scan (case c).
const foldBin = path.join(WS, 'fold-claude');
fs.writeFileSync(foldBin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
const call = (name, argsObj) => fetch(cfg.mcpServers.pendpost.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: argsObj } }) });
Promise.all([
  call('radar_ingest', { actor: 'agent:radar-scan', queryId: 'q1', signals: [{ source: 'web', ts: new Date().toISOString(), url: 'https://example.com/t/1', text: 'what scheduler do you all use?' }] }),
  call('radar_footprint_log', { actor: 'agent:radar-geo', question: 'best social scheduler', mentioned: false, competitorsMentioned: ['Buffer'] }),
]).then(() => process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'done' })))
  .catch((e) => { process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: String(e.message) })); process.exit(1); });
`);
fs.chmodSync(foldBin, 0o755);

// A child that ONLY logs footprint - the standalone geo recheck (case d).
const geoBin = path.join(WS, 'geo-claude');
fs.writeFileSync(geoBin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
fetch(cfg.mcpServers.pendpost.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'radar_footprint_log', arguments: { actor: 'agent:radar-geo', question: 'best social scheduler', mentioned: true, competitorsMentioned: [] } } }) })
  .then(() => process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'checked 1 question' })))
  .catch((e) => { process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: String(e.message) })); process.exit(1); });
`);
fs.chmodSync(geoBin, 0o755);

try {
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { radarAgentScan, listRadar } = await import('../lib/writes.mjs');
  const { radarScanPrompt, radarGeoPrompt } = await import('../lib/radar-prompt.mjs');
  const { AGENT_GEO_TOOLS } = await import('../lib/agent-runner.mjs');
  const { handleRpc, TOOLS } = await import('../lib/mcp.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');

  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  const CLIENT_ROOT = clientRoot(activeClientId());
  fs.mkdirSync(CLIENT_ROOT, { recursive: true });
  fs.writeFileSync(path.join(CLIENT_ROOT, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\n');

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

  // ===== (a) PURE: radarScanPrompt folds the GEO block only when questions are passed =====
  const q = [{ id: 'q1', label: 'Scheduling', competitors: ['Buffer'] }];
  const plain = radarScanPrompt(q, 20, 'pendpost', null, null);
  ok(!/KI-Sichtbarkeit|radar_footprint_log/.test(plain), 'a scan with NO questions is the old prompt untouched (no GEO block)');
  const folded = radarScanPrompt(q, 20, 'pendpost', null, { questions: ['best social scheduler', 'buffer alternative'], brandName: 'pendpost', competitors: ['Buffer'] });
  ok(/AI ANSWER VISIBILITY/.test(folded), 'with questions, the scan prompt carries the GEO block');
  ok(/radar_footprint_log/.test(folded), 'and instructs the child to call radar_footprint_log');
  ok(/best social scheduler/.test(folded) && /buffer alternative/.test(folded), 'the actual questions are in the brief, verbatim');
  ok(/"pendpost"/.test(folded), 'the brand name tells the child what "named" means');
  ok(!/—|–/.test(folded), 'the folded prompt carries no em or en dashes');

  // ===== (b) PURE: the standalone geo brief =====
  const geoPrompt = radarGeoPrompt(['best social scheduler'], { clientId: 'pendpost', brandName: 'pendpost', competitors: ['Buffer'] });
  ok(/radar_footprint_log/.test(geoPrompt), 'radarGeoPrompt instructs radar_footprint_log');
  ok(/best social scheduler/.test(geoPrompt), 'and carries the question');
  ok(!/radar_ingest/.test(geoPrompt), 'the geo brief does NOT ask for signal ingest - it is visibility only');
  ok(AGENT_GEO_TOOLS.includes('mcp__pendpost__radar_footprint_log') && !AGENT_GEO_TOOLS.includes('mcp__pendpost__radar_queue_reply'), 'the geo allow-list carries footprint_log and NOTHING that can post');

  const scanTool = TOOLS.find((t) => t.name === 'radar_agent_scan');
  ok(scanTool.inputSchema.properties.scope && scanTool.inputSchema.properties.scope.enum.includes('geo'), 'radar_agent_scan declares the scope:"geo" option');

  // Enable Radar with a query AND buying questions, and connect the agent.
  // PIN A SINGLE SEARCHABLE SOURCE. A manual feed scan runs PER-SOURCE ISOLATION (acb6915): one
  // child spawn per effective source (reddit/mastodon/bluesky/hackernews), and foldBin logs one
  // footprint UNCONDITIONALLY per spawn - so four lanes would record four checks, not the one this
  // case proves. The GEO check folds into the FIRST lane only in production, so a real four-lane
  // scan still checks each question once; the stub cannot model that per-lane conditionality, so
  // pinning one source keeps the "footprint has 1 check" arithmetic exact.
  await asClient(() => setConfig({
    ifRev: getConfig().rev,
    actor: 'owner',
    set: { posting: { radar: {
      enabled: true,
      queries: [{ id: 'q1', label: 'Scheduling', enabled: true, keywords: ['scheduling'], competitors: ['Buffer'] }],
      sources: { reddit: { scan: true }, mastodon: { scan: false }, bluesky: { scan: false }, hackernews: { scan: false } },
      geo: { buyingQuestions: ['best social scheduler'] },
      agent: { provider: 'claude-code' },
    } } },
  }));

  // ===== (c) E2E: a normal scan ALSO checks the questions (footprint lands) =====
  process.env[BIN_VAR] = foldBin;
  let before = (await asClient(() => listRadar({}))).lastScan;
  let r = await asClient(() => radarAgentScan({ actor: 'owner' }));
  ok(r.job.state === 'done' && r.job.scope === 'feed', 'the folded scan is a normal feed job');
  let feed = await asClient(() => listRadar({}));
  ok(feed.items.length === 1, 'the folded scan still ingested its signal');
  ok(feed.geo.footprintRate.checks === 1, 'AND the folded scan checked the KI-Sichtbarkeit question (footprint has 1 check) - the wire the feature was missing');
  ok(feed.lastScan && feed.lastScan !== before, 'a feed scan bumps lastScan');

  // ===== (d) E2E: scope:'geo' checks ONLY, does not touch the signal feed's lastScan =====
  process.env[BIN_VAR] = geoBin;
  before = (await asClient(() => listRadar({}))).lastScan;
  r = await asClient(() => radarAgentScan({ actor: 'owner', scope: 'geo' }));
  ok(r.job.state === 'done' && r.job.scope === 'geo', 'scope:"geo" runs a geo-scoped job to done');
  feed = await asClient(() => listRadar({}));
  ok(feed.geo.footprintRate.checks === 2, 'the standalone recheck recorded another footprint check (now 2)');
  ok(feed.items.length === 1, 'it ingested no signals - the feed is unchanged');
  ok(feed.lastScan === before, 'WS3: a geo recheck does NOT bump the signal "letztes Resultat" clock (it produced footprint, not signals)');

  // scope:'geo' with NO questions saved is an honest refusal, not a wasted spawn.
  await asClient(() => setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { geo: { buyingQuestions: [] } } } } }));
  r = await asClient(() => radarAgentScan({ actor: 'owner', scope: 'geo' }));
  ok(r.ok !== true && r.code === 'invalid_input', 'scope:"geo" with no questions saved refuses honestly rather than spawning');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-geo-check] OK - KI-Sichtbarkeit checks ride every scan AND run standalone; geo never fakes a signal scan (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-geo-check] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((r) => server.close(r));
  if (savedBin === undefined) delete process.env[BIN_VAR]; else process.env[BIN_VAR] = savedBin;
  delete process.env.PENDPOST_PORT;
  fs.rmSync(WS, { recursive: true, force: true });
}
