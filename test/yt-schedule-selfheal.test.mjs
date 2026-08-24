// yt-schedule-selfheal - the YouTube engine's schedule verb must not silently skip
// recoverable states (the daemon surfaced those as the reason-less "engine returned
// no result" failure):
//  1. status 'scheduled' WITHOUT a ytVideoId (a reverted handoff, e.g. a cleared
//     mock id) is re-scheduled instead of dropped.
//  2. an OVERDUE approved post clamps publishAt to the near future instead of
//     refusing (YouTube rejects a past publishAt).
// Runs the real engine in --dry-run (no token, no network) against a temp root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-ytheal-'));
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed += 1; console.log(`  ok - ${msg}`); };

const planDir = path.join(WS, 'data', 'plans', 'yh');
fs.mkdirSync(planDir, { recursive: true });
const mediaDir = path.join(WS, 'data', 'media');
fs.mkdirSync(mediaDir, { recursive: true });
// A dummy video file: resolveMediaPath only needs existence + extension; the A/V
// probe fails open on unprobeable bytes.
fs.writeFileSync(path.join(mediaDir, 'clip.mp4'), Buffer.alloc(1024));

const past = new Date(Date.now() - 60 * 60_000).toISOString();
const plan = {
  campaign: 'yh',
  timezone: 'UTC',
  folder: 'data/media',
  posts: [{
    id: 'poisoned',
    type: 'youtube-short',
    platforms: ['youtube'],
    executionMode: 'fully-scheduled',
    status: 'scheduled', // poisoned: says scheduled, but no ytVideoId exists
    approval: 'approved',
    scheduledAt: past, // and overdue on top
    title: 'a short honest test title',
    description: 'a short honest test description',
    file: 'clip.mp4',
  }],
};
const planPath = path.join(planDir, 'post-plan.json');
fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

try {
  const out = execFileSync('node', [path.join(ROOT, 'scripts', 'yt-social.mjs'), 'schedule', '--plan', planPath, '--dry-run'], {
    cwd: ROOT,
    env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: '' },
    encoding: 'utf8',
  });
  ok(/re-scheduling it/.test(out),
    'a status "scheduled" post with no ytVideoId is picked up again (self-heal), not silently skipped');
  ok(/clamping publishAt/.test(out),
    'an overdue post clamps publishAt to the near future instead of refusing');
  ok(/\[dry\] poisoned: would schedule/.test(out),
    `the dry-run reaches the actual schedule step for the healed post (output tail: ${JSON.stringify(out.slice(-200))})`);
  const publishAtMatch = out.match(/auto-publish at ([0-9T:.Z-]+)/);
  ok(publishAtMatch && Date.parse(publishAtMatch[1]) > Date.now(),
    `the clamped publishAt is in the future (got ${publishAtMatch && publishAtMatch[1]})`);
  console.log(`[yt-schedule-selfheal] OK - the engine heals the reverted-handoff state and ships overdue posts (${passed} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
