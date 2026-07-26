#!/usr/bin/env node
// test/radar-reply-context.test.mjs - a queued Radar reply must carry the thread it answers.
//
// The gap this closes: radarReplyTo was { url, source, externalId } only. That is enough to
// FIRE the reply and enough to join it back to its signal, but it is not enough to READ it.
// The approvals surface could show the draft and nothing about the question being answered,
// so the operator was asked to approve a reply to a thread they could not see. The only
// affordance was the raw permalink, and only if they thought to open it.
//
// The snapshot is taken SERVER-SIDE from the cached signal (state.radar.signals), keyed by
// the source+externalId the caller already supplies. That choice matters three ways:
//   - no API/MCP parameter grows, so an agent calling radar_queue_reply gets the context free,
//   - the context cannot be fabricated by the caller: it is whatever the scan/ingest recorded,
//   - it is a COPY, so it survives the 30-day signal prune (radar.mjs RADAR_RETENTION_DAYS)
//     and needs no cross-store read at render time.
//
// It is display-only text, never an address: the reply still fires at radarReplyTo.externalId,
// so a stale excerpt can never mis-target a reply the way a stale ID could.
//
// Zero-dep node:assert. Mirrors test/radar-ingest.test.mjs's harness.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-reply-context-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const QUERY = { id: 'q1', label: 'coaching', sources: ['reddit', 'hackernews', 'bluesky', 'mastodon'], keywords: ['coach'], competitors: [], minScore: 0 };
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ radar: { enabled: true, queries: [QUERY] } }));

// A real-shaped question, longer than the excerpt cap, so truncation is exercised.
const LONG_Q = 'Looking for an ADHD coach for women if possible. I have reached out to around eight potential coaches and have three favourites but I am overwhelmed how to choose. '.repeat(6);

try {
  const { radarIngest, queueRadarReply, createCampaign } = await import('../lib/writes.mjs');
  const { loadPlanStore } = await import('../lib/plans.mjs');
  const { RADAR_EXCERPT_MAX } = await import('../lib/radar.mjs');
  await createCampaign({ id: 'ctx', note: 'radar replies', timezone: 'UTC', actor: 'owner' });
  const getPost = (id) => (loadPlanStore().campaigns.find((c) => c.id === 'ctx')?.posts || []).find((p) => p.id === id);

  // Seed one signal exactly the way bondigoo's real feed was seeded: an agent submitted it.
  const ing = await radarIngest({
    actor: 'agent:claude',
    queryId: 'q1',
    signals: [{
      source: 'reddit', externalId: 't3_ctx', url: 'https://reddit.com/r/askswitzerland/comments/ctx/x',
      author: 'WorthObjective6266', community: 'askswitzerland', text: LONG_Q, ts: new Date().toISOString(),
    }],
  });
  ok(ing.ok && ing.accepted === 1, 'seeded one ingested reddit signal carrying author + community + text');

  // ===== (1) the snapshot rides the queued reply =====
  const q = await queueRadarReply({
    campaign: 'ctx', signalUrl: 'https://reddit.com/r/askswitzerland/comments/ctx/x',
    source: 'reddit', externalId: 't3_ctx', text: 'a few things that helped me choose', actor: 'agent:radar', confirm: true,
  });
  ok(q.ok, 'queueRadarReply queued the reply');
  const rr = getPost(q.postId).radarReplyTo;
  ok(rr.author === 'WorthObjective6266', 'radarReplyTo carries the author of the thread being answered');
  ok(rr.community === 'askswitzerland', 'radarReplyTo carries the community the thread lives in');
  ok(typeof rr.excerpt === 'string' && rr.excerpt.startsWith('Looking for an ADHD coach'),
    'radarReplyTo carries an excerpt of the question, so the approver can read what is being answered');
  ok(rr.excerpt.length <= RADAR_EXCERPT_MAX,
    `the excerpt is bounded at ${RADAR_EXCERPT_MAX} chars (a snapshot, not a copy of the whole thread)`);
  ok(rr.url === 'https://reddit.com/r/askswitzerland/comments/ctx/x' && rr.externalId === 't3_ctx' && rr.source === 'reddit',
    'the addressing fields are untouched: the reply still fires at the same target');

  // ===== (2) no cached signal -> NO context, never an invented one =====
  const orphan = await queueRadarReply({
    campaign: 'ctx', signalUrl: 'https://reddit.com/r/x/comments/gone/y',
    source: 'reddit', externalId: 't3_notinfeed', text: 'still a valid reply', actor: 'agent:radar', confirm: true,
  });
  ok(orphan.ok, 'a reply to a signal that is not in the feed still queues (the cache is not a gate)');
  const orr = getPost(orphan.postId).radarReplyTo;
  ok(orr.author === undefined && orr.community === undefined && orr.excerpt === undefined,
    'an uncached signal yields NO author/community/excerpt: the surface renders the link only, never a fabricated quote');
  ok(orr.url === 'https://reddit.com/r/x/comments/gone/y' && orr.externalId === 't3_notinfeed',
    'the uncached reply keeps its addressing fields and remains firable');

  console.log(`[radar-reply-context] OK - a queued reply snapshots its thread's author/community/excerpt from the cached signal, bounded and display-only, and renders link-only rather than inventing context when the signal is unknown (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
