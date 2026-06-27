#!/usr/bin/env node
// test/setup-status.test.mjs - the machine-readable SETUP-COMPLETENESS signal that
// drives agent-onboarding + the dashboard Setup page. Proves: per-platform
// connected|skipped|incomplete derivation, the missing-inputs + CLI connectAction
// (secret = CLI ceremony, never a config write), the explicit-skip state via
// config_set, and that pendpost_health carries setup while overview/preview omits it.
//
// UNIT 1 (C1): on top of status, every platform now carries a nested VALIDATION
// derived from the last liveness probe (state.health.<p>.live) - state is one of
// live|failed|unproven|skipped|blocked, and `ready` is now LIVE-GATED (every lane
// must be validation.state==='live' OR status==='skipped', not merely connected).
// validation is DERIVED, never persisted; summary.validated counts the live lanes.
//
// Creds are simulated by writing .env directly (= the output of the CLI ceremony);
// probe rows are injected straight into state.json (= the output of probeAll, which
// we never spawn here); skip/locale go through the REAL config_set path an agent
// would use. readEnv reads .env fresh each call, so mutating it mid-test is honoured.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-setup-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));

const { setupStatus } = await import('../lib/setup.mjs');
const { pendpostHealth, getConfig, setConfig } = await import('../lib/writes.mjs').then(async (w) => ({
  pendpostHealth: w.pendpostHealth,
  ...(await import('../lib/config.mjs')),
}));
const { loadState, saveState, recordMetaBlock } = await import('../lib/state.mjs').then(async (st) => ({
  loadState: st.loadState,
  saveState: st.saveState,
  ...(await import('../lib/accounts.mjs')),
}));

const setEnv = (lines) => fs.writeFileSync(path.join(WS, '.env'), lines.join('\n') + '\n', { mode: 0o600 });
const skip = (arr) => {
  const r = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { skippedPlatforms: arr } } });
  assert.ok(r.ok, `setConfig skip: ${JSON.stringify(r)}`);
};
// Inject a probe row exactly as probeAll/sanitizeHealthRow would persist it (no
// engine spawn): state.health.<p> = { ok, detail?, checkedAt }.
const setHealth = (platform, row) => {
  const state = loadState();
  state.health = state.health || {};
  state.health[platform] = { checkedAt: new Date().toISOString(), ...row };
  saveState();
};
const clearHealth = () => {
  const state = loadState();
  delete state.health;
  saveState();
};
const byPlatform = (s) => Object.fromEntries(s.platforms.map((p) => [p.platform, p]));

