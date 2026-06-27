#!/usr/bin/env node
// test/rules-profile.test.mjs - the PER-CLIENT RULES PROFILE extension seam
// (extensibility-sdk.md #2). lib/lint.mjs resolves rules.json under activeRoot()
// with a per-ROOT compiled-rule cache, so each client keeps its OWN brand-lint
// profile and no client's rules leak into another. This proves the isolation
// guarantee with a FOCUSED assertion: two clients with DIFFERENT rules.json
// produce DIFFERENT lint verdicts for the SAME caption.
//
// One process, one PENDPOST_ROOT (util binds DATA_ROOT at import). Mock mode, no
// network. We drop a rules.json into each client subtree and switch with
// withClient(clientRoot(id)), exactly how api/mcp dispatch binds a clientId.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-rules-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
const { withClient, activeRoot } = await import('../lib/context.mjs');
const { createClient } = await import('../lib/clients.mjs');
const { brandLint, reloadRules } = await import('../lib/lint.mjs');

// The same caption is linted under both clients; only the per-client rules.json
// differs, so any difference in verdict proves per-client resolution + cache.
const CAPTION = 'Grab the deal now before it is gone';

try {
  // ---- boot: default client, plus a second client "acme" ----
  initMultiClient();
  const defPlans = path.join(activeRoot(), 'data', 'plans');
  fs.mkdirSync(defPlans, { recursive: true });
  fs.writeFileSync(path.join(defPlans, 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
  const created = createClient({ id: 'acme', displayName: 'Acme Co', timezone: 'UTC', actor: 'owner' });
  ok(created.ok, 'createClient registered a second client (acme)');

  // ---- DIFFERENT rules.json per client ----
  // default: the word "deal" is a hard ERROR (brand bans promo language).
  withClient(clientRoot('default'), () => {
    fs.writeFileSync(path.join(activeRoot(), 'rules.json'), JSON.stringify({
      version: 1,
      rules: [{ id: 'no-deal', severity: 'error', matcher: { regex: '\\bdeal\\b', flags: 'gi' }, hint: 'no promo language' }],
    }, null, 2));
  });
  // acme: a DIFFERENT rule on a DIFFERENT word ("now"), only a WARN - the same
  // caption is therefore CLEAN for acme (no error) but BLOCKED for default.
  withClient(clientRoot('acme'), () => {
    fs.writeFileSync(path.join(activeRoot(), 'rules.json'), JSON.stringify({
      version: 1,
      rules: [{ id: 'soft-now', severity: 'warn', matcher: { regex: '\\bnow\\b', flags: 'gi' }, hint: 'consider a softer CTA' }],
    }, null, 2));
  });
  // Drop any compiled cache so the freshly-written files are read.
  reloadRules();

  // ---- the SAME caption, DIFFERENT verdict per client ----
  const defVerdict = withClient(clientRoot('default'), () => brandLint({ text: CAPTION }));
  const acmeVerdict = withClient(clientRoot('acme'), () => brandLint({ text: CAPTION }));

  ok(defVerdict.clean === false && defVerdict.errors === 1, 'default client: the caption is BLOCKED (1 error) by its own "no-deal" rule');
  ok(defVerdict.findings.some((f) => f.rule === 'no-deal'), 'default client: the blocking finding is its own no-deal rule');
  ok(acmeVerdict.clean === true && acmeVerdict.errors === 0, 'acme client: the SAME caption is CLEAN (0 errors) under its own profile');
  ok(acmeVerdict.warnings === 1 && acmeVerdict.findings.some((f) => f.rule === 'soft-now'), 'acme client: only its own soft-now WARN fires');
  ok(!acmeVerdict.findings.some((f) => f.rule === 'no-deal'), 'acme client: default\'s no-deal rule did NOT leak across clients');
  ok(!defVerdict.findings.some((f) => f.rule === 'soft-now'), 'default client: acme\'s soft-now rule did NOT leak across clients');
  // The verdicts genuinely differ on clean-ness for the identical input.
  ok(defVerdict.clean !== acmeVerdict.clean, 'the SAME caption yields OPPOSITE clean verdicts under the two clients\' profiles');

  // ---- per-client cache: re-reading without an edit serves each its OWN ----
  const defAgain = withClient(clientRoot('default'), () => brandLint({ text: CAPTION }));
  const acmeAgain = withClient(clientRoot('acme'), () => brandLint({ text: CAPTION }));
  ok(defAgain.clean === false && acmeAgain.clean === true, 'cached re-lint keeps each client on its OWN compiled rules (no cross-stomp)');

  console.log(`[rules-profile] OK - per-client rules.json -> different lint verdicts for the same caption; no cross-client rule leak (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
