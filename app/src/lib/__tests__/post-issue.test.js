import { describe, it, expect } from 'vitest';
import { postIssue, groupIssues, isNotConnectedFailure } from '../postIssue.js';

// postIssue is the ONE judge of "does this post need something from the owner, and what is
// the one fix". It lifts what the Studio already decided in three places (postStatusWord /
// blockedLanes in format.js, lastFailure.recovery from the engine, and the PostDetail banner's
// recovery switch) so the detail card, the list row and the tray can never disagree.

const setup = (rows) => ({ platforms: rows });
const base = {
  id: 'p1', campaign: 'launch', clientId: 'acme', caption: 'Hello', platforms: ['linkedin'],
  approval: 'approved', status: 'planned', derivedState: 'scheduled', scheduledAt: '2026-11-03T10:00:00Z',
};
const failing = (lastFailure, extra = {}) => ({ ...base, derivedState: 'publish-failed', lastFailure: { at: '2026-11-01T08:00:00Z', terminal: true, ...lastFailure }, ...extra });

describe('postIssue: blocked', () => {
  it('a post on one unconnected lane is blocked with a connect fix for that lane', () => {
    const issue = postIssue(base, setup([{ platform: 'linkedin', status: 'incomplete' }]));
    expect(issue).toEqual({
      kind: 'blocked', lane: 'linkedin', lanes: ['linkedin'], clientId: 'acme', cause: 'connect:linkedin', code: null,
      fix: { type: 'connect', lane: 'linkedin', agent: false },
    });
  });

  it('a post on several unconnected lanes names them all and fixes the first', () => {
    const post = { ...base, platforms: ['x', 'linkedin', 'mastodon'] };
    const issue = postIssue(post, setup([
      { platform: 'x', status: 'incomplete' }, { platform: 'linkedin', status: 'connected' }, { platform: 'mastodon', status: 'incomplete' },
    ]));
    expect(issue.kind).toBe('blocked');
    expect(issue.lanes).toEqual(['x', 'mastodon']);
    expect(issue.lane).toBe('x');
    expect(issue.fix).toEqual({ type: 'connect', lane: 'x', agent: false });
  });

  it('Instagram and Facebook resolve to the one Meta connect', () => {
    const post = { ...base, platforms: ['instagram'] };
    const issue = postIssue(post, setup([{ platform: 'meta', status: 'incomplete' }]));
    expect(issue.cause).toBe('connect:meta');
    expect(issue.fix.lane).toBe('meta');
    expect(issue.lanes).toEqual(['instagram']);
  });

  it('a Reddit post on the manual paste lane is NOT blocked: posting it yourself is the path', () => {
    const post = { ...base, platforms: ['reddit'] };
    expect(postIssue(post, setup([{ platform: 'reddit', status: 'incomplete' }]))).toBeNull();
  });
});

describe('postIssue: needs you', () => {
  it('a credential refusal reads needs-you with a reconnect fix', () => {
    const issue = postIssue(failing({ lane: 'linkedin', code: 'needs_scope', message: 'LinkedIn POST /rest/posts: HTTP 401', recovery: 'reconnect' }), null);
    expect(issue).toMatchObject({ kind: 'needs-you', lane: 'linkedin', cause: 'reconnect:linkedin', code: 'needs_scope', fix: { type: 'reconnect', lane: 'linkedin', agent: false } });
  });

  it('a lane that was never connected reads Connect, not Reconnect (Bluesky)', () => {
    const post = failing({ lane: 'bluesky', code: 'not_connected', message: 'Bluesky is not connected (BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD not set)', recovery: 'reconnect' }, { platforms: ['bluesky'] });
    expect(postIssue(post, null)).toMatchObject({ kind: 'needs-you', cause: 'connect:bluesky', fix: { type: 'connect', lane: 'bluesky' } });
  });

  it('a Bluesky reply parked under the old needs_scope "not set" message also reads Connect', () => {
    const post = failing({ lane: 'bluesky', code: 'needs_scope', message: 'BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD not set', recovery: 'reconnect' }, { platforms: ['bluesky'] });
    expect(postIssue(post, null).fix.type).toBe('connect');
  });

  it('a content block is an edit fix with the agent flag', () => {
    const issue = postIssue(failing({ lane: 'x', code: 'invalid_input', message: 'caption over 280', recovery: 'edit' }, { platforms: ['x'] }), null);
    expect(issue).toMatchObject({ kind: 'needs-you', cause: 'edit:x', fix: { type: 'edit', lane: 'x', agent: true } });
  });

  it('a long cloud hold is one cloud cause, whatever the lane', () => {
    const issue = postIssue(failing({ lane: 'linkedin', code: 'cloud_unanswered', recovery: 'cloud' }), null);
    expect(issue).toMatchObject({ kind: 'needs-you', cause: 'cloud:*', fix: { type: 'cloud', agent: false } });
  });

  it('X reply restriction is a manual fix', () => {
    const issue = postIssue(failing({ lane: 'x', code: 'needs_scope', recovery: 'manual' }, { platforms: ['x'] }), null);
    expect(issue).toMatchObject({ kind: 'needs-you', cause: 'manual:x', fix: { type: 'manual', lane: 'x' } });
  });

  it('a halted lane (credits) is a resume fix', () => {
    const issue = postIssue(failing({ lane: 'x', code: 'credits', halted: true }, { platforms: ['x'] }), null);
    expect(issue).toMatchObject({ kind: 'needs-you', cause: 'resume:x', fix: { type: 'resume', lane: 'x' } });
  });

  it('a Radar reply whose thread is gone is a discard fix', () => {
    const post = failing({ lane: 'x', message: 'reply target is no longer available', terminal: false }, {
      platforms: ['x'], radarReplyTo: { source: 'x', url: 'https://x.com/a/status/1' }, radarReplyState: 'target_gone',
    });
    expect(postIssue(post, null)).toMatchObject({ kind: 'needs-you', cause: 'discard:x', fix: { type: 'discard', lane: 'x' } });
  });

  it('the engine code rides along for the Details disclosure', () => {
    expect(postIssue(failing({ lane: 'linkedin', code: 'needs_scope', recovery: 'reconnect' }), null).code).toBe('needs_scope');
  });
});

