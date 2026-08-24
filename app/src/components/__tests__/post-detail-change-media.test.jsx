// US-MEDIA-UP: an open post can swap its media in place. The detail dialog shows a
// "Media" control (the same VideoPicker the editor uses) for an editable single-
// media post, and never for a posted, text, or carousel post - those keep media
// editing where it belongs (nowhere / the Composer's multi-slide picker).
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme', accent: '#22566d' }, activeClientId: 'acme' }),
  usePendpostHealth: () => ({ data: { setup: { platforms: [] } } }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useAssets: () => ({ data: { dir: 'data/media', assets: [] } }),
  approvePost: vi.fn(), rejectPost: vi.fn(), deletePost: vi.fn(), unschedulePost: vi.fn(),
  reschedulePost: vi.fn(), markPosted: vi.fn(), verifyPost: vi.fn(), runPublishDue: vi.fn(),
  setCoverFrame: vi.fn(), uploadCover: vi.fn(), clearCover: vi.fn(), updatePost: vi.fn(),
}));

const BASE = {
  id: 'p1', campaign: 'spring', rev: 1, approval: 'pending', derivedState: 'scheduled',
  scheduledAt: '2026-07-01T10:00:00Z', executionMode: 'fully-scheduled', platforms: ['instagram'],
  ids: {}, cover: null, publishedVia: null, externalUrl: null, verify: null,
  media: { file: 'reel.mp4', exists: true, bytes: 1000, url: '/media?p=reel.mp4', cover: null, path: '/x/reel.mp4' },
};

function renderDetail(over) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <PostDetail post={{ ...BASE, ...over }} onClose={() => {}} onEdit={() => {}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const hasMediaControl = () => screen.queryAllByRole('button', { name: /choose video/i }).length > 0;

describe('PostDetail change-media control', () => {
  it('shows the Media picker for an editable reel', () => {
    renderDetail({ type: 'reel' });
    expect(screen.getByText('Media')).toBeInTheDocument();
    expect(hasMediaControl()).toBe(true);
  });

  it('shows it for an editable feed image too', () => {
    renderDetail({ type: 'image' });
    expect(hasMediaControl()).toBe(true);
  });

  it('hides it once the post is posted (not editable)', () => {
    renderDetail({ type: 'reel', derivedState: 'posted' });
    expect(hasMediaControl()).toBe(false);
  });

  it('hides it for a carousel (multi-slide editing stays in the Composer)', () => {
    renderDetail({ type: 'carousel', media: { file: null, exists: false, url: null, items: [] } });
    expect(hasMediaControl()).toBe(false);
  });

  it('hides it for a media-less text post', () => {
    renderDetail({ type: 'text', platforms: ['mastodon'], media: { file: null, exists: false, url: null } });
    expect(hasMediaControl()).toBe(false);
  });
});
