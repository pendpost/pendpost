import { render, screen, within, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { ListView } from '../Planner.jsx';
import { setTimeFormat } from '../../lib/format.js';
import { I18nProvider } from '../../lib/i18n.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Studio fix flow, package C: the List row redesign (owner, 2026-11-01: "most of the content
// is cut off for text-only posts ... when there are errors we need a clear way to resolve
// it, preferably a button"). These pin the row contract:
//   - media first (2026-11-05): a media post's real thumbnail, or a quiet lane tile for a text
//     post (never a fake picture of its words), leads the words after the time column;
//   - a bold title only where a lane publishes one; the caption is one paragraph, clamped to
//     two lines, and keeps its first line when there is no title;
//   - a post that needs the owner shows ONE status line under its title (rose alert glyph +
//     the reason in the halted ink + its fix button on the same line) and no status pill;
//   - a calm post keeps its status pill and gets no fix button;
//   - the platform glyph leads the meta line, and every row's words share one edge;
//   - the ⋯ menu never repeats the row's fix, and a divider sets the delete apart
//     (polish round after the fresh-eyes review, 2026-11-01).

vi.mock('../../lib/agentFix.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useAgentFixes: () => ({ data: undefined }) };
});

const setup = { platforms: [
  { platform: 'telegram', status: 'incomplete' },
  { platform: 'linkedin', status: 'connected', validation: { state: 'live' } },
] };
const NO_MEDIA = { file: null, exists: false, bytes: null, url: null, cover: null, path: null };

const textPost = {
  id: 't1', campaign: 'launch', type: 'text', title: '', platforms: ['linkedin'],
  caption: 'Three things we learned shipping the planner\nFirst, approvals need to be one click.\nSecond, nobody reads a status pill.',
  scheduledAt: '2099-01-02T10:00:00Z', approval: 'approved', derivedState: 'waiting-due', image: null, media: NO_MEDIA,
};
const shortText = { ...textPost, id: 't2', caption: 'Just one line.' };
const mediaPost = {
  ...textPost, id: 'm1', type: 'reel', title: 'Reel of the week', caption: 'Watch the tour.',
  media: { ...NO_MEDIA, exists: true, cover: '/media/cover.jpg', url: '/media/reel.mp4', path: 'data/media/reel.mp4' },
};
const blockedPost = { ...textPost, id: 'b1', title: 'Telegram teaser', caption: 'Coming soon.', platforms: ['telegram'] };

function renderList(posts, props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['pendpost-health'], { setup });
  const onNavigate = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <ListView posts={posts} onSelect={() => {}} onNavigate={onNavigate} loading={false} {...props} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onNavigate };
}
// A row by the post's NAME (postDisplayTitle), which its selection checkbox carries: the visible
// words follow the title rule, so a LinkedIn post's title is not on the row.
const rowOf = (name) => screen.getByRole('checkbox', { name: `Select ${name}` }).closest('li');

