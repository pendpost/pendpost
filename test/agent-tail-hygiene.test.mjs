// test/agent-tail-hygiene.test.mjs - L6 (audit 2026-08-31), the tail half: in stream mode
// stdout is NDJSON, and when the child dies without a closing `result` event (timeout kill,
// crash, quota death) the raw last frames used to become the job tail / Activity
// errorMessage - live rows carried {"type":"rate_limit_event",...}, worthless to an
// operator. humanTailText walks the lines from the end and keeps the LAST human-readable
// text (result words, assistant text blocks, plain prose), skipping protocol frames.
// Also pins the L6 timeout half: AGENT_TIMEOUT_MS raised to 900s (runs were chronically
// at 580-600s and two died at exactly 600s).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-agent-tail-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.writeFileSync(path.join(WS, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake-tail-test\n');

const BIN_VAR = 'PENDPOST_AGENT_BIN_CLAUDE_CODE';
const savedBin = process.env[BIN_VAR];

try {
  const { runAgentJob, humanTailText, AGENT_TIMEOUT_MS } = await import('../lib/agent-runner.mjs');

  // ===== the L6 timeout raise =====
  ok(AGENT_TIMEOUT_MS === 900_000, `AGENT_TIMEOUT_MS is 900s (got ${AGENT_TIMEOUT_MS}) - live runs sat at 580-600s and two died at exactly the old 600s bound`);

  // ===== humanTailText: the unit =====
  const rl = JSON.stringify({ type: 'rate_limit_event', rate_limit: { status: 'allowed_warning', resetsAt: 1756600000 } });
  const asst = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'checked reddit, found 2 candidate threads' }] } });
  const toolUse = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'x' } }] } });
  const res = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'reported 2 findings' });

  ok(humanTailText(`${asst}\n${rl}\n${rl}`) === 'checked reddit, found 2 candidate threads',
    'a rate_limit_event frame after real assistant text is SKIPPED - the operator reads the text');
  ok(humanTailText(`${asst}\n${res}\n${rl}`) === 'reported 2 findings',
    'the result event\'s own words win when present');
  ok(humanTailText(`${rl}\n${toolUse}\n${rl}`) === '',
    'nothing human-readable (frames + tool_use only) => empty, never a raw protocol frame');
  ok(humanTailText('Not logged in · Please run /login') === 'Not logged in · Please run /login',
    'plain non-JSON prose (the real CLI auth refusal) survives verbatim');
  ok(humanTailText('') === '' && humanTailText(null) === '', 'degrades to empty, never throws');

  // ===== end to end: a streamed child that dies mid-run on a rate limit =====
  // Byte-shaped like the live failure: assistant text, then rate_limit_event frames, then a
  // non-zero exit with NO closing result event and NOTHING on stderr. The old tail was the
  // last 500 chars of raw NDJSON - i.e. the rate_limit_event frame.
  const rlBin = path.join(WS, 'ratelimit-claude');
  fs.writeFileSync(rlBin, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(asst)} + '\\n');
process.stdout.write(${JSON.stringify(rl)} + '\\n');
process.stdout.write(${JSON.stringify(rl)} + '\\n');
process.exit(1);
`);
  fs.chmodSync(rlBin, 0o755);
  process.env[BIN_VAR] = rlBin;
  const run = await runAgentJob({ providerId: 'claude-code', prompt: 'x', allowedTools: [], stream: true });
  ok(run.ok === false, 'the child failed (non-zero exit, no result event)');
  ok(!String(run.tail || '').includes('rate_limit_event'),
    `L6 regression: the tail is never a raw stream frame (got ${JSON.stringify(run.tail)})`);
  ok(String(run.tail || '').includes('checked reddit, found 2 candidate threads'),
    'the tail is the last human-readable assistant text instead');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[agent-tail-hygiene] OK - 900s timeout + protocol frames never reach the operator's tail (${pass} assertions).`);
} catch (err) {
  console.error(`[agent-tail-hygiene] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  if (savedBin === undefined) delete process.env[BIN_VAR]; else process.env[BIN_VAR] = savedBin;
  fs.rmSync(WS, { recursive: true, force: true });
}
