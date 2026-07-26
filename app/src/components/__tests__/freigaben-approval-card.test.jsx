import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// B2 part 1: the ApprovalCard must show the post's caption BODY (not just the
// single firstLine detail) AND reuse PostPreview so the reviewer sees the post's
// real shape inline (poster/cover for media-backed; LinkCardPreview for text).
// We mock the write/read layer; lintText returns a CLEAN envelope so the
// advisory brand-lint badge stays silent and does not interfere.
const approvePost = vi.fn(() => Promise.resolve({ ok: true }));
const rejectPost = vi.fn(() => Promise.resolve({ ok: true }));
const lintText = vi.fn(() =>
  Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] }),
);

vi.mock('../../lib/api.js', () => ({
  approvePost: (...a) => approvePost(...a),
  rejectPost: (...a) => rejectPost(...a),
  lintText: (...a) => lintText(...a),
  usePendpostHealth: () => healthState,
  // Freigaben reads the connected accounts once at the parent for the destination strip.
  useAccounts: () => ({ data: null, isLoading: false, isError: false }),
}));

// setup=null by default => redditWarmthInputs yields no warmth (the advisory fixture below
// depends on that) AND unconnectedLanes returns [] (no rows => never guess a lane is broken).
let healthState = { data: null };

const CAPTION = 'Spring promo headline line\nThis is the full caption body that reviewers need to read before approving.';

const mediaPost = {
  id: 'p1',
  campaign: 'spring',
  title: 'Spring promo',
  caption: CAPTION,
  platforms: ['instagram'],
  approval: 'pending',
  derivedState: 'draft',
  scheduledAt: '2026-07-01T10:00:00Z',
  type: 'reel',
  image: null,
  media: { file: 'reel.mp4', exists: true, bytes: 1000, url: '/media?p=reel.mp4', cover: '/media?p=reel.jpg', path: 'reel.mp4' },
};

const textPost = {
  id: 'p2',
  campaign: 'spring',
  title: 'Article share',
  caption: 'An article worth a LinkedIn share with a meaty caption body line.',
  platforms: ['linkedin'],
  approval: 'pending',
  derivedState: 'draft',
  scheduledAt: '2026-07-02T10:00:00Z',
  type: 'text',
  link: 'https://example.com/blog/post',
  image: 'https://res.cloudinary.com/demo/hero.jpg',
  media: { file: null, exists: false, bytes: null, url: null, cover: null, path: null },
};

// A reddit post carrying a warmth ADVISORY - the fixture the nesting assertion below
// needs to be worth anything. usePendpostHealth is mocked to {data:null} => setup=null,
// so redditWarmthInputs yields no age/karma and laneReadiness fails closed with
// promo+cold => hasAdvisory. The advisory renders an IconBadge, and an IconBadge WITH a
// label is a real <button> (Tip -> RT.Trigger asChild). An instagram/pending fixture
// renders no contextBadges at all, so it can never catch a badge nested in the
// open-detail button - that blind spot is how the nested-button bug shipped.
const redditAdvisoryPost = {
  id: 'p3',
  campaign: 'spring',
  title: 'Built an MCP server',
  caption: 'A reddit self-post whose account warmth is unknown, so it reads as promotional.',
  platforms: ['reddit'],
  approval: 'pending',
  derivedState: 'draft',
  scheduledAt: '2026-07-03T10:00:00Z',
  type: 'text',
  image: null,
  media: { file: null, exists: false, bytes: null, url: null, cover: null, path: null },
};

// The OTHER IconBadge trigger on an actionable card: auto-approved. editedSinceApproval
// keeps it actionable (so it stays in the default "to review" tab) while approvalBy
// renders the Sparkles badge. Same nesting path as the advisory, different condition.
const autoApprovedPost = {
  ...mediaPost,
  id: 'p4',
  title: 'Auto approved promo',
  approval: 'approved',
  approvalBy: 'policy:auto-approve',
  editedSinceApproval: true,
  derivedState: 'waiting-due',
};

