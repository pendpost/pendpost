import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { ListView } from '../Planner.jsx';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Final judge finding 4: the planner List row meta read "Launch · li-scope · Text" and the
// Freigaben card meta "Kampagne: Launch · tg-review". The post id is an infrastructure slug;
// the row's own headline already names the post (its title, else its first caption line),
// so the meta keeps only the human campaign label (plus the type on the List row). The raw
// campaign / post ids stay on the meta line's hover title for the operator who needs them,
// the same approach the post detail header took (e6922eba).

vi.mock('../../lib/api.js', () => ({
  usePlatformValidate: () => ({ data: null }),
  approvePost: vi.fn(() => Promise.resolve({ ok: true })),
  rejectPost: vi.fn(() => Promise.resolve({ ok: true })),
  markPosted: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
  usePendpostHealth: () => ({ data: null }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: null, isLoading: false, isError: false }),
  reschedulePost: vi.fn(),
}));

const NO_MEDIA = { file: null, exists: false, bytes: null, url: null, cover: null, path: null };
const liScope = {
  id: 'li-scope', campaign: 'launch', title: 'Launch week recap', caption: 'The approval gate now covers LinkedIn.',
  platforms: ['linkedin'], type: 'text', approval: 'pending', derivedState: 'draft',
  scheduledAt: '2099-07-01T10:00:00Z', image: null, media: NO_MEDIA,
};
const tgReview = {
  id: 'tg-review', campaign: 'launch', caption: 'Planner tour for the Telegram channel, next steps inside.',
  platforms: ['telegram'], type: 'text', approval: 'pending', derivedState: 'draft',
  scheduledAt: '2099-07-02T10:00:00Z', image: null, media: NO_MEDIA,
};

const wrap = (ui, locale = 'de-CH') => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <I18nProvider locale={locale}>
      <TooltipProvider>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </TooltipProvider>
    </I18nProvider>
  </QueryClientProvider>
);

// Studio fix flow (2026-11-01, package C): the List row no longer carries a "Launch · Text"
// meta line; the owner picked wide rows whose second and third lines are the post's own
// caption (the type shows as the thumbnail or its absence, the campaign in the detail). The
// raw slugs still never show.
describe('Planner List row: never the raw post slug', () => {
  it('names the post by its title (else its first caption line) and shows the caption, no ids', () => {
    const { container } = render(wrap(<ListView posts={[liScope, tgReview]} onSelect={() => {}} loading={false} lane={{}} />));
    expect(container.textContent).not.toContain('li-scope');
    expect(container.textContent).not.toContain('tg-review');
    expect(screen.queryByText('Launch · Text')).toBeNull();
    // The headline still names the post: its title, else its first caption line.
    expect(screen.getByText('Launch week recap')).toBeInTheDocument();
    expect(screen.getByText('The approval gate now covers LinkedIn.')).toBeInTheDocument();
    expect(screen.getAllByText('Planner tour for the Telegram channel, next steps inside.').length).toBeGreaterThan(0);
  });
});

describe('Freigaben card meta: campaign label, never the raw post slug', () => {
  // 2026-11-01 (owner: "remove the campaign display, it can be a hover or in the details"): the
  // row's meta line carries glyph, date and type only; the campaign rides a real tooltip on
  // the date, never visible row text, and the raw slug never reaches the screen.
  it('the campaign is no longer row text and the raw slug never shows', () => {
    const campaigns = [{ id: 'launch', active: true, posts: [liScope, tgReview] }];
    const { container } = render(wrap(<Freigaben campaigns={campaigns} onOpen={() => {}} />));
    expect(container.textContent).not.toContain('li-scope');
    expect(container.textContent).not.toContain('tg-review');
    expect(container.textContent).not.toContain('Kampagne:');
  });

  it('the date carries the campaign in a real tooltip', async () => {
    const user = userEvent.setup();
    const campaigns = [{ id: 'launch', active: true, posts: [tgReview] }];
    const { container } = render(wrap(<Freigaben campaigns={campaigns} onOpen={() => {}} />, 'en'));
    expect(container.textContent).not.toContain('Campaign: Launch');
    await user.hover(container.querySelector('[data-row-meta] .tabular-nums'));
    expect((await screen.findAllByText('Campaign: Launch')).length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain('tg-review');
  });
});
