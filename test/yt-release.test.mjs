#!/usr/bin/env node
// test/yt-release.test.mjs - the run-now YouTube RELEASE recovery. When YouTube
// leaves a natively-scheduled video PRIVATE past its publishAt (verify read-back
// 'private-overdue'), pendpost makes it public via a metadata-only videos.update -
// NEVER a re-upload (re-running `schedule` would mint a duplicate video). Proves:
//   - the engine `release` command exists, is wired, and uses videos.update (PUT
//     /videos, privacyStatus public) and NOT insertVideo;
//   - the youtube-release lane is registered (ENGINES, LANE_PLATFORMS) and owed by
//     lanesFor ONLY for a private-overdue id (never racing the upload lane);
//   - buildPublishJob accepts the lane (KNOWN_LANES) so local dispatch can run it;
//   - mock release returns a public envelope with no network.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ytSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'yt-social.mjs'), 'utf8');
const schedulerSrc = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'scheduler.mjs'), 'utf8');

const { buildPublishJob } = await import('../lib/publish-job.mjs');

try {
  // ===== (1) engine release command: wired + metadata-only (no re-upload) =====
  ok(/release: cmdRelease/.test(ytSrc), 'release is wired into the COMMANDS map');
  const start = ytSrc.indexOf('async function cmdRelease');
  ok(start >= 0, 'cmdRelease is defined');
  const relBody = ytSrc.slice(start, start + 2600);
  ok(/api\('PUT', '\/videos'/.test(relBody) && /privacyStatus: 'public'/.test(relBody),
    'cmdRelease flips privacyStatus public via videos.update (PUT /videos)');
  ok(!/insertVideo\(/.test(relBody), 'cmdRelease NEVER re-uploads (no insertVideo) - no duplicate video');

  // ===== (2) youtube-release lane registered + owed only for private-overdue =====
  ok(/'youtube-release': \{[^}]*command: 'release'/.test(schedulerSrc),
    'ENGINES has the youtube-release lane -> release command');
  ok(/lanes\.push\('youtube-release'\)/.test(schedulerSrc) && /private-overdue/.test(schedulerSrc),
    'lanesFor owes youtube-release only on a private-overdue YouTube video');
  ok(/'youtube-release': \['youtube'\]/.test(schedulerSrc), 'LANE_PLATFORMS maps youtube-release -> [youtube]');
  // The recovery stays LOCAL: it must NOT pollute the shared lanesOwed (the cloud
  // push contract). lanesOwed gates youtube purely on the missing id.
  const owedBody = schedulerSrc.slice(schedulerSrc.indexOf('export function lanesOwed'), schedulerSrc.indexOf('function lanesFor'));
  ok(!/youtube-release/.test(owedBody), 'lanesOwed (shared with the cloud) does NOT emit youtube-release');

  // ===== (3) buildPublishJob accepts the lane (KNOWN_LANES) - local dispatch needs it =====
  const post = { id: 'yt1', approval: 'approved', approvalBy: 'owner', createdBy: 'owner', platforms: ['youtube'], type: 'youtube-short', ids: { ytVideoId: 'VID' }, media: { path: '/x.mp4' } };
  const job = buildPublishJob(post, 'youtube-release', { clientId: 'c', campaign: 'cam', command: 'release', timeoutMs: 1, lanePlatforms: ['youtube'] });
  ok(job && job.lane === 'youtube-release' && job.engine.command === 'release',
    'buildPublishJob describes a youtube-release job (lane is in KNOWN_LANES)');

  // ===== (4) mock release returns a public envelope, no network =====
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-ytrel-'));
  fs.mkdirSync(path.join(WS, 'data', 'plans', 'c'), { recursive: true });
  const plan = path.join(WS, 'data', 'plans', 'c', 'post-plan.json');
  fs.writeFileSync(plan, JSON.stringify({
    campaign: 'c', timezone: 'UTC',
    posts: [{ id: 'yt1', type: 'youtube-short', platforms: ['youtube'], scheduledAt: '2026-06-29T07:00:00Z', ytVideoId: 'VID123', status: 'scheduled', approval: 'approved' }],
  }));
  const out = execFileSync(process.execPath,
    [path.join(REPO_ROOT, 'scripts', 'yt-social.mjs'), 'release', '--plan', plan, '--only', 'yt1', '--json'],
    { cwd: REPO_ROOT, env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: 'mock' }, encoding: 'utf8' });
  const env = JSON.parse(out.trim().split('\n').pop());
  ok(env.ok && env.results.some((r) => r.action === 'release' && r.ok && r.state === 'public'),
    'mock release returns a public release result (no network)');

  console.log(`\n${pass} assertions passed.`);
} catch (e) {
  console.error('FAIL -', e.message);
  if (e.stdout) console.error(String(e.stdout));
  process.exit(1);
}
