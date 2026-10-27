#!/usr/bin/env node
// test/config-hold.test.mjs - nothing publishes on guessed settings (owner decision 2026-10-14).
//
// When a client's config.json EXISTS but cannot be read or parsed (EMFILE under a request
// burst, EACCES, a half-written or invalid file), getPosting used to fall back to the defaults,
// and REVIEW_DEFAULTS.required is false: the client sign-off fence (spec 48 R10) failed OPEN,
// so an owner-approved post still awaiting the client's sign-off became publish-eligible.
//
// Pinned here:
//   (1) the local firing path (runDueExclusive: the tick, Check now, the MCP due-runner) refuses
//       with config_unreadable and fires NOTHING while config.json will not parse; the same run
//       on develop before this change fired the post awaiting sign-off,
//   (2) a transient read failure after a good read serves the LAST GOOD config, never the
//       defaults (so a getPosting deep inside a run cannot flip the fence either),
//   (2b) while the file is unreadable every AUTONOMY switch (engage autopilot, auto-approve,
//       daily agent scans, metered reads) reads closed, even though the rest is last-good,
//   (3) an ABSENT config.json is not a hold (a fresh client, or one deleted to reset it, runs on
//       the defaults by design), but a dangling symlink or wrong-shape JSON is,
//   (3b) setConfig refuses while the file exists but will not read, so a Studio or agent save
//       never overwrites the owner's half-finished hand-edit with the last good copy,
//   (4) the health check names the hold (blocker.config),
//   (5) the cloud push refuses with config_unreadable and sends no job,
//   (6) the hold lifts by itself once the file reads again.
//
// Mock mode + a mocked global.fetch; no network, no real cloud. Fresh temp PENDPOST_ROOT.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-config-hold-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n');
const CFG = path.join(WS, 'config.json');
// Two-step sign-off ON: an owner-approved post awaits the client and must NOT fire.
// Autonomy ON too (engage live, auto-approve, daily agent scans, metered reads), so (2b) can prove
// an unreadable file closes every switch that lets pendpost act or spend on its own.
const GOOD = JSON.stringify({
  review: { required: true },
  autoApprove: { enabled: true, platforms: ['instagram'] },
  radar: { enabled: true, dailyEnabled: true, engage: { mode: 'live' } },
  insights: { meteredAuto: ['x'] },
}, null, 2);
fs.writeFileSync(CFG, GOOD);
let bump = 0;
const touch = () => { bump += 10; const t = new Date(Date.now() + bump * 1000); fs.utimesSync(CFG, t, t); };
const corrupt = () => { fs.writeFileSync(CFG, '{ "review": { "required": tr'); touch(); };
const restore = () => { fs.writeFileSync(CFG, GOOD); touch(); };

