#!/usr/bin/env node
// test/carousel-type-switch.test.mjs - H3. A type change left the other shape's media
// behind, and the consequences were worse than a cosmetic leftover.
//
// normalizePost routed only media.exists through carouselExists. media.file, url, path,
// cover and resolution still resolved from the stale single file/path. So a reel
// switched to carousel kept painting the old video in the review dialog, UNLOCKED the
// cover editor (gated on media.url), let set_cover stamp a cover onto a video that will
// never publish, and poisoned the in-use map. The Composer compounded it: it sends
// `path: mediaPath || null` on every save while the single picker is hidden for an
// album, re-persisting the stale path each time.
//
// The reconcile lives at the SERVER chokepoint (updatePost inside mutatePlan), AFTER the
// offered-apply loop and BEFORE the approval-hash gate, so no caller can defeat it -
// including plan_update_post over MCP, and including the Composer's re-persist. The
// key assertion is a PATCH that sends `type` AND a stale `path` in ONE call: if the
// reconcile ran before the apply loop, the stale path would win.
//
// Switching AWAY from carousel deliberately KEEPS mediaItems. Deleting them would
// destroy up to 20 authored slides on a mis-click, and H5's type gate already makes the
// orphan inert (asserted in test/carousel-asset-inuse.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-carousel-typeswitch-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const mediaDir = path.join(WS, 'data', 'media');
const campDir = path.join(WS, 'data', 'plans', 'cts');
fs.mkdirSync(mediaDir, { recursive: true });
fs.mkdirSync(campDir, { recursive: true });
for (const n of ['old.mp4', 's1.jpg', 's2.jpg', 's3.jpg']) fs.writeFileSync(path.join(mediaDir, n), 'x');
const rel = (f) => `data/media/${f}`;

fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'cts', path: 'data/plans/cts/post-plan.json', active: true }],
}, null, 2));

const base = {
  status: 'planned', executionMode: 'fully-scheduled', createdBy: 'agent:claude',
  scheduledAt: '2099-01-01T09:00:00Z', caption: 'Swipe', platforms: ['linkedin'],
};
const slides = [{ path: rel('s1.jpg') }, { path: rel('s2.jpg') }];
const posts = [
  { id: 'reel2car', type: 'reel', path: rel('old.mp4'), ...base },
  { id: 'sneaky', type: 'reel', path: rel('old.mp4'), ...base },
  { id: 'approved', type: 'reel', path: rel('old.mp4'), ...base, approval: 'approved', approvalBy: 'owner', approvalAt: '2026-01-01T00:00:00Z' },
  { id: 'car2reel', type: 'carousel', mediaItems: slides, ...base },
  // A legacy album already carrying a stale path, exactly what the Composer re-persisted.
  { id: 'legacy', type: 'carousel', path: rel('old.mp4'), mediaItems: slides, ...base },
  { id: 'plainreel', type: 'reel', path: rel('old.mp4'), ...base },
];
fs.writeFileSync(path.join(campDir, 'post-plan.json'), JSON.stringify({ campaign: 'cts', timezone: 'UTC', folder: '', posts }, null, 2));

const { updatePost, createPost } = await import('../lib/writes.mjs');
const { loadCampaigns, postRev } = await import('../lib/plans.mjs');

const raw = (id) => JSON.parse(fs.readFileSync(path.join(campDir, 'post-plan.json'), 'utf8')).posts.find((p) => p.id === id);
const dto = (id) => (loadCampaigns().find((c) => c.id === 'cts')?.posts || []).find((p) => p.id === id);
const revOf = (id) => postRev(raw(id));

// The approvedContentHash has to be stamped the way approvePost stamps it, or the
// edited-since-approval assertion would be vacuous.
const { postContentHash } = await import('../lib/plans.mjs');
{
  const store = JSON.parse(fs.readFileSync(path.join(campDir, 'post-plan.json'), 'utf8'));
  const p = store.posts.find((x) => x.id === 'approved');
  p.approvedContentHash = postContentHash(p);
  fs.writeFileSync(path.join(campDir, 'post-plan.json'), JSON.stringify(store, null, 2));
}

