import { describe, it, expect } from 'vitest';
import { effectiveDelivery } from '../format.js';

// H6. The cloud never fires a carousel, and no surface said so: an album scheduled for a
// future time showed a plain "Geplant" while in truth it publishes only if this Mac is
// awake with the daemon running. That was live for three real scheduled posts.
//
// The fact is per-TYPE, and the capability endpoint is lane-shaped, so the type list
// arrives as an option rather than as a cloud read. It is checked BEFORE the lane check:
// a carousel on LinkedIn with the cloud on is still local, because it is the FORMAT the
// cloud cannot carry, not the lane.
//
// Every existing call passes no options object, so every existing caller stays green.
describe('effectiveDelivery, local-only formats (H6)', () => {
  const on = { cloudOn: true, cloudLanes: ['meta', 'linkedin', 'x'] };
  const withTypes = { ...on, type: 'carousel', localOnlyTypes: ['carousel', 'nostr-longform'] };

  it('is local for a carousel on a cloud lane, because the FORMAT is what the cloud cannot fire', () => {
    expect(effectiveDelivery('linkedin', withTypes)).toBe('local');
    expect(effectiveDelivery('x', withTypes)).toBe('local');
    expect(effectiveDelivery('instagram', withTypes)).toBe('local');
  });

  it('checks the type BEFORE the lane, so a cloud-covered lane cannot override it', () => {
    // Without the type it is 'cloud'. The only difference is the format.
    expect(effectiveDelivery('linkedin', on)).toBe('cloud');
    expect(effectiveDelivery('linkedin', withTypes)).toBe('local');
  });

  it('leaves a normal format on a cloud lane alone', () => {
    expect(effectiveDelivery('linkedin', { ...withTypes, type: 'reel' })).toBe('cloud');
  });

  it('does not override a NATIVE lane: the platform schedules it itself, cloud or not', () => {
    // youtube self-schedules, so the Mac being asleep is irrelevant there. Claiming
    // "needs your Mac" would be a false alarm.
    expect(effectiveDelivery('youtube', { ...withTypes, type: 'carousel' })).toBe('native');
  });

  it('is inert when the caller passes no type list, so every existing call stays identical', () => {
    expect(effectiveDelivery('linkedin', on)).toBe('cloud');
    expect(effectiveDelivery('linkedin', { ...on, type: 'carousel' })).toBe('cloud');
    expect(effectiveDelivery('x')).toBe('local');
  });
});
