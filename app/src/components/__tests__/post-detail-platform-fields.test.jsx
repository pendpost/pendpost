import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { vi } from 'vitest';

// Platform-aware content rendering: the detail dialog must show ONLY the fields a
// targeted platform actually posts (the shared field-relevance model), so a
// YouTube-only post never shows an empty "Caption", an X post surfaces its tweet
// override, a blog post its title/body/excerpt, etc. This is the CI backstop for
// every platform - including the wave-2 lanes the live demo data lacks.

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme', accent: '#22566d' }, activeClientId: 'acme' }),
  usePendpostHealth: () => ({ data: { setup: { platforms: [] } } }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  approvePost: vi.fn(), rejectPost: vi.fn(), deletePost: vi.fn(), unschedulePost: vi.fn(),
  reschedulePost: vi.fn(), markPosted: vi.fn(), verifyPost: vi.fn(), runPublishDue: vi.fn(),
  setCoverFrame: vi.fn(), uploadCover: vi.fn(), clearCover: vi.fn(), updatePost: vi.fn(),
}));

const BASE = {
  id: 'p1', campaign: 'spring', rev: 1, approval: 'pending', derivedState: 'scheduled',
  scheduledAt: '2026-07-01T10:00:00Z', executionMode: 'fully-scheduled',
  ids: {}, cover: null, publishedVia: null, externalUrl: null, verify: null,
  media: { file: null, exists: false, url: null },
};

function makePost(over) {
  return { ...BASE, ...over };
}

