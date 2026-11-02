#!/usr/bin/env node
// test/reply-alerts.test.mjs - new replies raise the digest line and the push (planner-bulk
// contract 2026-11-01, row R8 at the engine level).
//
//  (A) radarDigestLines carries a "Replies to you" line: new since yesterday + still unanswered,
//      and it opens the Radar section on its own; nothing waiting -> no line (byte-unchanged).
//  (B) digestReplyCounts reads the sweep's cache only while the monitor is on.
//  (C) generateDigest prints the line even with Radar search off.
//  (D) the push: one message per batch on Telegram + macOS, ONLY for items new since the last
//      push; the first run primes the watermark (no backlog dump); exactly once per channel; a
//      transient failure is retried; a monitor that is off is byte-unchanged.
//
// Injected senders, temp workspace, no network.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-reply-alerts-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));

const { radarDigestLines } = await import('../lib/radar.mjs');
const { digestReplyCounts, generateDigest } = await import('../lib/insights.mjs');
const { pushSweep } = await import('../lib/engage-asks.mjs');
const { engagePushText } = await import('../lib/notify.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');

const t = (key, vars = {}) => `${key}${Object.keys(vars).length ? ` ${JSON.stringify(vars)}` : ''}`;
const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3600e3).toISOString();

try {
  // ---- (A) the digest line ---------------------------------------------------------------
  let lines = radarDigestLines({}, t, { replies: { fresh: 3, unanswered: 7 } });
  ok(lines[0] === 'radar.digest.section' && lines[1] === 'radar.digest.replies.new {"fresh":3,"unanswered":7}', 'digest: new + unanswered line, and it opens the section on its own');
  lines = radarDigestLines({}, t, { replies: { fresh: 0, unanswered: 2 } });
  ok(lines[1] === 'radar.digest.replies.waiting {"fresh":0,"unanswered":2}', 'digest: nothing new, two still waiting -> the waiting line');
  ok(radarDigestLines({}, t, { replies: { fresh: 0, unanswered: 0 } }).length === 0 && radarDigestLines({}, t).length === 0, 'digest: nothing waiting -> no section (byte-unchanged)');
  const { STRINGS } = await import('../lib/i18n.mjs');
  const copy = Object.values(STRINGS).flatMap((pack) => Object.entries(pack).filter(([k]) => k.startsWith('radar.digest.replies')).map(([, v]) => v));
  ok(copy.length === 4 && copy.every((v) => !/[\u2014\u2013]/.test(v)), 'digest copy: en + de-CH, no em or en dash');

  // ---- (B) the counts ----------------------------------------------------------------------
  const state = { comments: { items: [{ foundAt: hoursAgo(2) }, { foundAt: hoursAgo(5) }, { foundAt: hoursAgo(30) }] } };
  ok(JSON.stringify(digestReplyCounts(state, { enabled: true }, NOW)) === '{"fresh":2,"unanswered":3}', 'counts: fresh = found in the last 24 h, unanswered = all waiting');
  ok(JSON.stringify(digestReplyCounts(state, { enabled: false }, NOW)) === '{"fresh":0,"unanswered":0}', 'counts: zero while the monitor is off');

  // ---- (C) generateDigest with Radar search off --------------------------------------------
  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { commentWatch: { enabled: true } } } });
  const st = loadState();
  st.comments = { items: [{ kind: 'mention', lane: 'mastodon', commentId: 'a', foundAt: new Date().toISOString() }], seen: [], sources: {} };
  saveState();
  const digest = await generateDigest({});
  const text = typeof digest === 'string' ? digest : JSON.stringify(digest);
  ok(/Replies to you: 1 new since yesterday, 1 still unanswered|Antworten an dich/.test(text), 'generateDigest: the reply line shows with Radar search off');

  // ---- (D) the push --------------------------------------------------------------------------
  const tg = [];
  const mac = [];
  let tgMode = 'ok';
  const send = async (text) => { tg.push(text); return tgMode === 'down' ? { ok: false, code: 'send_failed' } : { ok: true }; };
  const notify = async (ask) => { mac.push(ask); return { ok: true, delivered: true }; };
  const setItems = (items) => { const s = loadState(); s.comments = { ...(s.comments || {}), items }; saveState(); };
  const s0 = loadState();
  s0.comments = { items: [{ kind: 'comment', lane: 'meta', platform: 'instagram', commentId: 'old', foundAt: hoursAgo(50) }], seen: [], sources: {} };
  saveState();
  let r = await pushSweep({ send, notify, now: NOW });
  ok(r.ran === false && r.replies.primed === true && tg.length === 0 && mac.length === 0, 'push: the first run primes the watermark and does not push the backlog');
  ok(loadState().comments.lastPushAt === hoursAgo(50), 'push: the watermark is the newest item already there');
  r = await pushSweep({ send, notify, now: NOW });
  ok(r.replies.sent === 0 && tg.length === 0, 'push: nothing new -> nothing sent');

  setItems([...loadState().comments.items,
    { kind: 'reply', lane: 'meta', platform: 'instagram', commentId: 'n1', foundAt: hoursAgo(1) },
    { kind: 'mention', lane: 'mastodon', platform: 'mastodon', commentId: 'n2', foundAt: hoursAgo(1) },
  ]);
  r = await pushSweep({ send, notify, now: NOW });
  ok(r.replies.sent === 2 && tg.length === 1 && mac.length === 1, 'push: two new replies -> one Telegram message and one macOS notification');
  ok(/^2 new replies to you on instagram, mastodon\. Open Radar to answer\. http:\/\/127\.0\.0\.1:\d+\/#radar$/.test(tg[0]), `push: one plain sentence with the count, the platforms and the Radar link (${tg[0]})`);
  ok(engagePushText(mac[0]) === '2 new replies to you on instagram, mastodon. Open Radar to answer.' && !/[\u2014\u2013]/.test(tg[0]), 'push: the macOS text is the same sentence, no em dash');
  r = await pushSweep({ send, notify, now: NOW });
  ok(r.replies.sent === 0 && tg.length === 1 && mac.length === 1, 'push: the same batch is never pushed twice');

  setItems([...loadState().comments.items, { kind: 'radar-reply', lane: 'reddit', platform: 'reddit', commentId: 'n3', foundAt: hoursAgo(0.5) }]);
  tgMode = 'down';
  r = await pushSweep({ send, notify, now: NOW });
  ok(r.replies.sent === 1 && tg.length === 2 && mac.length === 2, 'push: Telegram down -> macOS still lands');
  ok(/^1 new reply to you on reddit\./.test(tg[1]), 'push: only the item new since the last push is counted');
  tgMode = 'ok';
  r = await pushSweep({ send, notify, now: NOW });
  ok(r.replies.sent === 1 && tg.length === 3 && mac.length === 2, 'push: the next tick retries only Telegram');
  r = await pushSweep({ send, notify, now: NOW });
  ok(r.replies.sent === 0 && tg.length === 3, 'push: and then it is done');

  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { commentWatch: { enabled: false } } } });
  setItems([...loadState().comments.items, { kind: 'comment', lane: 'meta', platform: 'facebook', commentId: 'n4', foundAt: new Date(NOW).toISOString() }]);
  const before = JSON.stringify(loadState().comments);
  r = await pushSweep({ send, notify, now: NOW + 1000 });
  ok(r.replies.sent === 0 && tg.length === 3 && JSON.stringify(loadState().comments) === before, 'push: monitor off -> nothing sent, nothing written');

  console.log(`\n${pass} passed`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
