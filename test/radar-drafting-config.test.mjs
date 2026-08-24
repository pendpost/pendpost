#!/usr/bin/env node
// test/radar-drafting-config.test.mjs - the posting.radar.drafting subtree (engagement
// engine, owner decision 2026-08-17): the DRAFT-volume policy { minScore, maxPerRun },
// decoupled from autoReply (the auto-POST policy).
//
// What this pins, and why each pin exists:
//   (1) the validator: integers in range, no unknown keys, partials accepted;
//   (2) OWNER-ONLY: drafting decides unattended agent volume (the dailyBudget
//       precedent) - an agent must never widen its own draft budget;
//   (3) THE THREE-PLACE MERGE PIN (memory: posting-subtree-shallow-merge-rule): a new
//       object posting.* subtree needs (a) defaults, (b) readPosting's full-shape
//       re-merge, (c) setConfig's nested shallow-merge - and the failure mode is a
//       LATER partial write silently wiping the stored siblings. All three are proven
//       here, including the later-partial-write case that historically broke (20e2430).
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-drafting-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
const configPath = path.join(WS, 'config.json');

try {
  const { getConfig, setConfig, RADAR_OWNER_ONLY_KEYS } = await import('../lib/config.mjs');
  const radarOf = () => getConfig().posting.radar;
  const set = (radar, actor = 'owner') => setConfig({ ifRev: getConfig().rev, actor, set: { posting: { radar } } });

  // ===== (0) defaults: a fresh read presents the full shape =====
  const fresh = radarOf();
  ok(fresh.drafting && fresh.drafting.minScore === 30 && fresh.drafting.maxPerRun === 20,
    'RADAR_DEFAULTS presents drafting { minScore:30, maxPerRun:20 } on a fresh read (generous volume, per owner decision 2)');
  ok(RADAR_OWNER_ONLY_KEYS.includes('drafting'),
    'drafting is in RADAR_OWNER_ONLY_KEYS - unattended volume policy is owner-authorized');

  // ===== (1) the validator =====
  ok(set({ drafting: { minScore: 50 } }).ok === true, 'a partial { minScore } write is accepted');
  ok(set({ drafting: { maxPerRun: 5 } }).ok === true, 'a partial { maxPerRun } write is accepted');
  ok(set({ drafting: {} }).ok === true, 'an empty drafting partial is accepted (a no-op merge)');
  ok(set({ drafting: { minScore: 0, maxPerRun: 1 } }).ok === true, 'the lower bounds (0, 1) are legal');
  ok(set({ drafting: { minScore: 100, maxPerRun: 50 } }).ok === true, 'the upper bounds (100, 50) are legal');
  ok(set({ drafting: { minScore: 101 } }).code === 'invalid_input', 'minScore > 100 is refused');
  ok(set({ drafting: { minScore: -1 } }).code === 'invalid_input', 'minScore < 0 is refused');
  ok(set({ drafting: { minScore: 30.5 } }).code === 'invalid_input', 'a non-integer minScore is refused');
  ok(set({ drafting: { maxPerRun: 0 } }).code === 'invalid_input', 'maxPerRun 0 is refused (a knob that drafts nothing is `minScore:100`, not a zero cap)');
  ok(set({ drafting: { maxPerRun: 51 } }).code === 'invalid_input', 'maxPerRun > 50 is refused (the ingest cap bound, like agent.maxPerRun)');
  ok(set({ drafting: { cadence: 'daily' } }).code === 'invalid_input', 'an unknown drafting key is refused (deliberately NO cadence: drafting is phase 2 of a scan job, a separate clock would silently multiply spend)');
  ok(set({ drafting: [30, 20] }).code === 'invalid_input', 'an array is refused');
  const refusal = set({ drafting: { nope: 1 } });
  ok(String(refusal.message || '').includes('drafting'), 'the radar refusal message names drafting (honest allowed-key list)');

  // ===== (2) owner-only =====
  const agentTry = set({ drafting: { minScore: 0 } }, 'agent:claude');
  ok(agentTry.code === 'invalid_input' && String(agentTry.message || '').includes('drafting'),
    'a NON-owner actor writing drafting is refused by name - an agent can never widen its own draft volume');
  const agentOther = set({ enabled: true }, 'agent:claude');
  ok(agentOther.ok === true, 'the same agent may still write the non-autonomy radar keys (enabled) - the gate is surgical');

  // ===== (3) THE THREE-PLACE MERGE PIN =====
  // Reset to a known state: owner sets minScore 50 (leaving maxPerRun to ride along from
  // the earlier writes), then verify each merge place in turn.
  ok(set({ drafting: { minScore: 50, maxPerRun: 20 } }).ok === true, 'owner seeds drafting { minScore:50, maxPerRun:20 }');

  // (3a) a LATER partial radar write must NOT wipe the stored drafting subtree. This is the
  // exact failure class of 20e2430: the write path replaces posting.radar wholesale unless
  // the subtree has an explicit shallow-merge branch, and readPosting's defaults re-merge
  // then silently resets the wiped keys - so the bug is invisible until a later read.
  ok(set({ enabled: true }).ok === true, 'a LATER partial { enabled } write succeeds');
  ok(radarOf().drafting.minScore === 50 && radarOf().drafting.maxPerRun === 20,
    'the later partial radar write did NOT wipe drafting (the setConfig radar-level spread preserves absent keys)');

  // (3b) a partial drafting write must NOT wipe its sibling key (the nested merge).
  ok(set({ drafting: { minScore: 40 } }).ok === true, 'a partial { drafting:{ minScore } } write succeeds');
  ok(radarOf().drafting.minScore === 40 && radarOf().drafting.maxPerRun === 20,
    'the partial drafting write did NOT wipe maxPerRun (setConfig recurses into owner-only object subtrees)');
  ok(set({ drafting: { maxPerRun: 7 } }).ok === true, 'a partial { drafting:{ maxPerRun } } write succeeds');
  ok(radarOf().drafting.minScore === 40 && radarOf().drafting.maxPerRun === 7,
    'and the reverse partial preserves minScore');

  // (3c) readPosting presents the FULL shape from a PARTIAL store: hand-persist what an
  // older build (or a hand edit) might hold - drafting with only one key - and read it back.
  const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  stored.radar.drafting = { minScore: 65 };
  fs.writeFileSync(configPath, JSON.stringify(stored, null, 2));
  const partial = radarOf();
  ok(partial.drafting.minScore === 65 && partial.drafting.maxPerRun === 20,
    'readPosting re-merges a PARTIAL persisted drafting onto the defaults - a reader never sees maxPerRun undefined');

  // The Studio read-modify-write echo still saves (the no-bricked-install rule).
  const echo = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: partial } } });
  ok(echo.ok === true, 'echoing the loaded subtree straight back still SAVES');

  console.log(`[radar-drafting-config] OK - drafting { minScore, maxPerRun } validated, owner-only, and merged in all three places incl. the later-partial-write-keeps-siblings pin (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
