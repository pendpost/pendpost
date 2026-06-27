#!/usr/bin/env node
// test/cloud-health-overdue.test.mjs - the silent-overdue guard in pendpost_health
// (lib/writes.mjs pendpostHealth). An APPROVED post past its due time by more than the
// grace and still not posted is the cloud-managed silent failure the incident exposed
// (all signals green, the post never published). pendpostHealth must surface it as a
// TOP-LEVEL blocker (ready:false), naming the post and - when reconcile cached WHY a
// cloud fire failed - the sanitized reason. This makes "silently overdue forever"
// structurally impossible regardless of cause (never pushed, worker down, dead key).
// Mock mode; no network; pendpostHealth is a pure read.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-health-overdue-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n');

const { createCampaign, createPost, approvePost, pendpostHealth } = await import('../lib/writes.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');

const CAMP = 'linkedin-blog-2026-06';
const POST = 'blog-side-hustle';
const MSG = 'Access token expired and no refresh token was issued - re-run auth.';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };
const hasOverdueCode = (h, postId) => h.blockerCodes.some((c) => c.code === 'blocker.overdueUnpublished' && c.params.postId === postId);

try {
  await createCampaign({ id: CAMP, note: 'blog', timezone: 'UTC', actor: 'owner' });
  await createPost({ campaign: CAMP, post: { id: POST, type: 'text', platforms: ['linkedin'], scheduledAt: '2020-01-01T00:00:00Z', caption: 'a quiet blog post' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: POST, actor: 'owner' });
  // The guard is meaningful only when the scheduler is ON (an OFF scheduler is surfaced
  // separately); enable it directly (no real timer needed for the read).
  const s = loadState(); s.scheduler = { ...(s.scheduler || {}), enabled: true }; saveState();

  // --- (1) an approved, long-overdue, unpublished post is a TOP-LEVEL blocker --------
  const h1 = pendpostHealth({ includeSetup: false });
  ok(hasOverdueCode(h1, POST), 'an approved, overdue, unpublished post raises blocker.overdueUnpublished (silent-overdue made loud)');
  ok(h1.ready === false, 'pendpost_health is NOT ready while an approved post is silently overdue');
  ok(h1.blockers.some((b) => /overdue:.*approved and past due/i.test(b)), 'the English blocker names the stuck post');

  // --- (2) the cached cloud failure reason is surfaced in the blocker ---------------
  const s2 = loadState();
  s2.cloudFailures = { [`${CAMP}:${POST}`]: { lane: 'linkedin', jobId: `default:${CAMP}:${POST}:linkedin`, message: MSG, at: new Date().toISOString() } };
  saveState();
  const h2 = pendpostHealth({ includeSetup: false });
  ok(h2.blockers.some((b) => b.includes(MSG)), 'the blocker surfaces the cloud failure reason (e.g. token expired - re-run auth)');

  // --- (3) control: an UNAPPROVED overdue post is NOT flagged as overdueUnpublished --
  await createPost({ campaign: CAMP, post: { id: 'draft1', type: 'text', platforms: ['linkedin'], scheduledAt: '2020-01-01T00:00:00Z', caption: 'still a draft' }, actor: 'agent:a' });
  const h3 = pendpostHealth({ includeSetup: false });
  ok(!hasOverdueCode(h3, 'draft1'), 'an unapproved overdue post is NOT flagged overdueUnpublished (the approval gate covers it)');

  console.log(`[cloud-health-overdue] OK - approved-overdue is a top-level blocker, surfaces the cloud reason, ignores unapproved (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
