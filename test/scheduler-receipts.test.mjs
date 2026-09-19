#!/usr/bin/env node
// test/scheduler-receipts.test.mjs - spec 51 Task 5: the REAL scheduler fire path
// (runDueExclusive spawns the real engine subprocess, which resolves to the mock
// driver because PENDPOST_MODE=mock and the temp workspace has no .env). No real
// network ever happens. This proves the two scheduler insertion points end-to-end:
//   A (mint, pre-fire)  -> post.attestation[platform] before dispatch + the split fence
//   B (record, post-fire) -> post.receipt[platform] after the results loop
//   C (activity mirror) -> the publish row carries attest:{ kid, sig }
// while test/receipts.test.mjs covers mint/record/verify by pure construction.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-srx-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_MOCK_FAIL;

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
const CLIP = Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), CLIP);

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { loadState } = await import('../lib/state.mjs');
const { verifyReceipt } = await import('../lib/receipts.mjs');

const activity = () => loadState().activity || [];
// The RAW plan post read straight from disk - the bytes the scheduler + engine saw,
// carrying the lib-written attestation/receipt maps and the engine-written id fields.
const getRawPost = (camp, id) => {
  const c = loadPlanStore().campaigns.find((x) => x.id === camp);
  const planAbs = path.resolve(WS, c.path);
  const plan = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
  return { planAbs, post: (plan.posts || []).find((p) => p.id === id) };
};
async function approvedXPost(camp, id, caption = 'a calm little update') {
  const cp = await createPost({ campaign: camp, post: { id, type: 'text', platforms: ['x'], scheduledAt: '2020-01-01T00:00:00Z', caption }, actor: 'agent:claude' });
  assert.ok(cp.ok, `createPost(${camp}/${id}): ${JSON.stringify(cp)}`);
  const ap = await approvePost({ campaign: camp, postId: id, actor: 'owner' });
  assert.ok(ap.ok, `approvePost(${camp}/${id}): ${JSON.stringify(ap)}`);
}

