#!/usr/bin/env node
// test/image-type-lanes.test.mjs - the engine no-strand proof for the byte lanes that
// gained the single-image `image` TYPE (capabilities.mjs IMAGE_LANES): x, telegram, discord,
// mastodon. Their engines are media-kind driven (they upload the attached file and detect
// still-vs-video by extension), so a type:image post must publish exactly like any other
// media post - never silently dropped. This is the guard that a lane is only OFFERED the
// type when its engine can actually deliver it: the same reasoning that keeps nostr OUT
// (its note engine is isTextPost-gated and would drop a type:image, so nostr is absent from
// IMAGE_LANES and from the loop below).
//
// Mirrors test/mastodon-carousel.test.mjs: a fresh temp PENDPOST_ROOT, PENDPOST_MODE=mock,
// and runMockCommand simulating the real engine's publish. X is checked first (the reported gap).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-image-lanes-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans', 'img'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
// A tiny still image the post points at (SOI + EOI); the byte-lane mocks are kind-driven.
fs.writeFileSync(path.join(WS, 'data', 'media', 'pic.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

const { IMAGE_LANES } = await import('../lib/capabilities.mjs');
const { runMockCommand } = await import('../lib/drivers/mock-driver.mjs');

const planPath = path.join(WS, 'data', 'plans', 'img', 'post-plan.json');
const imagePost = (lane) => ({
  id: `img-${lane}`, platforms: [lane], type: 'image', caption: 'A still frame',
  path: 'data/media/pic.jpg', scheduledAt: '2020-01-01T00:00:00Z',
  approval: 'approved', status: 'planned', executionMode: 'fully-scheduled',
});

// X first (the reported gap), then the other byte lanes. Kept in step with the source of
// truth: every lane here must be image-capable, and nostr must NOT be (it would strand).
const BYTE_LANES = ['x', 'telegram', 'discord', 'mastodon'];

try {
  ok(BYTE_LANES.every((l) => IMAGE_LANES.includes(l)),
    'every byte lane under test is in IMAGE_LANES (the single source of truth)');
  ok(!IMAGE_LANES.includes('nostr'),
    'nostr is deliberately NOT in IMAGE_LANES - its engine would drop a type:image note');

  for (const lane of BYTE_LANES) {
    fs.writeFileSync(planPath, JSON.stringify({ campaign: 'img', posts: [imagePost(lane)] }, null, 2));
    const out = await runMockCommand({ platform: lane, command: 'publish-due', planPath, only: `img-${lane}` });
    // A media-kind-driven lane publishes the still image as an ordinary media post: one
    // successful row (a live publish, or a native-scheduled hand-off for a native lane).
    const row = out.results.find((r) => r.platform === lane && r.ok === true
      && (r.action === 'publish' || r.action === 'schedule-native'));
    ok(Boolean(row), `${lane}: a type:image post publishes in the engine (mock) - the offered type never strands`);
    ok(!out.results.some((r) => r.platform === lane && r.ok === false),
      `${lane}: no failed row - the engine does not reject the image type`);
  }

  console.log(`\n[image-type-lanes] OK - x/telegram/discord/mastodon publish a type:image post without stranding (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
