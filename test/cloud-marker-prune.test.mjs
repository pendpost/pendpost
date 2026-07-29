#!/usr/bin/env node
// test/cloud-marker-prune.test.mjs - the connected-but-PAUSED brand (scheduler Branch B) used to
// poll the cloud on EVERY tick forever, because cloudInFlight() counted RELIC markers: a
// cloudAccepted / cloudFailures / cloudRetriggered entry for a post that has long since posted (or
// vanished from the plan) is never cleared, so the in-flight gate stayed permanently true. Live
// evidence 2026-07-29: 24 acks + 9 failures (pendpost) and 18 + 1 (bondigoo), most of them relics,
// driving ~2,880 PUT /v1/brands a day against the cloud (each one a Neon write AND a live Stripe
// subscriptions.list).
//
// The discriminator is post OPENNESS, not age: reconcileCloudResults rewrites a failure's `at` on
// every poll, so ages never grow. liveCloudMarkers counts only markers whose post is still open
// (approved + unposted), and pruneCloudMarkers deletes the rest. Both are pure over the state
// object + the open-key set; no network, no plan writes.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-markerprune-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { liveCloudMarkers, pruneCloudMarkers } = await import('../lib/scheduler.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// The live shape, reduced: one ack + one failure for a post that is still open, and the relics -
// an ack for a since-posted post, a retrigger anchor for a vanished campaign, and a failure the
// remediator already declared terminal.
const stateFixture = () => ({
  cloudAccepted: {
    'launch:open-post:x': { at: '2026-07-28T08:00:00.000Z' },
    'launch:already-posted:x': { at: '2026-07-08T07:20:00.000Z' },
    'gone-campaign:whatever:meta': { at: '2026-06-11T10:00:00.000Z' },
  },
  cloudFailures: {
    'launch:open-post': { lane: 'x', at: '2026-07-29T07:17:00.423Z' },
    'launch:already-posted': { lane: 'x', at: '2026-07-29T07:17:00.423Z' },
    'launch:open-post-terminal': { lane: 'x', at: '2026-07-29T07:17:00.423Z', terminal: true },
  },
  cloudRetriggered: {
    'launch:open-post:x': { at: '2026-07-28T09:00:00.000Z' },
    'gone-campaign:whatever:meta': { at: '2026-06-11T11:00:00.000Z' },
  },
});
const OPEN = new Set(['launch:open-post', 'launch:open-post-terminal']);

try {
  ok(typeof liveCloudMarkers === 'function', 'liveCloudMarkers is exported');
  ok(typeof pruneCloudMarkers === 'function', 'pruneCloudMarkers is exported');

  // --- liveCloudMarkers: only markers whose post is still open count ---------------
  const live = liveCloudMarkers(stateFixture(), OPEN);
  ok(live.accepted === 1, 'only the open post\'s ack counts (a posted post\'s ack is a relic)');
  ok(live.retriggered === 1, 'only the open post\'s retrigger anchor counts');
  ok(live.failures === 1, 'a terminal failure does not count as in flight');
  ok(live.total === 3, 'total is the sum of the three live counts');

  const none = liveCloudMarkers(stateFixture(), new Set());
  ok(none.total === 0, 'no open post -> nothing is in flight (this is what lets the polling stop)');

  const empty = liveCloudMarkers({}, OPEN);
  ok(empty.total === 0, 'an empty state has no markers');
  ok(liveCloudMarkers(null, OPEN).total === 0, 'a null state is tolerated (never throws)');

  // --- pruneCloudMarkers: deletes the relics, keeps everything still open ----------
  const s = loadState();
  Object.assign(s, stateFixture());
  saveState();

  const first = pruneCloudMarkers(OPEN);
  ok(first.pruned === 4, 'the four relic keys are deleted (2 acks, 1 failure, 1 retrigger anchor)');
  const after = loadState();
  ok(Object.keys(after.cloudAccepted).length === 1 && after.cloudAccepted['launch:open-post:x'], 'the open post\'s ack survives');
  ok(Object.keys(after.cloudRetriggered).length === 1, 'the open post\'s retrigger anchor survives');
  ok(Boolean(after.cloudFailures['launch:open-post']), 'an OPEN post\'s failure survives (it is the operator surface)');
  ok(Boolean(after.cloudFailures['launch:open-post-terminal']), 'a terminal failure for an open post is kept (it is the remediator\'s record), it just is not in flight');
  ok(!after.cloudFailures['launch:already-posted'], 'the posted post\'s stale failure is gone');

  // Idempotent + churn-free: a second prune changes nothing and must not rewrite state.
  const before = fs.readFileSync(path.join(WS, 'state.json'), 'utf8');
  const second = pruneCloudMarkers(OPEN);
  ok(second.pruned === 0, 'a second prune finds nothing to do');
  ok(fs.readFileSync(path.join(WS, 'state.json'), 'utf8') === before, 'an idempotent prune does not rewrite state.json (no per-tick churn)');

  console.log(`[cloud-marker-prune] OK - relic cloud markers no longer hold the paused-brand poll open forever (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
