import { describe, it, expect } from 'vitest';
import { effectiveDelivery } from '../format.js';

// effectiveDelivery layers cloud coverage over the base native/local mechanism so the
// post-detail delivery statement tells the truth once the cloud is accounted for.
describe('effectiveDelivery', () => {
  const on = { cloudOn: true, cloudLanes: ['meta', 'linkedin', 'x'] };

  it('returns cloud for a covered lane when the cloud is on', () => {
    expect(effectiveDelivery('x', on)).toBe('cloud');
    expect(effectiveDelivery('linkedin', on)).toBe('cloud');
    // facebook/instagram resolve to the 'meta' lane via setupIdOf.
    expect(effectiveDelivery('facebook', on)).toBe('cloud');
    expect(effectiveDelivery('instagram', on)).toBe('cloud');
  });

  it('is native for a self-scheduling platform regardless of cloud', () => {
    expect(effectiveDelivery('youtube', on)).toBe('native');
    expect(effectiveDelivery('mastodon', { cloudOn: false, cloudLanes: [] })).toBe('native');
  });

  it('is local for an uncovered lane even when the cloud is on', () => {
    expect(effectiveDelivery('reddit', on)).toBe('local');
    expect(effectiveDelivery('tiktok', on)).toBe('local');
  });

  it('is local for a cloud-capable lane when the cloud is off', () => {
    expect(effectiveDelivery('x', { cloudOn: false, cloudLanes: [] })).toBe('local');
    expect(effectiveDelivery('x')).toBe('local'); // no options -> conservative
  });
});
