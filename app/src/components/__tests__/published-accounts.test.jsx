import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Published from '../Published.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// A5: the Published account strip deactivates Facebook (dropped even when its
// public URL is set) and surfaces the active platforms - Instagram, YouTube,
// LinkedIn, and X - whose env-derived public URL exists AND that this workspace
// has actually published to (so it never links a platform never posted to).
vi.mock('../../lib/api.js', () => ({
  useAccounts: () => ({
    data: {
      publicUrls: {
        facebook: 'https://facebook.com/acme',
        instagram: 'https://instagram.com/acme',
        youtube: 'https://youtube.com/channel/UC123',
        linkedin: 'https://linkedin.com/company/acme',
        x: 'https://x.com/acme',
      },
    },
  }),
  verifyPost: vi.fn(() => Promise.resolve({ ok: true })),
}));

function renderPublished() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <Published
            campaigns={[{
              id: 'c',
              active: true,
              // A published post touching every strip platform (+ facebook) so the
              // "only platforms actually published to" gate is satisfied.
              posts: [{
                id: 'p1', campaign: 'c', derivedState: 'posted', type: 'reel',
                platforms: ['facebook', 'instagram', 'youtube', 'linkedin', 'x'],
                scheduledAt: '2026-07-01T10:00:00Z', postedAt: '2026-07-01T10:00:00Z',
                media: {}, ids: {}, verify: null,
              }],
            }]}
            onOpen={() => {}}
          />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Published account strip (A5)', () => {
  it('does NOT show a Facebook account link even when its public URL is set', () => {
    renderPublished();
    expect(screen.queryByRole('link', { name: /open facebook/i })).toBeNull();
  });

  it('surfaces Instagram, YouTube, LinkedIn, and X account links', () => {
    renderPublished();
    expect(screen.getByRole('link', { name: /open instagram/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open youtube/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open linkedin/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open x/i })).toBeInTheDocument();
  });
});
