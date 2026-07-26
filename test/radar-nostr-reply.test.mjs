#!/usr/bin/env node
// test/radar-nostr-reply.test.mjs - nostr as a reply-capable Radar source (the
// wave-5 flip of spec 33's banner note), cloned from radar-x-youtube-reply.test.mjs.
// A wrong id/tag mapping here is an irreversible PUBLIC reply on a stranger's
// note, so this locks:
//
//   nostr: the signal externalId (an event id) -> the NIP-10 ['e', <id>, '', 'root']
//          tag on a signed kind-1, with ['p', <author-pubkey>] routing it to the
//          author (buildRadarReplyEvent).
//
// It also pins the seam decisions the checklist at lib/radar.mjs demands:
//   - nostr is reply:true + humanGated, search:false (agent-ingested, never
//     searched - runLaneRadar refuses), copyDraft dropped (disjoint sets).
//   - RADAR_SOURCE_SCOPE carries the nostr entry (null - client-signed, no OAuth).
//   - the write boundary accepts source:nostr + platforms:[nostr] and rejects a
//     mismatch.
//   - the scheduler routes a nostr radar reply to the LOCAL-only `nostr-reply`
//     lane (never the CLOUD nostr lane), due-gated + target_gone-terminal, while
//     a normal nostr post still rides the shared nostr lane.
//   - the auto-approve fence refuses any radarReplyTo post (byte-unchanged rule).
//   - mock and live agree: the mock driver fires the reply like bluesky's.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-nostr-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