try {
  // ---- switching TO carousel clears the stale single media --------------------------
  const r1 = await updatePost({ campaign: 'cts', postId: 'reel2car', ifRev: revOf('reel2car'), actor: 'owner', fields: { type: 'carousel', mediaItems: slides } });
  ok(r1.ok === true, 'reel -> carousel: the update is accepted');
  ok(raw('reel2car').path === undefined && raw('reel2car').file === undefined,
    'reel -> carousel: the stale file and path are gone from the stored post');

  const d1 = dto('reel2car');
  ok(d1.media.url === null, 'reel -> carousel: media.url is null, so the cover editor stays locked (it is gated on media.url)');
  ok(d1.media.path === null && d1.media.file === null, 'reel -> carousel: media.path and media.file no longer resolve the old video');
  ok(d1.media.cover === null, 'reel -> carousel: no phantom cover survives the switch');
  ok(d1.media.resolution === null, 'reel -> carousel: the old video no longer supplies the album resolution');
  ok(d1.media.items.length === 2, 'reel -> carousel: the real slides resolve');

  // ---- THE ordering proof: type and a stale path in ONE call ------------------------
  const r2 = await updatePost({
    campaign: 'cts', postId: 'sneaky', ifRev: revOf('sneaky'), actor: 'owner',
    fields: { type: 'carousel', mediaItems: slides, path: rel('old.mp4') },
  });
  ok(r2.ok === true, 'one-call PATCH with type AND a stale path is accepted');
  ok(raw('sneaky').path === undefined,
    'the reconcile runs AFTER the apply loop: a caller that sends type and path together cannot re-persist the stale path');

  // ---- the Composer re-persist cannot win on an existing album ----------------------
  const r3 = await updatePost({ campaign: 'cts', postId: 'legacy', ifRev: revOf('legacy'), actor: 'owner', fields: { caption: 'edited' } });
  ok(r3.ok === true, 'legacy album: an unrelated edit is accepted');
  ok(raw('legacy').path === undefined,
    'legacy album: an already-stale path is cleared on the next save, so the Composer cannot keep re-persisting it');

  // ---- switching AWAY keeps the slides ---------------------------------------------
  const r4 = await updatePost({ campaign: 'cts', postId: 'car2reel', ifRev: revOf('car2reel'), actor: 'owner', fields: { type: 'reel', path: rel('old.mp4') } });
  ok(r4.ok === true, 'carousel -> reel: the update is accepted');
  ok(Array.isArray(raw('car2reel').mediaItems) && raw('car2reel').mediaItems.length === 2,
    'carousel -> reel: mediaItems is KEPT - a mis-click must not destroy up to 20 authored slides');
  ok(raw('car2reel').path === rel('old.mp4'), 'carousel -> reel: the new single media is stored normally');
  ok(dto('car2reel').media.items.length === 0,
    'carousel -> reel: the orphan slides do not resolve into the DTO, so nothing renders them');

  // ---- an approval does not carry across a type change -------------------------------
  const before = raw('approved');
  ok(before.approval === 'approved' && !before.editedSinceApproval, 'approved reel starts clean');
  const r5 = await updatePost({ campaign: 'cts', postId: 'approved', ifRev: revOf('approved'), actor: 'owner', fields: { type: 'carousel', mediaItems: slides } });
  ok(r5.ok === true, 'approved reel -> carousel: the update is accepted');
  ok(raw('approved').editedSinceApproval === true,
    'approved reel -> carousel: editedSinceApproval is re-raised - an approval of "this reel" must not carry to "this album"');

  // ---- regression fence: a single-media post is untouched ----------------------------
  const r6 = await updatePost({ campaign: 'cts', postId: 'plainreel', ifRev: revOf('plainreel'), actor: 'owner', fields: { caption: 'still a reel' } });
  ok(r6.ok === true, 'plain reel: an unrelated edit is accepted');
  ok(raw('plainreel').path === rel('old.mp4'), 'plain reel: its path is untouched by the reconcile');
  ok(dto('plainreel').media.url !== null, 'plain reel: still resolves its media normally');

  // ---- create is the same chokepoint -------------------------------------------------
  const c1 = await createPost({
    campaign: 'cts', actor: 'owner',
    post: { id: 'created', type: 'carousel', platforms: ['linkedin'], scheduledAt: '2099-02-01T09:00:00Z', caption: 'new', mediaItems: slides, path: rel('old.mp4') },
  });
  ok(c1.ok === true, 'create: a carousel with a stray path is accepted');
  ok(raw('created').path === undefined,
    'create: the stray path is reconciled away at create too, so a fresh album never starts stale');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
