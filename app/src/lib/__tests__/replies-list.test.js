import { describe, it, expect } from 'vitest';
import {
  REPLY_KINDS, itemKind, inboxUnanswered, replyRows, laneLines, threadOneLevel, parentOf, replyRoute, mergeInboxAll, radarSignalKeyOf, canAnswer, canReact,
} from '../replies.js';

// The one "Replies to you" list (planner-bulk contract, package U). These pin the pure merge:
// posts[] groups (as today) + elsewhere[] items in ONE newest-first list, the kind of every
// item, the count the segment label carries, the honest lane lines and the one-level threading
// the per-post Comments panel uses. Fixtures are in the contract shape ("Fixed interface:
// reply items (R -> U)"); the old shape (no kind, no elsewhere) must keep working.

const group = (over = {}) => ({
  campaign: 'launch', postId: 'p1', platform: 'mastodon', caption: 'Launch day', permalink: 'https://m.example/@us/1',
  lanes: ['mastodon'], unanswered: 1, reactActions: ['favourite'], lastCommentTs: '2026-11-01T10:00:00.000Z',
  comments: [{ key: 'mastodon:p1:c1', kind: 'comment', lane: 'mastodon', platform: 'mastodon', campaign: 'launch', postId: 'p1', commentId: 'c1', author: 'ana@m.example', text: 'Nice', ts: '2026-11-01T10:00:00.000Z' }],
  ...over,
});
const elsewhere = (over = {}) => ({
  key: 'bluesky:mention:m1', kind: 'mention', lane: 'bluesky', author: 'sam.bsky.social', text: '@pendpost is neat', ts: '2026-11-01T11:00:00.000Z',
  commentId: 'm1', permalink: 'https://bsky.app/profile/sam/post/m1', ref: { type: 'profile', id: 'pendpost.bsky.social' },
  ...over,
});

describe('itemKind', () => {
  it('knows every contract kind', () => {
    expect(REPLY_KINDS).toEqual(['comment', 'reply', 'mention', 'quote', 'repost', 'zap', 'review', 'event', 'radar-reply']);
    for (const k of REPLY_KINDS) expect(itemKind({ kind: k })).toBe(k);
  });
  it('falls back to the old behaviour: no kind = comment, a parentId = reply', () => {
    expect(itemKind({})).toBe('comment');
    expect(itemKind({ parentId: 'c0' })).toBe('reply');
  });
  it('an unknown future kind reads as a comment, never a raw word', () => {
    expect(itemKind({ kind: 'hologram' })).toBe('comment');
  });
});

describe('replyRows: one list, newest first', () => {
  it('interleaves post groups and elsewhere items by time', () => {
    const data = {
      posts: [group(), group({ postId: 'p2', lastCommentTs: '2026-11-01T08:00:00.000Z' })],
      elsewhere: [elsewhere(), elsewhere({ key: 'gbp:r1', kind: 'review', lane: 'gbp', ts: '2026-11-01T09:00:00.000Z', rating: 4, ref: { type: 'location', id: 'loc1' } })],
    };
    const rows = replyRows(data);
    expect(rows.map((r) => r.key)).toEqual(['bluesky:mention:m1', 'launch:p1', 'gbp:r1', 'launch:p2']);
    expect(rows.map((r) => r.type)).toEqual(['item', 'post', 'item', 'post']);
  });
  it('the old shape (posts only, no elsewhere) still renders every group', () => {
    const rows = replyRows({ posts: [group()] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'post', key: 'launch:p1' });
  });
  it('a project-stamped group keeps a distinct key per project', () => {
    const rows = replyRows({ posts: [group({ clientId: 'a' }), group({ clientId: 'b' })] });
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });
  it('an item with no time sorts last instead of breaking the order', () => {
    const rows = replyRows({ elsewhere: [elsewhere({ key: 'x', ts: null }), elsewhere()] });
    expect(rows.map((r) => r.key)).toEqual(['bluesky:mention:m1', 'x']);
  });
  it('tolerates a missing body', () => {
    expect(replyRows(undefined)).toEqual([]);
    expect(replyRows({})).toEqual([]);
  });
});

