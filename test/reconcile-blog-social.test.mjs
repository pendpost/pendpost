#!/usr/bin/env node
// test/reconcile-blog-social.test.mjs - the blog social reconciler builds the
// right drafts from one social.json entry and fails closed on bad copy.
//
// Pure: exercises draftsFor/zurichIso only, no Studio and no filesystem writes.
import assert from 'node:assert/strict';
import { draftsFor, draftWarnings, zurichIso } from '../scripts/reconcile-blog-social.mjs';

const link = 'https://pendpost.com/blog/demo-post';
const entry = {
  slug: 'demo-post',
  title: 'Demo post',
  datePublished: '2026-11-03',
  x: [`First tweet ${link}`, 'Second tweet', 'Third tweet'],
  mastodon: `Mastodon text ${link}`,
  nostr: `Nostr text ${link}`,
  instagram: { caption: 'IG caption', slides: ['one'] },
};

// Zurich offsets: winter +01:00, summer +02:00.
assert.equal(zurichIso('2026-11-03', '09:30'), '2026-11-03T09:30:00+01:00');
assert.equal(zurichIso('2026-07-14', '17:00'), '2026-07-14T17:00:00+02:00');

// Happy path: a 3-tweet thread chained by xReplyTo, one draft per other lane.
{
  const { drafts, problems } = draftsFor(entry, { ogExists: true });
  assert.deepEqual(problems, []);
  assert.deepEqual(drafts.map((d) => d.id), [
    'blog-demo-post-x', 'blog-demo-post-x-2', 'blog-demo-post-x-3',
    'blog-demo-post-mastodon', 'blog-demo-post-nostr', 'blog-demo-post-instagram',
  ]);
  assert.equal(drafts[0].xReplyTo, undefined);
  assert.equal(drafts[1].xReplyTo, 'blog-demo-post-x');
  assert.equal(drafts[2].xReplyTo, 'blog-demo-post-x-2');
  const ig = drafts.at(-1);
  assert.equal(ig.type, 'image');
  assert.equal(ig.imageUrl, 'https://pendpost.com/og/blog/demo-post.png');
  assert.equal(ig.path, 'data/media/blog-og-demo-post.png');
  assert.equal(ig.scheduledAt, '2026-11-03T17:00:00+01:00');
  // Never carries approval state: drafts only.
  for (const d of drafts) assert.equal('approved' in d, false);
}

// Fail closed: an over-long tweet blocks the whole X thread, not just one tweet.
{
  const bad = { ...entry, x: [`${'a'.repeat(260)} ${link}`] };
  const { drafts, problems } = draftsFor(bad, { ogExists: true });
  assert.equal(drafts.some((d) => d.platforms[0] === 'x'), false);
  assert.match(problems[0], /over 280/);
}

// Fail closed: first tweet without the article link, and no OG card for Instagram.
{
  const bad = { ...entry, x: ['No link here'] };
  const { drafts, problems } = draftsFor(bad, { ogExists: false });
  assert.equal(drafts.some((d) => d.platforms[0] === 'x' || d.platforms[0] === 'instagram'), false);
  assert.equal(problems.length, 2);
}

// Engine checks before writing (2026-10-28): a draft the Studio would flag is still
// created, but the run names it. Mastodon counts links as 23 (lib/caption.mjs), so a
// 600-char post with long links that fits is NOT flagged, and one that is over is.
{
  const longLink = `${link}?${'q'.repeat(150)}`;
  const fits = { ...entry, mastodon: `${'m'.repeat(440)} ${longLink}` }; // 440 + 1 + 23 = 464 counted
  const { drafts } = draftsFor(fits, { ogExists: true });
  assert.ok(fits.mastodon.length > 500);
  assert.deepEqual(draftWarnings(drafts), [], 'a link-heavy Mastodon post that fits under Mastodon counting is clean');

  const over = { ...entry, mastodon: `${'m'.repeat(490)} ${link}`, instagram: { caption: 'i'.repeat(2300), slides: [] } };
  const res = draftsFor(over, { ogExists: true });
  assert.equal(res.drafts.some((d) => d.id === 'blog-demo-post-mastodon'), true, 'the over-cap draft is still created');
  const warns = draftWarnings(res.drafts);
  assert.ok(warns.some((w) => w.startsWith('blog-demo-post-mastodon:') && /514 chars - mastodon caps at 500/.test(w)), `mastodon over cap named (got ${JSON.stringify(warns)})`);
  assert.ok(warns.some((w) => w.startsWith('blog-demo-post-instagram:') && /2300 chars - instagram caps at 2200/.test(w)), 'instagram over cap named');

  const lint = { ...entry, nostr: `Nostr text ${link} and https:// broken` };
  const lw = draftWarnings(draftsFor(lint, { ogExists: true }).drafts);
  assert.ok(lw.some((w) => w.startsWith('blog-demo-post-nostr:') && /brand-lint error broken-link/.test(w) && /refused at approval/.test(w)), `a brand-lint error is named (got ${JSON.stringify(lw)})`);
}

console.log('reconcile-blog-social: all assertions passed');
