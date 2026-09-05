#!/usr/bin/env node
// test/radar-followup-report.test.mjs - the fenced, evidence-gated agent follow-up report
// (engagement engine, owner decision 4).
//
// The reporting child reads UNTRUSTED public threads, and "the author replied" is a stamp
// that promotes a signal to the top of the feed and arms the round-2 reply target - so a
// fabricated claim must be structurally impossible, not merely discouraged:
//   - THE FENCE FAILS CLOSED: disarmed -> every call refused (no chat-agent/operator path
//     exists for this tool); armed -> only the exact enumerated targets.
//   - EVERY evidence gate refuses a fabrication: author must match pendpost's own recorded
//     snapshot; the permalink must live on the lane's own host and prove the SAME thread;
//     the commentId must have the lane's native shape (and stays a LEGAL round-2 target);
//     no recorded author -> no stamp at all (stamped:false), never a guess.
//   - a verified hit stamps the BYTE-IDENTICAL radarFollowup shape the engine verbs write
//     (+ additive via:'agent'), accretes the engager, and round-trips into a legal
//     queueRadarReply parentExternalId. replied:false stamps lastCheckedTs only; terminal
//     states are never un-set. Stamping never posts anything.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-followup-report-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

try {
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  const { createCampaign, radarFollowupReport, radarIngest, markCopyPosted, queueRadarReply } = await import('../lib/writes.mjs');
  const { beginFollowupFence, endFollowupFence, followupTargetAllowed } = await import('../lib/agent-runner.mjs');
  const { loadState } = await import('../lib/state.mjs');

  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { enabled: true, queries: [{ id: 'q1', label: 'q', keywords: ['schedule'] }] } } } });
  await createCampaign({ id: 'c1', displayName: 'C', timezone: 'UTC', actor: 'owner' });

  // A POSTED youtube reply post (the plan-post target) with the author snapshot pendpost
  // records at queue time, and an x copy-posted ledger target with a cached-signal author.
  const planPath = path.join(WS, 'data', 'plans', 'c1', 'post-plan.json');
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  plan.posts = [{
    id: 'yt-reply-1', type: 'text', platforms: ['youtube'], caption: 'our helpful reply',
    status: 'posted', postedAt: '2026-08-16T10:00:00.000Z', ytCommentId: 'our-comment-1',
    radarReplyTo: { url: 'https://youtube.com/watch?v=vid1', source: 'youtube', externalId: 'vid1', author: 'Buyer_Jane' },
  }];
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  await radarIngest({ queryId: 'q1', signals: [{ source: 'x', ts: new Date().toISOString(), externalId: 'tw1', url: 'https://x.com/buyer_bob/status/1', author: 'buyer_bob', text: 'anyone know a scheduler?' }], actor: 'agent:claude' });
  await markCopyPosted({ source: 'x', externalId: 'tw1', postedUrl: 'https://x.com/pendpost/status/2', actor: 'owner' });
  await markCopyPosted({ source: 'x', externalId: 'tw_orphan', actor: 'owner' }); // no cached signal -> no author snapshot

  const report = (args) => radarFollowupReport({ actor: 'agent:radar-followup', ...args });
  const VALID_YT = {
    source: 'youtube', externalId: 'vid1', replied: true, author: 'buyer_jane',
    permalink: 'https://youtube.com/watch?v=vid1&lc=UgxReply42', commentId: 'UgxReply42',
    text: 'Thanks, that fixed it for me!', ts: '2026-08-17T09:00:00.000Z',
  };

  // ===== (1) the fence fails CLOSED =====
  ok(followupTargetAllowed('youtube vid1') === false, 'disarmed: followupTargetAllowed refuses (fail-closed - the draft fence inversion)');
  const disarmed = await report(VALID_YT);
  ok(disarmed.code === 'invalid_input' && /inert|brief/.test(disarmed.message || ''),
    'disarmed: a fully valid report is refused - outside a follow-up job the tool is inert');

  beginFollowupFence(['youtube vid1', 'x tw1', 'x tw_orphan']);

  const unlisted = await report({ ...VALID_YT, externalId: 'vid_other', permalink: 'https://youtube.com/watch?v=vid_other' });
  ok(unlisted.code === 'invalid_input', 'armed: an UNENUMERATED target is refused - the child checks only what pendpost listed');

  // ===== (2) evidence gates, each fabrication refused =====
  const wrongAuthor = await report({ ...VALID_YT, author: 'someone_else' });
  ok(wrongAuthor.code === 'invalid_input' && /author/.test(wrongAuthor.message || ''),
    'author mismatch vs the recorded snapshot -> refused (someone else replying is not the author answering)');

  const wrongHost = await report({ ...VALID_YT, permalink: 'https://evil.example/watch?v=vid1' });
  ok(wrongHost.code === 'invalid_input', 'a permalink off the lane\'s own host is refused (host allow-list)');

  const wrongThread = await report({ ...VALID_YT, permalink: 'https://youtube.com/watch?v=DIFFERENT' });
  ok(wrongThread.code === 'invalid_input', 'a youtube permalink that does not reference the SAME video is refused (thread mismatch)');

  const badCid = await report({ ...VALID_YT, commentId: 'x!' });
  ok(badCid.code === 'invalid_input', 'a malformed commentId (not the lane\'s native shape) is refused');

  const noText = await report({ ...VALID_YT, text: '' });
  ok(noText.code === 'invalid_input', 'a replied:true claim with no text is refused');

  const badTs = await report({ ...VALID_YT, ts: '2026-08-15T09:00:00.000Z' });
  ok(badTs.code === 'invalid_input', 'a ts BEFORE our reply was posted is refused (the author cannot have answered then)');

  // x-lane specifics on the ledger target
  const xWrongPath = await report({ source: 'x', externalId: 'tw1', replied: true, author: 'buyer_bob', permalink: 'https://x.com/i/lists/9', commentId: '12345', text: 'yes!' });
  ok(xWrongPath.code === 'invalid_input', 'an x permalink that is not /<handle>/status/<id> is refused');
  const xWrongHandle = await report({ source: 'x', externalId: 'tw1', replied: true, author: 'buyer_bob', permalink: 'https://x.com/not_bob/status/33', commentId: '33', text: 'yes!' });
  ok(xWrongHandle.code === 'invalid_input', 'an x permalink whose handle is not the claimed author is refused');
  const xBadCid = await report({ source: 'x', externalId: 'tw1', replied: true, author: 'buyer_bob', permalink: 'https://x.com/buyer_bob/status/33', commentId: 'abc', text: 'yes!' });
  ok(xBadCid.code === 'invalid_input', 'an x commentId that is not the numeric tweet id is refused');

  // no recorded author: no stamp, an honest reason, lastCheckedTs still recorded
  const orphan = await report({ source: 'x', externalId: 'tw_orphan', replied: true, author: 'whoever', permalink: 'https://x.com/whoever/status/44', commentId: '44', text: 'hi' });
  ok(orphan.ok === true && orphan.stamped === false && orphan.reason === 'no_recorded_author',
    'no recorded author snapshot -> stamped:false reason:no_recorded_author (we looked, we cannot verify, we never guess)');
  {
    const e = loadState().radar.copyPosted.find((x) => x.externalId === 'tw_orphan');
    ok(e.radarFollowup && e.radarFollowup.lastCheckedTs && e.radarReplyState !== 'author_replied',
      'the no-author target still records lastCheckedTs - "we looked" is true, "they replied" is not stamped');
  }

  // ===== (3) replied:false stamps lastCheckedTs ONLY =====
  const quiet = await report({ source: 'youtube', externalId: 'vid1', replied: false });
  ok(quiet.ok === true && quiet.replied === false && quiet.stamped === true, 'replied:false is accepted with no evidence fields');
  {
    const p = JSON.parse(fs.readFileSync(planPath, 'utf8')).posts.find((x) => x.id === 'yt-reply-1');
    ok(p.radarFollowup && p.radarFollowup.lastCheckedTs && !p.radarFollowup.author && p.radarReplyState === undefined,
      'replied:false stamped lastCheckedTs only - no author, no reply state');
  }

  // ===== (4) the valid report stamps the byte-identical shape =====
  const hit = await report(VALID_YT);
  ok(hit.ok === true && hit.stamped === true && hit.state === 'author_replied' && hit.commentId === 'UgxReply42',
    'a fully evidenced youtube report is accepted and stamped');
  {
    const p = JSON.parse(fs.readFileSync(planPath, 'utf8')).posts.find((x) => x.id === 'yt-reply-1');
    ok(p.radarReplyState === 'author_replied', 'the post carries the terminal author_replied state');
    ok(p.radarFollowup.author === 'buyer_jane' && p.radarFollowup.text === 'Thanks, that fixed it for me!'
      && p.radarFollowup.permalink === 'https://youtube.com/watch?v=vid1&lc=UgxReply42'
      && p.radarFollowup.ts === '2026-08-17T09:00:00.000Z' && p.radarFollowup.commentId === 'UgxReply42'
      && typeof p.radarFollowup.lastCheckedTs === 'string',
      'radarFollowup carries the BYTE-IDENTICAL field set the engine verbs stamp (author/text/permalink/ts/commentId/lastCheckedTs)');
    ok(p.radarFollowup.via === 'agent', 'plus the ADDITIVE via:agent provenance mark, set after the stamp');
  }
  {
    const engagers = loadState().engagers || {};
    const key = Object.keys(engagers).find((k) => k.includes('buyer_jane'));
    ok(Boolean(key) && engagers[key].exchanges.some((e) => e.ref === 'UgxReply42'),
      'the answering author accretes into relationship memory (stampFollowupEngager), ref = the reply commentId');
  }

  // ===== (5) terminal is never un-set =====
  const after = await report({ source: 'youtube', externalId: 'vid1', replied: false });
  ok(after.ok === true, 'a later replied:false on a found target is accepted');
  {
    const p = JSON.parse(fs.readFileSync(planPath, 'utf8')).posts.find((x) => x.id === 'yt-reply-1');
    ok(p.radarReplyState === 'author_replied' && p.radarFollowup.author === 'buyer_jane',
      'the terminal author_replied + its evidence SURVIVE a later miss (a found fact is never un-found)');
  }

  // ===== (6) the stamped commentId is a LEGAL round-2 target =====
  endFollowupFence();
  ok(followupTargetAllowed('youtube vid1') === false, 'the fence disarms in finally-style - and back to fail-closed');
  const round2 = await queueRadarReply({
    campaign: 'c1', signalUrl: 'https://youtube.com/watch?v=vid1', source: 'youtube', externalId: 'vid1',
    parentExternalId: 'UgxReply42', text: 'Glad it helped! Ping me if the export trips you up.',
    actor: 'owner', confirm: true,
  });
  ok(round2.ok === true && round2.parentExternalId === 'UgxReply42' && round2.approval === 'pending',
    'ROUND TRIP: the stamped commentId flows capturedFollowupCommentId -> a legal queueRadarReply parentExternalId, and the round-2 reply queues PENDING');

  console.log(`\n[radar-followup-report] OK - fail-closed fence, every fabrication refused structurally, byte-identical stamp + engager accretion + via:agent, terminal never un-set, and the commentId round-trips into round 2 (${pass} assertions).`);
} finally {
  try { (await import('../lib/agent-runner.mjs')).endFollowupFence(); } catch { /* already disarmed */ }
  fs.rmSync(WS, { recursive: true, force: true });
}
