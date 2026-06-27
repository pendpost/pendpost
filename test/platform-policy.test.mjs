#!/usr/bin/env node
// test/platform-policy.test.mjs - the per-client platform policy (Facebook
// DENY-BY-DEFAULT, the 2026-06 Meta-suspension lesson) proven FAIL-CLOSED at all
// three layers:
//   (1) the shared lib/mode.mjs platformEnabled helper (policy logic + env hard-lock),
//   (2) the meta ENGINE - the ONLY place a real FB Graph call happens - which must
//       skip FB writes BEFORE touching credentials unless the client opts in,
//   (3) the lib guards: platformValidate (readiness) + the scheduler (lane select).
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib so
// WORKSPACE_ROOT binds to it (mirrors test/circuit-breaker.test.mjs). PENDPOST_MODE
// is mock for the in-process scheduler run; the engine subprocess forces LIVE so the
// FB gate (not the mock short-circuit) is what stops the write.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-policy-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS; // keep ambient hard-lock out of the unit asserts

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
const CLIP = Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), CLIP);

const mode = await import('../lib/mode.mjs');
const { createCampaign, createPost, approvePost, platformValidate } = await import('../lib/writes.mjs');
const { runDueExclusive, lanesOwed } = await import('../lib/scheduler.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');

const getPost = (camp, id) => (loadPlanStore().campaigns.find((c) => c.id === camp)?.posts || []).find((p) => p.id === id);
async function approvedReel(camp, id, platforms) {
  const cc = await createCampaign({ id: camp, note: camp, timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok || cc.code === 'exists', `createCampaign(${camp}): ${JSON.stringify(cc)}`);
  const cp = await createPost({
    campaign: camp,
    post: { id, type: 'reel', platforms, scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'a quiet clip' },
    actor: 'agent:claude',
  });
  assert.ok(cp.ok, `createPost(${camp}/${id}): ${JSON.stringify(cp)}`);
  const ap = await approvePost({ campaign: camp, postId: id, actor: 'owner' });
  assert.ok(ap.ok, `approvePost(${camp}/${id}): ${JSON.stringify(ap)}`);
}
const setPolicy = (obj) => fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify(obj));
const clearPolicy = () => fs.rmSync(path.join(WS, 'config.json'), { force: true });

