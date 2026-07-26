import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import ActivityView from '../Activity.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';

// Spec 23 (webhook/realtime ingestion seam) — the normalized inbound-event feed rides
// the SAME Activity inbox chip as GBP reviews (no new page). We drive ActivityView with
// the inbox action-group selected (which mounts InboundEventsInbox) and mock
// useInboundEvents / useReviews to exercise the rows per-platform, the neutral empty
// state, and the degraded-cloud "last-known feed, no toast" behavior. The day feed and
// reviews block are empty so only the inbound-events block matters here.

const inboundState = vi.hoisted(() => ({ data: { ok: true, events: [] }, isLoading: false, isError: false }));

vi.mock('../../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useActivity: () => ({ data: { activity: [] }, isLoading: false, isError: false }),
    useReviews: () => ({ data: { ok: true, items: [] }, isLoading: false, isError: false }),
  };
});

vi.mock('../../lib/cloud.js', () => ({
  useInboundEvents: () => inboundState,
}));

const EVENTS = [
  { eventId: 'evt_1', type: 'comment', platform: 'instagram', clientId: 'default', postId: 'p1', externalPostId: 'ig_1', author: { id: 'u1', handle: 'alex', displayName: 'Alex M.' }, text: 'Love this drop!', reaction: null, parentId: null, permalink: 'https://instagram.com/p/abc', ts: '2026-07-11T09:00:00.000Z' },
  { eventId: 'evt_2', type: 'reaction', platform: 'discord', clientId: 'default', postId: null, externalPostId: 'msg_9', author: { id: 'u2', handle: 'jordan' }, text: null, reaction: '🔥', parentId: null, permalink: null, ts: '2026-07-11T08:00:00.000Z' },
];

function renderActivity(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ActivityView active platformFilter={[]} failuresOnly={false} actionGroups={['inbox']} {...props} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  inboundState.data = { ok: true, events: [] };
  inboundState.isLoading = false;
  inboundState.isError = false;
});

describe('inbound-events inbox (spec 23)', () => {
  it('renders one row per inbound event, with the platform glyph + label (PLATFORM_META)', () => {
    inboundState.data = { ok: true, events: EVENTS };
    renderActivity();
    expect(screen.getByText('Alex M.')).toBeInTheDocument();
    expect(screen.getByText('Love this drop!')).toBeInTheDocument();
    // The platform label rides in the same timestamp paragraph ("11:00 AM · Instagram"),
    // so match by substring rather than an exact node.
    expect(screen.getByText(/Instagram/)).toBeInTheDocument();
    // The reaction-only row has no text body but shows the platform + author.
    expect(screen.getByText('jordan')).toBeInTheDocument();
    expect(screen.getByText(/Discord/)).toBeInTheDocument();
    expect(screen.getByText('🔥')).toBeInTheDocument();
  });

  it('shows the neutral empty state when there are no inbound events (the honest state pre-cloud-receiver)', () => {
    inboundState.data = { ok: true, events: [] };
    renderActivity();
    expect(screen.getByText('No inbound events yet.')).toBeInTheDocument();
  });

  it('shows the last-known events (not a blank/error block) when the background pull is degraded', () => {
    // react-query keeps the previously-fetched `data` on a background refetch error;
    // this seam fails open server-side, so there is no NEW error surface to render -
    // the existing header cloud dot already reflects the degraded connection.
    inboundState.data = { ok: true, events: EVENTS };
    inboundState.isError = true;
    renderActivity();
    expect(screen.getByText('Alex M.')).toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/i)).not.toBeInTheDocument();
  });

  it('does NOT render the inbound-events block when the inbox chip is not selected', () => {
    inboundState.data = { ok: true, events: EVENTS };
    renderActivity({ actionGroups: [] });
    expect(screen.queryByText('Alex M.')).not.toBeInTheDocument();
    expect(screen.queryByText('No inbound events yet.')).not.toBeInTheDocument();
  });

  it('hides the inbound-events block under failures-only (an inbound event is never a failure)', () => {
    inboundState.data = { ok: true, events: EVENTS };
    renderActivity({ failuresOnly: true });
    expect(screen.queryByText('Alex M.')).not.toBeInTheDocument();
  });

  it('narrows rows client-side to the selected platform filter', () => {
    inboundState.data = { ok: true, events: EVENTS };
    renderActivity({ platformFilter: ['discord'] });
    expect(screen.queryByText('Alex M.')).not.toBeInTheDocument();
    expect(screen.getByText('jordan')).toBeInTheDocument();
  });

  it('gives the reaction glyph an accessible value instead of hiding it (spec 23 review NIT-6)', () => {
    // Previously aria-hidden="true", so a screen reader announced "Reaction · jordan ·
    // time" with no indication of WHICH reaction arrived. The glyph itself must now be
    // in the accessibility tree so its own accessible name (e.g. "fire") is read.
    inboundState.data = { ok: true, events: EVENTS };
    renderActivity();
    const reactionEl = screen.getByText('🔥');
    expect(reactionEl).not.toHaveAttribute('aria-hidden');
  });

  it('has no axe violations', async () => {
    inboundState.data = { ok: true, events: EVENTS };
    const { container } = renderActivity();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
