// lib/receipts.mjs - spec 51 fire-path glue (mint pre-fire, record post-fire) + the
// verify read. The engines are untouched: the statements are lib-written, for the same
// field-merge reason post.verify is lib-written (lib/verify.mjs). All three functions
// are called from the scheduler's per-lane loop (mint/record) or the MCP/API read
// surface (verify); none spawns an engine or touches the network.
import fs from 'node:fs';
import path from 'node:path';
import { signStatement, verifyStatement, keyStatus, getPublicKey } from './attest.mjs';
import { loadPlanStore, postContentHash, contentSha256, PLATFORM_ID_FIELDS } from './plans.mjs';
import { mutatePlan } from './planWrite.mjs';
import { loadState, saveState } from './state.mjs';
import { expectedAccountsFor } from './cloud-client.mjs';
import { activeRoot } from './context.mjs';
import { logLine, errorBody } from './util.mjs';

// Re-read the RAW post from the plan file on disk - the exact bytes the engine is about
// to read - so the fence hash and contentSha256 are computed over what fires, not over
// the normalised in-memory copy.
// NOTE: this is deliberately NOT writes.mjs's rawPostOf. That one swallows a read error
// to null, which would collapse the not-found (post_missing) vs unreadable (plan_unreadable)
// distinction the split fence below depends on - here a read failure MUST throw.
function rawPostOf(planAbs, postId) {
  const plan = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
  return (plan.posts || []).find((p) => p.id === postId) || null;
}

// Mint one signed authorization per authorized platform, gated by the split fence.
// Attestation is ADDITIVE - it must never block a legitimate publish - so ok:false is
// returned for EXACTLY ONE reason: a present approvedContentHash that no longer matches
// the raw-from-disk recompute (tamper evidence). Every other problem is ok:true with a
// DISTINCT unattested:<reason> label meaning "fire the publish, just write no receipt".
// Returns:
//   { ok:true, statements:{ <platform>: signed } }                    happy path - sign + fire
//   { ok:true, statements:{}, unattested:'plan_unreadable', message } raw read OR a hash-
//                                                                     computation threw - fire, no receipt
//   { ok:true, statements:{}, unattested:'post_missing' }             post gone from plan - fire, no receipt
//   { ok:true, statements:{}, unattested:'no_fingerprint' }           legacy post - fire, no receipt
//   { ok:true, statements:{}, unattested:'key_unavailable', message } key I/O fail - fire, warn, no receipt
//   { ok:false, code:'stale_content', message }                       TRUE mismatch - refuse (the ONLY block)
// ok:true ALWAYS means "proceed to fire".
export async function mintAuthorizations({ campaign, post, lane, planAbs, platforms, clientId, now }) {
  // Evaluate post.id BEFORE the try so a caller bug (post undefined) surfaces as a real
  // throw, not a swallowed degrade.
  const postId = post.id;
  let rawPost;
  try {
    rawPost = rawPostOf(planAbs, postId);
  } catch (e) {
    return { ok: true, statements: {}, unattested: 'plan_unreadable', message: `plan unreadable: ${e.message}` };
  }
  // Post genuinely absent from the plan vs present-but-no-fingerprint are distinct, honest
  // labels - both fire, neither is a mismatch.
  if (!rawPost) return { ok: true, statements: {}, unattested: 'post_missing' };

  const approvedHash = rawPost.approvedContentHash || null;
  if (!approvedHash) return { ok: true, statements: {}, unattested: 'no_fingerprint' };

  // The COMPUTATION is guarded (a throw - e.g. a malformed rawPost shape - must
  // degrade, never crash the tick), but the COMPARISON just below is deliberately
  // left outside any catch: stale_content is tamper evidence and must never be
  // swallowed by a broad try/catch around both steps.
  let finalParamsHash;
  try {
    finalParamsHash = postContentHash(rawPost);
  } catch (e) {
    return { ok: true, statements: {}, unattested: 'plan_unreadable', message: `content hash failed: ${e.message}` };
  }
  if (finalParamsHash !== approvedHash) {
    return { ok: false, code: 'stale_content', message: 'content changed since approval - re-approve to publish' };
  }

  // Ensure the signing key exists / is readable; a failure here fires WITHOUT a receipt.
  try { getPublicKey(); } catch (e) { return { ok: true, statements: {}, unattested: 'key_unavailable', message: e.message }; }

  // Same guard as finalParamsHash above: a throw here must degrade, not crash.
  let fullSha;
  try {
    fullSha = contentSha256(rawPost);
  } catch (e) {
    return { ok: true, statements: {}, unattested: 'plan_unreadable', message: `content hash failed: ${e.message}` };
  }
  // Guard the timestamp so the module keeps its never-throw ethos even on a bad `now`.
  const firedAt = new Date(Number.isFinite(now) ? now : Date.now()).toISOString();
  let accounts = {};
  try { accounts = expectedAccountsFor(); } catch { accounts = {}; }

  const statements = {};
  for (const platform of platforms) {
    const payload = {
      v: 1,
      kind: 'authorization',
      clientId,
      campaign,
      postId: post.id,
      platform,
      lane,
      account: accounts[platform] || null,
      approvedBy: rawPost.approvalBy || null,
      approvedAt: rawPost.approvalAt || null,
      approvedHash,
      finalParamsHash,
      contentSha256: fullSha,
      firedAt,
    };
    try { statements[platform] = signStatement('authorization', payload); }
    catch (e) { return { ok: true, statements: {}, unattested: 'key_unavailable', message: e.message }; }
  }
  return { ok: true, statements };
}