describe('inboxUnanswered: the number the segment label and the alerts share', () => {
  it('uses the engine count when it is there', () => {
    expect(inboxUnanswered({ unanswered: 7, posts: [group()], elsewhere: [] })).toBe(7);
  });
  it('counts both lists when the engine sent no number', () => {
    expect(inboxUnanswered({ posts: [group({ unanswered: 2 })], elsewhere: [elsewhere(), elsewhere({ key: 'y' })] })).toBe(4);
  });
  it('is zero for nothing', () => {
    expect(inboxUnanswered(undefined)).toBe(0);
  });
});

describe('laneLines: an honest line per lane that cannot read, never a zero', () => {
  it('maps every reason to its one fix, blocked lanes to "needs you"', () => {
    const lines = laneLines({
      sources: {
        mastodon: { ok: true },
        x: { ok: false, reason: 'needs_owner', message: 'Reading X needs paid API access.' },
        bluesky: { ok: false, reason: 'not_connected' },
        meta: { ok: false, error: 'needs_scope' },
        reddit: { ok: false, error: 'HTTP 502' },
      },
    });
    expect(lines.map((l) => [l.lane, l.fix])).toEqual([
      ['bluesky', 'connect'], ['meta', 'reconnect'], ['x', 'owner'], ['reddit', 'retry'],
    ]);
    expect(lines.find((l) => l.lane === 'x').why).toBe('Reading X needs paid API access.');
    expect(lines.find((l) => l.lane === 'reddit').why).toBe('HTTP 502');
  });
  it('keeps a needs_owner row whose read worked (Instagram authors withheld, issue #44)', () => {
    const lines = laneLines({ sources: { meta: { ok: true, reason: 'needs_owner', detail: 'meta_comment_author_scope', scope: 'instagram_manage_comments' } } });
    expect(lines.map((l) => [l.lane, l.fix])).toEqual([['meta', 'owner']]);
  });
  it('is empty when every lane reads', () => {
    expect(laneLines({ sources: { mastodon: { ok: true } } })).toEqual([]);
    expect(laneLines({})).toEqual([]);
  });
});

describe('threadOneLevel: the per-post panel shows replies under their comment', () => {
  const items = [
    { commentId: 'c1', author: 'ana', text: 'Root', ts: '2026-11-01T09:00:00Z' },
    { commentId: 'c2', author: 'us', text: 'Our answer', parentId: 'c1', ts: '2026-11-01T09:10:00Z' },
    { commentId: 'c3', author: 'ben', text: 'Answer to our answer', parentId: 'c2', ts: '2026-11-01T09:20:00Z' },
    { commentId: 'c4', author: 'cy', text: 'Second root', ts: '2026-11-01T09:30:00Z' },
    { commentId: 'c5', author: 'dee', text: 'Parent not loaded', parentId: 'gone', ts: '2026-11-01T09:40:00Z' },
  ];
  it('nests every descendant one level under its root, oldest first', () => {
    const roots = threadOneLevel(items);
    expect(roots.map((r) => r.commentId)).toEqual(['c1', 'c4', 'c5']);
    expect(roots[0].replies.map((r) => r.commentId)).toEqual(['c2', 'c3']);
    expect(roots[1].replies).toEqual([]);
  });
  it('a reply to a reply names who it answers', () => {
    const [root] = threadOneLevel(items);
    expect(root.replies[0].replyTo).toBeNull();
    expect(root.replies[1].replyTo).toBe('us');
  });
  it('survives a parent cycle', () => {
    const roots = threadOneLevel([{ commentId: 'a', parentId: 'b' }, { commentId: 'b', parentId: 'a' }]);
    expect(roots.length).toBeGreaterThan(0);
  });
});

