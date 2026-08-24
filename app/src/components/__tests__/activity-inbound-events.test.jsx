import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import ActivityView from '../Activity.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';

// The inbound-event reply WRITE client fn is mocked so no test hits the network; each
// case sets its own resolve/reject on this hoisted spy.
const replyMock = vi.hoisted(() => vi.fn());
// A thrown server error carries a stable `code` (sendJson surfaces it as err.code); the
// reply box maps that code to its remediation. This mirrors the real error shape.
function codedError(code) {
  return Object.assign(new Error(`inbound reply failed: ${code}`), { code });
}

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
    replyToInboundEvent: replyMock,
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

// A repliable X mention (carries a thread) - the reply box renders on this row.
const MENTION = { eventId: 'evt_m', type: 'mention', platform: 'x', clientId: 'default', postId: 'p9', externalPostId: 'x_9', author: { id: 'u3', handle: 'mia', displayName: 'Mia P.' }, text: '@you thoughts on this?', reaction: null, parentId: null, permalink: 'https://x.com/mia/status/9', ts: '2026-07-11T11:00:00.000Z' };
const FOLLOW = { eventId: 'evt_f', type: 'follow', platform: 'x', clientId: 'default', postId: null, externalPostId: null, author: { id: 'u9', handle: 'sam', displayName: 'Sam R.' }, text: null, reaction: null, parentId: null, permalink: 'https://x.com/sam', ts: '2026-07-11T10:30:00.000Z' };

beforeEach(() => {
  inboundState.data = { ok: true, events: [] };
  inboundState.isLoading = false;
  inboundState.isError = false;
  replyMock.mockReset();
  replyMock.mockResolvedValue({ ok: true, id: 'reply_1', platform: 'x', eventId: 'evt_m' });
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

  it('renders an X `follow` event with the "New follower" label, the author, and the X platform (X Activity API)', () => {
    // A follow has no post and no reaction body - only an author - so the type label
    // is what carries the meaning. `follow` is the one new enum member the X Activity
    // seam adds; likes/reposts ride the existing `reaction` field.
    inboundState.data = { ok: true, events: [
      { eventId: 'evt_f', type: 'follow', platform: 'x', clientId: 'default', postId: null, externalPostId: null, author: { id: 'u9', handle: 'sam', displayName: 'Sam R.' }, text: null, reaction: null, parentId: null, permalink: 'https://x.com/sam', ts: '2026-07-11T10:00:00.000Z' },
    ] };
    renderActivity();
    expect(screen.getByText('New follower')).toBeInTheDocument();
    expect(screen.getByText('Sam R.')).toBeInTheDocument();
    // The platform label rides in the timestamp paragraph ("... · X").
    expect(screen.getByText(/· X/)).toBeInTheDocument();
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

// The inline reply affordance (spec 23 close-the-loop): a repliable inbound event
// (mention/comment/message) grows a reply box; a reaction/follow never does. Opening +
// sending calls replyToInboundEvent, and the server error code maps to a remediation
// (needs_scope -> authorize, credits -> top-up). The 280 counter guards the tweet lanes.
describe('inbound-event reply (spec 23 close-the-loop)', () => {
  it('shows a Reply control on a mention row but NONE on a follow or reaction row', () => {
    // EVENTS[1] is a reaction; FOLLOW is a follow. Only the mention is repliable, so exactly
    // one Reply control renders across the three rows.
    inboundState.data = { ok: true, events: [MENTION, FOLLOW, EVENTS[1]] };
    renderActivity();
    expect(screen.getByText('Mia P.')).toBeInTheDocument();
    expect(screen.getByText('Sam R.')).toBeInTheDocument();
    expect(screen.getByText('jordan')).toBeInTheDocument();
    const replyButtons = screen.getAllByRole('button', { name: /^reply$/i });
    expect(replyButtons).toHaveLength(1);
  });

  it('opens and submits the reply, calling replyToInboundEvent with the row eventId + text', async () => {
    inboundState.data = { ok: true, events: [MENTION] };
    renderActivity();
    fireEvent.click(screen.getByRole('button', { name: /^reply$/i }));
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'Thanks Mia!' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    // Success collapses the box to the neutral "Replied" marker.
    expect(await screen.findByText('Replied')).toBeInTheDocument();
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'evt_m', text: 'Thanks Mia!' }));
  });

  it('renders the authorize affordance when the server returns needs_scope (403)', async () => {
    replyMock.mockRejectedValue(codedError('needs_scope'));
    inboundState.data = { ok: true, events: [MENTION] };
    renderActivity();
    fireEvent.click(screen.getByRole('button', { name: /^reply$/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hi' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    expect(await screen.findByRole('button', { name: /authorize x in setup/i })).toBeInTheDocument();
  });

  it('renders the top-up affordance when the server returns credits (402)', async () => {
    replyMock.mockRejectedValue(codedError('credits'));
    inboundState.data = { ok: true, events: [MENTION] };
    renderActivity();
    fireEvent.click(screen.getByRole('button', { name: /^reply$/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hi' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    expect(await screen.findByRole('button', { name: /top up credits/i })).toBeInTheDocument();
  });

  it('disables Send past the 280-char cap on a tweet reply, with a live counter', () => {
    inboundState.data = { ok: true, events: [MENTION] };
    renderActivity();
    fireEvent.click(screen.getByRole('button', { name: /^reply$/i }));
    const box = screen.getByRole('textbox');
    // Exactly 280 is allowed; 281 trips the cap and disables Send.
    fireEvent.change(box, { target: { value: 'a'.repeat(280) } });
    expect(screen.getByText('280/280')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^send$/i })).not.toBeDisabled();
    fireEvent.change(box, { target: { value: 'a'.repeat(281) } });
    expect(screen.getByText('281/280')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
  });
});
