// nextActorOf - ONE truthful next-actor state per approval card.
//
// The approval card used to stack three independently-derived badges, and three
// independent conditions can contradict each other on one post: "Geplant" +
// "Du postest selbst" + "Automatisch freigegeben" all at once. This suite pins
// the strict first-match precedence so every contradiction resolves to exactly
// one key, and pins WHO acts next for each state.

import { describe, it, expect } from 'vitest';
import { nextActorOf } from '../format.js';

// A setup whose reddit lane is unconnected and whose linkedin lane is fine.
const setupRedditOffline = {
  platforms: [
    { platform: 'reddit', status: 'incomplete' },
    { platform: 'linkedin', status: 'connected' },
  ],
};

const base = {
  id: 'p1',
  campaign: 'c',
  platforms: ['linkedin'],
  approval: 'pending',
  derivedState: 'draft',
  scheduledAt: null,
};

describe('nextActorOf precedence table', () => {
  it('posted / verified-live is done, system-actor, and beats everything', () => {
    expect(nextActorOf({ ...base, derivedState: 'posted', approval: 'approved' }, null))
      .toEqual({ key: 'done', actor: 'system' });
    expect(nextActorOf({ ...base, derivedState: 'verified-live', approval: 'approved', editedSinceApproval: true }, null))
      .toEqual({ key: 'done', actor: 'system' });
  });

  it('publish-failed and overdue keep their own alarm keys, you-actor', () => {
    expect(nextActorOf({ ...base, derivedState: 'publish-failed', approval: 'approved' }, null))
      .toEqual({ key: 'publish-failed', actor: 'you' });
    expect(nextActorOf({ ...base, derivedState: 'overdue', approval: 'approved' }, null))
      .toEqual({ key: 'overdue', actor: 'you' });
  });

  it('V6 clamp folded in: a reviewPending post NEVER reads overdue-red', () => {
    expect(nextActorOf({ ...base, derivedState: 'overdue', approval: 'pending', reviewPending: true }, null))
      .toEqual({ key: 'clientSignoff', actor: 'client' });
  });

  it('an unconnected lane means you post it, whatever the schedule claims', () => {
    const post = { ...base, platforms: ['reddit'], approval: 'pending', derivedState: 'waiting-due' };
    expect(nextActorOf(post, setupRedditOffline)).toEqual({ key: 'handOff', actor: 'you' });
  });

  it('approved-but-edited needs a fresh decision from you', () => {
    expect(nextActorOf({ ...base, approval: 'approved', editedSinceApproval: true, derivedState: 'waiting-due' }, null))
      .toEqual({ key: 'reApprove', actor: 'you' });
  });

  it('awaiting client sign-off is the client acting, not you', () => {
    expect(nextActorOf({ ...base, approval: 'pending', reviewPending: true }, null))
      .toEqual({ key: 'clientSignoff', actor: 'client' });
  });

  it('pending, draft and absent approval all mean: you approve', () => {
    expect(nextActorOf({ ...base, approval: 'pending' }, null)).toEqual({ key: 'approve', actor: 'you' });
    expect(nextActorOf({ ...base, approval: 'draft' }, null)).toEqual({ key: 'approve', actor: 'you' });
    expect(nextActorOf({ ...base, approval: undefined }, null)).toEqual({ key: 'approve', actor: 'you' });
  });

  it('rejected is a settled you-decision', () => {
    expect(nextActorOf({ ...base, approval: 'rejected' }, null)).toEqual({ key: 'rejected', actor: 'you' });
  });

  it('approved with a slot is scheduled(system, at); without one, awaitingSlot', () => {
    expect(nextActorOf({ ...base, approval: 'approved', scheduledAt: '2026-08-20T07:00:00Z', derivedState: 'waiting-due' }, null))
      .toEqual({ key: 'scheduled', actor: 'system', at: '2026-08-20T07:00:00Z' });
    expect(nextActorOf({ ...base, approval: 'approved', scheduledAt: null, derivedState: 'draft' }, null))
      .toEqual({ key: 'awaitingSlot', actor: 'system' });
  });
});

// The three real-world contradiction stacks the old badges produced. Each MUST
// resolve to exactly ONE key.
describe('nextActorOf contradiction fixtures', () => {
  it('"Geplant" + "Du postest selbst": the unconnected lane wins - a schedule on a lane pendpost cannot publish to is not a schedule', () => {
    const post = { ...base, platforms: ['reddit'], approval: 'approved', scheduledAt: '2026-08-20T07:00:00Z', derivedState: 'waiting-due' };
    expect(nextActorOf(post, setupRedditOffline)).toEqual({ key: 'handOff', actor: 'you' });
  });

  it('"Automatisch freigegeben" + "Du postest selbst": still the hand-off - the policy approved a post only you can post', () => {
    const post = { ...base, platforms: ['reddit'], approval: 'approved', approvalBy: 'policy:auto-approve', scheduledAt: '2026-08-20T07:00:00Z', derivedState: 'waiting-due' };
    expect(nextActorOf(post, setupRedditOffline)).toEqual({ key: 'handOff', actor: 'you' });
  });

  it('auto-approved + edited-since-approval: re-approve wins - the edit invalidated the provenance', () => {
    const post = { ...base, approval: 'approved', approvalBy: 'policy:auto-approve', editedSinceApproval: true, derivedState: 'waiting-due', scheduledAt: '2026-08-20T07:00:00Z' };
    expect(nextActorOf(post, null)).toEqual({ key: 'reApprove', actor: 'you' });
  });
});
