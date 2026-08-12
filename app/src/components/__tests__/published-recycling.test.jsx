import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Published from '../Published.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// ux-audit dim-3 M1 (evergreen recycling): Published surfaces AGED high-performers
// behind one conditional filter, and each such row offers a "Recycle" action that
// seeds a fresh draft (via onRecycle -> the gated create path) - it never
// re-publishes the live post.
vi.mock('../../lib/api.js', () => ({
  useAccounts: () => ({ data: { publicUrls: {} } }),
  verifyPost: vi.fn(() => Promise.resolve({ ok: true })),
}));

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

function post(over) {
  return {
    campaign: 'c', id: 'p', derivedState: 'posted', type: 'reel', platforms: ['instagram'],
    media: { cover: null, url: null, path: 'data/media/x.mp4' }, image: null, caption: 'proven cap', ...over,
  };
}

function renderPublished({ posts, evergreen = [], onRecycle = () => {} }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <Published campaigns={[{ id: 'c', active: true, posts }]} onOpen={() => {}} evergreen={evergreen} onRecycle={onRecycle} />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Published: evergreen recycling filter (dim-3 M1)', () => {
  it('offers no recycling filter when nothing is flagged evergreen', () => {
    renderPublished({ posts: [post({ id: 'p1', title: 'One', postedAt: iso(40) })], evergreen: [] });
    expect(screen.queryByRole('button', { name: /recycle-worthy/i })).toBeNull();
  });

  it('surfaces the filter, narrows to the winner, and recycles it into a fresh draft', async () => {
    const user = userEvent.setup();
    const onRecycle = vi.fn();
    const winner = post({ id: 'p1', title: 'Winner', postedAt: iso(40) });
    renderPublished({
      posts: [winner, post({ id: 'p2', title: 'Ordinary', postedAt: iso(41) })],
      evergreen: [{ campaign: 'c', postId: 'p1', score: 120 }],
      onRecycle,
    });
    // Both posts visible, no Recycle action until the filter is engaged.
    expect(screen.getByText('Winner')).toBeInTheDocument();
    expect(screen.getByText('Ordinary')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /recycle this post/i })).toBeNull();

    // The conditional filter appears with its count.
    const toggle = screen.getByRole('button', { name: /recycle-worthy \(1\)/i });
    await user.click(toggle);

    // The list narrows to the flagged winner; the ordinary post drops out.
    expect(screen.getByText('Winner')).toBeInTheDocument();
    expect(screen.queryByText('Ordinary')).toBeNull();

    // The Recycle action seeds a draft from THIS post (never touches the live one).
    const recycle = screen.getByRole('button', { name: /recycle this post/i });
    await user.click(recycle);
    expect(onRecycle).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
  });
});