function renderFreigaben(posts) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const campaigns = [{ id: 'spring', active: true, posts }];
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Freigaben campaigns={campaigns} onOpen={() => {}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  approvePost.mockClear();
  rejectPost.mockClear();
  lintText.mockClear();
  healthState = { data: null };
});

// The queue is the surface the operator actually works from, and it was the one the
// not-connected fix missed: the detail modal stopped offering a no-op approval while the card
// behind it still showed a green Freigeben on the same post. It already had `setup` in hand.
const radarReplyPost = {
  id: 'radar-reddit-abc',
  campaign: 'radar-replies',
  caption: 'A few things that helped me choose when I was in the same spot.',
  platforms: ['reddit'],
  approval: 'pending',
  derivedState: 'waiting-due',
  scheduledAt: '2026-07-14T16:53:00Z',
  type: 'text',
  image: null,
  media: { file: null, exists: false, bytes: null, url: null, cover: null, path: null },
  radarReplyTo: {
    url: 'https://reddit.com/r/askswitzerland/comments/abc/x',
    source: 'reddit',
    externalId: 't3_abc',
    author: 'WorthObjective6266',
    community: 'askswitzerland',
    excerpt: 'Looking for an ADHD coach for women if possible.',
  },
};

describe('the queue tells the truth about a lane it cannot publish to', () => {
  it('offers Approve while the lane is connected', () => {
    healthState = { data: { setup: { platforms: [{ platform: 'reddit', status: 'connected' }] } } };
    renderFreigaben([radarReplyPost]);
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /post yourself/i })).not.toBeInTheDocument();
  });

  it('replaces Approve on the CARD when the lane is not connected', () => {
    healthState = { data: { setup: { platforms: [{ platform: 'reddit', status: 'incomplete' }] } } };
    renderFreigaben([radarReplyPost]);
    expect(screen.getByRole('button', { name: /post yourself/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
  });

  it('replaces the approval pill with the consequence on the card too', () => {
    healthState = { data: { setup: { platforms: [{ platform: 'reddit', status: 'incomplete' }] } } };
    renderFreigaben([radarReplyPost]);
    expect(screen.getByText(/you post this yourself/i)).toBeInTheDocument();
    expect(screen.queryByText(/waiting for approval/i)).not.toBeInTheDocument();
  });

  it('shows the thread being answered on the card, not only pendpost\'s own reply', () => {
    renderFreigaben([radarReplyPost]);
    expect(screen.getByText('WorthObjective6266')).toBeInTheDocument();
    expect(screen.getByText('askswitzerland')).toBeInTheDocument();
    expect(screen.getByText(/Looking for an ADHD coach for women/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open thread/i })).toHaveAttribute('href', radarReplyPost.radarReplyTo.url);
  });

  it('renders NO link-card preview for a reply: it has no link, and the empty box claimed a LinkedIn card on a Reddit post', () => {
    renderFreigaben([radarReplyPost]);
    expect(screen.queryByText(/no preview image|Kein Vorschaubild/i)).not.toBeInTheDocument();
  });
});

