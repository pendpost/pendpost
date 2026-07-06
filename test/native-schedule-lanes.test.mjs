#!/usr/bin/env node
// test/native-schedule-lanes.test.mjs - the 2026-07-05 native-scheduling
// refactor: mastodon/wordpress/ghost hand approved entries to the PLATFORM's
// own scheduler ahead of due (like yt-social's private+publishAt), so they
// survive the machine being off without pendpost-cloud. Proves:
//   - the engines wire `schedule` (native params per lane) + the reconcile
//     commands (mastodon resolve/unschedule, wordpress/ghost release);
//   - the scheduler registers the lanes (`schedule` command) + the recovery
//     lanes (mastodon-resolve, wordpress-release, ghost-release) and lanesOwed
//     treats a mastodon queue entry as a real hand-off;
//   - the edit/cancel story: nativeHandoffs (lib/writes.mjs) covers all three
//     platform objects (the header rationale the old publish-at-due choice
//     pointed at), and buildPublishJob reports them native/power-off-safe;
//   - the mock loop runs the new split end-to-end: future due -> schedule-native
//     (status 'scheduled', never posted), past due -> immediate publish,
//     resolve/release close the loop. Zero network.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-native-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const src = (p) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');
const schedulerSrc = src('lib/scheduler.mjs');
const writesSrc = src('lib/writes.mjs');
const plansSrc = src('lib/plans.mjs');
const mastoSrc = src('scripts/mastodon-social.mjs');
const wpSrc = src('scripts/wordpress-social.mjs');
const ghostSrc = src('scripts/ghost-social.mjs');

const { lanesOwed } = await import('../lib/scheduler.mjs');
const { NATIVE_SCHEDULING_PLATFORMS } = await import('../lib/plans.mjs');
const { buildPublishJob } = await import('../lib/publish-job.mjs');

