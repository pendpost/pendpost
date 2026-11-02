#!/usr/bin/env node
// test/comment-answered-on-platform.test.mjs - the reply inbox counts only what still waits for
// the owner (lib/comment-watch.mjs commentSweep).
//
// Two leaks used to inflate "Antworten an dich" and its unanswered count (digest + push alerts):
//   1. the owner's OWN substantive replies were stored as unanswered items (only the housekeeping
//      first comment was dropped), and
//   2. a stranger's comment the owner had already answered DIRECTLY on the platform (not through
//      the Studio) stayed open forever.
// Now an item whose author is the owner (isOwnAuthor, the stable-id check) never enters the
// unanswered set; a stranger's reply to it keeps our words as context only (parent.own). And when
// a fresh read shows an own reply whose parentId is a stranger's comment in the same thread, that
// comment is resolved into the `seen` ledger with reason 'answered-on-platform', so it leaves the
// open set, is never counted as new, and never comes back. Lanes where isOwnAuthor fails open
// (no stored owner id) keep today's behaviour.
//
// Security review 2026-11-01: resolving HIDES someone else's comment, so it is fail-closed. Only an
// own reply proven by a server-set identity compared with the owner's stored one counts
// (isOwnAuthorProven), and a Mastodon acct is ours only with our own domain: a remote
// "mybot@evil.instance" is a stranger and can never resolve (or hide) anything.
//
// Every read is an injected stub (the reconcileCopyFollowups precedent): no engine, no network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-cw-answered-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const HOUR = 3600 * 1000;
const ago = (h, base = NOW) => new Date(base - h * HOUR).toISOString();
const recent = ago(48);

const CAMP = 'camp1';
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [{ id: CAMP, path: 'data/plans/camp1.json', active: true }] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'plans', 'camp1.json'), JSON.stringify({
  campaign: CAMP,
  posts: [
    { id: 'p-ig', type: 'image', platforms: ['instagram'], igMediaId: 'IGMEDIA1', postedAt: recent, caption: 'ig post', firstComment: 'our first comment #tags' },
    { id: 'p-mast', type: 'text', platforms: ['mastodon'], mastodonStatusId: 'MAST1', postedAt: recent, caption: 'toot' },
    { id: 'p-yt', type: 'video', platforms: ['youtube'], ytVideoId: 'yt1', postedAt: recent, caption: 'video' },
    // Reddit: isOwnAuthor has no stored owner id for it (fail-open), so nothing changes there.
    { id: 'p-red', type: 'text', platforms: ['reddit'], redditPostId: 'red1', postedAt: recent, caption: 'reddit post' },
  ],
}, null, 2));

// The owner identity lives in the client .env (readEnv reads the file, not process.env).
const { envPath } = await import('../lib/util.mjs');
fs.writeFileSync(envPath(), [
  'META_IG_USER_ID=IG_OWNER',
  'META_PAGE_ID=PAGE_OWNER',
  'MASTODON_HANDLE=mybot@m.example',
  'MASTODON_INSTANCE_URL=https://m.example',
  'MASTODON_ACCESS_TOKEN=t',
  'YT_CHANNEL_ID=UC_OURS',
].join('\n') + '\n', { mode: 0o600 });

const { commentSweep, commentInbox, commentKey, answeredOnPlatform, ANSWERED_ON_PLATFORM_LANES } = await import('../lib/comment-watch.mjs');
const { isOwnAuthor, isOwnAuthorProven } = await import('../lib/comments.mjs');
const { digestReplyCounts } = await import('../lib/insights.mjs');
const { repliesPush } = await import('../lib/engage-asks.mjs');
const { loadState } = await import('../lib/state.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');
setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { commentWatch: { enabled: true } } } });

