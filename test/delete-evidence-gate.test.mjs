#!/usr/bin/env node
// test/delete-evidence-gate.test.mjs - B3 (ux-audit dim-1 G2): deletePost's
// publish-evidence gate must count EVERY lane's minted platform id as evidence,
// not just the 6 legacy fields (fbPostId/fbReelId/igMediaId/liPostId/ytVideoId/
// xPostId). The field list is derived from PLATFORM_ID_FIELDS (lib/plans.mjs),
// the same registry deriveState's per-platform evidence walk reads, so a new
// lane's id field can never silently fall through the delete gate again.
//
// Also pins the native-handoff guard: a natively scheduled post (Ghost/
// WordPress/Mastodon/FB/YouTube object already living platform-side) refuses
// delete even WITH force, pointing at unschedule - deleting the plan row would
// leave the platform object to fire with no plan record and no cancel path.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib
// (util binds WORKSPACE_ROOT at import; mirrors test/delete-insights-cascade).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-del-gate-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const dataDir = path.join(WS, 'data');
const plansDir = path.join(dataDir, 'plans');
const campDir = path.join(plansDir, 'gate-camp');
fs.mkdirSync(campDir, { recursive: true });

const PAST = '2020-01-01T00:00:00Z';
fs.writeFileSync(path.join(plansDir, 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'gate-camp', path: 'data/plans/gate-camp/post-plan.json', active: true }],
}, null, 2));
fs.writeFileSync(path.join(campDir, 'post-plan.json'), JSON.stringify({
  campaign: 'gate-camp',
  timezone: 'UTC',
  posts: [
    // (a) newer-lane evidence the legacy gate missed: telegram message already fired.
    { id: 'tg', type: 'text', platforms: ['telegram'], caption: 'tg live', status: 'planned', approval: 'draft', scheduledAt: PAST, tgMessageId: '4711' },
    // (b) newer-lane evidence: ghost post id minted, status not yet 'posted'.
    { id: 'gh', type: 'text', platforms: ['ghost'], caption: 'gh live', status: 'planned', approval: 'draft', scheduledAt: PAST, ghostPostId: 'gh-abc' },
    // (c) natively scheduled ghost object: platform-side object exists and will
    // fire later - delete must refuse even WITH force and point at unschedule.
    { id: 'gh-native', type: 'text', platforms: ['ghost'], caption: 'gh queued', status: 'scheduled', approval: 'approved', scheduledAt: '2030-01-01T00:00:00Z', ghostPostId: 'gh-queued' },
    // (c2) same for a mastodon scheduled-queue entry (mastodonScheduledId, no status id yet).
    { id: 'ma-native', type: 'text', platforms: ['mastodon'], caption: 'ma queued', status: 'scheduled', approval: 'approved', scheduledAt: '2030-01-01T00:00:00Z', mastodonScheduledId: 'ma-queued' },
    // (d) legacy behavior unchanged: fbPostId evidence.
    { id: 'fb', type: 'text', platforms: ['facebook'], caption: 'fb live', status: 'planned', approval: 'draft', scheduledAt: PAST, fbPostId: 'fb-123' },
    // (d2) legacy behavior unchanged: status 'posted' with no ids at all.
    { id: 'posted', type: 'text', platforms: ['x'], caption: 'marked posted', status: 'posted', approval: 'approved', scheduledAt: PAST },
    // (d3) legacy behavior unchanged: a clean draft deletes without force.
    { id: 'clean', type: 'text', platforms: ['x'], caption: 'nothing minted', status: 'planned', approval: 'draft', scheduledAt: PAST },
  ],
}, null, 2));

const { deletePost } = await import('../lib/writes.mjs');
const { PLATFORM_ID_FIELDS } = await import('../lib/plans.mjs');

const remaining = () => JSON.parse(fs.readFileSync(path.join(campDir, 'post-plan.json'), 'utf8')).posts.map((p) => p.id);

