#!/usr/bin/env node
// test/demo-guard.test.mjs - demo content can never publish in live mode.
//
// Until 2.13.1 pendpost shipped an example campaign (acme-launch) whose Instagram reel
// `teaser` was already APPROVED and dated June 2026. The scheduler fires on due <= now,
// so a workspace that still holds it (an install from before 2.13.1) would post it to a
// real account the moment Instagram is connected. 2.13.1 stopped shipping the example;
// this test pins the engine side:
//   1. a positive marker (`demo: true` on a post, on its plan file, or on its manifest
//      entry) keeps a post out of the shared eligibility gate (eligibleDuePosts), which
//      the local scheduler AND the cloud push both walk, in live mode;
//   2. the unmodified shipped teaser is recognised even before it carries the marker;
//   3. the boot sweep stamps the marker on exactly that legacy post (and parks its
//      shipped approval back to draft), never on a post the user wrote or edited;
//   4. mock mode still lets the demo run its full loop (that is what a demo is for);
//   5. the owner can turn the guard off (posting.demoLiveGuard: false).
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-demo-guard-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE; // LIVE: the mode a real user runs
delete process.env.PENDPOST_DEV_READONLY;

const PLANS = path.join(WS, 'data', 'plans');
const MEDIA = path.join(WS, 'data', 'media');
fs.mkdirSync(PLANS, { recursive: true });
fs.mkdirSync(MEDIA, { recursive: true });
const MP4 = Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
for (const f of ['acme-bts.mp4', 'acme-reel.mp4', 'mine.mp4']) fs.writeFileSync(path.join(MEDIA, f), MP4);

// The legacy teaser exactly as the npm package shipped it (52b996d7^:data/plans/acme-launch).
const SHIPPED_TEASER = {
  id: 'teaser',
  type: 'reel',
  platforms: ['instagram'],
  scheduledAt: '2026-06-21T12:00:00Z',
  path: 'data/media/acme-bts.mp4',
  caption: "A look behind the scenes before tomorrow's launch.",
  status: 'planned',
  approval: 'approved',
  createdBy: 'agent:claude',
  approvalBy: 'owner',
  approvalAt: '2026-06-20T10:00:00Z',
  createdAt: '2026-06-19T16:00:00Z',
};
const due = '2020-01-01T00:00:00Z';
const approved = (id, extra = {}) => ({
  id, type: 'reel', platforms: ['instagram'], scheduledAt: due, path: 'data/media/mine.mp4',
  caption: `my own post ${id}`, status: 'planned', approval: 'approved',
  createdBy: 'agent:claude', approvalBy: 'owner', approvalAt: '2026-11-01T10:00:00Z', ...extra,
});

const writePlan = (id, plan) => {
  fs.mkdirSync(path.join(PLANS, id), { recursive: true });
  fs.writeFileSync(path.join(PLANS, id, 'post-plan.json'), JSON.stringify(plan, null, 2));
};
const readPlan = (id) => JSON.parse(fs.readFileSync(path.join(PLANS, id, 'post-plan.json'), 'utf8'));

writePlan('acme-launch', {
  campaign: 'Acme Launch', timezone: 'UTC',
  posts: [
    SHIPPED_TEASER,
    // The user edited the caption of a second copy: theirs now, never touched.
    { ...SHIPPED_TEASER, id: 'teaser-edited', caption: 'Our real launch is today' },
    // The user's own post living in the example campaign.
    approved('own-in-acme'),
  ],
});
writePlan('marked-plan', { campaign: 'Marked by plan', timezone: 'UTC', demo: true, posts: [approved('p-plan')] });
writePlan('marked-entry', { campaign: 'Marked by manifest', timezone: 'UTC', posts: [approved('p-entry')] });
writePlan('mine', { campaign: 'Mine', timezone: 'UTC', posts: [approved('p-mine'), approved('p-flagged', { demo: true })] });
fs.writeFileSync(path.join(PLANS, 'active-plans.json'), JSON.stringify({
  plans: [
    { id: 'acme-launch', path: 'data/plans/acme-launch/post-plan.json', active: true },
    { id: 'marked-plan', path: 'data/plans/marked-plan/post-plan.json', active: true },
    { id: 'marked-entry', path: 'data/plans/marked-entry/post-plan.json', active: true, demo: true },
    { id: 'mine', path: 'data/plans/mine/post-plan.json', active: true },
  ],
}, null, 2));

