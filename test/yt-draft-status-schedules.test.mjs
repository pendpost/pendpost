// yt-draft-status-schedules - RC1 regression. The YouTube engine's `schedule` verb must:
//  1. SCHEDULE an approved post that is still stamped status:'draft' (some plan writers
//     seed a draft entry directly, bypassing createPost's status:'planned' default). The
//     old gate fired only status:'planned' and dropped a draft with NO result row - the
//     daemon's reason-less "engine returned no result" that stranded three real Shorts.
//  2. Never SKIP without a reason: a genuinely non-plannable status (terminal 'cancelled')
//     is refused WITH an explicit skip result row, so the scheduler surfaces the reason
//     instead of the generic no_result.
// Runs the real engine in --dry-run (no token, no network) against a temp root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-ytdraft-'));
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed += 1; console.log(`  ok - ${msg}`); };

const planDir = path.join(WS, 'data', 'plans', 'yd');
fs.mkdirSync(planDir, { recursive: true });
const mediaDir = path.join(WS, 'data', 'media');
fs.mkdirSync(mediaDir, { recursive: true });
fs.writeFileSync(path.join(mediaDir, 'clip.mp4'), Buffer.alloc(1024));

const future = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
const base = {
  type: 'youtube-short', platforms: ['youtube'], executionMode: 'fully-scheduled',
  approval: 'approved', scheduledAt: future, title: 'a short honest test title',
  description: 'a short honest test description', file: 'clip.mp4',
};
const plan = {
  campaign: 'yd', timezone: 'UTC', folder: 'data/media',
  posts: [
    { ...base, id: 'draftpost', status: 'draft' },     // approved but stamped draft
    { ...base, id: 'cancelledpost', status: 'cancelled' }, // terminal: must never fire
  ],
};
const planPath = path.join(planDir, 'post-plan.json');
fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

const run = (extra) => execFileSync(
  'node',
  [path.join(ROOT, 'scripts', 'yt-social.mjs'), 'schedule', '--plan', planPath, '--dry-run', ...extra],
  { cwd: ROOT, env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: '' }, encoding: 'utf8' },
);

try {
  // (1) Console proof: the draft post reaches the schedule step; the cancelled one is
  // skipped WITH a named reason (no silent continue).
  const out = run([]);
  ok(/\[dry\] draftpost: would schedule/.test(out),
    'an approved status:"draft" post is scheduled, not silently skipped (RC1 fix)');
  ok(!/\[skip\] draftpost/.test(out) && !/\[warn\] draftpost/.test(out),
    'the draft post is never skipped/warned');
  ok(/\[skip\] cancelledpost: status is "cancelled"/.test(out),
    'a terminal-status post is skipped WITH its reason (never silent)');

  // (2) Envelope proof: the cancelled skip is a real RESULT ROW, so the scheduler can
  // never read this as a reason-less no_result (results.length > 0).
  const jsonOut = run(['--json']);
  const envelope = JSON.parse(jsonOut.trim().split('\n').pop());
  const skipRow = (envelope.results || []).find((r) => r.postId === 'cancelledpost');
  ok(skipRow && skipRow.ok === false && skipRow.errorCode === 'not_plannable',
    `the skip is a result row with a machine code (got ${JSON.stringify(skipRow)})`);
  ok((envelope.results || []).length > 0,
    'the engine returns at least one result row - the scheduler never logs a reason-less no_result');

  console.log(`[yt-draft-status-schedules] OK - draft posts schedule, terminal posts skip with a reason (${passed} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
