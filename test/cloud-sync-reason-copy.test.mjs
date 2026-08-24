#!/usr/bin/env node
// test/cloud-sync-reason-copy.test.mjs - the three faces of the header cloud dot share
// ONE reason vocabulary, and nothing but this test holds them together: cloudSyncStatus
// emits a reason (SYNC_REASONS), the popover renders it via a DYNAMIC locale key
// (t(`connection.sync.reason.${reason}`), so a missing key silently shows the raw
// string), and the cloud_status MCP outputSchema advertises the enum to agents. A reason
// added to the engine without its copy or its schema entry is exactly the drift that let
// the amber state ship invisible to the agent face. This test fails on that drift.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// cloud-client reads PENDPOST_ROOT at import; point it at a throwaway dir so importing
// the vocabulary const never touches the real workspace.
process.env.PENDPOST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-reason-copy-'));

const { SYNC_REASONS, SYNC_STATES } = await import('../lib/cloud-client.mjs');
// The locale files nest the flat dotted keys under `strings`.
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/src/locales/en.json'), 'utf8')).strings;
const de = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/src/locales/de-CH.json'), 'utf8')).strings;

// green (all_confirmed) and yellow (push_pending) render the status line, never a reason
// sentence (ConnectionStatus only shows a reason for degraded/broken), so they carry no
// reason key by design. Every other reason MUST have copy in both locales.
const NO_REASON_LINE = new Set(['all_confirmed', 'push_pending']);
const needCopy = SYNC_REASONS.filter((r) => !NO_REASON_LINE.has(r));

for (const r of needCopy) {
  const key = `connection.sync.reason.${r}`;
  assert.ok(typeof en[key] === 'string' && en[key].length, `en.json missing ${key}`);
  assert.ok(typeof de[key] === 'string' && de[key].length, `de-CH.json missing ${key}`);
}

// The MCP contract must advertise the exact vocabulary an agent can receive.
const mcpSrc = fs.readFileSync(path.join(ROOT, 'lib/mcp.mjs'), 'utf8');
assert.ok(mcpSrc.includes('SYNC_REASONS') && mcpSrc.includes('SYNC_STATES'),
  'cloud_status outputSchema must import the single-sourced enums, not re-list them');
assert.deepStrictEqual(SYNC_STATES, ['green', 'yellow', 'amber', 'red'], 'four-state contract');

console.log(`ok - all ${needCopy.length} degraded/broken reasons have en + de-CH copy; schema single-sourced`);
