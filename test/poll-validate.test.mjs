#!/usr/bin/env node
// test/poll-validate.test.mjs - spec 10 review (finding #3): platformValidate names
// the exact per-lane poll DURATION floor/ceiling AND QUESTION cap, not just the option
// cap, so Pruefen blocks an out-of-range poll BEFORE the remote 400s. Proven: an X 1-min
// poll (X floor 5 min) and a 301-char Discord question each surface a blocking problem
// naming the cap; a well-shaped poll carries no poll-cap problem.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib (util
// binds WORKSPACE_ROOT at import; mirrors test/platform-validate-lanes.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-poll-validate-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;

const plansDir = path.join(WS, 'data', 'plans');
const campDir = path.join(plansDir, 'pv');
fs.mkdirSync(campDir, { recursive: true });
fs.writeFileSync(path.join(plansDir, 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'pv', path: 'data/plans/pv/post-plan.json', active: true }],
}, null, 2));

const base = {
  status: 'planned', executionMode: 'fully-scheduled',
  approval: 'approved', approvalBy: 'owner', approvalAt: '2026-01-01T00:00:00Z',
  createdBy: 'agent:claude', scheduledAt: '2099-01-01T09:00:00Z',
};
const posts = [
  // X floor is 5 min; a 1-min poll must be blocked by Pruefen, not by the remote 400.
  { id: 'x-shortdur', platforms: ['x'], type: 'poll', caption: 'Best release day?', poll: { options: ['Yes', 'No'], durationMinutes: 1 }, ...base },
  // Discord/Telegram cap a poll question at 300 chars - a 301-char question must block.
  { id: 'dc-longq', platforms: ['discord'], type: 'poll', caption: 'q'.repeat(301), poll: { options: ['Yes', 'No'], durationMinutes: 60 }, ...base },
  // A well-shaped poll: no poll-cap problem (connectivity aside).
  { id: 'x-ok', platforms: ['x'], type: 'poll', caption: 'Best release day?', poll: { options: ['Yes', 'No'], durationMinutes: 1440 }, ...base },
];
fs.writeFileSync(path.join(campDir, 'post-plan.json'), JSON.stringify({ campaign: 'pv', timezone: 'UTC', posts }, null, 2));

const { platformValidate } = await import('../lib/writes.mjs');

try {
  const xShort = await platformValidate({ campaign: 'pv', postId: 'x-shortdur' });
  const xProblems = xShort.platforms?.x?.problems || [];
  ok(xProblems.some((p) => /at least 5 minutes/.test(p)),
    'X: a 1-min poll surfaces a duration-floor problem naming the 5-minute cap');

  const dcLong = await platformValidate({ campaign: 'pv', postId: 'dc-longq' });
  const dcProblems = dcLong.platforms?.discord?.problems || [];
  ok(dcProblems.some((p) => /poll question at 300 chars/.test(p)),
    'Discord: a 301-char question surfaces a question-cap problem naming the 300-char cap');

  const xOk = await platformValidate({ campaign: 'pv', postId: 'x-ok' });
  const xOkProblems = xOk.platforms?.x?.problems || [];
  ok(!xOkProblems.some((p) => /at least \d+ minutes|caps a poll|at most \d+ (poll options|chars)/.test(p)),
    'X: a valid 2-option / 1-day poll has NO poll-cap problem (connectivity aside)');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
