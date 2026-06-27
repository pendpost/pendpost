#!/usr/bin/env node
// test/publish-preview.test.mjs - C3: a strictly READ-ONLY publish-preview
// (dry-run). publishPreview({ horizon, campaign }) reports, per due post in the
// horizon, which posts would fire, on which lanes, in which mode ('mock'|'live'),
// and with what blockers - reusing pendpostHealth + platformValidate + resolveMode.
//
// It NEVER spawns an engine and NEVER writes a file/activity entry; it DESCRIBES
// readiness (approval!=approved => not-ready blocker) and never publishes. The
// lane key is the publishing lane, NOT the post platform: facebook AND instagram
// both resolve to the 'meta' lane, so resolveMode is called with 'meta' (the one
// easy bug this test pins).
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib
// (util binds WORKSPACE_ROOT at import; mirrors test/account-mode.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// Throwaway workspace - set BEFORE importing lib. No clients.json exists, so the
// activeRoot() legacy fallback resolves data/ + .env at WS (single-client hold).
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-preview-'));
process.env.PENDPOST_ROOT = WS;
// PENDPOST_MODE=mock forces every lane to mock regardless of credential presence
// (criterion 3); a seeded LinkedIn token makes the approved post authenticate
// (so its only-platform problem clears) while mode stays 'mock'.
process.env.PENDPOST_MODE = 'mock';

// A sentinel token: present so the approved LinkedIn post resolves authenticated
// (ready:true), and used at the end to prove the preview never leaks a secret.
const LI_TOKEN = 'SENTINEL_li_access_token_C3_publish_preview_9999_ABCD';

const dataDir = path.join(WS, 'data');
const plansDir = path.join(dataDir, 'plans');
const campDir = path.join(plansDir, 'preview-camp');
fs.mkdirSync(campDir, { recursive: true });
fs.writeFileSync(path.join(WS, '.env'), `LINKEDIN_ACCESS_TOKEN=${LI_TOKEN}\n`, { mode: 0o600 });

// All posts are future-dated and fully-scheduled so they derive to 'waiting-due'
// (a due post in the horizon). A far-future ISO keeps them due regardless of run day.
const FUTURE = '2099-01-01T09:00:00Z';
fs.writeFileSync(path.join(plansDir, 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'preview-camp', path: 'data/plans/preview-camp/post-plan.json', active: true }],
}, null, 2));
fs.writeFileSync(path.join(campDir, 'post-plan.json'), JSON.stringify({
  campaign: 'Preview Camp',
  timezone: 'UTC',
  posts: [
    // approved + ready: a LinkedIn text post needs no media; with the seeded token
    // authenticated, platformValidate clears every problem -> ready:true.
    {
      id: 'approved-ready', type: 'text', platforms: ['linkedin'], scheduledAt: FUTURE,
      caption: 'Approved and ready to fire.', link: 'https://example.com/a',
      status: 'planned', approval: 'approved', approvalBy: 'owner', approvalAt: '2026-01-01T00:00:00Z',
    },
    // draft: same shape but approval:'draft' -> ready:false with an approval blocker.
    {
      id: 'draft-post', type: 'text', platforms: ['linkedin'], scheduledAt: FUTURE,
      caption: 'Still a draft.', link: 'https://example.com/d',
      status: 'planned', approval: 'draft',
    },
    // facebook+instagram: both map to the 'meta' LANE (not the post platform) -
    // proves the lane-key derivation matches ModeBadge.
    {
      id: 'meta-post', type: 'reel', platforms: ['facebook', 'instagram'], scheduledAt: FUTURE,
      path: 'data/media/missing.mp4', caption: 'Cross-posted reel.',
      status: 'planned', approval: 'approved', approvalBy: 'owner', approvalAt: '2026-01-01T00:00:00Z',
    },
  ],
}, null, 2));

const { publishPreview } = await import('../lib/writes.mjs');
const { resolveMode } = await import('../lib/mode.mjs');
const { getActivity } = await import('../lib/scheduler.mjs');

const planFile = path.join(campDir, 'post-plan.json');