// Record one signed receipt per AUTHORIZED platform (keyed by the result row's platform;
// a zero-row run carries the lane-level failure code). Best-effort against the plan lock:
// the engine has exited and the publish already happened, so a write failure only logs
// warn - a receipt is evidence, never a gate. A no-op returning { ok:true, receipts:{} }
// when there are no authorizations, so the two maps can never fall out of step.
export async function recordReceipts({ campaign, post, lane, planAbs, clientId, authorizations, results, laneFailure }) {
  const auths = authorizations || {};
  const authPlatforms = Object.keys(auths);
  if (!authPlatforms.length) return { ok: true, receipts: {} };

  // Select the FIRE row per platform by ACTION, never by position. The old rule kept
  // the first result row seen per platform, on the assumption that every engine
  // appends companion rows (set-alt, set-seo, post-comment, ...) AFTER the
  // publish/fire row for the same platform in the same tick. That assumption is
  // FALSE for at least two engines: scripts/x-social.mjs pushes a set-alt FAILURE
  // row inside uploadMediaX (~:377-383), which runs BEFORE createTweet's publish
  // row is pushed (~:858); scripts/wordpress-social.mjs pushes set-alt/set-seo
  // failure rows in buildPayload (~:364-382), BEFORE the publish row (~:541/:628).
  // "First row" there picks the failed companion, which would sign a receipt
  // claiming the post failed to publish (and stamp attest on the companion row)
  // for a post that actually went live - a false signed audit record.
  // The rule instead: per platform, prefer an ok:true row whose action is
  // publish-shaped (`action === 'schedule-native' || /^publish/.test(action)`,
  // covering publish, publish-image, publish-carousel, publish-reel and
  // schedule-native across the engines); else any publish-shaped row (a genuine
  // publish failure); else, only when the platform emitted no publish-shaped row
  // at all this tick, fall back to the first row seen (preserves the old
  // behaviour for that edge case, e.g. an engine that failed before ever
  // attempting the fire action).
  const isFireAction = (action) => action === 'schedule-native' || /^publish/.test(String(action || ''));
  const rowsByPlatform = new Map();
  for (const r of results || []) {
    if (!r || !r.platform) continue;
    if (!rowsByPlatform.has(r.platform)) rowsByPlatform.set(r.platform, []);
    rowsByPlatform.get(r.platform).push(r);
  }
  const byPlatform = new Map();
  for (const [platform, rows] of rowsByPlatform) {
    const fireRows = rows.filter((r) => isFireAction(r.action));
    byPlatform.set(platform, fireRows.find((r) => r.ok) || fireRows[0] || rows[0]);
  }

  // platformId is resolved from PLATFORM_ID_FIELDS against `post` FIRST - the caller
  // (the scheduler) passes the post re-read from disk AFTER the fire, so this sees the
  // id the engine (mock or live) just persisted, the same field the post's own publish
  // evidence uses (lib/plans.mjs PLATFORM_ID_FIELDS). This is the one mechanism that
  // resolves identically for mock (whose result rows omit `id` - the mock driver mutates
  // the post object in place and lets the plan write carry the id) and live (whose
  // result-row id key varies by lane). r.id is kept as a fallback ONLY for a caller that
  // did not thread a freshly-minted post through (e.g. a pure-construction caller
  // exercising this function directly against a stub post) - never the primary source.
  const idFor = (platform, r) => {
    const fields = PLATFORM_ID_FIELDS[platform] || [];
    const fromPost = fields.map((f) => (post && post[f] != null ? String(post[f]) : null)).find((v) => v != null);
    if (fromPost != null) return fromPost;
    return r && r.id != null ? String(r.id) : null;
  };

  const receipts = {};
  for (const platform of authPlatforms) {
    const r = byPlatform.get(platform);
    const outcome = r
      ? { ok: Boolean(r.ok), platformId: r.ok ? idFor(platform, r) : null, errorCode: r.ok ? null : (r.errorCode || 'engine_failure') }
      : { ok: false, platformId: null, errorCode: (laneFailure && laneFailure.errorCode) || 'engine_failure' };
    const payload = {
      v: 1, kind: 'receipt', clientId, campaign, postId: post.id, platform,
      authSig: auths[platform]?.sig || null,
      outcome,
      recordedAt: new Date().toISOString(),
    };
    try { receipts[platform] = signStatement('receipt', payload); }
    catch (e) { logLine('warn', `[attest] receipt sign failed for ${campaign}/${post.id} ${platform}: ${e.message}`); return { ok: false, receipts }; }
  }

  try {
    let found = true;
    await mutatePlan(planAbs, (plan) => {
      const p = (plan.posts || []).find((x) => x.id === post.id);
      if (!p) { found = false; return null; }
      p.receipt = { ...(p.receipt || {}), ...receipts };
      return p;
    });
    // The post vanished from the plan before the write - the publish already happened, so
    // the receipt did not persist. Funnel it into the same failure path as a write error
    // (ok:false honestly signals no receipt landed), matching how lib/verify.mjs treats
    // unknown_post rather than falsely reporting ok:true.
    if (!found) {
      logLine('warn', `[attest] receipt write skipped - post gone from plan for ${campaign}/${post.id}`);
      return { ok: false, receipts };
    }
  } catch (e) {
    logLine('warn', `[attest] receipt write failed for ${campaign}/${post.id}: ${e.message}`);
    return { ok: false, receipts };
  }

  // Insertion C (activity mirror): patch attest onto the just-appended fire row this tick,
  // matched by (campaign, postId, platform, action). Zero-row lane rows (platform === lane)
  // do not match a receipt platform and stay un-mirrored, which is fine (§8 only asserts
  // the per-result publish row carries attest.kid). Best-effort.
  //
  // Matching on action (not just campaign/postId/platform) matters because appendActivity
  // PREPENDS (newest-first): a lane that appends more than one row for this platform in one
  // tick - a companion action right after the publish/fire row, e.g. x image+altText
  // (publish then set-alt), linkedin+firstComment (publish then post-comment), wordpress/
  // ghost+SEO (publish or schedule-native then set-seo), pinterest+altText (publish then
  // set-alt) - sits with its LAST-appended row at index 0. Matching on (campaign, postId,
  // platform) alone would stamp attest onto that companion row instead of the actual
  // publish row, which is exactly what spec 51 §4.5 C / §8 require to carry attest.kid.
  try {
    const state = loadState();
    let touched = false;
    for (const [platform, signed] of Object.entries(receipts)) {
      const r = byPlatform.get(platform);
      const fireAction = r ? r.action : null;
      let row = fireAction
        ? (state.activity || []).find((e) => e.campaign === campaign && e.postId === post.id && e.platform === platform && e.action === fireAction && !e.attest)
        : null;
      // Fallback (fire action unresolved, e.g. a zero-row lane failure this tick): the
      // OLDEST unattested matching row for the platform, never the newest - the publish
      // row is always appended first, so among prepended rows it ends up LAST.
      if (!row) {
        const matches = (state.activity || []).filter((e) => e.campaign === campaign && e.postId === post.id && e.platform === platform && !e.attest);
        row = matches.length ? matches[matches.length - 1] : null;
      }
      if (row) { row.attest = { kid: signed.kid, sig: signed.sig.slice(0, 12) }; touched = true; }
    }
    if (touched) saveState();
  } catch { /* the activity mirror is best-effort */ }

  return { ok: true, receipts };
}

