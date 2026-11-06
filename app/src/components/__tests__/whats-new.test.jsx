import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { I18nProvider } from '../../lib/i18n.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import WhatsNewDialog, { WhatsNewList } from '../WhatsNew.jsx';
import FeedbackDialog from '../FeedbackDialog.jsx';
import { itemsFor, formatNoteDate } from '../../lib/whatsNew.js';

// The notes view (docs/specs/whats-new.md) and its second door, the Help and
// feedback dialog: the running version with "What's new", which swaps the dialog
// body to the recent notes and back, never a second dialog on top. Each item is
// a row: art tile, title, one sentence, and "Show me" when it has a known spot.
let news = null;
vi.mock('../../lib/whatsNew.js', async (importOriginal) => ({
  ...(await importOriginal()),
  useWhatsNew: () => ({ data: news }),
}));
vi.mock('../../lib/api.js', () => ({
  useBuildStatus: () => ({ data: { version: '2.10.0', os: 'darwin', node: 'v22', mode: 'live' } }),
}));
const jumps = [];
vi.mock('../../lib/spotJump.js', async (importOriginal) => ({
  ...(await importOriginal()),
  jumpToSpot: (key) => { jumps.push(key); return true; },
}));

const ITEM = (kind, icon, en, de, go) => ({
  kind,
  icon,
  title: { en: en[0], ...(de ? { 'de-CH': de[0] } : {}) },
  body: { en: en[1], ...(de ? { 'de-CH': de[1] } : {}) },
  ...(go ? { go } : {}),
});
const NOTE = (version, date, items) => ({ version, date, url: `https://pendpost.com/changelog#v${version}`, items });
const RECENT = [
  NOTE('2.10.0', '2026-11-02', [
    ITEM('new', 'list-checks', ['Many posts at once', 'Approve many posts in one go.'], ['Mehrere Beiträge auf einmal', 'Gib viele Beiträge auf einmal frei.'], 'bulk-select'),
    ITEM('improved', 'radar', ['Fewer, stronger asks', 'Radar shows a handful of strong asks.'], ['Weniger, bessere Anfragen', 'Radar zeigt wenige starke Anfragen.'], 'nowhere'),
  ]),
  NOTE('2.9.0', '2026-10-28', [
    ITEM('fixed', 'youtube', ['Complete YouTube uploads', 'Uploads carry the right language.']),
  ]),
];
const RELEASES = 'https://pendpost.com/changelog';
const wrap = (node, locale = 'en') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['dashboard-update'], { update: { running: { version: '2.10.0', commit: 'a1b2c3d4e5f6a7b8' } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}><TooltipProvider>{node}</TooltipProvider></I18nProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  news = { ok: true, version: '2.10.0', seen: '2.10.0', unseen: [], recent: RECENT, releasesUrl: RELEASES };
  jumps.length = 0;
});

describe('whatsNew helpers', () => {
  it('resolves each item for the locale, then the language, then English', () => {
    expect(itemsFor(RECENT[0], 'de-CH')[0]).toEqual({
      kind: 'new', icon: 'list-checks', title: 'Mehrere Beiträge auf einmal', body: 'Gib viele Beiträge auf einmal frei.', go: 'bulk-select',
    });
    // No de-CH text: English.
    expect(itemsFor(RECENT[1], 'de-CH')[0]).toMatchObject({ title: 'Complete YouTube uploads', go: null });
    // The language alone ("de") when the exact locale is missing.
    const de = NOTE('1.0.0', '2026-01-01', [{ kind: 'new', icon: 'inbox', title: { en: 'Hi', de: 'Hallo' }, body: { en: 'One.', de: 'Eins.' } }]);
    expect(itemsFor(de, 'de-CH')[0]).toMatchObject({ title: 'Hallo', body: 'Eins.' });
    expect(itemsFor({}, 'en')).toEqual([]);
  });

  it('formats the date per locale without a time-zone shift', () => {
    expect(formatNoteDate('2026-11-02', 'en')).toBe('2 November 2026');
    expect(formatNoteDate('2026-11-02', 'de-CH')).toBe('2. November 2026');
    expect(formatNoteDate('nope', 'en')).toBe('');
  });
});