try {
  ok(typeof publishPreview === 'function', 'publishPreview is exported from lib/writes.mjs');

  // ---- read-only proof: snapshot activity + plan mtime BEFORE -----------------
  const activityBefore = getActivity(1000).length;
  const mtimeBefore = fs.statSync(planFile).mtimeMs;

  const result = await publishPreview({ horizon: 5 });

  // ---- shape: { ok, ready, schedulerRunning, posts[] } ------------------------
  ok(result && result.ok === true, 'preview returns ok:true');
  ok(typeof result.ready === 'boolean', 'preview returns a boolean ready');
  ok(typeof result.schedulerRunning === 'boolean', 'preview returns a boolean schedulerRunning');
  ok(Array.isArray(result.posts), 'preview returns a posts array');

  const byId = Object.fromEntries(result.posts.map((p) => [p.postId, p]));
  ok(byId['approved-ready'] && byId['draft-post'] && byId['meta-post'], 'all three due posts appear in the preview');

  // ---- per-post shape: { campaign, postId, scheduledAt, platforms[] } ---------
  const ap = byId['approved-ready'];
  ok(ap.campaign === 'preview-camp', 'post carries its campaign id');
  ok(ap.scheduledAt === FUTURE, 'post carries its scheduledAt verbatim');
  ok(Array.isArray(ap.platforms), 'post carries a platforms array');

  // ---- per-platform shape: { platform, lane, mode, ready, blockers[] } --------
  const apLi = ap.platforms.find((x) => x.platform === 'linkedin');
  ok(apLi && apLi.lane === 'linkedin', 'linkedin platform reports lane:linkedin');
  ok(apLi.mode === 'mock', 'PENDPOST_MODE=mock forces the linkedin lane mode to mock');
  ok(apLi.ready === true, 'the approved+authenticated linkedin post is ready:true');
  ok(Array.isArray(apLi.blockers) && apLi.blockers.length === 0, 'a ready platform has no blockers');

  // ---- draft post: ready:false with an approval blocker ----------------------
  const dr = byId['draft-post'];
  const drLi = dr.platforms.find((x) => x.platform === 'linkedin');
  ok(drLi.ready === false, 'the draft linkedin post is ready:false');
  ok(drLi.blockers.some((b) => /approval/i.test(b) && /draft/i.test(b)), 'the draft post carries an "approval: draft" blocker');

  // ---- facebook + instagram BOTH map to the META lane (criterion 2) ----------
  const mp = byId['meta-post'];
  const fb = mp.platforms.find((x) => x.platform === 'facebook');
  const ig = mp.platforms.find((x) => x.platform === 'instagram');
  ok(fb && fb.lane === 'meta', 'facebook resolves lane:meta');
  ok(ig && ig.lane === 'meta', 'instagram resolves lane:meta');
  ok(fb.mode === resolveMode('meta') && ig.mode === resolveMode('meta'),
    'both meta-lane entries report mode === resolveMode(\'meta\') (the lane key, not the platform)');
  ok(fb.mode === 'mock' && ig.mode === 'mock', 'under PENDPOST_MODE=mock the meta lane is mock');

  // ---- read-only proof: activity length + plan mtime UNCHANGED (criterion 4) --
  const activityAfter = getActivity(1000).length;
  ok(activityAfter === activityBefore, 'preview appended NO activity-log entry (read-only)');
  const mtimeAfter = fs.statSync(planFile).mtimeMs;
  ok(mtimeAfter === mtimeBefore, 'preview did NOT touch the plan file (mtime unchanged)');

  // ---- no secret leak: the seeded token never appears in the result ----------
  ok(!JSON.stringify(result).includes(LI_TOKEN), 'preview never leaks the seeded LinkedIn token');

  // ---- horizon clamp parity with pendpostHealth: huge horizon does not throw ---
  const wide = await publishPreview({ horizon: 9999 });
  ok(wide.ok === true && Array.isArray(wide.posts), 'a huge horizon clamps gracefully (no throw, ok:true)');

  // ---- unknown campaign filter yields an empty (not 500) result --------------
  const none = await publishPreview({ horizon: 5, campaign: 'does-not-exist' });
  ok(none.ok === true && none.posts.length === 0, 'an unknown campaign filter yields ok:true with zero posts');

  console.log(`[publish-preview] OK - read-only dry-run shape, meta-lane derivation, mock forcing, no write/leak (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
