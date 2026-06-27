import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// US-APPR-07: the bulk approve/reject bar must sit at the TOP of the queue, not
// the bottom, so the primary "alle freigeben" action is reachable without
// scrolling past a long list (owner testing feedback).
vi.mock('../../lib/api.js', () => ({
  approvePost: vi.fn(() => Promise.resolve({ ok: true })),
  rejectPost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
}));

const post = {
  id: 'p1', campaign: 'spring', title: 'Spring promo', caption: 'Spring promo headline',
  platforms: ['instagram'], approval: 'pending', derivedState: 'draft',
  scheduledAt: '2026-07-01T10:00:00Z', type: 'reel', image: null,
  media: { file: 'reel.mp4', exists: true, bytes: 1000, url: '/media?p=reel.mp4', cover: '/media?p=reel.jpg', path: 'reel.mp4' },
};

function renderFreigaben(posts) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Freigaben campaigns={[{ id: 'spring', active: true, posts }]} onOpen={() => {}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Freigaben bulk action bar position', () => {
  it('renders the bulk action bar ABOVE the post list when posts are selected', async () => {
    const user = userEvent.setup();
    const { container } = renderFreigaben([post]);
    await user.click(screen.getByRole('checkbox', { name: /select post/i }));

    const selected = await screen.findByText(/1 selected/i);
    const list = container.querySelector('ul[role="list"]');
    expect(list).toBeTruthy();
    // DOCUMENT_POSITION_FOLLOWING set => `list` comes AFTER the bulk bar text,
    // i.e. the bulk bar precedes the list in the document.
    expect(selected.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
