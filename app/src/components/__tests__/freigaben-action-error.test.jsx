import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { clearRefusals } from '../../lib/refusalMemo.js';

// A failed approve/reject leaves a lasting alert that is always a plain sentence
// (humanizeAction), never the server's raw English line inline. ActionButton hands over
// null for an error that carried no message, which used to leave NO alert at all once the
// button's red flash ended; a server message ("HTTP 500 internal") used to be the alert.
const approvePost = vi.fn();
const rejectPost = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('../../lib/api.js', () => ({
  usePlatformValidate: () => ({ data: null }),
  approvePost: (...a) => approvePost(...a),
  rejectPost: (...a) => rejectPost(...a),
  markPosted: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
  usePendpostHealth: () => ({ data: null }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: null, isLoading: false, isError: false }),
}));

const post = {
  id: 'p1',
  campaign: 'spring',
  title: 'Spring promo',
  caption: 'A caption body.',
  platforms: ['linkedin'],
  approval: 'pending',
  derivedState: 'draft',
  scheduledAt: '2026-07-01T10:00:00Z',
  type: 'text',
  image: null,
  media: { file: null, exists: false, bytes: null, url: null, cover: null, path: null },
};

function renderFreigaben(locale = 'en') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ConfirmProvider>
            <Freigaben campaigns={[{ id: 'spring', active: true, posts: [post] }]} onOpen={() => {}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  clearRefusals();
  approvePost.mockReset();
  rejectPost.mockClear();
});

describe('Freigaben action errors speak a plain sentence', () => {
  it('a message-less approve failure still leaves the generic sentence as the alert', async () => {
    approvePost.mockRejectedValue(new Error());
    const user = userEvent.setup();
    renderFreigaben();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That did not work. Please try again.');
  });

  it('a server error is not shown inline; its raw line rides the "?" only', async () => {
    approvePost.mockRejectedValue(new Error('HTTP 500 internal'));
    const user = userEvent.setup();
    renderFreigaben();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That did not work. Please try again.');
    expect(alert).not.toHaveTextContent(/HTTP 500/);
    // The raw detail is still reachable behind the house "?" trigger.
    const help = screen.getByRole('button', { name: /more about this|mehr dazu/i });
    expect(help).toHaveAccessibleDescription('HTTP 500 internal');
  });

  it('the German surface says it in German', async () => {
    approvePost.mockRejectedValue(new Error('HTTP 500 internal'));
    const user = userEvent.setup();
    renderFreigaben('de-CH');
    await user.click(screen.getByRole('button', { name: 'Freigeben' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Das hat nicht geklappt. Bitte versuch es nochmals.');
    expect(alert).not.toHaveTextContent(/HTTP/);
  });

  it('a failed bulk approve names the failed post but keeps the server line off the bar', async () => {
    approvePost.mockRejectedValue(new Error('HTTP 500 internal'));
    const user = userEvent.setup();
    renderFreigaben();
    await user.click(screen.getByRole('checkbox', { name: /select post/i }));
    const bar = (await screen.findByText(/1 selected/i)).parentElement;
    await user.click(within(bar).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(within(bar).getByRole('alert')).toHaveTextContent(/0 approved, 1 failed: p1/));
    expect(within(bar).getByRole('alert')).not.toHaveTextContent(/HTTP 500/);
  });
});
