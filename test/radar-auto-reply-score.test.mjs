#!/usr/bin/env node
// test/radar-auto-reply-score.test.mjs - the SCORE THRESHOLD on the opt-in auto-reply gate (spec C),
// re-pinned after the DECOUPLING (engagement engine, owner decision 2026-08-17):
//
//   - autoReply.minScore gates ONLY the AUTO-APPROVE decision. It no longer refuses drafts at
//     the queue door - that job moved to posting.radar.drafting.minScore (default 30), so a
//     signal above the drafting threshold but below autoReply.minScore queues PENDING for a
//     human and is NEVER auto-approved. Volume changed; autonomy did not.
//   - the auto-approve gate still requires scoredBy==='agent' AND intentScore >= minScore:
//     a regex "Match 16" and an agent's 80 are incommensurable numbers, and auto-posting to a
//     stranger on a number whose meaning changes per row is the footgun the Fable-5 review
//     flagged. Engine-scored and uncached signals never auto-post under a threshold.
//   - minScore UNSET -> the pre-existing auto-approve gate (enabled + lane + fences).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-autoreply-score-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { createCampaign, queueRadarReply, radarIngest } = await import('../lib/writes.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');

const CAMP = 'radar';
const setRadar = (radar) => setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar } } });
const QUERY = { id: 'q1', label: 'q', sources: ['reddit'], keywords: ['schedule', 'scheduler'] };

// Seed ONE signal (agent- or engine-scored) via the real ingest, so queueRadarReply's cached
// lookup finds it with a real scoredBy/intentScore. Returns its {source, ts: new Date().toISOString(), externalId, url}.
let sn = 0;
const seed = async ({ source = 'reddit', score = null, text = 'Can anyone recommend a tool to schedule social posts across Mastodon and Reddit?' } = {}) => {
  sn += 1;
  const externalId = `ext-${sn}`;
  const url = `https://example.com/thread/${sn}`;
  const signal = { source, ts: new Date().toISOString(), externalId, url, author: `u${sn}`, community: 'r/test', text };
  if (score != null) signal.score = score;
  const res = await radarIngest({ queryId: 'q1', signals: [signal], actor: 'agent:claude' });
  assert.ok(res.ok, `ingest ok: ${JSON.stringify(res)}`);
  return { source, ts: new Date().toISOString(), externalId, url };
};
const queue = async (sig, text = 'A genuinely useful, link-free answer to the question asked, no url anywhere.') =>
  queueRadarReply({ campaign: CAMP, signalUrl: sig.url, source: sig.source, externalId: sig.externalId, text, actor: 'agent:claude', confirm: true });

try {
  await createCampaign({ id: CAMP, note: 'radar replies', timezone: 'UTC', actor: 'owner' });

  // ---- threshold UNSET first (a fresh config): pre-existing behavior preserved -------
  // The radar autonomy subtree deep-merges one level (config.mjs), so minScore, once set, can only
  // be changed - not dropped by a partial write. So the "unset" case must run before any is set.
  setRadar({ enabled: true, queries: [QUERY], autoReply: { enabled: true, lanes: ['reddit'] } });
  const legacy = await seed({ score: null });
  ok((await queue(legacy)).approval === 'approved', 'minScore unset -> legacy behavior preserved (enabled+lane auto-approves)');

  // ---- threshold SET to 70, auto-reply on for reddit --------------------------------
  setRadar({ enabled: true, queries: [QUERY], autoReply: { enabled: true, lanes: ['reddit'], minScore: 70 } });

  const hi = await seed({ score: 80 });
  ok((await queue(hi)).approval === 'approved', 'agent-scored 80 >= threshold 70 -> auto-approved');

  // THE DECOUPLING PIN: agent-scored 30 clears the DRAFTING threshold (default 30, inclusive)
  // so it QUEUES - but it is below autoReply.minScore 70, so it lands PENDING for a human and
  // is never auto-approved. Under the old coupling this was refused outright; the owner wants
  // the draft (volume), just not the autonomy.
  const lo = await seed({ score: 30 });
  const loRes = await queue(lo);
  ok(loRes.ok === true && loRes.approval === 'pending',
    'agent-scored 30: above drafting.minScore (30, inclusive) -> DRAFTS; below autoReply.minScore 70 -> PENDING, never auto-approved');

  // The COPY path honors the DRAFTING threshold: a draft is a draft, whether it posts via API
  // or is pasted by hand. 25 < drafting.minScore 30 -> no draft at all.
  const loCopy = await seed({ source: 'hackernews', score: 25 });
  const loCopyRes = await queue(loCopy);
  ok(loCopyRes.code === 'below_threshold' && loCopyRes.ok !== true, 'copy path (hackernews), agent-scored 25 < drafting.minScore 30 -> refused with below_threshold (the drafting door)');
  const hiCopy = await seed({ source: 'hackernews', score: 75 });
  const hiCopyRes = await queue(hiCopy);
  ok(hiCopyRes.ok === true && hiCopyRes.mode === 'copy', 'copy path at/above the threshold still saves the copy-paste suggestion');

  const atThreshold = await seed({ score: 70 });
  ok((await queue(atThreshold)).approval === 'approved', 'agent-scored 70 == threshold 70 -> auto-approved (inclusive)');

  // A regex-scored signal, however high the phrase count, NEVER auto-posts under a threshold.
  const eng = await seed({ score: null, text: 'buffer alternative buffer alternative schedule social posts scheduler recommendation please help' });
  ok((await queue(eng)).approval === 'pending', 'engine-scored signal never auto-approves under a threshold (agent-scored only)');

  // An uncached signal (not in the feed) under a threshold fails closed.
  const orphan = await queueRadarReply({ campaign: CAMP, signalUrl: 'https://example.com/orphan', source: 'reddit', externalId: 'not-seeded', text: 'clean answer', actor: 'agent:claude', confirm: true });
  ok(orphan.approval === 'pending', 'uncached signal under a threshold stays pending (fail-closed)');

  console.log(`\n[radar-auto-reply-score] OK - autoReply.minScore gates the auto-approve decision ONLY (agent score, inclusive, fail-closed for engine-scored/uncached); the draft door belongs to drafting.minScore (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
