#!/usr/bin/env node
// test/radar-reply-edit-target.test.mjs - a radar reply cannot be re-aimed by an edit.
//
// Spec 40 6.10. The wrong-target invariant (a radar reply must target exactly its source
// lane) lives in validateFieldValues, which is PURE over the fields it is handed - so it
// only fires when `platforms` arrives ALONGSIDE `radarReplyTo`, which is always true on
// create and never guaranteed on update. An updatePost supplying ONLY `platforms` on an
// existing reply therefore walked straight past it.
//
// Why it matters more now: before auto-reply, a human read the thread and approved it, so
// a re-aimed reply still faced a person. With spec 40's opt-in auto-reply, a reply can go
// out without that read, leaving the per-engine fire-time guard as the only backstop. The
// fix re-validates supplied platforms against the STORED radarReplyTo.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-edit-target-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { createCampaign, queueRadarReply, updatePost } = await import('../lib/writes.mjs');
const { setConfig, getConfig } = await import('../lib/config.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');

const CAMP = 'radar';
const getPost = (id) => (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []).find((p) => p.id === id);
const revOf = (id) => {
  const p = getPost(id);
  return p && p.rev;
};

try {
  await createCampaign({ id: CAMP, note: 'radar', timezone: 'UTC', actor: 'owner' });
  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { enabled: true } } } });

  const queued = await queueRadarReply({
    campaign: CAMP,
    signalUrl: 'https://mastodon.social/@someone/1',
    source: 'mastodon',
    externalId: '1',
    text: 'A useful answer.',
    actor: 'agent:claude',
    confirm: true,
  });
  ok(queued.ok === true, 'a mastodon reply is queued');
  const id = queued.postId;
  ok(getPost(id).platforms.join() === 'mastodon', 'it targets mastodon, matching radarReplyTo.source');

  // ---- THE HOLE: platforms alone, no radarReplyTo in the payload -------------
  const reaim = await updatePost({
    campaign: CAMP,
    postId: id,
    ifRev: revOf(id),
    fields: { platforms: ['reddit'] },
    actor: 'agent:claude',
  });
  ok(reaim && reaim.code === 'invalid_input',
    'updatePost REFUSES to re-aim a radar reply at another lane with platforms alone');
  ok(getPost(id).platforms.join() === 'mastodon', 'the stored reply still targets its own source lane');

  // Multi-lane fan-out is refused for the same reason.
  const fanout = await updatePost({
    campaign: CAMP,
    postId: id,
    ifRev: revOf(id),
    fields: { platforms: ['mastodon', 'reddit'] },
    actor: 'agent:claude',
  });
  ok(fanout && fanout.code === 'invalid_input',
    'a radar reply cannot be fanned out to extra lanes by an edit');
  ok(getPost(id).platforms.join() === 'mastodon', 'the fan-out did not land');

  // ---- what must STILL work --------------------------------------------------
  const same = await updatePost({
    campaign: CAMP,
    postId: id,
    ifRev: revOf(id),
    fields: { platforms: ['mastodon'] },
    actor: 'agent:claude',
  });
  ok(same && same.ok === true, 'setting platforms to the SAME source lane is still allowed (no false positive)');

  const caption = await updatePost({
    campaign: CAMP,
    postId: id,
    ifRev: revOf(id),
    fields: { caption: 'A better answer, same thread.' },
    actor: 'agent:claude',
  });
  ok(caption && caption.ok === true, 'editing the reply text is untouched by the guard');

  const cleared = await updatePost({
    campaign: CAMP,
    postId: id,
    ifRev: revOf(id),
    fields: { radarReplyTo: null, platforms: ['reddit'] },
    actor: 'agent:claude',
  });
  ok(cleared && cleared.ok === true,
    'clearing radarReplyTo in the SAME call releases the post: it is no longer a reply, so the lane is free');
  ok(!getPost(id).radarReplyTo && getPost(id).platforms.join() === 'reddit', 'the released post kept the new lane');

  // ---- an ORDINARY post is unaffected ---------------------------------------
  const { createPost } = await import('../lib/writes.mjs');
  await createPost({
    campaign: CAMP,
    post: { id: 'plain1', type: 'text', platforms: ['mastodon'], caption: 'hello', scheduledAt: '2030-01-01T00:00:00Z' },
    actor: 'agent:claude',
  });
  const plain = await updatePost({
    campaign: CAMP,
    postId: 'plain1',
    ifRev: revOf('plain1'),
    fields: { platforms: ['reddit', 'mastodon'] },
    actor: 'agent:claude',
  });
  ok(plain && plain.ok === true, 'a NORMAL post can still change platforms freely (the guard is radar-only)');

  console.log(`\nradar-reply-edit-target: ${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
