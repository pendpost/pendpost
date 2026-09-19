#!/usr/bin/env node
// test/youtube-api-disabled.test.mjs - spec-15 follow-on (60s-news 2026-09-19 live
// diagnosis). A Google 403 has THREE distinct meanings pendpost must keep apart,
// or the surfaced reason sends debugging down the wrong path:
//   1. accessNotConfigured / SERVICE_DISABLED  -> the API is DISABLED in the GCP
//      project; the fix is to ENABLE it in the Cloud console (NOT reconnect).
//      This was live-observed: the YouTube Analytics API not enabled in project
//      449370365247 surfaced as the misleading "youtube needs_scope".
//   2. insufficientPermissions (+ any non-quota, non-disabled 403) -> a genuinely
//      missing OAuth scope; the fix IS a reconnect (needs_scope).
//   3. quotaExceeded / rateLimitExceeded / dailyLimitExceeded -> wait / raise the
//      quota; neither reconnect nor enable (engine_failure with the real message).
//
// Proven here, credential-free and network-free:
//   A. the PURE yt-social classifiers (ytApiDisabled / ytNeedsScope) partition the
//      three 403 kinds correctly (and a non-403 is never either).
//   B. the insights sweep's reason classifier (failureClass) maps an api_disabled
//      row to 'api_disabled' - so the daily activity_log summary reads
//      "youtube api_disabled", not "youtube needs_scope".
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A throwaway root, set BEFORE importing lib (WORKSPACE_ROOT/activeRoot bind at
// import) - mirrors profile-edit.test.mjs.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-api-disabled-'));
process.env.PENDPOST_ROOT = WS;

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const err403 = (reason) => ({ status: 403, reason });

try {
  // ---- A. pure yt-social 403 classifiers ------------------------------------
  const { ytApiDisabled, ytNeedsScope } = await import('../scripts/yt-social.mjs');

  // (1) disabled-API reasons -> api_disabled, and NEVER needs_scope.
  for (const reason of ['accessNotConfigured', 'SERVICE_DISABLED']) {
    ok(ytApiDisabled(err403(reason)) === true, `ytApiDisabled: a 403 ${reason} IS api_disabled`);
    ok(ytNeedsScope(err403(reason)) === false, `ytNeedsScope: a 403 ${reason} is NOT needs_scope (the live mislabel this fix removes)`);
  }

  // (2) a genuine missing-scope 403 -> needs_scope, and NOT api_disabled.
  for (const reason of ['insufficientPermissions', 'forbidden', '']) {
    ok(ytNeedsScope(err403(reason)) === true, `ytNeedsScope: a 403 ${reason || '(no reason)'} IS needs_scope`);
    ok(ytApiDisabled(err403(reason)) === false, `ytApiDisabled: a 403 ${reason || '(no reason)'} is NOT api_disabled`);
  }

  // (3) a quota 403 -> neither (reads engine_failure with the real message).
  for (const reason of ['quotaExceeded', 'rateLimitExceeded', 'dailyLimitExceeded']) {
    ok(ytApiDisabled(err403(reason)) === false, `ytApiDisabled: a quota 403 (${reason}) is NOT api_disabled`);
    ok(ytNeedsScope(err403(reason)) === false, `ytNeedsScope: a quota 403 (${reason}) is NOT needs_scope`);
  }

  // (4) a non-403 is never either class, and a nullish err never throws.
  ok(ytApiDisabled({ status: 500, reason: 'accessNotConfigured' }) === false, 'ytApiDisabled: only a 403 counts (a 500 never does)');
  ok(ytNeedsScope({ status: 401 }) === false, 'ytNeedsScope: only a 403 counts (a 401 is the token class, handled elsewhere)');
  ok(ytApiDisabled(null) === false && ytNeedsScope(undefined) === false, 'both classifiers are null-safe');

  // ---- B. insights sweep reason classifier ----------------------------------
  const { failureClass } = await import('../lib/insights.mjs');

  // The structured api_disabled row the engine now emits.
  ok(failureClass({ error: 'api_disabled', errorMessage: 'YouTube Analytics API has not been used in project 449370365247 before or it is disabled.' }) === 'api_disabled',
    'failureClass: a structured api_disabled row -> api_disabled (so the summary reads "youtube api_disabled")');
  // Even a raw per-post message tail (no structured field) is caught by the text match.
  ok(failureClass({ errorMessage: 'HTTP 403 accessNotConfigured - ... it is disabled' }) === 'api_disabled',
    'failureClass: a raw accessNotConfigured message tail -> api_disabled');
  ok(failureClass({ errorMessage: 'SERVICE_DISABLED' }) === 'api_disabled',
    'failureClass: a SERVICE_DISABLED message tail -> api_disabled');
  // The other classes are unchanged.
  ok(failureClass({ error: 'needs_scope' }) === 'needs_scope', 'failureClass: a needs_scope row still -> needs_scope');
  ok(failureClass({ errorMessage: 'invalid_grant: token expired' }) === 'token', 'failureClass: an expired-token message still -> token');
  ok(failureClass({ errorMessage: 'ECONNRESET' }) === 'error', 'failureClass: an unrelated failure still -> error');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[youtube-api-disabled] OK - pure 403 classifiers partition api_disabled/needs_scope/quota, insights failureClass maps api_disabled honestly (${pass} assertions).`);
} catch (err) {
  console.error(`[youtube-api-disabled] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
