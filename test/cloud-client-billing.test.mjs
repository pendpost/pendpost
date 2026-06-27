#!/usr/bin/env node
// test/cloud-client-billing.test.mjs - the OPTIONAL managed-cloud billing surface on
// lib/cloud-client.mjs (the tiered-pricing half). Proves, with a mocked global.fetch and
// no network, that:
//   1. The billing functions are all exported (getSubscription, startCheckout,
//      startBillingPortal, setSpendCap).
//   2. startCheckout({plan, interval}) POSTs /v1/billing/checkout with the plan + interval
//      in the body (so the tier + cadence reach the engine), plus the loopback urls.
//   3. setSpendCap(cents) POSTs /v1/billing/spend-cap with { cents }.
//   4. The api key rides ONLY in the Authorization header, never in a url or a body.
// Mock mode + a mocked global.fetch; no network, no real cloud.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-cloud-billing-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const API_KEY = 'ppc_test_secret_abcdef0123456789';
fs.writeFileSync(path.join(WS, '.env'), `PENDPOST_CLOUD_API_KEY=${API_KEY}\n`);

const cloud = await import('../lib/cloud-client.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// A capturing fetch mock: records every call and answers the billing seam (and /v1/health
// for the connect). Returns a plausible body so the callers resolve.
const calls = [];
function installFetch() {
  global.fetch = async (input, opts = {}) => {
    const url = String(input);
    const method = opts.method || 'GET';
    const headers = opts.headers || {};
    const body = typeof opts.body === 'string' ? opts.body : (opts.body ? '<bytes>' : undefined);
    calls.push({ url, method, headers, body });
    const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (url.endsWith('/v1/health')) return json({ ok: true });
    if (url.endsWith('/v1/billing/checkout')) return json({ url: 'https://checkout.test/session' });
    if (url.endsWith('/v1/billing/portal')) return json({ url: 'https://portal.test/session' });
    if (url.endsWith('/v1/billing/spend-cap')) return json({ spendCapCents: JSON.parse(body || '{}').cents });
    if (url.endsWith('/v1/subscription')) return json({ alwaysOn: true, status: 'active', tier: 'studio', postsUsed: 5, postsIncluded: 300 });
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
  };
}

try {
  // --- (1) the billing functions are exported ----------------------------------
  ok(typeof cloud.getSubscription === 'function', 'getSubscription is exported');
  ok(typeof cloud.startCheckout === 'function', 'startCheckout is exported');
  ok(typeof cloud.startBillingPortal === 'function', 'startBillingPortal is exported');
  ok(typeof cloud.setSpendCap === 'function', 'setSpendCap is exported');

  installFetch();
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });

  // --- (2) startCheckout sends plan + interval in the body ----------------------
  calls.length = 0;
  const checkout = await cloud.startCheckout({ plan: 'studio', interval: 'year' });
  ok(checkout && checkout.url === 'https://checkout.test/session', 'startCheckout returns the checkout url');
  const checkoutCall = calls.find((c) => c.url.endsWith('/v1/billing/checkout'));
  ok(checkoutCall && checkoutCall.method === 'POST', 'startCheckout POSTs /v1/billing/checkout');
  const checkoutBody = JSON.parse(checkoutCall.body);
  ok(checkoutBody.plan === 'studio', 'the checkout body carries plan:studio');
  ok(checkoutBody.interval === 'year', 'the checkout body carries interval:year');
  ok(typeof checkoutBody.successUrl === 'string' && typeof checkoutBody.cancelUrl === 'string', 'the loopback success/cancel urls are still sent');

  // --- (3) setSpendCap sends { cents } -----------------------------------------
  calls.length = 0;
  const cap = await cloud.setSpendCap(5000);
  ok(cap && cap.spendCapCents === 5000, 'setSpendCap returns the new cap');
  const capCall = calls.find((c) => c.url.endsWith('/v1/billing/spend-cap'));
  ok(capCall && capCall.method === 'POST', 'setSpendCap POSTs /v1/billing/spend-cap');
  ok(JSON.parse(capCall.body).cents === 5000, 'the spend-cap body carries cents:5000');
  // null clears the cap.
  calls.length = 0;
  await cloud.setSpendCap(null);
  const clearCall = calls.find((c) => c.url.endsWith('/v1/billing/spend-cap'));
  ok(JSON.parse(clearCall.body).cents === null, 'setSpendCap(null) sends cents:null to clear the cap');

  // --- (4) the api key NEVER leaks (header only) -------------------------------
  let keyInHeaderCount = 0;
  for (const c of calls.concat(checkoutCall ? [checkoutCall] : [], capCall ? [capCall] : [])) {
    const auth = c.headers.Authorization || c.headers.authorization;
    if (auth === `Bearer ${API_KEY}`) keyInHeaderCount += 1;
    ok(!c.url.includes(API_KEY), `api key absent from url (${c.method} ${c.url.slice(0, 48)})`);
    ok(!(c.body || '').includes(API_KEY), `api key absent from body (${c.method})`);
  }
  ok(keyInHeaderCount >= 1, 'the api key rides ONLY in Authorization headers');

  console.log(`[cloud-client-billing] OK - tiered checkout sends plan+interval, spend-cap sends cents, no key leak (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
