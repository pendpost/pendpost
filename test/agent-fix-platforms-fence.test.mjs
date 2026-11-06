#!/usr/bin/env node
// test/agent-fix-platforms-fence.test.mjs - the one WHERE field an agent fix may touch.
//
// Freigaben error UX (2026-11-06): a post aimed at a platform its project has turned off
// (validate.fbDisabled) is fixed by removing that platform. The fix fence lets plan_update_post
// carry `platforms` ONLY as a non-empty strict subset of the post's platforms when the job
// started: removal is allowed, adding, emptying or resending the same set is refused. The brief
// tells the child that removing the platform is its only option (turning the project setting on
// stays the owner's).
//
// Pure: the fence is armed directly (no child, no plan files). Zero-dep node:assert style.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-fix-platforms-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

try {
  const runner = await import('../lib/agent-runner.mjs');
  const fix = await import('../lib/agent-fix.mjs');
  const { beginFixFence, endFixFence, fixFenceRefusal, platformsSubsetRefusal } = runner;

  // ---- 1. the pure subset rule ---------------------------------------------------
  const start = ['instagram', 'facebook', 'linkedin'];
  const fb = ['facebook'];
  ok(platformsSubsetRefusal(['instagram', 'linkedin'], start, fb) === null, 'removing the flagged platform is allowed');
  ok(/only a platform turned off/.test(platformsSubsetRefusal(['instagram'], start, fb) || ''), 'removing the flagged one plus a non-flagged one is refused');
  ok(/only a platform turned off/.test(platformsSubsetRefusal(['instagram', 'facebook'], start, fb) || ''), 'removing a non-flagged platform is refused');
  ok(/no platform that is turned off/.test(platformsSubsetRefusal(['instagram', 'linkedin'], start, []) || ''), 'a job with no off-platform issue refuses every platforms write');
  ok(/no platform that is turned off/.test(platformsSubsetRefusal(['instagram', 'linkedin'], start) || ''), 'removable defaults to none');
  ok(/no platform that is turned off/.test(platformsSubsetRefusal(['instagram'], ['instagram'], ['facebook']) || ''), 'a flagged platform the post does not have gives no right');
  ok(/never gain/.test(platformsSubsetRefusal(['instagram', 'linkedin', 'x'], start, fb) || ''), 'adding a platform is refused');
  ok(/never gain/.test(platformsSubsetRefusal(['instagram', 'x'], start, fb) || ''), 'swapping a platform in is refused');
  ok(/emptied/.test(platformsSubsetRefusal([], start, fb) || ''), 'an empty list is refused');
  ok(/drop at least one/.test(platformsSubsetRefusal(['facebook', 'linkedin', 'instagram'], start, fb) || ''), 'the same set (any order) is refused');
  ok(/drop at least one/.test(platformsSubsetRefusal(['instagram', 'instagram', 'facebook', 'linkedin'], start, fb) || ''), 'duplicates do not disguise the same set');
  ok(/list of platform ids/.test(platformsSubsetRefusal('instagram', start, fb) || ''), 'a non-list is refused');
  ok(/list of platform ids/.test(platformsSubsetRefusal([null], start, fb) || ''), 'a list with a non-string is refused');

  // ---- 2. the armed fence ----------------------------------------------------------
  beginFixFence({ root: WS, campaign: 'c1', postId: 'p1', platforms: start, removable: fb });
  const call = (fields, postId = 'p1') => fixFenceRefusal('plan_update_post', WS, 'c1', postId, { fields });
  ok(call({ platforms: ['instagram', 'linkedin'] }) === null, 'fenced: removing the flagged facebook is allowed');
  ok(call({ platforms: ['instagram', 'linkedin'], caption: 'shorter' }) === null, 'fenced: removal plus a content field is allowed');
  ok(/turned-off platform/.test(call({ platforms: ['instagram', 'facebook'] }) || ''), 'fenced: removing non-flagged linkedin is refused');
  ok(/turned-off platform/.test(call({ platforms: ['instagram', 'linkedin', 'x'] }) || ''), 'fenced: adding x is refused');
  ok(/turned-off platform/.test(call({ platforms: [] }) || ''), 'fenced: emptying platforms is refused');
  ok(/turned-off platform/.test(call({ platforms: [...start] }) || ''), 'fenced: resending the same set is refused');
  ok(/refused: scheduledAt/.test(call({ platforms: ['instagram', 'linkedin'], scheduledAt: '2026-12-01T10:00:00Z' }) || ''), 'fenced: a WHEN field next to platforms is still refused');
  ok(fixFenceRefusal('plan_update_post', WS, 'c1', 'p2', { fields: { platforms: ['instagram', 'linkedin'] } }) !== null, 'fenced: removal on another post is refused');
  const refused = endFixFence();
  ok(refused.length === 6, `every refusal is recorded (got ${refused.length})`);

  // A job whose issues flag no platform as off refuses every platforms write.
  beginFixFence({ root: WS, campaign: 'c1', postId: 'p1', platforms: start, removable: [] });
  ok(/turned-off platform/.test(call({ platforms: ['instagram', 'linkedin'] }) || ''), 'fenced, no off-platform issue: removing facebook is refused');
  endFixFence();
  beginFixFence({ root: WS, campaign: 'c1', postId: 'p1' });
  ok(call({ platforms: ['instagram'] }) !== null, 'fenced without a starting set: any platforms write is refused');
  endFixFence();

  // The job derives removable from its own issues, and only from the off codes.
  ok(JSON.stringify(fix.removablePlatformsOf({ edit: [{ platform: 'facebook', code: 'validate.fbDisabled' }, { platform: 'x', code: 'validate.xTooLong' }] })) === '["facebook"]', 'removablePlatformsOf takes only the off-platform issues');
  ok(fix.removablePlatformsOf({ edit: [{ platform: 'x', code: 'validate.xTooLong' }] }).length === 0, 'a content-only issue makes nothing removable');

  // ---- 3. the brief ---------------------------------------------------------------
  const fbIssue = (platforms) => ({
    kind: 'edit',
    post: { platforms, approval: 'draft' },
    edit: [{ platform: 'facebook', code: 'validate.fbDisabled', text: 'facebook publishing is disabled by platform policy - enable via config.platforms.facebook=true', fix: 'edit' }],
    other: [],
    failure: null,
  });
  const brief = fix.agentFixPrompt({ clientId: 'acme', campaign: 'c1', postId: 'p1', issue: fbIssue(['instagram', 'facebook']) });
  ok(/Your only option is to remove it: save platforms as \["instagram"\]/.test(brief), 'the fbDisabled brief tells the agent to remove facebook');
  ok(/you cannot turn it on/.test(brief), 'the brief says turning it on is not the agent\'s');
  ok(!/config\.platforms\.facebook=true/.test(brief), 'the brief never repeats the "enable via config" sentence');
  ok(/plus platforms when it only REMOVES/.test(brief), 'the editable-field list names the removal-only platforms write');
  ok(!/[\u2013\u2014]/.test(brief), 'no em or en dash in the brief');
  const solo = fix.agentFixPrompt({ campaign: 'c1', postId: 'p1', issue: fbIssue(['facebook']) });
  ok(/only platform, so change nothing/.test(solo), 'facebook as the only platform: the brief says change nothing');
  const plain = fix.agentFixPrompt({ campaign: 'c1', postId: 'p1', issue: { kind: 'edit', post: { platforms: ['x'] }, edit: [{ platform: 'x', code: 'validate.xTooLong', text: 'too long', fix: 'edit' }], other: [], failure: null } });
  ok(!/Your only option is to remove it/.test(plain), 'a brief without a turned-off platform has no removal step');
} catch (err) {
  failures += 1;
  console.error('  FAIL - threw:', err && err.stack ? err.stack : err);
} finally {
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* temp */ }
}

console.log(`\n${pass} passed, ${failures} failed`);
if (failures) process.exit(1);
