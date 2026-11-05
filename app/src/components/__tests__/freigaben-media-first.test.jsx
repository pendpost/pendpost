import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider, makeT } from '../../lib/i18n.js';
import { clearRefusals } from '../../lib/refusalMemo.js';

const t = makeT('en');

// The media-first row (owner-approved mockup A, 2026-11-05): checkbox | media | words |
// action. The media leads at its real aspect (or a quiet lane tile for a post with nothing to
// look at), the meta line sits on top, a bold title shows ONLY when a lane publishes one, the
// caption is one paragraph, and Approve is tonal except on the focused row.
vi.mock('../../lib/api.js', () => ({
  usePlatformValidate: () => ({ data: null }),
  approvePost: vi.fn(() => Promise.resolve({ ok: true })),
  rejectPost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
  usePendpostHealth: () => ({ data: null }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: null, isLoading: false, isError: false }),
}));

const media = { file: 'reel.mp4', exists: true, bytes: 1000, url: '/media?p=reel.mp4', cover: '/media?p=reel.jpg', path: 'reel.mp4', resolution: 'story-9x16' };
const reel = {
  id: 'reel-1', campaign: 'spring', title: 'Internal working title',
  caption: 'Wer morgens zehn Minuten draussen geht\nschlaeft abends frueher ein.',
  platforms: ['instagram'], approval: 'pending', derivedState: 'draft',
  scheduledAt: '2026-12-15T17:00:00Z', type: 'reel', image: null, media,
};
const short = {
  ...reel, id: 'short-1', title: 'Zehn Minuten Morgenlicht', platforms: ['youtube'], type: 'youtube-short',
  caption: 'Zehn Minuten Morgenlicht\nEine Studie mit 140 Bueroangestellten.',
};
const textPost = {
  id: 'text-1', campaign: 'spring', caption: 'A plain LinkedIn note for the week.', platforms: ['linkedin'],
  approval: 'pending', derivedState: 'draft', scheduledAt: '2026-12-16T07:30:00Z', type: 'text', image: null,
  media: { file: null, exists: false, bytes: null, url: null, cover: null, path: null },
};
const radarReply = {
  ...textPost, id: 'radar-1', platforms: ['reddit'], caption: 'The lamps work when they are bright enough.',
  radarReplyTo: { source: 'reddit', url: 'https://reddit.com/r/schlaf/1', author: 'u/nightowl', excerpt: 'Do daylight lamps help?' },
};

function renderFreigaben(posts, { density = 'comfortable', onOpen = vi.fn() } = {}) {
  try { localStorage.setItem('pendpost-approvals-density', density); } catch { /* private mode */ }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Freigaben campaigns={[{ id: 'spring', active: true, posts }]} onOpen={onOpen} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...utils, onOpen };
}

const rowFor = (text) => screen.getAllByRole('listitem').find((li) => (li.textContent || '').includes(text));
// DOCUMENT_POSITION_FOLLOWING: b comes after a in document order.
const precedes = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const isSolid = (btn) => /(^|\s)bg-emerald-700(\s|$)/.test(btn.className);

beforeEach(() => {
  clearRefusals();
  try { localStorage.clear(); } catch { /* private mode */ }
});

