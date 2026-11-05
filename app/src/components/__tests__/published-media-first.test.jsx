import { render, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Published from '../Published.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// The media-first Published row (the Freigaben row's rule, 2026-11-05): the media leads at its
// real aspect (a quiet lane tile for a text post), the meta line sits on top, a bold title shows
// ONLY when a lane publishes one, and the caption is one paragraph that keeps its first line.
vi.mock('../../lib/api.js', () => ({
  useAccounts: () => ({ data: { publicUrls: {} } }),
  verifyPost: vi.fn(() => Promise.resolve({ ok: true })),
}));

const postedAt = new Date(Date.now() - 86400000).toISOString();
const media = { exists: true, url: '/media?p=reel.mp4', cover: '/media?p=reel.jpg', path: 'reel.mp4', resolution: 'story-9x16', items: [] };
const reel = {
  campaign: 'c', id: 'reel-1', derivedState: 'posted', type: 'reel', platforms: ['instagram'], postedAt,
  title: 'Internal working title', caption: 'Ten minutes outside in the morning\nand you fall asleep earlier.', image: null, media,
};
const short = {
  ...reel, id: 'short-1', type: 'youtube-short', platforms: ['youtube'],
  title: 'Ten minutes of morning light', caption: 'Ten minutes of morning light\nA study with 140 office workers.',
};
const textPost = {
  campaign: 'c', id: 'text-1', derivedState: 'posted', type: 'text', platforms: ['linkedin'], postedAt,
  caption: 'A plain LinkedIn note for the week.', image: null,
  media: { exists: false, url: null, cover: null, path: null, items: [] },
};

function renderRow(post) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <Published campaigns={[{ id: 'c', active: true, posts: [post] }]} onOpen={() => {}} />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const tokens = (el) => (el.getAttribute('class') || '').split(/\s+/);

describe('Published media-first row', () => {
  it('leads with the media, before the meta line and the words, inside the open-detail button', () => {
    const { container } = renderRow(reel);
    const mediaEl = container.querySelector('[data-row-media]');
    const meta = container.querySelector('[data-row-meta]');
    const caption = container.querySelector('[data-row-caption]');
    expect(mediaEl).not.toBeNull();
    expect(mediaEl.closest('button')).not.toBeNull();
    expect(mediaEl.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(meta.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The real picture at its real aspect.
    const img = mediaEl.querySelector('img');
    expect(img).not.toBeNull();
    expect(img.className).toContain('aspect-');
  });

  it('an Instagram Reel shows no title line and its caption keeps its first line', () => {
    const { container } = renderRow(reel);
    expect(container.querySelector('[data-row-title]')).toBeNull();
    expect(container.querySelector('[data-row-caption]')).toHaveTextContent('Ten minutes outside in the morning and you fall asleep earlier.');
  });

  it('a YouTube post shows its title bold above a quieter two-line caption', () => {
    const { container } = renderRow(short);
    const titleEl = container.querySelector('[data-row-title]');
    expect(titleEl).toHaveTextContent('Ten minutes of morning light');
    expect(tokens(titleEl)).toContain('font-bold');
    const caption = container.querySelector('[data-row-caption]');
    expect(caption).toHaveTextContent('A study with 140 office workers.');
    expect(tokens(caption)).toContain('line-clamp-2');
    expect(tokens(caption)).toContain('text-zinc-600');
  });

  // A YouTube video publishes post.description, never the caption (yt-social.mjs buildMeta).
  it('a YouTube post with an empty caption shows its description under the title, two lines', () => {
    const { container } = renderRow({ ...short, caption: '', description: 'A study with 140 office workers.\nSources below.' });
    expect(container.querySelector('[data-row-title]')).toHaveTextContent('Ten minutes of morning light');
    const caption = container.querySelector('[data-row-caption]');
    expect(caption).toHaveTextContent(/^A study with 140 office workers\. Sources below\.$/);
    expect(tokens(caption)).toContain('line-clamp-2');
    expect(tokens(caption)).not.toContain('block');
  });

  it('says "Short" beside the YouTube glyph, not "YouTube Short"', () => {
    const { container } = renderRow(short);
    const meta = container.querySelector('[data-row-meta]');
    expect(within(meta).getByText('Short')).toBeInTheDocument();
    expect(meta).not.toHaveTextContent('YouTube Short');
  });

  it('a text-only post shows its lane tile in the media column', () => {
    const { container } = renderRow(textPost);
    const tile = container.querySelector('[data-row-media] [data-lane-tile]');
    expect(tile).not.toBeNull();
    expect(tile.getAttribute('data-lane-tile')).toBe('linkedin');
    expect(container.querySelector('[data-row-media] img')).toBeNull();
  });

  it('the caption clamps to three lines without a title and never carries a standalone block', () => {
    const { container } = renderRow(reel);
    const caption = container.querySelector('[data-row-caption]');
    expect(tokens(caption)).toContain('line-clamp-3');
    expect(tokens(caption)).not.toContain('block');
  });

  // One continuous row (owner, 2026-11-05): the caption fills the row up to the action cluster.
  it('the caption carries no reading-measure cap', () => {
    const { container } = renderRow(reel);
    expect(tokens(container.querySelector('[data-row-caption]')).some((c) => c.startsWith('max-w-'))).toBe(false);
  });

  it('a post with no title and no caption falls back to its name, muted', () => {
    const { container } = renderRow({ ...textPost, caption: '' });
    const caption = container.querySelector('[data-row-caption]');
    expect(caption).toHaveTextContent('text-1');
    expect(tokens(caption)).toContain('text-zinc-600');
  });
});
