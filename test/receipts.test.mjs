#!/usr/bin/env node
// test/receipts.test.mjs - spec 51 fire glue + verify. Mock mode, the
// circuit-breaker.test.mjs harness. Part A is unit slices for mintAuthorizations'
// split fence + verifyReceipt's neutral state; Part B exercises recordReceipts and the
// full verifyReceipt verdict matrix by PURE construction (mint + a simulated insertion-A
// attestation write + recordReceipts), never the scheduler (that path is Task 5).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-rc-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
const CLIP = Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), CLIP);

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { loadPlanStore, postContentHash } = await import('../lib/plans.mjs');
const { mutatePlan } = await import('../lib/planWrite.mjs');
const { mintAuthorizations, recordReceipts, verifyReceipt } = await import('../lib/receipts.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');
const { verifyPost } = await import('../lib/verify.mjs');

// chmod-based fault injection is meaningless on Windows and bypassed by root - skip those
// slices there rather than assert a fault that never fires.
const CAN_CHMOD = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0);

const getRawPost = (camp, id) => {
  const c = loadPlanStore().campaigns.find((x) => x.id === camp);
  const plan = JSON.parse(fs.readFileSync(path.resolve(WS, c.path), 'utf8'));
  return { plan, planAbs: path.resolve(WS, c.path), post: (plan.posts || []).find((p) => p.id === id) };
};

// Simulate scheduler insertion A: write the minted authorization statements onto the
// raw post as post.attestation[platform] (the scheduler owns this write, not receipts.mjs).
const writeAttestation = async (planAbs, id, statements) => {
  await mutatePlan(planAbs, (plan) => {
    const p = (plan.posts || []).find((x) => x.id === id);
    if (!p) return null;
    p.attestation = { ...(p.attestation || {}), ...statements };
    return p;
  });
};
const setField = async (planAbs, id, field, value) => {
  await mutatePlan(planAbs, (plan) => {
    const p = (plan.posts || []).find((x) => x.id === id);
    if (!p) return null;
    p[field] = value;
    return p;
  });
};
const approvedXPost = async (camp, id, caption = 'a calm little update') => {
  const cp = await createPost({ campaign: camp, post: { id, type: 'text', platforms: ['x'], scheduledAt: '2020-01-01T00:00:00Z', caption }, actor: 'agent:claude' });
  assert.ok(cp.ok, `createPost(${camp}/${id}): ${JSON.stringify(cp)}`);
  const ap = await approvePost({ campaign: camp, postId: id, actor: 'owner' });
  assert.ok(ap.ok, `approvePost(${camp}/${id}): ${JSON.stringify(ap)}`);
};

