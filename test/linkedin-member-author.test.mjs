#!/usr/bin/env node
// test/linkedin-member-author.test.mjs - the per-post LinkedIn author target
// (liAuthor: organization | member). A post publishing to the connected member's
// PERSONAL profile needs a captured person URN (LINKEDIN_PERSON_URN, written when
// the owner reconnects with the w_member_social scope). platformValidate fails
// CLOSED on a member post with no person URN - silently publishing to the Company
// Page instead would be the wrong destination (the DestinationStrip lesson).
//
// Proven here:
//   (1) org default: a connected LinkedIn post with no liAuthor is ready.
//   (2) member + person URN present: ready (member posting is available).
//   (3) member + NO person URN: blocked, needsSetup, names the reconnect fix.
//   (4) accountStatus surfaces linkedin.personUrn (write/read parity).
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib
// (util binds WORKSPACE_ROOT at import; mirrors test/platform-validate-lanes.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-li-member-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;

const plansDir = path.join(WS, 'data', 'plans');
const campDir = path.join(plansDir, 'li');
fs.mkdirSync(campDir, { recursive: true });

const FUTURE = '2099-01-01T09:00:00Z';
const post = (id, extra = {}) => ({
  id, platforms: ['linkedin'], type: 'text', scheduledAt: FUTURE, caption: 'a quiet note',
  image: 'https://res.cloudinary.com/x/hero.jpg', // silences the no-thumbnail warning
  status: 'planned', executionMode: 'fully-scheduled',
  approval: 'approved', approvalBy: 'owner', approvalAt: '2026-01-01T00:00:00Z',
  createdBy: 'agent:claude', ...extra,
});

fs.writeFileSync(path.join(plansDir, 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'li', path: 'data/plans/li/post-plan.json', active: true }],
}, null, 2));
fs.writeFileSync(path.join(campDir, 'post-plan.json'), JSON.stringify({
  campaign: 'LinkedIn author target',
  timezone: 'UTC',
  posts: [
    post('li-org'),
    post('li-member', { liAuthor: 'member' }),
  ],
}, null, 2));

// Connected LinkedIn lane: token + org urn. LINKEDIN_PERSON_URN is added later.
const writeEnv = (extra = []) => fs.writeFileSync(path.join(WS, '.env'), [
  'LINKEDIN_ACCESS_TOKEN=sentinel-li',
  'LINKEDIN_ORG_URN=urn:li:organization:99',
  ...extra,
  '',
].join('\n'), { mode: 0o600 });

const { platformValidate } = await import('../lib/writes.mjs');
const { accountStatus } = await import('../lib/accounts.mjs');
const li = async (postId) => {
  const r = await platformValidate({ campaign: 'li', postId });
  assert.ok(r.ok, `platformValidate(${postId}): ${JSON.stringify(r)}`);
  return r.platforms.linkedin;
};
const MEMBER_RE = /member posting needs a captured person URN|reconnect LinkedIn/i;

try {
  // (1) org default: no liAuthor -> ready, no member problem.
  writeEnv();
  const org = await li('li-org');
  ok(org.ready === true && org.problems.length === 0, 'org default: a connected LinkedIn post is ready, clean');

  // (3) member + NO person URN: blocked, needsSetup, names the fix (checked before (2)
  // so the missing-URN path is exercised while the env still lacks it).
  const memberNoUrn = await li('li-member');
  ok(memberNoUrn.ready === false, 'member without a person URN is NOT ready (fail closed)');
  ok(memberNoUrn.problems.some((p) => MEMBER_RE.test(p)), 'member without a person URN names the reconnect fix');
  ok(memberNoUrn.needsSetup === true, 'member without a person URN routes to the Setup page (needsSetup)');

  // (2) member + person URN present: ready, no member problem.
  writeEnv(['LINKEDIN_PERSON_URN=urn:li:person:MEMBER99']);
  const memberOk = await li('li-member');
  ok(memberOk.ready === true && !memberOk.problems.some((p) => MEMBER_RE.test(p)), 'member WITH a captured person URN is ready');

  // (4) accountStatus surfaces linkedin.personUrn (write/read parity).
  ok(accountStatus().linkedin.personUrn === 'urn:li:person:MEMBER99', 'accountStatus exposes linkedin.personUrn');
} catch (err) {
  console.error(`[linkedin-member-author] FAIL - ${err.message}`);
  process.exit(1);
}

console.log(`[linkedin-member-author] OK - per-post LinkedIn author target gates on a captured person URN (${pass} assertions).`);
process.exit(0);
