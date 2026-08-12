#!/usr/bin/env node
// test/digest-v2.test.mjs - ux-audit 2026-08-04 R2 ("digest v2"). The digest was a
// terminal artifact: renderable on every face, delivered on none (dim-3 gap 8), silent
// about what the autonomy policies did alone (dim-5 AU3), missing the mention-rate
// trend spec 35 §4 promised (dim-7 parity drift) and blind to lanes that stopped
// being fed. Proves, per piece:
//   1. DELIVERY: posting.digest.notify validated + default ON; notifyDailyDigest()
//      respects the gate and stamps state.notify.lastDigestAt (the autonomy window
//      anchor) without popping a real notification in mock mode.
//   2. AUTONOMY REPORT: the digest leads with what policies did alone since the last
//      digest (auto-approved posts, auto-posted radar replies, refusals by reason
//      class) and SKIPS the whole section when nothing autonomous happened.
//   3. GEO MENTION RATE: one line (current rate + delta) inside the Radar section,
//      only when checks exist.
//   4. CALENDAR GAP: one line naming lanes that published in the last 30 days but
//      have no approved post scheduled in the next 7.
// All lines localized en + de-CH (real umlauts, no eszett), no em dashes.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-digest-v2-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
const writePlans = (posts) => {
  fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({
    plans: [{ id: 'local', path: 'data/plans/local.json', active: true }],
  }, null, 2));
  fs.writeFileSync(path.join(WS, 'data', 'plans', 'local.json'), JSON.stringify({ campaign: 'local', posts }, null, 2));
};
writePlans([]);

