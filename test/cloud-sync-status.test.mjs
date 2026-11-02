#!/usr/bin/env node
// test/cloud-sync-status.test.mjs - cloudSyncStatus(), the guarantee roll-up behind
// the header cloud dot (lib/cloud-client.mjs). Four-state contract (green/yellow/amber/red):
//   green  - every approved post owing a CLOUD lane is ack'd, contact fresh, no failure
//   yellow - an owed cloud-lane job has no push-ack yet (push pending)
//   amber  - delivery DEGRADED but nothing missed yet: cloud unreachable / its worker
//            wedged / syncStopped / on-flag drift - the local backstop covers it
//   red    - a post is at risk RIGHT NOW: overdue-unpublished / a cloud failure /
//            an unreadable plan - the owner must act
//   null   - the active brand is not cloud-managed (no claim, dot falls back to local)
// A genuine miss (red) must OUTRANK a mere connectivity blip (amber): overdue wins over
// unreachable. Includes the incident's exact shape: ACKED but OVERDUE must be red - an
// ack proves acceptance, never that the job will fire. Pure reads; mocked fetch; mock mode.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-syncstatus-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n');

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const { loadPlanStore, clearPlanStoreCache } = await import('../lib/plans.mjs');
const cloud = await import('../lib/cloud-client.mjs');

const CAMP = 'status-2026-07';
const CLIENT = activeClientId();
const FUTURE = new Date(Date.now() + 60 * 60_000).toISOString(); // due in 1h: owed, not overdue
const RECENT = new Date(Date.now() - 2 * 60_000).toISOString(); // due 2 min ago: due, inside the overdue grace

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

global.fetch = async (input, init) => {
  const url = String(input);
  const method = (init && init.method) || 'GET';
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (url.endsWith('/v1/health')) return json({ ok: true });
  if (url.endsWith('/v1/content/presign')) return json({ alreadyPresent: true });
  if (url.endsWith('/v1/sync/push') && method === 'POST') {
    const body = JSON.parse(init.body);
    return json({ accepted: (body.jobs || []).map((j) => ({ jobId: j.jobId, enqueueRef: 'e1' })), refused: [] });
  }
  return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
};

const freshContact = () => { const s = loadState(); s.cloudContact = { okAt: new Date().toISOString() }; saveState(); };