try {
  // ===== (1) nothing configured -> all four incomplete, every validation unproven =====
  let s = setupStatus();
  ok(s.ready === false, 'a fresh instance is not ready (nothing connected or skipped)');
  ok(s.summary.incomplete === 4 && s.summary.total === 4, 'all four platforms start incomplete');
  ok(s.summary.validated === 0, 'summary.validated is 0 with no live lane');
  const meta0 = byPlatform(s).meta;
  ok(meta0.status === 'incomplete', 'meta starts incomplete');
  ok(meta0.missing.some((m) => m.kind === 'identifier' && m.key === 'metaPageId'), 'meta lists its missing Page ID identifier (agent fills via config_set)');
  const metaSecret = meta0.missing.find((m) => m.kind === 'secret');
  ok(metaSecret && /setup-system-user/.test(metaSecret.action), 'meta lists its missing secret with the exact CLI connectAction (never a config write)');
  // PENDPOST_MODE=mock with NO creds -> EVERY validation.state is 'unproven', never 'failed'.
  ok(s.platforms.every((p) => p.validation && p.validation.state === 'unproven'), 'mock + no creds: every validation.state is unproven (no/partial/forced-mock is NEVER failed)');
  ok(meta0.validation.fix && /setup-system-user/.test(meta0.validation.fix), 'an unproven lane with no credential points its fix at the connectAction');

  // ===== (2) a credential present (simulated CLI ceremony) -> connected, but still UNPROVEN until probed =====
  setEnv(['LINKEDIN_ACCESS_TOKEN=ey_fake_li_token', 'LINKEDIN_ORG_URN=urn:li:organization:1']);
  s = setupStatus();
  ok(byPlatform(s).linkedin.status === 'connected', 'LinkedIn becomes connected once its access token is present');
  ok(byPlatform(s).linkedin.validation.state === 'unproven', 'present-but-unprobed credential is unproven (connected does not imply live)');
  ok(s.ready === false, 'a connected-but-unproven lane keeps the instance not-ready (live-gated)');
  ok(s.summary.connected === 1 && s.summary.incomplete === 3, 'summary reflects 1 connected, 3 incomplete');
  ok(s.summary.validated === 0, 'summary.validated stays 0 while the only credentialed lane is unproven');

  // ===== (3) inject a passing probe row -> validation.state live; validated counts it =====
  setHealth('linkedin', { ok: true });
  s = setupStatus();
  ok(byPlatform(s).linkedin.validation.state === 'live', 'a recorded {ok:true} probe + creds promotes the lane to live');
  ok(byPlatform(s).linkedin.validation.ok === true, 'validation.ok mirrors the live probe by reference');
  ok(s.summary.validated === 1, 'summary.validated counts the one live lane');

  // ===== (4) a failing probe row + creds -> validation.state failed, fix names a re-run =====
  setHealth('linkedin', { ok: false, detail: 'Token inactive' });
  s = setupStatus();
  const liFail = byPlatform(s).linkedin;
  ok(liFail.validation.state === 'failed', 'creds present + {ok:false} probe is failed (only reachable WITH creds)');
  ok(s.ready === false, 'a failed lane is not ready');
  ok(/re-run/.test(liFail.validation.fix) && /linkedin-social\.mjs auth/.test(liFail.validation.fix), 'a failed lane fix names a re-run of the connectAction');
  ok(liFail.validation.detail === 'Token inactive', 'validation.detail mirrors the probe detail by reference');

  // ===== (5) explicit skip via config_set -> skipped, not incomplete; validation.state skipped =====
  setHealth('linkedin', { ok: true }); // restore a live linkedin lane
  skip(['x', 'youtube']);
  s = setupStatus();
  ok(byPlatform(s).x.status === 'skipped' && byPlatform(s).youtube.status === 'skipped', 'config_set skippedPlatforms marks x + youtube as skipped');
  ok(byPlatform(s).x.validation.state === 'skipped' && byPlatform(s).youtube.validation.state === 'skipped', 'a skipped lane has validation.state skipped (and a null fix)');
  ok(byPlatform(s).x.validation.fix === null, 'a skipped lane carries no fix');
  ok(byPlatform(s).meta.status === 'incomplete', 'meta (no creds, not skipped) stays incomplete');
  ok(s.ready === false, 'not ready while meta is still unproven');
  ok(s.summary.connected === 1 && s.summary.skipped === 2 && s.summary.incomplete === 1, 'summary: 1 connected, 2 skipped, 1 incomplete');

  // ===== (6) connect + PROVE the last lane -> ready (every lane live-or-skipped) =====
  setEnv(['LINKEDIN_ACCESS_TOKEN=ey_fake_li_token', 'LINKEDIN_ORG_URN=urn:li:organization:1', 'META_PAGE_TOKEN=fake_page_token', 'META_PAGE_ID=12345']);
  setHealth('linkedin', { ok: true });
  setHealth('meta', { ok: true });
  s = setupStatus();
  ok(byPlatform(s).meta.status === 'connected', 'meta connects once page token + id are present');
  ok(byPlatform(s).meta.validation.state === 'live', 'meta is live once its probe passes');
  ok(s.ready === true, 'ready once every lane is live or skipped');
  ok(s.summary.incomplete === 0, 'no platform left incomplete');
  ok(s.summary.validated === 2, 'summary.validated counts both live lanes');

  // connected-but-unproven keeps ready false even with no incomplete lanes
  clearHealth();
  ok(setupStatus().ready === false, 'clearing the probe rows drops ready back to false (connected != ready)');
  setHealth('linkedin', { ok: true });
  setHealth('meta', { ok: true });

  // a connected platform ignores a stale skip flag (never hides a live lane)
  skip(['meta', 'x', 'youtube']);
  ok(byPlatform(setupStatus()).meta.status === 'connected', 'a connected platform is never shown as skipped even if listed in skippedPlatforms');

  // ===== (7) only X_API_KEY set (partial creds) -> x stays unproven, never failed =====
  setEnv(['LINKEDIN_ACCESS_TOKEN=ey_fake_li_token', 'LINKEDIN_ORG_URN=urn:li:organization:1', 'META_PAGE_TOKEN=fake_page_token', 'META_PAGE_ID=12345', 'X_API_KEY=just_a_key']);
  skip([]); // unskip x so its own derivation shows
  s = setupStatus();
  ok(byPlatform(s).x.validation.state === 'unproven', 'a partial X credential (only X_API_KEY) is unproven, never failed');

  // ===== (8) a recorded Meta-368 block -> meta validation.state blocked, regardless of a prior ok probe =====
  setHealth('meta', { ok: true }); // even with a passing probe on record...
  const blk = recordMetaBlock({ blockedUntil: '2099-01-01T00:00:00.000Z', reason: 'integrity 368', source: 'test', actor: 'owner' });
  assert.ok(blk.ok, `recordMetaBlock: ${JSON.stringify(blk)}`);
  s = setupStatus();
  ok(byPlatform(s).meta.validation.state === 'blocked', 'a recorded Meta-368 block forces meta validation.state to blocked (over any prior ok probe)');
  ok(/action block/.test(byPlatform(s).meta.validation.fix), 'a blocked meta lane fixes via clearing the Meta action block');
  ok(s.ready === false, 'a blocked meta lane keeps the instance not-ready');
  recordMetaBlock({ blockedUntil: null, source: 'test', actor: 'owner' }); // clear for any later assertions

  // ===== (9) pendpost_health carries setup; overview/preview omit it =====
  const sh = pendpostHealth();
  ok(sh.setup && Array.isArray(sh.setup.platforms) && sh.setup.platforms.length === 4, 'pendpost_health embeds the setup breakdown for the agent + UI');
  ok(pendpostHealth({ includeSetup: false }).setup === undefined, 'the includeSetup:false path (overview/preview) omits the setup compute');

  // ===== (10) config_set validates skippedPlatforms shape =====
  const bad = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { skippedPlatforms: 'x' } } });
  ok(bad && bad.code === 'invalid_input', 'a non-array skippedPlatforms is rejected (invalid_input)');

  console.log(`[setup-status] OK - per-platform status + nested validation (live|failed|unproven|skipped|blocked), live-gated ready, summary.validated, missing+CLI action, config_set skip, pendpost_health embed (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
