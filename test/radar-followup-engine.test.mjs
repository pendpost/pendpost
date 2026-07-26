#!/usr/bin/env node
// test/radar-followup-engine.test.mjs (spec 44) - the storage stamp + the mock verb path.
//
// Covers the pieces the pure-parser test can't: stampFollowup's storage shape + terminal
// discipline, needsFollowupCheck's due predicate, and the mock `radar-followup` verb driving
// a real plan file end to end (loadPlan -> stamp -> savePlan). Mock path === live path: the
// verb the reconcile spawns in mock mode IS this handler.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stampFollowup, needsFollowupCheck } from '../lib/radar.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)})`); console.log(`  ok - ${msg}`); pass += 1; };

// ---- stampFollowup: storage shape + terminal discipline
{
  const found = stampFollowup({ id: 'p' }, { replied: true, author: 'jane', text: 'thanks', permalink: 'https://x/1', ts: '2026-07-16T11:00:00.000Z' }, '2026-07-16T12:00:00.000Z');
  eq(found.radarReplyState, 'author_replied', 'stamp: hit sets terminal author_replied');
  eq(found.radarFollowup.author, 'jane', 'stamp: record author');
  eq(found.radarFollowup.permalink, 'https://x/1', 'stamp: record permalink');
  eq(found.radarFollowup.lastCheckedTs, '2026-07-16T12:00:00.000Z', 'stamp: lastCheckedTs set');

  const miss = stampFollowup({ id: 'q' }, null, '2026-07-16T12:00:00.000Z');
  eq(miss.radarReplyState, undefined, 'stamp: a miss never sets a reply state');
  eq(miss.radarFollowup.lastCheckedTs, '2026-07-16T12:00:00.000Z', 'stamp: a miss still records lastCheckedTs');
  ok(!('author' in miss.radarFollowup), 'stamp: a miss records no author');

  // a later miss must NOT erase a previously-found reply
  const prev = { id: 'r', radarReplyState: 'author_replied', radarFollowup: { author: 'jane', text: 't', permalink: 'p', ts: 'x', lastCheckedTs: 'old' } };
  stampFollowup(prev, null, '2026-07-16T13:00:00.000Z');
  eq(prev.radarReplyState, 'author_replied', 'stamp: a later miss keeps the found terminal state');
  eq(prev.radarFollowup.author, 'jane', 'stamp: a later miss keeps the found author');
  eq(prev.radarFollowup.lastCheckedTs, '2026-07-16T13:00:00.000Z', 'stamp: a later miss refreshes lastCheckedTs');
}

// ---- needsFollowupCheck: only posted, API-precise, non-terminal replies are due
{
  const base = { status: 'posted', radarReplyTo: { source: 'reddit', externalId: 't3_x' } };
  ok(needsFollowupCheck(base) === true, 'due: a posted reddit reply is due');
  ok(needsFollowupCheck({ ...base, status: 'planned' }) === false, 'due: an unposted reply is not due');
  ok(needsFollowupCheck({ ...base, radarReplyState: 'author_replied' }) === false, 'due: an already-answered reply is not due');
  ok(needsFollowupCheck({ ...base, radarReplyState: 'target_gone' }) === false, 'due: a gone reply is not due');
  ok(needsFollowupCheck({ status: 'posted', radarReplyTo: { source: 'hackernews', externalId: '1' } }) === false, 'due: hacker-news (followup:thread) is not a verb target');
  ok(needsFollowupCheck({ status: 'posted' }) === false, 'due: a non-radar post is never due');
}

// ---- the mock verb over a real plan file (loadPlan -> stamp -> savePlan)
{
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-followup-'));
  const planPath = path.join(WS, 'post-plan.json');
  const plan = { campaign: 'radar', posts: [
    { id: 'reddit-a', status: 'posted', platforms: ['reddit'], redditPostId: 't1_ours', radarReplyTo: { source: 'reddit', externalId: 't3_replied_thread', author: 'buyer_jane', url: 'https://mock.reddit/thread' } },
    { id: 'reddit-b', status: 'posted', platforms: ['reddit'], redditPostId: 't1_quiet', radarReplyTo: { source: 'reddit', externalId: 't3_quiet_thread', author: 'buyer_bob', url: 'https://mock.reddit/quiet' } },
    { id: 'masto-x', status: 'posted', platforms: ['mastodon'], radarReplyTo: { source: 'mastodon', externalId: 'ignored' } }, // wrong lane for a reddit run
  ] };
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

  const env = await runMockCommand({ platform: 'reddit', command: 'radar-followup', planPath, only: null });
  ok(env.ok === true, 'mock verb: returns ok');
  const rows = env.results.filter((r) => r.action === 'radar-followup');
  eq(rows.length, 2, 'mock verb: processes both reddit replies, skips the mastodon one');

  const saved = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const a = saved.posts.find((p) => p.id === 'reddit-a');
  const b = saved.posts.find((p) => p.id === 'reddit-b');
  eq(a.radarReplyState, 'author_replied', 'mock verb: the "replied" target reaches author_replied');
  ok(a.radarFollowup && a.radarFollowup.permalink && a.radarFollowup.author === 'buyer_jane', 'mock verb: a stamped author-reply record');
  eq(b.radarReplyState, undefined, 'mock verb: the quiet thread gets no reply state');
  ok(b.radarFollowup && b.radarFollowup.lastCheckedTs && !b.radarFollowup.author, 'mock verb: the quiet thread records only lastCheckedTs');

  // idempotent: a second run does not re-touch the already-answered post
  const env2 = await runMockCommand({ platform: 'reddit', command: 'radar-followup', planPath, only: null });
  const rows2 = env2.results.filter((r) => r.action === 'radar-followup');
  eq(rows2.length, 1, 'mock verb: the answered post is terminal - only the quiet one is re-checked');

  fs.rmSync(WS, { recursive: true, force: true });
}

console.log(`\n${pass} assertions passed`);
