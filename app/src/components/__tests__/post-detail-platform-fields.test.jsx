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
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme', accent: '#22566d' }, activeClientId: 'acme' }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
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
    expect(labels).not.toContain('Caption');
    // The core bug: no "No caption" placeholder anywhere for a YouTube post.
    expect(screen.queryByText('No caption')).toBeNull();
    // Title is the first editable field (primary text leads).
    expect(screen.getAllByRole('textbox')[0].getAttribute('aria-label')).toBe('Title');
  });

  it('YouTube longform: same YouTube field set', () => {
    renderDetail(makePost({ type: 'youtube-longform', platforms: ['youtube'], title: 'T', description: 'D' }));
    expect(contentLabels()).toContain('Description');
    expect(contentLabels()).not.toContain('Caption');
  });

  it('Meta reel: Caption leads + first comment, no Title/Description', () => {
    renderDetail(makePost({ type: 'reel', platforms: ['instagram', 'facebook'], caption: 'hi', firstComment: 'fc' }));
    const labels = contentLabels();
    expect(labels[0]).toBe('Caption');
    expect(labels).toContain('First comment');
    expect(labels).not.toContain('Title');
    expect(labels).not.toContain('Description');
  });

  it('X: Caption + the X override (xCaption) with a fallback/override hint', () => {
    renderDetail(makePost({ type: 'video', platforms: ['x'], caption: 'base', xCaption: 'tweet' }));
    const labels = contentLabels();
    expect(labels).toContain('Caption');
    expect(labels).toContain('X post');
    // The override note is shown (set -> "Overrides the caption").
    expect(screen.getByText('Overrides the caption')).toBeInTheDocument();
  });

  it('X override empty: hint reads "Uses the caption when empty"', () => {
    renderDetail(makePost({ type: 'video', platforms: ['x'], caption: 'base', xCaption: '' }));
    expect(screen.getByText('Uses the caption when empty')).toBeInTheDocument();
  });

  it('Mastodon + Nostr: each shows its own note override', () => {
    renderDetail(makePost({ type: 'video', platforms: ['mastodon', 'nostr'], caption: 'c', mastodonCaption: 'm', nostrCaption: 'n' }));
    const labels = contentLabels();
    expect(labels).toContain('Mastodon post');
    expect(labels).toContain('Nostr note');
  });

  it('WordPress article: Title + Body + Excerpt + Tags, NO caption', () => {
    renderDetail(makePost({ type: 'text', platforms: ['wordpress'], title: 'T', body: 'B', excerpt: 'E', tags: 't', caption: 'stray' }));
    const labels = contentLabels();
    expect(labels).toContain('Title');
    expect(labels).toContain('Body');
    expect(labels).toContain('Excerpt');
    expect(labels).toContain('Tags');
    expect(labels).not.toContain('Caption');
  });

  it('Ghost article: adds the canonical URL + newsletter flag in Details', () => {
    renderDetail(makePost({ type: 'text', platforms: ['ghost'], title: 'T', body: 'B', canonicalUrl: 'https://x.com/orig', ghostEmail: true, image: 'https://img' }));
    expect(within(screen.getByRole('dialog')).getByText('Details')).toBeInTheDocument();
    expect(screen.getByText('Canonical URL')).toBeInTheDocument();
    expect(screen.getByText('Send as newsletter')).toBeInTheDocument();
  });

  it('LinkedIn text: Title + Link description + link/image extras', () => {
    renderDetail(makePost({ type: 'text', platforms: ['linkedin'], caption: 'c', title: 'T', liDescription: 'ld', link: 'https://a', image: 'https://i' }));
    const labels = contentLabels();
    expect(labels).toContain('Caption');
    expect(labels).toContain('Title');
    expect(labels).toContain('Link description');
    expect(screen.getByText('Link')).toBeInTheDocument(); // extra row
  });

  it.each([
    ['telegram'], ['discord'], ['tiktok'], ['reddit'], ['pinterest'],
  ])('%s: shows just the caption, no platform-specific fields', (platform) => {
    renderDetail(makePost({ type: 'video', platforms: [platform], caption: 'c' }));
    const labels = contentLabels();
    expect(labels).toEqual(['Caption']);
  });

  it('GBP: caption + a Details row summarising the local-post intent', () => {
    renderDetail(makePost({ type: 'image', platforms: ['gbp'], caption: 'c', gbp: { topic: 'offer', ctaType: 'BOOK' } }));
    expect(contentLabels()).toContain('Caption');
    expect(screen.getByText('Google Business post')).toBeInTheDocument();
  });

  it('IG story: interactive stickers summarised in Details, no first comment', () => {
    renderDetail(makePost({ type: 'story', platforms: ['instagram'], caption: 'c', interactiveStory: { stickers: [{ kind: 'poll' }, { kind: 'mention' }] } }));
    expect(contentLabels()).not.toContain('First comment');
    expect(screen.getByText('Story stickers')).toBeInTheDocument();
    expect(screen.getByText('2 stickers')).toBeInTheDocument();
  });

  it('Multi-platform X + YouTube: union of both field sets', () => {
    renderDetail(makePost({ type: 'youtube-short', platforms: ['x', 'youtube'], caption: 'c', xCaption: 'x', title: 'T', description: 'D' }));
    const labels = contentLabels();
    expect(labels).toContain('Caption');
    expect(labels).toContain('X post');
    expect(labels).toContain('Title');
    expect(labels).toContain('Description');
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
