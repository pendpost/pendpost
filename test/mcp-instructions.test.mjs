#!/usr/bin/env node
// test/mcp-instructions.test.mjs - C9 (US-MCP-03): the MCP INSTRUCTIONS
// tool-list must be DERIVED from the TOOLS array, not a hand-maintained literal,
// so the handshake contract can never drift from the actual tool set. We drive a
// real 'initialize' through handleMcp and assert every TOOLS[].name appears in
// result.instructions. RED at HEAD: the static literal omits tools added since it
// was hand-written (e.g. health_recheck / config_get / config_set / client_list /
// mark_posted / asset_upload). The prose framing (368 rule, approval gate, error
// codes, derivedState legend) must still be present.
//
// Zero-dep: a fresh temp PENDPOST_ROOT before importing lib; handleMcp is driven
// through a mock req (Readable) + res (Writable) so we exercise the real handshake.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-mcp-instr-'));
process.env.PENDPOST_ROOT = WS;

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// Drive one JSON-RPC message through handleMcp and return the parsed reply.
async function rpc(handleMcp, msg) {
  const body = JSON.stringify(msg);
  const req = Readable.from([Buffer.from(body, 'utf8')]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json' };
  const chunks = [];
  let status = 0;
  const res = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
  });
  res.writeHead = (s) => { status = s; };
  await handleMcp(req, res);
  const text = Buffer.concat(chunks).toString('utf8');
  return { status, body: text ? JSON.parse(text) : null };
}

try {
  const { TOOLS, handleMcp } = await import('../lib/mcp.mjs');
  ok(Array.isArray(TOOLS) && TOOLS.length > 0, 'lib/mcp.mjs exports a non-empty TOOLS array');

  const { body } = await rpc(handleMcp, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18' },
  });
  ok(body && body.result && typeof body.result.instructions === 'string',
    'initialize returns a string instructions field');
  const instructions = body.result.instructions;

  // ---- every tool name must appear in the instructions ----------------------
  const missing = TOOLS.map((t) => t.name).filter((name) => !instructions.includes(name));
  ok(missing.length === 0,
    `every TOOLS[].name appears in instructions (missing: ${missing.join(', ') || 'none'})`);

  // ---- the prose framing must be preserved ----------------------------------
  ok(/368/.test(instructions), 'instructions still document the Meta 368 rule');
  ok(/approval/i.test(instructions), 'instructions still document the approval gate');
  ok(/derivedState/.test(instructions), 'instructions still document the derivedState legend');
  ok(/manifest_error/.test(instructions) && /stale_write/.test(instructions),
    'instructions still document the stable error codes');

  // ---- UNIT 2b: the enriched first-run onboarding block ----------------------
  // The single SETUP paragraph the agent reads on connect. We grep it out so the
  // onboarding assertions only see the relevant prose, not an accidental match in
  // an unrelated line (every other line is on its own \n-joined entry).
  const setupLine = instructions
    .split('\n')
    .find((l) => /first-?run setup/i.test(l));
  ok(typeof setupLine === 'string' && setupLine.length > 0,
    'instructions carry a FIRST-RUN SETUP onboarding block');

  // (a) per incomplete platform, present the playbook portal link + ordered steps
  //     + which env var/field + the connectAction CLI (point at pendpost_health.setup).
  ok(/pendpost_health/.test(setupLine) && /setup/.test(setupLine),
    'onboarding tells the agent to read pendpost_health.setup');
  ok(/playbook/i.test(setupLine),
    'onboarding points the agent at the per-platform setup playbook');
  ok(/portal/i.test(setupLine),
    'onboarding surfaces the playbook portal link');
  ok(/step/i.test(setupLine),
    'onboarding surfaces the playbook ordered steps');
  ok(/env|identifier|field/i.test(setupLine),
    'onboarding names which env var / identifier / field each step needs');
  ok(/connectAction/.test(setupLine),
    'onboarding surfaces the connectAction CLI command');

  // (b) the human does the portal/OAuth step; the agent NEVER reads/types/writes a secret.
  ok(/owner|human|user/i.test(setupLine) && /oauth|portal/i.test(setupLine),
    'onboarding states the human does the portal/OAuth step');
  ok(/never\b[^.]*\b(read|type|paste|write)/i.test(setupLine) && /secret|token/i.test(setupLine),
    'onboarding states the agent NEVER reads/types/writes a raw secret');

  // (c) call health_recheck{platform} to VALIDATE and surface the real pass/fail + fix.
  ok(/health_recheck/.test(setupLine),
    'onboarding tells the agent to call health_recheck to validate');
  ok(/health_recheck\s*\{?\s*platform/i.test(setupLine),
    'onboarding scopes the re-probe with health_recheck{platform}');
  ok(/validat/i.test(setupLine) && /(pass|fail)/i.test(setupLine) && /fix/i.test(setupLine),
    'onboarding surfaces the real pass/fail + fix from the probe');

  // (d) 'ready' only when every platform is validated-live or skipped.
  ok(/ready/i.test(setupLine) && /(validated|live)/i.test(setupLine) && /skip/i.test(setupLine),
    'onboarding states ready means every platform validated-live or skipped');

  console.log(`[mcp-instructions] OK - ${pass} assertions; ${TOOLS.length} tools all enumerated.`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
