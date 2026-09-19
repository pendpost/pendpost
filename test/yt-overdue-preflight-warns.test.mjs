#!/usr/bin/env node
// yt-overdue-preflight-warns - RC3 last gate. lanePreflight (the scheduler's dispatch
// gate AND the UI presubmit) used to REFUSE an overdue fully-scheduled YouTube post
// ("scheduledAt is in the past - reschedule first") as a blocking problem. But the engine
// clamps an overdue publishAt to ~2 min out and ships the video late, so refusing here was
// the last gate stranding an overdue Short (it blocked auto-ship late AND manual Publish
// Now). The past-scheduledAt is now a WARNING (publishes a little late), never a problem.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-ytpreflight-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { preflightContext, lanePreflight } = await import('../lib/writes.mjs');

const overduePast = (extra = {}) => ({
  id: 'yt1', platforms: ['youtube'], type: 'video', executionMode: 'fully-scheduled',
  title: 'a short honest title', description: 'a short honest description about the clip',
  tags: '', ids: {}, media: { exists: true }, scheduledAt: '2020-01-01T00:00:00Z', ...extra,
});
const isPastMsg = (m) => /in the past|future publishat/i.test(m);

try {
  const overdue = overduePast();
  const { problems, warnings } = lanePreflight(overdue, 'youtube', preflightContext(overdue));
  ok(!problems.some(isPastMsg),
    `an overdue youtube post's past scheduledAt is NOT a blocking problem (problems: ${JSON.stringify(problems)})`);
  ok(warnings.some(isPastMsg),
    'the past scheduledAt is surfaced as a WARNING (the engine clamps publishAt and ships it late)');

  // A FUTURE post carries neither the problem nor the warning.
  const future = overduePast({ scheduledAt: '2099-01-01T00:00:00Z' });
  const f = lanePreflight(future, 'youtube', preflightContext(future));
  ok(!f.problems.some(isPastMsg) && !f.warnings.some(isPastMsg),
    'a future youtube post carries no past-scheduledAt problem or warning');

  // An already-handed-off post (ytVideoId present) is not re-flagged either.
  const handed = overduePast({ ids: { ytVideoId: 'realVID12345' } });
  const h = lanePreflight(handed, 'youtube', preflightContext(handed));
  ok(!h.problems.some(isPastMsg) && !h.warnings.some(isPastMsg),
    'a post already carrying a ytVideoId is not flagged for a past scheduledAt');

  console.log(`[yt-overdue-preflight-warns] OK - overdue youtube warns, never blocks (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