describe.each(['comfortable', 'compact'])('Freigaben media-first row (%s)', (density) => {
  it('puts the media before the words, the meta line above the caption', () => {
    renderFreigaben([reel], { density });
    const row = rowFor('Wer morgens');
    const mediaEl = row.querySelector('[data-row-media]');
    const meta = row.querySelector('[data-row-meta]');
    const caption = row.querySelector('[data-row-caption]');
    expect(mediaEl.querySelector('img, video')).not.toBeNull();
    expect(precedes(mediaEl, meta)).toBe(true);
    expect(precedes(meta, caption)).toBe(true);
    // The media sits before the open-detail button, never inside it (one control, no nesting).
    expect(mediaEl.closest('button')).toBeNull();
    // 72px wide from sm up (56px on a phone), at the post's real aspect.
    expect(mediaEl.className).toMatch(/sm:w-\[72px\]/);
    expect(mediaEl.querySelector('img').className).toMatch(/aspect-\[/);
  });

  it('an Instagram Reel has no title line: the whole caption is one paragraph, first line kept', () => {
    renderFreigaben([reel], { density });
    const row = rowFor('Wer morgens');
    expect(row.querySelector('[data-row-title]')).toBeNull();
    expect(row.textContent).not.toMatch(/Internal working title/);
    const caption = row.querySelector('[data-row-caption]');
    expect(caption.textContent).toBe('Wer morgens zehn Minuten draussen geht schlaeft abends frueher ein.');
    expect(caption.className).toMatch(/line-clamp-3/);
    // `block` overrides line-clamp's -webkit-box display, so the clamp would silently not apply.
    expect(caption.className).not.toMatch(/(^|\s)block(\s|$)/);
    expect(caption.className).not.toMatch(/font-bold/);
  });

  it('a YouTube post with a title shows it bold, and the caption under it without the repeated line', () => {
    renderFreigaben([short], { density });
    const row = rowFor('Bueroangestellten');
    const title = row.querySelector('[data-row-title]');
    expect(title).toHaveTextContent('Zehn Minuten Morgenlicht');
    expect(title.className).toMatch(/font-bold/);
    const caption = row.querySelector('[data-row-caption]');
    expect(caption.textContent).toBe('Eine Studie mit 140 Bueroangestellten.');
    expect(caption.className).toMatch(/line-clamp-2/);
    expect(precedes(row.querySelector('[data-row-meta]'), title)).toBe(true);
  });

  // A YouTube video publishes post.description, never the caption (yt-social.mjs buildMeta).
  it('a YouTube post with an empty caption shows its description under the title, two lines', () => {
    renderFreigaben([{ ...short, id: 'short-2', caption: '', description: 'Eine Studie mit 140 Bueroangestellten.\nQuellen im Kommentar.' }], { density });
    const row = rowFor('Quellen im Kommentar');
    expect(row.querySelector('[data-row-title]')).toHaveTextContent('Zehn Minuten Morgenlicht');
    const caption = row.querySelector('[data-row-caption]');
    expect(caption.textContent).toBe('Eine Studie mit 140 Bueroangestellten. Quellen im Kommentar.');
    expect(caption.className.split(/\s+/)).toContain('line-clamp-2');
    expect(caption.className.split(/\s+/)).not.toContain('block');
  });

  // One continuous row (owner, 2026-11-05): the words fill the row up to the action cluster,
  // and the cluster sits at the row's trailing edge. No reading-measure cap anywhere between.
  it('the words fill the row and the action cluster sits at the trailing edge', () => {
    renderFreigaben([reel], { density });
    const row = rowFor('Wer morgens');
    const action = row.querySelector('[data-row-action]');
    expect(action.className.split(/\s+/)).toContain('ml-auto');
    expect(action.className).not.toMatch(/sm:ml-0/);
    for (let el = row.querySelector('[data-row-caption]'); el && el !== row; el = el.parentElement) {
      expect(el.className).not.toMatch(/max-w-/);
    }
  });

  it('a text post keeps the media column with a quiet tile of its lane', () => {
    renderFreigaben([textPost], { density });
    const row = rowFor('plain LinkedIn note');
    const tile = row.querySelector('[data-row-media] [data-lane-tile]');
    expect(tile).toHaveAttribute('data-lane-tile', 'linkedin');
    expect(row.querySelector('img, video')).toBeNull();
  });

  it('a Radar reply tiles its source lane, with the thread above the reply caption', () => {
    renderFreigaben([radarReply], { density });
    const row = rowFor('bright enough');
    expect(row.querySelector('[data-row-media] [data-lane-tile]')).toHaveAttribute('data-lane-tile', 'reddit');
    const thread = within(row).getByText('Do daylight lamps help?');
    const caption = row.querySelector('[data-row-caption]');
    expect(precedes(thread, caption)).toBe(true);
    // The thread's link is a sibling of the open-detail button, never inside it.
    expect(within(row).getByRole('link').closest('button')).toBeNull();
  });

  it('clicking the media opens the post, like the rest of the row', () => {
    const { onOpen } = renderFreigaben([reel], { density });
    fireEvent.click(rowFor('Wer morgens').querySelector('[data-row-media]'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0].id).toBe('reel-1');
  });

  // ONE solid approve per list (owner, 2026-11-05): every row's approve is tonal and the list's
  // CSS makes one solid: the hovered row's, else the keyboard row's (data-focused).
  it('Approve is tonal on every row; the list makes the hovered, else the focused, row solid', async () => {
    renderFreigaben([reel, short], { density });
    // The queue pulls focus to the first row once it renders.
    await waitFor(() => expect(rowFor('Wer morgens')).toHaveFocus());
    const first = within(rowFor('Wer morgens')).getByRole('button', { name: t('approvals.action.approve') });
    const second = within(rowFor('Bueroangestellten')).getByRole('button', { name: t('approvals.action.approve') });
    for (const btn of [first, second]) {
      expect(isSolid(btn)).toBe(false);
      expect(btn.className).toMatch(/bg-emerald-500\/15/);
      expect(btn.className).not.toMatch(/group-hover|group-focus-within/);
      expect(btn).toHaveAttribute('data-row-approve');
    }
    expect(rowFor('Wer morgens')).toHaveAttribute('data-focused');
    expect(rowFor('Bueroangestellten')).not.toHaveAttribute('data-focused');
    const list = rowFor('Wer morgens').closest('ul');
    expect(list.className).toContain('[&_li:hover_[data-row-approve]:enabled]:bg-emerald-700');
    expect(list.className).toContain('[&:not(:has(li:hover))_li[data-focused]_[data-row-approve]:enabled]:bg-emerald-700');
  });
});

// The row's when reads like speech (owner, 2026-11-05): a day word for today / tomorrow /
// yesterday, else weekday + day + short month, never the "15.12.26" stamp.
describe('Freigaben row date', () => {
  afterEach(() => vi.useRealTimers());

  it('names tomorrow and shows a readable date further out', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 11, 14, 12, 0));
    const tomorrow = new Date(2026, 11, 15, 17, 0).toISOString();
    const later = new Date(2026, 11, 21, 9, 0).toISOString();
    renderFreigaben([{ ...reel, scheduledAt: tomorrow }, { ...textPost, scheduledAt: later }], { density: 'compact' });
    const whenOf = (text) => rowFor(text).querySelector('[data-row-meta] .tabular-nums').textContent;
    expect(whenOf('Wer morgens')).toMatch(/^Tomorrow · /);
    expect(whenOf('A plain LinkedIn note')).toMatch(/^Mon, Dec 21 · /);
  });
});

