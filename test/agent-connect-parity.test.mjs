#!/usr/bin/env node
// test/agent-connect-parity.test.mjs - the Setup "Your agent" card cannot drift from AGENTS.md.
//
// Spec 40 6.3 puts the connect ceremony on the Setup page, and spec 40's whole premise is
// that the agent is the brain: if the command shown there is stale, the agent-native path
// is broken at step one and every downstream promise (keyless scan, keyless automation,
// drafted replies) silently fails.
//
// The app bundle cannot import lib/ or scripts/ (a Vite bundle, no core import - the same
// reason format.js restates NATIVE_SCHEDULING_PLATFORMS), so the strings are restated in
// app/src/lib/agent-connect.js. That is only safe with a guard: this test pins the restated
// commands against scripts/gen-agents.mjs, which generates AGENTS.md, so the two can never
// disagree in silence.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const genAgents = fs.readFileSync(path.join(ROOT, 'scripts', 'gen-agents.mjs'), 'utf8');
const connectSrc = fs.readFileSync(path.join(ROOT, 'app', 'src', 'lib', 'agent-connect.js'), 'utf8');

// Pull the restated values straight out of the app module (a plain string literal, so a
// regex read keeps this test free of a bundler/JSX import).
const valueOf = (key) => {
  const m = new RegExp(`${key}:\\s*'([^']+)'`).exec(connectSrc);
  return m ? m[1] : null;
};

const http = valueOf('http');
const stdio = valueOf('stdio');

ok(Boolean(http), 'app/src/lib/agent-connect.js exports an http connect command');
ok(Boolean(stdio), 'app/src/lib/agent-connect.js exports a stdio connect command');

// The load-bearing assertion: every command the Studio shows must appear VERBATIM in the
// AGENTS.md generator. gen-agents.mjs escapes backticks for its template literal, so
// compare against a backtick-stripped copy.
const genPlain = genAgents.replace(/\\`/g, '`');
ok(genPlain.includes(http), `the http connect command matches gen-agents.mjs verbatim: ${http}`);
ok(genPlain.includes(stdio), `the stdio connect command matches gen-agents.mjs verbatim: ${stdio}`);

// The command must actually address the loopback MCP server the app boots (lib/mcp.mjs),
// so a port/path change cannot leave the card confidently wrong.
ok(http.includes('http://127.0.0.1:8090/mcp'), 'the http command points at the loopback MCP endpoint pendpost serves');

// No model key, no API key, no cloud endpoint may ever appear in the connect ceremony:
// the agent authenticates with its OWN subscription (the model-free/key-free invariant).
for (const banned of ['api_key', 'apiKey', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'sk-']) {
  ok(!connectSrc.includes(banned), `the connect ceremony asks for no key (${banned} absent)`);
}

console.log(`\nagent-connect-parity: ${pass} checks passed`);
