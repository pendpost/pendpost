#!/usr/bin/env node
// test/comment-watch-linkedin-skip.test.mjs - the sweep must SKIP a lane whose read path cannot
// actually run yet (linkedin: Community Management API product pending, readAvailable:false).
//
// Before this fix, linkedin was enumerated, its read 403'd, and the inbox surfaced a false
// "Kommentare auf LinkedIn koennen gerade nicht gelesen werden" + a misleading reconnect link -
// a dead-end error (canon), because no re-auth grants the pending CMA product. Now the lane is
// skipped (no source row, no nag) and the GUI greys it in settings via the capabilities map.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-cw-li-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });

const NOW = Date.parse('2026-08-10T12:00:00.000Z');
const HOUR = 3600 * 1000;
const recent = new Date(NOW - 2 * 24 * HOUR).toISOString(); // inside the 14d window

// One campaign with a recent YouTube post (available lane) and a recent LinkedIn post
// (readAvailable:false). Mirrors comment-watch.test.mjs' top-level-id post shape.
const CAMP = 'camp1';
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [{ id: CAMP, path: 'data/plans/camp1.json', active: true }] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'plans', 'camp1.json'), JSON.stringify({
  campaign: CAMP,
  posts: [
    { id: 'p-yt', type: 'video', platforms: ['youtube'], ytVideoId: 'yt-1', postedAt: recent, caption: 'my video' },
    { id: 'p-li', type: 'text', platforms: ['linkedin'], liPostId: 'li-1', postedAt: recent, caption: 'my linkedin post' },
  ],
}, null, 2));

const { commentSweep, commentInbox } = await import('../lib/comment-watch.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');
const enable = () => setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { commentWatch: { enabled: true } } } });

// A stub that returns a stranger comment for EVERY target it is asked to read. If linkedin were
// enumerated, its target would be read here and would appear in sources - so its ABSENCE proves
// the skip. LinkedIn's real read would 403; the point is we never even call it.
const readTargets = [];
async function readComments({ campaign, postId, platform }) {
  readTargets.push(platform);
  return { ok: true, items: [{ commentId: `${postId}-c1`, author: 'stranger', text: 'nice', ts: recent, permalink: `https://x/${postId}`, kind: 'comment' }] };
}

try {
  enable();
  await commentSweep({ force: true, now: NOW, readComments });
  const inbox = commentInbox();

  ok(!readTargets.includes('linkedin'), 'sweep: linkedin is never read (skipped before the read)');
  ok(readTargets.includes('youtube'), 'sweep: youtube (available lane) IS read');
  ok(!inbox.sources.linkedin, 'inbox: no linkedin source row -> no false "cannot be read" degrade');
  ok(inbox.sources.youtube && inbox.sources.youtube.ok === true, 'inbox: youtube reads ok');
  ok(inbox.posts.some((p) => p.platform === 'youtube'), 'inbox: the youtube post surfaces its comment');
  ok(!inbox.posts.some((p) => p.platform === 'linkedin'), 'inbox: no linkedin post in the feed');

  ok(inbox.capabilities && inbox.capabilities.linkedin, 'capabilities: linkedin entry present for the settings list');
  ok(inbox.capabilities.linkedin.readAvailable === false, 'capabilities: linkedin readAvailable=false');
  ok(inbox.capabilities.linkedin.readBlocked === 'linkedin_cma_pending', 'capabilities: linkedin carries the block reason');
  ok(inbox.capabilities.youtube.readAvailable === true, 'capabilities: youtube readAvailable=true');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`\n${pass} passed, ${failures} failed`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