try {
  // (1) one x post fires => attestation.x + receipt.x on the raw post; chain links; id matches.
  const c1 = await createCampaign({ id: 'fire', note: 'fire', timezone: 'UTC', actor: 'owner' });
  assert.ok(c1.ok, JSON.stringify(c1));
  await approvedXPost('fire', 'x1');
  await runDueExclusive('owner', { campaign: 'fire', postId: 'x1' });
  const f1 = getRawPost('fire', 'x1').post;
  ok(f1.attestation && f1.attestation.x && f1.receipt && f1.receipt.x, 'a fired x post carries attestation.x + receipt.x');
  ok(f1.receipt.x.payload.authSig === f1.attestation.x.sig, 'the receipt chains to its own authorization sig');
  ok(f1.receipt.x.payload.outcome.platformId === String(f1.xPostId), 'the receipt platformId equals the minted post id');
  ok(activity().some((e) => e.campaign === 'fire' && e.postId === 'x1' && e.platform === 'x' && e.attest && e.attest.kid), 'the publish activity row carries attest.kid');

  // (2) a reel targeting instagram + facebook => four statements, two distinct ids.
  const c2 = await createCampaign({ id: 'meta', note: 'meta', timezone: 'UTC', actor: 'owner' });
  assert.ok(c2.ok, JSON.stringify(c2));
  const cpr = await createPost({ campaign: 'meta', post: { id: 'r1', type: 'reel', platforms: ['instagram', 'facebook'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'a quiet clip' }, actor: 'agent:claude' });
  assert.ok(cpr.ok, JSON.stringify(cpr));
  await approvePost({ campaign: 'meta', postId: 'r1', actor: 'owner' });
  await runDueExclusive('owner', { campaign: 'meta', postId: 'r1' });
  const f2 = getRawPost('meta', 'r1').post;
  ok(f2.attestation.instagram && f2.attestation.facebook && f2.receipt.instagram && f2.receipt.facebook, 'a meta reel carries four statements');
  ok(f2.receipt.instagram.payload.outcome.platformId !== f2.receipt.facebook.payload.outcome.platformId, 'the two platforms carry distinct minted ids');

  // (3) fence: edit the caption on disk after approval => refuse, de-dupe, then recover.
  const c3 = await createCampaign({ id: 'fen', note: 'fen', timezone: 'UTC', actor: 'owner' });
  assert.ok(c3.ok, JSON.stringify(c3));
  await approvedXPost('fen', 'x1');
  const fenAbs = getRawPost('fen', 'x1').planAbs;
  const fenRaw = JSON.parse(fs.readFileSync(fenAbs, 'utf8'));
  fenRaw.posts.find((p) => p.id === 'x1').caption = 'edited by hand on disk';
  fs.writeFileSync(fenAbs, JSON.stringify(fenRaw, null, 2));
  const fenBefore = activity().length;
  await runDueExclusive('owner', { campaign: 'fen', postId: 'x1' });
  await runDueExclusive('owner', { campaign: 'fen', postId: 'x1' }); // second tick: de-duped
  const fenRows = activity().slice(0, activity().length - fenBefore).filter((e) => e.postId === 'x1' && e.action === 'publish-refused' && e.errorCode === 'stale_content');
  ok(fenRows.length === 1, `a disk-edited post refuses with ONE stale_content row across two ticks (${fenRows.length})`);
  ok(!getRawPost('fen', 'x1').post.attestation && !getRawPost('fen', 'x1').post.xPostId, 'nothing signed, nothing fired on a fence refusal');
  await approvePost({ campaign: 'fen', postId: 'x1', actor: 'owner' }); // re-approve clears it
  await runDueExclusive('owner', { campaign: 'fen', postId: 'x1' });
  ok(Boolean(getRawPost('fen', 'x1').post.attestation?.x), 're-approving then ticking fires and signs');

  // (4) legacy (split fence): no approvedContentHash => fires, no receipt, no refusal.
  const c4 = await createCampaign({ id: 'leg', note: 'leg', timezone: 'UTC', actor: 'owner' });
  assert.ok(c4.ok, JSON.stringify(c4));
  await approvedXPost('leg', 'x1');
  const legAbs = getRawPost('leg', 'x1').planAbs;
  const legRaw = JSON.parse(fs.readFileSync(legAbs, 'utf8'));
  delete legRaw.posts.find((p) => p.id === 'x1').approvedContentHash;
  fs.writeFileSync(legAbs, JSON.stringify(legRaw, null, 2));
  const legBefore = activity().length;
  await runDueExclusive('owner', { campaign: 'leg', postId: 'x1' });
  const legPost = getRawPost('leg', 'x1').post;
  ok(Boolean(legPost.xPostId) && !legPost.attestation && !legPost.receipt, 'a legacy post fires with NO attestation/receipt');
  ok(!activity().slice(0, activity().length - legBefore).some((e) => e.action === 'publish-refused'), 'a legacy post is never refused');
  const legV = await verifyReceipt({ campaign: 'leg', postId: 'x1', actor: 'owner' });
  ok(legV.ok && legV.reason === 'no_local_fire', 'verifyReceipt on a legacy fire is neutral no_local_fire');

  // (5) partial failure: instagram fails, facebook succeeds; a later tick overwrites.
  process.env.PENDPOST_MOCK_FAIL = 'instagram:engine_failure:mock ig failure';
  const c5 = await createCampaign({ id: 'part', note: 'part', timezone: 'UTC', actor: 'owner' });
  assert.ok(c5.ok, JSON.stringify(c5));
  const cpp = await createPost({ campaign: 'part', post: { id: 'r1', type: 'reel', platforms: ['instagram', 'facebook'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'partial clip' }, actor: 'agent:claude' });
  assert.ok(cpp.ok, JSON.stringify(cpp));
  await approvePost({ campaign: 'part', postId: 'r1', actor: 'owner' });
  await runDueExclusive('owner', { campaign: 'part', postId: 'r1' });
  const f5 = getRawPost('part', 'r1').post;
  ok(f5.receipt.facebook.payload.outcome.ok === true && f5.receipt.instagram.payload.outcome.ok === false, 'partial failure yields one ok:true and one ok:false receipt');
  ok(f5.receipt.instagram.payload.outcome.errorCode === 'engine_failure', 'the failed receipt carries the failure code');
  delete process.env.PENDPOST_MOCK_FAIL;
  await runDueExclusive('owner', { campaign: 'part', postId: 'r1' }); // publish-hold retry overwrites
  ok(getRawPost('part', 'r1').post.receipt.instagram.payload.outcome.ok === true, 'a later successful tick overwrites the failed receipt');

  // (6) key unavailable (split fence): swap the key file for a DIRECTORY so getPublicKey's
  // read throws EISDIR => fire, no receipt, no refusal. A 0000 placeholder does NOT work:
  // readKey self-heals a bad mode via chmod and would mint a fresh key instead. Back up +
  // restore the real key bytes so the kid earlier fires signed under stays 'active' below.
  {
    const c6 = await createCampaign({ id: 'nokey', note: 'nokey', timezone: 'UTC', actor: 'owner' });
    assert.ok(c6.ok, JSON.stringify(c6));
    await approvedXPost('nokey', 'x1');
    const keyPath = path.join(WS, 'attest-key.json');
    const keyBackup = fs.existsSync(keyPath) ? fs.readFileSync(keyPath) : null;
    fs.rmSync(keyPath, { force: true });
    fs.mkdirSync(keyPath); // a directory where the key file should be => readFileSync throws EISDIR
    const nokeyBefore = activity().length;
    try {
      await runDueExclusive('owner', { campaign: 'nokey', postId: 'x1' });
    } finally {
      fs.rmSync(keyPath, { recursive: true, force: true });
      if (keyBackup) fs.writeFileSync(keyPath, keyBackup, { mode: 0o600 });
    }
    const f6 = getRawPost('nokey', 'x1').post;
    ok(Boolean(f6.xPostId) && !f6.attestation && !f6.receipt, 'an unreadable key still fires, with no attestation/receipt');
    ok(!activity().slice(0, activity().length - nokeyBefore).some((e) => e.action === 'publish-refused'), 'a key-unavailable fire is never refused');
  }

  // (7)(8)(9): verifyReceipt verdicts on the scheduler-signed fire. Reuse campaign 'fire'.
  const vIntact = await verifyReceipt({ campaign: 'fire', postId: 'x1', actor: 'owner' });
  ok(vIntact.receipts.x.signatureValid && vIntact.receipts.x.chainValid && vIntact.receipts.x.contentMatchesPlan && vIntact.receipts.x.platformIdMatches && vIntact.receipts.x.keyStatus === 'active', 'row 7: an intact fire verifies green on every axis');
  // (8) tamper the caption on disk after the fire => contentMatchesPlan false, sig valid.
  const fireAbs = getRawPost('fire', 'x1').planAbs;
  const fireRaw = JSON.parse(fs.readFileSync(fireAbs, 'utf8'));
  fireRaw.posts.find((p) => p.id === 'x1').caption = 'silently edited after publish';
  fs.writeFileSync(fireAbs, JSON.stringify(fireRaw, null, 2));
  const vEdited = await verifyReceipt({ campaign: 'fire', postId: 'x1', actor: 'owner' });
  ok(vEdited.receipts.x.signatureValid === true && vEdited.receipts.x.contentMatchesPlan === false, 'row 8: a post-publish content edit reads as content changed, not forged');
  // (9) forge the stored receipt's platformId => signatureValid false.
  const fireRaw2 = JSON.parse(fs.readFileSync(fireAbs, 'utf8'));
  fireRaw2.posts.find((p) => p.id === 'x1').receipt.x.payload.outcome.platformId = '000000';
  fs.writeFileSync(fireAbs, JSON.stringify(fireRaw2, null, 2));
  const vForged = await verifyReceipt({ campaign: 'fire', postId: 'x1', actor: 'owner' });
  ok(vForged.receipts.x.signatureValid === false, 'row 9: a forged receipt payload fails signatureValid');

  // (10) activity-mirror precision: a platform that appends MORE than one row in the
  // same tick (x image+altText fires publish then set-alt - lib/drivers/mock-driver.mjs)
  // must stamp attest onto the publish row, never onto the later-appended companion row.
  // appendActivity PREPENDS (newest-first), so the naive "any unattested row for this
  // platform" match picks the LAST-appended row (set-alt) instead of the publish row the
  // receipt actually describes.
  const c10 = await createCampaign({ id: 'altmirror', note: 'altmirror', timezone: 'UTC', actor: 'owner' });
  assert.ok(c10.ok, JSON.stringify(c10));
  fs.writeFileSync(path.join(WS, 'data', 'media', 'pic.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const cp10 = await createPost({
    campaign: 'altmirror',
    post: { id: 'x1', type: 'image', platforms: ['x'], scheduledAt: '2020-01-01T00:00:00Z', caption: 'a calm little update', path: 'data/media/pic.jpg', altText: 'a red bicycle' },
    actor: 'agent:claude',
  });
  assert.ok(cp10.ok, JSON.stringify(cp10));
  await approvePost({ campaign: 'altmirror', postId: 'x1', actor: 'owner' });
  await runDueExclusive('owner', { campaign: 'altmirror', postId: 'x1' });
  const altRows = activity().filter((e) => e.campaign === 'altmirror' && e.postId === 'x1' && e.platform === 'x');
  const publishRow = altRows.find((e) => e.action === 'publish');
  const setAltRow = altRows.find((e) => e.action === 'set-alt');
  ok(Boolean(publishRow), 'row 10 setup: the tick appended a publish row');
  ok(Boolean(setAltRow), 'row 10 setup: the tick appended a companion set-alt row (confirms the mock driver reproduces the multi-row case)');
  ok(Boolean(publishRow?.attest?.kid), 'row 10: the publish row carries attest.kid');
  ok(!setAltRow?.attest, 'row 10: the companion set-alt row does NOT carry attest');

  console.log(`[scheduler-receipts] OK - fire-path mint/record/mirror + split fence + verify verdicts (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