const { getConfig, setConfig, getPosting } = await import('../lib/config.mjs');
const { notifyDailyDigest } = await import('../lib/notify.mjs');
const { generateDigest } = await import('../lib/insights.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const { appendActivity } = await import('../lib/scheduler.mjs');

const now = Date.now();
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

try {
  // ================= piece 1: delivery =================
  ok(getPosting().digest?.notify === true, 'posting.digest.notify defaults ON (delivery is the default, silence is the opt-in)');

  let res = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { digest: { notify: false } } } });
  ok(res.ok === true && getPosting().digest.notify === false, 'the owner can turn the digest notification off via posting.digest.notify');
  ok(setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { digest: { notify: 'no' } } } }).code === 'invalid_input', 'digest.notify must be a boolean');
  ok(setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { digest: { junk: 1 } } } }).code === 'invalid_input', 'digest refuses an unknown key');

  // Gate OFF: no delivery, no window stamp.
  res = await notifyDailyDigest();
  ok(res.delivered === false && res.reason === 'disabled', 'notify:false silences the daily digest notification');
  ok(!loadState().notify?.lastDigestAt, 'a silenced digest does NOT stamp lastDigestAt');

  // Gate ON (default): delivered, window stamped; mock mode never pops a real popup
  // (unprovable here, but the mock guard is the same one notifyRadarScanDone uses).
  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { digest: { notify: true } } } });
  res = await notifyDailyDigest();
  ok(res.delivered === true, 'with the gate on, the digest notification delivers');
  ok(typeof loadState().notify?.lastDigestAt === 'string', 'delivery stamps state.notify.lastDigestAt (the autonomy-report window anchor)');
  ok(typeof res.body === 'string' && res.body.length > 0 && !res.body.includes('notify.digest'), 'the body is a localized string, not a raw key');
  // Localized body follows posting.locale.
  fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ locale: 'de-CH' }));
  res = await notifyDailyDigest();
  ok(/Digest/.test(res.body) && !/ß/.test(res.body), 'de-CH notification body renders localized, eszett-free');
  fs.rmSync(path.join(WS, 'config.json'), { force: true });

  // ================= piece 2: autonomy report =================
  // Empty project: NO autonomy section at all.
  let st = loadState();
  delete st.notify;
  st.activity = [];
  saveState();
  ok(!generateDigest({ locale: 'en' }).digest.includes('## Autonomy'), 'no autonomous activity => the whole section is skipped');

  // Seed: one auto-approved post, one auto-posted radar reply, three recorded refusals.
  writePlans([
    { id: 'a1', platforms: ['x'], status: 'posted', postedAt: iso(now - 2 * HOUR), approval: 'approved', approvalBy: 'policy:auto-approve', approvalAt: iso(now - 3 * HOUR), scheduledAt: iso(now - 3 * HOUR), caption: 'Auto post', xPostId: '1811111111111111111' },
    { id: 'rep1', platforms: ['mastodon'], status: 'posted', postedAt: iso(now - 1 * HOUR), approval: 'approved', approvalBy: 'policy:auto-approve', approvalAt: iso(now - 2 * HOUR), scheduledAt: iso(now - 2 * HOUR), caption: 'Reply', mastodonStatusId: '111', radarReplyTo: { source: 'mastodon', externalId: 'e1', url: 'https://mastodon.example/1' } },
    { id: 'h1', platforms: ['linkedin'], status: 'draft', approval: 'pending', caption: 'Human post', scheduledAt: iso(now + 2 * DAY) },
  ]);
  appendActivity({ campaign: 'local', postId: 'x9', platform: 'mastodon', action: 'auto-approve-refused', ok: true, errorCode: null, errorMessage: null, reason: 'foreign_link', lateMin: null, actor: 'policy:auto-approve' });
  appendActivity({ campaign: 'local', postId: 'x8', platform: 'mastodon', action: 'auto-approve-refused', ok: true, errorCode: null, errorMessage: null, reason: 'foreign_link', lateMin: null, actor: 'policy:auto-approve' });
  appendActivity({ campaign: 'local', postId: 'x7', platform: null, action: 'auto-approve-refused', ok: true, errorCode: null, errorMessage: null, reason: 'lint', lateMin: null, actor: 'policy:auto-approve' });

  let dEn = generateDigest({ locale: 'en' });
  ok(dEn.digest.includes('## Autonomy'), 'autonomy section renders when policies acted');
  ok(dEn.digest.indexOf('## Autonomy') < dEn.digest.indexOf('## Published'), 'the digest LEADS with the autonomy report (review by exception)');
  ok(/Auto-approved by policy: 1 post\b/.test(dEn.digest), 'auto-approved count (the radar reply is counted separately, not double)');
  ok(/Auto-posted Radar replies: 1/.test(dEn.digest), 'auto-posted radar reply count');
  ok(/Held for review: 3 \(2 foreign link, 1 brand lint\)/.test(dEn.digest), 'refusals grouped by reason class (the fences teach)');
  let dDe = generateDigest({ locale: 'de-CH' });
  ok(dDe.digest.includes('## Autonomie'), 'de-CH autonomy header');
  ok(/Automatisch freigegeben \(Richtlinie\): 1 Beitrag\b/.test(dDe.digest), 'de-CH auto-approved line');
  ok(/Zur Prüfung zurückgehalten: 3 \(2 fremder Link, 1 Brand-Lint\)/.test(dDe.digest), 'de-CH held line with localized reason classes');
  ok(!/ß/.test(dDe.digest) && /[äöü]/.test(dDe.digest), 'de-CH digest keeps Swiss orthography (umlauts, no eszett)');
  ok(!dEn.digest.includes('—') && !dDe.digest.includes('—'), 'no em dashes in either digest');

  // The window: activity/approvals BEFORE the last digest are not re-reported.
  st = loadState();
  st.notify = { ...(st.notify || {}), lastDigestAt: iso(now - 1.5 * HOUR) };
  saveState();
  dEn = generateDigest({ locale: 'en' });
  ok(!/Auto-approved by policy/.test(dEn.digest), 'an approval OLDER than lastDigestAt drops out of the report');
  ok(/Auto-posted Radar replies: 1/.test(dEn.digest), 'the reply POSTED after lastDigestAt stays in');
  st = loadState();
  delete st.notify;
  st.activity = [];
  saveState();

  // ================= piece 3: GEO mention-rate line =================
  writePlans([]);
  st = loadState();
  st.radar = {
    signals: [],
    geo: {
      comparisonBacklog: [],
      footprint: [
        { question: 'q1', mentioned: true, ts: iso(now - 1 * DAY) },
        { question: 'q2', mentioned: false, ts: iso(now - 2 * DAY) },
        { question: 'q1', mentioned: true, ts: iso(now - 8 * DAY) },
        { question: 'q2', mentioned: true, ts: iso(now - 9 * DAY) },
      ],
    },
  };
  saveState();
  ok(!/AI visibility/.test(generateDigest({ locale: 'en' }).digest), 'radar OFF: no mention-rate line (the beta gate wins)');
  fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ radar: { enabled: true } }));
  dEn = generateDigest({ locale: 'en' });
  ok(/## Radar \(beta\)/.test(dEn.digest), 'checks alone are enough to open the Radar section (spec 35 §4: the digest carries the trend)');
  ok(/AI visibility: mentioned in 3 of 4 checks \(75%\)/.test(dEn.digest), 'the line carries the SAME overall rate the panel shows');
  ok(/\(-50 points vs the 7 days before\)/.test(dEn.digest), 'the delta compares the last 7 days against the 7 before (50% now vs 100% then)');
  dDe = generateDigest({ locale: 'de-CH' });
  ok(/KI-Sichtbarkeit: in 3 von 4 Prüfungen erwähnt \(75%\)/.test(dDe.digest), 'de-CH mention-rate line');
  ok(!/ß/.test(dDe.digest), 'de-CH stays eszett-free with the geo line rendered');
  // Only-recent checks: rate renders, delta omits (never a fabricated baseline).
  st = loadState();
  st.radar.geo.footprint = [{ question: 'q1', mentioned: true, ts: iso(now - 1 * DAY) }];
  saveState();
  dEn = generateDigest({ locale: 'en' });
  ok(/AI visibility: mentioned in 1 of 1 checks \(100%\)/.test(dEn.digest) && !/points vs/.test(dEn.digest), 'with no prior-week checks the delta is omitted, never invented');
  // No checks at all: no line.
  st = loadState();
  st.radar.geo.footprint = [];
  saveState();
  ok(!/AI visibility/.test(generateDigest({ locale: 'en' }).digest), 'no checks => no mention-rate line');
  fs.rmSync(path.join(WS, 'config.json'), { force: true });
  st = loadState();
  delete st.radar;
  saveState();

  // ================= piece 4: calendar gap line =================
  writePlans([
    // x published 5 days ago, nothing approved upcoming -> gap.
    { id: 'g1', platforms: ['x'], status: 'posted', postedAt: iso(now - 5 * DAY), scheduledAt: iso(now - 5 * DAY), caption: 'was live', xPostId: '181' },
    // mastodon published 10 days ago AND has an approved post in 2 days -> covered.
    { id: 'g2', platforms: ['mastodon'], status: 'posted', postedAt: iso(now - 10 * DAY), scheduledAt: iso(now - 10 * DAY), caption: 'was live', mastodonStatusId: '2' },
    { id: 'g3', platforms: ['mastodon'], status: 'draft', approval: 'approved', approvalBy: 'owner', approvalAt: iso(now - 1 * DAY), scheduledAt: iso(now + 2 * DAY), caption: 'coming' },
  ]);
  dEn = generateDigest({ locale: 'en' });
  ok(/Calendar gap: X\b/.test(dEn.digest), 'a lane that published in the last 30 days with nothing approved next 7 is named');
  ok(!/Calendar gap:.*Mastodon/.test(dEn.digest), 'a lane with an approved upcoming post is NOT named');
  dDe = generateDigest({ locale: 'de-CH' });
  ok(/Kalenderlücke: X\b/.test(dDe.digest), 'de-CH calendar gap line (real umlaut)');
  // An edited-since-approval post will NOT fire -> it does not cover the lane.
  writePlans([
    { id: 'g1', platforms: ['x'], status: 'posted', postedAt: iso(now - 5 * DAY), scheduledAt: iso(now - 5 * DAY), caption: 'was live', xPostId: '181' },
    { id: 'g4', platforms: ['x'], status: 'draft', approval: 'approved', approvalBy: 'owner', approvalAt: iso(now - 1 * DAY), editedSinceApproval: true, scheduledAt: iso(now + 2 * DAY), caption: 'stale approval' },
  ]);
  ok(/Calendar gap: X\b/.test(generateDigest({ locale: 'en' }).digest), 'an edited-since-approval post does not count as coverage (the scheduler refuses it)');
  // A lane that never published recently is not nagged about.
  writePlans([]);
  ok(!/Calendar gap/.test(generateDigest({ locale: 'en' }).digest), 'no recent publishing => no gap line (never a false alarm)');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[digest-v2] OK - delivery gate + window stamp, autonomy report (skip-when-empty, window, both locales), geo mention-rate line (rate+delta, honest omissions), calendar gap line (${pass} assertions).`);
} catch (err) {
  console.error(`[digest-v2] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