describe('WhatsNewList', () => {
  it('one block per version: number, date, then a row per item with title, body and kind', () => {
    wrap(<WhatsNewList entries={RECENT} releasesUrl={RELEASES} onGo={() => {}} />);
    const blocks = screen.getAllByRole('region');
    expect(blocks).toHaveLength(2);
    expect(within(blocks[0]).getByRole('heading', { level: 3 })).toHaveTextContent('2.10.0');
    expect(blocks[0]).toHaveTextContent('2 November 2026');
    const rows = within(blocks[0]).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('New: Many posts at once');
    expect(rows[0]).toHaveTextContent('Approve many posts in one go.');
    expect(rows[1]).toHaveTextContent('Improved: Fewer, stronger asks');
    expect(within(blocks[1]).getByRole('listitem')).toHaveTextContent('Fixed: Complete YouTube uploads');
  });

  it('reads in de-CH, kind included', () => {
    wrap(<WhatsNewList entries={RECENT} releasesUrl={RELEASES} onGo={() => {}} />, 'de-CH');
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Neu: Mehrere Beiträge auf einmal');
    expect(rows[0]).toHaveTextContent('Gib viele Beiträge auf einmal frei.');
    expect(rows[1]).toHaveTextContent('Verbessert: Weniger, bessere Anfragen');
    expect(rows[2]).toHaveTextContent('Behoben: Complete YouTube uploads');
    expect(screen.getByRole('button', { name: 'Zeig mir: Mehrere Beiträge auf einmal' })).toBeInTheDocument();
    expect(screen.getByText('2. November 2026')).toBeInTheDocument();
  });

  it('shows the arrow only for a known spot, and it calls onGo with the key', async () => {
    const onGo = vi.fn();
    wrap(<WhatsNewList entries={RECENT} releasesUrl={RELEASES} onGo={onGo} />);
    const arrows = screen.getAllByRole('button', { name: /^Show me: / });
    // 'nowhere' is not a spot and the YouTube item has no go: one arrow.
    expect(arrows).toHaveLength(1);
    expect(arrows[0]).toHaveAccessibleName('Show me: Many posts at once');
    expect(arrows[0].className).toMatch(/after:h-11/);
    await userEvent.click(arrows[0]);
    expect(onGo).toHaveBeenCalledWith('bulk-select');
  });

  it('art tiles are decorative and fall back to Sparkles for an unknown icon', () => {
    const odd = NOTE('3.0.0', '2026-12-01', [ITEM('new', 'not-an-icon', ['Odd', 'Odd one.']), ITEM('fixed', 'radar', ['Even', 'Even one.'])]);
    const { container } = wrap(<WhatsNewList entries={[odd]} releasesUrl={RELEASES} />);
    const tiles = container.querySelectorAll('[data-icon]');
    expect([...tiles].map((t) => t.getAttribute('data-icon'))).toEqual(['sparkles', 'radar']);
    for (const tile of tiles) expect(tile).toHaveAttribute('aria-hidden', 'true');
  });

  it('one footer link to every version on the changelog, and no per-version link', () => {
    wrap(<WhatsNewList entries={RECENT} releasesUrl={RELEASES} />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName('All releases');
    expect(links[0]).toHaveAttribute('href', RELEASES);
    expect(links[0]).toHaveAttribute('target', '_blank');
  });

  it('with nothing to show it says so and links to all releases', () => {
    wrap(<WhatsNewList entries={[]} releasesUrl={RELEASES} />);
    expect(screen.getByText(/No notes for this version yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All releases' })).toHaveAttribute('href', RELEASES);
  });
});

describe('WhatsNewDialog: Show me', () => {
  it('closes the dialog (which marks it seen) and jumps to the spot', async () => {
    const onClose = vi.fn();
    wrap(<WhatsNewDialog entries={RECENT} releasesUrl={RELEASES} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show me: Many posts at once' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(jumps).toEqual(['bulk-select']);
  });
});

describe('Help and feedback: the version line', () => {
  it('names the running version, with the short commit only as its title', () => {
    wrap(<FeedbackDialog onClose={() => {}} />);
    const line = screen.getByText('pendpost 2.10.0');
    expect(line).toHaveAttribute('title', 'a1b2c3d');
    expect(screen.queryByText(/a1b2c3d/)).toBeNull();
  });

  it('swaps to the recent notes and back, in one dialog', async () => {
    wrap(<FeedbackDialog onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: "What's new" }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    const dialog = screen.getByRole('dialog', { name: "What's new" });
    expect(within(dialog).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['2.10.0', '2.9.0']);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('dialog', { name: 'Help & feedback' })).toBeInTheDocument();
  });

  it('Show me closes Help and feedback and jumps', async () => {
    const onClose = vi.fn();
    wrap(<FeedbackDialog onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: "What's new" }));
    await userEvent.click(screen.getByRole('button', { name: 'Show me: Many posts at once' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(jumps).toEqual(['bulk-select']);
  });

  it('keeps what was typed when the owner comes back from the notes', async () => {
    wrap(<FeedbackDialog onClose={() => {}} />);
    await userEvent.type(screen.getByRole('textbox'), 'Hello');
    await userEvent.click(screen.getByRole('button', { name: "What's new" }));
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('textbox')).toHaveValue('Hello');
  });

  it('reads in de-CH', async () => {
    wrap(<FeedbackDialog onClose={() => {}} />, 'de-CH');
    await userEvent.click(screen.getByRole('button', { name: 'Neuerungen' }));
    const dialog = screen.getByRole('dialog', { name: 'Neuerungen' });
    expect(dialog).toHaveTextContent('Mehrere Beiträge auf einmal');
    expect(within(dialog).getByRole('button', { name: 'Zurück' })).toBeInTheDocument();
  });
});
