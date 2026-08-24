#!/usr/bin/env node
// test/delete-evidence-gate.test.mjs - B3 (ux-audit dim-1 G2) + "delete always
// works" (owner directive 2026-08-18): deletePost's publish-evidence gate must
// count EVERY lane's minted platform id as evidence, not just the 6 legacy
// fields (fbPostId/fbReelId/igMediaId/liPostId/ytVideoId/xPostId). The field
// list is derived from PLATFORM_ID_FIELDS (lib/plans.mjs), the same registry
// deriveState's per-platform evidence walk reads, so a new lane's id field can
// never silently fall through the delete gate again.
//
// The old "unschedule first" pin is DELIBERATELY inverted: a natively scheduled
// post (Ghost/WordPress/Mastodon/FB/YouTube object living platform-side, plus
// the Discord guild event) now DELETES in one motion - pendpost cancels the
// platform object(s) BEFORE removing the row (the unschedulePost order). The
// only remaining refusal is an honest engine_failure when the cancel itself
// fails, in which case the row stays intact. The cancel wiring is proven with
// the PENDPOST_MOCK_FAIL seam: a forced cancel failure can only surface if the
// engine really spawned the lane's cancel verb.
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
delete process.env.PENDPOST_MOCK_FAIL;

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
    // (c) natively scheduled ghost object: the platform-side object exists and
    // would fire later - delete must CANCEL it first, then remove the row.
    { id: 'gh-native', type: 'text', platforms: ['ghost'], caption: 'gh queued', status: 'scheduled', approval: 'approved', scheduledAt: '2030-01-01T00:00:00Z', ghostPostId: 'gh-queued' },
    // (c2) same for a mastodon scheduled-queue entry (mastodonScheduledId, no status id yet).
    { id: 'ma-native', type: 'text', platforms: ['mastodon'], caption: 'ma queued', status: 'scheduled', approval: 'approved', scheduledAt: '2030-01-01T00:00:00Z', mastodonScheduledId: 'ma-queued' },
    // (e) a Discord guild scheduled event rides the DELETE-side cascade even
    // though dcEventId is NOT publish evidence (no force needed) and the post is
    // not status 'scheduled' - the row is the only cancel path for the event.
    { id: 'dc-event', type: 'text', platforms: ['discord'], caption: 'dc event', status: 'planned', approval: 'draft', scheduledAt: PAST, dcEvent: { name: 'Launch party', startTime: '2030-01-01T00:00:00Z' }, dcEventId: 'ev-1' },
    { id: 'dc-event2', type: 'text', platforms: ['discord'], caption: 'dc event 2', status: 'planned', approval: 'draft', scheduledAt: PAST, dcEvent: { name: 'Launch party 2', startTime: '2030-01-01T00:00:00Z' }, dcEventId: 'ev-2' },
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

const planNow = () => JSON.parse(fs.readFileSync(path.join(campDir, 'post-plan.json'), 'utf8'));
const remaining = () => planNow().posts.map((p) => p.id);

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

  // (c) natively scheduled objects DELETE in one motion now: the evidence gate
  // still wants force (the id is minted), and WITH force the engine cancels the
  // platform object first, reporting the lane in nativeCancelled.
  const c1 = await deletePost({ campaign: 'gate-camp', postId: 'gh-native', actor: 'owner' });
  ok(c1.ok !== true && c1.code === 'invalid_input', `natively scheduled ghost post still needs force (evidence gate) (${JSON.stringify(c1)})`);
  ok(!/unschedule first/i.test(String(c1.message || '')), 'the refusal no longer demands an unschedule ceremony');
  // Cancel failure = the ONE remaining refusal: the row stays intact. The forced
  // failure riding through PENDPOST_MOCK_FAIL proves the engine really spawned
  // the ghost cancel verb (the seam lives inside the lane engine's mock driver).
  process.env.PENDPOST_MOCK_FAIL = 'ghost:engine_failure:mock ghost cancel is down';
  const c2 = await deletePost({ campaign: 'gate-camp', postId: 'gh-native', force: true, actor: 'owner' });
  ok(c2.ok !== true && c2.code === 'engine_failure' && /native cancel failed on ghost/.test(String(c2.message || '')),
    `a failing native cancel refuses the delete with engine_failure (${JSON.stringify(c2)})`);
  const intact = planNow().posts.find((p) => p.id === 'gh-native');
  ok(intact && intact.ghostPostId === 'gh-queued', 'the post survives a failed cancel INTACT (row + platform id still present)');
  delete process.env.PENDPOST_MOCK_FAIL;
  const c3 = await deletePost({ campaign: 'gate-camp', postId: 'gh-native', force: true, actor: 'owner' });
  ok(c3.ok === true && c3.nativeCancelled === 'ghost', `with the cancel healthy the natively scheduled ghost post deletes in one motion (${JSON.stringify(c3)})`);
  ok(!remaining().includes('gh-native'), 'the row is gone after the cascade delete');
  const c4 = await deletePost({ campaign: 'gate-camp', postId: 'ma-native', force: true, actor: 'owner' });
  ok(c4.ok === true && c4.nativeCancelled === 'mastodon', `a mastodon scheduled-queue entry cancels + deletes the same way (${JSON.stringify(c4)})`);

  // (e) the Discord guild event: dcEventId is NOT publish evidence (no force
  // needed) but the delete cascade cancels the event so it cannot orphan.
  process.env.PENDPOST_MOCK_FAIL = 'discord:engine_failure:mock discord event cancel is down';
  const e1 = await deletePost({ campaign: 'gate-camp', postId: 'dc-event2', actor: 'owner' });
  ok(e1.ok !== true && e1.code === 'engine_failure' && /native cancel failed on discord/.test(String(e1.message || '')),
    `a failing guild-event cancel refuses the delete (${JSON.stringify(e1)})`);
  ok(planNow().posts.find((p) => p.id === 'dc-event2')?.dcEventId === 'ev-2', 'the event id survives the failed cancel');
  delete process.env.PENDPOST_MOCK_FAIL;
  const e2 = await deletePost({ campaign: 'gate-camp', postId: 'dc-event', actor: 'owner' });
  ok(e2.ok === true && e2.nativeCancelled === 'discord', `deleting a post with a guild event cancels the event, no force needed (${JSON.stringify(e2)})`);
  const e3 = await deletePost({ campaign: 'gate-camp', postId: 'dc-event2', actor: 'owner' });
  ok(e3.ok === true && e3.nativeCancelled === 'discord', 'the second event post deletes once the cancel heals');

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
  ok(d5.ok === true && d5.nativeCancelled === null, 'a clean draft still deletes without force (and reports no native cancel)');

  ok(remaining().length === 0, `every post deleted - no "unschedule first" survivor (left: ${remaining().join(', ') || 'none'})`);

  console.log(`[delete-evidence-gate] OK - every lane's platform id gates delete, native objects cancel inside the delete itself (${pass} assertions).`);
} finally {
  delete process.env.PENDPOST_MOCK_FAIL;
  fs.rmSync(WS, { recursive: true, force: true });
}