const { createCampaign, createPost, approvePost, pendpostHealth } = await import('../lib/writes.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { getPosting, postingConfigError } = await import('../lib/config.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');
const { withClient } = await import('../lib/context.mjs');
const cloud = await import('../lib/cloud-client.mjs');
const { setCloudEnabled } = await import('../lib/cloud-config.mjs');

const CAMP = 'hold';
const postNow = () => loadPlanStore().campaigns.find((c) => c.id === CAMP).posts.find((p) => p.id === 'awaiting');
const fired = (p) => p.status === 'posted' || (p.attempts || []).length > 0 || Object.values(p.ids || {}).some((v) => typeof v === 'string' && v !== '');

await createCampaign({ id: CAMP, note: 'hold', timezone: 'UTC', actor: 'owner' });
await createPost({ campaign: CAMP, post: { id: 'awaiting', type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'awaits the client' }, actor: 'agent:a' });
await approvePost({ campaign: CAMP, postId: 'awaiting', actor: 'owner' });
ok(postNow().reviewPending === true, 'baseline: the owner-approved post awaits the client sign-off');
ok(postingConfigError() === null, 'baseline: a readable config.json is no hold');

// ---- (1) the local firing path holds ------------------------------------------------
corrupt();
ok(/cannot be read/.test(postingConfigError() || ''), `an unparseable config.json is a hold (${postingConfigError()})`);
const run = await runDueExclusive('test');
ok(run.ok === false && run.code === 'config_unreadable', `runDueExclusive refuses with config_unreadable (${run.code})`);
ok(!fired(postNow()), 'the post awaiting client sign-off did NOT fire on guessed settings');

// ---- (2) a read failure serves the LAST GOOD config, never the defaults ---------------
ok(getPosting().review.required === true, 'while config.json is unparseable, getPosting serves the last good config (review.required stays ON)');
// ---- (2b) ...but every AUTONOMY switch reads closed (critic round 4) ----------------------
{
  const g = getPosting();
  ok(g.radar.engage.mode === 'off', 'the engage autopilot reads OFF while the file is unreadable (no live likes/replies/follows on stale settings)');
  ok(g.autoApprove.enabled === false && g.autoApprove.radarReplies.enabled === false, 'auto-approve reads OFF while the file is unreadable');
  ok(g.radar.dailyEnabled === false && g.insights.meteredAuto.length === 0, 'the daily agent scan and metered reads read OFF while the file is unreadable');
}
restore();
ok(getPosting().review.required === true && getPosting().radar.engage.mode === 'live', 'restored config reads normally, autonomy included');
const realRead = fs.readFileSync;
let failing = true;
fs.readFileSync = (f, ...rest) => {
  if (failing && String(f) === CFG) throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
  return realRead(f, ...rest);
};
try {
  touch(); // force a cache miss so the failing read is actually attempted
  ok(getPosting().review.required === true, 'a transient EMFILE serves the last good config, not review.required=false');
  ok(/EMFILE/.test(postingConfigError() || ''), 'and the transient failure is a hold for that moment');
  failing = false;
} finally {
  fs.readFileSync = realRead;
}
ok(postingConfigError() === null, 'the hold lifts on the very next good read');

// ---- (3) absent vs vanished vs broken -----------------------------------------------------
const FRESH = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-config-fresh-'));
ok(withClient(FRESH, () => postingConfigError()) === null, 'a client that never had a config.json is no hold (a fresh client runs on the defaults)');
fs.symlinkSync(path.join(FRESH, 'nowhere.json'), path.join(FRESH, 'config.json'));
ok(/cannot be read/.test(withClient(FRESH, () => postingConfigError()) || ''), 'a dangling config.json symlink is a broken config (a hold), not an absent one');
fs.rmSync(path.join(FRESH, 'config.json'));
fs.writeFileSync(path.join(FRESH, 'config.json'), '[]');
ok(/not a JSON object/.test(withClient(FRESH, () => postingConfigError()) || ''), 'valid JSON of the wrong shape ([]) is a hold, never "all defaults"');
fs.rmSync(FRESH, { recursive: true, force: true });
fs.renameSync(CFG, `${CFG}.away`);
ok(postingConfigError() === null && getPosting().review.required !== true, 'a config.json DELETED (to reset it) runs on the defaults, no hold: only a file that exists but will not read holds');
fs.renameSync(`${CFG}.away`, CFG);
touch();
ok(getPosting().review.required === true, 'and it reads again when it is back');

// ---- (3b) no save over an unreadable file ------------------------------------------------
{
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const rev = getConfig().rev;
  corrupt();
  const broken = fs.readFileSync(CFG, 'utf8');
  const res = setConfig({ ifRev: rev, actor: 'owner', set: { posting: { locale: 'de-CH' } } });
  ok(res.code === 'config_unreadable', `setConfig refuses while config.json will not read (${res.code})`);
  ok(fs.readFileSync(CFG, 'utf8') === broken, "and the owner's half-finished file is left exactly as it was");
  restore();
}

// ---- (4) the health check names the hold -----------------------------------------------
corrupt();
const health = pendpostHealth({ horizon: 5 });
ok((health.blockerCodes || []).some((b) => b.code === 'blocker.config'), 'pendpost_health carries blocker.config while held');
ok(health.ready === false, 'and the client does not read as ready');

// ---- (5) the cloud push holds and sends nothing ------------------------------------------
const calls = [];
global.fetch = async (input, opts = {}) => {
  const url = String(input);
  calls.push(url);
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (url.endsWith('/v1/health')) return json({ ok: true });
  if (url.endsWith('/v1/sync/push')) return json({ accepted: [], refused: [] });
  return json({ alreadyPresent: true, key: 'k' });
};
restore();
await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
setCloudEnabled(true);
corrupt();
calls.length = 0;
await assert.rejects(() => cloud.pushApprovedJobs(), (e) => e.name === 'CloudError' && e.code === 'config_unreadable');
ok(true, 'pushApprovedJobs refuses with config_unreadable');
ok(!calls.some((u) => u.endsWith('/v1/sync/push')), 'no job reached the cloud while held');

// ---- (6) the hold lifts by itself ------------------------------------------------------
restore();
setCloudEnabled(false);
const after = await runDueExclusive('test');
ok(after.code !== 'config_unreadable', `once config.json reads again, a publish run is no longer held (${after.code || 'ok'})`);
ok(!fired(postNow()), 'and the post awaiting client sign-off still does not fire (the fence is back ON, not guessed)');

fs.rmSync(WS, { recursive: true, force: true });
console.log(`\nconfig-hold: ${pass} checks passed`);