// Exceptions only (owner, 2026-11-05): the meta line names what the glyph does not already say
// and flags only what is wrong.
describe('Freigaben row meta: exceptions only', () => {
  it('says "Short" beside the YouTube glyph, not "YouTube Short"', () => {
    renderFreigaben([short], { density: 'compact' });
    const meta = rowFor('Bueroangestellten').querySelector('[data-row-meta]');
    expect(within(meta).getByText('Short')).toBeInTheDocument();
    expect(meta).not.toHaveTextContent('YouTube Short');
  });

  it('shows no HD pill for an HD video and keeps the 720p warning', () => {
    renderFreigaben([
      { ...reel, media: { ...media, hdReady: true } },
      { ...short, media: { ...media, hdReady: false, bitrate: 3_000_000 } },
    ], { density: 'compact' });
    expect(within(rowFor('Wer morgens').querySelector('[data-row-meta]')).queryByText('HD')).toBeNull();
    expect(within(rowFor('Bueroangestellten').querySelector('[data-row-meta]')).getByText('720p')).toBeInTheDocument();
  });

  it('drops the "N posts" count when the To review chip already carries it, keeps it on All', () => {
    renderFreigaben([reel, textPost], { density: 'compact' });
    expect(screen.getByText(t('approvals.view.toReviewCount', { n: 2 }))).toBeInTheDocument();
    expect(screen.queryByText(t('approvals.postCount', { n: 2 }))).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('approvals.view.all') }));
    expect(screen.getByText(t('approvals.postCount', { n: 2 }))).toBeInTheDocument();
  });
});
