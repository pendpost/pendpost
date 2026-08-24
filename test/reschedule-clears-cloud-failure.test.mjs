#!/usr/bin/env node
// test/reschedule-clears-cloud-failure.test.mjs - reschedule is the operator's
// "retry now" verb. It already clears the LOCAL failure state (publishHold /
// publishRetry on the post). This is the regression for its missing CLOUD twin:
// a post that failed a cloud attempt, then was rescheduled to a new (future) time,
// kept its stale state.cloudFailures[campaign:postId] entry. Because the post is
// still OPEN (approved + unposted), neither pruneCloudMarkers (keyed on openness)
// nor reconcile (keyed on the post posting) reaps it - so deriveSyncState kept
// counting it and the health dot showed a phantom red "Cloud: 1 nicht zugestellt"
// for a post 9 days from due that carried no failure of its own.
//
// Fix: reschedulePost clears cloudFailures / cloudAccepted / cloudRetriggered for
// the post, symmetric with the publishHold clear = "retry from scratch".
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-resched-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
const CLIP = Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), CLIP);

const { createCampaign, createPost, approvePost, reschedulePost } = await import('../lib/writes.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');

try {
  const cc = await createCampaign({ id: 'growth', note: 'growth', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, `createCampaign: ${JSON.stringify(cc)}`);
  const cp = await createPost({
    campaign: 'growth',
    post: { id: 'ig29', type: 'reel', platforms: ['instagram'], scheduledAt: '2026-08-16T10:00:00Z', path: 'data/media/clip.mp4', caption: 'a quiet behind the scenes clip about programmes' },
    actor: 'agent:claude',
  });
  assert.ok(cp.ok, `createPost: ${JSON.stringify(cp)}`);
  const ap = await approvePost({ campaign: 'growth', postId: 'ig29', actor: 'owner' });
  assert.ok(ap.ok, `approvePost: ${JSON.stringify(ap)}`);

  // Seed the relics a failed-then-abandoned cloud attempt leaves behind.
  const key = 'growth:ig29';
  const st = loadState();
  st.cloudFailures = { [key]: { lane: 'meta', jobId: `${key}:meta`, message: 'engine reported no successful publish', at: '2026-08-16T10:16:06.639Z', retries: 1 } };
  st.cloudAccepted = { [`${key}:meta`]: { at: '2026-08-16T10:15:00.000Z' } };
  saveState();

  // The operator reschedules the post to a new, future time = "retry now".
  const rs = await reschedulePost({ campaign: 'growth', postId: 'ig29', scheduledAt: '2026-08-26T10:00:00Z', actor: 'owner' });
  ok(rs.ok, `reschedulePost succeeds: ${JSON.stringify(rs)}`);

  const after = loadState();
  ok(!(after.cloudFailures && after.cloudFailures[key]), 'stale cloudFailures entry is cleared by reschedule');
  ok(!(after.cloudAccepted && after.cloudAccepted[`${key}:meta`]), 'stale cloudAccepted marker is cleared by reschedule');

  console.log(`\nPASS - ${pass} assertions`);
} catch (err) {
  console.error(`\nFAIL - ${err.message}`);
  console.error(err.stack);
  process.exit(1);
}