function renderDetail(post, locale = 'en') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ConfirmProvider>
            <PostDetail post={post} onClose={() => {}} onEdit={() => {}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

// The content region is the dialog minus the Platforms status list, so a field
// label assertion is not confused by a platform's own name in the status rows.
function contentLabels() {
  return screen.queryAllByRole('textbox').map((el) => el.getAttribute('aria-label')).filter(Boolean);
}

describe('PostDetail — platform-relevant fields', () => {
  it('YouTube short: Title + Description + Tags lead, NO caption', () => {
    renderDetail(makePost({ type: 'youtube-short', platforms: ['youtube'], title: 'T', description: 'D', tags: 'a,b', caption: 'stray' }));
    const labels = contentLabels();
    expect(labels).toContain('Title');
    expect(labels).toContain('Description');
    expect(labels).toContain('Tags');
    expect(labels).toContain('First comment'); // YouTube pins a first comment
    expect(labels).not.toContain('Post text');
    // The core bug: no "No post text" placeholder anywhere for a YouTube post.
    expect(screen.queryByText('No post text')).toBeNull();
    // Title is the first editable field (primary text leads).
    expect(screen.getAllByRole('textbox')[0].getAttribute('aria-label')).toBe('Title');
  });

  it('YouTube longform: same YouTube field set', () => {
    renderDetail(makePost({ type: 'youtube-longform', platforms: ['youtube'], title: 'T', description: 'D' }));
    expect(contentLabels()).toContain('Description');
    expect(contentLabels()).not.toContain('Post text');
  });

  it('Meta reel: Post text leads + first comment, no Title/Description', () => {
    renderDetail(makePost({ type: 'reel', platforms: ['instagram', 'facebook'], caption: 'hi', firstComment: 'fc' }));
    const labels = contentLabels();
    expect(labels[0]).toBe('Post text');
    expect(labels).toContain('First comment');
    expect(labels).not.toContain('Title');
    expect(labels).not.toContain('Description');
  });

  it('X with a LEGACY override set: base text + the X override with its hint', () => {
    renderDetail(makePost({ type: 'video', platforms: ['x'], caption: 'base', xCaption: 'tweet' }));
    const labels = contentLabels();
    expect(labels).toContain('Post text');
    expect(labels).toContain('X post');
    // The override note is shown (set -> "Overrides the post text").
    expect(screen.getByText('Overrides the post text')).toBeInTheDocument();
  });

  it('X-only with an EMPTY override: ONE text field, the override is collapsed', () => {
    renderDetail(makePost({ type: 'video', platforms: ['x'], caption: 'base', xCaption: '' }));
    const labels = contentLabels();
    expect(labels).toContain('Post text');
    expect(labels).not.toContain('X post');
    expect(screen.queryByText('Uses the post text when empty')).toBeNull();
  });

  it('Mastodon + Nostr (multi-platform): each shows its own note override', () => {
    renderDetail(makePost({ type: 'video', platforms: ['mastodon', 'nostr'], caption: 'c', mastodonCaption: 'm', nostrCaption: 'n' }));
    const labels = contentLabels();
    expect(labels).toContain('Mastodon post');
    expect(labels).toContain('Nostr note');
  });

  it('Mastodon-only with an empty override: the override is collapsed', () => {
    renderDetail(makePost({ type: 'video', platforms: ['mastodon'], caption: 'c', mastodonCaption: '' }));
    const labels = contentLabels();
    expect(labels).toContain('Post text');
    expect(labels).not.toContain('Mastodon post');
  });

  it('WordPress article: Title + Body + Excerpt + Tags + Alt text, NO caption', () => {
    renderDetail(makePost({ type: 'text', platforms: ['wordpress'], title: 'T', body: 'B', excerpt: 'E', tags: 't', caption: 'stray', altText: 'a hero shot' }));
    const labels = contentLabels();
    expect(labels).toContain('Title');
    expect(labels).toContain('Body');
    expect(labels).toContain('Excerpt');
    expect(labels).toContain('Tags');
    expect(labels).toContain('Alt text');
    expect(labels).not.toContain('Post text');
  });

  // Spec 13: rich long-form metadata - SEO title/description + feature-image alt
  // apply to either blog lane, categories are WordPress-only (Ghost has none).
  it('spec 13: WordPress article shows SEO title/description + categories + feature-image alt', () => {
    renderDetail(makePost({
      type: 'text', platforms: ['wordpress'], title: 'T', body: 'B',
      metaTitle: 'SEO title', metaDescription: 'SEO desc', wpCategories: 'News', featureImageAlt: 'hero alt',
    }));
    const labels = contentLabels();
    expect(labels).toContain('SEO title');
    expect(labels).toContain('SEO description');
    expect(labels).toContain('Categories');
    expect(labels).toContain('Feature image alt text');
  });

  it('spec 13: Ghost article shows SEO title/description + feature-image alt, NO categories', () => {
    renderDetail(makePost({
      type: 'text', platforms: ['ghost'], title: 'T', body: 'B',
      metaTitle: 'SEO title', metaDescription: 'SEO desc', featureImageAlt: 'hero alt',
    }));
    const labels = contentLabels();
    expect(labels).toContain('SEO title');
    expect(labels).toContain('SEO description');
    expect(labels).toContain('Feature image alt text');
    expect(labels).not.toContain('Categories');
  });

  it('X: Alt text rides alongside the tweet text (spec 21 live lane)', () => {
    renderDetail(makePost({ type: 'video', platforms: ['x'], caption: 'base', altText: 'a red bicycle' }));
    const labels = contentLabels();
    expect(labels).toContain('Post text');
    expect(labels).toContain('Alt text');
  });

  it('a linkedin-only post never shows Alt text (not a spec-21 lane)', () => {
    renderDetail(makePost({ type: 'text', platforms: ['linkedin'], caption: 'c', title: 'T', liDescription: 'ld', link: 'https://a', image: 'https://i' }));
    expect(contentLabels()).not.toContain('Alt text');
  });

  it('Ghost article: adds the canonical URL + newsletter flag in Details', () => {
    renderDetail(makePost({ type: 'text', platforms: ['ghost'], title: 'T', body: 'B', canonicalUrl: 'https://x.com/orig', ghostEmail: true, image: 'https://img' }));
    expect(within(screen.getByRole('dialog')).getByText('Details')).toBeInTheDocument();
    expect(screen.getByText('Canonical URL')).toBeInTheDocument();
    expect(screen.getByText('Send as newsletter')).toBeInTheDocument();
  });

  // Spec 01: the three newsletter refinements ride ghostEmail and appear as their
  // own Details rows only when the post actually carries them.
  it('Ghost article: newsletter/segment/email-only refinements show in Details', () => {
    renderDetail(makePost({
      type: 'text', platforms: ['ghost'], title: 'T', body: 'B', ghostEmail: true,
      newsletter: 'weekly', emailSegment: 'paid', emailOnly: true,
    }));
    expect(screen.getByText('Newsletter')).toBeInTheDocument();
    expect(screen.getByText('weekly')).toBeInTheDocument();
    expect(screen.getByText('Audience segment')).toBeInTheDocument();
    expect(screen.getByText('Paid members')).toBeInTheDocument();
    expect(screen.getByText('Email-only')).toBeInTheDocument();
  });

  it('Ghost article: no newsletter/segment rows when unset (identical to today)', () => {
    renderDetail(makePost({ type: 'text', platforms: ['ghost'], title: 'T', body: 'B', ghostEmail: true }));
    expect(screen.queryByText('Newsletter')).not.toBeInTheDocument();
    expect(screen.queryByText('Audience segment')).not.toBeInTheDocument();
    expect(screen.queryByText('Email-only')).not.toBeInTheDocument();
  });

  // Spec 27: draft/pending-review publish status - a read-only Details row
  // (like ghostEmail), shown ONLY when the post actually carries it.
  it('WordPress article: shows "Publish as draft" in Details when publishAsDraft is set', () => {
    renderDetail(makePost({ type: 'text', platforms: ['wordpress'], title: 'T', body: 'B', publishAsDraft: true }));
    expect(within(screen.getByRole('dialog')).getByText('Details')).toBeInTheDocument();
    expect(screen.getByText('Publish as draft')).toBeInTheDocument();
  });

  it('WordPress article: no "Publish as draft" row when unset (identical to today)', () => {
    renderDetail(makePost({ type: 'text', platforms: ['wordpress'], title: 'T', body: 'B' }));
    expect(screen.queryByText('Publish as draft')).not.toBeInTheDocument();
  });

  it('LinkedIn text: Title + Link description + link/image extras', () => {
    renderDetail(makePost({ type: 'text', platforms: ['linkedin'], caption: 'c', title: 'T', liDescription: 'ld', link: 'https://a', image: 'https://i' }));
    const labels = contentLabels();
    expect(labels).toContain('Post text');
    expect(labels).toContain('Title');
    expect(labels).toContain('Link description');
    expect(screen.getByText('Link')).toBeInTheDocument(); // extra row
  });

  it.each([
    ['telegram'], ['tiktok'], ['reddit'],
  ])('%s: shows just the post text, no platform-specific fields', (platform) => {
    renderDetail(makePost({ type: 'video', platforms: [platform], caption: 'c' }));
    const labels = contentLabels();
    expect(labels).toEqual(['Post text']);
  });

  // B1 (ux-audit dim-6 P1): the per-lane prose overrides the engines publish
  // (tgCaption/dcCaption/ttCaption/redditText/pinTitle/pinDescription) must be
  // VISIBLE here once set - an MCP agent writes them server-side, and the
  // approver has to see exactly what each lane will publish.
  it.each([
    ['telegram', 'tgCaption', 'Telegram message'],
    ['tiktok', 'ttCaption', 'TikTok caption'],
    ['reddit', 'redditText', 'Reddit text'],
  ])('B1 %s: a saved %s override renders with the override hint', (platform, field, label) => {
    renderDetail(makePost({ type: 'video', platforms: [platform], caption: 'base', [field]: 'agent-written text' }));
    const labels = contentLabels();
    expect(labels).toContain('Post text');
    expect(labels).toContain(label);
    expect(screen.getByText('Overrides the post text')).toBeInTheDocument();
  });

  it('B1 multi-lane chat post: each lane shows its own override field', () => {
    renderDetail(makePost({ type: 'text', platforms: ['telegram', 'discord'], caption: 'c' }));
    const labels = contentLabels();
    expect(labels).toEqual(['Post text', 'Telegram message', 'Discord message', 'Forum thread name', 'Existing thread id']);
  });

  // Spec 26: discord ALSO shows the two forum/thread-targeting fields
  // (dcThreadName/dcThreadId) - plain EDITABLE fields whenever discord targets
  // the post, distinct from the caption-only siblings above.
  it('discord: shows the post text + the forum thread-targeting fields', () => {
    renderDetail(makePost({ type: 'video', platforms: ['discord'], caption: 'c' }));
    const labels = contentLabels();
    expect(labels).toEqual(['Post text', 'Forum thread name', 'Existing thread id']);
  });

  // Pinterest rides the shared caption, PLUS the spec-21 alt-text field and the
  // B1 pin-title override (pinTitle shadows post.title, which has no pinterest
  // surface of its own; the empty pinDescription collapses like xCaption).
  it('pinterest: shows the post text + pin title + alt text', () => {
    renderDetail(makePost({ type: 'video', platforms: ['pinterest'], caption: 'c' }));
    const labels = contentLabels();
    expect(labels).toEqual(['Post text', 'Pin title', 'Alt text']);
  });

  it('B1 pinterest: a saved pinDescription renders alongside the pin title', () => {
    renderDetail(makePost({ type: 'video', platforms: ['pinterest'], caption: 'c', pinTitle: 'Board headline', pinDescription: 'agent pin copy' }));
    const labels = contentLabels();
    expect(labels).toEqual(['Post text', 'Pin title', 'Pin description', 'Alt text']);
  });

  // Spec 17: the board-section target, shown as a Details row ONLY when set - a
  // no-section pinterest post shows no row (byte-identical to before this spec).
  it('pinterest: shows a Details row for pinBoardSection only when set', () => {
    renderDetail(makePost({ type: 'video', platforms: ['pinterest'], caption: 'c', pinBoardSection: 'sec123' }));
    expect(screen.getByText('Board section')).toBeInTheDocument();
    expect(screen.getByText('sec123')).toBeInTheDocument();
  });

  it('pinterest: no Details row for pinBoardSection when unset', () => {
    renderDetail(makePost({ type: 'video', platforms: ['pinterest'], caption: 'c' }));
    expect(screen.queryByText('Board section')).not.toBeInTheDocument();
  });

  it('GBP: post text + a Details row summarising the local-post intent', () => {
    renderDetail(makePost({ type: 'image', platforms: ['gbp'], caption: 'c', gbp: { topic: 'offer', ctaType: 'BOOK' } }));
    expect(contentLabels()).toContain('Post text');
    expect(screen.getByText('Google Business post')).toBeInTheDocument();
  });

  it('IG story: interactive stickers summarised in Details, no first comment', () => {
    renderDetail(makePost({ type: 'story', platforms: ['instagram'], caption: 'c', interactiveStory: { stickers: [{ kind: 'poll' }, { kind: 'mention' }] } }));
    expect(contentLabels()).not.toContain('First comment');
    expect(screen.getByText('Story stickers')).toBeInTheDocument();
    expect(screen.getByText('2 stickers')).toBeInTheDocument();
  });

  // Sticker honesty (platform-constraints): once the story is POSTED the count
  // summary becomes the add-by-hand checklist - the engine publishes no sticker
  // parameters, so the live story has none of these until the operator adds them.
  it('a POSTED IG story lists each sticker as an add-by-hand checklist', () => {
    renderDetail(makePost({
      type: 'story', platforms: ['instagram'], caption: 'c', derivedState: 'posted', ids: { igMediaId: 'ig1' },
      interactiveStory: { stickers: [{ kind: 'poll', question: 'Which?', options: ['A', 'B'] }, { kind: 'mention', handle: 'someone' }] },
    }));
    expect(screen.getByText('Story stickers')).toBeInTheDocument();
    expect(screen.queryByText('2 stickers')).not.toBeInTheDocument();
    expect(screen.getByText('Poll: Which? - A / B')).toBeInTheDocument();
    expect(screen.getByText('Mention: @someone')).toBeInTheDocument();
    expect(screen.getByText(/Add these by hand in the Instagram app/)).toBeInTheDocument();
  });

  it('Multi-platform X + YouTube: union of both field sets', () => {
    renderDetail(makePost({ type: 'youtube-short', platforms: ['x', 'youtube'], caption: 'c', xCaption: 'x', title: 'T', description: 'D' }));
    const labels = contentLabels();
    expect(labels).toContain('Post text');
    expect(labels).toContain('X post');
    expect(labels).toContain('Title');
    expect(labels).toContain('Description');
  });

  // US-CMT-10: comments are a visible control on a posted, comment-capable post -
  // never only an overflow entry beside Delete.
  it('a POSTED comment-capable post shows the visible Comments control (not in the overflow)', async () => {
    renderDetail(makePost({ type: 'reel', platforms: ['instagram'], caption: 'c', derivedState: 'posted', ids: { igMediaId: 'ig1' } }));
    expect(screen.getByRole('button', { name: /Comments/ })).toBeInTheDocument();
    const overflow = screen.getByRole('button', { name: 'More actions' });
    const user = (await import('@testing-library/user-event')).default.setup();
    await user.click(overflow);
    expect(screen.queryByRole('menuitem', { name: /Comments/ })).not.toBeInTheDocument();
  });

  it('a posted YouTube post renders its fields read-only (no textboxes)', () => {
    renderDetail(makePost({ type: 'youtube-longform', platforms: ['youtube'], derivedState: 'posted', title: 'T', description: 'D', ids: { ytVideoId: 'v' } }));
    // Read-only: the title/description show as text, not editable controls.
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.getByText('T')).toBeInTheDocument();
  });

  it('has no axe violations for a multi-platform post (en + de-CH)', async () => {
    const post = makePost({ type: 'youtube-short', platforms: ['x', 'youtube'], caption: 'c', xCaption: 'x', title: 'T', description: 'D', tags: 'a' });
    const { container, unmount } = renderDetail(post, 'en');
    expect(await axeClean(container)).toHaveNoViolations();
    unmount();
    const de = renderDetail(post, 'de-CH');
    expect(await axeClean(de.container)).toHaveNoViolations();
  });
});
