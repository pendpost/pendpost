// test/agent-runner.test.mjs - THE FENCE around the spawned agent (spec 41 §7).
//
// The child reads UNTRUSTED external threads while holding pendpost's MCP endpoint and the
// operator's credential. Everything below is a containment property, not a feature:
//   (a) a config naming a non-registry provider is refused (the registry IS the fence);
//   (b) a provider whose flags are unverified is refused, never spawned on a guess;
//   (c) the child env is EXACTLY { PATH, HOME } + the credential - no platform token,
//       no PENDPOST_ROOT, nothing else the daemon happens to hold;
//   (d) the credential never reaches any log, tool result, route or state row;
//   (e) argv is an array, never a shell string - no metacharacter path exists;
//   (f) a timeout kills the child and reports, and never orphans it.
//
// HERMETIC BY CONSTRUCTION: every spawn here goes to a fake binary written into a temp
// workspace and pointed at by PENDPOST_AGENT_BIN_CLAUDE_CODE. This test must NEVER spawn
// the real claude - CI has no such binary, and a real spawn spends the OWNER'S money.
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-agent-runner-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const FAKE_TOKEN = 'sk-ant-oat01-FAKE-TOKEN-VALUE-DO-NOT-LEAK-abcdef123456';
// The daemon's .env holds every platform token; the child must see none of them.
fs.writeFileSync(path.join(WS, '.env'), [
  `CLAUDE_CODE_OAUTH_TOKEN=${FAKE_TOKEN}`,
  'META_PAGE_TOKEN=meta-secret-must-not-reach-the-child',
  'X_ACCESS_TOKEN=x-secret-must-not-reach-the-child',
  '',
].join('\n'));

const BIN_VAR = 'PENDPOST_AGENT_BIN_CLAUDE_CODE';
const savedBin = process.env[BIN_VAR];

// The fake provider. It dumps its own env + argv as JSON so the test can assert the FLOOR
// from the child's side - the only vantage point that proves what actually crossed over.
const fakeBin = path.join(WS, 'fake-claude');
fs.writeFileSync(fakeBin, `#!/usr/bin/env node
const out = { env: process.env, argv: process.argv.slice(2), cwd: process.cwd() };
require('fs').writeFileSync(process.env.PENDPOST_TEST_DUMP || '${path.join(WS, 'dump.json')}', JSON.stringify(out));
// The result carries an em dash on purpose: a real agent writes them, and this is pendpost's screen.
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK \u2014 found 2', total_cost_usd: 0 }));
process.exit(0);
`);
fs.chmodSync(fakeBin, 0o755);

// A provider that hangs forever, for the timeout proof.
const hangBin = path.join(WS, 'hang-claude');
fs.writeFileSync(hangBin, `#!/usr/bin/env node
setInterval(() => {}, 1000);
`);
fs.chmodSync(hangBin, 0o755);

// A provider that CRASHES before emitting an envelope. It ECHOES ITS OWN TOKEN, the way a
// real CLI complaining about a bad credential would - that is the leak scrubCredential
// exists to catch, and the only way to prove it is to make the child actually emit it.
const angryBin = path.join(WS, 'angry-claude');
fs.writeFileSync(angryBin, `#!/usr/bin/env node
process.stderr.write('boom: token ' + process.env.CLAUDE_CODE_OAUTH_TOKEN + ' was rejected\\n');
process.exit(3);
`);
fs.chmodSync(angryBin, 0o755);

