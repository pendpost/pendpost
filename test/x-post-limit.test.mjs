#!/usr/bin/env node
// test/x-post-limit.test.mjs - X's post limit is PER ACCOUNT.
//
// The X health probe caches the account's subscription tier (X API v2 /2/users/me
// subscription_type) in state.health.x.subscriptionType. lib/x-text.mjs xPostLimit()
// turns it into the limit every gate reads: 25,000 weighted chars for Basic, Premium and
// PremiumPlus, 280 for None, an unknown tier, or an account that was never probed.
//   1. None / never probed: a 286-char post still blocks with validate.xTooLong, and the
//      Check rows show the length ONCE (no duplicate caption-hard-cap brand-lint row).
//   2. Premium: the same post lints clean, has no preflight block and approves.
//   3. Publisher (scripts/x-social.mjs publish-due --dry-run): Premium does not refuse
//      the 286-char post; None refuses it with a structured ok:false invalid_input row.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-xlimit-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
// OAuth 1.0a creds: the X lane is connected, and the publisher needs no token refresh
// (so the dry run below makes no network call).
fs.writeFileSync(path.join(WS, '.env'), 'X_API_KEY=k\nX_API_SECRET=s\nX_ACCESS_TOKEN=t\nX_ACCESS_TOKEN_SECRET=ts\nX_HANDLE=pendpost\n', { mode: 0o600 });

const { createCampaign, createPost, approvePost, platformValidate } = await import('../lib/writes.mjs');
const { brandLint } = await import('../lib/lint.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const { accountStatus } = await import('../lib/accounts.mjs');

const setTier = (subscriptionType) => {
  const st = loadState();
  st.health = st.health || {};
  if (subscriptionType === undefined) delete st.health.x;
  else st.health.x = { ok: true, detail: 'connected as @pendpost', tokenExpiresAt: null, skipped: null, subscriptionType, checkedAt: new Date().toISOString() };
  saveState();
};

const CAMP = 'xlimit';
const LONG = 'a'.repeat(286); // the x-fence shape: just over 280, nothing else wrong

try {
  await createCampaign({ id: CAMP, note: 'x post limit', timezone: 'UTC', actor: 'owner' });
  await createPost({
    campaign: CAMP,
    post: { id: 'long', type: 'text', platforms: ['x'], scheduledAt: '2099-01-01T00:00:00Z', caption: LONG },
    actor: 'agent:claude',
  });

  // ---- 1. never probed, then None: 280, one Check row -------------------------------
  for (const tier of [undefined, 'None']) {
    setTier(tier);
    const label = tier ?? 'never probed';
    ok((await accountStatus()).x.postLimit === 280, `${label}: accounts.x.postLimit is 280`);
    ok(brandLint({ text: LONG, platform: 'x' }).clean === false, `${label}: a 286-char X text trips the hard cap`);
    const lane = (await platformValidate({ campaign: CAMP, postId: 'long' })).platforms.x;
    const codes = lane.problemCodes.map((c) => c?.code);
    ok(codes.filter((c) => c === 'validate.xTooLong').length === 1, `${label}: validate.xTooLong blocks the lane`);
    ok(!lane.problemCodes.some((c) => c?.code === 'validate.brandLint' && c.params?.rule === 'caption-hard-cap'),
      `${label}: no second caption-hard-cap row says the same thing (got ${JSON.stringify(codes)})`);
    ok(lane.problems.length === 1, `${label}: exactly ONE Check row (got ${lane.problems.length})`);
  }
  const refused = await approvePost({ campaign: CAMP, postId: 'long', actor: 'owner' });
  ok(refused.ok !== true, 'None: approval of the 286-char post is refused');

  // ---- 2. Premium: clean lint, no preflight block, approves ---------------------------
  setTier('Premium');
  const acc = (await accountStatus()).x;
  ok(acc.postLimit === 25000 && acc.subscriptionType === 'Premium', 'Premium: accounts.x carries subscriptionType + postLimit 25000');
  const lint = brandLint({ text: LONG, platform: 'x' });
  ok(!lint.findings.some((f) => f.rule === 'caption-hard-cap' || f.rule === 'caption-length'), 'Premium: a 286-char X text trips neither cap');
  const lane = (await platformValidate({ campaign: CAMP, postId: 'long' })).platforms.x;
  ok(lane.problems.length === 0, `Premium: no preflight problem on the x lane (got ${JSON.stringify(lane.problems)})`);
  const approved = await approvePost({ campaign: CAMP, postId: 'long', actor: 'owner' });
  ok(approved.ok === true, `Premium: the 286-char post approves (got ${JSON.stringify(approved)})`);
  ok(brandLint({ text: 'a'.repeat(25001), platform: 'x' }).findings.some((f) => f.rule === 'caption-hard-cap' && /hard cap 25000 on x/.test(f.match)),
    'Premium: over 25,000 still trips the hard cap, in the format the Composer parses');

  // ---- 3. publisher reads the cached tier ---------------------------------------------
  const planAbs = path.join(WS, 'pub-plan.json');
  fs.writeFileSync(planAbs, JSON.stringify({ posts: [{
    id: 'long', type: 'text', platforms: ['x'], caption: LONG, scheduledAt: '2020-01-01T00:00:00Z',
    executionMode: 'fully-scheduled', status: 'planned', approval: 'approved', approvalBy: 'owner',
  }] }, null, 2));
  const publish = () => {
    const out = execFileSync(process.execPath, [path.join(REPO, 'scripts/x-social.mjs'), 'publish-due', '--plan', planAbs, '--dry-run', '--json'], {
      env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: 'live' }, encoding: 'utf8',
    });
    const last = out.trim().split('\n').pop();
    return JSON.parse(last);
  };
  setTier('PremiumPlus');
  const prem = publish();
  ok(!(prem.results || []).some((r) => r.postId === 'long' && r.ok === false), `PremiumPlus: the publisher does not refuse the 286-char post (got ${JSON.stringify(prem.results)})`);
  setTier('None');
  const none = publish();
  const row = (none.results || []).find((r) => r.postId === 'long');
  ok(row && row.ok === false && row.errorCode === 'invalid_input' && /286/.test(row.errorMessage) && /280/.test(row.errorMessage),
    `None: the publisher refuses with an ok:false invalid_input row naming 286 and 280 (got ${JSON.stringify(row)})`);

  console.log(`\n[x-post-limit] OK - ${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
process.exit(0);