function runEngine(script, args) {
  const out = execFileSync(process.execPath, [path.join(REPO_ROOT, script), ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, PENDPOST_MODE: 'mock', PENDPOST_ROOT: WS },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}

try {
  // ===== (1) engine commands wired, with each platform's real native params =====
  ok(/schedule: cmdSchedule/.test(mastoSrc) && /resolve: cmdResolve/.test(mastoSrc) && /unschedule: cmdUnschedule/.test(mastoSrc),
    'mastodon: schedule/resolve/unschedule are wired into the COMMANDS map');
  ok(/scheduled_at: new Date\(dueMs\)\.toISOString\(\)/.test(mastoSrc),
    'mastodon: cmdSchedule posts /statuses with scheduled_at');
  ok(/MIN_SCHEDULE_LEAD_MS/.test(mastoSrc), 'mastodon: the ~5-minute instance minimum lead is guarded');
  ok(/DELETE', `\/api\/v1\/scheduled_statuses\//.test(mastoSrc),
    'mastodon: unschedule/resolve cancel via DELETE /scheduled_statuses/:id (not the live-status delete)');

  ok(/schedule: cmdSchedule/.test(wpSrc) && /release: cmdRelease/.test(wpSrc),
    'wordpress: schedule/release are wired into the COMMANDS map');
  ok(/payload\.status = 'future'/.test(wpSrc) && /payload\.date_gmt/.test(wpSrc),
    "wordpress: cmdSchedule creates the post with status 'future' + date_gmt");
  const wpRelStart = wpSrc.indexOf('async function cmdRelease');
  const wpRelBody = wpSrc.slice(wpRelStart, wpSrc.indexOf('async function cmdStatus'));
  ok(wpRelStart >= 0 && /status: 'publish'/.test(wpRelBody) && !/buildPayload\(/.test(wpRelBody),
    'wordpress: cmdRelease flips status publish and NEVER re-creates the post');

  ok(/schedule: cmdSchedule/.test(ghostSrc) && /release: cmdRelease/.test(ghostSrc),
    'ghost: schedule/release are wired into the COMMANDS map');
  ok(/body\.published_at = new Date\(dueMs\)\.toISOString\(\)/.test(ghostSrc) && /targetStatus = pastDue \? 'published' : 'scheduled'/.test(ghostSrc),
    "ghost: cmdSchedule flips draft -> 'scheduled' + published_at");
  ok(/newsletter=\$\{encodeURIComponent\(newsletterSlug\)\}/.test(ghostSrc) && /flipPath/.test(ghostSrc),
    'ghost: ?newsletter= rides on the scheduling transition (verified v5 semantics - email sends at publish)');
  const ghRelBody = ghostSrc.slice(ghostSrc.indexOf('async function cmdRelease'), ghostSrc.indexOf('async function cmdStatus'));
  ok(/status: 'published'/.test(ghRelBody) && !/buildDraftPayload\(/.test(ghRelBody),
    'ghost: cmdRelease flips status published and NEVER re-creates the draft');

  // ===== (2) scheduler lanes: native hand-off ahead of due + recovery lanes =====
  ok(/mastodon: \{ script: 'scripts\/mastodon-social\.mjs', command: 'schedule'/.test(schedulerSrc)
    && /wordpress: \{ script: 'scripts\/wordpress-social\.mjs', command: 'schedule'/.test(schedulerSrc)
    && /ghost: \{ script: 'scripts\/ghost-social\.mjs', command: 'schedule'/.test(schedulerSrc),
    "ENGINES runs the three lanes through `schedule` (not publish-due)");
  ok(/'mastodon-resolve': \{[^}]*command: 'resolve'/.test(schedulerSrc)
    && /'wordpress-release': \{[^}]*command: 'release'/.test(schedulerSrc)
    && /'ghost-release': \{[^}]*command: 'release'/.test(schedulerSrc),
    'ENGINES registers the three recovery lanes');
  ok(/lanes\.push\('mastodon-resolve'\)/.test(schedulerSrc)
    && /lanes\.push\('wordpress-release'\)/.test(schedulerSrc) && /future-overdue/.test(schedulerSrc)
    && /lanes\.push\('ghost-release'\)/.test(schedulerSrc) && /scheduled-overdue/.test(schedulerSrc),
    'lanesFor owes the recovery lanes (verify-evidence-gated for wp/ghost, id-gated for mastodon)');
  ok(/NATIVE_ANYTIME_LANES = new Set\(\['mastodon', 'wordpress', 'ghost'\]\)/.test(schedulerSrc),
    'lanesFor fires the three native lanes both ahead of due (hand-off) and past due (immediate publish)');
  ok(/'mastodon-resolve': \['mastodon'\]/.test(schedulerSrc) && /'wordpress-release': \['wordpress'\]/.test(schedulerSrc) && /'ghost-release': \['ghost'\]/.test(schedulerSrc),
    'LANE_PLATFORMS maps the recovery lanes to their platforms');
  const owedBody = schedulerSrc.slice(schedulerSrc.indexOf('export function lanesOwed'), schedulerSrc.indexOf('function lanesFor'));
  ok(!/owed\.push\('[a-z]+-(release|resolve)'\)/.test(owedBody),
    'lanesOwed (shared with the cloud) does NOT emit the recovery lanes');

  // lanesOwed behavior: a mastodon queue entry is a real hand-off (no lane owed).
  const base = { platforms: ['mastodon'], type: 'text', ids: {} };
  ok(lanesOwed(base).includes('mastodon'), 'lanesOwed: a mastodon post with no ids owes the lane');
  ok(!lanesOwed({ ...base, ids: { mastodonScheduledId: 'q1' } }).includes('mastodon'),
    'lanesOwed: a natively-scheduled queue entry (mastodonScheduledId) no longer owes the lane');
  ok(!lanesOwed({ ...base, ids: { mastodonStatusId: 's1' } }).includes('mastodon'),
    'lanesOwed: a published status id no longer owes the lane');

  // ===== (3) the edit/cancel story: nativeHandoffs + power-off-safe jobs =====
  ok(/mastodonScheduledId[^\n]*field: 'mastodonScheduledId', command: 'unschedule'/.test(writesSrc),
    "nativeHandoffs cancels a mastodon queue entry via the engine's `unschedule`");
  ok(/field: 'wordpressPostId'/.test(writesSrc) && /field: 'ghostPostId'/.test(writesSrc),
    'nativeHandoffs covers the wordpress + ghost scheduled objects');
  ok(/function nativeHandoffs\(post\)/.test(writesSrc) && /for \(const h of handoffs\) delete p\[h\.field\]/.test(writesSrc),
    'unschedule/reschedule cancel EVERY native object of a multi-platform post');

  for (const p of ['mastodon', 'wordpress', 'ghost']) {
    ok(NATIVE_SCHEDULING_PLATFORMS.has(p), `NATIVE_SCHEDULING_PLATFORMS includes ${p} (survives power-off)`);
  }
  ok(/'future-overdue', 'scheduled-overdue'/.test(plansSrc),
    'VERIFY_FAILED knows the wp/ghost overdue read-back states (recovery-lane evidence)');
  const post = { id: 'n1', approval: 'approved', approvalBy: 'owner', createdBy: 'owner', platforms: ['mastodon'], type: 'text', ids: {}, media: { path: null }, caption: 'x' };
  const job = buildPublishJob(post, 'mastodon', { clientId: 'c', campaign: 'cam', command: 'schedule', timeoutMs: 1, lanePlatforms: ['mastodon'] });
  ok(job.delivery.mode === 'native' && job.delivery.survivesPowerOff === true,
    'buildPublishJob: a mastodon lane is native, power-off-safe');
  for (const lane of ['mastodon-resolve', 'wordpress-release', 'ghost-release']) {
    const rj = buildPublishJob(post, lane, { clientId: 'c', campaign: 'cam', command: 'x', timeoutMs: 1, lanePlatforms: [lane.split('-')[0]] });
    ok(rj.lane === lane, `buildPublishJob accepts the ${lane} lane (KNOWN_LANES)`);
  }

  // ===== (4) mock loop: future -> schedule-native, past -> publish, reconcile =====
  const MOCK_LANES = {
    mastodon: { script: 'scripts/mastodon-social.mjs', idField: 'mastodonStatusId', schedField: 'mastodonScheduledId', fields: { mastodonCaption: 'a native note' } },
    wordpress: { script: 'scripts/wordpress-social.mjs', idField: 'wordpressPostId', schedField: 'wordpressPostId', fields: { title: 'Native article', body: 'Body.' } },
    ghost: { script: 'scripts/ghost-social.mjs', idField: 'ghostPostId', schedField: 'ghostPostId', fields: { title: 'Native article', body: 'Body.', ghostEmail: false } },
  };
  for (const [lane, def] of Object.entries(MOCK_LANES)) {
    const planPath = path.join(WS, `${lane}-native-plan.json`);
    const mkPost = (scheduledAt) => ({
      id: 'ns-01', type: 'text', platforms: [lane], scheduledAt,
      caption: `native scheduling loop for ${lane}`, status: 'planned',
      executionMode: 'fully-scheduled', approval: 'approved', createdBy: 'owner', approvalBy: 'owner',
      ...def.fields,
    });

    // Future due: schedule hands off natively - id minted, 'scheduled', NOT posted.
    fs.writeFileSync(planPath, JSON.stringify({ campaign: `native-${lane}`, posts: [mkPost(new Date(Date.now() + 2 * 3600_000).toISOString())] }, null, 2));
    const sch = runEngine(def.script, ['schedule', '--plan', planPath, '--json']);
    ok(sch.ok === true && sch.results.some((r) => r.platform === lane && r.action === 'schedule-native' && r.ok),
      `${lane}: mock schedule natively hands off a future post (schedule-native)`);
    let saved = JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0];
    ok(typeof saved[def.schedField] === 'string' && saved[def.schedField].startsWith('mock_'), `${lane}: the native object id is minted on the plan`);
    ok(saved.status === 'scheduled', `${lane}: the post is 'scheduled' (handed off, never posted early)`);

    // Idempotent: a second schedule mints nothing new.
    const again = runEngine(def.script, ['schedule', '--plan', planPath, '--json']);
    ok(again.ok === true && !again.results.some((r) => ['schedule-native', 'publish'].includes(r.action)),
      `${lane}: a second schedule is a no-op (id already handed off)`);

    if (lane === 'mastodon') {
      // Past due, queue entry fired: resolve records the NEW live status id.
      const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
      plan.posts[0].scheduledAt = new Date(Date.now() - 3600_000).toISOString();
      fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
      const res = runEngine(def.script, ['resolve', '--plan', planPath, '--json']);
      ok(res.ok === true && res.results.some((r) => r.action === 'resolve' && r.ok), 'mastodon: mock resolve reconciles the fired queue entry');
      saved = JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0];
      ok(typeof saved.mastodonStatusId === 'string' && saved.status === 'posted', 'mastodon: resolve records the live status id + posted');
    } else {
      // The release recovery answers with a live/published envelope row.
      const rel = runEngine(def.script, ['release', '--plan', planPath, '--json']);
      ok(rel.ok === true && rel.results.some((r) => r.action === 'release' && r.ok && r.live === true), `${lane}: mock release reports the post live`);
    }

    // Past due from scratch: schedule publishes immediately (never strands).
    fs.writeFileSync(planPath, JSON.stringify({ campaign: `native-${lane}-late`, posts: [mkPost(new Date(Date.now() - 60_000).toISOString())] }, null, 2));
    const late = runEngine(def.script, ['schedule', '--plan', planPath, '--json']);
    ok(late.ok === true && late.results.some((r) => r.platform === lane && r.action === 'publish' && r.ok),
      `${lane}: a past-due entry publishes immediately through the same schedule command`);
    saved = JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0];
    ok(saved.status === 'posted', `${lane}: the late entry lands posted`);
  }

  console.log(`[native-schedule-lanes] OK - mastodon/wordpress/ghost schedule natively ahead of due (yt model), recovery lanes registered, nativeHandoffs cancels all platform objects, mock loop proves the future/past split (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