const { eligibleDuePosts, getActivity } = await import('../lib/scheduler.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const demo = await import('../lib/demo.mjs');

const eligible = () => [...eligibleDuePosts(loadPlanStore().campaigns, {})].map((e) => `${e.campaign.id}/${e.post.id}`).sort();
const postOf = (c, id) => loadPlanStore().campaigns.find((x) => x.id === c).posts.find((p) => p.id === id);

try {
  // ---- 1 + 2: the shared gate, live mode ------------------------------------------
  const live = eligible();
  ok(!live.includes('acme-launch/teaser'), 'live: the unmodified shipped teaser is NOT eligible (recognised before any marker)');
  ok(!live.includes('marked-plan/p-plan'), 'live: a post in a plan file marked demo:true is NOT eligible');
  ok(!live.includes('marked-entry/p-entry'), 'live: a post in a manifest entry marked demo:true is NOT eligible');
  ok(!live.includes('mine/p-flagged'), 'live: a post marked demo:true is NOT eligible');
  ok(live.includes('mine/p-mine'), 'live: the user\'s own approved due post stays eligible');
  ok(live.includes('acme-launch/teaser-edited'), 'live: an edited copy of the teaser is the user\'s post and stays eligible');
  ok(live.includes('acme-launch/own-in-acme'), 'live: the user\'s own post inside the example campaign stays eligible');
  ok(postOf('acme-launch', 'teaser').demo === true, 'the read model surfaces demo:true on the recognised teaser');
  ok(postOf('mine', 'p-mine').demo === false, 'the read model surfaces demo:false on the user\'s post');
  ok(demo.demoPublishBlocked({ demo: true }) === true, 'demoPublishBlocked: a demo post is blocked in live');
  ok(demo.demoPublishBlocked({ demo: false }) === false, 'demoPublishBlocked: a normal post is never blocked');

  // ---- the cloud withdraw gate agrees: a demo job the cloud already holds is taken back
  const { cloudWithdrawReason } = await import('../lib/scheduler.mjs');
  ok(cloudWithdrawReason(postOf('mine', 'p-flagged'), 'meta') === 'demo', 'cloudWithdrawReason: a demo post is withdrawn from the cloud in live');
  ok(cloudWithdrawReason(postOf('mine', 'p-mine'), 'meta') === null, 'cloudWithdrawReason: the user\'s post is not withdrawn');

  // ---- 4: mock mode keeps the demo loop working -----------------------------------
  process.env.PENDPOST_MODE = 'mock';
  const mock = eligible();
  ok(mock.includes('mine/p-flagged') && mock.includes('marked-entry/p-entry') && mock.includes('acme-launch/teaser'),
    'mock: demo posts stay eligible, so the credential-free demo runs end to end');
  delete process.env.PENDPOST_MODE;

  // ---- 5: the owner setting ---------------------------------------------------------
  fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ demoLiveGuard: false }, null, 2));
  ok(eligible().includes('mine/p-flagged'), 'posting.demoLiveGuard:false lets a demo post publish in live (owner opt-out)');
  fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({}, null, 2));
  ok(!eligible().includes('mine/p-flagged'), 'the guard is on by default');

  // ---- 3: the boot sweep -------------------------------------------------------------
  const before = readPlan('acme-launch');
  const mineBefore = JSON.stringify(readPlan('mine'));
  const r1 = await demo.parkShippedDemo();
  ok(r1.parked === 1, `the sweep parks exactly one post (got ${r1.parked})`);
  const after = readPlan('acme-launch');
  const t = after.posts.find((p) => p.id === 'teaser');
  ok(t.demo === true, 'the sweep stamps demo:true on the shipped teaser');
  ok(t.approval === 'draft', 'the sweep parks the shipped approval back to draft (nobody on this install approved it)');
  ok(t.caption === SHIPPED_TEASER.caption && t.scheduledAt === SHIPPED_TEASER.scheduledAt && t.path === SHIPPED_TEASER.path,
    'the sweep leaves the teaser content and date as they were');
  ok(JSON.stringify(after.posts.find((p) => p.id === 'teaser-edited')) === JSON.stringify(before.posts.find((p) => p.id === 'teaser-edited')),
    'the sweep never touches the edited copy');
  ok(JSON.stringify(after.posts.find((p) => p.id === 'own-in-acme')) === JSON.stringify(before.posts.find((p) => p.id === 'own-in-acme')),
    'the sweep never touches the user\'s own post');
  ok(JSON.stringify(readPlan('mine')) === mineBefore,
    'the sweep leaves other campaigns alone');
  const row = getActivity(20).find((a) => a.action === 'demo-parked');
  ok(row && row.campaign === 'acme-launch' && row.postId === 'teaser', 'the sweep logs one demo-parked activity row');
  const r2 = await demo.parkShippedDemo();
  ok(r2.parked === 0, 'the sweep is idempotent (a second boot parks nothing)');

  // A posted teaser is history, not a risk: never rewritten.
  writePlan('acme-launch', { campaign: 'Acme Launch', timezone: 'UTC', posts: [{ ...SHIPPED_TEASER, status: 'posted' }] });
  const r3 = await demo.parkShippedDemo();
  ok(r3.parked === 0, 'a teaser that already went out is left as history');

  // With the guard off the sweep does nothing.
  writePlan('acme-launch', { campaign: 'Acme Launch', timezone: 'UTC', posts: [SHIPPED_TEASER] });
  fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ demoLiveGuard: false }, null, 2));
  const r4 = await demo.parkShippedDemo();
  ok(r4.parked === 0 && readPlan('acme-launch').posts[0].approval === 'approved', 'posting.demoLiveGuard:false skips the sweep');

  console.log(`\n# demo-guard: ${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
