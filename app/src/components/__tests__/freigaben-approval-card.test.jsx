import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
const markPosted = vi.fn(() => Promise.resolve({ ok: true }));
const lintText = vi.fn(() =>
  Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] }),
);

vi.mock('../../lib/api.js', () => ({
  // A new dependency of the approval card. Reads a mutable holder so most tests fail OPEN
  // (no content blockers => the button keeps its pre-gate behaviour) while the gate test
  // below feeds a real over-limit verdict. Mirrors the healthState pattern used here.
  usePlatformValidate: () => platformValidateState,
  approvePost: (...a) => approvePost(...a),
  rejectPost: (...a) => rejectPost(...a),
  markPosted: (...a) => markPosted(...a),
  lintText: (...a) => lintText(...a),
  usePendpostHealth: () => healthState,
  useConfig: () => ({ data: null }),
  // Freigaben reads the connected accounts once at the parent for the destination strip.
  useAccounts: () => ({ data: null, isLoading: false, isError: false }),
}));

// setup=null by default => redditWarmthInputs yields no warmth (the advisory fixture below
// depends on that) AND unconnectedLanes returns [] (no rows => never guess a lane is broken).
let healthState = { data: null };
// The per-post readiness verdict. Default fails OPEN (no data => no blockers). The gate
// test overrides it with a real over-limit problem, exactly as platform_validate returns.
let platformValidateState = { data: null };

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

// An auto-approved post edited after approval. editedSinceApproval keeps it actionable
// (so it stays in the default "to review" tab); since the next-actor consolidation the
// auto-approve provenance renders no badge of its own: the re-approve chip is the one
// truthful state (the edit invalidated the approval, however it was given).
const autoApprovedPost = {
  ...mediaPost,
  id: 'p4',
  title: 'Auto approved promo',
  approval: 'approved',
  approvalBy: 'policy:auto-approve',
  editedSinceApproval: true,
  derivedState: 'waiting-due',
};

function renderFreigaben(posts, { onNavigate, locale = 'en', seed = [] } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // seed: [[queryKey, data]] pre-filled caches (e.g. another project's ['pendpost-health', id]).
  for (const [key, data] of seed) qc.setQueryData(key, data);
  const campaigns = [{ id: 'spring', active: true, posts }];
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ConfirmProvider>
            <Freigaben campaigns={campaigns} onOpen={() => {}} onNavigate={onNavigate} />
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
  platformValidateState = { data: null };
});

