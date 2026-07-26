import { describe, it, expect } from 'vitest';
import { unconnectedLanes } from '../format.js';

// The lanes pendpost cannot publish to, because they are not connected.
//
// The defect behind this: approving is a NO-OP on an unconnected lane. lib/writes.mjs
// setApproval checks the actor and self-approval and never connectivity, and the approve
// button was never disabled - so the one screen where an operator decides whether a post
// goes out was the one screen that could not tell them it would not. The live case was a
// Radar reply on Reddit for a project whose Reddit was never wired up: pressing Freigeben
// flipped a field and published nothing, forever.
//
// The shape mirrors pendpost_health's setup (lib/setup.mjs): platforms[] rows carrying
// { platform, status: connected|skipped|incomplete }.
const setup = (rows) => ({ platforms: rows });

describe('unconnectedLanes', () => {
  it('names an incomplete lane the post targets', () => {
    expect(unconnectedLanes({ platforms: ['reddit'] }, setup([{ platform: 'reddit', status: 'incomplete' }])))
      .toEqual(['reddit']);
  });

  it('is empty for a connected lane', () => {
    expect(unconnectedLanes({ platforms: ['reddit'] }, setup([{ platform: 'reddit', status: 'connected' }])))
      .toEqual([]);
  });

  it('does NOT flag a SKIPPED lane: the operator said they are not using it', () => {
    // Skipped is a decision, not a fault. There is nothing to fix and nothing to warn about.
    expect(unconnectedLanes({ platforms: ['reddit'] }, setup([{ platform: 'reddit', status: 'skipped' }])))
      .toEqual([]);
  });

  it('reports only the unconnected half of a multi-lane post', () => {
    const post = { platforms: ['linkedin', 'reddit', 'x'] };
    const s = setup([
      { platform: 'linkedin', status: 'connected' },
      { platform: 'reddit', status: 'incomplete' },
      { platform: 'x', status: 'connected' },
    ]);
    expect(unconnectedLanes(post, s)).toEqual(['reddit']);
  });

  it('ignores a lane with no setup row rather than guessing it is broken', () => {
    // A false "you must post this yourself" on a working lane is worse than staying quiet.
    expect(unconnectedLanes({ platforms: ['bluesky'] }, setup([{ platform: 'reddit', status: 'incomplete' }])))
      .toEqual([]);
  });

  it('is empty while setup has not loaded, so the UI never flashes a false hand-off', () => {
    expect(unconnectedLanes({ platforms: ['reddit'] }, undefined)).toEqual([]);
    expect(unconnectedLanes({ platforms: ['reddit'] }, { platforms: [] })).toEqual([]);
  });

  it('is defensive about a post with no platforms', () => {
    expect(unconnectedLanes({}, setup([{ platform: 'reddit', status: 'incomplete' }]))).toEqual([]);
    expect(unconnectedLanes(undefined, setup([]))).toEqual([]);
  });
});
