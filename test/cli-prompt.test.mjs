#!/usr/bin/env node
// test/cli-prompt.test.mjs - the interactive connect prompt (lib/cli-prompt.mjs).
// Streams are injected so the TTY behaviour is exercised without a real terminal:
// a visible line prompt echoes, a secret prompt does NOT, and the non-interactive
// path fails closed (returns '') instead of hanging - the invariant that keeps the
// daemon / CI / mock runs safe.
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { promptLine, promptSecret, resolveCredential, isInteractive } from '../lib/cli-prompt.mjs';

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (e) { failures++; console.error(`FAIL - ${name}: ${e.message}`); }
}

function capture() {
  const chunks = [];
  const out = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } });
  out.columns = 80; // some readline terminal paths read this
  return { out, text: () => chunks.join('') };
}

await check('isInteractive() is false without a TTY (test env)', () => {
  assert.equal(isInteractive(), false);
});

await check('promptLine resolves the trimmed answer', async () => {
  const input = new PassThrough();
  const { out } = capture();
  const p = promptLine('Client ID: ', { input, output: out });
  input.write('  449370365247-abc.apps.googleusercontent.com  \n');
  assert.equal(await p, '449370365247-abc.apps.googleusercontent.com');
});

await check('promptSecret resolves the value but never echoes it', async () => {
  const input = new PassThrough();
  const { out, text } = capture();
  const p = promptSecret('Client secret: ', { input, output: out });
  input.write('GOCSPX-super-secret\n');
  const val = await p;
  assert.equal(val, 'GOCSPX-super-secret');
  assert.ok(text().includes('Client secret: '), 'the prompt itself is shown');
  assert.ok(!text().includes('GOCSPX-super-secret'), 'the secret must never appear in the output');
});

await check('resolveCredential returns an already-present value without prompting', async () => {
  assert.equal(await resolveCredential({ value: 'already-here', hint: 'x', secret: true }), 'already-here');
});

await check('resolveCredential fails closed (empty) when absent and non-interactive', async () => {
  // No TTY in the test env -> isInteractive() false -> no prompt, returns '' so the
  // caller emits its own "set it in .env" error instead of blocking forever.
  assert.equal(await resolveCredential({ value: '', hint: 'x', secret: true }), '');
});

if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
