#!/usr/bin/env node
// test/radar-x-enterprise.test.mjs - the owner-declared X Enterprise flag (owner round 3,
// point 6). Since Feb 2026 X refuses API replies to strangers below the Enterprise tier,
// and exposes NO API to detect the tier - so posting.radar.xEnterprise is a declaration,
// not a probe. Proofs:
//   (a) default OFF: an x answer travels the copy path (draft ON the signal, no plan post);
//   (b) the flag is owner-only - an agent cannot widen its own autonomy;
//   (c) flag ON: x flips into the real reply lane - a PENDING plan post in a campaign,
//       exactly like reddit/mastodon/bluesky - and the effective capability table says so;
//   (d) auto-reply on x fails CLOSED without the flag, even with lanes:['x'] stored -
//       a stale lane must never fire into a guaranteed 403.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-x-enterprise-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { createCampaign, queueRadarReply, radarIngest, listRadar } = await import('../lib/writes.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');
const { effectiveRadarCapabilities, radarReplySources, radarCopyDraftSources } = await import('../lib/radar.mjs');

const CAMP = 'radar';
const setRadar = (radar, actor = 'owner') => setConfig({ ifRev: getConfig().rev, actor, set: { posting: { radar } } });

let sn = 0;
const seed = async ({ score = 80 } = {}) => {
  sn += 1;
  const externalId = `19${sn}0000000000000`;
  const url = `https://x.com/someone/status/${externalId}`;
  const res = await radarIngest({ queryId: 'q1', signals: [{ source: 'x', ts: new Date().toISOString(), externalId, url, author: 'stranger', text: 'What is a good Buffer alternative?', score }], actor: 'agent:claude' });
  assert.ok(res.ok, `ingest ok: ${JSON.stringify(res)}`);
  return { externalId, url };
};
const queue = (sig) => queueRadarReply({ campaign: CAMP, signalUrl: sig.url, source: 'x', externalId: sig.externalId, text: 'A useful link-free answer.', actor: 'agent:claude', confirm: true });

try {
  await createCampaign({ id: CAMP, note: 'radar replies', timezone: 'UTC', actor: 'owner' });
  const on = setRadar({ enabled: true, queries: [{ id: 'q1', label: 'q', sources: ['reddit'], keywords: ['alternative'] }] });
  assert.ok(on.ok, JSON.stringify(on));

  // ---- (a) default OFF: copy path ----
  ok(effectiveRadarCapabilities({}).x.reply === false && effectiveRadarCapabilities({}).x.copyDraft === true, '(a) without the flag the effective table keeps x as copy-draft');
  const s1 = await seed();
  const r1 = await queue(s1);
  ok(r1.ok === true && r1.mode === 'copy' && r1.approval === null, '(a) default: an x answer is a copy-paste suggestion, never a plan post');

  // ---- (b) owner-only ----
  const sneaky = setRadar({ xEnterprise: true }, 'agent:claude');
  ok(sneaky.ok !== true && /only the owner/.test(sneaky.message || ''), '(b) an AGENT cannot declare Enterprise for itself (autonomy stays owner-authorized)');
  ok(setRadar({ xEnterprise: 'yes' }).ok !== true, '(b) the flag is a boolean, shape-checked at the door');

  // ---- (c) flag ON: the real reply lane ----
  const flip = setRadar({ xEnterprise: true });
  assert.ok(flip.ok, JSON.stringify(flip));
  const radarCfg = { xEnterprise: true };
  ok(effectiveRadarCapabilities(radarCfg).x.reply === true && effectiveRadarCapabilities(radarCfg).x.copyDraft === false, '(c) with the flag the effective table flips x into the reply lane');
  ok(radarReplySources(radarCfg).includes('x') && !radarCopyDraftSources(radarCfg).includes('x'), '(c) the derived source sets follow');
  const s2 = await seed();
  const r2 = await queue(s2);
  ok(r2.ok === true && r2.approval === 'pending' && r2.postId, '(c) an x answer now queues a PENDING reply post in the campaign, like any reply lane');
  const feed = await listRadar({});
  ok(feed.capabilities.x.reply === true, '(c) listRadar ships the per-client effective capability table to the panel');

  // ---- (d) auto-reply fails closed without the flag ----
  const arm = setRadar({ xEnterprise: false, autoReply: { enabled: true, lanes: ['x'], requireLintClean: true } });
  assert.ok(arm.ok, JSON.stringify(arm));
  ok(getConfig().posting.radar.autoReply.lanes.includes('x'), "(d) lanes:['x'] is shape-valid (the stored policy survives)");
  const s3 = await seed();
  const r3 = await queue(s3);
  // Flag off again => x is BACK on the copy path; nothing can auto-fire (copy drafts never post).
  ok(r3.ok === true && r3.mode === 'copy', '(d) with the flag off, even an armed x lane yields only a copy draft - fail closed, no 403 in the queue');

  console.log(`\n[radar-x-enterprise] OK - owner-declared flag flips x copy-draft -> reply lane; agents cannot set it; stale lanes fail closed (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
