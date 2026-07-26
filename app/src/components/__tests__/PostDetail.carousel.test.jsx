import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 05: the review dialog is where the bug was seen. It used to render TWO
// disconnected pictures of the same album - a read-only thumbnail grid in the left
// column, and a red "no media selected" error in the media pane - and neither handled
// the 0-slide or 1-slide case. Both are now the ONE album render in the media pane.
//
// This file asserts the FOLD-IN: exactly one album render, no leftover strip, and the
// album's recovery control reaching the same handler the overflow menu uses.

vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  usePendpostHealth: () => ({ data: { setup: { platforms: [] } } }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
  approvePost: vi.fn(),
  rejectPost: vi.fn(),
  deletePost: vi.fn(),
  unschedulePost: vi.fn(),
  reschedulePost: vi.fn(),
  markPosted: vi.fn(),
  verifyPost: vi.fn(),
  setCoverFrame: vi.fn(),
  uploadCover: vi.fn(),
  clearCover: vi.fn(),
  runPublishDue: vi.fn(),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
}));

vi.mock('../../lib/cloud.js', async (importOriginal) => ({
  ...(await importOriginal()),
  useCloudDelivery: () => ({ cloudOn: false, cloudLanes: [], resolved: false }),
}));

const slide = (n, url = `/media?p=s${n}.png`) => ({
  file: `s${n}.png`, path: `/abs/s${n}.png`, exists: Boolean(url), url, bytes: 2048, resolution: 'feed-4x5',
});

const albumPost = (items, extra = {}) => ({
  id: 'ig16-first10-carousel',
  campaign: 'social-growth',
  caption: 'Swipe through',
  platforms: ['instagram'],
  approval: 'draft',
  derivedState: 'scheduled',
  scheduledAt: '2026-08-07T10:00:00Z',
  type: 'carousel',
  rev: 1,
  executionMode: 'fully-scheduled',
  image: null,
  ids: {},
  cover: null,
  mediaItems: items.map((it) => ({ path: it.path })),
  media: { file: null, exists: true, bytes: null, url: null, cover: null, path: null, resolution: null, items },
  ...extra,
});

const renderDetail = (post, onEdit = () => {}) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <PostDetail post={post} onClose={() => {}} onEdit={onEdit} onNavigate={() => {}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => vi.clearAllMocks());

describe('PostDetail renders a healthy album once, with no error', () => {
  const items = [slide(1), slide(2), slide(3), slide(4), slide(5), slide(6), slide(7)];

  it('shows no error state anywhere in the dialog', () => {
    renderDetail(albumPost(items));
    expect(screen.queryByText('No media selected')).not.toBeInTheDocument();
    // The dialog may carry other advisory rows; what must be gone is a media error.
    for (const alert of screen.queryAllByRole('alert')) {
      expect(alert.textContent).not.toMatch(/media/i);
    }
  });

  it('renders exactly ONE album summary line, not a strip plus a preview', () => {
    renderDetail(albumPost(items));
    // Scoped to the album's own summary line. A looser /Carousel/ query would also hit
    // the Format select's option label, which is a different thing entirely.
    expect(screen.getByText('Carousel · 7 slides · 4:5')).toBeInTheDocument();
  });

  it('drops the old strip: no per-slide filename captions remain', () => {
    // The retired strip printed each slide's filename under its thumbnail. The viewer
    // names a file only when that slide is MISSING, which is the only time it matters.
    renderDetail(albumPost(items));
    expect(screen.queryByText('s1.png')).not.toBeInTheDocument();
    expect(screen.queryByText('s7.png')).not.toBeInTheDocument();
  });

  it('offers one navigation control per slide', () => {
    renderDetail(albumPost(items));
    expect(screen.getAllByRole('button', { name: /^Show slide \d+$/ })).toHaveLength(7);
  });

  it('no longer offers a Format option that claims a 1:1 album', () => {
    renderDetail(albumPost(items));
    expect(screen.queryByRole('option', { name: 'Carousel (1:1)' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Carousel' })).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderDetail(albumPost(items));
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

describe('PostDetail album recovery', () => {
  it('an under-count album offers a control that reaches the SAME handler as the menu', async () => {
    const onEdit = vi.fn();
    renderDetail(albumPost([slide(1)]), onEdit);
    await userEvent.click(screen.getByRole('button', { name: 'Open in editor' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit.mock.calls[0][0].id).toBe('ig16-first10-carousel');
  });

  it('an empty album is a recoverable state rather than a bare red error', () => {
    renderDetail(albumPost([]), vi.fn());
    expect(screen.getByText(/No slides yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open in editor' })).toBeInTheDocument();
    expect(screen.queryByText('No media selected')).not.toBeInTheDocument();
  });

  it('withholds the recovery control once the post is published (not editable)', () => {
    renderDetail(albumPost([], { derivedState: 'posted' }), vi.fn());
    expect(screen.queryByRole('button', { name: 'Open in editor' })).not.toBeInTheDocument();
  });
});

describe('PostDetail does not offer a cover editor for an album', () => {
  it('keeps the video-only cover editor away from a carousel', () => {
    // The cover editor gates on post.media.url, which an album never has, and no lane
    // accepts an album cover. It must stay absent rather than stamping a phantom cover.
    renderDetail(albumPost([slide(1), slide(2)]));
    expect(screen.queryByText(/as the cover/i)).not.toBeInTheDocument();
  });
});