describe('List row: text posts show their words, not a fake thumbnail', () => {
  it('no title on a LinkedIn post: the whole caption is one paragraph on two lines, a lane tile leads', () => {
    renderList([textPost]);
    const li = rowOf('Three things we learned shipping the planner');
    expect(li.querySelector('[data-row-title]')).toBeNull();
    const snippet = li.querySelector('[data-row-caption]');
    expect(snippet).not.toBeNull();
    expect(snippet.className).toContain('line-clamp-2');
    expect(snippet).toHaveTextContent('Three things we learned shipping the planner First, approvals need to be one click. Second, nobody reads a status pill.');
    expect(snippet.className).not.toContain('font-bold');
    expect(li.querySelector('[data-text-preview]')).toBeNull();
    expect(li.querySelector('img, video')).toBeNull();
    const tile = li.querySelector('[data-row-media] [data-lane-tile]');
    expect(tile).toHaveAttribute('data-lane-tile', 'linkedin');
    expect(tile.className).toContain('w-full');
    expect(li.querySelector('[data-row-media]').className).toContain('w-10');
  });

  it('a one-line text post shows its line as the caption, with no title line', () => {
    renderList([shortText]);
    const li = rowOf('Just one line.');
    expect(li.querySelector('[data-row-title]')).toBeNull();
    expect(li.querySelector('[data-row-caption]')).toHaveTextContent(/^Just one line\.$/);
  });

  it('a media post keeps its real thumbnail, 40px wide at its own aspect, before the words', () => {
    renderList([mediaPost]);
    const li = rowOf('Reel of the week');
    const media = li.querySelector('[data-row-media]');
    expect(media.querySelector('img')).toHaveAttribute('src', '/media/cover.jpg');
    expect(media.querySelector('img').className).toMatch(/aspect-\[/);
    expect(li.querySelector('[data-row-caption]')).toHaveTextContent('Watch the tour.');
    expect(media.compareDocumentPosition(li.querySelector('[data-row-caption]')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a YouTube post shows its title bold, the caption quiet under it without the repeated line', () => {
    renderList([{ ...mediaPost, id: 'yt1', type: 'youtube-short', platforms: ['youtube'], title: 'Morning light', caption: 'Morning light\nA study with 140 people.' }]);
    const li = rowOf('Morning light');
    const title = li.querySelector('[data-row-title]');
    expect(title).toHaveTextContent('Morning light');
    expect(title.className).toContain('font-bold');
    expect(title.className).not.toMatch(/max-w-/);
    const caption = li.querySelector('[data-row-caption]');
    expect(caption).toHaveTextContent(/^A study with 140 people\.$/);
    expect(caption.className).toContain('text-zinc-600');
  });

  // A YouTube video publishes post.description, never the caption (yt-social.mjs buildMeta), so
  // the row reads the description: every live YouTube post has an empty caption.
  it('a YouTube post with an empty caption shows its description under the title, two lines', () => {
    renderList([{ ...mediaPost, id: 'yt2', type: 'youtube-short', platforms: ['youtube'], title: 'Morning light', caption: '', description: 'A study with 140 people.\nSources in the pinned comment.' }]);
    const li = rowOf('Morning light');
    expect(li.querySelector('[data-row-title]')).toHaveTextContent('Morning light');
    const caption = li.querySelector('[data-row-caption]');
    expect(caption).toHaveTextContent(/^A study with 140 people\. Sources in the pinned comment\.$/);
    expect(caption.className.split(/\s+/)).toContain('line-clamp-2');
    expect(caption.className.split(/\s+/)).not.toContain('block');
  });

  // Planner bulk (package P, the owner's pick): the List spans the panel like Approvals (the
  // max-w-6xl cap is gone), and the words carry no reading-measure cap of their own.
  it('the list spans the panel; the words are not capped', () => {
    renderList([textPost]);
    const li = rowOf('Three things we learned shipping the planner');
    expect(li.closest('.max-w-6xl')).toBeNull();
    expect(li.closest('.w-full')).not.toBeNull();
    expect(li.querySelector('[data-row-caption]').className).not.toMatch(/max-w-/);
  });

  // Exceptions only (owner, 2026-11-05): the glyph already says YouTube, and an HD video is the
  // normal case, so the meta line says "Short" and shows no HD pill; a thin master keeps 720p.
  it('the meta line says "Short", hides the HD pill and keeps the 720p warning', () => {
    const yt = { ...mediaPost, id: 'yt3', type: 'youtube-short', platforms: ['youtube'], title: 'Morning light' };
    renderList([
      { ...yt, media: { ...yt.media, hdReady: true } },
      { ...yt, id: 'yt4', title: 'Evening light', media: { ...yt.media, hdReady: false, bitrate: 3_000_000 } },
    ]);
    const hd = rowOf('Morning light');
    expect(within(hd).getByText('Short')).toBeInTheDocument();
    expect(hd).not.toHaveTextContent('YouTube Short');
    expect(within(hd).queryByText('HD')).toBeNull();
    expect(within(rowOf('Evening light')).getByText('720p')).toBeInTheDocument();
  });

  // One continuous row (owner, 2026-11-05): the open-detail button fills the row (flex-1, no
  // cap), so the pill and the ⋯ right after it sit at the row's trailing edge.
  it('the words fill the row; the pill and the menu sit at the trailing edge', () => {
    renderList([shortText]);
    const li = rowOf('Just one line.');
    const open = li.querySelector('[data-row-caption]').closest('button');
    expect(open.className.split(/\s+/)).toContain('flex-1');
    expect(open.className).not.toMatch(/max-w-/);
    expect(open.nextElementSibling).toBe(li.querySelector('[data-row-pill]'));
  });
});

describe('List row: one status signal', () => {
  it('a post that needs the owner shows the fix button, and keeps its APPROVAL pill beside the red line (judge round 2, item 3)', () => {
    renderList([blockedPost, { ...blockedPost, id: 'b9', title: 'Telegram draft', approval: 'pending', derivedState: 'draft' }]);
    const li = rowOf('Telegram teaser');
    expect(within(li).getByRole('button', { name: 'Connect Telegram' })).toBeInTheDocument();
    // The pill says where the post stands on approval; the red line says why it needs you.
    const pill = li.querySelector('[data-row-pill]');
    expect(pill).toHaveTextContent('Approved');
    expect(within(li).queryByText('Blocked')).toBeNull();
    expect(within(li).getByText('Telegram is not connected')).toBeInTheDocument();
    expect(rowOf('Telegram draft').querySelector('[data-row-pill]')).toHaveTextContent('Awaiting approval');
  });

  it('ONE status line under the title: rose alert glyph + reason in halted ink + the fix inline', () => {
    renderList([blockedPost]);
    const li = rowOf('Telegram teaser');
    const btn = within(li).getByRole('button', { name: 'Connect Telegram' });
    const line = btn.closest('[data-row-status]');
    expect(line).not.toBeNull();
    expect(line).toHaveAttribute('data-tone', 'halted');
    // The glyph and the reason both wear the halted staircase ink (format.js STAIR.halted).
    const glyph = line.querySelector('svg');
    expect(glyph.getAttribute('class')).toContain('text-rose-700');
    expect(glyph.getAttribute('class')).toContain('dark:text-rose-300');
    const reason = within(line).getByText('Telegram is not connected');
    expect(reason.className).toContain('text-rose-700');
    // The line spans the row under the title (indent = checkbox slot + time column and their
    // gaps, the title edge; md:pl-[6.75rem] beside the 12-hour column en-US renders; below md it
    // starts under the time, pl-7, so a phone never cuts the reason) and the fix sits ON it
    // (never wraps under the reason), pushed to its trailing edge.
    for (const c of ['flex', 'basis-full', 'pl-7', 'md:pl-[6.75rem]', 'order-last']) expect(line.className).toContain(c);
    expect(line.className).not.toContain('flex-wrap');
    // Only the indent changes with the width.
    expect(line.className.match(/\bmd:\S+/g)).toEqual(['md:pl-[6.75rem]']);
    expect(btn.closest('.ml-auto')).not.toBeNull();
    expect(btn.closest('.ml-auto').className).toContain('shrink-0');
    expect(btn.closest('.ml-auto').className).not.toMatch(/md:ml-0/);
    expect(reason.className).not.toMatch(/max-w-/);
    // The line sits under the title, outside the open-detail button (no nested controls).
    expect(line.closest('button')).toBeNull();
  });

  it('the platform glyph leads the meta line, and every row opens with its media column', () => {
    renderList([blockedPost, mediaPost]);
    const lead = rowOf('Telegram teaser').querySelector('[data-row-lead]');
    expect(lead).not.toBeNull();
    expect(lead.querySelector('[aria-label="Telegram"]')).not.toBeNull();
    // The type follows the lead glyph on the meta line.
    expect(lead.nextElementSibling).toHaveTextContent('Text');
    // Both rows open the button with the same 40px media column (a tile or the thumbnail), so
    // the words start at one x with or without a picture.
    for (const name of ['Telegram teaser', 'Reel of the week']) {
      const btn = rowOf(name).querySelector('[data-row-media]').parentElement;
      expect(btn.tagName).toBe('BUTTON');
      expect(btn.firstElementChild.hasAttribute('data-row-media')).toBe(true);
    }
  });

  it('a calm post keeps its status pill and offers no fix', () => {
    renderList([textPost]);
    const li = rowOf('Three things we learned shipping the planner');
    expect(within(li).getByText('Approved')).toBeInTheDocument();
    expect(within(li).queryByRole('button', { name: /^Connect/ })).toBeNull();
  });

  it('an OAuth lane fix sends the owner to Setup with the reconnect started', () => {
    const li = { ...blockedPost, id: 'b2', title: 'LinkedIn refusal', platforms: ['linkedin'], derivedState: 'publish-failed', lastFailure: { lane: 'linkedin', recovery: 'reconnect', terminal: true, code: 'needs_scope' } };
    const { onNavigate } = renderList([li]);
    fireEvent.click(within(rowOf('LinkedIn refusal')).getByRole('button', { name: 'Reconnect LinkedIn' }));
    expect(onNavigate).toHaveBeenCalledWith('setup', 'linkedin', { action: 'reconnect' });
  });
});

describe('List row ⋯ menu', () => {
  it('does not repeat the fix the row already shows as a button', () => {
    const li = { ...blockedPost, id: 'b3', title: 'LinkedIn refusal', platforms: ['linkedin'], derivedState: 'publish-failed', lastFailure: { lane: 'linkedin', recovery: 'reconnect', terminal: true } };
    renderList([li]);
    const row = rowOf('LinkedIn refusal');
    expect(within(row).getByRole('button', { name: 'Reconnect LinkedIn' })).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'More actions' }));
    for (const item of screen.getAllByRole('menuitem')) expect(item).not.toHaveTextContent(/Connect|Reconnect/);
  });

  it('sets the destructive delete apart with a divider', () => {
    renderList([textPost]);
    fireEvent.click(within(rowOf('Three things we learned shipping the planner')).getByRole('button', { name: 'More actions' }));
    const menu = screen.getByRole('menu');
    const sep = within(menu).getByRole('separator');
    const items = within(menu).getAllByRole('menuitem');
    const del = items[items.length - 1];
    expect(del).toHaveTextContent(/Delete/);
    // The separator sits directly before the delete item (its Tip wrapper is transparent).
    expect(sep.compareDocumentPosition(del) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sep.compareDocumentPosition(items[items.length - 2]) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });
});

// Release polish 2026-11-01: "01:25 PM" wrapped to two lines in the 44px time column. The
// column now fits the clock in use and never wraps; the lines under the title keep its edge.
describe('List row: the time column', () => {
  afterEach(() => setTimeFormat('auto'));
  const timeOf = (li) => within(li).getAllByRole('button').find((b) => /\d{2}:\d{2}/.test(b.textContent) && b.className.includes('tabular-nums'));

  it('12-hour: one line, wide enough for "01:25 PM", lines under the title indent with it', () => {
    setTimeFormat('12h');
    renderList([blockedPost]);
    const li = rowOf('Telegram teaser');
    const time = timeOf(li);
    expect(time).toHaveTextContent(/\d{2}:\d{2}\s?[AP]M/);
    expect(time.className).toContain('whitespace-nowrap');
    expect(time.className).toContain('w-[4.25rem]');
    expect(li.querySelector('[data-row-status]').className).toContain('md:pl-[6.75rem]');
  });

  it('24-hour: the compact 44px column and its indent (checkbox slot + column)', () => {
    setTimeFormat('24h');
    renderList([blockedPost]);
    const li = rowOf('Telegram teaser');
    const time = timeOf(li);
    expect(time.className).toContain('whitespace-nowrap');
    expect(time.className).toMatch(/(^|\s)w-11(\s|$)/);
    expect(li.querySelector('[data-row-status]').className).toContain('md:pl-[5.25rem]');
  });
});

// Planner judge round 2 (the phone): touch has no hover, so the checkbox must show to start a
// selection (item 1); a phone row says its status in words under its title, so nobody ticks a
// published post blind (item 4); and no gutter squeezes the caption next to a thumbnail
// (item 8): the time moves from its own column onto that status line.
describe('List row on a phone (< 768px)', () => {
  let original;
  beforeEach(() => {
    original = window.matchMedia;
    window.matchMedia = (q) => ({ matches: q.includes('max-width: 767px'), media: q, addEventListener() {}, removeEventListener() {} });
  });
  afterEach(() => { window.matchMedia = original; });

  it('every checkbox shows before anything is selected (touch cannot hover)', () => {
    renderList([textPost, shortText]);
    for (const slot of document.querySelectorAll('[data-pick]')) expect(slot.className).not.toContain('opacity-0');
  });

  it('the status (glyph + word) and the time sit under the title, inside the open-detail button', () => {
    setTimeFormat('24h');
    const published = { ...textPost, id: 'p1', caption: 'We are live', derivedState: 'posted', status: 'posted' };
    renderList([textPost, published]);
    const li = rowOf('We are live');
    const meta = li.querySelector('[data-row-meta]');
    expect(meta).not.toBeNull();
    expect(meta).toHaveTextContent(/Published/);
    expect(meta).toHaveTextContent(/\d{2}:\d{2}/);
    expect(meta.querySelector('svg')).not.toBeNull();
    // Directly under the title line, before the caption, inside the button that opens the post.
    expect(meta.closest('button')).not.toBeNull();
    expect(rowOf('Three things we learned shipping the planner').querySelector('[data-row-meta]')).toHaveTextContent('Approved');
    setTimeFormat('auto');
  });

  it('no time column beside the checkbox: the caption starts right after it', () => {
    renderList([textPost]);
    const li = rowOf('Three things we learned shipping the planner');
    const kids = [...li.children];
    expect(kids[0].hasAttribute('data-pick')).toBe(true);
    // The next sibling is the open-detail button, not a time column.
    expect(kids[1].tagName).toBe('BUTTON');
    expect(kids[1].textContent).toContain('Three things');
    expect(li.querySelector('[data-row-pill]')).toBeNull(); // the side pill is the desktop's
  });
});
