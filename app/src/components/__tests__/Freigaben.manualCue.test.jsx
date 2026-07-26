import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 37 (reversed 2026-07-13): every approved reddit post auto-publishes. A promotional or
// cold post shows a passive "Heads-up" advisory badge (the tooltip carries the concern); a warm
// organic post shows none. The approve action and the reject action are unchanged in every case -
// approving always leads to auto-publish, and a distinct human still approves every reddit post.
const approvePost = vi.fn(() => Promise.resolve({ ok: true }));
const rejectPost = vi.fn(() => Promise.resolve({ ok: true }));
const lintText = vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] }));

// A WARM account: an organic post is advisory-free, a promo post carries the promo advisory, so
// both branches are exercised under ONE warmth value.
const WARM_SETUP = { platforms: [{ platform: 'reddit', warmth: { ageDays: 400, linkKarma: 3000, commentKarma: 2000, karma: 5000 } }] };

vi.mock('../../lib/api.js', () => ({
  approvePost: (...a) => approvePost(...a),
  rejectPost: (...a) => rejectPost(...a),
  lintText: (...a) => lintText(...a),
  usePendpostHealth: () => ({ data: { setup: WARM_SETUP } }),
  // Freigaben reads the connected accounts once at the parent for the destination strip.
  useAccounts: () => ({ data: null, isLoading: false, isError: false }),
}));

const base = { campaign: 'spring', platforms: ['reddit'], approval: 'pending', derivedState: 'draft', scheduledAt: '2026-07-01T10:00:00Z', type: 'text', media: { file: null, exists: false } };
const promoPost = { ...base, id: 'promo1', title: 'Buy my thing', caption: 'Buy my thing now', isPromo: true };
const organicPost = { ...base, id: 'org1', title: 'A genuine question', caption: 'A genuine question for the community', isPromo: false };
// A Radar reply (spec 34) is handled by the radar path and must show NO advisory badge.
const radarReplyPost = { ...base, id: 'reply1', title: 'A helpful reply', caption: 'A helpful reply', radarReplyTo: { url: 'https://reddit.com/r/x/comments/abc', source: 'reddit', externalId: 't3_abc' } };

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

describe('Freigaben reddit warmth advisory (spec 37, reversed)', () => {
  it('shows the Heads-up advisory + reason on a promotional reddit post, and still lets it be approved', async () => {
    const { container } = renderFreigaben([promoPost]);
    // The inline "Heads-up" advisory marker (IconBadge) is present.
    expect(screen.getByText('Heads-up')).toBeInTheDocument();
    // The badge's accessible name carries the localized promo advisory.
    expect(screen.getByRole('button', { name: /reads as promotional/i })).toBeInTheDocument();
    // The approve action is unchanged (approving auto-publishes it). Exact name, since the
    // advisory tooltip text itself contains the word "approve".
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    await axeClean(container);
  });

  it('shows NO advisory on a warm + organic reddit post', () => {
    renderFreigaben([organicPost]);
    expect(screen.queryByText('Heads-up')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
  });

  it('shows NO advisory on a Radar reply reddit post (handled by the radar path)', () => {
    renderFreigaben([radarReplyPost]);
    expect(screen.queryByText('Heads-up')).not.toBeInTheDocument();
  });

  it('an advisory never blocks the actions (reject + approve both present alongside it)', () => {
    renderFreigaben([promoPost]);
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByText('Heads-up')).toBeInTheDocument();
  });
});
