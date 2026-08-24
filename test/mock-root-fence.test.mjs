#!/usr/bin/env node
// test/mock-root-fence.test.mjs - the mock-mode root fence + attempt parity.
//
// Failsafe 1: PENDPOST_MODE=mock against a LIVE workspace must refuse to run -
// the mock driver writes fake platform ids into real client plan files, and the
// scheduler then treats those posts as published forever. The fence
// (lib/mode.mjs assertMockRootAllowed) allows only roots under the OS temp dir
// (the whole test suite uses mkdtemp roots) or an explicit
// PENDPOST_MOCK_ALLOW_ROOT=1 opt-out.
//
// Failsafe 2 (attempt parity): every mock fake publish records an attempt row
// via recordAttempt like the live engines do - previously only Instagram did,
// so a mock youtube publish left NO audit trail at all.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib
// (util binds WORKSPACE_ROOT at import; mirrors test/account-mode.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-mockfence-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;
delete process.env.PENDPOST_MOCK_ALLOW_ROOT;

const { assertMockRootAllowed } = await import('../lib/mode.mjs');
const { runMockCommand } = await import('../lib/drivers/mock-driver.mjs');

try {
  // ---- live mode: the fence is inert on ANY root -----------------------------
  delete process.env.PENDPOST_MODE;
  assertMockRootAllowed('/Users/someone/pendpost');
  ok(true, 'live mode: any root passes (the fence only guards mock mode)');

  // ---- mock mode + live root: refused ---------------------------------------
  process.env.PENDPOST_MODE = 'mock';
  let threw = null;
  try { assertMockRootAllowed('/Users/someone/pendpost'); } catch (err) { threw = err; }
  ok(threw instanceof Error, 'mock mode + non-temp root throws');
  ok(/mock mode refused/.test(threw.message) && /PENDPOST_MOCK_ALLOW_ROOT=1/.test(threw.message)
    && /PENDPOST_ROOT/.test(threw.message),
    'the refusal names what happened, why it is dangerous, and both recovery paths');

  // ---- mock mode + mkdtemp root: allowed ------------------------------------
  assertMockRootAllowed(WS);
  ok(true, 'mock mode + a root under os.tmpdir() passes (the test-suite shape)');
  // /tmp-literal roots are accepted too (macOS symlinks /tmp -> /private/tmp).
  assertMockRootAllowed('/tmp/pendpost-demo');
  ok(true, 'mock mode + a /tmp root passes');

  // ---- explicit opt-out -----------------------------------------------------
  process.env.PENDPOST_MOCK_ALLOW_ROOT = '1';
  assertMockRootAllowed('/Users/someone/pendpost');
  ok(true, 'PENDPOST_MOCK_ALLOW_ROOT=1 allows a deliberate non-temp root');
  delete process.env.PENDPOST_MOCK_ALLOW_ROOT;

  // ---- the driver entry point enforces the fence ----------------------------
  // WORKSPACE_ROOT bound to the temp WS at import, so runMockCommand passes the
  // fence here; the throw path is proven above on the same function the driver
  // calls first. Prove the wiring: a fake youtube publish still works under WS.
  const planPath = path.join(WS, 'plan.json');
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  fs.writeFileSync(planPath, JSON.stringify({
    campaign: 'fence-test',
    posts: [{ id: 'p1', platforms: ['youtube'], type: 'video', approval: 'approved', status: 'draft', scheduledAt: future, attempts: [] }],
  }, null, 2));
  const res = await runMockCommand({ platform: 'youtube', command: 'publish-due', planPath });
  ok(res.ok === true && res.results.some((r) => r.platform === 'youtube' && r.ok === true),
    'mock youtube publish succeeds under a temp root');

  // ---- attempt parity: the fake publish left an audit row -------------------
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const post = plan.posts[0];
  ok(/^mock/.test(post.ytVideoId || ''), 'mock youtube publish minted a mock-prefixed id');
  const row = (post.attempts || []).find((a) => a.platform === 'youtube');
  ok(Boolean(row), 'mock youtube publish records an attempt row (live-engine parity)');
  ok(row.ok === true && row.actor === 'mock' && row.action === 'schedule-native',
    `the attempt row matches the live engine shape (ok:true, actor:mock, action:schedule-native; got ${JSON.stringify(row)})`);

  console.log(`[mock-root-fence] OK - mock refuses live roots, honours the opt-out, and fake publishes leave attempt rows (${pass} assertions).`);
} finally {
  delete process.env.PENDPOST_MODE;
  delete process.env.PENDPOST_MOCK_ALLOW_ROOT;
  fs.rmSync(WS, { recursive: true, force: true });
}
