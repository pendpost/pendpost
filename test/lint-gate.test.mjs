#!/usr/bin/env node
// test/lint-gate.test.mjs - US-LINT-06: the publish path runs brand_lint on the
// caption for the target platform BEFORE spawning an engine and BLOCKS publish
// on any severity:"error" finding (fail-closed), recording a clear blocked
// activity entry and minting no platform id. Warnings never block.
//
// Driven against the REAL scheduler publish path (runDueExclusive). The default
// shipped rules.json has exactly one error rule: broken-link (a bare scheme or
// empty markdown link). A clean caption must still publish - this is the same
// guarantee test/mock-loop.test.mjs depends on.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-lint-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.META_PUBLISHING_PAUSED;

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
// A generous cadence so the cadence brake never binds across the several
// publishes below - this test isolates the LINT gate, not the cadence cap
// (which test/circuit-breaker.test.mjs covers).
fs.writeFileSync(path.join(WS, 'data', 'plans', 'meta-lane.json'), JSON.stringify({ cadence: { maxPer24h: 1000, minGapMinutes: 0 } }, null, 2));

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');
const { brandLint } = await import('../lib/lint.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { loadState } = await import('../lib/state.mjs');

const getPost = (camp, id) => (loadPlanStore().campaigns.find((c) => c.id === camp)?.posts || []).find((p) => p.id === id);
const activity = () => loadState().activity || [];
async function approvedIgPost(camp, id, caption) {
  const cc = await createCampaign({ id: camp, note: camp, timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, `createCampaign(${camp}): ${JSON.stringify(cc)}`);
  const cp = await createPost({
    campaign: camp,
    post: { id, type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption },
    actor: 'agent:claude',
  });
  assert.ok(cp.ok, `createPost(${camp}/${id}): ${JSON.stringify(cp)}`);
  const ap = await approvePost({ campaign: camp, postId: id, actor: 'owner' });
  assert.ok(ap.ok, `approvePost(${camp}/${id}): ${JSON.stringify(ap)}`);
}

try {
  // ---- a caption that trips an ERROR rule does NOT publish, and is logged ---
  // "https:// soon" is a bare scheme with no host -> broken-link (severity error).
  const dirtyCaption = 'big news today, read more https:// soon';
  // Sanity: the gate's own lint sees this as an error, not a warning.
  const lintOfDirty = brandLint({ text: dirtyCaption, platform: 'instagram' });
  ok(lintOfDirty.clean === false && lintOfDirty.errors >= 1, 'the dirty caption trips a severity:"error" brand-lint rule (broken-link)');

  await approvedIgPost('dirty', 'p1', dirtyCaption);
  const beforeDirty = activity().length;
  await runDueExclusive('owner', { campaign: 'dirty', postId: 'p1' });
  const dirtyPost = getPost('dirty', 'p1');
  ok(!dirtyPost.ids.igMediaId, 'a caption with an error-severity finding does NOT publish (no platform id minted)');
  ok(dirtyPost.status !== 'posted', 'the blocked post is not marked posted');
  const dirtyRun = activity().slice(0, activity().length - beforeDirty);
  const lintBlocked = dirtyRun.find((e) => e.action === 'lint-blocked');
  ok(Boolean(lintBlocked), 'a lint-blocked activity entry was recorded for the blocked publish');
  ok(lintBlocked && lintBlocked.ok === false, 'the lint-blocked entry is marked ok:false');
  ok(lintBlocked && lintBlocked.platform === 'instagram', 'the lint-blocked entry names the target platform (instagram)');

  // ---- a CLEAN caption still publishes (the gate does not over-block) -------
  // The same caption the mock-loop test uses; it must clear the gate.
  await approvedIgPost('clean', 'p1', 'a quiet behind the scenes clip');
  await runDueExclusive('owner', { campaign: 'clean', postId: 'p1' });
  const cleanPost = getPost('clean', 'p1');
  ok(Boolean(cleanPost.ids.igMediaId), 'a clean caption still publishes (the lint gate does not over-block)');
  ok(cleanPost.derivedState === 'posted', `the clean post is posted (state=${cleanPost.derivedState})`);

  // ---- a WARNING-only caption still publishes (warnings never block) --------
  // "leverage" trips the ai-vocab rule at severity:"warn" only.
  const warnCaption = 'we leverage our craft to make this clip';
  const lintOfWarn = brandLint({ text: warnCaption, platform: 'instagram' });
  ok(lintOfWarn.errors === 0 && lintOfWarn.warnings >= 1, 'the warn caption trips a warning but no error');
  await approvedIgPost('warn', 'p1', warnCaption);
  await runDueExclusive('owner', { campaign: 'warn', postId: 'p1' });
  ok(Boolean(getPost('warn', 'p1').ids.igMediaId), 'a warning-only caption still publishes (warnings are advisory, never block)');

  // ---- A4: the platform tunes the caption-length cap ------------------------
  // Guards the server contract the dashboard's live lint now depends on: a long
  // caption that is fine for Facebook (cap 63206) must over-run Instagram's far
  // tighter cap (2200). The Composer derives ONE representative platform from the
  // multi-select and threads it through lintText -> /api/lint -> brandLint.
  const longCaption = 'a'.repeat(3000);
  const fbLint = brandLint({ text: longCaption, platform: 'facebook' });
  const fbCapFinding = fbLint.findings.find((f) => f.rule === 'caption-length');
  ok(!fbCapFinding, 'a 3000-char caption is NOT flagged for caption length on facebook (cap 63206)');
  const igLint = brandLint({ text: longCaption, platform: 'instagram' });
  const igCapFinding = igLint.findings.find((f) => f.rule === 'caption-length');
  ok(Boolean(igCapFinding), 'the same 3000-char caption IS flagged for caption length on instagram (cap 2200)');
  // And with no platform context the conservative default (2200) applies, so the
  // unary lintText call shape (no platform) still flags the long caption.
  const defLint = brandLint({ text: longCaption });
  ok(Boolean(defLint.findings.find((f) => f.rule === 'caption-length')), 'with no platform the conservative default cap (2200) still flags the long caption');

  console.log(`[lint-gate] OK - US-LINT-06 fail-closed + A4 platform caps: error captions blocked + logged, clean/warn captions publish, caption cap is platform-tuned (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
