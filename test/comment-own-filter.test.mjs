#!/usr/bin/env node
// test/comment-own-filter.test.mjs - the inbox must show OTHERS' comments, plus the
// owner's own SUBSTANTIVE replies, and hide only the owner's HOUSEKEEPING comments.
// pendpost posts a first-comment on its own IG/FB media as itself, and Mastodon reads
// the whole thread (so our own replies come back). isOwnAuthor (lib/comments.mjs)
// answers WHO wrote it; isOwnHousekeepingComment (owner decision 5, 2026-08-17)
// answers whether it may be hidden: only the post.firstComment we posted ourselves,
// or a hashtag-only comment - a substantive own reply stays visible so answers TO it
// are caught and the conversation continues. Also pins the row-like capability
// annotation (reactActions) and the Instagram post-permalink fallback (from verify).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-cw-own-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });

// Owner identity lives in the client .env (readEnv reads the file, not process.env).
fs.writeFileSync(path.join(WS, '.env'), [
  'META_IG_USER_ID=IG_OWNER',
  'META_PAGE_ID=PAGE_OWNER',
  'MASTODON_HANDLE=mybot@my.instance',
  'LINKEDIN_ORG_URN=urn:li:organization:99',
].join('\n') + '\n');

const NOW = Date.parse('2026-08-09T12:00:00.000Z');
const HOUR = 3600 * 1000;
const recent = new Date(NOW - 2 * 24 * HOUR).toISOString();

const CAMP = 'camp1';
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [{ id: CAMP, path: 'data/plans/camp1.json', active: true }] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'plans', 'camp1.json'), JSON.stringify({
  campaign: CAMP,
  posts: [
    // An IG post with a verify read-back permalink (derivePermalinks hard-nulls instagram).
    { id: 'p-ig', type: 'image', platforms: ['instagram'], igMediaId: 'IGMEDIA1', postedAt: recent, caption: 'my ig post',
      firstComment: 'our first comment #tags',
      verify: { platforms: { instagram: { live: true, state: 'published', permalink: 'https://www.instagram.com/p/ABC123/' } } } },
    // A Mastodon post (its read returns the whole thread, including our own replies).
    { id: 'p-mast', type: 'text', platforms: ['mastodon'], mastodonStatusId: 'MAST1', postedAt: recent, caption: 'my toot' },
  ],
}, null, 2));

const { commentSweep, commentInbox } = await import('../lib/comment-watch.mjs');
const { isOwnAuthor, isOwnHousekeepingComment } = await import('../lib/comments.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');
setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { commentWatch: { enabled: true } } } });

// Injected read: (campaign, postId, platform) -> a listComments-shaped result.
const READS = {
  [`${CAMP}:p-ig:instagram`]: { ok: true, items: [
    { commentId: 'ig-own', author: 'mybrand', authorId: 'IG_OWNER', text: '  Our First   Comment #tags ', ts: new Date(NOW - 3 * HOUR).toISOString(), kind: 'comment' }, // the firstComment, spacing/case mangled by the platform echo
    { commentId: 'ig-own-tags', author: 'mybrand', authorId: 'IG_OWNER', text: '#launch #buildinpublic #swiss', ts: new Date(NOW - 3 * HOUR).toISOString(), kind: 'comment' }, // hashtag-only housekeeping
    { commentId: 'ig-own-reply', author: 'mybrand', authorId: 'IG_OWNER', text: 'Great question - the export lives under Settings, ping me if it hides.', ts: new Date(NOW - 90 * 60 * 1000).toISOString(), kind: 'comment' }, // our SUBSTANTIVE reply
    { commentId: 'ig-stranger', author: 'a_fan', authorId: 'STRANGER_1', text: 'love this!', ts: new Date(NOW - 2 * HOUR).toISOString(), permalink: null, kind: 'comment' },
    { commentId: 'ig-noid', author: 'ghost', text: 'no from.id here', ts: new Date(NOW - 1 * HOUR).toISOString(), kind: 'comment' }, // fail-open: shown
  ] },
  [`${CAMP}:p-mast:mastodon`]: { ok: true, items: [
    { commentId: 'm-own', author: 'mybot', text: 'thanks all', ts: new Date(NOW - 3 * HOUR).toISOString(), permalink: 'https://my.instance/@mybot/1', kind: 'comment' },
    { commentId: 'm-stranger', author: 'someone@else.social', text: 'nice', ts: new Date(NOW - 2 * HOUR).toISOString(), permalink: 'https://else.social/@someone/9', kind: 'comment' },
  ] },
};
const readComments = async ({ campaign, postId, platform }) => READS[`${campaign}:${postId}:${platform}`] || { ok: true, items: [] };