try {
  // ===== (1) capability table + scope + derived sets =====
  const { RADAR_SOURCES, RADAR_CAPABILITIES, RADAR_REPLY_SOURCES, RADAR_COPY_DRAFT_SOURCES, RADAR_SOURCE_SCOPE, runLaneRadar } = await import('../lib/radar.mjs');
  ok(RADAR_CAPABILITIES.nostr && RADAR_CAPABILITIES.nostr.search === false && RADAR_CAPABILITIES.nostr.reply === true && RADAR_CAPABILITIES.nostr.humanGated === true,
    'RADAR_CAPABILITIES.nostr = { search:false, reply:true, humanGated:true } (the wave-5 flip)');
  ok(!RADAR_CAPABILITIES.nostr.copyDraft && !RADAR_COPY_DRAFT_SOURCES.includes('nostr'),
    'nostr left the copy path (the two sets stay disjoint by construction)');
  ok(RADAR_REPLY_SOURCES.includes('nostr'),
    'RADAR_REPLY_SOURCES auto-derives nostr from reply:true');
  ok(Object.prototype.hasOwnProperty.call(RADAR_SOURCE_SCOPE, 'nostr') && RADAR_SOURCE_SCOPE.nostr === null,
    'RADAR_SOURCE_SCOPE carries the nostr entry (null - client-signed, no OAuth scope; the hackernews posture)');
  ok(!RADAR_SOURCES.includes('nostr'),
    'nostr stays OUT of RADAR_SOURCES (agent-ingested, never engine-searched - mirrors web/x/youtube)');
  const scan = await runLaneRadar('nostr', {});
  ok(scan.ok === false && scan.error === 'invalid_input' && (scan.items || []).length === 0,
    'runLaneRadar("nostr") refuses (search:false) - never spawns an engine search');

  // ===== (2) the signed kind-1 reply event: e/p tag mapping =====
  {
    const { buildRadarReplyEvent, keysFromSecret, verifyRelayEvent } = await import('../scripts/nostr-social.mjs');
    const crypto = await import('node:crypto');
    // A throwaway secp256k1 keypair via the engine's own exported derivation.
    const keys = keysFromSecret(crypto.randomBytes(32).toString('hex'));
    const ev = buildRadarReplyEvent(keys, 'EVENT_PARENT_1', 'a'.repeat(64), 'happy to help - here is how we handle that');
    ok(ev.kind === 1, 'the radar reply is a kind-1 note (not a reaction, not an article)');
    const eTag = ev.tags.find((t) => t[0] === 'e');
    ok(eTag && eTag[1] === 'EVENT_PARENT_1' && eTag[3] === 'root',
      "the signal externalId (event id) rides as the NIP-10 ['e', id, '', 'root'] tag - the parent it answers");
    const pTag = ev.tags.find((t) => t[0] === 'p');
    ok(pTag && pTag[1] === 'a'.repeat(64), "the parent author's pubkey rides as the ['p'] tag - routes the reply to the author");
    ok(ev.content === 'happy to help - here is how we handle that', 'the caption is the note content');
    ok(verifyRelayEvent(ev) === true, 'the event id + Schnorr sig VERIFY (the engine\'s own verifier accepts it)');
  }

  // ===== (3) write boundary: source<->platform match =====
  {
    const { validateFieldValues } = await import('../lib/writes.mjs');
    ok(validateFieldValues({ radarReplyTo: { url: 'https://njump.me/e1', source: 'nostr', externalId: 'e1' }, platforms: ['nostr'] }) === null,
      'radarReplyTo source:nostr + platforms:[nostr] validates (nostr is reply-capable now)');
    const mm = validateFieldValues({ radarReplyTo: { url: 'https://njump.me/e1', source: 'nostr', externalId: 'e1' }, platforms: ['mastodon'] });
    ok(mm && mm.code === 'invalid_input', 'a source<->platform mismatch (source:nostr, platforms:[mastodon]) is rejected at the write boundary');
  }

  // ===== (4) scheduler routing: LOCAL nostr-reply lane, never the cloud lane =====
  {
    const { lanesOwed, lanesFor, CLOUD_LANES } = await import('../lib/scheduler.mjs');
    const now = Date.now();
    const past = new Date(now - 60_000).toISOString();

    const reply = { platforms: ['nostr'], scheduledAt: past, radarReplyTo: { source: 'nostr', externalId: 'EV1', url: 'https://njump.me/EV1' }, ids: {} };
    ok(!lanesOwed(reply).includes('nostr'),
      'lanesOwed: a nostr radar reply does NOT owe the shared (cloud) nostr lane - the cloud never fires Radar replies');
    const lanes = lanesFor(reply, now);
    ok(lanes.includes('nostr-reply') && !lanes.includes('nostr'),
      'lanesFor: a due nostr radar reply fires the LOCAL nostr-reply lane, never the cloud nostr lane');
    const future = { ...reply, scheduledAt: new Date(now + 3_600_000).toISOString() };
    ok(!lanesFor(future, now).includes('nostr-reply'),
      'lanesFor: a future-due nostr radar reply does not fire yet (due-gated)');
    const gone = { ...reply, radarReplyState: 'target_gone' };
    ok(!lanesFor(gone, now).includes('nostr-reply'),
      'lanesFor: a target_gone nostr radar reply is NOT re-fired (terminal)');
    const normal = { platforms: ['nostr'], scheduledAt: past, ids: {} };
    ok(lanesOwed(normal).includes('nostr'),
      'lanesOwed: a normal nostr post still owes the shared nostr lane (own notes unaffected)');
    ok(!CLOUD_LANES.includes('nostr-reply'),
      'CLOUD_LANES is untouched - nostr-reply is not a cloud lane');
  }

  // ===== (5) the auto-approve fence holds (byte-unchanged rule) =====
  {
    const { inAutoApproveScope, autoApproveDecision } = await import('../lib/auto-approve.mjs');
    const replyPost = { id: 'r1', platforms: ['nostr'], approval: 'pending', caption: 'a helpful reply', radarReplyTo: { source: 'nostr', externalId: 'EV1' } };
    const scope = inAutoApproveScope(replyPost, { enabled: true, platforms: ['nostr'] }, { id: 'camp' });
    ok(scope.match === false && scope.reason === 'radar_reply_human_only',
      'auto-approve scope: a nostr radarReplyTo post can NEVER match (the field fence covers it untouched)');
    const decision = autoApproveDecision(replyPost, { enabled: true, platforms: ['nostr'] }, { id: 'camp' });
    ok(decision.approve === false,
      'auto-approve decision: refused end to end for the nostr radar reply');
  }

  // ===== (6) mock<->live coherence: the mock driver fires the reply like bluesky =====
  {
    const { runMockCommand } = await import('../lib/drivers/mock-driver.mjs');
    const campDir = path.join(WS, 'data', 'plans', 'nreply');
    fs.mkdirSync(campDir, { recursive: true });
    const planPath = path.join(campDir, 'post-plan.json');
    const base = {
      platforms: ['nostr'], type: 'text', caption: 'a helpful reply', status: 'planned',
      executionMode: 'fully-scheduled', approval: 'approved', approvalBy: 'owner',
      approvalAt: '2026-01-01T00:00:00Z', createdBy: 'agent:claude', scheduledAt: '2020-01-01T00:00:00Z',
    };
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'nostr replies', timezone: 'UTC',
      posts: [
        { id: 'nr1', ...base, radarReplyTo: { source: 'nostr', externalId: 'EV_OK', url: 'https://njump.me/EV_OK' } },
        { id: 'nr2', ...base, radarReplyTo: { source: 'nostr', externalId: 'EV_gone', url: 'https://njump.me/EV_gone' } },
      ],
    }, null, 2));
    const fired = await runMockCommand({ platform: 'nostr', command: 'publish-radar', planPath, only: 'nr1' });
    const row = (fired.results || []).find((r) => r.platform === 'nostr');
    ok(row && row.ok === true && row.radarReply === 'EV_OK', 'mock: the nostr radar reply fires (publish-radar is mockable, the bluesky shape)');
    const saved = JSON.parse(fs.readFileSync(planPath, 'utf8')).posts.find((p) => p.id === 'nr1');
    ok(Boolean(saved.nostrEventId) && saved.status === 'posted', 'mock: the fired reply mints nostrEventId + flips posted (idempotency)');
    const goneRun = await runMockCommand({ platform: 'nostr', command: 'publish-radar', planPath, only: 'nr2' });
    const goneRow = (goneRun.results || []).find((r) => r.platform === 'nostr');
    ok(goneRow && goneRow.ok === false && goneRow.errorCode === 'radar_target_gone', 'mock: a gone target degrades radar_target_gone (terminal), mirroring the live relay-resolve failure');
  }
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}

console.log(`\nradar-nostr-reply: ${pass} checks passed`);