try {
  // --- null: not cloud-managed --------------------------------------------------------
  ok(cloud.cloudSyncStatus() === null, 'not connected -> null (no guarantee claim)');
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  ok(cloud.cloudSyncStatus() === null, 'connected but the brand is not always-on -> still null');
  setBrandAlwaysOn(CLIENT, true);

  // --- green: nothing owed, contact fresh (connectWorkspace just reached the cloud) ---
  const g0 = cloud.cloudSyncStatus();
  ok(g0 && g0.state === 'green' && g0.reason === 'all_confirmed', 'cloud-managed, empty backlog, fresh contact -> green');
  ok(Array.isArray(g0.issues) && g0.issues.length === 0, 'green carries an empty issues[]');
  ok('lastError' in g0 && 'errorAt' in g0, 'the roll-up exposes lastError + errorAt from cloudContact');

  // --- yellow: an approved cloud-lane post without an ack -----------------------------
  await createCampaign({ id: CAMP, note: 'status contract', timezone: 'UTC', actor: 'owner' });
  await createPost({ campaign: CAMP, post: { id: 'p1', type: 'reel', platforms: ['instagram'], scheduledAt: FUTURE, path: 'data/media/clip.mp4', caption: 'a quiet clip' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'p1', actor: 'owner' });
  const y1 = cloud.cloudSyncStatus();
  ok(y1.state === 'yellow' && y1.reason === 'push_pending' && y1.pendingCount === 1, 'approved cloud-lane post without an ack -> yellow (push pending)');

  // --- green again: the push acks the job ---------------------------------------------
  await cloud.pushApprovedJobs();
  freshContact(); // the push stamp is throttled; make freshness explicit for the read
  const g1 = cloud.cloudSyncStatus();
  ok(g1.state === 'green' && g1.pendingCount === 0, 'the acked job flips the dot back to green');

  // --- red: ACKED but OVERDUE (the incident shape - an ack is not a fire) --------------
  {
    const s = loadState();
    // Re-date the ack'd post far past due WITHOUT touching the ack.
    const planAbs = path.join(WS, 'data', 'plans', CAMP, 'post-plan.json');
    const plan = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
    plan.posts.find((p) => p.id === 'p1').scheduledAt = '2020-01-01T00:00:00Z';
    fs.writeFileSync(planAbs, JSON.stringify(plan, null, 2));
    void s;
  }
  const r1 = cloud.cloudSyncStatus();
  ok(r1.state === 'red' && r1.reason === 'overdue_unpublished' && r1.overdueCount === 1, 'ACKED but overdue-unpublished -> red (an ack proves acceptance, not firing)');
  {
    const i = r1.issues.find((x) => x.kind === 'overdue');
    ok(i && i.campaign === CAMP && i.postId === 'p1' && i.lane === 'meta' && i.title === 'a quiet clip' && i.clientId === CLIENT && typeof i.clientName === 'string',
      `an overdue post surfaces as an issue row naming the post, lane and title (${JSON.stringify(i)})`);
  }

  // --- red: a cached cloud-lane failure ------------------------------------------------
  {
    const plan = path.join(WS, 'data', 'plans', CAMP, 'post-plan.json');
    const j = JSON.parse(fs.readFileSync(plan, 'utf8'));
    // Just past due (inside the overdue grace): a failure can only be real for a post that
    // IS due - one scheduled in the future is a stale echo and is ignored (see below).
    j.posts.find((p) => p.id === 'p1').scheduledAt = RECENT;
    fs.writeFileSync(plan, JSON.stringify(j, null, 2));
    const s = loadState();
    s.cloudFailures = { [`${CAMP}:p1`]: { lane: 'meta', jobId: 'j1', message: 'token expired', at: new Date().toISOString() } };
    saveState();
  }
  const r2 = cloud.cloudSyncStatus();
  ok(r2.state === 'red' && r2.reason === 'cloud_failures' && r2.failedCount === 1, 'a cached cloud-lane failure -> red');
  {
    const i = r2.issues[0];
    ok(r2.issues.length === 1 && i.kind === 'post' && i.postId === 'p1' && i.lane === 'meta' && i.message === 'token expired' && i.terminal === false && i.code === null,
      `a fire failure surfaces as ONE kind:'post' issue carrying the real message (${JSON.stringify(r2.issues)})`);
    // The row carries the SAME failure inputs the post's own banner reads (lib/plans.mjs
    // lastFailureFor: recovery + halted), so the Studio judges both with one failedDisplayKey
    // and a cloud row can never call "retrying" what the banner calls "waiting on you".
    {
      const st = loadState();
      const rowAndBanner = (failure) => {
        st.cloudFailures[`${CAMP}:p1`] = { lane: 'meta', jobId: 'j1', at: new Date().toISOString(), retries: 1, ...failure };
        saveState();
        clearPlanStoreCache();
        const row = cloud.cloudSyncStatus().issues[0];
        const banner = loadPlanStore().campaigns.find((c) => c.id === CAMP).posts.find((p) => p.id === 'p1').lastFailure;
        return { row: { recovery: row.recovery, halted: row.halted, terminal: row.terminal, kind: row.kind }, banner: { recovery: banner.recovery, halted: banner.halted } };
      };
      const transient = rowAndBanner({ message: 'meta: POST /feed: HTTP 500 - internal error' });
      ok(transient.row.kind === 'post' && transient.row.terminal === false && transient.row.recovery === null && transient.row.halted === false
        && transient.banner.recovery === null && transient.banner.halted === false,
        `a transient 500 the cloud still retries: no recovery, not halted, on the row and the banner alike (${JSON.stringify(transient)})`);
      const manual = rowAndBanner({ message: 'x: POST /2/tweets: HTTP 403 - You can only reply to or quote posts where you are mentioned' });
      ok(manual.row.terminal === false && manual.row.recovery === 'manual' && manual.banner.recovery === 'manual',
        `a refusal no retry can land (X reply rule) carries the banner's recovery although the cloud has not stamped it terminal (${JSON.stringify(manual)})`);
      st.meta = { ...(st.meta || {}), recordedAt: new Date().toISOString(), blockedUntil: new Date(Date.now() + 3600_000).toISOString(), reason: 'action block' };
      const halted = rowAndBanner({ message: 'meta: POST /feed: HTTP 500 - internal error' });
      ok(halted.row.halted === true && halted.banner.halted === true, `a circuit-broken lane reads halted on the row as on the banner (${JSON.stringify(halted)})`);
      delete st.meta;
      st.cloudFailures[`${CAMP}:p1`] = { lane: 'meta', jobId: 'j1', message: 'token expired', at: new Date().toISOString() };
      saveState();
      clearPlanStoreCache();
    }
    const s = loadState();
    s.cloudFailures[`${CAMP}:p1`] = { ...s.cloudFailures[`${CAMP}:p1`], refusedCode: 'account_unresolved', message: 'Nothing was published: reconnect.', terminal: true };
    saveState();
    const rc = cloud.cloudSyncStatus();
    const c = rc.issues[0];
    ok(c && c.kind === 'credential' && c.code === 'account_unresolved' && c.terminal === true && c.recovery === 'reconnect', `a credential refusal surfaces as kind:'credential' with its code + terminal flag (${JSON.stringify(c)})`);
    s.cloudFailures[`${CAMP}:p1`] = { lane: 'meta', jobId: 'j1', message: 'token expired', at: new Date().toISOString() };
    saveState();
  }
  // The same failure for a post the owner moved into the FUTURE is a stale echo -> not red.
  { const plan = path.join(WS, 'data', 'plans', CAMP, 'post-plan.json'); const j = JSON.parse(fs.readFileSync(plan, 'utf8')); j.posts.find((p) => p.id === 'p1').scheduledAt = FUTURE; fs.writeFileSync(plan, JSON.stringify(j, null, 2)); }
  const r2f = cloud.cloudSyncStatus();
  ok(r2f.state !== 'red' && r2f.failedCount === 0, 'a failure for a future-scheduled post is ignored (it cannot have failed on time)');
  // A RELIC failure (its post is posted/gone) must not hold the dot red forever.
  { const s = loadState(); s.cloudFailures = { [`${CAMP}:p-long-gone`]: { lane: 'linkedin', jobId: 'j0', message: 'token expired', at: '2026-06-26T14:19:50.356Z' } }; saveState(); }
  const g3 = cloud.cloudSyncStatus();
  ok(g3.state !== 'red' && g3.failedCount === 0, 'a stale failure for a posted/absent post is ignored (no eternal red)');
  { const s = loadState(); s.cloudFailures = {}; saveState(); }

  // --- amber: subscription sync stopped (degraded, but the local backstop covers it) ---
  { const s = loadState(); s.cloudSubView = { alwaysOn: true, syncStopped: true, stopReason: 'spend_cap_reached', at: new Date().toISOString() }; saveState(); }
  const r3 = cloud.cloudSyncStatus();
  ok(r3.state === 'amber' && r3.reason === 'sync_stopped', 'syncStopped subscription -> amber (covered locally, attention not failure)');
  { const s = loadState(); s.cloudSubView = { alwaysOn: true, syncStopped: false, stopReason: null, at: new Date().toISOString() }; saveState(); }

  // --- Neon-economy policy: a stale contact is an ALARM only when something is pending it
  //     endangers. We stopped idle-polling (an idle daemon makes zero Neon calls to let the compute
  //     suspend), so a stale okAt no longer means "unreachable" - with nothing pending it means
  //     "not polled, nothing to sync" -> GREEN. A PENDING post + the same stale contact is a real
  //     degradation -> amber (the alarm is preserved). This is the data-honesty rule: no attention
  //     colour when nothing is at risk.
  { const s = loadState(); s.cloudContact = { okAt: '2020-01-01T00:00:00.000Z' }; saveState(); }
  const r4idle = cloud.cloudSyncStatus();
  ok(r4idle.state === 'green' && r4idle.reason === 'all_confirmed', 'idle (nothing pending) + stale contact -> green (no idle poll needed; nothing at risk)');
  // Momentarily unack p1 so it is PENDING; the same stale contact must still read amber.
  const savedAcks = loadState().cloudAccepted;
  { const s = loadState(); s.cloudAccepted = {}; saveState(); }
  const r4pending = cloud.cloudSyncStatus();
  ok(r4pending.state === 'amber' && r4pending.reason === 'cloud_unreachable', 'a pending post + stale contact -> amber cloud_unreachable (the real alarm is preserved)');
  ok(r4pending.issues.length === 1 && r4pending.issues[0].kind === 'unreachable', 'unreachable surfaces as a kind:unreachable issue');
  {
    const s = loadState(); s.cloudContact = { ...s.cloudContact, lastError: 'cloud request failed: fetch failed', errorAt: '2026-09-25T08:00:00.000Z' }; saveState();
    const u = cloud.cloudSyncStatus();
    ok(u.lastError === 'cloud request failed: fetch failed' && u.errorAt === '2026-09-25T08:00:00.000Z' && u.issues[0].message === 'cloud request failed: fetch failed',
      'the contact error rides lastError/errorAt and is the unreachable row message');
    ok(u.issues[0].lastOkAt === '2020-01-01T00:00:00.000Z', 'the unreachable row carries lastOkAt (the last good contact) so the UI can say "last reached HH:MM"');
    ok(!JSON.stringify(u).includes('ppc_test_secret'), 'the roll-up never carries the api key');
    s.cloudContact = { okAt: '2020-01-01T00:00:00.000Z' }; saveState();
  }
  { const s = loadState(); s.cloudAccepted = savedAcks; saveState(); }

  // --- red OUTRANKS amber: an overdue post while ALSO unreachable is still red ----------
  // The whole point of the split - a genuine miss must never hide behind "unreachable".
  {
    const plan = path.join(WS, 'data', 'plans', CAMP, 'post-plan.json');
    const j = JSON.parse(fs.readFileSync(plan, 'utf8'));
    j.posts.find((p) => p.id === 'p1').scheduledAt = '2020-01-01T00:00:00Z'; // overdue again
    fs.writeFileSync(plan, JSON.stringify(j, null, 2));
    // contact is STILL stale from r4 above
  }
  const r5 = cloud.cloudSyncStatus();
  ok(r5.state === 'red' && r5.reason === 'overdue_unpublished', 'overdue post + unreachable cloud -> red (miss outranks connectivity)');
  { const plan = path.join(WS, 'data', 'plans', CAMP, 'post-plan.json'); const j = JSON.parse(fs.readFileSync(plan, 'utf8')); j.posts.find((p) => p.id === 'p1').scheduledAt = FUTURE; fs.writeFileSync(plan, JSON.stringify(j, null, 2)); }
  freshContact();

  // --- amber: cloud reachable but its publisher worker is wedged (silent-drop class) ----
  { const s = loadState(); s.cloudContact = { okAt: new Date().toISOString(), workerStale: true, workerCheckedAt: new Date().toISOString() }; saveState(); }
  const r6 = cloud.cloudSyncStatus();
  ok(r6.state === 'amber' && r6.reason === 'worker_stale', 'reachable but worker wedged -> amber (worker_stale)');
  ok(r6.issues.some((x) => x.kind === 'worker_stale'), 'a wedged worker surfaces as a kind:worker_stale issue');
  freshContact();

  // --- worker_stale carries the worker's last heartbeat, like unreachable's lastOkAt ----
  // /v1/health reports each process's beatAt; the ping keeps the newest stale beat so the
  // row can say "last reached HH:MM" instead of no time at all.
  {
    const realFetch = global.fetch;
    const BEAT = '2026-09-25T22:31:00.000Z';
    const health = (worker) => async (input, init) => (String(input).endsWith('/v1/health')
      ? { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, worker }) }
      : realFetch(input, init));
    global.fetch = health({ ok: false, processes: [
      { process: 'runtime', beatAt: '2026-09-25T22:10:00.000Z', ageSeconds: 2000, stale: true },
      { process: 'runtime-2', beatAt: BEAT, ageSeconds: 900, stale: true },
      { process: 'cron', beatAt: new Date().toISOString(), ageSeconds: 10, stale: false },
    ] });
    const ping = await cloud.cloudHealthPing();
    ok(ping && ping.workerStale === true && loadState().cloudContact.workerBeatAt === BEAT, 'the ping records the newest stale process beat as workerBeatAt');
    const w = cloud.cloudSyncStatus().issues.find((x) => x.kind === 'worker_stale');
    ok(w && w.lastOkAt === BEAT, 'the worker_stale row carries lastOkAt = the last worker heartbeat');
    global.fetch = health({ ok: true, processes: [{ process: 'runtime', beatAt: new Date().toISOString(), ageSeconds: 5, stale: false }] });
    await cloud.cloudHealthPing();
    const c = loadState().cloudContact;
    ok(c.workerStale === false && c.workerBeatAt == null, 'a healthy ping clears workerStale and workerBeatAt');
    global.fetch = realFetch;
  }
  freshContact();

  // --- local-only lanes never colour the cloud dot -------------------------------------
  // reddit is a LOCAL-ONLY lane (telegram is now a CLOUD lane), so an overdue reddit-only
  // post is the local scheduler's job and must not touch the cloud guarantee dot.
  await createPost({ campaign: CAMP, post: { id: 'p-rd', type: 'text', platforms: ['reddit'], scheduledAt: '2020-01-01T00:00:00Z', caption: 'a quiet reddit note' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'p-rd', actor: 'owner' });
  const g2 = cloud.cloudSyncStatus();
  ok(g2.state === 'green', 'an overdue REDDIT (local-only) post does not colour the cloud dot (cloud lanes only)');

  console.log(`[cloud-sync-status] OK - null/green/yellow/amber/red matrix incl. miss-outranks-unreachable + worker-stale + the acked-but-overdue incident shape (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