try {
  // The registry the gate derives from is the shared one, and it knows the lanes
  // the legacy list missed.
  ok(PLATFORM_ID_FIELDS && typeof PLATFORM_ID_FIELDS === 'object', 'PLATFORM_ID_FIELDS is exported from lib/plans.mjs');
  for (const lane of ['telegram', 'ghost', 'mastodon', 'wordpress', 'nostr', 'gbp', 'reddit', 'pinterest', 'tiktok', 'discord']) {
    ok(Array.isArray(PLATFORM_ID_FIELDS[lane]) && PLATFORM_ID_FIELDS[lane].length > 0, `registry covers the ${lane} lane`);
  }

  // (a) tgMessageId alone is publish evidence: refused without force.
  const a1 = await deletePost({ campaign: 'gate-camp', postId: 'tg', actor: 'owner' });
  ok(a1.ok !== true && a1.code === 'invalid_input', `tgMessageId-only post refuses delete without force (${JSON.stringify(a1)})`);
  ok(String(a1.message || '').includes('tgMessageId'), 'the refusal names the evidence field (tgMessageId)');
  const a2 = await deletePost({ campaign: 'gate-camp', postId: 'tg', force: true, actor: 'owner' });
  ok(a2.ok === true, 'tgMessageId-only post deletes WITH force (already-fired message stays platform-side by design)');

  // (b) ghostPostId alone is publish evidence: refused without force.
  const b1 = await deletePost({ campaign: 'gate-camp', postId: 'gh', actor: 'owner' });
  ok(b1.ok !== true && b1.code === 'invalid_input', `ghostPostId-only post refuses delete without force (${JSON.stringify(b1)})`);
  ok(String(b1.message || '').includes('ghostPostId'), 'the refusal names the evidence field (ghostPostId)');
  const b2 = await deletePost({ campaign: 'gate-camp', postId: 'gh', force: true, actor: 'owner' });
  ok(b2.ok === true, 'ghostPostId post (not natively scheduled) deletes WITH force');

  // (c) natively scheduled objects: delete refuses even WITH force, pointing at
  // unschedule - the platform object would otherwise fire with no plan record.
  const c1 = await deletePost({ campaign: 'gate-camp', postId: 'gh-native', force: true, actor: 'owner' });
  ok(c1.ok !== true && c1.code === 'invalid_input', `natively scheduled ghost post refuses delete even WITH force (${JSON.stringify(c1)})`);
  ok(/unschedule/i.test(String(c1.message || '')), 'the refusal points at unschedule as the cancel path');
  const c2 = await deletePost({ campaign: 'gate-camp', postId: 'gh-native', actor: 'owner' });
  ok(c2.ok !== true, 'natively scheduled ghost post refuses delete without force too');
  const c3 = await deletePost({ campaign: 'gate-camp', postId: 'ma-native', force: true, actor: 'owner' });
  ok(c3.ok !== true && /unschedule/i.test(String(c3.message || '')), `mastodon scheduled-queue entry refuses forced delete with the same guidance (${JSON.stringify(c3)})`);

  // (d) legacy behavior unchanged.
  const d1 = await deletePost({ campaign: 'gate-camp', postId: 'fb', actor: 'owner' });
  ok(d1.ok !== true && d1.code === 'invalid_input', 'legacy fbPostId evidence still refuses delete without force');
  const d2 = await deletePost({ campaign: 'gate-camp', postId: 'fb', force: true, actor: 'owner' });
  ok(d2.ok === true, 'legacy fbPostId post still deletes WITH force');
  const d3 = await deletePost({ campaign: 'gate-camp', postId: 'posted', actor: 'owner' });
  ok(d3.ok !== true && d3.code === 'invalid_input', "status 'posted' with no ids still refuses delete without force");
  const d4 = await deletePost({ campaign: 'gate-camp', postId: 'posted', force: true, actor: 'owner' });
  ok(d4.ok === true, "status 'posted' still deletes WITH force");
  const d5 = await deletePost({ campaign: 'gate-camp', postId: 'clean', actor: 'owner' });
  ok(d5.ok === true, 'a clean draft still deletes without force');

  const left = remaining();
  ok(left.length === 2 && left.includes('gh-native') && left.includes('ma-native'), `only the natively scheduled posts survive (${left.join(', ')})`);

  console.log(`[delete-evidence-gate] OK - every lane's platform id gates delete, native handoffs refuse delete with unschedule guidance (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
