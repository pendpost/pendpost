#!/usr/bin/env node
// test/radar-reply-state.test.mjs - "overdue" is a claim about an APPROVED post.
//
// queueRadarReply stamps scheduledAt = now so an approved reply fires on the next
// tick (reply timeliness). But it is born approval:'pending', so deriveState marked
// it 'overdue' the moment it was created: the operator saw a red "overdue" pill on a
// draft nobody had looked at yet. "Overdue" only means something for a post the
// scheduler WOULD have fired - i.e. an approved one. For a radar reply, scheduledAt
// is a "fire when approved" marker, not a slot it missed.
//
// Two exemptions from the schedule-overdue alarm while UNAPPROVED:
//   1. a post carrying radarReplyTo (its due clock starts at approval), AND
//   2. a self-post / local-only post - one whose every lane is reddit/tiktok/
//      pinterest/gbp (owner rule: overdue there requires approval; nothing but the
//      owner posting it can fire it, so it belongs in Freigaben, not Ueberfaellig).
// A NORMAL unapproved post on a CLOUD or NATIVE lane (instagram/x/linkedin/telegram/
// discord/nostr/youtube/...) past its slot STAYS 'overdue' - App.jsx overdueCount
// drives the sidebar at-risk alert, and a late post awaiting approval there is exactly
// when the operator most needs that signal. Do NOT widen the exemption to "any
// unapproved post is never overdue".
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-reply-state-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { normalizePost } = await import('../lib/plans.mjs');

const NOW = Date.parse('2026-07-15T12:00:00Z');
const PAST = '2026-07-15T11:00:00Z';
const FUTURE = '2026-07-15T13:00:00Z';
const REPLY_TO = { url: 'https://mastodon.social/@x/1', source: 'mastodon', externalId: '1' };

const PLAN_ENTRY = { id: 'radar' };
const PLAN = { timezone: 'UTC' };
const stateOf = (post) => normalizePost(PLAN_ENTRY, PLAN, { type: 'text', ...post }, NOW).derivedState;

try {
  // ---- the defect: an unapproved radar reply must not wear a red "overdue" ----
  ok(stateOf({ id: 'r1', platforms: ['mastodon'], scheduledAt: PAST, approval: 'pending', radarReplyTo: REPLY_TO }) === 'waiting-due',
    'a PENDING radar reply past its scheduledAt is waiting-due, not overdue');
  ok(stateOf({ id: 'r2', platforms: ['mastodon'], scheduledAt: PAST, approval: 'draft', radarReplyTo: REPLY_TO }) === 'waiting-due',
    'a DRAFT radar reply past its scheduledAt is waiting-due, not overdue');
  ok(stateOf({ id: 'r3', platforms: ['reddit'], scheduledAt: PAST, radarReplyTo: REPLY_TO }) === 'waiting-due',
    'a radar reply with NO approval field (fail-closed draft) is waiting-due, not overdue');

  // ---- the due clock starts at approval -------------------------------------
  ok(stateOf({ id: 'r4', platforms: ['mastodon'], scheduledAt: PAST, approval: 'approved', radarReplyTo: REPLY_TO }) === 'overdue',
    'an APPROVED radar reply past due IS overdue (the scheduler would have fired it)');
  ok(stateOf({ id: 'r5', platforms: ['mastodon'], scheduledAt: FUTURE, approval: 'pending', radarReplyTo: REPLY_TO }) === 'waiting-due',
    'a not-yet-due pending radar reply is waiting-due (unchanged)');

  // ---- C1 regression guard: cloud/native lanes still alarm while unapproved ---
  // Widening the exemption to "any unapproved post" would silently zero the sidebar
  // at-risk alert (App.jsx overdueCount) for every late post awaiting approval.
  ok(stateOf({ id: 'n1', platforms: ['instagram'], scheduledAt: PAST, approval: 'pending' }) === 'overdue',
    'a NORMAL pending post past due is STILL overdue (at-risk signal preserved)');
  ok(stateOf({ id: 'n2', platforms: ['instagram'], scheduledAt: PAST, approval: 'draft' }) === 'overdue',
    'a NORMAL draft post past due is STILL overdue (at-risk signal preserved)');
  ok(stateOf({ id: 'n3', platforms: ['instagram'], scheduledAt: PAST }) === 'overdue',
    'a NORMAL post with no approval field past due is STILL overdue');
  ok(stateOf({ id: 'n4', platforms: ['x'], scheduledAt: PAST, approval: 'draft' }) === 'overdue',
    'a DRAFT post on a CLOUD lane (x) past due is STILL overdue (cloud keeps alarming)');

  // ---- self-post / local-only lanes: overdue requires approval (owner rule) ----
  // A standalone (non-reply) post whose every lane is reddit/tiktok/pinterest/gbp
  // never fires without the owner, so an UNAPPROVED one past its slot belongs in
  // Freigaben, not the red Ueberfaellig alarm.
  for (const lane of ['reddit', 'tiktok', 'pinterest', 'gbp']) {
    ok(stateOf({ id: `sp-${lane}`, platforms: [lane], scheduledAt: PAST, approval: 'draft' }) === 'waiting-due',
      `a DRAFT self-post ${lane} post past due is waiting-due, NOT overdue`);
    ok(stateOf({ id: `sp-${lane}-p`, platforms: [lane], scheduledAt: PAST, approval: 'pending' }) === 'waiting-due',
      `a PENDING self-post ${lane} post past due is waiting-due, NOT overdue`);
    ok(stateOf({ id: `sp-${lane}-a`, platforms: [lane], scheduledAt: PAST, approval: 'approved' }) === 'overdue',
      `an APPROVED self-post ${lane} post past due IS overdue (the scheduler would have fired it)`);
  }
  // A mixed post that ALSO targets a cloud lane is not self-post-only, so it keeps alarming.
  ok(stateOf({ id: 'sp-mixed', platforms: ['reddit', 'x'], scheduledAt: PAST, approval: 'draft' }) === 'overdue',
    'a DRAFT post targeting a cloud lane alongside reddit is STILL overdue (not self-post-only)');

  // ---- the other axes of deriveState are untouched ---------------------------
  ok(stateOf({ id: 'p1', platforms: ['mastodon'], scheduledAt: PAST, approval: 'pending', radarReplyTo: REPLY_TO, executionMode: 'parked' }) === 'parked',
    'a parked radar reply still reads parked (executionMode wins over the exemption)');
  ok(stateOf({ id: 'p2', platforms: ['mastodon'], scheduledAt: PAST, approval: 'pending', radarReplyTo: REPLY_TO, status: 'posted' }) === 'posted',
    'a posted radar reply still reads posted');

  // ---- Fix B: a self-post post never wears a CLOUD failure (relic guard) ------
  // lastFailureFor reads state.cloudFailures[campaign:postId] (keyed WITHOUT a lane).
  // A lingering relic entry must not paint a local-only self-post post as a cloud
  // publish-failed. An APPROVED reddit post past due normally reads 'overdue'; a
  // stray cloud failure record must NOT flip it to 'publish-failed'.
  const { loadState, saveState } = await import('../lib/state.mjs');
  const st = loadState();
  st.cloudFailures = { 'radar:cf1': { lane: 'x', jobId: 'default:radar:cf1:x', message: 'stale relic', at: PAST } };
  saveState();
  ok(stateOf({ id: 'cf1', platforms: ['reddit'], scheduledAt: PAST, approval: 'approved' }) === 'overdue',
    'an approved self-post reddit post with a relic cloud failure reads overdue, NOT publish-failed');

  console.log(`\nradar-reply-state: ${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