try {
  // ---- isOwnAuthor unit ----------------------------------------------------
  ok(isOwnAuthor('meta', { authorId: 'IG_OWNER' }) === true, 'meta: authorId == META_IG_USER_ID is own');
  ok(isOwnAuthor('meta', { authorId: 'PAGE_OWNER' }) === true, 'meta: authorId == META_PAGE_ID is own');
  ok(isOwnAuthor('meta', { authorId: 'STRANGER_1' }) === false, 'meta: a stranger id is not own');
  ok(isOwnAuthor('meta', { author: 'mybrand' }) === false, 'meta: no authorId => fail-open (not own)');
  ok(isOwnAuthor('mastodon', { author: 'mybot@my.instance' }) === true, 'mastodon: same acct (with instance) is own');
  ok(isOwnAuthor('mastodon', { author: 'mybot' }) === true, 'mastodon: bare local-part is own');
  ok(isOwnAuthor('mastodon', { author: 'someone@else.social' }) === false, 'mastodon: a stranger acct is not own');
  ok(isOwnAuthor('linkedin', { author: 'urn:li:organization:99' }) === true, 'linkedin: our org urn is own');
  ok(isOwnAuthor('linkedin', { author: 'urn:li:person:xyz' }) === false, 'linkedin: a person urn is not own');
  ok(isOwnAuthor('telegram', { author: 'anyone', authorId: 'x' }) === false, 'a lane with no stored own-id passes through (fail-open)');

  // ---- isOwnHousekeepingComment unit (owner decision 5, 2026-08-17) --------
  // The 8 cases: what may be hidden is exactly {firstComment echo, hashtag-only}.
  ok(isOwnHousekeepingComment('our first comment #tags', 'our first comment #tags') === true, 'housekeeping: an exact firstComment echo is housekeeping');
  ok(isOwnHousekeepingComment('  Our First   Comment #TAGS ', 'our first comment #tags') === true, 'housekeeping: normalized match - case/whitespace mangling still matches');
  ok(isOwnHousekeepingComment('#launch #buildinpublic', '') === true, 'housekeeping: hashtag-only (every token starts with #) is housekeeping even with no firstComment');
  ok(isOwnHousekeepingComment('#one', null) === true, 'housekeeping: a single hashtag token counts');
  ok(isOwnHousekeepingComment('Great question - the export lives under Settings.', 'our first comment #tags') === false, 'housekeeping: a substantive own reply is NOT housekeeping');
  ok(isOwnHousekeepingComment('check #this out', '') === false, 'housekeeping: mixed text with a hashtag is NOT hashtag-only');
  ok(isOwnHousekeepingComment('', 'our first comment #tags') === false, 'housekeeping: an empty text matches nothing (fail-open, kept)');
  ok(isOwnHousekeepingComment('thanks all', '') === false, 'housekeeping: with no firstComment on record, ordinary own text stays visible');

  // ---- sweep filters own housekeeping, keeps strangers AND own substance ----
  await commentSweep({ force: true, now: NOW, readComments });
  const inbox = commentInbox();
  const byPost = Object.fromEntries(inbox.posts.map((g) => [g.postId, g]));
  const ig = byPost['p-ig'];
  const mast = byPost['p-mast'];

  const igIds = (ig?.comments || []).map((c) => c.commentId).sort();
  ok(!igIds.includes('ig-own'), 'sweep: our own IG first-comment is filtered out (matched against post.firstComment, spacing/case-tolerant)');
  ok(!igIds.includes('ig-own-tags'), 'sweep: our own hashtag-only IG comment is filtered out');
  ok(igIds.includes('ig-own-reply'), 'sweep: our own SUBSTANTIVE IG reply is KEPT - answers to it must be catchable (owner decision 5)');
  ok(igIds.includes('ig-stranger'), 'sweep: a stranger IG comment is kept');
  ok(igIds.includes('ig-noid'), 'sweep: an IG comment with no from.id is kept (fail-open)');

  const mIds = (mast?.comments || []).map((c) => c.commentId).sort();
  // DELIBERATE FLIP (owner decision 5, 2026-08-17): this assertion used to read
  // "!mIds.includes('m-own') - our own Mastodon reply is filtered out". The blanket
  // own-filter hid SUBSTANTIVE replies too, so a conversation the operator was already
  // holding went invisible in the inbox. 'thanks all' is not the firstComment and not
  // hashtag-only, so it now STAYS.
  ok(mIds.includes('m-own'), 'sweep: our own substantive Mastodon reply is KEPT (deliberate flip of the old blanket-suppression pin)');
  ok(mIds.includes('m-stranger'), 'sweep: a stranger Mastodon reply is kept');

  ok(inbox.unanswered === igIds.length + mIds.length, 'unanswered count excludes own comments');

  // ---- reactActions annotation (row-like capability) -----------------------
  ok(Array.isArray(ig?.reactActions) && ig.reactActions.length === 0, 'IG group reactActions is [] (Meta cannot like)');
  ok(mast?.reactActions?.includes('favourite'), 'Mastodon group reactActions includes favourite (row-like works)');

  // ---- Instagram post permalink falls back to the verify read-back ---------
  ok(ig?.permalink === 'https://www.instagram.com/p/ABC123/', 'IG group permalink falls back to verify permalink');
  ok(mast?.comments?.find((c) => c.commentId === 'm-stranger')?.permalink === 'https://else.social/@someone/9', 'a Mastodon comment keeps its per-comment permalink');
} catch (err) {
  failures += 1;
  console.error('  FAIL - threw:', (err && err.stack) || err);
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