function safeKey() {
  try { const k = getPublicKey(); return { kid: k.kid, pub: k.pub, status: keyStatus(k.kid) }; }
  catch { return null; }
}

// Read-only verify: recompute both signatures, the receipt->authorization chain, the
// placement, whether the plan's current content and minted id still match what was
// signed, and the key status. Appends NO activity row. `reason` keys on the ATTESTATION
// (not the minted id) so the split fence never reads as a fault: missing_receipt only
// when an authorization exists but its receipt does not; neither map => no_local_fire.
export async function verifyReceipt({ campaign, postId, platform = null, actor }) {
  const { campaigns } = loadPlanStore();
  const c = campaigns.find((x) => x.id === campaign);
  if (!c) return errorBody('unknown_campaign', `unknown campaign ${campaign}`);
  const planAbs = path.resolve(activeRoot(), c.path);
  let rawPost;
  try { rawPost = rawPostOf(planAbs, postId); }
  catch (e) { return errorBody('engine_failure', `plan unreadable: ${e.message}`); }
  if (!rawPost) return errorBody('unknown_post', `unknown post ${postId} in ${campaign}`);

  const attestation = rawPost.attestation || {};
  const receiptMap = rawPost.receipt || {};
  const key = safeKey();

  if (!Object.keys(attestation).length && !Object.keys(receiptMap).length) {
    return { ok: true, campaign, postId, key, receipts: {}, reason: 'no_local_fire' };
  }

  // When no platform is named, walk the UNION of both maps: an authorization whose
  // receipt vanished lives in attestation only, and it is exactly that platform that
  // must surface as missing_receipt. Iterating receiptMap alone would never visit it.
  const platforms = platform ? [platform] : [...new Set([...Object.keys(attestation), ...Object.keys(receiptMap)])];
  const fullSha = contentSha256(rawPost);
  const receipts = {};
  let missing = false;

  for (const p of platforms) {
    const rc = receiptMap[p];
    const auth = attestation[p];
    if (!rc) { if (auth) missing = true; continue; }
    const rcV = verifyStatement(rc);
    const authV = auth ? verifyStatement(auth) : { ok: false };
    const idFields = PLATFORM_ID_FIELDS[p] || [];
    const liveId = idFields.map((f) => (rawPost[f] != null ? String(rawPost[f]) : null)).find((v) => v != null) ?? null;
    receipts[p] = {
      signatureValid: rcV.ok && authV.ok,
      chainValid: Boolean(auth) && rc.payload.authSig === auth.sig,
      placementValid: rc.payload.campaign === campaign && rc.payload.postId === postId && rc.payload.platform === p,
      contentMatchesPlan: Boolean(auth) && auth.payload.contentSha256 === fullSha,
      platformIdMatches: (rc.payload.outcome?.platformId ?? null) === liveId,
      keyStatus: keyStatus(rc.kid),
      kid: rc.kid,
      pub: rc.pub,
      firedAt: auth?.payload.firedAt ?? null,
      recordedAt: rc.payload.recordedAt ?? null,
      outcome: rc.payload.outcome ?? null,
    };
  }

  const out = { ok: true, campaign, postId, key, receipts };
  if (!Object.keys(receipts).length) out.reason = missing ? 'missing_receipt' : 'no_local_fire';
  else if (missing) out.reason = 'missing_receipt';
  return out;
}
