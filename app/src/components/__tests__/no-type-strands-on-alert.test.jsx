import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PostPreview } from '../ui.jsx';
import { TYPES } from '../../lib/format.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Flywheel item 1. This is the SECOND time a per-type render stranded on a type-blind
// error state in this component. The first is recorded in the comment at ui.jsx:433:
// text posts used to fall through to "the old red media missing error" too. It was fixed
// for that one type, and then it happened again for `carousel`, which shipped to
// production and made three healthy albums look broken for months.
//
// Fixing it a second time for a second type is not a fix, it is the same bug waiting for
// the tenth format. So this is promoted out of prose into a check that iterates TYPES
// and asserts that NO type, given healthy data for its own shape, renders role="alert".
//
// The red alert stays reachable and must NOT be softened: a genuinely broken
// single-media post still has to shout. What this forbids is a HEALTHY post reaching it
// because nobody wrote that type's branch.

const IMAGE_URL = '/media?p=pic.jpg';
const slide = (n) => ({ file: `s${n}.png`, path: `/abs/s${n}.png`, exists: true, url: `/media?p=s${n}.png`, bytes: 2048, resolution: 'feed-4x5' });

// Healthy data for each type: whatever that shape genuinely needs to be publishable.
// A media-less type gets no media; a media-backed one gets a resolvable file; an album
// gets resolved slides. If a new type needs something else, ADD IT HERE - do not delete
// the type from the list, which would put the door straight back on the latch.
function healthyPost(type) {
  const base = {
    id: `p-${type}`,
    campaign: 'c',
    type,
    platforms: ['linkedin'],
    approval: 'draft',
    derivedState: 'scheduled',
    scheduledAt: '2099-01-01T09:00:00Z',
    caption: 'A perfectly healthy post',
    title: 'Title',
    body: 'Body copy for the article shapes.',
    rev: 'r1',
    ids: {},
    cover: null,
  };
  if (type === 'carousel') {
    return {
      ...base,
      mediaItems: [{ path: '/abs/s1.png' }, { path: '/abs/s2.png' }],
      media: { file: null, exists: true, bytes: null, url: null, cover: null, path: null, resolution: null, items: [slide(1), slide(2)] },
    };
  }
  if (type === 'poll') {
    return { ...base, poll: { options: ['A', 'B'], durationMinutes: 1440 }, media: { file: null, exists: false, bytes: null, url: null, cover: null, path: null, resolution: null, items: [] } };
  }
  if (type === 'text' || type === 'nostr-longform') {
    return { ...base, media: { file: null, exists: false, bytes: null, url: null, cover: null, path: null, resolution: null, items: [] } };
  }
  if (type === 'image') {
    return { ...base, imageUrl: 'https://cdn.example.com/pic.jpg', media: { file: 'pic.jpg', exists: true, bytes: 10, url: IMAGE_URL, cover: null, path: '/abs/pic.jpg', resolution: 'feed-4x5', items: [] } };
  }
  // Every remaining shape is single-media backed.
  return { ...base, media: { file: 'v.mp4', exists: true, bytes: 10, url: '/media?p=v.mp4', cover: null, path: '/abs/v.mp4', resolution: 'feed-4x5', items: [] } };
}

function renderPreview(post) {
  return render(
    <I18nProvider locale="en">
      <TooltipProvider>
        <PostPreview post={post} />
      </TooltipProvider>
    </I18nProvider>,
  );
}

describe('no post type strands on the type-blind error state', () => {
  it('covers every type in TYPES, so the list cannot quietly shrink', () => {
    expect(TYPES.length).toBeGreaterThanOrEqual(10);
  });

  for (const type of TYPES) {
    it(`renders healthy ${type} without a role="alert"`, () => {
      const { unmount } = renderPreview(healthyPost(type));
      const alerts = screen.queryAllByRole('alert');
      expect(
        alerts.map((a) => a.textContent).join(' | '),
        `a healthy ${type} post reached an alert state - it is missing its own branch in PostPreview, which is exactly how the carousel bug shipped`,
      ).toBe('');
      unmount();
    });
  }
});
