#!/usr/bin/env node
// test/next-due-fields.test.mjs - Mandate B (data layer). pendpostHealth().nextDue
// must carry enough to render a CONTENT-RICH readiness card: the post type, its
// caption, a slim media {cover,url}, and a fallback image - not just the bare
// postId/campaign/scheduledAt it shipped before. This is a pure READ enrichment
// (no new write capability, parity untouched); both faces inherit it because
// pendpost_health is one shared read fn. Same harness as test/digest-locale.test.mjs.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-nextdue-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
const { withClient, activeRoot } = await import('../lib/context.mjs');
const { createCampaign, createPost, approvePost, pendpostHealth } = await import('../lib/writes.mjs');

try {
  initMultiClient();
  // Scaffold the default client's empty plan manifest, then seed one approved,
  // future (waiting-due) LinkedIn text post - reaches the nextDue horizon on
  // scheduledAt + approval alone (text needs no media file).
  withClient(clientRoot('default'), () => {
    const plans = path.join(activeRoot(), 'data', 'plans');
    fs.mkdirSync(plans, { recursive: true });
    fs.writeFileSync(path.join(plans, 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
  });

  const future = new Date(Date.now() + 3_600_000).toISOString();
  await withClient(clientRoot('default'), async () => {
    const c = await createCampaign({ id: 'b-camp', timezone: 'UTC', actor: 'owner' });
    assert.ok(c.ok, `createCampaign: ${JSON.stringify(c)}`);
    const p = await createPost({
      campaign: 'b-camp',
      post: { id: 'b1', type: 'text', platforms: ['linkedin'], caption: 'Hello world caption', scheduledAt: future },
      actor: 'agent:claude',
    });
    assert.ok(p.ok, `createPost: ${JSON.stringify(p)}`);
    const a = await approvePost({ campaign: 'b-camp', postId: 'b1', actor: 'owner' });
    assert.ok(a.ok, `approvePost: ${JSON.stringify(a)}`);
  });

  const sh = withClient(clientRoot('default'), () => pendpostHealth());
  const row = (sh.nextDue || []).find((r) => r.postId === 'b1');
  ok(row, 'pendpost_health.nextDue includes the seeded due post');

  // NEW rich fields (Mandate B):
  ok(row.type === 'text', 'nextDue row carries the post type');
  ok(typeof row.caption === 'string' && row.caption.includes('Hello world'), 'nextDue row carries the caption');
  ok(row.media && typeof row.media === 'object' && 'cover' in row.media && 'url' in row.media, 'nextDue row carries a slim media {cover,url}');
  ok('image' in row, 'nextDue row carries an image fallback field');

  // Existing fields preserved (no regression):
  ok(row.campaign === 'b-camp', 'existing field: campaign preserved');
  ok(Array.isArray(row.platforms) && row.platforms.includes('linkedin'), 'existing field: platforms preserved');
  ok(row.scheduledAt === future, 'existing field: scheduledAt preserved');
  ok(Array.isArray(row.blockers), 'existing field: per-post blockers preserved');

  console.log(`[next-due-fields] OK - pendpost_health.nextDue enriched with type/caption/media/image (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
