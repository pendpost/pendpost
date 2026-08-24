#!/usr/bin/env node
// test/radar-next-scan.test.mjs - nextScan + lastProduced on the listRadar tail
// (engagement engine): "when does the next scan run and what did the last one produce?"
//
// The load-bearing pin is THE AGREEMENT PROPERTY between nextDueDailyAt (the forward
// clock the panel renders) and dueDailyAt (the real gate the scheduler ticks): for any
// (lastIso, dailyAt, tz, now), whenever next > now,
//     dueDailyAt(last, at, tz, next)          is TRUE   (the gate opens at the claimed time)
//     dueDailyAt(last, at, tz, next - 60s)    is FALSE  (and not one tick earlier)
// - so however either side is implemented, the claim and the behaviour cannot drift.
// Plus: the closed-form branch cases, the bad-tz fallback, and the exact response shape.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-next-scan-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

try {
  const { dueDailyAt, nextDueDailyAt } = await import('../lib/radar-sweep.mjs');
  const MIN = 60_000;
  const DAY = 24 * 3600 * 1000;

  // ===== (1) THE AGREEMENT PROPERTY, over a varied grid =====
  // now values across days-of-week/times incl. odd minutes; stamps absent/old/today/just-now;
  // dailyAt early/late/midnight; tz east/west/UTC.
  const nows = [
    Date.parse('2026-08-17T06:30:00Z'), Date.parse('2026-08-17T12:00:00Z'),
    Date.parse('2026-08-17T23:59:00Z'), Date.parse('2026-01-01T00:00:00Z'),
    Date.parse('2026-03-29T01:30:00Z'), // European DST-spring boundary day
  ];
  const dailyAts = ['09:00', '00:00', '23:30', '07:15'];
  const tzs = ['UTC', 'Europe/Zurich', 'America/Los_Angeles', 'Asia/Tokyo'];
  const lastOffsets = [null, -3 * DAY, -26 * 3600 * 1000, -2 * 3600 * 1000, -10 * MIN];
  let checked = 0;
  for (const now of nows) for (const at of dailyAts) for (const tz of tzs) for (const off of lastOffsets) {
    const last = off == null ? null : new Date(now + off).toISOString();
    const nextIso = nextDueDailyAt(last, at, tz, now);
    const next = Date.parse(nextIso);
    assert.ok(Number.isFinite(next), `nextDueDailyAt returns a parseable ISO (${nextIso})`);
    assert.ok(next >= now, `next is never in the past (at=${at} tz=${tz} off=${off}: ${nextIso})`);
    assert.ok(next <= now + 2 * DAY, 'next is within 48h - the gate opens at least daily');
    if (next > now) {
      assert.ok(dueDailyAt(last, at, tz, next) === true,
        `AGREEMENT: the gate OPENS at the claimed time (now=${new Date(now).toISOString()} at=${at} tz=${tz} off=${off} -> ${nextIso})`);
      assert.ok(dueDailyAt(last, at, tz, next - MIN) === false,
        `AGREEMENT: and not one tick earlier (now=${new Date(now).toISOString()} at=${at} tz=${tz} off=${off} -> ${nextIso})`);
    } else {
      // next === now: the gate is open RIGHT NOW - the honest "fires on the next tick".
      assert.ok(dueDailyAt(last, at, tz, now) === true, 'next==now only when the gate is open right now');
    }
    checked += 1;
  }
  ok(checked === nows.length * dailyAts.length * tzs.length * lastOffsets.length,
    `agreement property holds across ${checked} (now, dailyAt, tz, last) combinations`);

  // ===== (2) the closed-form branch cases =====
  // Before dailyAt today, nothing stamped -> today's dailyAt.
  {
    const now = Date.parse('2026-08-17T05:00:00Z');
    const next = nextDueDailyAt(null, '09:00', 'UTC', now);
    ok(next === '2026-08-17T09:00:00.000Z', `before dailyAt, unstamped -> TODAY's dailyAt (got ${next})`);
  }
  // Stamped today (the scheduled run already fired) -> tomorrow's dailyAt.
  {
    const now = Date.parse('2026-08-17T12:00:00Z');
    const next = nextDueDailyAt('2026-08-17T09:00:30Z', '09:00', 'UTC', now);
    ok(next === '2026-08-18T09:00:00.000Z', `stamped today -> TOMORROW's dailyAt (got ${next})`);
  }
  // Past dailyAt, NOT stamped today -> due right now (the next tick fires it).
  {
    const now = Date.parse('2026-08-17T12:00:00Z');
    const next = nextDueDailyAt('2026-08-15T09:00:00Z', '09:00', 'UTC', now);
    ok(next === new Date(now).toISOString(), `past dailyAt and unstamped -> NOW, the honest next-tick (got ${next})`);
  }
  // Timezone honoured: 09:00 in Zurich (CEST, UTC+2 in August) = 07:00Z.
  {
    const now = Date.parse('2026-08-17T05:00:00Z'); // 07:00 local Zurich
    const next = nextDueDailyAt(null, '09:00', 'Europe/Zurich', now);
    ok(next === '2026-08-17T07:00:00.000Z', `09:00 Europe/Zurich resolves to 07:00Z in August (got ${next})`);
  }
  // Bad tz falls back to UTC exactly like dueDailyAt.
  {
    const now = Date.parse('2026-08-17T05:00:00Z');
    const next = nextDueDailyAt(null, '09:00', 'Not/AZone', now);
    ok(next === nextDueDailyAt(null, '09:00', 'UTC', now), 'a bad tz falls back like dueDailyAt (UTC)');
  }
  // A garbage dailyAt falls back to 09:00 exactly like dueDailyAt.
  {
    const now = Date.parse('2026-08-17T05:00:00Z');
    ok(nextDueDailyAt(null, '25:99', 'UTC', now) === nextDueDailyAt(null, '09:00', 'UTC', now),
      'a garbage dailyAt falls back to 09:00 like dueDailyAt');
  }

  // ===== (3) listRadar carries the exact nextScan + lastProduced shape =====
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  const { listRadar } = await import('../lib/writes.mjs');
  const { loadState, saveState } = await import('../lib/state.mjs');
  setConfig({
    ifRev: getConfig().rev, actor: 'owner',
    set: { posting: { defaultTimezone: 'Europe/Zurich', radar: {
      enabled: true, dailyAt: '07:30',
      queries: [{ id: 'q1', label: 'S', enabled: true, cadence: 'daily', keywords: ['schedule'] }],
      agent: { provider: 'claude-code', dailyBudget: 3 },
    } } },
  });
  // Seed the stamps + two jobs (a running geo one and a settled feed one) directly in state:
  // the shape join is what is under test, not the scan pipeline.
  {
    const state = loadState();
    if (!state.radar) state.radar = {};
    state.radar.lastAgentScan = '2026-08-16T05:30:00Z';
    state.radar.lastDailyScan = '2026-08-16T05:31:00Z';
    state.radar.lastAuthorReplyReconcile = '2026-08-16T06:00:00Z';
    state.radar.jobs = [
      { id: 'job-geo', scope: 'geo', state: 'done', startedAt: '2026-08-16T08:00:00Z', finishedAt: '2026-08-16T08:01:00Z', accepted: 0, drafted: 0 },
      { id: 'job-feed', scope: 'feed', state: 'done', partial: true, reason: 'partial', startedAt: '2026-08-16T05:30:00Z', finishedAt: '2026-08-16T05:40:00Z', accepted: 7, drafted: 4, autoPosted: 1, exitCode: 0 },
      { id: 'job-old', scope: 'feed', state: 'failed', reason: 'timeout', startedAt: '2026-08-15T05:30:00Z', finishedAt: '2026-08-15T05:40:00Z', accepted: 0, drafted: 0 },
    ];
    saveState();
  }
  const feed = await listRadar({});
  ok(feed.ok === true && feed.nextScan && typeof feed.nextScan === 'object', 'listRadar carries nextScan');
  const ns = feed.nextScan;
  ok(ns.timezone === 'Europe/Zurich' && ns.dailyAt === '07:30', 'nextScan carries { timezone, dailyAt } from config');
  ok(ns.agent.armed === true, 'agent.armed: provider connected AND an enabled daily query');
  ok(typeof ns.agent.at === 'string' && Number.isFinite(Date.parse(ns.agent.at)), 'agent.at is an ISO time');
  ok(ns.agent.lastAt === '2026-08-16T05:30:00Z', 'agent.lastAt echoes the lastAgentScan stamp');
  ok(ns.agent.budget === 3 && ns.agent.spent === 0, 'agent.{budget,spent} state the honest unattended spend (old jobs are outside the 24h window)');
  ok(ns.keyword.armed === true && ns.keyword.lastAt === '2026-08-16T05:31:00Z' && typeof ns.keyword.at === 'string', 'keyword clock: armed + lastAt + at');
  ok(ns.followup.lastAt === '2026-08-16T06:00:00Z' && Date.parse(ns.followup.at) === Date.parse('2026-08-16T06:00:00Z') + 24 * 3600 * 1000,
    'followup.at = lastAuthorReplyReconcile + 24h (its clock is a plain 24h interval, not dailyAt)');
  ok(ns.followup.agentDue === 0, 'followup.agentDue present (0 until agent-lane targets are due)');
  ok(feed.lastProduced && feed.lastProduced.jobId === 'job-feed',
    'lastProduced is the NEWEST SETTLED scope-feed job - the running/geo rows are skipped');
  ok(feed.lastProduced.state === 'done' && feed.lastProduced.partial === true && feed.lastProduced.reason === 'partial'
    && feed.lastProduced.accepted === 7 && feed.lastProduced.drafted === 4 && feed.lastProduced.autoPosted === 1
    && feed.lastProduced.finishedAt === '2026-08-16T05:40:00Z',
    'lastProduced carries { jobId, finishedAt, state, partial, reason, accepted, drafted, autoPosted }');

  // Un-armed when no daily query: nextScan still present (the times are derivable) but armed:false.
  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { queries: [{ id: 'q1', label: 'S', enabled: true, cadence: 'manual', keywords: ['schedule'] }] } } } });
  const feed2 = await listRadar({});
  ok(feed2.nextScan.agent.armed === false && feed2.nextScan.keyword.armed === false,
    'with no daily-cadence query both clocks read armed:false - no scan is promised that will not fire');

  console.log(`\n[radar-next-scan] OK - nextDueDailyAt agrees with the scheduler gate by property, the closed-form branches and fallbacks hold, and listRadar carries the exact nextScan + lastProduced shape (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
