// B1: the Radar-Antworten facet on the pending tab. At engagement-engine volume the
// queue mixes planned campaign posts with radar reply drafts; the chip narrows to the
// radar work without touching the flat list mechanics (keyboard a/r triage, roving
// focus). Pinned here: hidden at zero, count == list, one predicate, a/r still works
// on a focused radar card, and the self-release when the last radar draft is decided.

import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

const approvePost = vi.fn(() => Promise.resolve({ ok: true }));
const rejectPost = vi.fn(() => Promise.resolve({ ok: true }));
const lintText = vi.fn(() =>
  Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] }),
);

vi.mock('../../lib/api.js', () => ({
  // A new dependency of the approval card: fail OPEN in tests (no content blockers) so
  // the approve button keeps its pre-gate behaviour here; blocking is covered in its own test.
  usePlatformValidate: () => ({ data: null }),
  approvePost: (...a) => approvePost(...a),
  rejectPost: (...a) => rejectPost(...a),
  lintText: (...a) => lintText(...a),
  usePendpostHealth: () => ({ data: null }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: null, isLoading: false, isError: false }),
}));

const mkPost = (id, title, when) => ({
  id,
  campaign: 'spring',
  title,
  caption: `${title} headline\nThe full caption body reviewers read before approving.`,
  platforms: ['instagram'],
  approval: 'pending',
  derivedState: 'draft',
  scheduledAt: when,
  type: 'reel',
  image: null,
  media: { file: 'reel.mp4', exists: true, bytes: 1000, url: '/media?p=reel.mp4', cover: '/media?p=reel.jpg', path: 'reel.mp4' },
});

const mkRadarReply = (id, title, when) => ({
  ...mkPost(id, title, when),
  platforms: ['mastodon'],
  type: 'text',
  media: { file: null, exists: false, bytes: null, url: null, cover: null, path: null },
  radarReplyTo: {
    url: `https://example.social/@someone/${id}`,
    source: 'mastodon',
    externalId: id,
    author: 'someone',
    excerpt: 'Looking for a tool that does exactly this.',
  },
});

const planned = mkPost('p1', 'Alpha promo', '2026-07-01T10:00:00Z');
const radarA = mkRadarReply('r1', 'Radar answer one', '2026-07-02T10:00:00Z');
const radarB = mkRadarReply('r2', 'Radar answer two', '2026-07-03T10:00:00Z');

function Providers({ children }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>{children}</ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

function renderFreigaben(posts) {
  const campaigns = [{ id: 'spring', active: true, posts }];
  return render(
    <Providers>
      <Freigaben campaigns={campaigns} onOpen={() => {}} />
    </Providers>,
  );
}

// A host owning the posts in state, so a test can simulate the post-decision
// refetch that empties the radar set while the filter is still switched on.
let hostSetPosts;
function StatefulHost({ initial }) {
  const [posts, setPosts] = useState(initial);
  hostSetPosts = setPosts;
  return <Freigaben campaigns={[{ id: 'spring', active: true, posts }]} onOpen={() => {}} />;
}

beforeEach(() => {
  approvePost.mockClear();
  rejectPost.mockClear();
  lintText.mockClear();
});

describe('Freigaben Radar-Antworten filter chip', () => {
  it('is hidden while no radar reply draft awaits a decision - never an empty toggle', () => {
    renderFreigaben([planned]);
    expect(screen.queryByRole('button', { name: /Radar replies/ })).not.toBeInTheDocument();
  });

  it('carries the same count the narrowed list will show', () => {
    renderFreigaben([planned, radarA, radarB]);
    expect(screen.getByRole('button', { name: 'Radar replies (2)' })).toBeInTheDocument();
  });

  it('narrows the queue to radar replies and back, one predicate, no other mechanics', async () => {
    const user = userEvent.setup();
    renderFreigaben([planned, radarA, radarB]);
    const chip = screen.getByRole('button', { name: 'Radar replies (2)' });
    await user.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Alpha promo')).not.toBeInTheDocument();
    expect(screen.getByText('Radar answer one')).toBeInTheDocument();
    expect(screen.getByText('Radar answer two')).toBeInTheDocument();
    await user.click(chip);
    expect(screen.getByText('Alpha promo')).toBeInTheDocument();
  });

  it('keyboard a-approve still works on a focused radar card behind the filter', async () => {
    const user = userEvent.setup();
    renderFreigaben([planned, radarA]);
    await user.click(screen.getByRole('button', { name: 'Radar replies (1)' }));
    // Move focus onto the (now only) card, as ArrowDown/roving focus would.
    const li = screen.getByText('Radar answer one').closest('li');
    li.focus();
    expect(li).toHaveFocus();
    await user.keyboard('a');
    await waitFor(() => expect(approvePost).toHaveBeenCalledWith('spring', 'r1'));
  });

  it('self-releases when the last radar draft is decided: the full queue returns, no pressed chip over an empty list', async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <StatefulHost initial={[planned, radarA]} />
      </Providers>,
    );
    await user.click(screen.getByRole('button', { name: 'Radar replies (1)' }));
    expect(screen.queryByText('Alpha promo')).not.toBeInTheDocument();
    // The decision lands and the refetch drops the radar draft from the queue.
    hostSetPosts([planned]);
    // The chip hides (count is 0) and the filter releases the same frame: the
    // remaining decision work is visible again.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Radar replies/ })).not.toBeInTheDocument();
      expect(screen.getByText('Alpha promo')).toBeInTheDocument();
    });
  });
});
