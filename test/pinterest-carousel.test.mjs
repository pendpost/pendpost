#!/usr/bin/env node
// test/pinterest-carousel.test.mjs - spec 39 rider (wave-5 item 6): pinterest
// carousel pins publish from per-slide public URLs (mediaItems[].url or the
// §4.0 mirror), riding the same shared seam as the IG image children.
//
//   1. carouselUnsupported (single source): all-url slides pass; a url-less
//      slide degrades without the mirror and passes with it; a VIDEO slide is
//      always refused (v5 multiple_image_urls is images-only).
//   2. Validator: a url-bearing pinterest carousel has no seam problem; a mixed
//      video carousel blocks with the images-only reason.
//   3. Mock engine: all-url publishes (pinId minted); url-less degrades to the
//      same structured unsupported row as live.
//   4. Source-level: the live engine's multiple_image_urls branch exists and the
//      single-pin path resolves through the shared seam (mirror-aware).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-pin-carousel-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;

const plansDir = path.join(WS, 'data', 'plans');
const campDir = path.join(plansDir, 'pincar');
const mediaDir = path.join(WS, 'data', 'media');
fs.mkdirSync(campDir, { recursive: true });
fs.mkdirSync(mediaDir, { recursive: true });
fs.writeFileSync(path.join(mediaDir, 'a.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 0]));
fs.writeFileSync(path.join(mediaDir, 'b.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 1]));

const U = (f) => `https://cdn.example.com/${f}`;
const PAST = '2020-01-01T00:00:00Z';
const post = (id, extra = {}) => ({
  id, platforms: ['pinterest'], type: 'carousel', scheduledAt: PAST, caption: 'pins',
  status: 'planned', executionMode: 'fully-scheduled',
  approval: 'approved', approvalBy: 'owner', approvalAt: '2026-01-01T00:00:00Z',
  createdBy: 'agent:claude', ...extra,
});

fs.writeFileSync(path.join(plansDir, 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'pincar', path: 'data/plans/pincar/post-plan.json', active: true }],
}, null, 2));
fs.writeFileSync(path.join(campDir, 'post-plan.json'), JSON.stringify({
  campaign: 'Pinterest carousels',
  timezone: 'UTC',
  posts: [
    post('pc-urls', { mediaItems: [{ path: 'data/media/a.jpg', url: U('a.jpg') }, { path: 'data/media/b.jpg', url: U('b.jpg') }] }),
    post('pc-nourl', { mediaItems: [{ path: 'data/media/a.jpg', url: U('a.jpg') }, { path: 'data/media/b.jpg' }] }),
    post('pc-video', { mediaItems: [{ path: 'data/media/a.jpg', url: U('a.jpg') }, { path: 'data/media/clip.mp4', url: U('clip.mp4') }] }),
  ],
}, null, 2));
fs.writeFileSync(path.join(mediaDir, 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70]));

const { carouselUnsupported } = await import('../lib/carousel.mjs');
const { platformValidate } = await import('../lib/writes.mjs');
const { runMockCommand } = await import('../lib/drivers/mock-driver.mjs');

try {
  // ===== 1. the single-source degrade reason =====
  const MIRROR = { publicMediaBaseUrl: 'https://media.example.com' };
  ok(carouselUnsupported({ type: 'carousel', mediaItems: [{ path: 'a.jpg', url: U('a.jpg') }, { path: 'b.jpg', url: U('b.jpg') }] }, 'pinterest') === null, 'carouselUnsupported: all-url pinterest slides pass');
  ok(/public image URL per slide/.test(carouselUnsupported({ type: 'carousel', mediaItems: [{ path: 'a.jpg' }] }, 'pinterest') || ''), 'carouselUnsupported: a url-less slide degrades without the mirror, naming both fixes');
  ok(carouselUnsupported({ type: 'carousel', mediaItems: [{ path: 'a.jpg' }] }, 'pinterest', MIRROR) === null, 'carouselUnsupported: the mirror resolves a url-less slide (config-only upgrade)');
  ok(/image-only/.test(carouselUnsupported({ type: 'carousel', mediaItems: [{ path: 'clip.mp4', url: U('c') }] }, 'pinterest', MIRROR) || ''), 'carouselUnsupported: a video slide is refused even with the mirror (v5 carousel is images-only)');

  // ===== 2. validator =====
  const v = async (id) => (await platformValidate({ campaign: 'pincar', postId: id })).platforms.pinterest;
  ok(!(await v('pc-urls')).problems.some((p) => /per slide|image-only/.test(p)), 'validate: an all-url pinterest carousel carries no seam problem');
  ok((await v('pc-nourl')).problems.some((p) => /public image URL per slide/.test(p)), 'validate: a url-less slide blocks at Pruefen');
  ok((await v('pc-video')).problems.some((p) => /image-only/.test(p)), 'validate: a video slide blocks with the images-only reason');

  // ===== 3. mock engine =====
  const planPath = path.join(campDir, 'post-plan.json');
  const readPost = (id) => JSON.parse(fs.readFileSync(planPath, 'utf8')).posts.find((x) => x.id === id);
  const okRun = await runMockCommand({ platform: 'pinterest', command: 'publish-due', planPath, only: 'pc-urls' });
  ok((okRun.results || []).some((r) => r.platform === 'pinterest' && r.ok === true), 'mock: an all-url pinterest carousel publishes');
  ok(Boolean(readPost('pc-urls').pinId), 'mock: the carousel publish mints pinId');
  const noRun = await runMockCommand({ platform: 'pinterest', command: 'publish-due', planPath, only: 'pc-nourl' });
  const noRow = (noRun.results || []).find((r) => r.platform === 'pinterest');
  ok(noRow && noRow.ok === false && noRow.errorCode === 'unsupported' && /per slide/.test(noRow.errorMessage), 'mock: a url-less slide degrades with the shared single-source reason (mock and live agree)');

  // ===== 4. source-level =====
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'pinterest-social.mjs'), 'utf8');
  ok(/source_type: 'multiple_image_urls'/.test(src), 'engine: the v5 multiple_image_urls carousel branch exists');
  ok(/effectivePublicUrl\(post, loadClientConfig\(\)\)/.test(src), 'engine: the single-pin path resolves through the shared seam (mirror-aware)');
  ok(/effectiveSlideUrl\(it, cfg\)/.test(src), 'engine: carousel slides resolve through effectiveSlideUrl');

  console.log(`\n[pinterest-carousel] OK - per-slide URLs + mirror + images-only honesty (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
