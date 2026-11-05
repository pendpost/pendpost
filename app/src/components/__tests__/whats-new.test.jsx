import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { I18nProvider } from '../../lib/i18n.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { WhatsNewList } from '../WhatsNew.jsx';
import FeedbackDialog from '../FeedbackDialog.jsx';
import { highlightsFor, formatNoteDate } from '../../lib/whatsNew.js';

// The notes view (docs/specs/whats-new.md) and its second door, the Help and
// feedback dialog: the running version with "What's new", which swaps the dialog
// body to the recent notes and back, never a second dialog on top.
let news = null;
vi.mock('../../lib/whatsNew.js', async (importOriginal) => ({
  ...(await importOriginal()),
  useWhatsNew: () => ({ data: news }),
}));
vi.mock('../../lib/api.js', () => ({
  useBuildStatus: () => ({ data: { version: '2.10.0', os: 'darwin', node: 'v22', mode: 'live' } }),
}));

const NOTE = (version, date, en, de) => ({ version, date, url: `https://example.test/v${version}`, highlights: { en, ...(de ? { 'de-CH': de } : {}) } });
const RECENT = [
  NOTE('2.10.0', '2026-11-02', ['Bulk actions in the List.', 'A tray groups problems.'], ['Mehrere Beiträge auf einmal.', 'Eine Leiste fasst Probleme zusammen.']),
  NOTE('2.9.0', '2026-10-28', ['Clear refusals.']),
];
const wrap = (node, locale = 'en') => render(
  <I18nProvider locale={locale}><TooltipProvider>{node}</TooltipProvider></I18nProvider>,
);

beforeEach(() => {
  news = { ok: true, version: '2.10.0', seen: '2.10.0', unseen: [], recent: RECENT, releasesUrl: 'https://example.test/releases' };
});

describe('whatsNew helpers', () => {
  it('picks the active locale and falls back to English', () => {
    expect(highlightsFor(RECENT[0], 'de-CH')).toEqual(['Mehrere Beiträge auf einmal.', 'Eine Leiste fasst Probleme zusammen.']);
    expect(highlightsFor(RECENT[1], 'de-CH')).toEqual(['Clear refusals.']);
    expect(highlightsFor({}, 'en')).toEqual([]);
  });

  it('formats the date per locale without a time-zone shift', () => {
    expect(formatNoteDate('2026-11-02', 'en')).toBe('2 November 2026');
    expect(formatNoteDate('2026-11-02', 'de-CH')).toBe('2. November 2026');
    expect(formatNoteDate('nope', 'en')).toBe('');
  });
});

describe('WhatsNewList', () => {
  it('one block per version: number, date, highlights and its full-notes link', () => {
    wrap(<WhatsNewList entries={RECENT} releasesUrl="https://example.test/releases" />);
    const blocks = screen.getAllByRole('region');
    expect(blocks).toHaveLength(2);
    expect(within(blocks[0]).getByRole('heading', { level: 3 })).toHaveTextContent('2.10.0');
    expect(blocks[0]).toHaveTextContent('2 November 2026');
    expect(within(blocks[0]).getAllByRole('listitem')).toHaveLength(2);
    const link = within(blocks[0]).getByRole('link', { name: 'Full notes for 2.10.0' });
    expect(link).toHaveAttribute('href', 'https://example.test/v2.10.0');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('with nothing to show it says so and links to all releases', () => {
    wrap(<WhatsNewList entries={[]} releasesUrl="https://example.test/releases" />);
    expect(screen.getByText(/No notes for this version yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All releases' })).toHaveAttribute('href', 'https://example.test/releases');
  });
});

describe('Help and feedback: the version line', () => {
  it('names the running version and swaps to the recent notes and back, in one dialog', async () => {
    wrap(<FeedbackDialog onClose={() => {}} />);
    expect(screen.getByText('pendpost 2.10.0')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: "What's new" }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    const dialog = screen.getByRole('dialog', { name: "What's new" });
    expect(within(dialog).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['2.10.0', '2.9.0']);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('dialog', { name: 'Help & feedback' })).toBeInTheDocument();
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
    expect(dialog).toHaveTextContent('Mehrere Beiträge auf einmal.');
    expect(within(dialog).getByRole('button', { name: 'Zurück' })).toBeInTheDocument();
  });
});