describe('parentOf: the quiet parent line on a reply row', () => {
  it('finds the parent among the siblings', () => {
    const sib = [{ commentId: 'c1', author: 'ana', text: 'Root' }];
    expect(parentOf({ parentId: 'c1' }, sib)).toEqual({ author: 'ana', text: 'Root' });
  });
  it('uses a parent the engine sent along', () => {
    expect(parentOf({ parentId: 'z', parent: { author: 'you', text: 'Our reply' } }, [])).toEqual({ author: 'you', text: 'Our reply' });
  });
  it('is null for a top-level item or an unknown parent', () => {
    expect(parentOf({}, [])).toBeNull();
    expect(parentOf({ parentId: 'nope' }, [])).toBeNull();
  });
});

describe('replyRoute: Reply only where a write exists', () => {
  it('routes each kind of elsewhere item', () => {
    expect(replyRoute({ kind: 'review' })).toBe('review');
    expect(replyRoute({ kind: 'event' })).toBe('event');
    expect(replyRoute({ kind: 'radar-reply' })).toBe('radar');
    expect(replyRoute({ kind: 'mention' })).toBeNull();
    expect(replyRoute({ kind: 'zap' })).toBeNull();
  });
});

describe('radarSignalKeyOf: the card an answer to our Radar reply belongs to', () => {
  it('reads the source externalId key, or a bare id with the item lane', () => {
    expect(radarSignalKeyOf({ lane: 'reddit', ref: { type: 'radar', id: 'reddit ghi789' } })).toBe('reddit ghi789');
    expect(radarSignalKeyOf({ lane: 'bluesky', ref: { type: 'radar', id: '3kdef' } })).toBe('bluesky 3kdef');
    expect(radarSignalKeyOf({ lane: 'reddit', ref: { type: 'radar' } })).toBeNull();
    expect(radarSignalKeyOf({})).toBeNull();
  });
});

describe('canAnswer / canReact: the write truth per kind (no Reply or heart where nothing can be written)', () => {
  it('under one of our posts: text-bearing kinds can be answered, a zap or a repost cannot', () => {
    for (const k of ['comment', 'reply', 'mention', 'quote']) expect(canAnswer({ kind: k }, { onPost: true })).toBe(true);
    for (const k of ['zap', 'repost']) expect(canAnswer({ kind: k }, { onPost: true })).toBe(false);
  });
  it('elsewhere: only kinds with a reply seam (review, X event, Radar reply)', () => {
    expect(canAnswer({ kind: 'review' })).toBe(true);
    expect(canAnswer({ kind: 'event' })).toBe(true);
    expect(canAnswer({ kind: 'radar-reply' })).toBe(true);
    for (const k of ['mention', 'quote', 'repost', 'zap']) expect(canAnswer({ kind: k })).toBe(false);
  });
  it('a like goes only on a comment or a reply, never on a zap receipt or a repost', () => {
    expect(canReact({ kind: 'comment' })).toBe(true);
    expect(canReact({ kind: 'reply' })).toBe(true);
    expect(canReact({ parentId: 'x' })).toBe(true);
    for (const k of ['zap', 'repost', 'mention', 'quote', 'review', 'event']) expect(canReact({ kind: k })).toBe(false);
  });
});

describe('mergeInboxAll: the all-projects twin', () => {
  it('stamps both lists with their project and sums the counts', () => {
    const merged = mergeInboxAll([
      { client: { id: 'acme', displayName: 'Acme', accent: '#0f766e' }, data: { unanswered: 2, posts: [group()], elsewhere: [elsewhere()] } },
      { client: { id: 'globex', displayName: 'Globex', accent: '#7c3aed' }, data: { posts: [group({ unanswered: 3 })] } },
      { client: { id: 'down', displayName: 'Down' }, data: undefined },
    ]);
    expect(merged.unanswered).toBe(5);
    expect(merged.posts.map((g) => g.clientId)).toEqual(['acme', 'globex']);
    expect(merged.elsewhere[0]).toMatchObject({ clientId: 'acme', clientName: 'Acme', accent: '#0f766e' });
  });
});
