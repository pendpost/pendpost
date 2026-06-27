import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import ActivityCheckNow from '../ActivityCheckNow.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// B4 — the Activity "Check now" publish (publish_due_run) fired with NO confirm
// today. It is a real publish path, so it must FIRST raise an in-app confirm that
// NAMES the target client by displayName, and only confirm:true proceeds to
// runPublishDue() (fail-closed: cancel publishes nothing).

const runPublishDue = vi.fn(() => Promise.resolve({ ok: true }));
let activeState;

vi.mock('../../lib/api.js', () => ({
  runPublishDue: (...args) => runPublishDue(...args),
  useActiveClient: () => activeState,
}));

function renderCheckNow() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <I18nProvider locale="en">
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <ConfirmProvider>
            <ActivityCheckNow />
          </ConfirmProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { ...utils, qc };
}

beforeEach(() => {
  runPublishDue.mockReset();
  runPublishDue.mockResolvedValue({ ok: true });
  activeState = {
    activeClient: { id: 'acme', displayName: 'Acme Retail', status: 'active', accent: '#22566d' },
    activeClientId: 'acme',
  };
});

describe('Activity Check now (client-naming publish confirm)', () => {
  it('clicking opens a confirm that NAMES the active client before any publish', async () => {
    const user = userEvent.setup();
    renderCheckNow();

    await user.click(screen.getByRole('button', { name: /publish due now/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    // The confirm copy names the target client by displayName...
    expect(dialog).toHaveTextContent(/Acme Retail/);
    // ...and no publish has fired yet.
    expect(runPublishDue).not.toHaveBeenCalled();
  });

  it('only confirm:true proceeds to runPublishDue()', async () => {
    const user = userEvent.setup();
    renderCheckNow();

    await user.click(screen.getByRole('button', { name: /publish due now/i }));
    const dialog = await screen.findByRole('dialog');
    // Confirm via the affirmative dialog button (scoped to the dialog so it is
    // not ambiguous with the now identically-named trigger button).
    const confirmBtn = within(dialog).getByRole('button', { name: /publish|confirm/i });
    await user.click(confirmBtn);

    await waitFor(() => expect(runPublishDue).toHaveBeenCalledTimes(1));
  });

  it('fail-closed: cancelling the confirm never calls runPublishDue()', async () => {
    const user = userEvent.setup();
    renderCheckNow();

    await user.click(screen.getByRole('button', { name: /publish due now/i }));
    await screen.findByRole('dialog');
    const cancelBtns = screen.getAllByRole('button', { name: /^cancel$/i });
    await user.click(cancelBtns[cancelBtns.length - 1]);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(runPublishDue).not.toHaveBeenCalled();
  });

  it('with no active client the confirm still appears (neutral) and stays fail-closed on cancel', async () => {
    activeState = { activeClient: null, activeClientId: null };
    const user = userEvent.setup();
    renderCheckNow();

    await user.click(screen.getByRole('button', { name: /publish due now/i }));
    await screen.findByRole('dialog');
    const cancelBtns = screen.getAllByRole('button', { name: /^cancel$/i });
    await user.click(cancelBtns[cancelBtns.length - 1]);
    expect(runPublishDue).not.toHaveBeenCalled();
  });

  it('has no axe violations', async () => {
    const { container } = renderCheckNow();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
