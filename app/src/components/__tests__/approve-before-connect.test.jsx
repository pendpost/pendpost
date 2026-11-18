import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { nextActorOf } from '../../lib/format.js';

// Owner decision 2 (2026-11-12): a new user can approve before connecting anything. Approve
// stays the row's one action on every card, also when the post's lane is not connected; the
// quiet "not connected" glyph sits in the row beside it instead of replacing it. An approved
// post on a lane that is not connected says so in one chip: "Approved, waits for Telegram".
// Publishing waits for the connection (lib/scheduler.mjs, test/wait-for-connect.test.mjs).
const approvePost = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('../../lib/api.js', () => ({
  usePlatformValidate: () => ({ data: null }),
  approvePost: (...a) => approvePost(...a),
  rejectPost: vi.fn(() => Promise.resolve({ ok: true })),
  markPosted: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
  usePendpostHealth: () => healthState,
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: null, isLoading: false, isError: false }),
}));

let healthState = { data: null };
const offline = { data: { setup: { platforms: [{ platform: 'telegram', status: 'incomplete' }] } } };

const tgPost = {
  id: 'tg-1',
  campaign: 'spring',
  title: 'Planner tour',
  caption: 'Next week: a short tour of the planner for new projects.',
  platforms: ['telegram'],
  approval: 'pending',
  derivedState: 'waiting-due',
  scheduledAt: '2026-08-20T07:00:00Z',
  type: 'text',
  image: null,
  media: { file: null, exists: false, bytes: null, url: null, cover: null, path: null },
};

function renderFreigaben(posts, { locale = 'en' } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ConfirmProvider>
            <Freigaben campaigns={[{ id: 'spring', active: true, posts }]} onOpen={() => {}} onNavigate={vi.fn()} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  approvePost.mockClear();
  healthState = offline;
});

describe('Approve before connect', () => {
  it('Approve is the row action on a post whose lane is not connected', () => {
    renderFreigaben([tgPost]);
    const row = screen.getByRole('listitem');
    const approve = within(row).getByRole('button', { name: /^approve$/i });
    expect(approve.closest('[data-row-action]')).not.toBeNull();
    // The quiet glyph stays in the row, beside Approve, not instead of it.
    const glyph = within(row).getByLabelText('Telegram not connected');
    expect(glyph.closest('[data-offline-chip]')).not.toBeNull();
    expect(glyph.closest('button')).toBeNull();
    // No per-row Connect (the connect fix lives once per project) and no helper sentence.
    expect(within(row).queryByRole('button', { name: 'Connect Telegram' })).not.toBeInTheDocument();
    expect(screen.queryByText(/is not connected/)).not.toBeInTheDocument();
  });

  it('pressing Approve approves the post', async () => {
    renderFreigaben([tgPost]);
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(approvePost).toHaveBeenCalledWith('spring', 'tg-1'));
  });

  it('the keyboard approves too (a on the focused row)', async () => {
    renderFreigaben([tgPost]);
    const row = screen.getByRole('listitem');
    row.focus();
    fireEvent.keyDown(row, { key: 'a' });
    await waitFor(() => expect(approvePost).toHaveBeenCalledWith('spring', 'tg-1'));
  });

  it('an approved post on a lane that is not connected reads "Approved, waits for Telegram", never overdue', async () => {
    renderFreigaben([{ ...tgPost, approval: 'approved', approvalBy: 'owner', derivedState: 'overdue' }]);
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    const row = screen.getByRole('listitem');
    expect(within(row).getByText('Approved, waits for Telegram')).toBeInTheDocument();
    expect(within(row).queryByText(/overdue/i)).not.toBeInTheDocument();
    expect(within(row).getByLabelText('Telegram not connected')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
  });

  it('de-CH says "Freigegeben, wartet auf Telegram"', async () => {
    renderFreigaben([{ ...tgPost, approval: 'approved', approvalBy: 'owner' }], { locale: 'de-CH' });
    await userEvent.click(screen.getByRole('button', { name: 'Alle' }));
    expect(screen.getByText('Freigegeben, wartet auf Telegram')).toBeInTheDocument();
  });
});

describe('nextActorOf: waits for a connection', () => {
  const setup = offline.data.setup;
  it('approved + lane not connected = waitsForConnect, naming the lanes', () => {
    expect(nextActorOf({ ...tgPost, approval: 'approved' }, setup)).toEqual({ key: 'waitsForConnect', actor: 'you', lanes: ['telegram'] });
  });
  it('outranks overdue (the post is waiting for the connection, not late on its own)', () => {
    expect(nextActorOf({ ...tgPost, approval: 'approved', derivedState: 'overdue' }, setup).key).toBe('waitsForConnect');
  });
  it('a real failure still leads', () => {
    expect(nextActorOf({ ...tgPost, approval: 'approved', derivedState: 'publish-failed' }, setup).key).toBe('publish-failed');
  });
  it('a pending post is still blocked (Approve leads the row, the glyph says why it will wait)', () => {
    expect(nextActorOf(tgPost, setup).key).toBe('blocked');
  });
  it('an edit after approval still asks for re-approval first', () => {
    expect(nextActorOf({ ...tgPost, approval: 'approved', editedSinceApproval: true }, setup).key).not.toBe('waitsForConnect');
  });
});
