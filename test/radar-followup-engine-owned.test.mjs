#!/usr/bin/env node
// test/radar-followup-engine-owned.test.mjs - radarFollowup persists through every
// reply-lane engine's savePlan (engagement engine, owner decision 4).
//
// THE GOTCHA THIS PINS (memory: pendpost-media-attach-path / ENGINE_OWNED_FIELDS): every
// driver script's savePlan is a MERGE-ONLY write - it re-reads the plan from disk, copies
// ONLY the fields named in that script's ENGINE_OWNED_FIELDS from its in-memory post onto
// the disk copy, and writes the disk copy back. Any field the script stamps in memory but
// does not list is silently dropped. nostr-social stamped radarReplyState='target_gone'
// for a year with exactly this hole (fixed E1); x/yt listed radarReplyState but NOT
// radarFollowup - so an engine-side follow-up stamp (or any future engine write of the
// shape) would vanish. Now all reply-lane scripts own both fields.
//
// Two layers:
//   (1) SOURCE-LEVEL PIN: every reply-lane script's ENGINE_OWNED_FIELDS names
//       radarReplyState AND radarFollowup (the consts are module-private by design, so
//       the source is the honest place to read them).
//   (2) FUNCTIONAL: replicate savePlan's exact merge rule (disk as base; for each touched
//       id copy mem[f] for f in ENGINE_OWNED_FIELDS) with each script's EXTRACTED const:
//       a stampFollowup'd in-memory post must land its full radarFollowup shape +
//       radarReplyState on disk, and a disk-side stamp must survive an engine save that
//       touches the post with no in-memory stamp.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { stampFollowup } from '../lib/radar.mjs';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const HERE = path.dirname(new URL(import.meta.url).pathname);
const scriptPath = (name) => path.join(HERE, '..', 'scripts', name);

// Every script that can carry a Radar reply (or its copy-posted x sibling).
const REPLY_LANE_SCRIPTS = ['reddit-social.mjs', 'mastodon-social.mjs', 'bluesky-social.mjs', 'x-social.mjs', 'yt-social.mjs', 'nostr-social.mjs'];

const fieldsOf = (name) => {
  const src = fs.readFileSync(scriptPath(name), 'utf8');
  const m = src.match(/const ENGINE_OWNED_FIELDS = \[([^\]]*)\]/);
  assert.ok(m, `${name} declares ENGINE_OWNED_FIELDS`);
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
};

// ===== (1) the source-level pin =====
for (const name of REPLY_LANE_SCRIPTS) {
  const fields = fieldsOf(name);
  ok(fields.includes('radarReplyState') && fields.includes('radarFollowup'),
    `${name} ENGINE_OWNED_FIELDS owns radarReplyState + radarFollowup`);
}

// ===== (2) the merge rule, with each script's REAL const =====
// This is savePlan's touched-ids branch verbatim (see e.g. scripts/x-social.mjs savePlan):
//   out = disk; for each touched id: for f of ENGINE_OWNED_FIELDS: if mem[f] !== undefined
//   -> disk[f] = mem[f].
const mergeLikeSavePlan = (fields, diskPost, memPost) => {
  const target = { ...diskPost };
  for (const f of fields) if (memPost[f] !== undefined) target[f] = memPost[f];
  return target;
};
const HIT = { replied: true, author: 'buyer_jane', text: 'thanks, that fixed it', permalink: 'https://youtube.com/watch?v=vid1&lc=c1', ts: '2026-08-17T10:00:00.000Z', commentId: 'c1' };

for (const name of ['x-social.mjs', 'yt-social.mjs', 'nostr-social.mjs']) {
  const fields = fieldsOf(name);
  // (2a) the in-memory stamp SURVIVES onto disk.
  const mem = stampFollowup({ id: 'p1', status: 'posted' }, HIT, '2026-08-17T11:00:00.000Z');
  const disk = { id: 'p1', status: 'posted', caption: 'our reply' };
  const merged = mergeLikeSavePlan(fields, disk, mem);
  ok(merged.radarReplyState === 'author_replied'
    && merged.radarFollowup && merged.radarFollowup.author === 'buyer_jane'
    && merged.radarFollowup.commentId === 'c1' && merged.radarFollowup.lastCheckedTs === '2026-08-17T11:00:00.000Z',
    `${name}: an in-memory stampFollowup survives the savePlan merge onto disk (full shape + terminal state)`);
  // (2b) a DISK-side stamp survives an engine save that touches the post without one in
  // memory (disk is the base; an unlisted-or-unset field is never clobbered).
  const diskStamped = stampFollowup({ id: 'p2', status: 'posted' }, HIT, '2026-08-17T11:00:00.000Z');
  const memPlain = { id: 'p2', status: 'posted', postedAt: '2026-08-17T12:00:00.000Z' };
  const merged2 = mergeLikeSavePlan(fields, diskStamped, memPlain);
  ok(merged2.radarReplyState === 'author_replied' && merged2.radarFollowup && merged2.radarFollowup.author === 'buyer_jane',
    `${name}: a server-stamped disk copy survives an engine save of the same post (merge base is the disk)`);
}

console.log(`\n[radar-followup-engine-owned] OK - every reply-lane script owns radarReplyState + radarFollowup, and the savePlan merge carries the stamp both directions (${pass} assertions).`);
