#!/usr/bin/env node
// test/radar-config-hygiene.test.mjs - two holes in the posting.radar schema, and the ONE
// migration trap they share.
//
// (1) isRadarQuery enum-checks `cadence` and does NOT enum-check `sources` (it only asks
//     isStringArray). posting.radar is deliberately agent-writable, so `sources:['hacker-news']`
//     - a very plausible typo for 'hackernews' - was accepted, and then:
//       - Radar.jsx renders it raw kebab-case on the query row (a machine key on screen),
//       - SourceCoverage silently drops it (it filters to the known ids),
//       - runRadarScan filters it out of the scan.
//     A query that scans nothing and looks completely fine. Validate it like cadence.
//
// (2) posting.radar.autoScan is orphaned config: everything that READ it was deleted with the
//     cron-recipe generator, but the key, its validator, its defaults and its owner-only entry
//     stayed. RADAR_DEFAULTS re-merges it into every install's read.
//
// THE SHARED TRAP, and why they ship together: the Studio persists the WHOLE radar subtree
// (Radar.jsx persistRadar is a read-modify-write that echoes back what it read). So tightening
// a validator alone would brick every later radar write on any install already carrying the bad
// value - the config would be un-saveable through the UI that shows it. Both fixes therefore
// need the same thing: strip the dead/invalid value on LOAD, so what the caller echoes back is
// already clean.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-cfg-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
const configPath = path.join(WS, 'config.json');

try {
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  const radarOf = () => getConfig().posting.radar;
  const set = (radar) => setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar } } });

  // ===== (1) sources is validated like cadence =====
  const bad = set({ enabled: true, queries: [{ id: 'q1', label: 'x', sources: ['hacker-news'], keywords: ['k'] }] });
  ok(bad.code === 'invalid_input',
    "config_set REFUSES sources:['hacker-news'] - an unknown source is a typo, not a query that silently scans nothing");
  const good = set({ enabled: true, queries: [{ id: 'q1', label: 'x', sources: ['hackernews', 'reddit'], keywords: ['k'] }] });
  ok(good.ok === true, 'a query naming real sources is accepted');
  ok(radarOf().queries[0].sources.join() === 'hackernews,reddit', 'the real sources round-trip intact');

  // ===== (1b) the free-text `brief` field: a string round-trips, a non-string is refused =====
  const withBrief = set({ enabled: true, queries: [{ id: 'q1', label: 'x', brief: 'people asking which scheduler handles Mastodon', sources: ['reddit'] }] });
  ok(withBrief.ok === true, 'a query carrying a free-text brief is accepted');
  ok(radarOf().queries[0].brief === 'people asking which scheduler handles Mastodon', 'the brief round-trips intact');
  const badBrief = set({ enabled: true, queries: [{ id: 'q1', label: 'x', brief: 42, sources: ['reddit'] }] });
  ok(badBrief.code === 'invalid_input', 'config_set REFUSES a non-string brief');

  // ===== (2) autoScan is gone from the schema AND from every read =====
  ok(!('autoScan' in radarOf()), 'a fresh read carries NO autoScan: nothing reads it, so nothing should present it');
  const withAutoScan = set({ autoScan: { enabled: true, cadence: 'daily', maxPerRun: 20 } });
  ok(withAutoScan.code === 'invalid_input', 'config_set REFUSES autoScan: the key is retired, not merely ignored');

  // ===== (3) THE TRAP: a stored config carrying the retired key still works =====
  // This is the whole reason strip-on-load exists. Hand-persist the shape an older build wrote,
  // then do exactly what the Studio does: read the subtree and echo it straight back.
  // config.json stores the posting subtree at its ROOT (radar is a top-level key here).
  const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  stored.radar.autoScan = { enabled: true, cadence: 'weekly', maxPerRun: 20 };
  stored.radar.queries[0].sources = ['reddit', 'hacker-news'];
  fs.writeFileSync(configPath, JSON.stringify(stored, null, 2));

  const legacy = radarOf();
  ok(!('autoScan' in legacy), 'a PERSISTED autoScan is stripped on load, so an old install presents the current shape');
  ok(legacy.queries[0].sources.join() === 'reddit',
    'a persisted unknown source is stripped on load: the config now says what the engine actually scans (it filtered it anyway)');

  // The read-modify-write the Studio performs, verbatim. Before strip-on-load this was the
  // brick: the UI would read a config it could no longer save.
  const echo = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: legacy } } });
  ok(echo.ok === true,
    'echoing the loaded subtree straight back still SAVES - an install carrying legacy values is never bricked by the tighter schema');

  // ===== (4) agent.daily is retired the same way (owner round 3): refused AND stripped =====
  const withDaily = set({ agent: { daily: true } });
  ok(withDaily.code === 'invalid_input', 'config_set REFUSES agent.daily: arming is derived from provider + a daily query, not toggled');
  const storedDaily = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  storedDaily.radar.agent = { provider: '', daily: true, dailyBudget: 1, maxPerRun: 20 };
  fs.writeFileSync(configPath, JSON.stringify(storedDaily, null, 2));
  const legacyAgent = radarOf();
  ok(!('daily' in (legacyAgent.agent || {})), 'a PERSISTED agent.daily is stripped on load (the autoScan precedent)');
  const echoAgent = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: legacyAgent } } });
  ok(echoAgent.ok === true, 'the Studio read-modify-write still saves after the strip - no bricked install');

  // ===== (5) dailyAt: a valid HH:MM round-trips, garbage is refused =====
  const goodAt = set({ dailyAt: '07:30' });
  ok(goodAt.ok === true && radarOf().dailyAt === '07:30', 'dailyAt accepts a valid HH:MM and round-trips');
  ok(set({ dailyAt: '25:00' }).code === 'invalid_input', 'dailyAt refuses an impossible hour');
  ok(set({ dailyAt: 'soonish' }).code === 'invalid_input', 'dailyAt refuses a non-time string');
  ok(radarOf().dailyAt === '07:30', 'a refused dailyAt write leaves the stored value untouched');

  // ===== (6) the refusal message tells the WHOLE truth: it names every allowed radar key =====
  // The old string omitted sources/dailyAt-siblings xEnterprise/geo/autoReply/agent - a caller
  // refused for a typo was handed a shape that itself would be refused for missing keys.
  {
    const refused = set({ nope: true });
    ok(refused.code === 'invalid_input', 'an unknown radar key is refused');
    for (const k of ['enabled', 'competitorsDefault', 'replyVoiceDefault', 'queries', 'sources', 'dailyAt', 'xEnterprise', 'geo', 'brand', 'autoReply', 'agent', 'drafting']) {
      ok(String(refused.message || '').includes(k), `the radar refusal message names '${k}' (honest allowed-key list)`);
    }
  }

  console.log(`[radar-config-hygiene] OK - sources is enum-validated like cadence, the retired autoScan + agent.daily keys are refused and stripped on load, dailyAt is shape-checked, the refusal message names every allowed key, and an install carrying legacy values can still save through the read-modify-write the Studio performs (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