// Content-readiness gate (canon: prevent at the control, not after the click). The engine
// already refuses an over-limit post at approve; the queue must SAY so up-front and disable
// the button, rather than let the press fail into a red error dead-end.
describe('Freigaben approve is gated on content readiness', () => {
  const overCapMastodon = {
    id: 'p-mastodon-long',
    campaign: 'spring',
    title: 'pendpost 2.2 closes the loop on X.',
    caption: 'x'.repeat(20),
    platforms: ['mastodon'],
    approval: 'pending',
    derivedState: 'draft',
    scheduledAt: '2026-08-25T09:35:00Z',
    type: 'text',
    image: null,
    media: { file: null, exists: false, bytes: null, url: null, cover: null, path: null },
  };
  const blockedVerdict = {
    data: {
      ok: true,
      platforms: {
        mastodon: { ready: false, needsSetup: false, problems: ['note text is 501 chars - Mastodon caps at 500 (set a shorter mastodonCaption)'], warnings: [] },
      },
    },
  };

  it('disables Approve and shows the reason up-front when a lane exceeds its cap', () => {
    platformValidateState = blockedVerdict;
    renderFreigaben([overCapMastodon]);
    const approve = screen.getByRole('button', { name: /not ready/i });
    expect(approve).toBeDisabled();
    // The reason is rendered proactively (PlatformBlockers), not only after a click.
    expect(screen.getByText(/Mastodon caps at 500/i)).toBeInTheDocument();
  });

  it('leaves Approve enabled when the verdict is clean', () => {
    platformValidateState = { data: { ok: true, platforms: { mastodon: { ready: true, needsSetup: false, problems: [], warnings: [] } } } };
    renderFreigaben([overCapMastodon]);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('a warning-only verdict does NOT block (warnings are advisory)', () => {
    platformValidateState = { data: { ok: true, platforms: { mastodon: { ready: true, needsSetup: false, problems: [], warnings: ['some advisory'] } } } };
    renderFreigaben([overCapMastodon]);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });
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
    // B2: the offline slot IS the hand-off now - copy the text, open the thread.
    expect(screen.getByRole('button', { name: /copy reply & open/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
  });

  // One status signal per row (2026-11-01): the hand-off button IS the state, so no pill
  // repeats it beside the button and no "waiting for approval" chip contradicts it.
  it('the hand-off button is the one state on the card: no pill beside it', () => {
    healthState = { data: { setup: { platforms: [{ platform: 'reddit', status: 'incomplete' }] } } };
    renderFreigaben([radarReplyPost]);
    expect(screen.getByRole('button', { name: /copy reply & open/i })).toBeInTheDocument();
    expect(screen.queryByText(/you post this yourself/i)).not.toBeInTheDocument();
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

  it('renders the LinkCardPreview for a LinkedIn text post with a link', () => {
    renderFreigaben([textPost]);
    expect(screen.getByText(/LinkedIn card preview/i)).toBeInTheDocument();
  });

  // LinkedIn only builds an article card when the post carries a link (the engine's
  // `else if (post.link)` branch); every other text post publishes as plain text. The
  // card used to show an empty "LinkedIn card preview" on a Reddit or X post.
  it('renders NO LinkedIn card for a Reddit text post without a link', () => {
    renderFreigaben([redditAdvisoryPost]);
    expect(screen.queryByText(/LinkedIn card preview/i)).not.toBeInTheDocument();
  });

  it('renders NO LinkedIn card for an X text post, even one with a link', () => {
    renderFreigaben([{ ...textPost, id: 'p-x', platforms: ['x'] }]);
    expect(screen.queryByText(/LinkedIn card preview/i)).not.toBeInTheDocument();
  });

  it('renders NO LinkedIn card for a LinkedIn text post without a link', () => {
    renderFreigaben([{ ...textPost, id: 'p-li-plain', link: undefined }]);
    expect(screen.queryByText(/LinkedIn card preview/i)).not.toBeInTheDocument();
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

// B2: the copy-lane hand-off ON the card. "Manually post" is one flow: copy the
// effective text, open the destination, then capture the live link and mark it
// posted - the evidence contract closed without opening PostDetail.
describe('Freigaben copy-lane hand-off on the card', () => {
  const offlineX = { data: { setup: { platforms: [{ platform: 'x', status: 'incomplete' }] } } };
  const xReplyPost = {
    ...radarReplyPost,
    id: 'radar-x-abc',
    platforms: ['x'],
    radarReplyTo: { ...radarReplyPost.radarReplyTo, source: 'x', url: 'https://x.com/someone/status/123' },
  };
  let writeText;
  let openSpy;
  beforeEach(() => {
    writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  });
  afterEach(() => {
    openSpy.mockRestore();
  });
  // A blocked X post leads with its fix; the hand-off is one menu item away.
  const openHandOff = async (name = /copy reply & open/i) => {
    fireEvent.click(screen.getByRole('button', { name: /^(more actions|weitere aktionen)$/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name }));
  };

  it('a blocked X post leads with Connect X; the hand-off sits in the menu, Approve is gone', async () => {
    healthState = offlineX;
    renderFreigaben([xReplyPost], { onNavigate: vi.fn() });
    expect(screen.getByRole('button', { name: 'Connect X' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /copy reply & open/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^more actions$/i }));
    expect(await screen.findByRole('menuitem', { name: /copy reply & open/i })).toBeInTheDocument();
  });

  it('click copies the text, opens the thread, and reveals the link capture', async () => {
    healthState = offlineX;
    renderFreigaben([xReplyPost]);
    await openHandOff();
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(xReplyPost.caption));
    expect(openSpy).toHaveBeenCalledWith('https://x.com/someone/status/123', '_blank', 'noopener,noreferrer');
    // The capture row is revealed so the loop can close with evidence.
    expect(screen.getByLabelText(/Link to the published post/i)).toBeInTheDocument();
  });

  it('saving the URL calls markPosted and refreshes the plans', async () => {
    healthState = offlineX;
    renderFreigaben([xReplyPost]);
    await openHandOff();
    const input = await screen.findByLabelText(/Link to the published post/i);
    fireEvent.change(input, { target: { value: 'https://x.com/pendpost/status/456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Posted' }));
    await waitFor(() => expect(markPosted).toHaveBeenCalledWith('radar-replies', 'radar-x-abc', 'https://x.com/pendpost/status/456'));
  });

  // A failed save speaks one plain sentence; the server's English line rides the "?" only.
  const saveLink = async () => {
    await openHandOff();
    const input = await screen.findByLabelText(/Link to the published post/i);
    fireEvent.change(input, { target: { value: 'https://x.com/pendpost/status/456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Posted' }));
  };

  it('a message-less save failure still says the plain sentence', async () => {
    healthState = offlineX;
    markPosted.mockRejectedValueOnce(new Error());
    renderFreigaben([xReplyPost]);
    await saveLink();
    expect(await screen.findByText('Could not record this. Please try again.')).toBeInTheDocument();
  });

  it('a server error on save is not shown inline; its raw line is the "?" description', async () => {
    healthState = offlineX;
    markPosted.mockRejectedValueOnce(new Error('HTTP 500 internal'));
    renderFreigaben([xReplyPost]);
    await saveLink();
    const sentence = await screen.findByText('Could not record this. Please try again.');
    expect(sentence).toBeInTheDocument();
    expect(screen.queryByText(/HTTP 500/, { ignore: '.sr-only' })).toBeNull();
    const help = screen.getByRole('button', { name: /more about this|mehr dazu/i });
    expect(help).toHaveAccessibleDescription('HTTP 500 internal');
  });

  it('a clipboard refusal shows the error and NO false success', async () => {
    healthState = offlineX;
    writeText.mockImplementation(() => Promise.reject(new Error('denied')));
    renderFreigaben([xReplyPost]);
    await openHandOff();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    // No tab opened, no capture revealed, no "Copied" claim.
    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/Link to the published post/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();
  });

  // P5: the reply wording ("Copy reply & open thread") belongs to a Radar reply only.
  // A normal planned post on an offline lane (a Reddit paste-lane post, a manual X post)
  // has no thread: it reads PostDetail's generic hand-off label and opens the lane's
  // compose/submit page, never a "thread".
  const offlineReddit = { data: { setup: { platforms: [{ platform: 'reddit', status: 'incomplete' }] } } };
  const plainRedditPost = {
    ...textPost,
    id: 'plain-reddit-1',
    title: 'Plain reddit post',
    caption: 'A normal planned reddit post, not a reply to anyone.',
    platforms: ['reddit'],
    link: null,
    image: null,
    redditSubreddit: 'selfhosted',
  };

  it('a normal (non-Radar) post reads the generic hand-off label, not the reply wording', () => {
    healthState = offlineReddit;
    renderFreigaben([plainRedditPost]);
    expect(screen.getByRole('button', { name: /^copy and post yourself$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /copy reply/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/open thread/i)).not.toBeInTheDocument();
  });

  it('a normal post hand-off copies the text and opens the submit page, then reads Copied', async () => {
    healthState = offlineReddit;
    renderFreigaben([plainRedditPost]);
    fireEvent.click(screen.getByRole('button', { name: /^copy and post yourself$/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(plainRedditPost.caption));
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy.mock.calls[0][0]).toMatch(/^https:\/\/www\.reddit\.com\/r\/selfhosted\/submit\?/);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Link to the published post/i)).toBeInTheDocument();
  });

  it('a normal post reads the generic label in German too', async () => {
    healthState = offlineX;
    renderFreigaben([{ ...plainRedditPost, id: 'plain-x-1', platforms: ['x'] }], { locale: 'de-CH' });
    fireEvent.click(screen.getByRole('button', { name: /^weitere aktionen$/i }));
    expect(await screen.findByRole('menuitem', { name: /^Kopieren und selbst posten$/ })).toBeInTheDocument();
    expect(screen.queryByText(/Antwort kopieren/)).not.toBeInTheDocument();
  });

  it('a Radar reply still reads the reply wording in German', async () => {
    healthState = offlineX;
    renderFreigaben([xReplyPost], { locale: 'de-CH' });
    fireEvent.click(screen.getByRole('button', { name: /^weitere aktionen$/i }));
    expect(await screen.findByRole('menuitem', { name: /^Antwort kopieren & Thread öffnen$/ })).toBeInTheDocument();
  });
});

// Posted = linked (chip 3): the "Alle Beitraege" view's posted cards carry the same
// quiet open-live-post links Published's rows use - and NOTHING when no permalink is
// provable (never a dead control).
describe('Freigaben posted cards link the live post in all-mode', () => {
  const postedWithProof = {
    ...mediaPost,
    id: 'posted-1',
    approval: 'approved',
    derivedState: 'posted',
    permalinks: { instagram: 'https://www.instagram.com/p/live-proof/' },
  };
  const postedNoProof = {
    ...mediaPost,
    id: 'posted-2',
    title: 'Posted without evidence',
    approval: 'approved',
    derivedState: 'posted',
  };

  it('a posted card with a resolvable permalink renders the icon-only live link', async () => {
    renderFreigaben([postedWithProof]);
    const user = (await import('@testing-library/user-event')).default;
    await user.click(screen.getByRole('button', { name: 'All posts' }));
    const link = screen.getByRole('link', { name: /view on instagram/i });
    expect(link).toHaveAttribute('href', 'https://www.instagram.com/p/live-proof/');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('a posted card with NO evidence renders no link at all', async () => {
    renderFreigaben([postedNoProof]);
    const user = (await import('@testing-library/user-event')).default;
    await user.click(screen.getByRole('button', { name: 'All posts' }));
    expect(screen.getByText('Posted without evidence')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /view on/i })).not.toBeInTheDocument();
  });
});

// ONE truthful next-actor state per card (nextActorOf). The old badge stack could show
// "Scheduled" + "You post this yourself" + "Auto-approved" side by side - three
// independent derivations of who acts next, two of them false at any given moment.
describe('Freigaben next-actor consolidation', () => {
  it('a scheduled post on an unconnected lane renders exactly ONE state: the hand-off', async () => {
    healthState = { data: { setup: { platforms: [{ platform: 'reddit', status: 'incomplete' }] } } };
    const scheduledOffline = {
      ...radarReplyPost,
      id: 'sched-offline',
      approval: 'approved',
      approvalBy: 'policy:auto-approve',
      derivedState: 'waiting-due',
      scheduledAt: '2026-08-20T07:00:00Z',
    };
    renderFreigaben([scheduledOffline]);
    // Approved posts live in the "All posts" tab.
    const user = (await import('@testing-library/user-event')).default;
    await user.click(screen.getByRole('button', { name: 'All posts' }));
    // The hand-off truth renders (the row's one action, approved or not)...
    expect(screen.getByRole('button', { name: /copy reply & open/i })).toBeInTheDocument();
    // ...and neither of the contradicting claims does.
    expect(screen.queryByText(/goes out/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Auto-approved')).not.toBeInTheDocument();
  });

  it('auto-approved + edited reads re-approve, with NO auto-approved badge', () => {
    renderFreigaben([autoApprovedPost]);
    expect(screen.getByText('Re-approve')).toBeInTheDocument();
    expect(screen.queryByText('Auto-approved')).not.toBeInTheDocument();
  });

  it('a cleanly scheduled approved post says when it goes out, date and time on the chip, nothing hover-only', async () => {
    const scheduled = {
      ...mediaPost,
      id: 'sched-clean',
      approval: 'approved',
      approvalBy: 'policy:auto-approve',
      editedSinceApproval: false,
      derivedState: 'waiting-due',
      scheduledAt: '2026-08-20T07:00:00Z',
    };
    const { container } = renderFreigaben([scheduled]);
    const user = (await import('@testing-library/user-event')).default;
    await user.click(screen.getByRole('button', { name: 'All posts' }));
    // The label carries the date AND the time, so the full stamp needs no hover title.
    expect(screen.getByText(/goes out/i).textContent).toMatch(/\d{2}[./]\d{2}[./]26/);
    // Canon (phase 3 final tail): no hover-only reveal and never a third badge. The
    // auto-approve provenance lives in Activity (the approve row names the policy actor).
    const chip = screen.getByText(/goes out/i).closest('span.rounded-full');
    expect(chip).not.toBeNull();
    expect(chip.hasAttribute('title')).toBe(false);
    expect(container.textContent).not.toContain('Auto-approved');
  });
});

// P4: the queue chip is the SAME word as the planner card, List row and detail header
// (postStatusWord). A Telegram post whose lane is not connected is BLOCKED, with the same
// connect route as the detail's delivery row; "You post this yourself" is the manual paste
// lane's word (reddit) and would send the owner to the wrong fix here.
describe('Freigaben chip: blocked lane vs manual paste lane', () => {
  const tgPost = {
    id: 'tg-blocked',
    campaign: 'spring',
    title: 'Planner tour',
    caption: 'Next week: a short tour of the planner for new projects.',
    platforms: ['telegram'],
    approval: 'pending',
    derivedState: 'waiting-due',
    scheduledAt: '2026-08-20T07:00:00Z',
    type: 'text',
    image: null,
    media: { file: null, exists: false, bytes: null, url: null, cover: null, path: null },
  };
  const offline = { data: { setup: { platforms: [
    { platform: 'telegram', status: 'incomplete' },
    { platform: 'reddit', status: 'incomplete' },
  ] } } };

  // 2026-11-01 (owner: "a blocked pill, a reject button, and copy and post yourself: way too
  // high cognitive load"): a blocked row carries ONE status signal, the status line under the
  // title (the planner row's grammar: glyph, reason, the fix at its trailing edge), and no
  // "Blocked" pill beside the fix.
  it('a post on a lane that is not connected says so on its status line, offers the fix, and wears no Blocked pill', () => {
    healthState = offline;
    renderFreigaben([tgPost], { onNavigate: vi.fn() });
    expect(screen.queryByText(/^Blocked$/)).not.toBeInTheDocument();
    const line = screen.getByText('Telegram is not connected').closest('[data-row-status]');
    expect(line).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Connect Telegram' })).toBeInTheDocument();
    expect(screen.getAllByText(/is not connected/)).toHaveLength(1);
    expect(screen.queryByText(/you post this yourself/i)).not.toBeInTheDocument();
  });

  it('the status line sits outside the open-detail button; the fix sits in the row\'s one action slot', () => {
    healthState = offline;
    renderFreigaben([tgPost], { onNavigate: vi.fn() });
    const line = screen.getByText('Telegram is not connected').closest('[data-row-status]');
    expect(line.closest('button')).toBeNull();
    expect(within(line).queryByRole('button')).toBeNull();
    const fix = screen.getByRole('button', { name: 'Connect Telegram' });
    expect(fix.closest('[data-row-action]')).not.toBeNull();
    expect(fix.closest('[data-row-action].ml-auto')).not.toBeNull();
  });

  it('several blocked lanes read in the plural', () => {
    healthState = { data: { setup: { platforms: [
      { platform: 'telegram', status: 'incomplete' },
      { platform: 'discord', status: 'incomplete' },
    ] } } };
    renderFreigaben([{ ...tgPost, id: 'two', platforms: ['telegram', 'discord'] }], { onNavigate: vi.fn() });
    expect(screen.getByText('Telegram, Discord are not connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Telegram' })).toBeInTheDocument();
  });

  it('an OAuth lane fix opens Setup at that lane with the sign-in started', () => {
    healthState = { data: { setup: { platforms: [{ platform: 'x', status: 'incomplete' }] } } };
    const onNavigate = vi.fn();
    renderFreigaben([{ ...tgPost, id: 'x-blocked', platforms: ['x'] }], { onNavigate });
    fireEvent.click(screen.getByRole('button', { name: 'Connect X' }));
    expect(onNavigate).toHaveBeenCalledWith('setup', 'x', { action: 'reconnect' });
  });

  it('an All-projects row is judged by ITS project and names that project to the navigation', () => {
    // The active project has X; project B does not. B's post reads blocked by B's own setup.
    healthState = { data: { setup: { platforms: [{ platform: 'x', status: 'connected' }] } } };
    const onNavigate = vi.fn();
    renderFreigaben([{ ...tgPost, id: 'x-blocked-b', platforms: ['x'], clientId: 'client-b', clientName: 'Client B' }], {
      onNavigate,
      seed: [[['pendpost-health', 'client-b'], { setup: { platforms: [{ platform: 'x', status: 'incomplete' }] } }]],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect X' }));
    expect(onNavigate).toHaveBeenCalledWith('setup', 'x', { action: 'reconnect' }, 'client-b');
  });

  it('a blocked lane beside the paste lane leads with the blocked lane\'s fix only', () => {
    healthState = offline;
    renderFreigaben([{ ...tgPost, id: 'mixed', platforms: ['reddit', 'telegram'] }], { onNavigate: vi.fn() });
    expect(screen.queryByText(/^Blocked$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/you post this yourself/i)).not.toBeInTheDocument();
    expect(screen.getByText('Telegram is not connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Telegram' })).toBeInTheDocument();
  });

  it('the manual paste lane (reddit) leads with the hand-off, with no connect fix (the hand-off is the path)', () => {
    healthState = offline;
    renderFreigaben([radarReplyPost], { onNavigate: vi.fn() });
    expect(screen.getByRole('button', { name: /copy reply & open/i })).toBeInTheDocument();
    expect(screen.queryByText(/^Blocked$/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^connect/i })).not.toBeInTheDocument();
  });

  // Tier-3 (phase 3): a short card (a Telegram text post with no body) sat in a grid row beside
  // a taller one and was stretched to its height, which left an empty band above its actions.
  // Each card now keeps its own height.
  it('cards in the comfortable grid keep their own height (no stretched empty band)', () => {
    healthState = offline;
    renderFreigaben([tgPost], { onNavigate: vi.fn() });
    const list = screen.getByRole('list');
    expect(list.className.split(/\s+/)).toContain('items-start');
  });

  // D12 (phase 3): reject is reversible (rejectPost only sets a verdict; the post can be
  // approved again), so it is never the red danger tone. It now leads the row menu.
  it('Reject leads the row menu and reads neutral, not red', async () => {
    healthState = offline;
    renderFreigaben([tgPost], { onNavigate: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^more actions$/i }));
    const items = await screen.findAllByRole('menuitem');
    expect(items[0]).toHaveTextContent('Reject');
    expect(items[0].className).not.toMatch(/red-/);
  });

  it('a blocked row shows ONE action: the fix; Reject and the hand-off are in the menu', async () => {
    healthState = offline;
    renderFreigaben([tgPost], { onNavigate: vi.fn() });
    const row = screen.getByRole('listitem');
    const rowButtons = within(row).getAllByRole('button').map((b) => b.getAttribute('aria-label') || b.textContent.trim());
    expect(rowButtons).toContain('Connect Telegram');
    expect(rowButtons.some((n) => /^(reject|approve|copy and post yourself)$/i.test(n))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /^more actions$/i }));
    expect(await screen.findByRole('menuitem', { name: /copy and post yourself/i })).toBeInTheDocument();
  });
});

// A Blocked card's reason is the recovery's WHY. At 375px the card footer squeezed the reason
// beside "Connect ⋯" and clamped it to "Telegram ist nicht..." (seen 2026-11-01 in the
// p4-status-gaps flow, phone light and dark), the bug the planner List row fixed in 65f9021b.
// The reason now takes the card's full width on a phone and shares the line from sm up; jsdom
// has no layout, so the contract is the wrapper's classes.
describe('Freigaben Blocked card: the reason reads whole on a phone', () => {
  const tgPost = {
    ...textPost,
    id: 'tg-1',
    title: 'Planner tour',
    caption: 'Planner tour for the Telegram channel, next steps inside.',
    platforms: ['telegram'],
    link: null,
    image: null,
  };
  it('the reason line takes the full card width below sm and shares the line from sm up', () => {
    healthState = { data: { setup: { platforms: [{ platform: 'telegram', status: 'incomplete' }] } } };
    const { container } = renderFreigaben([tgPost], { onNavigate: vi.fn() });
    const status = container.querySelector('[data-row-status]');
    expect(status).not.toBeNull();
    expect(status.textContent).toBe('Telegram is not connected');
    const slot = status.parentElement;
    expect(slot.className).toMatch(/(^|\s)basis-full(\s|$)/);
    expect(slot.className).toMatch(/(^|\s)sm:basis-0(\s|$)/);
    expect(slot.className).toMatch(/(^|\s)sm:flex-1(\s|$)/);
    // The fix still closes the card, after the reason it fixes.
    const action = container.querySelector('[data-row-action]');
    expect(action).not.toBeNull();
    expect(within(action).getByRole('button', { name: /connect telegram/i })).toBeInTheDocument();
    expect(slot.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
