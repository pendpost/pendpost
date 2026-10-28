import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Composer from '../Composer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// The Mastodon counter counts the way Mastodon does (lib/mastodon-text.js): a long blog link
// is 23 characters, not its real length. A status that fits must never read "over the limit"
// (the owner's blog posts that read 502/500 while Mastodon accepts them).
vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({ data: { dir: '/tmp/assets', assets: [] } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePinterestBoardSections: () => ({ data: undefined, isLoading: false }),
  createPost: vi.fn(() => Promise.resolve({ ok: true })),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
}));

const LONG_URL = `https://pendpost.com/blog/${'a'.repeat(120)}`;

function renderEdit(mastodonCaption, extra = {}) {
  const post = {
    id: 'p1', campaign: 'launch', type: 'text', platforms: ['mastodon', 'x'], approval: 'draft',
    derivedState: 'scheduled', scheduledAt: '2026-07-01T10:00:00Z', caption: 'short', rev: 1,
    media: { file: null, exists: false, url: null, cover: null, path: null },
    mastodonCaption, ...extra,
  };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Composer mode="edit" post={post} campaigns={[{ id: 'launch', active: true, posts: [post] }]} onClose={vi.fn()} onSaved={vi.fn()} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

describe('Composer Mastodon counter counts links as 23', () => {
  it('a long link inside a fitting status reads under the cap', () => {
    renderEdit(`${'w'.repeat(470)} ${LONG_URL}`);
    const counter = document.getElementById('composer-mastodon-counter');
    expect(counter).toHaveTextContent('494/500 characters');
    expect(counter).not.toHaveClass('text-red-600');
  });

  it('the content warning adds to the same cap', () => {
    renderEdit(`${'w'.repeat(470)} ${LONG_URL}`, { spoilerText: 'Spoiler warning' });
    expect(document.getElementById('composer-mastodon-counter')).toHaveTextContent(/509\/500/);
  });
});