describe('postIssue: nothing to do', () => {
  it('a calm approved post returns null', () => {
    expect(postIssue(base, setup([{ platform: 'linkedin', status: 'connected' }]))).toBeNull();
  });

  it('a failure pendpost is still retrying returns null (it heals on its own)', () => {
    expect(postIssue(failing({ lane: 'linkedin', terminal: false, message: 'HTTP 503' }), null)).toBeNull();
  });

  it('a stale lastFailure on a rescheduled, healthy post returns null', () => {
    expect(postIssue({ ...base, lastFailure: { lane: 'linkedin', recovery: 'reconnect' } }, null)).toBeNull();
  });

  it('a posted post returns null', () => {
    expect(postIssue({ ...base, derivedState: 'posted', status: 'posted' }, setup([{ platform: 'linkedin', status: 'incomplete' }]))).toBeNull();
  });

  it('a post without a clientId carries clientId null', () => {
    const { clientId, ...rest } = base; // eslint-disable-line no-unused-vars
    expect(postIssue(rest, setup([{ platform: 'linkedin', status: 'incomplete' }])).clientId).toBeNull();
  });
});

describe('isNotConnectedFailure', () => {
  it('reads the not_connected code and the old Bluesky "not set" message, nothing else', () => {
    expect(isNotConnectedFailure({ code: 'not_connected' })).toBe(true);
    expect(isNotConnectedFailure({ code: 'needs_scope', message: 'BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD not set' })).toBe(true);
    expect(isNotConnectedFailure({ code: 'needs_scope', message: 'bluesky session HTTP 401' })).toBe(false);
    expect(isNotConnectedFailure(null)).toBe(false);
  });
});

describe('groupIssues', () => {
  const bskyReply = (id) => failing(
    { lane: 'bluesky', code: 'not_connected', message: 'Bluesky is not connected', recovery: 'reconnect' },
    { id, platforms: ['bluesky'] },
  );

  it('folds four Bluesky replies into ONE group with four posts', () => {
    const posts = ['b1', 'b2', 'b3', 'b4'].map(bskyReply);
    const groups = groupIssues(posts, null);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ cause: 'connect:bluesky', kind: 'needs-you', lane: 'bluesky', clientId: 'acme', fix: { type: 'connect', lane: 'bluesky' } });
    expect(groups[0].posts.map((p) => p.id)).toEqual(['b1', 'b2', 'b3', 'b4']);
  });

  it('needs-you groups lead blocked ones, then by post count', () => {
    const s = setup([{ platform: 'linkedin', status: 'incomplete' }, { platform: 'x', status: 'connected' }]);
    const blocked = ['l1', 'l2', 'l3'].map((id) => ({ ...base, id }));
    const edit = failing({ lane: 'x', code: 'invalid_input', recovery: 'edit' }, { id: 'e1', platforms: ['x'] });
    const bsky = ['b1', 'b2'].map(bskyReply);
    const calm = { ...base, id: 'c1', platforms: ['x'] };
    const groups = groupIssues([...blocked, edit, calm, ...bsky], s);
    expect(groups.map((g) => g.cause)).toEqual(['connect:bluesky', 'edit:x', 'connect:linkedin']);
    expect(groups.map((g) => g.posts.length)).toEqual([2, 1, 3]);
  });

  it('the same cause in two projects is two groups (each fix targets its own project)', () => {
    const groups = groupIssues([bskyReply('b1'), { ...bskyReply('b2'), clientId: 'other' }], null);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.clientId).sort()).toEqual(['acme', 'other']);
  });

  it('no issues, no groups', () => {
    expect(groupIssues([base], null)).toEqual([]);
    expect(groupIssues(undefined, null)).toEqual([]);
  });
});