// The REAL auth failure, reproduced byte-faithfully from a live claude v2.1.201 run on
// 2026-07-15: a JSON envelope on STDOUT, is_error:true, subtype "success" (yes, both), and
// EXIT CODE 0. This is the shape that would sail through an exit-code check as a healthy
// job, so it gets its own fixture rather than being folded into the crash case.
const authFailBin = path.join(WS, 'authfail-claude');
fs.writeFileSync(authFailBin, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in \\u00b7 Please run /login', total_cost_usd: 0 }));
process.exit(0);
`);
fs.chmodSync(authFailBin, 0o755);

try {
  const runner = await import('../lib/agent-runner.mjs');
  const {
    AGENT_PROVIDERS, AGENT_PROVIDER_IDS, isSupportedProvider, resolveAgentBin, availableProviders,
    agentCredentialPresent, scrubCredential, runAgentJob, isJobRunning, killJob, firstLine,
    beginToolWitness, endToolWitness, witnessAgentTool, AGENT_SCAN_TOOLS, agentBinEnvVar,
  } = runner;

  // ===== (1) the registry IS the fence =====
  ok(Object.isFrozen(AGENT_PROVIDERS), 'AGENT_PROVIDERS is frozen - a config can only name a key of it, never a path');
  ok(AGENT_PROVIDER_IDS.includes('claude-code'), 'claude-code is a registry id');
  ok(!AGENT_PROVIDER_IDS.includes('../../bin/sh'), 'a path is not a registry id');
  ok(!AGENT_PROVIDERS['claude-code'].bin.includes('/'), 'the registry names a BIN, never a stored command string');
  ok(resolveAgentBin('nope-not-real') === null, 'an unknown provider resolves to no binary');
  ok(agentBinEnvVar('claude-code') === 'PENDPOST_AGENT_BIN_CLAUDE_CODE', 'the override var name is derived from the id');

  // ===== (2) an unverified provider is refused, never spawned on a guess =====
  ok(isSupportedProvider('claude-code') === true, 'claude-code is supported (its flags were proven against the real CLI)');
  ok(isSupportedProvider('gemini-cli') === false, 'gemini-cli is present as SHAPE but unsupported (verified:null)');
  ok(isSupportedProvider('codex') === false, 'codex is present as SHAPE but unsupported (argv:null)');
  const unverified = await runAgentJob({ providerId: 'gemini-cli', prompt: 'x', allowedTools: [] });
  ok(unverified.ok === false && unverified.error === 'unsupported_provider', 'a verified:null provider is REFUSED, not spawned');
  const unknown = await runAgentJob({ providerId: 'evil', prompt: 'x', allowedTools: [] });
  ok(unknown.ok === false && unknown.error === 'unknown_provider', 'an off-registry provider is REFUSED');
  ok(availableProviders().find((p) => p.id === 'gemini-cli').supported === false, 'availableProviders marks the unverified ones unsupported');
  // Each provider carries its OWN mint command, so the Setup card shows this agent's command,
  // never a hardcoded Claude one, the moment a second provider is offerable.
  ok(availableProviders().find((p) => p.id === 'claude-code').authCmd === AGENT_PROVIDERS['claude-code'].authCmd, 'availableProviders exposes each provider authCmd from the provider table');

  // ===== (3) the credential gate =====
  ok(agentCredentialPresent('claude-code') === true, 'the credential is detected by PRESENCE from the active .env');

  // ===== (4) the child env is a FLOOR - proven from the child's own side =====
  process.env[BIN_VAR] = fakeBin;
  ok(resolveAgentBin('claude-code') === fakeBin, 'the override seam resolves the fake binary (CI has no real claude)');

  const dumpPath = path.join(WS, 'dump.json');
  const run = await runAgentJob({ providerId: 'claude-code', prompt: 'hello', allowedTools: [...AGENT_SCAN_TOOLS] });
  ok(run.ok === true && run.exitCode === 0, 'a clean child exits 0 and the job is ok');

  const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
  // `__CF_USER_TEXT_ENCODING` is injected by macOS CoreFoundation INSIDE the child, not by
  // us - filtering the OS's own dunder vars keeps this asserting what pendpost actually
  // hands over, which is the property that matters, instead of failing on a platform quirk.
  const envKeys = Object.keys(dump.env).filter((k) => !k.startsWith('__')).sort();
  ok(JSON.stringify(envKeys) === JSON.stringify(['CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'PATH']),
    `the child env pendpost hands over is EXACTLY { PATH, HOME, CLAUDE_CODE_OAUTH_TOKEN } - got ${envKeys.join(', ')}`);
  ok(!('META_PAGE_TOKEN' in dump.env) && !('X_ACCESS_TOKEN' in dump.env),
    'NO platform token crosses into the child, though the daemon env holds them');
  ok(!('PENDPOST_ROOT' in dump.env), 'PENDPOST_ROOT is withheld - the child is not an engine and has no filesystem relationship with pendpost');
  ok(dump.env.PATH.includes('/usr/bin'), 'the child PATH is BUILT, not inherited (launchd PATH lacks Homebrew)');
  ok(dump.cwd !== process.cwd(), 'the child cwd is NOT the repo - defence in depth if the tool allow-list ever regresses');

  // ===== (5) argv: an array, no shell, no metacharacter path =====
  ok(Array.isArray(dump.argv), 'argv reaches the child as an array (spawn, never sh -c)');
  const pIdx = dump.argv.indexOf('-p');
  ok(pIdx === 0, '-p is FIRST: --allowed-tools/--mcp-config are variadic and would swallow a trailing prompt');
  ok(dump.argv[1] === 'hello', 'the prompt travels as ONE argv element');
  ok(dump.argv.includes('--strict-mcp-config'), '--strict-mcp-config: the child never inherits the operator\'s own MCP servers');
  ok(dump.argv.includes('--permission-mode') && dump.argv[dump.argv.indexOf('--permission-mode') + 1] === 'dontAsk',
    'permission mode is dontAsk (deny-if-not-pre-approved), NOT default (which prompts)');
  ok(!dump.argv.includes('--tools'), '--tools is NOT passed: it hides every MCP tool from the child (proven 2026-07-15), which would break radar_ingest');
  const allowIdx = dump.argv.indexOf('--allowed-tools');
  ok(allowIdx > -1 && dump.argv[allowIdx + 1] === 'WebSearch,WebFetch,mcp__pendpost__radar_ingest',
    'the allow-list IS the fence and carries exactly the research surface + radar_ingest');
  ok(!dump.argv.some((a) => /[;&|`$]/.test(String(a)) && !a.startsWith('-p')), 'no argv element carries a shell metacharacter path');
  const cfgIdx = dump.argv.indexOf('--mcp-config');
  ok(cfgIdx > -1 && !fs.existsSync(dump.argv[cfgIdx + 1]), 'the temp MCP config is deleted in a finally - it does not linger after the job');

  // ===== (6) THE LEAK FENCE: the credential never surfaces =====
  ok(!JSON.stringify(run).includes(FAKE_TOKEN), 'the credential is NOT in the job result the route/tool returns');
  process.env[BIN_VAR] = angryBin;
  const angry = await runAgentJob({ providerId: 'claude-code', prompt: 'x', allowedTools: [] });
  ok(angry.ok === false && angry.exitCode === 3, 'a non-zero exit is a failed job carrying the exit code');
  ok(angry.detail === 'boom: token [redacted] was rejected', 'a crash with no envelope reports its own first stderr line as detail');
  ok(!angry.tail.includes(FAKE_TOKEN), 'a child that ECHOES its own token does not leak it into `tail`');
  ok(!angry.stdout.includes(FAKE_TOKEN) && !angry.stderr.includes(FAKE_TOKEN), 'neither stream carries the credential onward');
  ok(angry.tail.includes('[redacted]'), 'the token is replaced, not silently dropped - the operator still sees the shape of the error');
  ok(!JSON.stringify(angry).includes(FAKE_TOKEN), 'the WHOLE failed-job payload is credential-free');
  ok(scrubCredential(`token ${FAKE_TOKEN} bad`, 'claude-code') === 'token [redacted] bad', 'scrubCredential redacts the live value');

  // ===== (6b) the auth failure that EXITS 0 - the shape an exit-code check would pass =====
  process.env[BIN_VAR] = authFailBin;
  const authFail = await runAgentJob({ providerId: 'claude-code', prompt: 'x', allowedTools: [] });
  ok(authFail.exitCode === 0, 'the real CLI exits 0 on `Not logged in` - so exit code alone would call this a success');
  ok(authFail.ok === false && authFail.error === 'agent_error',
    'the envelope\'s is_error makes it a FAILED job anyway - an unauthenticated scan must never report `done` with nothing found');
  ok(authFail.detail === 'Not logged in · Please run /login',
    'the child\'s own words survive to the operator, from the envelope on STDOUT (this CLI does not use stderr for that)');

  // ===== (7) a timeout kills and reports, never orphans =====
  process.env[BIN_VAR] = hangBin;
  const t0 = Date.now();
  const timed = await runAgentJob({ providerId: 'claude-code', prompt: 'x', allowedTools: [], timeoutMs: 700 });
  ok(timed.ok === false && timed.timedOut === true && timed.error === 'timeout', 'a hanging child TIMES OUT as a failed job with reason timeout');
  ok(Date.now() - t0 < 10_000, 'the timeout actually fires - it is not a job stuck running forever');
  ok(isJobRunning() === false, 'the registry is clean after a timeout - no orphan');

  // ===== (8) one job per client + stop =====
  const inflight = runAgentJob({ providerId: 'claude-code', prompt: 'x', allowedTools: [], timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 150));
  ok(isJobRunning() === true, 'a running job is visible in the registry, keyed on the resolved client root');
  const killedId = killJob();
  ok(killedId !== undefined, 'killJob targets the running child');
  const stopped = await inflight;
  ok(stopped.ok === false && stopped.stopped === true && stopped.error === 'stopped', 'Stop ends the job failed/stopped - anything spending the subscription needs a way out');
  ok(isJobRunning() === false, 'the registry is clean after a stop');

  // ===== (9) the witness: the ONLY honest "did the tool call land?" =====
  ok(endToolWitness().length === 0, 'no witness is armed by default - the normal MCP path pays one null check');
  witnessAgentTool('radar_ingest');
  ok(endToolWitness().length === 0, 'a tool call outside a probe is NOT witnessed');
  beginToolWitness();
  witnessAgentTool('pendpost_health');
  const seen = endToolWitness();
  ok(seen.length === 1 && seen[0] === 'pendpost_health', 'an armed witness records the tool that actually reached OUR handler');
  ok(endToolWitness().length === 0, 'the witness disarms after being read - it cannot vouch for a later job');

  // ===== (9b) the agent's words land under OUR copy rules =====
  // The tail renders in pendpost's own UI, so "no em dashes" (a Tier 1 copy rule here) binds it. A
  // model writes them freely: a real tail arrived reading "(all Hacker News — Reddit/Mastodon
  // searches...)" and put one on screen. This normalizes TYPOGRAPHY and nothing else - the words
  // stay the agent's own, because the tail exists so the operator reads what it actually said.
  ok(runner.normalizeTail('all HN — Reddit found nothing') === 'all HN - Reddit found nothing', 'an em dash in the agent\'s tail becomes the house " - "');
  ok(runner.normalizeTail('a – b') === 'a - b', 'an en dash too');
  ok(runner.normalizeTail('found 3 - all good') === 'found 3 - all good', 'text with no dash is untouched');
  ok(runner.normalizeTail('we shipped it. it works.') === 'we shipped it. it works.', 'the agent\'s words are NOT otherwise rewritten');
  process.env[BIN_VAR] = fakeBin;
  const dashRun = await runAgentJob({ providerId: 'claude-code', prompt: 'x', allowedTools: [] });
  // The RENDERED fields only. Raw stdout stays byte-exact on purpose: it is the record of what the
  // child actually emitted, and nothing puts it on screen - `tail` and `detail` are what the job row
  // shows, so they are what the copy rule binds.
  ok(!/[—–]/.test(dashRun.tail || ''), 'no em dash reaches the job row\'s tail');
  ok(!/[—–]/.test(dashRun.detail || ''), 'no em dash reaches the job row\'s detail');
  ok(/[—]/.test(dashRun.stdout), 'the raw stdout keeps the child\'s bytes exactly - it is a record, not a surface');

  // ===== (10) helpers =====
  ok(firstLine('', '  \n first \n second') === 'first', 'firstLine skips empty streams and trims');
  ok(firstLine(null, undefined) === null, 'firstLine degrades to null, never throws');

  // ===== (11) stream mode: the observable job =====
  // The flags are PROVEN against claude v2.1.201 (2026-07-20): -p + stream-json REFUSES to run
  // without --verbose, and the stream closes with a `result` event carrying the same envelope
  // fields as plain json. The fixture below emits that byte-shape: assistant events with
  // tool_use/text content, then the result event - split mid-line across two writes to prove
  // the incremental parser buffers partial lines rather than dropping events.
  const streamArgv = AGENT_PROVIDERS['claude-code'].argv({ prompt: 'x', mcpConfigPath: '/tmp/m.json', allowedTools: ['WebSearch'], model: null, stream: true });
  ok(streamArgv.includes('stream-json') && streamArgv.includes('--verbose'), 'stream mode passes --output-format stream-json WITH --verbose (the CLI refuses the pair without it)');
  const plainArgv = AGENT_PROVIDERS['claude-code'].argv({ prompt: 'x', mcpConfigPath: '/tmp/m.json', allowedTools: ['WebSearch'], model: null });
  ok(plainArgv.includes('json') && !plainArgv.includes('--verbose'), 'without stream the argv stays plain json - the probe and old callers are byte-identical');

  const streamBin = path.join(WS, 'stream-claude');
  fs.writeFileSync(streamBin, `#!/usr/bin/env node
const l1 = JSON.stringify({ type: 'assistant', message: { content: [ { type: 'tool_use', name: 'WebSearch', input: { query: 'best social planner' } } ] } });
const l2 = JSON.stringify({ type: 'assistant', message: { content: [ { type: 'text', text: 'checking reddit next' } ] } });
const l3 = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'reported 2 findings' });
process.stdout.write(l1 + '\\n' + l2.slice(0, 10));
setTimeout(() => { process.stdout.write(l2.slice(10) + '\\n' + l3 + '\\n'); process.exit(0); }, 50);
`);
  fs.chmodSync(streamBin, 0o755);
  process.env[BIN_VAR] = streamBin;
  const events = [];
  const streamRun = await runAgentJob({ providerId: 'claude-code', prompt: 'x', allowedTools: [], stream: true, onEvent: (e) => events.push(e) });
  ok(streamRun.ok === true, 'a streamed job with a clean result event is ok');
  ok(events.some((e) => e.type === 'assistant' && e.message?.content?.[0]?.name === 'WebSearch'), 'the observer sees the tool_use event');
  ok(events.some((e) => e.type === 'assistant' && e.message?.content?.[0]?.text === 'checking reddit next'), 'a line split across two writes is buffered and parsed whole');
  ok(events.some((e) => e.type === 'result'), 'the closing result event reaches the observer too');
  ok(streamRun.detail === 'reported 2 findings', 'detail is the result event\'s own words, not NDJSON garbage');
  ok(!String(streamRun.tail || '').includes('{"type"'), 'the tail is prose, never raw NDJSON');

  const streamAuthFailBin = path.join(WS, 'stream-authfail-claude');
  fs.writeFileSync(streamAuthFailBin, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in \\u00b7 Please run /login' }) + '\\n');
process.exit(0);
`);
  fs.chmodSync(streamAuthFailBin, 0o755);
  process.env[BIN_VAR] = streamAuthFailBin;
  const streamAuthFail = await runAgentJob({ providerId: 'claude-code', prompt: 'x', allowedTools: [], stream: true });
  ok(streamAuthFail.ok === false && streamAuthFail.error === 'agent_error', 'is_error on the streamed result event still fails the job - exit 0 proves nothing in stream mode either');

  const throwingObserver = await (async () => {
    process.env[BIN_VAR] = streamBin;
    return runAgentJob({ providerId: 'claude-code', prompt: 'x', allowedTools: [], stream: true, onEvent: () => { throw new Error('observer bug'); } });
  })();
  ok(throwingObserver.ok === true, 'a throwing observer never hurts the job - progress is a bonus, not a risk');
  process.env[BIN_VAR] = fakeBin;

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[agent-runner] OK - the registry fences the provider, the child env is a floor, the credential cannot leak, timeout+stop kill cleanly (${pass} assertions).`);
} catch (err) {
  console.error(`[agent-runner] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  if (savedBin === undefined) delete process.env[BIN_VAR]; else process.env[BIN_VAR] = savedBin;
  fs.rmSync(WS, { recursive: true, force: true });
}