const stranger = (commentId, extra = {}) => ({ commentId, author: `fan-${commentId}`, text: `question ${commentId}`, kind: 'comment', ...extra });
let reads = {};
let mentions = {};
const sweep = (now) => commentSweep({
  force: true, now,
  readComments: async ({ campaign, postId, platform }) => reads[`${campaign}:${postId}:${platform}`] || { ok: true, items: [] },
  readMentions: async (lane) => mentions[lane] || { ok: true, items: [] },
  readRadarReplies: async () => ({ items: [], sources: {} }),
  readReviews: async () => null,
  readEvents: async () => [],
});
const allItems = (inbox) => [...inbox.posts.flatMap((g) => g.comments), ...inbox.elsewhere];
const idsOf = (inbox) => allItems(inbox).map((i) => i.commentId).sort();
const seenRows = () => (loadState().comments.seen || []);

try {
  // ---- the pure helper -----------------------------------------------------------------------
  ok(Array.isArray(ANSWERED_ON_PLATFORM_LANES) && ['meta', 'youtube', 'reddit', 'mastodon', 'nostr', 'discord', 'linkedin', 'wordpress'].every((l) => ANSWERED_ON_PLATFORM_LANES.includes(l)),
    'the answered-on-platform lanes are the ones whose read carries parentId');
  ok(!ANSWERED_ON_PLATFORM_LANES.includes('telegram') && !ANSWERED_ON_PLATFORM_LANES.includes('tiktok') && !ANSWERED_ON_PLATFORM_LANES.includes('x'),
    'telegram, tiktok and x are not answered-on-platform lanes');
  const open = [{ lane: 'mastodon', postId: 'p', commentId: 's1' }, { lane: 'mastodon', postId: 'p', commentId: 's2' }];
  const mine = (extra) => ({ lane: 'mastodon', postId: 'p', commentId: 'o1', author: 'mybot', ...extra });
  ok(JSON.stringify(answeredOnPlatform([mine({ parentId: 's1' })], open)) === JSON.stringify(['mastodon:p:s1']),
    'helper: an own reply whose parentId is an open stranger comment in the same thread answers it');
  ok(answeredOnPlatform([mine({ parentId: null })], open).length === 0,
    'helper: an own reply without parentId answers nothing');
  ok(answeredOnPlatform([mine({ postId: 'OTHER', parentId: 's1' })], open).length === 0,
    'helper: the same comment id under another post is another thread, not answered');
  ok(answeredOnPlatform([{ lane: 'telegram', postId: 'p', commentId: 'o1', author: 'mybot', parentId: 's1' }], [{ lane: 'telegram', postId: 'p', commentId: 's1' }]).length === 0,
    'helper: a lane outside the parentId set never resolves anything');
  ok(answeredOnPlatform([mine({ parentId: 'gone' })], open).length === 0,
    'helper: a parent we never listed is not written to the ledger');
  // fail-closed: authorship must be proven by a stored, server-set identity
  ok(answeredOnPlatform([mine({ author: 'mybot@evil.instance', parentId: 's1' })], open).length === 0,
    'helper (security): a spoofed acct with our username on another instance resolves nothing');
  ok(answeredOnPlatform([{ lane: 'nostr', postId: 'p', commentId: 'o1', author: 'f'.repeat(64), authorId: 'f'.repeat(64), parentId: 's1' }], [{ lane: 'nostr', postId: 'p', commentId: 's1' }]).length === 0,
    'helper (security): a lane with no owner identity compared here (nostr) never auto-resolves');
  ok(answeredOnPlatform([{ lane: 'meta', postId: 'p', commentId: 'o1', author: 'mybrand', parentId: 's1' }], [{ lane: 'meta', postId: 'p', commentId: 's1' }]).length === 0,
    'helper (security): a Meta reply without from.id is not proven ours, so it resolves nothing');

  // ---- the Mastodon acct match (security review 2026-11-01) ---------------------------------
  ok(isOwnAuthor('mastodon', { author: 'mybot' }) === true, 'mastodon: a bare acct from our own instance is ours');
  ok(isOwnAuthor('mastodon', { author: '@MyBot@M.Example' }) === true, 'mastodon: our full acct (any case, leading @) is ours');
  ok(isOwnAuthor('mastodon', { author: 'mybot@evil.instance' }) === false, 'mastodon: our username on ANOTHER instance is a stranger');
  ok(isOwnAuthor('mastodon', { author: 'mybot@m.example@evil.instance' }) === false, 'mastodon: a malformed acct is never ours');
  ok(isOwnAuthorProven('mastodon', { author: 'mybot@evil.instance' }) === false && isOwnAuthorProven('mastodon', { author: 'mybot' }) === true,
    'proven: the Mastodon acct must carry our domain or be local to our instance');
  ok(isOwnAuthorProven('meta', { authorId: 'IG_OWNER' }) === true && isOwnAuthorProven('meta', { author: 'mybrand' }) === false,
    'proven: Meta needs from.id equal to our stored id');
  ok(isOwnAuthorProven('youtube', { authorId: 'UC_OURS' }) === true && isOwnAuthorProven('youtube', { author: 'Our Channel' }) === false,
    'proven: YouTube needs our channel id');
  ok(['reddit', 'nostr', 'discord', 'wordpress', 'telegram', 'tiktok'].every((l) => isOwnAuthorProven(l, { author: 'ourname', authorId: 'f'.repeat(64) }) === false),
    'proven: a lane without a stored owner identity compared here is never proven');

  // ---- sweep 1 -------------------------------------------------------------------------------
  reads = {
    [`${CAMP}:p-ig:instagram`]: { ok: true, items: [
      stranger('ig-q', { authorId: 'STRANGER_1', ts: ago(3) }),
      { commentId: 'ig-a', author: 'mybrand', authorId: 'IG_OWNER', text: 'Settings, then Export.', kind: 'reply', parentId: 'ig-q', ts: ago(2) },
      stranger('ig-q2', { authorId: 'STRANGER_2', ts: ago(2.5) }),
      // our own top-level comment: no parentId, so it answers nothing
      { commentId: 'ig-own-top', author: 'mybrand', authorId: 'IG_OWNER', text: 'Thanks for all the questions today!', kind: 'comment', ts: ago(1.5) },
      // no from.id: isOwnAuthor fails open, so this reads as a stranger and answers nothing
      { commentId: 'ig-noid', author: 'mybrand', text: 'an answer we cannot attribute', kind: 'reply', parentId: 'ig-q2', ts: ago(1) },
    ] },
    [`${CAMP}:p-mast:mastodon`]: { ok: true, items: [
      stranger('m-q', { author: 'someone@else.social', ts: ago(4) }),
      { commentId: 'm-a', author: 'mybot', text: 'Yes, it runs on your own machine.', kind: 'reply', parentId: 'm-q', ts: ago(3) },
      { commentId: 'm-r', author: 'other@else.social', text: 'thanks, that worked', kind: 'reply', parentId: 'm-a', ts: ago(2) },
      // a remote account that took our username elsewhere "answers" a stranger: nothing resolves
      stranger('m-q3', { author: 'third@else.social', ts: ago(3) }),
      { commentId: 'm-spoof', author: 'mybot@evil.instance', text: 'Answered, you can stop waiting.', kind: 'reply', parentId: 'm-q3', ts: ago(2.5) },
    ] },
    [`${CAMP}:p-yt:youtube`]: { ok: true, items: [
      stranger('y-q', { authorId: 'UC_STRANGER', ts: ago(5) }),
      { commentId: 'y-a', author: 'Our Channel', authorId: 'UC_OURS', text: 'Link is in the description.', kind: 'reply', parentId: 'y-q', ts: ago(4) },
    ] },
    [`${CAMP}:p-red:reddit`]: { ok: true, items: [
      stranger('t1_rq', { author: 'redditor', ts: ago(3) }),
      { commentId: 't1_ra', author: 'ourname', text: 'we answered on reddit', kind: 'reply', parentId: 't1_rq', ts: ago(2) },
    ] },
  };
  const r1 = await sweep(NOW);
  const inbox1 = commentInbox();
  const ids1 = idsOf(inbox1);

  // own items never count
  ok(!ids1.includes('ig-a') && !ids1.includes('m-a') && !ids1.includes('y-a'), 'own replies are not stored as unanswered items');
  ok(!ids1.includes('ig-own-top'), 'an own top-level comment is not stored as an unanswered item');
  // answered on the platform
  ok(!ids1.includes('ig-q'), 'IG: a stranger comment we answered on Instagram leaves the open set');
  ok(!ids1.includes('m-q'), 'Mastodon: a stranger comment we answered on Mastodon leaves the open set');
  ok(!ids1.includes('y-q'), 'YouTube: a stranger comment we answered on YouTube leaves the open set');
  const answeredRows = seenRows().filter((s) => s.reason === 'answered-on-platform').map((s) => s.key).sort();
  ok(JSON.stringify(answeredRows) === JSON.stringify(['mastodon:p-mast:m-q', 'meta:p-ig:ig-q', 'youtube:p-yt:y-q']),
    'each answered comment is resolved into the seen ledger with reason answered-on-platform');
  // an own comment without parentId changes nothing
  ok(ids1.includes('ig-q2'), 'an own comment without parentId (and an unattributable reply) leaves the other open comment open');
  // fail-open lanes keep today's behaviour
  ok(ids1.includes('ig-noid'), 'IG: a comment with no from.id is still shown (isOwnAuthor fails open)');
  ok(ids1.includes('t1_rq') && ids1.includes('t1_ra'), 'Reddit (no stored owner id): both the comment and the reply stay, as today');
  ok(!seenRows().some((s) => s.key === `reddit:p-red:t1_rq` || s.key === `meta:p-ig:ig-q2`), 'fail-open lanes write nothing to the ledger');
  // security: a spoofed acct neither resolves a stranger's comment nor hides itself as ours
  ok(ids1.includes('m-q3') && !seenRows().some((s) => s.key === 'mastodon:p-mast:m-q3'), 'security: a reply from mybot@evil.instance does not resolve the stranger comment under it');
  ok(ids1.includes('m-spoof'), 'security: mybot@evil.instance is a stranger, so its reply is listed like any other');
  // context only: a stranger answering our reply sees our words, without our reply counting
  const mr = allItems(inbox1).find((i) => i.commentId === 'm-r');
  ok(!allItems(inbox1).find((i) => i.commentId === 'm-spoof').parent, 'security: a reply to a stranger gets no own-parent context');
  ok(mr && mr.parent && mr.parent.own === true && mr.parent.author === 'mybot' && /own machine/.test(mr.parent.text),
    'a stranger reply to our reply keeps our words as context (parent.own), our reply itself is not an item');
  // counts: the inbox, the alerts and the digest all agree
  const expected = ['ig-noid', 'ig-q2', 'm-q3', 'm-r', 'm-spoof', 't1_ra', 't1_rq'];
  ok(JSON.stringify(ids1) === JSON.stringify(expected), `the open set is exactly the strangers still waiting (${ids1.join(', ')})`);
  ok(inbox1.unanswered === expected.length, 'unanswered counts only the strangers still waiting');
  ok(Object.values(inbox1.byKind).reduce((a, b) => a + b, 0) === expected.length, 'byKind counts no own or answered item');
  ok(r1.new === expected.length, 'the new-item count (Activity + push) leaves out own and answered items');
  const d1 = digestReplyCounts(loadState(), { enabled: true }, NOW);
  ok(d1.unanswered === expected.length && d1.fresh === expected.length, 'the digest counts match the open set');
  const primed = await repliesPush({ sendTelegram: async () => ({ ok: true }), notifyMacos: async () => ({ ok: true, delivered: true }), now: NOW });
  ok(primed.primed === true, 'push: the first run only sets the watermark');

  // ---- sweep 2: the answered comment never returns -------------------------------------------
  const T2 = NOW + 5 * HOUR;
  reads[`${CAMP}:p-ig:instagram`] = { ok: true, items: [
    // our reply is gone from this read (deleted, or paged out), the question is still there
    stranger('ig-q', { authorId: 'STRANGER_1', ts: ago(3) }),
    stranger('ig-q2', { authorId: 'STRANGER_2', ts: ago(2.5) }),
    { commentId: 'ig-noid', author: 'mybrand', text: 'an answer we cannot attribute', kind: 'reply', parentId: 'ig-q2', ts: ago(1) },
    stranger('ig-new', { authorId: 'STRANGER_3', ts: ago(0.5, T2) }),
  ] };
  // a new stranger comment on Mastodon, which sweep 3 will find answered while its read is cut short
  reads[`${CAMP}:p-mast:mastodon`].items.push(stranger('m-late', { author: 'late@else.social', ts: ago(0.5, T2) }));
  const r2 = await sweep(T2);
  const ids2 = idsOf(commentInbox());
  ok(!ids2.includes('ig-q') && !ids2.includes('m-q') && !ids2.includes('y-q'), 'sweep 2: an answered comment does not return, even after our reply left the read');
  ok(ids2.includes('ig-new') && ids2.includes('m-late'), 'sweep 2: new strangers are listed');
  ok(r2.new === 2, 'sweep 2: only the two genuinely new comments count as new');
  const keys = seenRows().map((s) => s.key);
  ok(keys.length === new Set(keys).size, 'sweep 2: re-reading the same own reply adds no duplicate ledger rows');
  const pushed = await repliesPush({ sendTelegram: async () => ({ ok: true }), notifyMacos: async () => ({ ok: true, delivered: true }), now: T2 });
  ok(pushed.count === 2, 'push: the alert counts only the two new strangers');

  // ---- sweep 3: answered while the read is cut short; the parent is only in the cache --------
  const T3 = T2 + 5 * HOUR;
  reads[`${CAMP}:p-mast:mastodon`] = { ok: true, truncated: true, items: [
    { commentId: 'm-late-a', author: 'mybot@m.example', text: 'Done, see the docs.', kind: 'reply', parentId: 'm-late', ts: ago(0.2, T3) },
  ] };
  // the same status also arrives through the mentions read, placed elsewhere
  mentions = { mastodon: { ok: true, items: [{ commentId: 'm-late', author: 'late@else.social', text: 'question m-late', kind: 'mention', inReplyTo: 'not-ours', ts: ago(0.5, T2) }] } };
  const r3 = await sweep(T3);
  const inbox3 = commentInbox();
  const ids3 = idsOf(inbox3);
  ok(seenRows().some((s) => s.key === 'mastodon:p-mast:m-late' && s.reason === 'answered-on-platform'), 'sweep 3: a cached stranger comment answered on-platform is resolved');
  ok(!ids3.includes('m-late'), 'sweep 3: it leaves the open set and does not come back under another key (the mention copy)');
  ok(ids3.includes('m-r'), 'sweep 3: the truncated read still carries the other cached comments forward');
  ok(r3.new === 0, 'sweep 3: nothing new');

  // ---- an own item cached by an older build is cleaned up on the next sweep ------------------
  const st = loadState().comments;
  st.items.push({ kind: 'reply', lane: 'mastodon', platform: 'mastodon', campaign: CAMP, postId: 'p-mast', commentId: 'm-legacy-own', author: 'mybot', text: 'old own reply', parentId: 'm-r', foundAt: ago(30, T3) });
  const { saveState } = await import('../lib/state.mjs');
  saveState();
  await sweep(T3 + HOUR);
  ok(!idsOf(commentInbox()).includes('m-legacy-own'), 'a cached own item from an older build leaves the set, even in a scope that was not read in full');
} catch (err) {
  failures += 1;
  console.error('  FAIL - threw:', (err && err.stack) || err);
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