try {
  // ===== Part A: the split fence + verify's neutral state =====================
  const cc = await createCampaign({ id: 'u', note: 'u', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, JSON.stringify(cc));
  const cp = await createPost({ campaign: 'u', post: { id: 'p1', type: 'text', platforms: ['x'], scheduledAt: '2020-01-01T00:00:00Z', caption: 'hello world' }, actor: 'agent:claude' });
  assert.ok(cp.ok, JSON.stringify(cp));
  await approvePost({ campaign: 'u', postId: 'p1', actor: 'owner' });

  const { post, planAbs } = getRawPost('u', 'p1');

  // Happy path: an approved post whose disk bytes still match the fence signs one auth.
  const m1 = await mintAuthorizations({ campaign: 'u', post, lane: 'x', planAbs, platforms: ['x'], clientId: 'u', now: Date.now() });
  ok(m1.ok && m1.statements.x && m1.statements.x.payload.kind === 'authorization', 'happy path mints one authorization for the x platform');
  ok(m1.statements.x.payload.approvedHash === post.approvedContentHash, 'the authorization carries the 12-hex approvedHash');
  ok(m1.statements.x.payload.contentSha256.length === 64, 'the authorization carries a full contentSha256');

  // Split fence - true mismatch: edit the caption on disk, keep the stale fence hash.
  const raw = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
  raw.posts.find((p) => p.id === 'p1').caption = 'tampered on disk';
  fs.writeFileSync(planAbs, JSON.stringify(raw, null, 2));
  const { post: edited } = getRawPost('u', 'p1');
  const m2 = await mintAuthorizations({ campaign: 'u', post: edited, lane: 'x', planAbs, platforms: ['x'], clientId: 'u', now: Date.now() });
  ok(m2.ok === false && m2.code === 'stale_content', 'a present-but-mismatched fence REFUSES with stale_content');

  // Split fence - missing fingerprint: drop approvedContentHash, fire without a receipt.
  const raw2 = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
  const p2 = raw2.posts.find((p) => p.id === 'p1');
  p2.caption = 'hello world'; // restore so a hash WOULD match if present
  delete p2.approvedContentHash;
  fs.writeFileSync(planAbs, JSON.stringify(raw2, null, 2));
  const { post: legacy } = getRawPost('u', 'p1');
  const m3 = await mintAuthorizations({ campaign: 'u', post: legacy, lane: 'x', planAbs, platforms: ['x'], clientId: 'u', now: Date.now() });
  ok(m3.ok === true && m3.unattested === 'no_fingerprint' && Object.keys(m3.statements).length === 0, 'a missing fingerprint fires without a receipt (no_fingerprint)');

  // verifyReceipt on a post with neither map => neutral no_local_fire.
  const v0 = await verifyReceipt({ campaign: 'u', postId: 'p1', actor: 'owner' });
  ok(v0.ok && v0.reason === 'no_local_fire' && Object.keys(v0.receipts).length === 0, 'verifyReceipt on an un-fired post is neutral no_local_fire');

  console.log(`[receipts:A] OK - split fence + verify neutral state (${pass} assertions).`);

  // ===== Part B: recordReceipts + the full verify verdict matrix =============
  const cb = await createCampaign({ id: 'r', note: 'r', timezone: 'UTC', actor: 'owner' });
  assert.ok(cb.ok, JSON.stringify(cb));

  // --- recordReceipts: empty authorizations is a no-op, writes nothing. -------
  await approvedXPost('r', 'noop');
  const noop = await recordReceipts({ campaign: 'r', post: { id: 'noop' }, lane: 'x', planAbs: getRawPost('r', 'noop').planAbs, clientId: 'r', authorizations: {}, results: [{ platform: 'x', ok: true, id: 'x-noop' }] });
  ok(noop.ok === true && Object.keys(noop.receipts).length === 0, 'empty authorizations is a no-op returning {ok:true, receipts:{}}');
  ok(!getRawPost('r', 'noop').post.receipt, 'the no-op wrote no receipt map to disk');

  // --- recordReceipts: happy path writes receipt.x with a success outcome. -----
  await approvedXPost('r', 'hap');
  {
    const { post: hp, planAbs: pa } = getRawPost('r', 'hap');
    const mh = await mintAuthorizations({ campaign: 'r', post: hp, lane: 'x', planAbs: pa, platforms: ['x'], clientId: 'r', now: Date.now() });
    assert.ok(mh.ok && mh.statements.x, JSON.stringify(mh));
    await writeAttestation(pa, 'hap', mh.statements);
    await setField(pa, 'hap', 'xPostId', 'tweet-1'); // the engine minted id on the raw post
    const rec = await recordReceipts({ campaign: 'r', post: { id: 'hap' }, lane: 'x', planAbs: pa, clientId: 'r', authorizations: mh.statements, results: [{ platform: 'x', ok: true, id: 'tweet-1' }] });
    ok(rec.ok && rec.receipts.x && rec.receipts.x.payload.kind === 'receipt', 'happy path records one receipt for the x platform');
    ok(rec.receipts.x.payload.outcome.ok === true && rec.receipts.x.payload.outcome.platformId === 'tweet-1' && rec.receipts.x.payload.outcome.errorCode === null, 'the receipt outcome carries ok:true + the stringified platformId + null errorCode');
    ok(rec.receipts.x.payload.authSig === mh.statements.x.sig, 'the receipt chains to the authorization via authSig');
    const disk = getRawPost('r', 'hap').post;
    ok(disk.receipt && disk.receipt.x && disk.receipt.x.sig, 'the receipt was written to the raw post on disk');

    // verifyReceipt INTACT => every axis true.
    const vi = await verifyReceipt({ campaign: 'r', postId: 'hap', actor: 'owner' });
    const rx = vi.receipts.x;
    ok(rx && rx.signatureValid && rx.chainValid && rx.placementValid && rx.contentMatchesPlan && rx.platformIdMatches, 'verifyReceipt on an intact fire passes every verdict axis');
    ok(!vi.reason, 'an intact fire carries no reason');
  }

  // --- recordReceipts: fire-row selection is action-aware, not positional. ----
  // Reproduces the LIVE ordering in scripts/x-social.mjs: a set-alt FAILURE row is
  // pushed inside uploadMediaX BEFORE createTweet's publish row, so `results` here
  // carries the companion failure first. If recordReceipts picked "the first row
  // per platform" (the old positional rule) it would sign a receipt claiming the
  // post failed to publish - a false signed audit record for a post that DID
  // publish. The fix selects by action (publish-shaped, ok:true preferred), so the
  // outcome must reflect the publish success, never the companion's errorCode.
  await approvedXPost('r', 'altfirst');
  {
    const { post: ap, planAbs: pa } = getRawPost('r', 'altfirst');
    const ma = await mintAuthorizations({ campaign: 'r', post: ap, lane: 'x', planAbs: pa, platforms: ['x'], clientId: 'r', now: Date.now() });
    assert.ok(ma.ok && ma.statements.x, JSON.stringify(ma));
    await writeAttestation(pa, 'altfirst', ma.statements);
    await setField(pa, 'altfirst', 'xPostId', 'tweet-altfirst'); // the engine minted id on the raw post
    const rec = await recordReceipts({
      campaign: 'r', post: { id: 'altfirst' }, lane: 'x', planAbs: pa, clientId: 'r', authorizations: ma.statements,
      results: [
        { platform: 'x', action: 'set-alt', ok: false, errorCode: 'media_alt_failed' },
        { platform: 'x', action: 'publish', ok: true, id: 'tweet-altfirst' },
      ],
    });
    ok(rec.ok && rec.receipts.x, 'recordReceipts still records a receipt when a companion failure row precedes the publish row');
    ok(rec.receipts.x.payload.outcome.ok === true, 'the outcome is ok:true (the publish succeeded), not the companion set-alt failure');
    ok(rec.receipts.x.payload.outcome.platformId === 'tweet-altfirst', 'the outcome platformId is the minted xPostId, not null');
    ok(rec.receipts.x.payload.outcome.errorCode !== 'media_alt_failed' && rec.receipts.x.payload.outcome.errorCode === null, 'the outcome errorCode is null, never the companion set-alt errorCode');
  }

  // --- recordReceipts: a failed result row carries its errorCode. --------------
  await approvedXPost('r', 'fail');
  {
    const { post: fp, planAbs: pa } = getRawPost('r', 'fail');
    const mf = await mintAuthorizations({ campaign: 'r', post: fp, lane: 'x', planAbs: pa, platforms: ['x'], clientId: 'r', now: Date.now() });
    await writeAttestation(pa, 'fail', mf.statements);
    const rec = await recordReceipts({ campaign: 'r', post: { id: 'fail' }, lane: 'x', planAbs: pa, clientId: 'r', authorizations: mf.statements, results: [{ platform: 'x', ok: false, errorCode: 'rate_limited' }] });
    ok(rec.ok && rec.receipts.x.payload.outcome.ok === false && rec.receipts.x.payload.outcome.errorCode === 'rate_limited' && rec.receipts.x.payload.outcome.platformId === null, 'a failed result row records a failure outcome carrying its errorCode');
  }

  // --- recordReceipts: a zero-row run records a lane-level failure receipt. -----
  await approvedXPost('r', 'zero');
  {
    const { post: zp, planAbs: pa } = getRawPost('r', 'zero');
    const mz = await mintAuthorizations({ campaign: 'r', post: zp, lane: 'x', planAbs: pa, platforms: ['x'], clientId: 'r', now: Date.now() });
    await writeAttestation(pa, 'zero', mz.statements);
    const rec = await recordReceipts({ campaign: 'r', post: { id: 'zero' }, lane: 'x', planAbs: pa, clientId: 'r', authorizations: mz.statements, results: [], laneFailure: { errorCode: 'no_result' } });
    ok(rec.ok && rec.receipts.x.payload.outcome.ok === false && rec.receipts.x.payload.outcome.errorCode === 'no_result', 'a zero-row run records a failure receipt with the lane errorCode');
  }

  // --- verifyReceipt: a forged stored receipt reads signatureValid:false. ------
  await approvedXPost('r', 'tamper');
  {
    const { post: tp, planAbs: pa } = getRawPost('r', 'tamper');
    const mt = await mintAuthorizations({ campaign: 'r', post: tp, lane: 'x', planAbs: pa, platforms: ['x'], clientId: 'r', now: Date.now() });
    await writeAttestation(pa, 'tamper', mt.statements);
    await recordReceipts({ campaign: 'r', post: { id: 'tamper' }, lane: 'x', planAbs: pa, clientId: 'r', authorizations: mt.statements, results: [{ platform: 'x', ok: true, id: 'tweet-t' }] });
    // Forge the stored receipt signature.
    await mutatePlan(pa, (plan) => {
      const p = (plan.posts || []).find((x) => x.id === 'tamper');
      p.receipt.x = { ...p.receipt.x, sig: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
      return p;
    });
    const vt = await verifyReceipt({ campaign: 'r', postId: 'tamper', actor: 'owner' });
    ok(vt.receipts.x.signatureValid === false, 'a forged stored receipt verifies signatureValid:false');
  }

  // --- verifyReceipt: an on-disk content edit reads contentMatchesPlan:false. --
  await approvedXPost('r', 'drift', 'the original reviewed copy');
  {
    const { post: dp, planAbs: pa } = getRawPost('r', 'drift');
    const md = await mintAuthorizations({ campaign: 'r', post: dp, lane: 'x', planAbs: pa, platforms: ['x'], clientId: 'r', now: Date.now() });
    await writeAttestation(pa, 'drift', md.statements);
    await recordReceipts({ campaign: 'r', post: { id: 'drift' }, lane: 'x', planAbs: pa, clientId: 'r', authorizations: md.statements, results: [{ platform: 'x', ok: true, id: 'tweet-d' }] });
    await setField(pa, 'drift', 'caption', 'edited on disk after the fire');
    const vd = await verifyReceipt({ campaign: 'r', postId: 'drift', actor: 'owner' });
    ok(vd.receipts.x.signatureValid === true && vd.receipts.x.chainValid === true && vd.receipts.x.contentMatchesPlan === false, 'an on-disk content edit keeps the signature/chain valid but reads contentMatchesPlan:false');
  }

  // --- verifyReceipt: an authorization with no receipt => missing_receipt. -----
  await approvedXPost('r', 'miss');
  {
    const { post: mp, planAbs: pa } = getRawPost('r', 'miss');
    const mm = await mintAuthorizations({ campaign: 'r', post: mp, lane: 'x', planAbs: pa, platforms: ['x'], clientId: 'r', now: Date.now() });
    await writeAttestation(pa, 'miss', mm.statements); // attestation only, no recordReceipts
    const vm = await verifyReceipt({ campaign: 'r', postId: 'miss', actor: 'owner' });
    ok(vm.ok && vm.reason === 'missing_receipt' && Object.keys(vm.receipts).length === 0, 'an authorization whose receipt vanished reads missing_receipt (not no_local_fire)');
  }

  console.log(`[receipts:B] OK - record + verify verdict matrix (${pass} assertions total).`);

  // ===== Part C: the never-crash degrade branches ============================
  // Every one of these is a problem OTHER than a true content mismatch, so mint must
  // return ok:true (fire) with a distinct unattested code, and recordReceipts must never
  // throw. Deterministic - no flaky signature mutation.

  // --- mint with the post absent from the plan => post_missing. ----------------
  await approvedXPost('r', 'present');
  {
    const { planAbs: pa } = getRawPost('r', 'present');
    const mpm = await mintAuthorizations({ campaign: 'r', post: { id: 'ghost-not-in-plan' }, lane: 'x', planAbs: pa, platforms: ['x'], clientId: 'r', now: Date.now() });
    ok(mpm.ok === true && mpm.unattested === 'post_missing' && Object.keys(mpm.statements).length === 0, 'a post absent from the plan fires without a receipt (post_missing)');
  }

  // --- mint with an unreadable plan file => plan_unreadable (fires, no throw). --
  if (CAN_CHMOD) {
    await approvedXPost('r', 'unread');
    const { post: up, planAbs: pa } = getRawPost('r', 'unread');
    fs.chmodSync(pa, 0o000);
    let mu; let threw = false;
    try { mu = await mintAuthorizations({ campaign: 'r', post: up, lane: 'x', planAbs: pa, platforms: ['x'], clientId: 'r', now: Date.now() }); }
    catch { threw = true; }
    finally { fs.chmodSync(pa, 0o600); }
    ok(!threw && mu.ok === true && mu.unattested === 'plan_unreadable' && Object.keys(mu.statements).length === 0, 'an unreadable plan fires without a receipt (plan_unreadable)');
  } else { console.log('  ~ skipped plan_unreadable slice (win/root)'); }

  // --- mint when the signing key cannot be created => key_unavailable. ---------
  // Delete the key and make the client root non-writable so writeKey's file create fails,
  // while the plan (in a writable subdir) still reads - so we reach getPublicKey, not the
  // plan_unreadable branch above.
  if (CAN_CHMOD) {
    await approvedXPost('r', 'nokey');
    const { post: kp, planAbs: pa } = getRawPost('r', 'nokey');
    const keyPath = path.join(WS, 'attest-key.json');
    let keyBackup = null;
    if (fs.existsSync(keyPath)) { keyBackup = fs.readFileSync(keyPath); fs.rmSync(keyPath); }
    fs.chmodSync(WS, 0o500);
    let mk; let threw = false;
    try { mk = await mintAuthorizations({ campaign: 'r', post: kp, lane: 'x', planAbs: pa, platforms: ['x'], clientId: 'r', now: Date.now() }); }
    catch { threw = true; }
    finally { fs.chmodSync(WS, 0o700); if (keyBackup) fs.writeFileSync(keyPath, keyBackup, { mode: 0o600 }); }
    ok(!threw && mk.ok === true && mk.unattested === 'key_unavailable' && Object.keys(mk.statements).length === 0, 'an uncreatable signing key fires without a receipt (key_unavailable)');
  } else { console.log('  ~ skipped key_unavailable slice (win/root)'); }

  // --- recordReceipts when the post vanished from the plan => ok:false, no throw.
  await approvedXPost('r', 'vanish');
  {
    const { post: vp, planAbs: pa } = getRawPost('r', 'vanish');
    const mv = await mintAuthorizations({ campaign: 'r', post: vp, lane: 'x', planAbs: pa, platforms: ['x'], clientId: 'r', now: Date.now() });
    await writeAttestation(pa, 'vanish', mv.statements);
    await mutatePlan(pa, (plan) => { plan.posts = (plan.posts || []).filter((p) => p.id !== 'vanish'); return null; });
    let rec; let threw = false;
    try { rec = await recordReceipts({ campaign: 'r', post: { id: 'vanish' }, lane: 'x', planAbs: pa, clientId: 'r', authorizations: mv.statements, results: [{ platform: 'x', ok: true, id: 'tw-v' }] }); }
    catch { threw = true; }
    ok(!threw && rec.ok === false, 'recordReceipts when the post is gone from the plan returns ok:false without throwing');
  }

  // --- recordReceipts: the activity-mirror catch swallows an unwritable state. -
  // Seed a matching activity row so the mirror actually attempts saveState, then make the
  // client root non-writable so that write throws - the best-effort catch must absorb it.
  if (CAN_CHMOD) {
    await approvedXPost('r', 'mir');
    const { post: mrp, planAbs: pa } = getRawPost('r', 'mir');
    const mm = await mintAuthorizations({ campaign: 'r', post: mrp, lane: 'x', planAbs: pa, platforms: ['x'], clientId: 'r', now: Date.now() });
    await writeAttestation(pa, 'mir', mm.statements);
    const st = loadState();
    st.activity = st.activity || [];
    st.activity.push({ campaign: 'r', postId: 'mir', platform: 'x' });
    saveState();
    fs.chmodSync(WS, 0o500);
    let rec; let threw = false;
    try { rec = await recordReceipts({ campaign: 'r', post: { id: 'mir' }, lane: 'x', planAbs: pa, clientId: 'r', authorizations: mm.statements, results: [{ platform: 'x', ok: true, id: 'tw-mir' }] }); }
    catch { threw = true; }
    finally { fs.chmodSync(WS, 0o700); }
    ok(!threw && rec.ok === true && rec.receipts.x, 'the activity-mirror best-effort catch absorbs an unwritable state (recordReceipts still ok:true)');
  } else { console.log('  ~ skipped activity-mirror slice (win/root)'); }

  console.log(`[receipts:C] OK - never-crash degrade branches (${pass} assertions total).`);

  // ===== Part D: the verify_post provenance fold (D2, additive) ==============
  // Intact fire: the existing verify_post result gains { signed:true, provenance:'verified' }.
  const c7 = await createCampaign({ id: 'prov', note: 'prov', timezone: 'UTC', actor: 'owner' });
  assert.ok(c7.ok, JSON.stringify(c7));
  await approvedXPost('prov', 'x1');
  await runDueExclusive('owner', { campaign: 'prov', postId: 'x1' });
  const vpOk = await verifyPost({ campaign: 'prov', postId: 'x1', actor: 'owner' });
  ok(vpOk.verify?.platforms?.x?.signed === true && vpOk.verify.platforms.x.provenance === 'verified',
    'verify_post folds { signed:true, provenance:verified } for an intact fire');
  // Edit the caption on disk after the fire => provenance:'content-changed', still signed.
  const provAbs = getRawPost('prov', 'x1').planAbs;
  const provRaw = JSON.parse(fs.readFileSync(provAbs, 'utf8'));
  provRaw.posts.find((p) => p.id === 'x1').caption = 'edited after publish';
  fs.writeFileSync(provAbs, JSON.stringify(provRaw, null, 2));
  const vpChanged = await verifyPost({ campaign: 'prov', postId: 'x1', actor: 'owner' });
  ok(vpChanged.verify.platforms.x.signed === true && vpChanged.verify.platforms.x.provenance === 'content-changed',
    'a post-publish content edit reads as provenance:content-changed');
  // Forge the stored receipt => provenance:'invalid'.
  const provRaw2 = JSON.parse(fs.readFileSync(provAbs, 'utf8'));
  provRaw2.posts.find((p) => p.id === 'x1').receipt.x.payload.outcome.platformId = '000000';
  fs.writeFileSync(provAbs, JSON.stringify(provRaw2, null, 2));
  const vpForged = await verifyPost({ campaign: 'prov', postId: 'x1', actor: 'owner' });
  ok(vpForged.verify.platforms.x.provenance === 'invalid', 'a forged receipt reads as provenance:invalid');
  // A legacy/no-receipt post => { signed:false, provenance:'none' }. Fire it for
  // real (so ids.xPostId is live and lanesToVerify includes 'x', i.e. verifyPost
  // does NOT take its early no-lanes return), then strip the receipt/attestation
  // maps to simulate a fire that predates spec 51 - so this genuinely exercises the
  // "no receipt" branch of the provenance fold instead of a vacuous early return.
  const cLeg = await createCampaign({ id: 'leg', note: 'leg', timezone: 'UTC', actor: 'owner' });
  assert.ok(cLeg.ok, JSON.stringify(cLeg));
  await approvedXPost('leg', 'x1');
  await runDueExclusive('owner', { campaign: 'leg', postId: 'x1' });
  const legAbs = getRawPost('leg', 'x1').planAbs;
  const legRaw = JSON.parse(fs.readFileSync(legAbs, 'utf8'));
  const legPost = legRaw.posts.find((p) => p.id === 'x1');
  // The raw plan stores the minted id flat (post.xPostId); findCampaign() is what
  // projects it onto post.ids.xPostId for lanesToVerify to read.
  assert.ok(legPost.xPostId, 'legacy fixture actually fired (carries a live xPostId)');
  delete legPost.receipt;
  delete legPost.attestation;
  fs.writeFileSync(legAbs, JSON.stringify(legRaw, null, 2));
  const vpNone = await verifyPost({ campaign: 'leg', postId: 'x1', actor: 'owner' });
  ok(vpNone.verify.platforms.x.signed === false && vpNone.verify.platforms.x.provenance === 'none',
    'a legacy fire (live id, no receipt) carries { signed:false, provenance:none }');

  console.log(`[receipts:D] OK - verify_post provenance fold (${pass} assertions total).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