try {
  // ===== (1) platformEnabled: the policy logic =====
  ok(mode.platformEnabled('facebook', {}) === false, 'facebook is DENY-by-default (empty policy)');
  ok(mode.platformEnabled('instagram', {}) === true, 'instagram is allowed by default');
  ok(mode.platformEnabled('linkedin', {}) === true, 'linkedin is allowed by default');
  ok(mode.platformEnabled('facebook', { platforms: { facebook: true } }) === true, 'facebook opt-in via config.platforms.facebook=true');
  ok(mode.platformEnabled('facebook', { platforms: {} }) === false, 'an empty platforms map keeps facebook off');
  ok(mode.platformEnabled('instagram', { platforms: { instagram: false } }) === false, 'any platform can be explicitly disabled');
  process.env.PENDPOST_DISABLED_PLATFORMS = 'facebook , youtube';
  ok(mode.platformEnabled('facebook', { platforms: { facebook: true } }) === false, 'PENDPOST_DISABLED_PLATFORMS hard-lock overrides a config opt-in');
  ok(mode.platformEnabled('youtube', {}) === false, 'the hard-lock disables a normally-allowed platform too');
  ok(mode.platformEnabled('instagram', {}) === true, 'the hard-lock only affects the named platforms');
  delete process.env.PENDPOST_DISABLED_PLATFORMS;

  // ===== (2) the meta ENGINE gate (the only real-FB-call path), forced LIVE =====
  const engine = path.join(REPO_ROOT, 'scripts', 'meta-social.mjs');
  const clip = path.join(WS, 'data', 'media', 'clip.mp4');
  const runFbreel = (extraEnv) => {
    try {
      return execFileSync(process.execPath, [engine, 'fbreel', '--file', clip, '--json'],
        { cwd: REPO_ROOT, env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: 'live', ...extraEnv }, encoding: 'utf8' });
    } catch (e) { return `${e.stdout || ''}${e.stderr || ''}`; }
  };
  clearPolicy();
  const off = runFbreel({});
  ok(/facebook_disabled/.test(off), 'engine fbreel (FB default-off, LIVE, no creds): skips with facebook_disabled');
  ok(!/META_PAGE_ID missing/.test(off), 'the FB skip returns BEFORE requiring credentials (true fail-closed no-op)');
  setPolicy({ platforms: { facebook: true } });
  const on = runFbreel({});
  ok(/META_PAGE_ID missing/.test(on), 'engine fbreel (opted IN) proceeds past the gate to the real publish path');
  const locked = runFbreel({ PENDPOST_DISABLED_PLATFORMS: 'facebook' });
  ok(/facebook_disabled/.test(locked), 'engine fbreel: the env hard-lock overrides the config opt-in');
  clearPolicy();

  // ===== (3a) platformValidate readiness: FB blocked by policy, IG unaffected =====
  await approvedReel('val', 'p1', ['facebook', 'instagram']);
  const pv = await platformValidate({ campaign: 'val', postId: 'p1' });
  ok(pv.ok && pv.platforms, 'platformValidate returns per-platform results');
  ok(pv.platforms.facebook.problems.some((p) => /platform policy/i.test(p)), 'facebook carries a "disabled by platform policy" problem (never ready)');
  ok(pv.platforms.facebook.ready === false, 'the facebook lane is not ready under the default policy');
  ok(!pv.platforms.instagram.problems.some((p) => /platform policy/i.test(p)), 'instagram is NOT touched by the facebook policy');

  // ===== (3b) the scheduler skips a FB-only post when FB is disabled (no spawn) =====
  await approvedReel('sch', 'fbonly', ['facebook']);
  await runDueExclusive('owner', { campaign: 'sch', postId: 'fbonly' });
  const fbonly = getPost('sch', 'fbonly');
  ok(!fbonly.ids.fbReelId && !fbonly.ids.fbPostId && fbonly.status !== 'posted',
    'a FB-only post with FB disabled is NOT published (scheduler never marked the meta lane due)');

  // ===== (3c) opt-in flips it: the same FB-only shape now publishes (mock) =====
  setPolicy({ platforms: { facebook: true } });
  await approvedReel('sch2', 'fbonly2', ['facebook']);
  await runDueExclusive('owner', { campaign: 'sch2', postId: 'fbonly2' });
  const fbonly2 = getPost('sch2', 'fbonly2');
  ok(Boolean(fbonly2.ids.fbReelId), 'with facebook opted IN, the scheduler marks the meta lane due and the (mock) publish mints an fbReelId');
  clearPolicy();

  // ===== (3d) lanesOwed gating: a disabled platform owes NO lane (never spawns/pushes) =====
  const postAll = { platforms: ['instagram', 'linkedin', 'x', 'youtube'], type: 'reel', ids: {} };
  clearPolicy();
  ok(JSON.stringify([...lanesOwed(postAll)].sort()) === JSON.stringify(['linkedin', 'meta', 'x', 'youtube']),
    'lanesOwed: every targeted platform owes its lane under the default policy');
  setPolicy({ platforms: { instagram: false, x: false } });
  const owed = lanesOwed(postAll);
  ok(!owed.includes('meta'), 'lanesOwed: a disabled instagram owes no meta lane');
  ok(!owed.includes('x'), 'lanesOwed: a disabled x owes no x lane');
  ok(owed.includes('linkedin') && owed.includes('youtube'), 'lanesOwed: the still-enabled lanes are unaffected');
  clearPolicy();

  console.log(`[platform-policy] OK - FB deny-by-default fail-closed at the helper, the live engine, platformValidate, the scheduler, AND lanesOwed gating; opt-in + env hard-lock both honored (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
