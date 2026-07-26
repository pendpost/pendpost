#!/usr/bin/env node
// test/config-unknown-key-hint.test.mjs - the unknown-top-level-key message must
// diagnose the ACTUAL mistake.
//
// setConfig takes a NESTED shape: { set: { posting: { radar: {...} } } }. Send the
// dotted key instead - { set: { "posting.radar": {...} } } - and the top-level
// allowlist rejects it with:
//
//   not settable: posting.radar (secrets are display-only; rotate via the CLI)
//
// Every word after the colon is wrong for this input. posting.radar is deliberately
// AGENT-WRITABLE (lib/config.mjs: "agents may tune queries") and has nothing to do
// with secrets or the CLI. On 2026-07-15 that message cost a session: it read the
// refusal, concluded posting.radar was classed with secrets, recorded "config_set
// refuses posting.radar" as a blocker, and abandoned a Radar UX walk that a nested
// write would have completed. A misleading error is worse than a terse one - it
// sends the reader somewhere specific and wrong.
//
// The secrets sentence is RIGHT for a real secret ({ set: { secrets: ... } }), so it
// stays for that case. This test pins both branches.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-config-hint-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { getConfig, setConfig } = await import('../lib/config.mjs');
const rev = () => getConfig().rev;

try {
  // ── a dotted key whose prefix IS a settable container ──
  const dotted = setConfig({ ifRev: rev(), actor: 'owner', set: { 'posting.radar': { enabled: true } } });
  ok(dotted.code === 'invalid_input', 'a dotted key is still refused');
  ok(
    /nest|posting:\s*\{|\{ posting/i.test(dotted.message),
    `the message tells the caller to NEST it (got: ${dotted.message})`,
  );
  ok(
    !/secret/i.test(dotted.message),
    `the message does NOT blame secrets for a nesting mistake (got: ${dotted.message})`,
  );

  // ── the same for an identifiers.* dotted key ──
  const dottedId = setConfig({ ifRev: rev(), actor: 'owner', set: { 'identifiers.xHandle': 'x' } });
  ok(/nest|identifiers:\s*\{|\{ identifiers/i.test(dottedId.message), 'identifiers.* gets the same nesting hint');

  // ── a genuinely unknown key still gets the secrets sentence ──
  const secret = setConfig({ ifRev: rev(), actor: 'owner', set: { secrets: { token: 'x' } } });
  ok(secret.code === 'invalid_input', 'an unknown top-level key is refused');
  ok(/secret/i.test(secret.message), `a real secrets write still gets the secrets sentence (got: ${secret.message})`);

  // ── and the nested write the dotted key MEANT still works ──
  const nested = setConfig({ ifRev: rev(), actor: 'owner', set: { posting: { radar: { enabled: true } } } });
  ok(nested.ok === true, 'the nested posting.radar write succeeds (it was never "not settable")');

  console.log(`\n${pass} passing`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
