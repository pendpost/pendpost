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

function renderFreigaben(posts, { onNavigate, locale = 'en', seed = [], allProjects = false } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // seed: [[queryKey, data]] pre-filled caches (e.g. another project's ['pendpost-health', id]).
  for (const [key, data] of seed) qc.setQueryData(key, data);
  const campaigns = [{ id: 'spring', active: true, posts }];
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ConfirmProvider>
            <Freigaben campaigns={campaigns} onOpen={() => {}} onNavigate={onNavigate} allProjects={allProjects} />
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
    // The reason is rendered proactively as ONE compact line, not only after a click: the
    // short words on the row, the full sentence behind the "?".
    const short = document.querySelector('[data-blocker-short]');
    expect(short.textContent).toMatch(/Mastodon caps at 500/i);
    expect(short.textContent.length).toBeLessThanOrEqual(60);
    expect(document.querySelector('[data-blocker-line]').closest('li')).not.toBeNull();
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

  it('a blocked X post wears the quiet X glyph; the hand-off sits in the menu, Approve is gone', async () => {
    healthState = offlineX;
    renderFreigaben([xReplyPost], { onNavigate: vi.fn() });
    const row = screen.getByRole('listitem');
    expect(within(row).getByLabelText('X not connected')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Connect X' })).not.toBeInTheDocument();
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
    // The title is internal on an Instagram-only post (the title rule): the caption names it.
    expect(screen.getByText(/Spring promo headline line/)).toBeInTheDocument();
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

  // Freigaben error UX (2026-11-06, owner pick A): a lane that is not connected is fixed ONCE
  // per project, never per row. The row keeps a quiet grey struck-through glyph (its name on
  // hover); the red "<Lane> is not connected" line and the per-row Connect are gone.
  it('a post on a lane that is not connected wears only a quiet glyph: no red line, no per-row Connect, no Blocked pill', () => {
    healthState = offline;
    const { container } = renderFreigaben([tgPost], { onNavigate: vi.fn() });
    const row = screen.getByRole('listitem');
    expect(screen.queryByText(/^Blocked$/)).not.toBeInTheDocument();
    expect(within(row).getByLabelText('Telegram not connected').closest('[data-offline-chip]')).not.toBeNull();
    expect(container.querySelector('[data-row-status]')).toBeNull();
    expect(screen.queryByText(/is not connected/)).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Connect Telegram' })).not.toBeInTheDocument();
    expect(screen.queryByText(/you post this yourself/i)).not.toBeInTheDocument();
  });

  it('the quiet glyph sits outside the open-detail button, in the row\'s one action slot', () => {
    healthState = offline;
    renderFreigaben([tgPost], { onNavigate: vi.fn() });
    const chip = screen.getByLabelText('Telegram not connected');
    expect(chip.closest('button')).toBeNull();
    expect(chip.closest('[data-row-action]')).not.toBeNull();
  });

  it('several lanes that are not connected show one glyph each', () => {
    healthState = { data: { setup: { platforms: [
      { platform: 'telegram', status: 'incomplete' },
      { platform: 'discord', status: 'incomplete' },
    ] } } };
    renderFreigaben([{ ...tgPost, id: 'two', platforms: ['telegram', 'discord'] }], { onNavigate: vi.fn() });
    const row = screen.getByRole('listitem');
    expect(within(row).getByLabelText('Telegram not connected')).toBeInTheDocument();
    expect(within(row).getByLabelText('Discord not connected')).toBeInTheDocument();
  });

  it('All projects: ONE line per project at the top carries the count and the Connect, scoped to THAT project', () => {
    // The active project has X; project B does not. B's posts read blocked by B's own setup.
    healthState = { data: { setup: { platforms: [{ platform: 'x', status: 'connected' }] } } };
    const onNavigate = vi.fn();
    const { container } = renderFreigaben([
      { ...tgPost, id: 'x-b1', platforms: ['x'], clientId: 'client-b', clientName: 'Client B' },
      { ...tgPost, id: 'x-b2', platforms: ['x'], clientId: 'client-b', clientName: 'Client B', scheduledAt: '2026-08-21T07:00:00Z' },
    ], {
      onNavigate,
      allProjects: true,
      seed: [[['pendpost-health', 'client-b'], { setup: { platforms: [{ platform: 'x', status: 'incomplete' }] } }]],
    });
    const lines = container.querySelectorAll('[data-unconnected-projects] [data-project]');
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line.getAttribute('data-project')).toBe('client-b');
    expect(line.textContent).toMatch(/Client B/);
    expect(line.textContent).toMatch(/2/);
    expect(within(line).getByLabelText('Client B: 2 posts wait for X')).toBeInTheDocument();
    // The rows carry no Connect of their own: the line's is the only one.
    expect(screen.getAllByRole('button', { name: 'Connect X' })).toHaveLength(1);
    fireEvent.click(within(line).getByRole('button', { name: 'Connect X' }));
    expect(onNavigate).toHaveBeenCalledWith('setup', 'x', { action: 'reconnect' }, 'client-b');
  });

  it('All projects: each lane on the project line is a connect pill (lane glyph + plug), unlike the rows\' struck chip', () => {
    healthState = { data: { setup: { platforms: [] } } };
    const onNavigate = vi.fn();
    const { container } = renderFreigaben([
      { ...tgPost, id: 'till-li', platforms: ['linkedin'], clientId: 'till', clientName: 'TILL' },
      { ...tgPost, id: 'till-x', platforms: ['x'], clientId: 'till', clientName: 'TILL', scheduledAt: '2026-08-21T07:00:00Z' },
    ], {
      onNavigate,
      allProjects: true,
      seed: [[['pendpost-health', 'till'], { setup: { platforms: [{ platform: 'linkedin', status: 'incomplete' }, { platform: 'x', status: 'incomplete' }] } }]],
    });
    const line = container.querySelector('[data-unconnected-projects] [data-project="till"]');
    const li = within(line).getByRole('button', { name: 'Connect LinkedIn' });
    const x = within(line).getByRole('button', { name: 'Connect X' });
    // Each button carries its own lane's glyph, NOT struck (the struck glyph is the rows'
    // passive status chip), plus a small plug badge: it reads "connect LinkedIn". No glyph sits
    // outside a button.
    expect(li.querySelector('[data-platform="linkedin"]')).not.toBeNull();
    expect(li.querySelector('[data-platform="linkedin"][data-off]')).toBeNull();
    expect(x.querySelector('[data-platform="x"]:not([data-off])')).not.toBeNull();
    expect([...line.querySelectorAll('[data-platform]')].every((g) => g.closest('button'))).toBe(true);
    for (const b of [li, x]) {
      expect(b.querySelector('[data-plug-badge] svg').getAttribute('class')).toMatch(/lucide-plug-zap/);
      // A bordered pill with a brand hover: clearly a button, unlike the rows' chip.
      expect(b.className).toMatch(/(^|\s)border(\s|$)/);
      expect(b.className).toMatch(/(^|\s)rounded-lg(\s|$)/);
      expect(b.className).toMatch(/hover:bg-brand\//);
      expect(b.className).toMatch(/(^|\s)h-10(\s|$)/);
      expect(b.className).toMatch(/(^|\s)min-w-10(\s|$)/);
      expect(b.className).toMatch(/focus-visible:ring-2/);
      // Right after the count, not pushed to the far edge.
      expect(b.closest('.ml-auto')).toBeNull();
    }
    expect(line.querySelector('[aria-label="TILL: 2 posts wait for LinkedIn, X"]').className).not.toMatch(/(^|\s)flex-1(\s|$)/);
    // The rows keep the quiet struck chip.
    expect(container.querySelector('li [data-offline-chip] [data-platform="linkedin"][data-off]')).not.toBeNull();
    // The count stays.
    expect(within(line).getByText('2')).toBeInTheDocument();
    fireEvent.click(li);
    expect(onNavigate).toHaveBeenCalledWith('setup', 'linkedin', { action: 'reconnect' }, 'till');
  });

  it('one project mode shows no per-project line (the destination strip says it)', () => {
    healthState = offline;
    const { container } = renderFreigaben([tgPost], { onNavigate: vi.fn() });
    expect(container.querySelector('[data-unconnected-projects]')).toBeNull();
  });

  it('a lane that is not connected beside the paste lane shows only the blocked lane\'s glyph', () => {
    healthState = offline;
    renderFreigaben([{ ...tgPost, id: 'mixed', platforms: ['reddit', 'telegram'] }], { onNavigate: vi.fn() });
    expect(screen.queryByText(/^Blocked$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/you post this yourself/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Telegram not connected')).toBeInTheDocument();
    expect(screen.queryByLabelText('Reddit not connected')).not.toBeInTheDocument();
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

  it('a blocked row shows no Approve, Reject or Connect of its own; Reject and the hand-off are in the menu', async () => {
    healthState = offline;
    renderFreigaben([tgPost], { onNavigate: vi.fn() });
    const row = screen.getByRole('listitem');
    const rowButtons = within(row).getAllByRole('button').map((b) => b.getAttribute('aria-label') || b.textContent.trim());
    expect(rowButtons.some((n) => /^(reject|approve|copy and post yourself|connect telegram)$/i.test(n))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /^more actions$/i }));
    expect(await screen.findByRole('menuitem', { name: /copy and post yourself/i })).toBeInTheDocument();
  });
});

// A blocked card's line is the recovery's WHY. At 375px the card footer squeezed the reason
// beside the actions and clamped it (seen 2026-11-01 in the p4-status-gaps flow). The line now
// takes the card's full width on a phone and shares the line from sm up; jsdom has no layout,
// so the contract is the wrapper's classes. Since 2026-11-06 the slot holds the blocker line.
describe('Freigaben blocked card: the blocker line reads whole on a phone', () => {
  const tgPost = {
    ...textPost,
    id: 'tg-1',
    title: 'Planner tour',
    caption: 'Planner tour for the Telegram channel, next steps inside.',
    platforms: ['telegram'],
    link: null,
    image: null,
  };
  it('the blocker line takes the full card width below sm and shares the line from sm up', () => {
    platformValidateState = { data: { ok: true, platforms: { telegram: { ready: false, needsSetup: false, problems: ['message is 4200 chars'], problemCodes: [{ code: 'validate.telegramMessageTooLong', params: {}, fix: 'edit' }], warnings: [] } } } };
    const { container } = renderFreigaben([tgPost], { onNavigate: vi.fn() });
    const line = container.querySelector('[data-blocker-line]');
    expect(line).not.toBeNull();
    expect(container.querySelector('[data-blocker-short]').textContent).toBe('Text too long for Telegram');
    const slot = line.parentElement;
    // The slot never lets the line shrink below its cause: the row wraps the action instead.
    expect(slot.className).not.toMatch(/(^|\s)min-w-0(\s|$)/);
    expect(slot.parentElement.className).toMatch(/(^|\s)flex-wrap(\s|$)/);
    expect(slot.className).toMatch(/(^|\s)basis-full(\s|$)/);
    expect(slot.className).toMatch(/(^|\s)sm:basis-0(\s|$)/);
    expect(slot.className).toMatch(/(^|\s)sm:flex-1(\s|$)/);
    const action = container.querySelector('[data-row-action]');
    expect(action).not.toBeNull();
    expect(slot.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