describe('Freigaben ApprovalCard caption body + inline PostPreview', () => {
  it('renders the full caption body, not just the single firstLine detail', () => {
    renderFreigaben([mediaPost]);
    expect(
      screen.getByText(/This is the full caption body that reviewers need to read/i),
    ).toBeInTheDocument();
  });

  it('renders an inline preview element (poster img / video) for a media-backed post', () => {
    const { container } = renderFreigaben([mediaPost]);
    // The poster/cover path renders an <img>; reserve full <video> for detail.
    const media = container.querySelector('img, video');
    expect(media).toBeTruthy();
  });

  it('renders the LinkCardPreview for a text-type post', () => {
    renderFreigaben([textPost]);
    expect(screen.getByText(/LinkedIn card preview/i)).toBeInTheDocument();
  });

  it('keeps the open-detail button free of nested interactive descendants (no interactive-in-interactive)', () => {
    renderFreigaben([mediaPost]);
    // The open-detail affordance is a button covering the cover + headline + meta.
    const openButtons = screen
      .getAllByRole('button')
      .filter((b) => b.querySelector('img, video') || /Spring promo/.test(b.textContent || ''));
    expect(openButtons.length).toBeGreaterThan(0);
    for (const btn of openButtons) {
      // No button/a/input/select/textarea nested inside the open-detail button.
      expect(within(btn).queryByRole('button')).toBeNull();
      expect(btn.querySelector('button, a, input, select, textarea')).toBeNull();
    }
  });

  it('has no axe violations with caption body + preview present', async () => {
    const { container } = renderFreigaben([mediaPost, textPost]);
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

// The invariant at the top of ApprovalCard, asserted against the cards that actually
// render an interactive badge. An IconBadge with a label IS a <button>, so a badge
// inside the open-detail button is a <button> in a <button>: invalid HTML that React
// warns about on every render, breaks keyboard traversal and screen-reader semantics,
// and makes the badge's click ambiguous (it also fires open-detail).
describe('Freigaben ApprovalCard badges never nest inside the open-detail button', () => {
  it('renders the warmth advisory badge on a reddit post (guards the fixture itself)', () => {
    renderFreigaben([redditAdvisoryPost]);
    // If this ever goes silent the nesting assertions below turn vacuous - exactly the
    // blind spot that let the bug ship. Fail loudly here instead.
    expect(screen.getByText('Heads-up')).toBeInTheDocument();
  });

  it('nests no button inside any other button (advisory + auto-approved badges present)', () => {
    const { container } = renderFreigaben([redditAdvisoryPost, autoApprovedPost]);
    const nested = container.querySelectorAll('button button');
    expect(Array.from(nested).map((b) => b.getAttribute('aria-label') || b.textContent)).toEqual([]);
  });

  it('keeps every interactive element out of the open-detail button', () => {
    renderFreigaben([redditAdvisoryPost, autoApprovedPost]);
    const openButtons = screen
      .getAllByRole('button')
      .filter((b) => /Built an MCP server|Auto approved promo/.test(b.textContent || ''));
    expect(openButtons.length).toBeGreaterThan(0);
    for (const btn of openButtons) {
      expect(btn.querySelector('button, a, input, select, textarea')).toBeNull();
    }
  });

  it('has no axe violations (covers the nested-interactive rule) with badges present', async () => {
    const { container } = renderFreigaben([redditAdvisoryPost, autoApprovedPost]);
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

// Trust gate: an approved post edited after approval (editedSinceApproval:true) must
// read as NEEDING action (re-approve), not as a settled approved card. The publish
// gate refuses it until re-approval, so the review surface must resurface it.
describe('Freigaben edited-since-approval (trust gate)', () => {
  const editedPost = {
    ...mediaPost,
    id: 'p9',
    approval: 'approved',
    editedSinceApproval: true,
    derivedState: 'waiting-due',
  };

  it('surfaces an approved-but-edited post with a re-approve badge and an Approve action', () => {
    renderFreigaben([editedPost]);
    // The distinct amber pill (not the hidden green "Approved" pill).
    expect(screen.getByText('Re-approve')).toBeInTheDocument();
    // Actionable again: the card's Approve control (exact label) is present so the
    // owner can re-bless it - distinct from the keyboard-hint "Approve post" entry.
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('does NOT show a re-approve badge for a cleanly-approved post', () => {
    renderFreigaben([{ ...mediaPost, id: 'p10', approval: 'approved', editedSinceApproval: false, derivedState: 'waiting-due' }]);
    expect(screen.queryByText('Re-approve')).toBeNull();
  });
});
